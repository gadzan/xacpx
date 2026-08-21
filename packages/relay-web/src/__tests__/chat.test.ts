// packages/relay-web/src/__tests__/chat.test.ts
import { setActivePinia, createPinia } from "pinia";
import { beforeEach, expect, it, test, vi } from "vitest";
import { mount } from "@vue/test-utils";
import { nextTick, watch } from "vue";

const rpc = vi.fn();
vi.mock("../api/client", () => ({
  ApiError: class ApiError extends Error {
    constructor(public code: string, public status: number) {
      super(code);
    }
  },
  api: {
    // Keep get working against the fetch stub used by loadHistory.
    get: async (path: string) => {
      const res = await fetch(path, { credentials: "include" });
      return res.json();
    },
    rpc: (instanceId: string, type: string, payload?: unknown) => rpc(instanceId, type, payload),
  },
}));

import { useChatStore, loadPersistedSelection } from "../stores/chat";
import { useInstancesStore } from "../stores/instances";
import { useSessionControlsStore } from "../stores/session-controls";
import { ApiError } from "../api/client";
import PromptInput from "../components/PromptInput.vue";

beforeEach(() => {
  setActivePinia(createPinia());
  rpc.mockReset();
});

test("streaming turn output accumulates then commits on finish", () => {
  const store = useChatStore();
  store.select("i1", "backend");
  store.applyEvent({ kind: "control-event", instanceId: "i1", event: { type: "turn-output", chatKey: "relay:a1", sessionAlias: "backend", chunk: "hel" } });
  store.applyEvent({ kind: "control-event", instanceId: "i1", event: { type: "turn-output", chatKey: "relay:a1", sessionAlias: "backend", chunk: "lo" } });
  expect(store.streaming).toBe("hello");
  store.applyEvent({ kind: "control-event", instanceId: "i1", event: { type: "turn-finished", chatKey: "relay:a1", sessionAlias: "backend", ok: true } });
  expect(store.streaming).toBe("");
  expect(store.messages.at(-1)).toMatchObject({ direction: "out", text: "hello" });
});

test("clearSelection drops the active session, transcript and persisted selection", () => {
  const store = useChatStore();
  store.select("i1", "backend");
  expect(localStorage.getItem("xrelay.selectedSession")).toContain("backend");
  store.clearSelection();
  expect(store.instanceId).toBeNull();
  expect(store.sessionAlias).toBeNull();
  expect(store.messages).toEqual([]);
  expect(localStorage.getItem("xrelay.selectedSession")).toBeNull();
});

test("a scheduled turn-started surfaces its prompt as a badged inbound message (selected session)", () => {
  const store = useChatStore();
  store.select("i1", "backend");
  store.applyEvent({ kind: "control-event", instanceId: "i1", event: {
    type: "turn-started", chatKey: "relay:a1", sessionAlias: "backend",
    prompt: "summarize commits", scheduled: { taskId: "ab12", executeAt: "2026-06-16T09:00:00.000Z" },
  } } as never);
  const last = store.messages.at(-1)!;
  expect(last).toMatchObject({ direction: "in", text: "summarize commits", scheduled: { taskId: "ab12" } });
});

test("a scheduled turn-started for an unselected session does not pollute the open transcript", () => {
  const store = useChatStore();
  store.select("i1", "backend");
  store.applyEvent({ kind: "control-event", instanceId: "i1", event: {
    type: "turn-started", chatKey: "relay:a1", sessionAlias: "other",
    prompt: "do thing", scheduled: { taskId: "zz99", executeAt: "2026-06-16T09:00:00.000Z" },
  } } as never);
  expect(store.messages.some((m) => m.text === "do thing")).toBe(false);
});

test("an agent-message event appends structured agentMessage to transcript for selected session", () => {
  const store = useChatStore();
  store.select("i1", "backend");
  const peerMsg = {
    kind: "agent_message" as const,
    direction: "sent" as const,
    messageId: "msg_peer_1",
    conversationId: "conv_1",
    peer: {
      handle: "agent:node_2:endpoint_b",
      displayName: "Worker B",
      agent: "codex",
      workspace: "server",
    },
    content: "Schema update notification",
    createdAt: 1771234567890,
    status: "sent" as const,
  };
  store.applyEvent({
    kind: "control-event",
    instanceId: "i1",
    event: {
      type: "agent-message",
      chatKey: "relay:a1",
      sessionAlias: "backend",
      message: peerMsg,
    },
  } as never);
  const last = store.messages.at(-1)!;
  expect(last).toMatchObject({
    direction: "out",
    text: "Schema update notification",
    structured: { agentMessage: peerMsg },
  });
});

test("an agent-message event for unselected session marks session as unread", () => {
  const store = useChatStore();
  store.select("i1", "backend");
  const peerMsg = {
    kind: "agent_message" as const,
    direction: "received" as const,
    messageId: "msg_peer_2",
    conversationId: "conv_2",
    peer: {
      handle: "agent:node_1:endpoint_a",
      displayName: "Worker A",
      agent: "claude",
    },
    content: "Review requested",
    createdAt: 1771234567890,
    status: "delivered" as const,
  };
  store.applyEvent({
    kind: "control-event",
    instanceId: "i1",
    event: {
      type: "agent-message",
      chatKey: "relay:a1",
      sessionAlias: "other",
      message: peerMsg,
    },
  } as never);
  expect(store.messages.some((m) => m.text === "Review requested")).toBe(false);
  expect(store.unread.has("i1\0other")).toBe(true);
});

test("an inbound agent-message event appends a received row for the selected session", () => {
  const store = useChatStore();
  store.select("i1", "backend");
  const peerMsg = {
    kind: "agent_message" as const,
    direction: "received" as const,
    messageId: "msg_peer_3",
    conversationId: "conv_3",
    peer: {
      handle: "agent:node_1:endpoint_a",
      displayName: "Worker A",
      agent: "claude",
    },
    content: "Review requested",
    createdAt: 1771234567890,
    status: "delivered" as const,
  };
  store.applyEvent({
    kind: "control-event",
    instanceId: "i1",
    event: {
      type: "agent-message",
      chatKey: "relay:a1",
      sessionAlias: "backend",
      message: peerMsg,
    },
  } as never);
  const last = store.messages.at(-1)!;
  expect(last).toMatchObject({
    direction: "in",
    text: "Review requested",
    structured: { agentMessage: peerMsg },
  });
  // The row lands in the open transcript, not behind an unread badge.
  expect(store.messages).toHaveLength(1);
  expect(store.unread.has("i1\0backend")).toBe(false);
});

test("chat.send forwards agentMentions in rpc control.prompt", async () => {
  const store = useChatStore();
  store.select("i1", "backend");
  rpc.mockResolvedValue({ ok: true });
  const mentions = [{ range: [4, 12] as [number, number], handle: "agent:i1:worker_b" }];
  await store.send("Ask @Backend about the schema", [], mentions);
  expect(rpc).toHaveBeenCalledWith("i1", "control.prompt", {
    sessionAlias: "backend",
    text: "Ask @Backend about the schema",
    agentMentions: mentions,
  });
});

test("turn-usage updates sessionUsage (REPLACE) and survives turn-finished", () => {
  const store = useChatStore();
  store.select("i1", "backend");
  store.applyEvent({ kind: "control-event", instanceId: "i1", event: { type: "turn-usage", chatKey: "relay:a1", sessionAlias: "backend", used: 34606, size: 200000 } } as never);
  expect(store.sessionUsage).toEqual({ used: 34606, size: 200000 });
  // The model corrects the window mid-turn → latest wins.
  store.applyEvent({ kind: "control-event", instanceId: "i1", event: { type: "turn-usage", chatKey: "relay:a1", sessionAlias: "backend", used: 34612, size: 1000000 } } as never);
  expect(store.sessionUsage).toEqual({ used: 34612, size: 1000000 });
  // Persists past turn-finished (session-scoped, decoupled from the live turn).
  store.applyEvent({ kind: "control-event", instanceId: "i1", event: { type: "turn-finished", chatKey: "relay:a1", sessionAlias: "backend", ok: true } });
  expect(store.sessionUsage).toEqual({ used: 34612, size: 1000000 });
});

test("turn-usage retains cost and breakdown for the selected session", () => {
  const store = useChatStore();
  store.select("i1", "backend");
  store.applyEvent({ kind: "control-event", instanceId: "i1", event: {
    type: "turn-usage", chatKey: "relay:a1", sessionAlias: "backend", used: 1000, size: 200000,
    cost: { amount: 0.42, currency: "USD" }, breakdown: { inputTokens: 800, totalTokens: 920 },
  } } as never);
  expect(store.sessionUsage).toEqual({
    used: 1000, size: 200000,
    cost: { amount: 0.42, currency: "USD" }, breakdown: { inputTokens: 800, totalTokens: 920 },
  });
});

test("turn-usage for an unselected session does not leak into sessionUsage", () => {
  const store = useChatStore();
  store.select("i1", "backend");
  store.applyEvent({ kind: "control-event", instanceId: "i1", event: { type: "turn-usage", chatKey: "relay:a1", sessionAlias: "other", used: 1, size: 2 } } as never);
  expect(store.sessionUsage).toBeNull();
});

test("agent-commands populate sessionCommands for the selected session", () => {
  const store = useChatStore();
  store.select("i1", "backend");
  store.applyEvent({ kind: "control-event", instanceId: "i1", event: {
    type: "agent-commands", chatKey: "relay:a1", sessionAlias: "backend",
    commands: [{ name: "compact", description: "Compact" }, { name: "run", hasInput: true }],
  } } as never);
  expect(store.sessionCommands).toEqual([{ name: "compact", description: "Compact" }, { name: "run", hasInput: true }]);
});

test("sessionCommands is empty for a session that advertised none", () => {
  const store = useChatStore();
  store.select("i1", "backend");
  expect(store.sessionCommands).toEqual([]);
});

test("requestScrollToScheduled bumps a nonce-keyed scroll request", () => {
  const store = useChatStore();
  expect(store.scrollRequest).toBeNull();
  store.requestScrollToScheduled("ab12");
  expect(store.scrollRequest).toMatchObject({ taskId: "ab12" });
  const firstNonce = store.scrollRequest!.nonce;
  store.requestScrollToScheduled("ab12");
  expect(store.scrollRequest!.nonce).not.toBe(firstNonce); // repeat clicks re-trigger
});

test("events for a different session are ignored", () => {
  const store = useChatStore();
  store.select("i1", "backend");
  store.applyEvent({ kind: "control-event", instanceId: "i1", event: { type: "turn-output", chatKey: "x", sessionAlias: "other", chunk: "nope" } });
  expect(store.streaming).toBe("");
});

test("loadHistory pulls cached messages for the selected session", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
    messages: [{ instanceId: "i1", sessionAlias: "backend", direction: "in", text: "hi", createdAt: "t" }],
  }), { status: 200 })));
  const store = useChatStore();
  store.select("i1", "backend");
  await store.loadHistory();
  expect(store.messages.map((m) => m.text)).toEqual(["hi"]);
});

test("a delayed history response cannot overwrite a newly selected session", async () => {
  let resolveBackend!: (response: Response) => void;
  const backendResponse = new Promise<Response>((resolve) => { resolveBackend = resolve; });
  vi.stubGlobal("fetch", vi.fn((path: string) => {
    if (path.includes("/sessions/backend/")) return backendResponse;
    return Promise.resolve(new Response(JSON.stringify({
      messages: [{ id: 2, instanceId: "i1", sessionAlias: "frontend", direction: "out", text: "frontend history", createdAt: "t2" }],
    }), { status: 200 }));
  }));

  const store = useChatStore();
  store.select("i1", "backend");
  const staleLoad = store.loadHistory();
  store.select("i1", "frontend");
  await store.loadHistory();

  resolveBackend(new Response(JSON.stringify({
    messages: [{ id: 1, instanceId: "i1", sessionAlias: "backend", direction: "out", text: "stale backend", createdAt: "t1" }],
  }), { status: 200 }));
  await staleLoad;

  expect(store.sessionAlias).toBe("frontend");
  expect(store.messages.map((message) => message.text)).toEqual(["frontend history"]);
});

test("switching to a working session keeps history when its turn starts during the fetch", async () => {
  let resolveHistory!: (response: Response) => void;
  const historyResponse = new Promise<Response>((resolve) => { resolveHistory = resolve; });
  const historyBody = {
    messages: [
      { id: 1, instanceId: "i1", sessionAlias: "working", direction: "out", text: "older history", createdAt: "t1" },
      { id: 2, instanceId: "i1", sessionAlias: "working", direction: "in", text: "current task", createdAt: "t2" },
    ],
  };
  let requests = 0;
  vi.stubGlobal("fetch", vi.fn(() => (
    ++requests === 1
      ? historyResponse
      : Promise.resolve(new Response(JSON.stringify(historyBody), { status: 200 }))
  )));

  const store = useChatStore();
  store.select("i1", "working");
  const historyLoad = store.loadHistory();

  store.applyEvent({
    kind: "control-event",
    instanceId: "i1",
    event: {
      type: "turn-started",
      chatKey: "relay:x",
      sessionAlias: "working",
      prompt: "current task",
    },
  });

  resolveHistory(new Response(JSON.stringify(historyBody), { status: 200 }));
  await historyLoad;

  expect(store.messages.map((message) => message.text)).toEqual(["older history", "current task"]);
});

test("loadingHistory is raised while the initial history fetch is in flight", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ messages: [] }), { status: 200 })));
  const store = useChatStore();
  store.select("i1", "backend");
  expect(store.loadingHistory).toBe(false); // select alone doesn't raise it
  const load = store.loadHistory();
  expect(store.loadingHistory).toBe(true);
  await load;
  expect(store.loadingHistory).toBe(false);
});

test("a stale history response cannot dismiss the skeleton a newer selection raised", async () => {
  let resolveBackend!: (response: Response) => void;
  const backendResponse = new Promise<Response>((resolve) => { resolveBackend = resolve; });
  vi.stubGlobal("fetch", vi.fn((path: string) => {
    if (path.includes("/sessions/backend/")) return backendResponse;
    return Promise.resolve(new Response(JSON.stringify({ messages: [] }), { status: 200 }));
  }));

  const store = useChatStore();
  store.select("i1", "backend");
  const staleLoad = store.loadHistory();
  expect(store.loadingHistory).toBe(true);
  // Switching away drops the skeleton immediately (the new load raises it again).
  store.select("i1", "frontend");
  expect(store.loadingHistory).toBe(false);
  await store.loadHistory();
  expect(store.loadingHistory).toBe(false);
  // The stale backend response landing late must not re-touch the flag.
  resolveBackend(new Response(JSON.stringify({ messages: [] }), { status: 200 }));
  await staleLoad;
  expect(store.loadingHistory).toBe(false);
});

test("turn-finished invalidates an older history read and converges on the persisted final", async () => {
  let resolveStale!: (response: Response) => void;
  const staleResponse = new Promise<Response>((resolve) => { resolveStale = resolve; });
  let calls = 0;
  const fetchMock = vi.fn(() => {
    calls += 1;
    if (calls === 1) return staleResponse;
    return Promise.resolve(new Response(JSON.stringify({
      messages: [{ id: 9, instanceId: "i1", sessionAlias: "backend", direction: "out", text: "complete", createdAt: "persisted" }],
    }), { status: 200 }));
  });
  vi.stubGlobal("fetch", fetchMock);

  const store = useChatStore();
  store.select("i1", "backend");
  store.applyEvent({ kind: "control-event", instanceId: "i1", event: { type: "turn-started", chatKey: "c", sessionAlias: "backend" } } as never);
  store.applyEvent({ kind: "control-event", instanceId: "i1", event: { type: "turn-output", chatKey: "c", sessionAlias: "backend", chunk: "complete" } } as never);
  const staleLoad = store.loadHistory();

  store.applyEvent({ kind: "control-event", instanceId: "i1", event: { type: "turn-finished", chatKey: "c", sessionAlias: "backend", ok: true } } as never);
  await vi.waitFor(() => expect(store.messages).toEqual([
    expect.objectContaining({ id: 9, text: "complete" }),
  ]));

  resolveStale(new Response(JSON.stringify({ messages: [] }), { status: 200 }));
  await staleLoad;
  expect(store.messages).toHaveLength(1);
  expect(store.messages[0]).toMatchObject({ id: 9, text: "complete" });
});

test("a final row loaded before turn-finished is not left duplicated", async () => {
  const persisted = { id: 7, instanceId: "i1", sessionAlias: "backend", direction: "out", text: "done", createdAt: "persisted" };
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ messages: [persisted] }), { status: 200 })));

  const store = useChatStore();
  store.select("i1", "backend");
  store.applyEvent({ kind: "control-event", instanceId: "i1", event: { type: "turn-started", chatKey: "c", sessionAlias: "backend" } } as never);
  store.applyEvent({ kind: "control-event", instanceId: "i1", event: { type: "turn-output", chatKey: "c", sessionAlias: "backend", chunk: "done" } } as never);
  await store.loadHistory();

  store.applyEvent({ kind: "control-event", instanceId: "i1", event: { type: "turn-finished", chatKey: "c", sessionAlias: "backend", ok: true } } as never);
  await vi.waitFor(() => expect(store.messages).toEqual([expect.objectContaining({ id: 7, text: "done" })]));
});

test("seedActiveTurns rebuilds a live turn (working dot + HUD) lost on refresh", () => {
  const store = useChatStore();
  store.seedActiveTurns([
    { instanceId: "i1", sessionAlias: "backend", status: "streaming", startedAt: 1000, parts: [{ type: "text", text: "half-written" }] },
  ]);
  // The sidebar "working" dot lights up without the session being selected.
  expect(store.sessionAttention("i1", "backend")).toBe("working");
  expect(store.runningSince("i1", "backend")).toBe(1000);
  // Selecting the running session shows its live content + the busy HUD.
  store.select("i1", "backend");
  expect(store.busy).toBe(true);
  expect(store.streaming).toBe("half-written");
  // A later turn-finished finalizes the seeded turn into a persisted message.
  store.applyEvent({ kind: "control-event", instanceId: "i1", event: { type: "turn-finished", chatKey: "relay:a", sessionAlias: "backend", ok: true } });
  expect(store.busy).toBe(false);
  expect(store.messages.at(-1)).toMatchObject({ direction: "out", text: "half-written" });
});

test("a turn-finished racing ahead of seedActiveTurns does not resurrect the finished turn", () => {
  // Regression (review H1): the ws stream is live before the active-turns snapshot is
  // applied. If turn-finished arrives in that gap, seeding the stale snapshot must NOT
  // re-create the turn (which would wedge the session "working" forever). A different,
  // un-finished session in the same snapshot must still seed normally.
  const store = useChatStore();
  // The finish already arrived (no live turn existed to flush); then the stale snapshot lands.
  store.applyEvent({ kind: "control-event", instanceId: "i1", event: { type: "turn-finished", chatKey: "relay:a", sessionAlias: "raced", ok: true } });
  store.seedActiveTurns([
    { instanceId: "i1", sessionAlias: "raced", status: "streaming", startedAt: 1, parts: [{ type: "text", text: "stale" }] },
    { instanceId: "i1", sessionAlias: "fresh", status: "streaming", startedAt: 1, parts: [{ type: "text", text: "live" }] },
  ]);
  expect(store.sessionAttention("i1", "raced")).not.toBe("working"); // not resurrected
  expect(store.sessionAttention("i1", "fresh")).toBe("working"); // guard isn't over-broad
});

test("an ordered state snapshot replaces content missed while the browser was offline", () => {
  const store = useChatStore();
  store.select("i1", "backend");
  store.applyEvent({ kind: "control-event", instanceId: "i1", event: { type: "turn-started", chatKey: "c", sessionAlias: "backend" } } as never);
  store.applyEvent({ kind: "control-event", instanceId: "i1", event: { type: "turn-output", chatKey: "c", sessionAlias: "backend", chunk: "A" } } as never);

  store.applyEvent({
    kind: "state-snapshot", instanceId: "i1",
    turns: [{ instanceId: "i1", sessionAlias: "backend", status: "streaming", startedAt: 1, parts: [{ type: "text", text: "ABC" }] }],
    usage: [], commands: [],
  } as never);
  expect(store.streaming).toBe("ABC");

  // Same-socket ordering guarantees this delta follows the snapshot and is appended once.
  store.applyEvent({ kind: "control-event", instanceId: "i1", event: { type: "turn-output", chatKey: "c", sessionAlias: "backend", chunk: "D" } } as never);
  expect(store.streaming).toBe("ABCD");
});

test("a snapshot clears a stale finished turn without touching another instance", () => {
  const store = useChatStore();
  store.applyEvent({ kind: "control-event", instanceId: "i1", event: { type: "turn-started", chatKey: "c", sessionAlias: "done-offline" } } as never);
  store.applyEvent({ kind: "control-event", instanceId: "i2", event: { type: "turn-started", chatKey: "c", sessionAlias: "still-live" } } as never);
  expect(store.sessionAttention("i1", "done-offline")).toBe("working");

  store.applyEvent({ kind: "state-snapshot", instanceId: "i1", turns: [], usage: [], commands: [] } as never);
  expect(store.sessionAttention("i1", "done-offline")).toBe("idle");
  expect(store.sessionAttention("i2", "still-live")).toBe("working");
});

test("a state snapshot restores a complete folded subagent trace", () => {
  const store = useChatStore();
  store.select("i1", "backend");
  store.applyEvent({
    kind: "state-snapshot", instanceId: "i1",
    turns: [{
      instanceId: "i1", sessionAlias: "backend", status: "streaming", startedAt: 1,
      parts: [
        { type: "tool", step: { toolCallId: "agent-1", toolName: "Agent", kind: "think", status: "running", title: "Research", isSubagent: true } },
        { type: "tool", step: { toolCallId: "grep-1", parentToolCallId: "agent-1", toolName: "Grep", kind: "search", status: "success", title: "wechat" } },
        { type: "text", text: "主 Agent 继续整理" },
      ],
    }],
    usage: [], commands: [],
  } as never);
  expect(store.liveToolSteps).toHaveLength(2);
  expect(store.liveToolSteps[0]).toMatchObject({ isSubagent: true });
  expect(store.liveToolSteps[1]).toMatchObject({ parentToolCallId: "agent-1" });
  expect(store.streaming).toBe("主 Agent 继续整理");
});

test("loadActiveTurns fetches the in-flight snapshot and seeds it", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
    turns: [{ instanceId: "i1", sessionAlias: "backend", status: "streaming", startedAt: 5, parts: [{ type: "text", text: "live" }] }],
  }), { status: 200 })));
  const store = useChatStore();
  await store.loadActiveTurns();
  expect(store.sessionAttention("i1", "backend")).toBe("working");
  store.select("i1", "backend");
  expect(store.streaming).toBe("live");
});

test("loadActiveTurns seeds the per-session usage meter so the context bar survives a refresh", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
    turns: [],
    usage: [{ instanceId: "i1", sessionAlias: "backend", used: 1200, size: 8000, cost: { totalUsd: 0.5 } }],
  }), { status: 200 })));
  const store = useChatStore();
  await store.loadActiveTurns();
  store.select("i1", "backend");
  expect(store.sessionUsage).toEqual({ used: 1200, size: 8000, cost: { totalUsd: 0.5 } });
});

test("loadActiveTurns tolerates a snapshot without a usage field (older hub)", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ turns: [] }), { status: 200 })));
  const store = useChatStore();
  await store.loadActiveTurns();
  store.select("i1", "backend");
  expect(store.sessionUsage).toBeNull();
});

test("loadHistory records hasMore; loadOlder prepends the older page and updates the cursor", async () => {
  const calls: string[] = [];
  vi.stubGlobal("fetch", vi.fn(async (path: string) => {
    calls.push(path);
    if (path.includes("before=")) {
      // Older page: two rows immediately before id 10, and no more remain.
      return new Response(JSON.stringify({
        messages: [
          { id: 8, instanceId: "i1", sessionAlias: "s1", direction: "in", text: "older-a", createdAt: "t" },
          { id: 9, instanceId: "i1", sessionAlias: "s1", direction: "out", text: "older-b", createdAt: "t" },
        ],
        hasMore: false,
      }), { status: 200 });
    }
    // Initial page: most recent row id 10, with older history available.
    return new Response(JSON.stringify({
      messages: [{ id: 10, instanceId: "i1", sessionAlias: "s1", direction: "in", text: "newest", createdAt: "t" }],
      hasMore: true,
    }), { status: 200 });
  }));

  const chat = useChatStore();
  chat.select("i1", "s1");
  await chat.loadHistory();
  expect(chat.messages.map((m) => m.text)).toEqual(["newest"]);
  expect(chat.hasMoreOlder).toBe(true);

  await chat.loadOlder();
  // Older rows PREPENDED, oldest-first, ahead of the existing newest row.
  expect(chat.messages.map((m) => m.text)).toEqual(["older-a", "older-b", "newest"]);
  expect(chat.hasMoreOlder).toBe(false);
  // The cursor was the oldest id we held (10).
  expect(calls.some((c) => c.includes("before=10"))).toBe(true);
  expect(calls[0]).toBe("/api/instances/i1/sessions/s1/messages?limit=10&view=compact");
  expect(calls.some((c) => c.includes("view=compact"))).toBe(true);

  // No older remain → loadOlder is now a no-op (no extra fetch).
  const before = calls.length;
  await chat.loadOlder();
  expect(calls.length).toBe(before);
});

test("ensureFullMessage replaces a compact row with the full persisted structured payload", async () => {
  vi.stubGlobal("fetch", vi.fn(async (path: string) => {
    if (path.endsWith("/messages/7")) {
      return new Response(JSON.stringify({
        message: {
          id: 7,
          instanceId: "i1",
          sessionAlias: "s1",
          direction: "out",
          text: "done",
          createdAt: "t",
          structured: {
            parts: [{ type: "tool", step: { toolCallId: "t1", toolName: "Read", kind: "read", status: "success", title: "a.ts", detail: { type: "read", path: "a.ts", preview: "full file" } } }],
          },
        },
      }), { status: 200 });
    }
    return new Response(JSON.stringify({
      messages: [{
        id: 7,
        instanceId: "i1",
        sessionAlias: "s1",
        direction: "out",
        text: "done",
        createdAt: "t",
        structured: {
          compact: true,
          parts: [{ type: "tool", step: { toolCallId: "t1", toolName: "Read", kind: "read", status: "success", title: "a.ts", detail: { type: "read", path: "a.ts" } } }],
        },
      }],
    }), { status: 200 });
  }));

  const chat = useChatStore();
  chat.select("i1", "s1");
  await chat.loadHistory();
  expect(chat.messages[0]?.structured?.compact).toBe(true);
  await chat.ensureFullMessage(7);
  expect(chat.messages[0]?.structured?.compact).toBeUndefined();
  const part = chat.messages[0]?.structured?.parts?.[0];
  expect(part?.type === "tool" ? part.step.detail : undefined).toEqual({ type: "read", path: "a.ts", preview: "full file" });
});

test("loadHistory keeps a locally richer structured payload over a compact page", async () => {
  const full = {
    parts: [{ type: "text" as const, text: "done" }, { type: "tool" as const, step: { toolCallId: "t1", toolName: "Bash", kind: "execute" as const, status: "success" as const, title: "ls", detail: { type: "command" as const, command: "ls", output: "a.ts" } } }],
  };
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
    messages: [{
      id: 3,
      instanceId: "i1",
      sessionAlias: "s1",
      direction: "out",
      text: "done",
      createdAt: "t",
      structured: { compact: true, parts: [{ type: "text", text: "done" }, { type: "tool", step: { toolCallId: "t1", toolName: "Bash", kind: "execute", status: "success", title: "ls", detail: { type: "command", command: "ls" } } }] },
    }],
  }), { status: 200 })));

  const chat = useChatStore();
  chat.select("i1", "s1");
  chat.messages = [{
    id: 3,
    instanceId: "i1",
    sessionAlias: "s1",
    direction: "out",
    text: "done",
    createdAt: "t",
    structured: full,
  }];
  await chat.loadHistory();
  const part = chat.messages[0]?.structured?.parts?.find((p) => p.type === "tool");
  expect(chat.messages[0]?.structured?.compact).toBeUndefined();
  expect(part?.type === "tool" ? part.step.detail : undefined).toEqual({ type: "command", command: "ls", output: "a.ts" });
});

test("select persists the open session so a refresh can restore it", () => {
  const store = useChatStore();
  store.select("i9", "frontend");
  expect(loadPersistedSelection()).toEqual({ instanceId: "i9", alias: "frontend" });
});

test("surfaces an error when send fails", async () => {
  rpc.mockRejectedValueOnce(new ApiError("instance-offline", 503));
  const chat = useChatStore();
  chat.select("inst", "backend");
  await chat.send("hello");
  expect(chat.error).toBe("instance-offline");
  expect(chat.sending).toBe(false);
});

test("send waits for the selected effort to finish persisting", async () => {
  let resolveEffort!: (value: unknown) => void;
  rpc.mockReturnValueOnce(new Promise((resolve) => { resolveEffort = resolve; }));
  rpc.mockResolvedValueOnce({ ok: true });
  const controls = useSessionControlsStore();
  const chat = useChatStore();
  chat.select("i1", "backend");

  const setting = controls.setEffort("i1", "backend", "high");
  const sending = chat.send("use the new effort");
  for (let i = 0; i < 10; i += 1) await Promise.resolve();
  expect(rpc).toHaveBeenCalledTimes(1);
  expect(rpc).toHaveBeenNthCalledWith(1, "i1", "control.session.effort.set", {
    sessionAlias: "backend",
    effort: "high",
  });

  resolveEffort({ current: "high", applied: true });
  await setting;
  await sending;
  expect(rpc).toHaveBeenNthCalledWith(2, "i1", "control.prompt", {
    sessionAlias: "backend",
    text: "use the new effort",
  });
});

test("a failed send flips the bubble to failed REACTIVELY (not only on the next push)", async () => {
  const chat = useChatStore();
  chat.select("i1", "backend");
  // Mirror MessageList's template dependency: it reads `m.failed` on each row. Watch that and
  // record every reactive transition. The bug: send() mutated `failed` on the RAW optimistic
  // object, which never trips Vue's proxy set-trap — so this watcher would only observe the
  // flip on a later array push, exactly matching "the bubble goes red only after I type again".
  const observed: boolean[] = [];
  watch(
    () => chat.messages.some((m) => m.failed === true),
    (v) => observed.push(v),
    { flush: "sync" },
  );
  rpc.mockResolvedValueOnce({ ok: false, errorMessage: "boom" });
  await chat.send("hi");
  await nextTick();
  expect(chat.messages).toHaveLength(1);
  expect(chat.messages[0]!.failed).toBe(true); // final value is correct either way
  expect(chat.error).toBe("boom");
  // The reactive proof: the watcher must have seen the transition to `true` with no further
  // list mutation. On the raw-mutation bug this stays [] (or all false) and the assertion fails.
  expect(observed).toContain(true);
});

test("resend drops the failed attempt and re-sends, leaving one clean entry on success", async () => {
  const chat = useChatStore();
  chat.select("i1", "s1");
  // First attempt fails (non-timeout) → the optimistic user message is marked failed.
  rpc.mockRejectedValueOnce(new ApiError("instance-offline", 503));
  await chat.send("play");
  const failed = chat.messages.at(-1)!;
  expect(failed.failed).toBe(true);
  expect(chat.messages.filter((m) => m.direction === "in")).toHaveLength(1);

  // Retry succeeds → exactly one "in" entry remains (the failed one was dropped), not two.
  rpc.mockResolvedValueOnce({ ok: true });
  await chat.resend(failed);
  const ins = chat.messages.filter((m) => m.direction === "in");
  expect(ins).toHaveLength(1);
  expect(ins[0]?.text).toBe("play");
  expect(ins[0]?.failed).toBeUndefined();
  expect(chat.error).toBe("");
});

test("a prompt RPC timeout does not surface an error (results stream via events)", async () => {
  rpc.mockRejectedValueOnce(new ApiError("timeout", 504));
  const chat = useChatStore();
  chat.select("i1", "s1");
  await chat.send("hi");
  expect(chat.error).toBe("");
  expect(chat.messages.at(-1)?.failed).toBeUndefined(); // optimistic msg not marked failed
  expect(chat.sending).toBe(false);
});

test("network jitter after a turn starts does not mark the accepted prompt as send-failed", async () => {
  let rejectPrompt!: (error: unknown) => void;
  rpc.mockReturnValueOnce(new Promise((_resolve, reject) => { rejectPrompt = reject; }));
  const chat = useChatStore();
  chat.select("i1", "s1");
  const sending = chat.send("keep working");

  chat.applyEvent({ kind: "control-event", instanceId: "i1", event: {
    type: "turn-started", chatKey: "relay:a1", sessionAlias: "s1",
  } });
  chat.applyEvent({ kind: "control-event", instanceId: "i1", event: {
    type: "turn-output", chatKey: "relay:a1", sessionAlias: "s1", chunk: "still running",
  } });
  rejectPrompt(new TypeError("Failed to fetch"));
  await sending;

  expect(chat.error).toBe("");
  expect(chat.messages.at(-1)?.failed).toBeUndefined();
  expect(chat.streaming).toBe("still running");
});

test("network jitter without turn events converges the optimistic prompt from history", async () => {
  rpc.mockRejectedValueOnce(new TypeError("Failed to fetch"));
  const fetchMock = vi.fn(async () => new Response(JSON.stringify({ messages: [] }), { status: 200 }));
  vi.stubGlobal("fetch", fetchMock);
  const chat = useChatStore();
  chat.select("i1", "s1");
  await chat.send("never arrived");
  await new Promise((resolve) => setTimeout(resolve, 0));

  expect(fetchMock).toHaveBeenCalledWith("/api/instances/i1/sessions/s1/messages?limit=10&view=compact", { credentials: "include" });
  expect(chat.messages).toEqual([]);
  expect(chat.error).toBe("");
});

test("a non-timeout prompt error still surfaces", async () => {
  rpc.mockRejectedValueOnce(new ApiError("instance-offline", 503));
  const chat = useChatStore();
  chat.select("i1", "s1");
  await chat.send("hi");
  expect(chat.error).toBe("instance-offline");
  expect(chat.messages.at(-1)?.failed).toBe(true);
});

test("a /-prefixed message is a prompt: a timeout is treated as pending, not an error", async () => {
  // `/` commands are no longer request/response — the web forwards them to the agent as
  // prompts, so a 504/timeout means "the turn may still be running" (pending), exactly
  // like a plain prompt, rather than a hard failure.
  rpc.mockRejectedValueOnce(new ApiError("timeout", 504));
  const chat = useChatStore();
  chat.select("i1", "s1");
  await chat.send("/status");
  expect(chat.error).toBe("");
  expect(chat.messages.at(-1)?.failed).toBeUndefined();
});

test("keeps a per-session streaming buffer across selection changes", () => {
  const chat = useChatStore();
  chat.select("inst", "A");
  chat.applyEvent({ kind: "control-event", instanceId: "inst", event: { type: "turn-output", chatKey: "relay:x", sessionAlias: "A", chunk: "partial-A" } });
  chat.select("inst", "B");
  expect(chat.streaming).toBe("");
  chat.select("inst", "A");
  expect(chat.streaming).toBe("partial-A");
});

test("sends `/`-prefixed text as a prompt (web forwards slash commands to the agent)", async () => {
  rpc.mockResolvedValueOnce({ ok: true });
  const chat = useChatStore();
  chat.select("inst", "backend");
  await chat.send("/status");
  // The web dashboard never invokes xacpx command handling; `/status` streams as a turn.
  expect(rpc).toHaveBeenCalledWith("inst", "control.prompt", { sessionAlias: "backend", text: "/status" });
  expect(rpc).not.toHaveBeenCalledWith("inst", "control.command.execute", expect.anything());
});

it("drops an instance's stream buffers when it goes offline", () => {
  const chat = useChatStore();
  chat.select("inst", "A");
  chat.applyEvent({ kind: "control-event", instanceId: "inst", event: { type: "turn-output", chatKey: "relay:x", sessionAlias: "A", chunk: "partial" } });
  expect(chat.streaming).toBe("partial");
  chat.applyEvent({ kind: "instance-status", instanceId: "inst", online: false });
  expect(chat.streaming).toBe("");
});

it("keys buffers by NUL so space-containing names do not collide", () => {
  const chat = useChatStore();
  chat.select("a b", "c");
  chat.applyEvent({ kind: "control-event", instanceId: "a b", event: { type: "turn-output", chatKey: "relay:x", sessionAlias: "c", chunk: "X" } });
  chat.select("a", "b c");
  // With a space delimiter both would map to "a b c" and collide; with NUL they are distinct.
  expect(chat.streaming).toBe("");
});

it("turn-finished with ok:false surfaces an error and marks the tail failed", () => {
  const chat = useChatStore();
  chat.select("inst", "A");
  chat.applyEvent({ kind: "control-event", instanceId: "inst", event: { type: "turn-output", chatKey: "c", sessionAlias: "A", chunk: "partial" } });
  chat.applyEvent({ kind: "control-event", instanceId: "inst", event: { type: "turn-finished", chatKey: "c", sessionAlias: "A", ok: false, errorMessage: "boom" } });
  expect(chat.error).toBe("boom");
  const last = chat.messages[chat.messages.length - 1];
  expect(last?.failed ?? false).toBe(true);
});

it("turn-finished with ok:true does not set error", () => {
  const chat = useChatStore();
  chat.select("inst", "A");
  chat.applyEvent({ kind: "control-event", instanceId: "inst", event: { type: "turn-output", chatKey: "c", sessionAlias: "A", chunk: "hi" } });
  chat.applyEvent({ kind: "control-event", instanceId: "inst", event: { type: "turn-finished", chatKey: "c", sessionAlias: "A", ok: true } });
  expect(chat.error).toBe("");
  expect(chat.messages[chat.messages.length - 1].failed ?? false).toBe(false);
});

it("clears error on session select", () => {
  const chat = useChatStore();
  chat.select("inst", "A");
  chat.error = "stale";
  chat.select("inst", "B");
  expect(chat.error).toBe("");
});

it("marks the optimistic message failed when send rejects", async () => {
  rpc.mockRejectedValueOnce(new ApiError("instance-offline", 503));
  const chat = useChatStore();
  chat.select("inst", "A");
  await chat.send("hello");
  const last = chat.messages[chat.messages.length - 1];
  expect(last.direction).toBe("in");
  expect(last.failed).toBe(true);
  expect(chat.error).toBe("instance-offline");
});

it("cancel sends control.prompt.cancel for the selected session", async () => {
  rpc.mockResolvedValueOnce({ cancelled: true });
  const chat = useChatStore();
  chat.select("inst", "A");
  await chat.cancel();
  expect(rpc).toHaveBeenCalledWith("inst", "control.prompt.cancel", { sessionAlias: "A" });
});

it("cancel surfaces an error code on failure", async () => {
  rpc.mockRejectedValueOnce(new ApiError("instance-offline", 503));
  const chat = useChatStore();
  chat.select("inst", "A");
  await chat.cancel();
  expect(chat.error).toBe("instance-offline");
});

it("cancel optimistically releases busy and preserves streamed content; the late echo is a no-op", async () => {
  rpc.mockResolvedValueOnce({ cancelled: true });
  const chat = useChatStore();
  chat.select("inst", "A");
  chat.applyEvent({ kind: "control-event", instanceId: "inst", event: { type: "turn-started", chatKey: "c", sessionAlias: "A" } } as never);
  chat.applyEvent({ kind: "control-event", instanceId: "inst", event: { type: "turn-output", chatKey: "c", sessionAlias: "A", chunk: "half a" } } as never);
  expect(chat.busy).toBe(true);
  await chat.cancel();
  // input/HUD release immediately, without waiting for any server turn-finished echo
  expect(chat.busy).toBe(false);
  const flushed = chat.messages.at(-1);
  expect(flushed).toMatchObject({ direction: "out", text: "half a", status: "cancelled" });
  // a server echo arriving afterwards must not double-render
  const before = chat.messages.length;
  chat.applyEvent({ kind: "control-event", instanceId: "inst", event: { type: "turn-finished", chatKey: "c", sessionAlias: "A", ok: false, cancelled: true } } as never);
  expect(chat.messages.length).toBe(before);
});

it("cancel is a no-op with no session selected", async () => {
  const chat = useChatStore();
  await chat.cancel();
  expect(rpc).not.toHaveBeenCalled();
});

test("PromptInput emits send with trimmed text and clears", async () => {
  const wrapper = mount(PromptInput);
  await wrapper.find("textarea").setValue("  do it  ");
  await wrapper.find("form").trigger("submit.prevent");
  expect(wrapper.emitted("send")?.[0]).toEqual(["do it", []]);
  expect((wrapper.find("textarea").element as HTMLTextAreaElement).value).toBe("");
});

test("live turn accumulates tool steps, reasoning, and flushes structured on finish", () => {
  const store = useChatStore();
  store.select("i1", "backend");
  store.applyEvent({ kind: "control-event", instanceId: "i1", event: { type: "turn-started", chatKey: "c", sessionAlias: "backend" } } as never);
  expect(store.busy).toBe(true);
  store.applyEvent({ kind: "control-event", instanceId: "i1", event: { type: "tool-event", chatKey: "c", sessionAlias: "backend", step: { toolCallId: "t1", toolName: "Bash", kind: "execute", status: "running", title: "ls" } } } as never);
  store.applyEvent({ kind: "control-event", instanceId: "i1", event: { type: "tool-event", chatKey: "c", sessionAlias: "backend", step: { toolCallId: "t1", toolName: "Bash", kind: "execute", status: "success", title: "ls" } } } as never);
  store.applyEvent({ kind: "control-event", instanceId: "i1", event: { type: "turn-thought", chatKey: "c", sessionAlias: "backend", chunk: "reasoning" } } as never);
  store.applyEvent({ kind: "control-event", instanceId: "i1", event: { type: "turn-output", chatKey: "c", sessionAlias: "backend", chunk: "answer" } } as never);
  // Parts preserve arrival order: tool, then reasoning, then text.
  expect(store.liveTurn?.parts.map((p) => p.type)).toEqual(["tool", "reasoning", "text"]);
  expect(store.liveToolSteps.length).toBe(1);
  store.applyEvent({ kind: "control-event", instanceId: "i1", event: { type: "turn-finished", chatKey: "c", sessionAlias: "backend", ok: true } } as never);
  expect(store.busy).toBe(false);
  expect(store.liveTurn).toBeNull();
  const last = store.messages.at(-1)!;
  expect(last).toMatchObject({ direction: "out", text: "answer", status: "done" });
  expect(last.structured?.toolSteps?.length).toBe(1);
  expect(last.structured?.reasoning).toBe("reasoning");
  // The ordered transcript is persisted for inline replay on history reload.
  expect(last.structured?.parts?.map((p) => p.type)).toEqual(["tool", "reasoning", "text"]);
});

it("sets the session plan on a plan event and replaces it on the next", () => {
  const chat = useChatStore();
  chat.select("i1", "backend");
  const ev = (entries: unknown) => chat.applyEvent({ kind: "control-event", instanceId: "i1",
    event: { type: "plan", chatKey: "relay:i1", sessionAlias: "backend", entries } } as never);
  ev([{ content: "a", status: "in_progress" }]);
  expect(chat.sessionPlan).toEqual([{ content: "a", status: "in_progress" }]);
  ev([{ content: "a", status: "completed" }, { content: "b", status: "pending" }]);
  expect(chat.sessionPlan?.length).toBe(2); // replace, not append
});

it("keeps the session plan after the turn finishes (does not vanish)", () => {
  const chat = useChatStore();
  chat.select("i1", "backend");
  const apply = (event: unknown) => chat.applyEvent({ kind: "control-event", instanceId: "i1", event } as never);
  // a turn is running and emits a plan
  apply({ type: "turn-started", chatKey: "relay:i1", sessionAlias: "backend" });
  apply({ type: "plan", chatKey: "relay:i1", sessionAlias: "backend", entries: [{ content: "a", status: "in_progress" }] });
  expect(chat.sessionPlan?.length).toBe(1);
  expect(chat.busy).toBe(true);
  // turn ends (agent paused to ask a question)
  apply({ type: "turn-finished", chatKey: "relay:i1", sessionAlias: "backend", ok: true });
  // the live turn is gone but the plan persists
  expect(chat.busy).toBe(false);
  expect(chat.sessionPlan?.length).toBe(1);
});

test("a cancelled finish marks the turn stopped, not errored", () => {
  const store = useChatStore();
  store.select("i1", "backend");
  store.applyEvent({ kind: "control-event", instanceId: "i1", event: { type: "turn-started", chatKey: "c", sessionAlias: "backend" } } as never);
  store.applyEvent({ kind: "control-event", instanceId: "i1", event: { type: "turn-output", chatKey: "c", sessionAlias: "backend", chunk: "partial" } } as never);
  store.applyEvent({ kind: "control-event", instanceId: "i1", event: { type: "turn-finished", chatKey: "c", sessionAlias: "backend", ok: false, cancelled: true } } as never);
  expect(store.error).toBe("");
  expect(store.messages.at(-1)).toMatchObject({ status: "cancelled", text: "partial" });
});

test("PromptInput stays composable while busy, shows Send (not Stop), and queues on submit", async () => {
  const wrapper = mount(PromptInput, { props: { busy: true } });
  // Textarea is intentionally enabled while busy (pre-compose / Esc-to-stop).
  expect((wrapper.find("textarea").element as HTMLTextAreaElement).disabled).toBe(false);
  expect(wrapper.find('[data-test="composer-stop"]').exists()).toBe(false);
  expect(wrapper.find('[data-test="composer-send"]').exists()).toBe(true);
  await wrapper.find("textarea").setValue("queued while busy");
  await wrapper.find("textarea").trigger("keydown", { key: "Enter" });
  // Submitting while busy is no longer blocked — the message queues server-side.
  expect(wrapper.emitted("send")?.[0]).toEqual(["queued while busy", []]);
});

test("PromptInput Esc-while-busy emits cancel", async () => {
  const wrapper = mount(PromptInput, { props: { busy: true } });
  await wrapper.find("textarea").trigger("keydown", { key: "Escape" });
  expect(wrapper.emitted("cancel")?.length).toBe(1);
});

test("a finished turn on an unviewed session becomes unread, and select clears it", () => {
  const store = useChatStore();
  store.select("i1", "backend"); // viewing backend, not frontend
  store.applyEvent({ kind: "control-event", instanceId: "i1", event: { type: "turn-finished", chatKey: "c", sessionAlias: "frontend", ok: true } } as never);
  expect(store.sessionAttention("i1", "frontend")).toBe("unread");
  expect(store.sessionAttention("i1", "backend")).toBe("idle"); // viewed → no unread
  store.select("i1", "frontend");
  expect(store.sessionAttention("i1", "frontend")).toBe("idle");
});

test("working (a live turn) outranks unread", () => {
  const store = useChatStore();
  store.select("i1", "backend");
  store.applyEvent({ kind: "control-event", instanceId: "i1", event: { type: "turn-finished", chatKey: "c", sessionAlias: "frontend", ok: true } } as never);
  expect(store.sessionAttention("i1", "frontend")).toBe("unread");
  store.applyEvent({ kind: "control-event", instanceId: "i1", event: { type: "turn-started", chatKey: "c", sessionAlias: "frontend" } } as never);
  expect(store.sessionAttention("i1", "frontend")).toBe("working");
});

test("an instance going offline clears its unread signals", () => {
  const store = useChatStore();
  store.select("i1", "backend");
  store.applyEvent({ kind: "control-event", instanceId: "i1", event: { type: "turn-finished", chatKey: "c", sessionAlias: "frontend", ok: true } } as never);
  expect(store.sessionAttention("i1", "frontend")).toBe("unread");
  store.applyEvent({ kind: "instance-status", instanceId: "i1", online: false } as never);
  expect(store.sessionAttention("i1", "frontend")).toBe("idle");
});

test("a cancelled turn on an unviewed session does NOT mark unread", () => {
  const store = useChatStore();
  store.select("i1", "backend");
  store.applyEvent({ kind: "control-event", instanceId: "i1", event: { type: "turn-finished", chatKey: "c", sessionAlias: "frontend", ok: false, cancelled: true } } as never);
  expect(store.sessionAttention("i1", "frontend")).toBe("idle");
});

test("blank thought chunks never open an empty reasoning block", () => {
  const store = useChatStore();
  store.select("i1", "backend");
  const ev = (event: unknown) => store.applyEvent({ kind: "control-event", instanceId: "i1", event } as never);
  ev({ type: "turn-started", chatKey: "relay:a1", sessionAlias: "backend" });
  // Some models (e.g. glm-5.2) stream empty / whitespace-only thought deltas.
  ev({ type: "turn-thought", chatKey: "relay:a1", sessionAlias: "backend", chunk: "" });
  ev({ type: "turn-thought", chatKey: "relay:a1", sessionAlias: "backend", chunk: "   \n" });
  ev({ type: "turn-output", chatKey: "relay:a1", sessionAlias: "backend", chunk: "hi" });
  ev({ type: "turn-finished", chatKey: "relay:a1", sessionAlias: "backend", ok: true });
  const m = store.messages.at(-1)!;
  expect(m.structured?.reasoning).toBeUndefined();
  expect((m.structured?.parts ?? []).some((p) => p.type === "reasoning")).toBe(false);
});

test("whitespace between non-blank reasoning chunks is preserved", () => {
  const store = useChatStore();
  store.select("i1", "backend");
  const ev = (event: unknown) => store.applyEvent({ kind: "control-event", instanceId: "i1", event } as never);
  ev({ type: "turn-started", chatKey: "relay:a1", sessionAlias: "backend" });
  ev({ type: "turn-thought", chatKey: "relay:a1", sessionAlias: "backend", chunk: "line1" });
  ev({ type: "turn-thought", chatKey: "relay:a1", sessionAlias: "backend", chunk: "\n\n" });
  ev({ type: "turn-thought", chatKey: "relay:a1", sessionAlias: "backend", chunk: "line2" });
  ev({ type: "turn-finished", chatKey: "relay:a1", sessionAlias: "backend", ok: true });
  expect(store.messages.at(-1)!.structured?.reasoning).toBe("line1\n\nline2");
});

function seedColdSleepingRow(warm: boolean | undefined, archived: boolean) {
  const instancesStore = useInstancesStore();
  instancesStore.instances = [{
    id: "i1", name: "pc", online: true, lastSeenAt: null, sessionsLoaded: true, agents: [], workspaces: [], agentCatalog: [],
    sessions: [{ alias: "backend", agent: "codex", workspace: "/w", transportSession: "t", running: false, archived, ...(warm === undefined ? {} : { warm }) }],
  }];
  return instancesStore.instances[0]!.sessions[0]!;
}

test("send optimistically clears the cold and sleeping indicators (prompt wakes/warms the session)", async () => {
  const row = seedColdSleepingRow(false, true);
  rpc.mockResolvedValueOnce({ ok: true });
  const chat = useChatStore();
  chat.select("i1", "backend");
  const sending = chat.send("wake up");
  // Cleared BEFORE the RPC resolves — that's the optimistic part.
  expect(row.warm).toBe(true);
  expect(row.archived).toBe(false);
  await sending;
  expect(row.warm).toBe(true);
  expect(row.archived).toBe(false);
});

test("a failed send restores the cold and sleeping indicators", async () => {
  const row = seedColdSleepingRow(false, true);
  rpc.mockRejectedValueOnce(new ApiError("instance-offline", 503));
  const chat = useChatStore();
  chat.select("i1", "backend");
  await chat.send("wake up");
  expect(row.warm).toBe(false);
  expect(row.archived).toBe(true);
});

test("an ok:false prompt result restores the cold indicator", async () => {
  const row = seedColdSleepingRow(false, false);
  rpc.mockResolvedValueOnce({ ok: false, errorMessage: "boom" });
  const chat = useChatStore();
  chat.select("i1", "backend");
  await chat.send("hi");
  expect(row.warm).toBe(false);
});

test("a prompt RPC timeout keeps the indicators cleared (turn may still be running)", async () => {
  const row = seedColdSleepingRow(false, true);
  rpc.mockRejectedValueOnce(new ApiError("timeout", 504));
  const chat = useChatStore();
  chat.select("i1", "backend");
  await chat.send("hi");
  expect(row.warm).toBe(true);
  expect(row.archived).toBe(false);
});

test("send leaves an unknown-warmth row untouched (warm stays undefined)", async () => {
  const row = seedColdSleepingRow(undefined, false);
  rpc.mockResolvedValueOnce({ ok: true });
  const chat = useChatStore();
  chat.select("i1", "backend");
  await chat.send("hi");
  expect(row.warm).toBeUndefined();
  expect(row.archived).toBe(false);
});

test("rollback after the row was replaced by a re-fetch is a no-op on the new row", async () => {
  seedColdSleepingRow(false, true);
  let rejectPrompt!: (e: unknown) => void;
  rpc.mockReturnValueOnce(new Promise((_resolve, reject) => { rejectPrompt = reject; }));
  const chat = useChatStore();
  chat.select("i1", "backend");
  const sending = chat.send("wake up");
  // Mid-flight, a sessions-changed re-fetch replaces the whole array with server truth.
  const instancesStore = useInstancesStore();
  instancesStore.instances[0]!.sessions = [{ alias: "backend", agent: "codex", workspace: "/w", transportSession: "t", running: false, archived: false, warm: true }];
  const freshRow = instancesStore.instances[0]!.sessions[0]!;
  rejectPrompt(new ApiError("instance-offline", 503));
  await sending;
  // The rollback mutated only the detached old row; server truth stays untouched.
  expect(freshRow.warm).toBe(true);
  expect(freshRow.archived).toBe(false);
});
