// packages/relay-web/src/__tests__/queuestrip.test.ts
import { setActivePinia, createPinia } from "pinia";
import { mount } from "@vue/test-utils";
import { describe, expect, it, vi } from "vitest";
import { i18n } from "../i18n";

vi.mock("../api/client", () => ({
  ApiError: class extends Error { constructor(public code: string, public status: number) { super(code); } },
  api: { get: vi.fn(), rpc: vi.fn() },
}));

import QueueStrip from "../components/QueueStrip.vue";
import { useChatStore } from "../stores/chat";
import type { WebServerEvent } from "@ganglion/xacpx-relay-protocol";

describe("QueueStrip", () => {
  it("renders queued items and cancels one on click", async () => {
    // Shared-pinia pattern: one pinia instance passed both to the store lookup used by
    // the test's assertions AND to the mounted component, so a spy assigned on the store
    // action is the exact same object the component's click handler invokes.
    const pinia = createPinia();
    setActivePinia(pinia);
    const chat = useChatStore();
    chat.select("i1", "s");
    chat.applyEvent({
      kind: "control-event",
      instanceId: "i1",
      event: {
        type: "queue-updated",
        chatKey: "c",
        sessionAlias: "s",
        items: [
          { id: "q1", textPreview: "aaa", enqueuedAt: "t" },
          { id: "q2", textPreview: "bbb", enqueuedAt: "t" },
        ],
      },
    } as WebServerEvent);
    chat.cancelQueuedItem = vi.fn();

    const w = mount(QueueStrip, { global: { plugins: [pinia, i18n] } });
    const items = w.findAll('[data-test="queue-item"]');
    expect(items).toHaveLength(2);
    expect(items[0].text()).toContain("aaa");
    expect(items[1].text()).toContain("bbb");

    await w.findAll('[data-test="queue-cancel"]')[0].trigger("click");
    expect(chat.cancelQueuedItem).toHaveBeenCalledWith("i1", "s", "q1");
  });

  it("renders nothing when the queue is empty", () => {
    const pinia = createPinia();
    setActivePinia(pinia);
    const chat = useChatStore();
    chat.select("i1", "s");

    const w = mount(QueueStrip, { global: { plugins: [pinia, i18n] } });
    expect(w.find('[data-test="queue-item"]').exists()).toBe(false);
    expect(w.find('[data-test="queue-strip"]').exists()).toBe(false);
  });
});
