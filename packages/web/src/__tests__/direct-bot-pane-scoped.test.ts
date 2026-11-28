import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import { MSG } from "@ganglion/xacpx-relay-protocol";
import { api } from "../api/client";
import { useDirectBotsStore } from "../stores/direct-bots";

const BOT = { id: "b1", name: "Reviewer", agent: "codex", workspace: "repo", enabled: true, updatedAt: "now" };
const TOPIC = {
  id: "t1", conversationId: "c1", title: "Default", status: "active",
  createdAt: "now", updatedAt: "now",
};

function runRow(id: string, state: string) {
  return {
    id, conversationId: "c1", topicId: "t1", requestMessageId: "m1", requestId: "req1",
    mode: "explicit", state, profileRevision: 1,
    createdAt: "2026-01-01T00:00:00.000Z", startedAt: "2026-01-01T00:00:00.000Z",
  };
}

beforeEach(() => {
  setActivePinia(createPinia());
  localStorage.clear();
  sessionStorage.clear();
});

afterEach(() => {
  vi.restoreAllMocks();
});

function mockRpc(handlers: Record<string, (payload: unknown) => unknown>) {
  return vi.spyOn(api, "rpc").mockImplementation(async (_instanceId: unknown, method: unknown, payload: unknown) => {
    const handler = handlers[String(method)];
    if (!handler) throw new Error(`unexpected rpc ${String(method)}`);
    return handler(payload);
  });
}

function seedScopeRpc() {
  return mockRpc({
    [MSG.botsList]: () => ({ bots: [BOT] }),
    [MSG.conversationsList]: () => ({ conversations: [{ id: "c1", botId: "b1", defaultTopicId: "t1" }] }),
    [MSG.topicsList]: () => ({ topics: [TOPIC] }),
    [MSG.runsList]: () => ({ runs: [], activeRunId: undefined }),
  });
}

describe("direct-bots background split scope", () => {
  it("ensureBotPaneScope resolves without touching the selection", async () => {
    seedScopeRpc();
    const store = useDirectBotsStore();
    const scope = await store.ensureBotPaneScope("i1", "b1");
    expect(scope).toEqual({ conversationId: "c1", topicId: "t1" });
    // Selection untouched.
    expect(store.instanceId).toBeNull();
    expect(store.selectedBotId).toBeNull();
    expect(store.activeTopicId).toBeNull();
    expect(store.messages).toHaveLength(0);
    // Pane record persisted the resolution.
    expect(store.getBotPaneState("i1", "b1")).toMatchObject({ conversationId: "c1", topicId: "t1" });
  });

  it("sendPromptTo sends at the scoped topic and tracks per-topic run/live", async () => {
    seedScopeRpc();
    const store = useDirectBotsStore();
    await store.ensureBotPaneScope("i1", "b1");
    const rpc = vi.spyOn(api, "rpc");
    rpc.mockImplementation(async (_instanceId: unknown, method: unknown) => {
      if (method === MSG.conversationPrompt) {
        return {
          message: {
            id: "m2", conversationId: "c1", topicId: "t1", seq: 2, role: "user",
            content: "hello", createdAt: "2026-01-01T00:00:01.000Z",
          },
          run: runRow("r1", "running"),
          memberTurn: null,
        };
      }
      throw new Error(`unexpected rpc ${String(method)}`);
    });
    const before = store.topicRevisionFor("i1", "c1", "t1");
    const outcome = await store.sendPromptTo("i1", "b1", "c1", "t1", "hello");
    expect(outcome).toBe("accepted");
    const promptCall = rpc.mock.calls.find((call) => call[1] === MSG.conversationPrompt);
    expect(promptCall?.[2]).toMatchObject({ conversationId: "c1", topicId: "t1", text: "hello" });
    expect(store.activeRunForTopic("i1", "c1", "t1")?.id).toBe("r1");
    expect(store.liveTurnForTopic("i1", "c1", "t1")).not.toBeNull();
    expect(store.topicRevisionFor("i1", "c1", "t1")).toBeGreaterThan(before);
    // Selection still untouched.
    expect(store.activeRun).toBeNull();
    expect(store.liveTurn).toBeNull();
  });

  it("mirror converges a scoped live turn from control events", async () => {
    seedScopeRpc();
    const store = useDirectBotsStore();
    await store.ensureBotPaneScope("i1", "b1");
    // A run starts on the scoped topic while the selection shows nothing.
    store.applyEvent({
      kind: "control-event", instanceId: "i1",
      event: {
        type: "member-turn-started",
        run: runRow("r2", "running"),
        memberTurn: { id: "mt1", runId: "r2", botId: "b1", conversationId: "c1", topicId: "t1", state: "running", attempt: 1 },
      },
    } as never);
    expect(store.activeRunForTopic("i1", "c1", "t1")?.id).toBe("r2");
    expect(store.liveTurnForTopic("i1", "c1", "t1")).not.toBeNull();
    expect(store.activeRun).toBeNull();
    // Streamed output appends to the scoped live turn only.
    store.applyEvent({
      kind: "control-event", instanceId: "i1",
      event: {
        type: "turn-output", chatKey: "c", sessionAlias: "s", chunk: "hello",
        conversation: { conversationId: "c1", topicId: "t1", runId: "r2", memberTurnId: "mt1" },
      },
    } as never);
    const live = store.liveTurnForTopic("i1", "c1", "t1");
    expect(live?.parts.map((p) => (p as { text?: string }).text).join("")).toContain("hello");
    expect(store.liveTurn).toBeNull();
    // The bot's durable reply for the tracked run retires the scoped bubble.
    store.applyEvent({
      kind: "control-event", instanceId: "i1",
      event: {
        type: "conversation-message",
        message: {
          id: "m3", conversationId: "c1", topicId: "t1", seq: 3, role: "bot", runId: "r2",
          content: "hello", createdAt: "2026-01-01T00:00:02.000Z",
        },
      },
    } as never);
    expect(store.liveTurnForTopic("i1", "c1", "t1")).toBeNull();
  });

  it("cancelRunFor stops the pane's own tracked run", async () => {
    seedScopeRpc();
    const store = useDirectBotsStore();
    await store.ensureBotPaneScope("i1", "b1");
    store.applyEvent({
      kind: "control-event", instanceId: "i1",
      event: {
        type: "member-turn-started",
        run: runRow("r3", "running"),
        memberTurn: { id: "mt3", runId: "r3", botId: "b1", conversationId: "c1", topicId: "t1", state: "running", attempt: 1 },
      },
    } as never);
    mockRpc({
      [MSG.runsCancel]: () => ({ ok: true, run: runRow("r3", "cancelled") }),
    });
    const stopped = await store.cancelRunFor("i1", "c1", "t1");
    expect(stopped).toBe(true);
    expect(store.activeRunForTopic("i1", "c1", "t1")?.state).toBe("cancelled");
    expect(store.liveTurnForTopic("i1", "c1", "t1")).toBeNull();
  });

  it("sendPromptTo creates the Default topic for a topicless scope", async () => {
    seedScopeRpc();
    const rpc = vi.spyOn(api, "rpc");
    rpc.mockImplementation(async (_instanceId: unknown, method: unknown) => {
      if (method === MSG.botsList) return { bots: [BOT] };
      if (method === MSG.conversationsList) return { conversations: [{ id: "c1", botId: "b1" }] };
      if (method === MSG.topicsList) return { topics: [] };
      if (method === MSG.topicsCreate) {
        return { topic: { ...TOPIC, id: "t-new", title: "Default" } };
      }
      if (method === MSG.runsList) return { runs: [], activeRunId: undefined };
      if (method === MSG.conversationPrompt) {
        return {
          message: {
            id: "m2", conversationId: "c1", topicId: "t-new", seq: 2, role: "user",
            content: "hello", createdAt: "2026-01-01T00:00:01.000Z",
          },
          run: { ...runRow("r9", "running"), topicId: "t-new" },
          memberTurn: null,
        };
      }
      throw new Error(`unexpected rpc ${String(method)}`);
    });
    const store = useDirectBotsStore();
    // Real flow resolves the (topicless) scope first, then sends.
    const scope = await store.ensureBotPaneScope("i1", "b1");
    expect(scope).toEqual({ conversationId: "c1", topicId: null });
    const outcome = await store.sendPromptTo("i1", "b1", "c1", null, "hello");
    expect(outcome).toBe("accepted");
    expect(rpc.mock.calls.some((call) => call[1] === MSG.topicsCreate)).toBe(true);
    expect(store.activeRunForTopic("i1", "c1", "t-new")?.id).toBe("r9");
  });
});
