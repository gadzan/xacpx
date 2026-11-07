import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { flushPromises, mount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import type {
  ConversationRunDto,
  MemberTurnSummaryDto,
  TurnPartDto,
} from "@ganglion/xacpx-relay-protocol";
import GroupRunDetailContent from "../components/GroupRunDetailContent.vue";
import { appendedTraceNodes, resetTraceDrawerState } from "../lib/trace-drawer-state";

const run = {
  id: "run", conversationId: "group", topicId: "topic", requestMessageId: "message",
  requestId: "request", mode: "explicit", state: "running", profileRevision: 1, createdAt: "now",
} as unknown as ConversationRunDto;

const memberTurn = {
  id: "member", runId: "run", conversationId: "group", topicId: "topic", botId: "bot",
  batch: 1, memberIndex: 0, attempt: 1, origin: "human-explicit", state: "running",
  createdAt: "now",
} as unknown as MemberTurnSummaryDto;

function tool(index: number): TurnPartDto {
  return { type: "tool", step: {
    toolCallId: `step-${index}`, toolName: "read_file", kind: "read", status: "success",
    title: `Read file ${index}`, detail: { type: "text", text: `Recorded output ${index}` },
  } };
}

let scroller: HTMLDivElement;
let offset = 0;
let scrollHeight = 1000;
const clientHeight = 400;

function mountContent(parts: TurnPartDto[], extra: Record<string, unknown> = {}) {
  return mount(GroupRunDetailContent, {
    attachTo: scroller,
    props: { run, memberTurn, attempt: 1, parts, traceStreaming: true, ...extra },
  });
}

describe("trace drawer state", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    resetTraceDrawerState();
    offset = 0;
    scrollHeight = 1000;
    scroller = document.createElement("div");
    scroller.className = "group-detail-scroll";
    Object.defineProperty(scroller, "scrollHeight", { configurable: true, get: () => scrollHeight });
    Object.defineProperty(scroller, "clientHeight", { configurable: true, get: () => clientHeight });
    Object.defineProperty(scroller, "scrollTop", {
      configurable: true,
      get: () => offset,
      set: (value: number) => { offset = value; },
    });
    document.body.append(scroller);
  });

  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("counts only appended events, never a prepended page", () => {
    expect(appendedTraceNodes([], ["a"])).toBe(0);
    expect(appendedTraceNodes(["a", "b"], ["a", "b"])).toBe(0);
    expect(appendedTraceNodes(["a", "b"], ["a", "b", "c", "d"])).toBe(2);
    expect(appendedTraceNodes(["a", "b"], ["x", "a", "b"])).toBe(0);
    expect(appendedTraceNodes(["a", "b"], ["z"])).toBe(0);
  });

  it("restores a scope's expansion when the reader returns to it (1 -> 2 -> 1)", async () => {
    const parts = [tool(0), tool(1)];
    const wrapper = mountContent(parts);
    await flushPromises();
    await wrapper.get('[data-test="group-trace-step-head"]').trigger("click");
    expect(wrapper.get('[data-test="tool-step-body"]').text()).toContain("Recorded output 0");

    // Attempt 2 starts empty: a retry never inherits attempt 1's expansion.
    await wrapper.setProps({ attempt: 2, parts });
    await flushPromises();
    expect(wrapper.find('[data-test="tool-step-body"]').exists()).toBe(false);
    await wrapper.findAll('[data-test="group-trace-step-head"]')[1]!.trigger("click");
    expect(wrapper.get('[data-test="tool-step-body"]').text()).toContain("Recorded output 1");

    // Back to attempt 1: its own expansion is restored, attempt 2's is not shown.
    await wrapper.setProps({ attempt: 1, parts });
    await flushPromises();
    const bodies = wrapper.findAll('[data-test="tool-step-body"]');
    expect(bodies).toHaveLength(1);
    expect(bodies[0]!.text()).toContain("Recorded output 0");
    wrapper.unmount();
  });

  it("keeps an expanded step across appends inside the same scope", async () => {
    const wrapper = mountContent([tool(0), tool(1)]);
    await flushPromises();
    await wrapper.get('[data-test="group-trace-step-head"]').trigger("click");
    expect(wrapper.get('[data-test="tool-step-body"]').text()).toContain("Recorded output 0");

    await wrapper.setProps({ parts: [tool(0), tool(1), ...Array.from({ length: 20 }, (_, i) => tool(i + 2))] });
    await flushPromises();
    expect(wrapper.findAll('[data-test="group-trace-step"]')).toHaveLength(22);
    expect(wrapper.get('[data-test="tool-step-body"]').text()).toContain("Recorded output 0");
    wrapper.unmount();
  });

  it("keeps an expanded step across a remount of the same member and attempt", async () => {
    const first = mountContent([tool(0), tool(1)]);
    await flushPromises();
    await first.get('[data-test="group-trace-step-head"]').trigger("click");
    expect(first.get('[data-test="tool-step-body"]').text()).toContain("Recorded output 0");
    first.unmount();

    const second = mountContent([tool(0), tool(1)]);
    await flushPromises();
    expect(second.get('[data-test="tool-step-body"]').text()).toContain("Recorded output 0");
    second.unmount();
  });

  it("freezes the viewport and counts new events while the reader is above the tail", async () => {
    const wrapper = mountContent([tool(0)]);
    await flushPromises();
    scroller.dispatchEvent(new Event("scroll"));

    await wrapper.setProps({ parts: [tool(0), tool(1), tool(2)] });
    await flushPromises();
    expect(offset).toBe(0);
    expect(wrapper.get('[data-test="group-trace-new-events"]').text()).toContain("2 new events");

    await wrapper.get('[data-test="group-trace-new-events"]').trigger("click");
    expect(offset).toBe(scrollHeight);
    expect(wrapper.find('[data-test="group-trace-new-events"]').exists()).toBe(false);
    wrapper.unmount();
  });

  it("follows appended events again once the reader is back at the bottom", async () => {
    const wrapper = mountContent([tool(0)]);
    await flushPromises();
    offset = scrollHeight - clientHeight;
    scroller.dispatchEvent(new Event("scroll"));

    await wrapper.setProps({ parts: [tool(0), tool(1)] });
    await flushPromises();
    expect(offset).toBe(scrollHeight);
    expect(wrapper.find('[data-test="group-trace-new-events"]').exists()).toBe(false);
    wrapper.unmount();
  });

  it("reveals and highlights the full-list row a live event was clicked on", async () => {
    const wrapper = mountContent([tool(0), tool(1)]);
    await flushPromises();
    await wrapper.get('[data-test="trace-live-row"]').trigger("click");
    const row = wrapper.get('[data-trace-key="tool:step-1"]');
    expect(row.attributes("data-highlight")).toBe("true");
    wrapper.unmount();
  });
});
