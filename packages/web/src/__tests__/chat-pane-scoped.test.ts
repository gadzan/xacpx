import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { mount, flushPromises } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import ChatPane from "../components/ChatPane.vue";
import { useChatStore } from "../stores/chat";
import { useInstancesStore } from "../stores/instances";

const messageListStub = {
  name: "MessageList",
  props: ["messages", "liveTurn"],
  template: "<div />",
};
const planPanelStub = {
  name: "PlanPanel",
  props: ["entries", "active"],
  template: "<div />",
};
const queueStripStub = {
  name: "QueueStrip",
  props: ["instanceId", "sessionAlias"],
  template: "<div />",
};
const promptInputStub = {
  name: "PromptInput",
  props: ["busy", "draftKey"],
  template: "<div />",
};

beforeEach(() => {
  setActivePinia(createPinia());
  localStorage.clear();
  sessionStorage.clear();
});

afterEach(() => {
  vi.restoreAllMocks();
});

function seedSessions(): void {
  const instances = useInstancesStore();
  instances.instances = [
    {
      id: "i1", name: "pc", online: true, lastSeenAt: null,
      sessions: [
        { alias: "backend", agent: "codex", workspace: "w" },
        { alias: "other", agent: "codex", workspace: "w" },
      ],
      agents: [], workspaces: [], agentCatalog: [],
    } as never,
  ];
}

describe("ChatPane scoped live state", () => {
  it("a split column reads its own liveTurn/plan/queue/busy, never the selection's", async () => {
    seedSessions();
    const chat = useChatStore();
    vi.spyOn(chat, "ensureSessionLoaded").mockResolvedValue(undefined);
    // Global selection sits on an idle session.
    chat.select("i1", "other");
    // The background session streams while the selection stays idle.
    chat.applyEvent({
      kind: "control-event", instanceId: "i1",
      event: { type: "turn-started", chatKey: "c", sessionAlias: "backend" },
    } as never);
    chat.applyEvent({
      kind: "control-event", instanceId: "i1",
      event: {
        type: "plan", chatKey: "c", sessionAlias: "backend",
        entries: [{ step: "scoped step", status: "in-progress" }],
      },
    } as never);
    chat.applyEvent({
      kind: "control-event", instanceId: "i1",
      event: {
        type: "queue-updated", chatKey: "c", sessionAlias: "backend",
        items: [{ id: "q1", textPreview: "scoped queued", enqueuedAt: "t1" }],
      },
    } as never);
    // The selected session carries decoy plan/queue rows.
    chat.applyEvent({
      kind: "control-event", instanceId: "i1",
      event: {
        type: "plan", chatKey: "c", sessionAlias: "other",
        entries: [{ step: "selected step", status: "done" }],
      },
    } as never);
    chat.applyEvent({
      kind: "control-event", instanceId: "i1",
      event: {
        type: "queue-updated", chatKey: "c", sessionAlias: "other",
        items: [{ id: "q9", textPreview: "selected queued", enqueuedAt: "t9" }],
      },
    } as never);

    const wrapper = mount(ChatPane, {
      props: { instanceId: "i1", sessionAlias: "backend", paneMode: "split" },
      global: {
        stubs: {
          MessageList: messageListStub,
          PlanPanel: planPanelStub,
          QueueStrip: queueStripStub,
          PromptInput: promptInputStub,
          ConversationInteractionForm: true,
        },
      },
    });
    await flushPromises();

    // Selection is idle — every live signal below must come from the scoped key.
    expect(chat.liveTurn).toBeNull();
    expect(chat.busy).toBe(false);
    const list = wrapper.findComponent({ name: "MessageList" });
    expect(list.props("liveTurn")).not.toBeNull();
    expect((list.props("liveTurn") as { status: string }).status).toBe("working");
    const input = wrapper.findComponent({ name: "PromptInput" });
    expect(input.props("busy")).toBe(true);
    const plan = wrapper.findComponent({ name: "PlanPanel" });
    expect(plan.props("entries")).toEqual([{ step: "scoped step", status: "in-progress" }]);
    expect(plan.props("active")).toBe(true);
    const queue = wrapper.findComponent({ name: "QueueStrip" });
    expect(queue.props("instanceId")).toBe("i1");
    expect(queue.props("sessionAlias")).toBe("backend");
  });
});
