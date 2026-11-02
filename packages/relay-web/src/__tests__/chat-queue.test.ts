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

it("sending while busy keeps the prompt in the strip, not the transcript", async () => {
  rpc.mockResolvedValueOnce({ ok: true, queued: true, queueItemId: "q1" });
  const chat = useChatStore();
  chat.select("i1", "s");
  // make the session busy: a live turn exists
  chat.applyEvent({ kind: "control-event", instanceId: "i1", event: { type: "turn-started", chatKey: "c", sessionAlias: "s" } } as WebServerEvent);
  expect(chat.busy).toBe(true);
  const before = chat.messages.length;
  await chat.send("queued msg");
  expect(chat.messages.length).toBe(before); // no transcript bubble while queued
  expect(chat.sessionQueue.map((i) => i.id)).toEqual(["q1"]);
  expect(rpc).toHaveBeenCalledWith("i1", "control.prompt", { sessionAlias: "s", text: "queued msg" });
});

it("builds the bubble at drain time and clears the strip", async () => {
  rpc.mockResolvedValueOnce({ ok: true, queued: true, queueItemId: "q1" });
  const chat = useChatStore();
  chat.select("i1", "s");
  chat.applyEvent({ kind: "control-event", instanceId: "i1", event: { type: "turn-started", chatKey: "c", sessionAlias: "s" } } as WebServerEvent);
  chat.applyEvent({ kind: "control-event", instanceId: "i1", event: { type: "turn-output", chatKey: "c", sessionAlias: "s", chunk: "first reply" } } as WebServerEvent);

  await chat.send("queued prompt");
  expect(chat.messages.map((message) => [message.direction, message.text])).toEqual([]);
  chat.applyEvent({ kind: "control-event", instanceId: "i1", event: { type: "turn-finished", chatKey: "c", sessionAlias: "s", ok: true } } as WebServerEvent);
  chat.applyEvent({ kind: "control-event", instanceId: "i1", event: { type: "turn-started", chatKey: "c", sessionAlias: "s", queueItemId: "q1", prompt: "queued prompt" } } as WebServerEvent);
  chat.applyEvent({ kind: "control-event", instanceId: "i1", event: { type: "queue-updated", chatKey: "c", sessionAlias: "s", items: [] } } as WebServerEvent);

  expect(chat.messages.map((message) => [message.direction, message.text])).toEqual([
    ["out", "first reply"],
    ["in", "queued prompt"],
  ]);
  expect(chat.sessionQueue).toEqual([]);
});

it("dedupes when the drain event arrives before the queued RPC response", async () => {
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

  // The late RPC must not resurrect a second bubble or a leftover strip chip.
  expect(chat.messages.map((message) => [message.direction, message.text])).toEqual([
    ["out", "first reply"],
    ["in", "queued prompt"],
    ["out", "second reply"],
  ]);
  expect(chat.sessionQueue).toEqual([]);
});

it("reloads pending strip items without transcript bubbles", async () => {
  rpc.mockResolvedValueOnce({ ok: true, queued: true, queueItemId: "q1" });
  globalThis.fetch = vi.fn().mockResolvedValue({
    json: async () => ({
      messages: [
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
  await chat.loadHistory();

  expect(chat.messages.map((message) => [message.direction, message.text])).toEqual([
    ["out", "first reply"],
  ]);
  expect(chat.sessionQueue).toEqual([]);

  // The pending endpoint (not the transcript page) restores the strip after reload.
  globalThis.fetch = vi.fn().mockImplementation(async (input: unknown) => ({
    json: async () => {
      const url = String(input);
      if (url.includes("view=pending")) {
        return { items: [{ id: "q1", textPreview: "queued prompt", enqueuedAt: "t1" }] };
      }
      return {
        messages: [
          { id: 2, instanceId: "i1", sessionAlias: "s", direction: "out", text: "first reply", createdAt: "t2" },
        ],
        hasMore: false,
      };
    },
  })) as typeof fetch;
  await chat.loadHistory();
  expect(chat.messages.map((message) => [message.direction, message.text])).toEqual([
    ["out", "first reply"],
  ]);
  expect(chat.sessionQueue.map((i) => i.id)).toEqual(["q1"]);
});

it("reloads history immediately after reselecting a session during prompt RPC", async () => {
  const { promise, resolve } = Promise.withResolvers<unknown>();
  rpc.mockImplementationOnce(() => promise);
  const transcript = {
    messages: [
      { id: 1, instanceId: "i1", sessionAlias: "s", direction: "out", text: "first reply", createdAt: "t1" },
    ],
    hasMore: false,
  };
  const pending = { items: [{ id: "q1", textPreview: "queued prompt", enqueuedAt: "t1" }] };
  const fetchMock = vi.fn().mockImplementation(async (input: unknown) => ({
    json: async () => (String(input).includes("view=pending") ? pending : transcript),
  }));
  globalThis.fetch = fetchMock as typeof fetch;
  const chat = useChatStore();
  chat.select("i1", "s");
  const sending = chat.send("queued prompt");
  chat.select("i1", "other");
  chat.select("i1", "s");
  // The reselected pane is empty — history must load right away rather than defer
  // until the prompt RPC settles, or the pane would show only the live turn.
  await chat.loadHistory();
  expect(chat.messages.map((message) => message.text)).toEqual(["first reply"]);
  expect(chat.sessionQueue.map((i) => i.id)).toEqual(["q1"]);

  resolve({ ok: true, queued: true, queueItemId: "q1" });
  await sending;
  // The settle-time convergence reload must not create a transcript bubble.
  await vi.waitFor(() => {
    expect(chat.messages.map((message) => message.text)).toEqual(["first reply"]);
    expect(chat.sessionQueue.map((i) => i.id)).toEqual(["q1"]);
  });
  expect(fetchMock).toHaveBeenCalled();
});

it("immediate send still bubbles in the transcript", async () => {
  rpc.mockResolvedValueOnce({ ok: true });
  const chat = useChatStore();
  chat.select("i1", "s");
  await chat.send("hello");
  expect(chat.messages.map((message) => [message.direction, message.text])).toEqual([["in", "hello"]]);
  expect(chat.sessionQueue).toEqual([]);
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
