import { beforeEach, describe, expect, it } from "vitest";
import { computed, defineComponent, ref, type PropType } from "vue";
import { mount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import type { ToolStepDto, TurnPartDto } from "@ganglion/xacpx-relay-protocol";
import GroupTraceTimeline from "../components/GroupTraceTimeline.vue";
import { deriveTurnPresentation } from "../lib/turn-presentation";
import { resetTraceDrawerState } from "../lib/trace-drawer-state";

const Harness = defineComponent({
  components: { GroupTraceTimeline },
  props: {
    parts: { type: Array as PropType<TurnPartDto[]>, required: true },
    streaming: { type: Boolean, default: false },
  },
  setup(props) {
    const expanded = ref(new Set<string>());
    const nodes = computed(() => deriveTurnPresentation(props.parts, { streaming: props.streaming }).nodes);
    function toggle(key: string): void {
      if (expanded.value.has(key)) expanded.value.delete(key);
      else expanded.value.add(key);
    }
    return { expanded, nodes, toggle };
  },
  template: `<GroupTraceTimeline :nodes="nodes" :expanded-keys="expanded" :streaming="streaming" @toggle="toggle" />`,
});

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
  beforeEach(() => {
    setActivePinia(createPinia());
    resetTraceDrawerState();
  });

  it("renders every step in order with no fold window or fold control", async () => {
    const parts: TurnPartDto[] = [
      { type: "text", text: "Before the first tool" },
      ...Array.from({ length: 7 }, (_, i) => tool(i)),
      { type: "text", text: "Final public report" },
    ];
    const wrapper = mount(Harness, { props: { parts, streaming: true } });
    expect(wrapper.findAll('[data-test="group-trace-step"]')).toHaveLength(7);
    const text = wrapper.text();
    expect(text).toContain("Read file 0");
    expect(text).toContain("Read file 6");
    expect(text).toContain("Before the first tool");
    expect(text).toContain("Final public report");
    expect(text.indexOf("Before the first tool")).toBeLessThan(text.indexOf("Read file 0"));
    expect(text.indexOf("Read file 6")).toBeLessThan(text.indexOf("Final public report"));
    expect(wrapper.find('[data-test="group-trace-fold"]').exists()).toBe(false);
    wrapper.unmount();
  });

  it("keeps a reader-expanded step open when new events arrive", async () => {
    const parts: TurnPartDto[] = [tool(0), tool(1)];
    const wrapper = mount(Harness, { props: { parts, streaming: true } });
    expect(wrapper.findAll('[data-test="group-trace-step"]')).toHaveLength(2);
    await wrapper.get('[data-test="group-trace-step-head"]').trigger("click");
    expect(wrapper.get('[data-test="tool-step-body"]').text()).toContain("Recorded output 0");

    const appended = [...parts, ...Array.from({ length: 20 }, (_, i) => tool(i + 2)), { type: "text", text: "Final public report" }];
    await wrapper.setProps({ parts: appended });
    expect(wrapper.findAll('[data-test="group-trace-step"]')).toHaveLength(22);
    expect(wrapper.get('[data-test="tool-step-body"]').text()).toContain("Recorded output 0");
    expect(wrapper.get('[data-test="group-trace-step-head"]').attributes("aria-expanded")).toBe("true");
    wrapper.unmount();
  });

  it("collapses a step only when the reader toggles it again", async () => {
    const wrapper = mount(Harness, { props: { parts: [tool(0), tool(1)] } });
    const head = () => wrapper.get('[data-test="group-trace-step-head"]');
    await head().trigger("click");
    expect(wrapper.find('[data-test="tool-step-body"]').exists()).toBe(true);
    await head().trigger("click");
    expect(wrapper.find('[data-test="tool-step-body"]').exists()).toBe(false);
    wrapper.unmount();
  });

  it("keeps reasoning compact until opened, and open across appended events", async () => {
    const parts: TurnPartDto[] = [
      { type: "reasoning", text: "first thought" },
      tool(0),
    ];
    const wrapper = mount(Harness, { props: { parts, streaming: true } });
    expect(wrapper.find('[data-test="reasoning-body"]').exists()).toBe(false);
    await wrapper.get('[data-test="reasoning-toggle"]').trigger("click");
    expect(wrapper.get('[data-test="reasoning-body"]').text()).toContain("first thought");
    await wrapper.setProps({ parts: [...parts, ...Array.from({ length: 20 }, (_, i) => tool(i + 1))] });
    expect(wrapper.get('[data-test="reasoning-body"]').text()).toContain("first thought");
    wrapper.unmount();
  });

  it("keeps failure output visible when a failed step is expanded", async () => {
    const part: TurnPartDto = { type: "tool", step: {
      toolCallId: "failed", toolName: "shell", kind: "execute", status: "error", title: "Run checks",
      error: "permission denied", detail: { type: "text", text: "permission denied" },
    } };
    const wrapper = mount(Harness, { props: { parts: [part] } });
    expect(wrapper.get('[data-test="group-trace-step"]').attributes("data-state")).toBe("error");
    await wrapper.get('[data-test="group-trace-step-head"]').trigger("click");
    expect(wrapper.get('[data-test="tool-step-body"]').text()).toContain("permission denied");
    wrapper.unmount();
  });

  it("marks the subagent row error when a child fails after the parent reports success", async () => {
    const wrapper = mount(Harness, { props: { parts: subagentParts("success", "error") } });
    expect(wrapper.findAll('[data-test="group-trace-step"]')).toHaveLength(1);
    expect(wrapper.get('[data-test="group-trace-step"]').attributes("data-state")).toBe("error");
    await wrapper.get('[data-test="group-trace-step-head"]').trigger("click");
    expect(wrapper.find('[data-test="subagent-error"]').exists()).toBe(true);
    expect(wrapper.get('[data-test="group-trace-step"]').attributes("data-state")).toBe("error");
    wrapper.unmount();
  });

  it("marks the subagent row running while a child still runs after the parent reports success", async () => {
    const wrapper = mount(Harness, { props: { parts: subagentParts("success", "running") } });
    expect(wrapper.findAll('[data-test="group-trace-step"]')).toHaveLength(1);
    expect(wrapper.get('[data-test="group-trace-step"]').attributes("data-state")).toBe("running");
    await wrapper.get('[data-test="group-trace-step-head"]').trigger("click");
    expect(wrapper.find('[data-test="subagent-running"]').exists()).toBe(true);
    expect(wrapper.get('[data-test="group-trace-step"]').attributes("data-state")).toBe("running");
    wrapper.unmount();
  });
});
