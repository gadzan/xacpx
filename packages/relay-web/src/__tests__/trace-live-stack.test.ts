import { beforeEach, describe, expect, it, vi } from "vitest";
import { mount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import type { ToolStepStatus } from "@ganglion/xacpx-relay-protocol";
import TraceLiveStack from "../components/TraceLiveStack.vue";
import type { TurnPresentationItem } from "../lib/turn-presentation";

function toolNode(id: string, title = `Step ${id}`, status: ToolStepStatus = "success"): TurnPresentationItem {
  return {
    key: `tool:${id}`,
    type: "tool",
    isLatest: false,
    step: { toolCallId: id, toolName: "read_file", kind: "read", status, title },
  };
}

function markdownNode(length: number, text: string): TurnPresentationItem {
  return {
    key: `markdown:0:${length}`,
    type: "markdown",
    sourceRange: [0, length],
    source: text,
    html: `<p>${text}</p>`,
    copyText: text,
    isLatest: true,
  };
}

function rows(wrapper: ReturnType<typeof mount>): string[] {
  return wrapper.findAll('[data-test="trace-live-item"]').map((row) => row.text());
}

describe("trace live stack", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    window.innerWidth = 1280;
  });

  it("shows the newest three events, newest first", () => {
    const wrapper = mount(TraceLiveStack, {
      props: { nodes: [toolNode("a"), toolNode("b"), toolNode("c"), toolNode("d")], streaming: true },
    });
    const text = rows(wrapper);
    expect(text).toHaveLength(3);
    expect(text[0]).toContain("Step d");
    expect(text[1]).toContain("Step c");
    expect(text[2]).toContain("Step b");
    expect(text.join(" ")).not.toContain("Step a");
    wrapper.unmount();
  });

  it("shows two events on mobile", () => {
    window.innerWidth = 390;
    const wrapper = mount(TraceLiveStack, {
      props: { nodes: [toolNode("a"), toolNode("b"), toolNode("c")], streaming: true },
    });
    expect(rows(wrapper)).toHaveLength(2);
    wrapper.unmount();
  });

  it("updates a same-key event in place without adding a row", async () => {
    const wrapper = mount(TraceLiveStack, {
      props: { nodes: [toolNode("a"), toolNode("b", "Step b", "running")], streaming: true },
    });
    expect(rows(wrapper)).toHaveLength(2);
    const firstRow = wrapper.findAll('[data-test="trace-live-item"]')[0]!.element;
    await wrapper.setProps({ nodes: [toolNode("a"), toolNode("b", "Step b updated", "success")] });
    await vi.waitFor(() => expect(wrapper.text()).toContain("Step b updated"));
    expect(rows(wrapper)).toHaveLength(2);
    expect(wrapper.findAll('[data-test="trace-live-item"]')[0]!.element).toBe(firstRow);
    expect(wrapper.find('[data-test="trace-live-status"]').attributes("data-status")).toBe("success");
    wrapper.unmount();
  });

  it("keeps the previous rows when a new event enters", async () => {
    const wrapper = mount(TraceLiveStack, {
      props: { nodes: [toolNode("a"), toolNode("b")], streaming: true },
    });
    expect(rows(wrapper)).toHaveLength(2);
    await wrapper.setProps({ nodes: [toolNode("a"), toolNode("b"), toolNode("c")] });
    await vi.waitFor(() => expect(rows(wrapper)).toHaveLength(3));
    expect(rows(wrapper)[0]).toContain("Step c");
    expect(rows(wrapper)[1]).toContain("Step b");
    expect(rows(wrapper)[2]).toContain("Step a");
    wrapper.unmount();
  });

  it("treats a growing markdown key as the same event", async () => {
    const wrapper = mount(TraceLiveStack, {
      props: { nodes: [markdownNode(5, "hello")], streaming: true },
    });
    const firstRow = wrapper.findAll('[data-test="trace-live-item"]')[0]!.element;
    await wrapper.setProps({ nodes: [markdownNode(11, "hello world")] });
    await vi.waitFor(() => expect(wrapper.text()).toContain("hello world"));
    expect(rows(wrapper)).toHaveLength(1);
    expect(wrapper.findAll('[data-test="trace-live-item"]')[0]!.element).toBe(firstRow);
    wrapper.unmount();
  });

  it("collapses to a terminal summary and stops the running stack", async () => {
    const wrapper = mount(TraceLiveStack, {
      props: { nodes: [toolNode("a"), toolNode("b")], streaming: true },
    });
    expect(wrapper.find('[data-test="trace-live-label"]').exists()).toBe(true);
    await wrapper.setProps({ streaming: false, terminal: "done" });
    expect(wrapper.get('[data-test="trace-live-summary"]').text()).toContain("Run complete");
    expect(wrapper.findAll('[data-test="trace-live-item"]')).toHaveLength(0);
    expect(wrapper.find('[data-test="trace-live-label"]').exists()).toBe(false);
    await wrapper.setProps({ terminal: "failed" });
    expect(wrapper.get('[data-test="trace-live-summary"]').text()).toContain("Run failed");
    await wrapper.setProps({ terminal: "cancelled" });
    expect(wrapper.get('[data-test="trace-live-summary"]').text()).toContain("Run cancelled");
    wrapper.unmount();
  });

  it("emits the revealed node key when a live row is clicked", async () => {
    const wrapper = mount(TraceLiveStack, {
      props: { nodes: [toolNode("a"), toolNode("b")], streaming: true },
    });
    await wrapper.get('[data-test="trace-live-row"]').trigger("click");
    expect(wrapper.emitted("reveal")).toEqual([["tool:b"]]);
    wrapper.unmount();
  });
});
