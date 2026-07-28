import { afterEach, describe, expect, it, vi } from "vitest";
import { mount } from "@vue/test-utils";
import { nextTick } from "vue";
import { createPinia } from "pinia";
import type { ToolStepDto, TurnPartDto } from "@ganglion/xacpx-relay-protocol";
import TurnParts from "../components/TurnParts.vue";
import SubagentStepCard from "../components/SubagentStepCard.vue";

const parent: ToolStepDto = {
  toolCallId: "agent-1",
  toolName: "Task",
  kind: "think",
  status: "running",
  title: "Find WeChat notification code",
  isSubagent: true,
  detail: { type: "text", text: "Search the repository thoroughly." },
};
const child = (id: string, title: string, status: ToolStepDto["status"] = "success"): ToolStepDto => ({
  toolCallId: id,
  parentToolCallId: "agent-1",
  toolName: "Grep",
  kind: "search",
  status,
  title,
  detail: { type: "search", query: title, output: "src/a.ts" },
});

afterEach(() => {
  vi.useRealTimers();
  document.body.innerHTML = "";
});

describe("subagent trace presentation", () => {
  it("folds child tool parts into one subagent card", () => {
    const parts: TurnPartDto[] = [
      { type: "tool", step: parent },
      { type: "tool", step: child("grep-1", "weixin") },
      { type: "tool", step: child("grep-2", "wechat", "running") },
    ];
    const wrapper = mount(TurnParts, {
      props: { parts, streaming: true },
      global: { plugins: [createPinia()] },
    });
    expect(wrapper.findAll('[data-test="subagent-card"]')).toHaveLength(1);
    expect(wrapper.findAll('[data-test="tool-step-card"]')).toHaveLength(0);
    expect(wrapper.find('[data-test="subagent-activity"]').text()).toContain("wechat");
  });

  it("expands a compact timeline and opens the full trace dialog", async () => {
    const wrapper = mount(SubagentStepCard, {
      attachTo: document.body,
      props: { step: parent, children: [child("grep-1", "weixin"), child("grep-2", "wechat", "running")] },
    });
    expect(wrapper.find('[data-test="subagent-timeline"]').exists()).toBe(false);
    await wrapper.find('[data-test="subagent-header"]').trigger("click");
    expect(wrapper.find('[data-test="subagent-timeline"]').text()).toContain("weixin");
    expect(wrapper.find('[data-test="subagent-timeline"]').text()).toContain("wechat");
    await wrapper.find('[data-test="subagent-open-trace"]').trigger("click");
    await nextTick();
    expect(document.querySelector('[data-test="subagent-trace-dialog"]')).not.toBeNull();
    expect(document.body.textContent).toContain("Search the repository thoroughly.");
    expect(document.body.querySelectorAll('[data-test="tool-step-card"]')).toHaveLength(2);
    (document.querySelector('[data-test="subagent-dialog-close"]') as HTMLButtonElement).click();
    await nextTick();
    expect(document.querySelector('[data-test="subagent-trace-dialog"]')).toBeNull();
    wrapper.unmount();
  });

  it("rotates among concurrent running activity while collapsed", async () => {
    vi.useFakeTimers();
    const wrapper = mount(SubagentStepCard, {
      props: {
        step: parent,
        children: [child("grep-1", "weixin", "running"), child("grep-2", "wechat", "running")],
      },
    });
    expect(wrapper.find('[data-test="subagent-activity"]').text()).toContain("weixin");
    vi.advanceTimersByTime(2400);
    await nextTick();
    expect(wrapper.find('[data-test="subagent-activity"]').text()).toContain("wechat");
  });

  it("shows the step's own detail text while running with no children", () => {
    const wrapper = mount(SubagentStepCard, { props: { step: parent, children: [] } });
    const snippet = wrapper.find('[data-test="subagent-detail-snippet"]');
    expect(snippet.exists()).toBe(true);
    expect(snippet.text()).toContain("Search the repository thoroughly.");
  });

  it("shows a running message when no children and no detail are available", () => {
    const bare: ToolStepDto = { ...parent, detail: undefined };
    const wrapper = mount(SubagentStepCard, { props: { step: bare, children: [] } });
    expect(wrapper.find('[data-test="subagent-activity"]').text()).toContain("Running — no activity details yet");
  });

  it("shows no-recorded-activity when finished with no children and no detail", () => {
    const done: ToolStepDto = { ...parent, status: "success", detail: undefined };
    const wrapper = mount(SubagentStepCard, { props: { step: done, children: [] } });
    expect(wrapper.find('[data-test="subagent-activity"]').text()).toContain("No recorded activity");
  });

  it("shows the output tail and a heartbeat while running without a trace", () => {
    const step: ToolStepDto = { ...parent, detail: { type: "text", text: "Investigate the flow", output: "line one\nline two tail" } };
    const wrapper = mount(SubagentStepCard, { props: { step, children: [] } });
    const activity = wrapper.find('[data-test="subagent-activity"]');
    expect(activity.find('[data-test="subagent-detail-snippet"]').text()).toContain("line two tail");
    expect(activity.text()).toContain("updated");
  });

  it("streams the raw output tail when expanded while running without a trace", async () => {
    const step: ToolStepDto = { ...parent, detail: { type: "text", text: "Investigate the flow", output: "partial output so far" } };
    const wrapper = mount(SubagentStepCard, { props: { step, children: [] } });
    await wrapper.find('[data-test="subagent-header"]').trigger("click");
    const report = wrapper.find('[data-test="subagent-report"]');
    expect(report.exists()).toBe(true);
    expect(wrapper.find('[data-test="subagent-stream"]').text()).toContain("partial output so far");
    wrapper.unmount();
  });

  it("renders the finished report as markdown when expanded without a trace", async () => {
    const step: ToolStepDto = { ...parent, status: "success", detail: { type: "text", text: "Investigate the flow", output: "## Result\n\nAll good." } };
    const wrapper = mount(SubagentStepCard, { props: { step, children: [] } });
    await wrapper.find('[data-test="subagent-header"]').trigger("click");
    const report = wrapper.find('[data-test="subagent-report"]');
    expect(report.exists()).toBe(true);
    expect(report.text()).toContain("All good.");
    expect(wrapper.find('[data-test="subagent-stream"]').exists()).toBe(false);
    wrapper.unmount();
  });

  it("shows the delegated prompt and a result report in the trace dialog without a trace", async () => {
    const step: ToolStepDto = { ...parent, status: "success", detail: { type: "text", text: "Investigate the flow", output: "Done: nothing to change." } };
    const wrapper = mount(SubagentStepCard, { attachTo: document.body, props: { step, children: [] } });
    await wrapper.find('[data-test="subagent-header"]').trigger("click");
    await wrapper.find('[data-test="subagent-open-trace"]').trigger("click");
    await nextTick();
    const dialog = document.querySelector('[data-test="subagent-trace-dialog"]');
    expect(dialog).not.toBeNull();
    expect(dialog?.textContent).toContain("Investigate the flow");
    expect(document.querySelector('[data-test="subagent-dialog-report"]')?.textContent).toContain("Done: nothing to change.");
    wrapper.unmount();
  });

  it("keeps nested subagent descendants visible in the full trace", async () => {
    const nestedAgent: ToolStepDto = {
      toolCallId: "agent-2",
      parentToolCallId: "agent-1",
      toolName: "Agent",
      kind: "think",
      status: "success",
      title: "Inspect protocol",
      isSubagent: true,
    };
    const nestedRead: ToolStepDto = {
      toolCallId: "read-2",
      parentToolCallId: "agent-2",
      toolName: "Read",
      kind: "read",
      status: "success",
      title: "Read web-dtos.ts",
    };
    const wrapper = mount(TurnParts, {
      attachTo: document.body,
      props: {
        parts: [
          { type: "tool", step: parent },
          { type: "tool", step: nestedAgent },
          { type: "tool", step: nestedRead },
        ],
      },
      global: { plugins: [createPinia()] },
    });

    await wrapper.find('[data-test="subagent-header"]').trigger("click");
    await wrapper.find('[data-test="subagent-open-trace"]').trigger("click");
    await nextTick();

    const dialog = document.querySelector('[data-test="subagent-trace-dialog"]');
    expect(dialog?.textContent).toContain("Inspect protocol");
    expect(dialog?.textContent).toContain("Read web-dtos.ts");
    wrapper.unmount();
  });

  it("keeps interleaved nested trace steps in their original arrival order", () => {
    const nestedAgent: ToolStepDto = {
      toolCallId: "agent-2",
      parentToolCallId: "agent-1",
      toolName: "Agent",
      kind: "think",
      status: "running",
      title: "Nested agent",
      isSubagent: true,
    };
    const outerRead = child("outer-read", "Outer read");
    const nestedRead: ToolStepDto = {
      ...child("nested-read", "Nested read"),
      parentToolCallId: "agent-2",
    };
    const wrapper = mount(TurnParts, {
      props: {
        parts: [
          { type: "tool", step: parent },
          { type: "tool", step: nestedAgent },
          { type: "tool", step: outerRead },
          { type: "tool", step: nestedRead },
        ],
      },
      global: { plugins: [createPinia()] },
    });

    expect(wrapper.findComponent(SubagentStepCard).props("children").map((step: ToolStepDto) => step.toolCallId))
      .toEqual(["agent-2", "outer-read", "nested-read"]);
  });
});
