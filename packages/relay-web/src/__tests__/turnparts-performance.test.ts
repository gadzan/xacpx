import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mount } from "@vue/test-utils";
import { nextTick } from "vue";
import { createPinia, setActivePinia } from "pinia";
import type { ToolStepDto, TurnPartDto } from "@ganglion/xacpx-relay-protocol";
import TurnParts from "../components/TurnParts.vue";

const tool: ToolStepDto = {
  toolCallId: "read-1",
  toolName: "Read",
  kind: "read",
  status: "running",
  title: "index.ts",
};

const parts = (suffix: string): TurnPartDto[] => [
  { type: "text", text: "before " },
  { type: "tool", step: tool },
  { type: "text", text: suffix },
];

beforeEach(() => {
  setActivePinia(createPinia());
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("TurnParts streaming performance", () => {
  it("coalesces multiple layout updates into one browser frame", async () => {
    const frames: FrameRequestCallback[] = [];
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      frames.push(callback);
      return frames.length;
    });
    vi.stubGlobal("cancelAnimationFrame", vi.fn());
    const wrapper = mount(TurnParts, {
      props: { parts: parts("one"), streaming: true },
    });

    await wrapper.setProps({ parts: parts("two") });
    await wrapper.setProps({ parts: parts("three") });
    await wrapper.setProps({ parts: parts("four") });
    expect(frames).toHaveLength(1);
    expect(wrapper.findAll('[data-test="turn-narrative"]')[1]!.text()).toBe("one");

    frames[0]!(16);
    await nextTick();
    expect(wrapper.findAll('[data-test="turn-narrative"]')[1]!.text()).toBe("four");
  });
});
