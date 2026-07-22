// packages/relay-web/src/__tests__/chat-queue.test.ts
import { setActivePinia, createPinia } from "pinia";
import { beforeEach, expect, it, vi } from "vitest";

const rpc = vi.fn();
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
  resolveRpc({ ok: true, queued: true, queueItemId: "q1" });
  await sending;

  expect(chat.messages.map((message) => [message.direction, message.text])).toEqual([
    ["out", "first reply"],
    ["in", "queued prompt"],
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
