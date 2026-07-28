// packages/relay-web/src/__tests__/chat-queue.test.ts
import { setActivePinia, createPinia } from "pinia";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const rpc = vi.fn();
const originalFetch = globalThis.fetch;
vi.mock("../api/client", () => ({
  ApiError: class ApiError extends Error {
    constructor(public code: string, public status: number) {
      super(code);
    }
  },
  api: {
    get: async (path: string) => {
      const res = await fetch(path, { credentials: "include" });
      return res.json();
    },
    rpc: (instanceId: string, type: string, payload?: unknown) => rpc(instanceId, type, payload),
  },
}));

import { useChatStore } from "../stores/chat";
import type { WebServerEvent } from "@ganglion/xacpx-relay-protocol";

beforeEach(() => {
  setActivePinia(createPinia());
  rpc.mockReset();
});

afterEach(() => { globalThis.fetch = originalFetch; });

it("queue-updated replaces the per-session queue list", () => {
  const chat = useChatStore();
  chat.select("i1", "s");
  chat.applyEvent({ kind: "control-event", instanceId: "i1", event: { type: "queue-updated", chatKey: "c", sessionAlias: "s", items: [{ id: "q1", textPreview: "hi", enqueuedAt: "t" }] } } as WebServerEvent);
  expect(chat.sessionQueue.map((i) => i.id)).toEqual(["q1"]);
  chat.applyEvent({ kind: "control-event", instanceId: "i1", event: { type: "queue-updated", chatKey: "c", sessionAlias: "s", items: [] } } as WebServerEvent);
  expect(chat.sessionQueue).toEqual([]);
});

it("sending while busy still issues control.prompt and pushes the optimistic bubble", async () => {
  rpc.mockResolvedValueOnce({ ok: true });
  const chat = useChatStore();
  chat.select("i1", "s");
  // make the session busy: a live turn exists
  chat.applyEvent({ kind: "control-event", instanceId: "i1", event: { type: "turn-started", chatKey: "c", sessionAlias: "s" } } as WebServerEvent);
  expect(chat.busy).toBe(true);
  const before = chat.messages.length;
  await chat.send("queued msg");
  expect(chat.messages.length).toBe(before + 1); // bubble pushed as normal
  expect(rpc).toHaveBeenCalledWith("i1", "control.prompt", { sessionAlias: "s", text: "queued msg" });
});

it("moves a drained queued prompt after the previous reply without duplicating it", async () => {
  rpc.mockResolvedValueOnce({ ok: true, queued: true, queueItemId: "q1" });
  const chat = useChatStore();
  chat.select("i1", "s");
  chat.applyEvent({ kind: "control-event", instanceId: "i1", event: { type: "turn-started", chatKey: "c", sessionAlias: "s" } } as WebServerEvent);
  chat.applyEvent({ kind: "control-event", instanceId: "i1", event: { type: "turn-output", chatKey: "c", sessionAlias: "s", chunk: "first reply" } } as WebServerEvent);

  await chat.send("queued prompt");
  chat.applyEvent({ kind: "control-event", instanceId: "i1", event: { type: "turn-finished", chatKey: "c", sessionAlias: "s", ok: true } } as WebServerEvent);
  chat.applyEvent({ kind: "control-event", instanceId: "i1", event: { type: "turn-started", chatKey: "c", sessionAlias: "s", queueItemId: "q1", prompt: "queued prompt" } } as WebServerEvent);

  expect(chat.messages.map((message) => [message.direction, message.text])).toEqual([
    ["out", "first reply"],
    ["in", "queued prompt"],
  ]);
});

it("reconciles when the drain event arrives before the queued RPC response", async () => {
  let resolveRpc!: (value: unknown) => void;
  rpc.mockImplementationOnce(() => new Promise((resolve) => { resolveRpc = resolve; }));
  const chat = useChatStore();
  chat.select("i1", "s");
  chat.applyEvent({ kind: "control-event", instanceId: "i1", event: { type: "turn-started", chatKey: "c", sessionAlias: "s" } } as WebServerEvent);
  chat.applyEvent({ kind: "control-event", instanceId: "i1", event: { type: "turn-output", chatKey: "c", sessionAlias: "s", chunk: "first reply" } } as WebServerEvent);

  const sending = chat.send("queued prompt");
  chat.applyEvent({ kind: "control-event", instanceId: "i1", event: { type: "turn-finished", chatKey: "c", sessionAlias: "s", ok: true } } as WebServerEvent);
  chat.applyEvent({ kind: "control-event", instanceId: "i1", event: { type: "turn-started", chatKey: "c", sessionAlias: "s", queueItemId: "q1", prompt: "queued prompt" } } as WebServerEvent);
  chat.applyEvent({ kind: "control-event", instanceId: "i1", event: { type: "turn-output", chatKey: "c", sessionAlias: "s", chunk: "second reply" } } as WebServerEvent);
  chat.applyEvent({ kind: "control-event", instanceId: "i1", event: { type: "turn-finished", chatKey: "c", sessionAlias: "s", ok: true } } as WebServerEvent);
  resolveRpc({ ok: true, queued: true, queueItemId: "q1" });
  await sending;

  expect(chat.messages.map((message) => [message.direction, message.text])).toEqual([
    ["out", "first reply"],
    ["in", "queued prompt"],
    ["out", "second reply"],
  ]);
});

it("keeps queue correlation across the previous turn history reload", async () => {
  rpc.mockResolvedValueOnce({ ok: true, queued: true, queueItemId: "q1" });
  globalThis.fetch = vi.fn().mockResolvedValue({
    json: async () => ({
      messages: [
        { id: 1, instanceId: "i1", sessionAlias: "s", direction: "in", text: "queued prompt", createdAt: "t1", queueItemId: "q1" },
        { id: 2, instanceId: "i1", sessionAlias: "s", direction: "out", text: "first reply", createdAt: "t2" },
      ],
      hasMore: false,
    }),
  }) as typeof fetch;
  const chat = useChatStore();
  chat.select("i1", "s");
  chat.applyEvent({ kind: "control-event", instanceId: "i1", event: { type: "turn-started", chatKey: "c", sessionAlias: "s" } } as WebServerEvent);
  await chat.send("queued prompt");
  chat.applyEvent({ kind: "control-event", instanceId: "i1", event: { type: "turn-output", chatKey: "c", sessionAlias: "s", chunk: "first reply" } } as WebServerEvent);
  chat.applyEvent({ kind: "control-event", instanceId: "i1", event: { type: "turn-finished", chatKey: "c", sessionAlias: "s", ok: true } } as WebServerEvent);
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(chat.messages[0]?.id).toBe(1);

  chat.applyEvent({ kind: "control-event", instanceId: "i1", event: { type: "turn-started", chatKey: "c", sessionAlias: "s", queueItemId: "q1", prompt: "queued prompt" } } as WebServerEvent);

  expect(chat.messages.map((message) => [message.direction, message.text])).toEqual([
    ["out", "first reply"],
    ["in", "queued prompt"],
  ]);
});

it("defers history convergence until the queued RPC response establishes correlation", async () => {
  let resolveRpc!: (value: unknown) => void;
  rpc.mockImplementationOnce(() => new Promise((resolve) => { resolveRpc = resolve; }));
  const fetchMock = vi.fn().mockResolvedValue({
    json: async () => ({
      messages: [
        { id: 1, instanceId: "i1", sessionAlias: "s", direction: "out", text: "first reply", createdAt: "t1" },
        { id: 2, instanceId: "i1", sessionAlias: "s", direction: "in", text: "queued prompt", createdAt: "t2" },
        { id: 3, instanceId: "i1", sessionAlias: "s", direction: "out", text: "second reply", createdAt: "t3" },
      ],
      hasMore: false,
    }),
  });
  globalThis.fetch = fetchMock as typeof fetch;
  const chat = useChatStore();
  chat.select("i1", "s");
  chat.applyEvent({ kind: "control-event", instanceId: "i1", event: { type: "turn-started", chatKey: "c", sessionAlias: "s" } } as WebServerEvent);
  chat.applyEvent({ kind: "control-event", instanceId: "i1", event: { type: "turn-output", chatKey: "c", sessionAlias: "s", chunk: "first reply" } } as WebServerEvent);

  const sending = chat.send("queued prompt");
  chat.applyEvent({ kind: "control-event", instanceId: "i1", event: { type: "turn-finished", chatKey: "c", sessionAlias: "s", ok: true } } as WebServerEvent);
  chat.applyEvent({ kind: "control-event", instanceId: "i1", event: { type: "turn-started", chatKey: "c", sessionAlias: "s", queueItemId: "q1", prompt: "queued prompt" } } as WebServerEvent);
  chat.applyEvent({ kind: "control-event", instanceId: "i1", event: { type: "turn-output", chatKey: "c", sessionAlias: "s", chunk: "second reply" } } as WebServerEvent);
  chat.applyEvent({ kind: "control-event", instanceId: "i1", event: { type: "turn-finished", chatKey: "c", sessionAlias: "s", ok: true } } as WebServerEvent);
  expect(fetchMock).not.toHaveBeenCalled();
  resolveRpc({ ok: true, queued: true, queueItemId: "q1" });
  await sending;
  await new Promise((resolve) => setTimeout(resolve, 0));

  expect(fetchMock).toHaveBeenCalledTimes(1);
  expect(chat.messages.map((message) => [message.direction, message.text])).toEqual([
    ["out", "first reply"],
    ["in", "queued prompt"],
    ["out", "second reply"],
  ]);
});

it("reloads history immediately after reselecting a session during prompt RPC", async () => {
  let resolveRpc!: (value: unknown) => void;
  rpc.mockImplementationOnce(() => new Promise((resolve) => { resolveRpc = resolve; }));
  const fetchMock = vi.fn().mockResolvedValue({
    json: async () => ({
      messages: [
        { id: 1, instanceId: "i1", sessionAlias: "s", direction: "in", text: "queued prompt", createdAt: "t1", queueItemId: "q1" },
      ],
      hasMore: false,
    }),
  });
  globalThis.fetch = fetchMock as typeof fetch;
  const chat = useChatStore();
  chat.select("i1", "s");
  const sending = chat.send("queued prompt");
  chat.select("i1", "other");
  chat.select("i1", "s");
  // The reselected pane is empty — history must load right away rather than defer
  // until the prompt RPC settles, or the pane would show only the live turn.
  await chat.loadHistory();
  expect(fetchMock).toHaveBeenCalledTimes(1);
  expect(chat.messages.map((message) => message.text)).toEqual(["queued prompt"]);

  resolveRpc({ ok: true, queued: true, queueItemId: "q1" });
  await sending;
  await new Promise((resolve) => setTimeout(resolve, 0));

  // Settling the RPC must not duplicate the prompt row.
  expect(chat.messages.map((message) => message.text)).toEqual(["queued prompt"]);
});

it("converges after the RPC settles when the reselect fetch raced the queueItemId stamp", async () => {
  let resolveRpc!: (value: unknown) => void;
  rpc.mockImplementationOnce(() => new Promise((resolve) => { resolveRpc = resolve; }));
  const fetchMock = vi.fn()
    // Reselect fetch races the RPC: the hub persisted the prompt row on enqueue, but
    // markQueued hasn't stamped its queueItemId yet — the row arrives uncorrelated.
    .mockResolvedValueOnce({
      json: async () => ({
        messages: [
          { id: 1, instanceId: "i1", sessionAlias: "s", direction: "in", text: "queued prompt", createdAt: "t1" },
        ],
        hasMore: false,
      }),
    })
    // The post-settle convergence reload returns the authoritative correlated row.
    .mockResolvedValue({
      json: async () => ({
        messages: [
          { id: 1, instanceId: "i1", sessionAlias: "s", direction: "in", text: "queued prompt", createdAt: "t1", queueItemId: "q1" },
        ],
        hasMore: false,
      }),
    });
  globalThis.fetch = fetchMock as typeof fetch;
  const chat = useChatStore();
  chat.select("i1", "s");
  const sending = chat.send("queued prompt");
  chat.select("i1", "other");
  chat.select("i1", "s");
  await chat.loadHistory();
  expect(fetchMock).toHaveBeenCalledTimes(1);
  expect(chat.messages.map((message) => message.text)).toEqual(["queued prompt"]);

  // The drain event can't correlate the uncorrelated row, so it pushes its own bubble —
  // a transient duplicate that the convergence reload below must eliminate.
  chat.applyEvent({ kind: "control-event", instanceId: "i1", event: { type: "turn-started", chatKey: "c", sessionAlias: "s", queueItemId: "q1", prompt: "queued prompt" } } as WebServerEvent);
  expect(chat.messages.map((message) => message.text)).toEqual(["queued prompt", "queued prompt"]);

  resolveRpc({ ok: true, queued: true, queueItemId: "q1" });
  await sending;
  await new Promise((resolve) => setTimeout(resolve, 0));

  // RPC settle triggered the deferred convergence reload with the authoritative row.
  expect(fetchMock).toHaveBeenCalledTimes(2);
  expect(chat.messages.map((message) => [message.text, message.queueItemId])).toEqual([
    ["queued prompt", "q1"],
  ]);
});

it("cancelQueuedItem issues control.queue.cancel and optimistically drops the chip", async () => {
  rpc.mockResolvedValueOnce({ ok: true });
  const chat = useChatStore();
  chat.select("i1", "s");
  chat.applyEvent({ kind: "control-event", instanceId: "i1", event: { type: "queue-updated", chatKey: "c", sessionAlias: "s", items: [{ id: "q1", textPreview: "hi", enqueuedAt: "t" }] } } as WebServerEvent);
  await chat.cancelQueuedItem("i1", "s", "q1");
  expect(chat.sessionQueue.find((i) => i.id === "q1")).toBeUndefined();
  expect(rpc).toHaveBeenCalledWith("i1", "control.queue.cancel", { sessionAlias: "s", itemId: "q1" });
});

it("cancelQueuedItem is best-effort: an RPC failure still leaves the chip dropped", async () => {
  const { ApiError } = await import("../api/client");
  rpc.mockRejectedValueOnce(new ApiError("instance-offline", 503));
  const chat = useChatStore();
  chat.select("i1", "s");
  chat.applyEvent({ kind: "control-event", instanceId: "i1", event: { type: "queue-updated", chatKey: "c", sessionAlias: "s", items: [{ id: "q1", textPreview: "hi", enqueuedAt: "t" }] } } as WebServerEvent);
  await chat.cancelQueuedItem("i1", "s", "q1");
  expect(chat.sessionQueue.find((i) => i.id === "q1")).toBeUndefined();
});
