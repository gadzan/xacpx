import { beforeEach, describe, expect, it } from "vitest";
import { mount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import type { ToolStepDto, TurnPartDto } from "@ganglion/xacpx-relay-protocol";
import GroupTraceTimeline from "../components/GroupTraceTimeline.vue";

function subagentParts(parentStatus: ToolStepDto["status"], childStatus: ToolStepDto["status"]): TurnPartDto[] {
  return [
    { type: "tool", step: {
      toolCallId: "agent-1", toolName: "Task", kind: "think", status: parentStatus,
      title: "Delegate work", isSubagent: true,
    } },
    { type: "tool", step: {
      toolCallId: "child-1", parentToolCallId: "agent-1", toolName: "Bash", kind: "execute",
      status: childStatus, title: "Child work",
    } },
  ];
}
function tool(index: number): TurnPartDto {
  return { type: "tool", step: {
    toolCallId: `step-${index}`, toolName: "read_file", kind: "read", status: "success",
    title: `Read file ${index}`, detail: { type: "text", text: `Recorded output ${index}` },
  } };
}

describe("group process timeline", () => {
  beforeEach(() => setActivePinia(createPinia()));
  it("folds the earlier process as streaming steps arrive and restores its narrative in order", async () => {
    const parts: TurnPartDto[] = [{ type: "text", text: "Before the first tool" }, tool(0), tool(1)];
    const wrapper = mount(GroupTraceTimeline, { props: { parts, streaming: true } });
    expect(wrapper.findAll('[data-test="group-trace-step"]')).toHaveLength(2);
    const complete = [...parts, ...Array.from({ length: 5 }, (_, i) => tool(i + 2)), { type: "text", text: "Final public report" } as TurnPartDto];
    await wrapper.setProps({ parts: complete });
    expect(wrapper.findAll('[data-test="group-trace-step"]')).toHaveLength(3);
    expect(wrapper.text()).toContain("Read file 4");
    expect(wrapper.text()).not.toContain("Read file 0");
    expect(wrapper.text()).toContain("Final public report");
    await wrapper.get('[data-test="group-trace-fold"]').trigger("click");
    expect(wrapper.findAll('[data-test="group-trace-step"]')).toHaveLength(7);
    expect(wrapper.text().indexOf("Before the first tool")).toBeLessThan(wrapper.text().indexOf("Read file 0"));
    await wrapper.get('[data-test="group-trace-step-head"]').trigger("click");
    expect(wrapper.get('[data-test="tool-step-body"]').text()).toContain("Recorded output 0");
    await wrapper.setProps({ parts: [...complete, tool(7)] });
    expect(wrapper.findAll('[data-test="group-trace-step"]')).toHaveLength(8);
    expect(wrapper.get('[data-test="tool-step-body"]').text()).toContain("Recorded output 0");
    wrapper.unmount();
  });

  it("keeps failure output visible when a failed step is expanded", async () => {
    const part: TurnPartDto = { type: "tool", step: {
      toolCallId: "failed", toolName: "shell", kind: "execute", status: "error", title: "Run checks",
      error: "permission denied", detail: { type: "text", text: "permission denied" },
    } };
    const wrapper = mount(GroupTraceTimeline, { props: { parts: [part] } });
    expect(wrapper.get('[data-test="group-trace-step"]').attributes("data-state")).toBe("error");
    await wrapper.get('[data-test="group-trace-step-head"]').trigger("click");
    expect(wrapper.get('[data-test="tool-step-body"]').text()).toContain("permission denied");
    wrapper.unmount();
  });

  it("marks the subagent row error when a child fails after the parent reports success", async () => {
    const wrapper = mount(GroupTraceTimeline, { props: { parts: subagentParts("success", "error") } });
    expect(wrapper.findAll('[data-test="group-trace-step"]')).toHaveLength(1);
    expect(wrapper.get('[data-test="group-trace-step"]').attributes("data-state")).toBe("error");
    await wrapper.get('[data-test="group-trace-step-head"]').trigger("click");
    expect(wrapper.find('[data-test="subagent-error"]').exists()).toBe(true);
    expect(wrapper.get('[data-test="group-trace-step"]').attributes("data-state")).toBe("error");
    wrapper.unmount();
  });

  it("marks the subagent row running while a child still runs after the parent reports success", async () => {
    const wrapper = mount(GroupTraceTimeline, { props: { parts: subagentParts("success", "running") } });
    expect(wrapper.findAll('[data-test="group-trace-step"]')).toHaveLength(1);
    expect(wrapper.get('[data-test="group-trace-step"]').attributes("data-state")).toBe("running");
    await wrapper.get('[data-test="group-trace-step-head"]').trigger("click");
    expect(wrapper.find('[data-test="subagent-running"]').exists()).toBe(true);
    expect(wrapper.get('[data-test="group-trace-step"]').attributes("data-state")).toBe("running");
    wrapper.unmount();
  });
});
