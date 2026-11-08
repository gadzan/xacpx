import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { flushPromises, mount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import type { TurnPartDto } from "@ganglion/xacpx-relay-protocol";
import TraceOverlay from "../components/TraceOverlay.vue";

const run = { id: "run", conversationId: "group", topicId: "topic", requestMessageId: "message", requestId: "request", mode: "explicit" as const, state: "running" as const, profileRevision: 1, createdAt: "now" };
const memberTurn = { id: "member", runId: "run", conversationId: "group", topicId: "topic", botId: "bot", batch: 1, attempt: 1, origin: "human" as const, state: "running" as const, createdAt: "now" };
const parts: TurnPartDto[] = [{ type: "text", text: "Recorded process now available" }];

for (const [name, selector, viewportWidth] of [
  ["drawer", ".group-detail-scroll", 1280],
  ["sheet", '[data-test="group-detail-sheet"] .thin-scroll', 390],
] as const) {
  describe(`${name} delayed scroll restore`, () => {
    let maxScroll: number;
    let offsets: WeakMap<HTMLElement, number>;
    let original: PropertyDescriptor | undefined;
    beforeEach(() => {
      setActivePinia(createPinia());
      window.innerWidth = viewportWidth;
      maxScroll = 0;
      offsets = new WeakMap();
      original = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "scrollTop");
      Object.defineProperty(HTMLElement.prototype, "scrollTop", {
        configurable: true,
        get() { return offsets.get(this) ?? 0; },
        set(value: number) { offsets.set(this, Math.min(maxScroll, Math.max(0, value))); },
      });
    });
    afterEach(() => {
      window.innerWidth = 1280;
      if (original) Object.defineProperty(HTMLElement.prototype, "scrollTop", original);
      else Reflect.deleteProperty(HTMLElement.prototype, "scrollTop");
      document.body.innerHTML = "";
      vi.restoreAllMocks();
    });

    it("keeps the saved offset while the loading shell clamps it, then restores only once", async () => {
      const anchor = document.createElement("button");
      document.body.append(anchor);
      const memory = new Map([["run:member:1", 240], ["run:member:2", 180]]);
      const wrapper = mount(TraceOverlay, { attachTo: document.body, props: {
        id: "detail", anchorEl: anchor, run, memberTurns: [memberTurn], attempt: 1,
        parts: [], traceLoading: true, scrollMemory: memory,
      } });
      await flushPromises();
      const scroll = document.querySelector<HTMLElement>(selector)!;
      expect(scroll.scrollTop).toBe(0);
      scroll.dispatchEvent(new Event("scroll"));
      expect(memory.get("run:member:1")).toBe(240);
      maxScroll = 800;
      await wrapper.setProps({ parts, traceLoading: false });
      await vi.waitFor(() => expect(scroll.scrollTop).toBe(240));
      scroll.scrollTop = 90;
      scroll.dispatchEvent(new Event("scroll"));
      await wrapper.setProps({ parts: [...parts, { type: "text", text: "Streamed addition" }] });
      await flushPromises();
      expect(scroll.scrollTop).toBe(90);
      maxScroll = 0;
      await wrapper.setProps({ attempt: 2, parts: [], traceLoading: true });
      await flushPromises();
      expect(scroll.scrollTop).toBe(0);
      maxScroll = 800;
      await wrapper.setProps({ parts, traceLoading: false });
      await vi.waitFor(() => expect(scroll.scrollTop).toBe(180));
      wrapper.unmount();
    });

    it("abandons a pending restore when the reader scrolls before the trace arrives", async () => {
      const anchor = document.createElement("button");
      document.body.append(anchor);
      const memory = new Map([["run:member:1", 240]]);
      const wrapper = mount(TraceOverlay, { attachTo: document.body, props: {
        id: "detail", anchorEl: anchor, run, memberTurns: [memberTurn], attempt: 1,
        parts: [], traceLoading: true, scrollMemory: memory,
      } });
      await flushPromises();
      const scroll = document.querySelector<HTMLElement>(selector)!;
      scroll.dispatchEvent(new WheelEvent("wheel", { deltaY: 40 }));
      maxScroll = 800;
      scroll.scrollTop = 40;
      scroll.dispatchEvent(new Event("scroll"));
      await wrapper.setProps({ parts, traceLoading: false });
      await flushPromises();
      expect(scroll.scrollTop).toBe(40);
      expect(memory.get("run:member:1")).toBe(40);
      wrapper.unmount();
    });
  });
}
