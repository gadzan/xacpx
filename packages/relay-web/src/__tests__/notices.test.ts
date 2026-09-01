import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import { mount } from "@vue/test-utils";

vi.mock("../api/client", () => ({
  ApiError: class ApiError extends Error {
    constructor(public code: string, public status: number) {
      super(code);
    }
  },
  api: {
    get: async () => ({}),
    rpc: async () => ({}),
  },
}));

import { useNoticesStore, QUEUE_OVERFLOW_TOAST_MS } from "../stores/notices";
import { useChatStore } from "../stores/chat";
import NoticeToast from "../components/NoticeToast.vue";

describe("notices store", () => {
  beforeEach(() => setActivePinia(createPinia()));
  afterEach(() => vi.useRealTimers());

  it("appends notice events and caps the list at 20", () => {
    const store = useNoticesStore();
    for (let i = 0; i < 25; i++) {
      store.applyEvent({ kind: "notice", instanceId: "inst", notice: { kind: "task-completion", text: `done ${i}` } });
    }
    expect(store.items).toHaveLength(20);
    expect(store.items[0].text).toBe("done 24");
  });

  it("ignores non-notice events", () => {
    const store = useNoticesStore();
    store.applyEvent({ kind: "instance-status", instanceId: "inst", online: true });
    expect(store.items).toHaveLength(0);
  });

  it("dismiss removes a notice by id", () => {
    const store = useNoticesStore();
    store.applyEvent({ kind: "notice", instanceId: "inst", notice: { kind: "task-progress", text: "x" } });
    const id = store.items[0].id;
    store.dismiss(id);
    expect(store.items).toHaveLength(0);
  });

  it("renders notices and dismisses on click", async () => {
    const pinia = createPinia();
    setActivePinia(pinia);
    const store = useNoticesStore();
    store.applyEvent({ kind: "notice", instanceId: "inst", notice: { kind: "task-completion", text: "all done" } });
    const w = mount(NoticeToast, { global: { plugins: [pinia] } });
    expect(w.text()).toContain("all done");
    await w.find('[data-test="notice"] button').trigger("click");
    expect(store.items).toHaveLength(0);
  });

  it("queue-overflow toasts auto-dismiss after 3s and never become chat messages", async () => {
    vi.useFakeTimers();
    const pinia = createPinia();
    setActivePinia(pinia);
    const notices = useNoticesStore();
    const chat = useChatStore();
    chat.select("inst", "demo");
    const tip = "Reply was truncated for size — you can continue.";
    const event = {
      kind: "notice" as const,
      instanceId: "inst",
      notice: { kind: "queue-overflow" as const, text: tip },
    };
    notices.applyEvent(event);
    chat.applyEvent(event);
    const w = mount(NoticeToast, { global: { plugins: [pinia] } });
    const toast = w.get('[data-test="queue-overflow-toast"]');
    expect(toast.text()).toContain(tip);
    expect(toast.text()).not.toMatch(/⚠️|❌|queue-overflow/i);
    expect(chat.messages.some((m) => m.text.includes(tip))).toBe(false);
    vi.advanceTimersByTime(QUEUE_OVERFLOW_TOAST_MS - 1);
    expect(notices.items).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(notices.items).toHaveLength(0);
    await w.vm.$nextTick();
    expect(w.find('[data-test="queue-overflow-toast"]').exists()).toBe(false);
  });

  it("task-completion notices stay until dismissed", async () => {
    vi.useFakeTimers();
    const store = useNoticesStore();
    store.applyEvent({ kind: "notice", instanceId: "inst", notice: { kind: "task-completion", text: "all done" } });
    vi.advanceTimersByTime(QUEUE_OVERFLOW_TOAST_MS + 1_000);
    expect(store.items).toHaveLength(1);
  });
});
