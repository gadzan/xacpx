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
});
