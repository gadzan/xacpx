import { expect, test, vi } from "bun:test";
import { createDiscordPreviewStream } from "../../../../packages/channel-discord/src/preview-stream";
import type { DeliveryTarget } from "../../../../packages/channel-discord/src/types";
import type { DiscordClientLike } from "../../../../packages/channel-discord/src/discord-client";

function createFakeClient(hooks: {
  onSend?: (target: DeliveryTarget, content: string) => void;
  onEdit?: (target: DeliveryTarget, messageId: string, content: string) => void;
  onDelete?: (target: DeliveryTarget, messageId: string) => void;
  failCreate?: boolean;
  failEdit?: boolean;
} = {}) {
  let nextId = 0;
  const sent: Array<{ target: DeliveryTarget; content: string; id: string }> = [];
  const edited: Array<{ target: DeliveryTarget; messageId: string; content: string }> = [];
  const deleted: Array<{ target: DeliveryTarget; messageId: string }> = [];
  const client: DiscordClientLike = {
    start: async () => ({ botUserId: "bot" }),
    probeBot: async () => ({ botUserId: "bot" }),
    sendMessage: async (target, body) => {
      if (hooks.failCreate) throw new Error("create failed");
      const id = `m${++nextId}`;
      sent.push({ target, content: body.content ?? "", id });
      hooks.onSend?.(target, body.content ?? "");
      return { messageId: id };
    },
    editMessage: async (target, messageId, body) => {
      if (hooks.failEdit) throw new Error("edit failed");
      edited.push({ target, messageId, content: body.content ?? "" });
      hooks.onEdit?.(target, messageId, body.content ?? "");
    },
    deleteMessage: async (target, messageId) => {
      deleted.push({ target, messageId });
      hooks.onDelete?.(target, messageId);
    },
    startTyping: async () => () => {},
    addReaction: async () => {},
    destroy: async () => {},
  };
  return { client, sent, edited, deleted };
}

const target: DeliveryTarget = { channelId: "chan1" };

test("preview defers creation until minInitialChars and throttles edits", () => {
  vi.useFakeTimers();
  const { client, sent, edited } = createFakeClient();
  const preview = createDiscordPreviewStream({ client, target, throttleMs: 300, minInitialChars: 5, maxChars: 2000 });
  preview.update("hi");
  vi.advanceTimersByTime(400);
  expect(sent.length).toBe(0);
  preview.update("hello world");
  vi.advanceTimersByTime(400);
  expect(sent.length).toBe(1);
  preview.update("hello world!!");
  preview.update("hello world!!!");
  vi.advanceTimersByTime(400);
  expect(edited.length).toBe(1);
  expect(edited[0]!.content).toBe("hello world!!!");
  vi.useRealTimers();
});

test("preview stops edit after overflow > maxChars", () => {
  vi.useFakeTimers();
  const { client, sent, edited } = createFakeClient();
  const preview = createDiscordPreviewStream({ client, target, throttleMs: 300, minInitialChars: 1, maxChars: 10 });
  preview.update("12345");
  vi.advanceTimersByTime(400);
  expect(sent.length).toBe(1);
  preview.update("x".repeat(11));
  vi.advanceTimersByTime(400);
  expect(edited.length).toBe(0);
  preview.update("12345");
  vi.advanceTimersByTime(400);
  expect(edited.length).toBe(0);
  vi.useRealTimers();
});

test("preview cleanup deletes message and is no-op if not created", async () => {
  vi.useFakeTimers();
  const { client, sent, deleted } = createFakeClient();
  const preview = createDiscordPreviewStream({ client, target, throttleMs: 300, minInitialChars: 1 });
  await preview.cleanup();
  expect(deleted.length).toBe(0);
  // After cleanup, update() must be a no-op (review #2 contract).
  preview.update("hello");
  vi.advanceTimersByTime(400);
  await Promise.resolve();
  await Promise.resolve();
  expect(sent.length).toBe(0);
  vi.useRealTimers();
});
test("preview cleanup awaits in-flight create then deletes the created message", async () => {
  let resolveCreate: (() => void) | null = null;
  const gate = Promise.withResolvers<void>();
  resolveCreate = gate.resolve;
  const client: DiscordClientLike = {
    start: async () => ({ botUserId: "bot" }),
    probeBot: async () => ({ botUserId: "bot" }),
    sendMessage: async (_t, _body) => {
      await gate.promise;
      return { messageId: "m1" };
    },
    editMessage: async () => {},
    deleteMessage: async (_t, id) => { deleteCalls.push(id); },
    startTyping: async () => () => {},
    addReaction: async () => {},
    destroy: async () => {},
  };
  const deleteCalls: string[] = [];
  const preview = createDiscordPreviewStream({ client, target, throttleMs: 250, minInitialChars: 1 });
  preview.update("hello world");
  await new Promise((r) => setTimeout(r, 400)); // throttleMs clamps to ≥250; wait past it
  // Begin cleanup while create is mid-flight (gate is still unresolved).
  const cleanup = preview.cleanup();
  resolveCreate?.();
  await cleanup;
  expect(deleteCalls.length).toBe(1);
  expect(deleteCalls[0]).toBe("m1");
});
test("preview create/edit failure degrades silently", async () => {
  vi.useFakeTimers();
  const { client, sent } = createFakeClient({ failCreate: true });
  const warns: string[] = [];
  const preview = createDiscordPreviewStream({ client, target, throttleMs: 300, minInitialChars: 1, onWarn: (m) => warns.push(m) });
  preview.update("hello");
  vi.advanceTimersByTime(400);
  await Promise.resolve();
  await Promise.resolve();
  expect(sent.length).toBe(0);
  vi.useRealTimers();

  vi.useFakeTimers();
  const { client: client2, sent: sent2, edited: edited2 } = createFakeClient({ failEdit: true });
  const warns2: string[] = [];
  const preview2 = createDiscordPreviewStream({ client: client2, target, throttleMs: 300, minInitialChars: 1, onWarn: (m) => warns2.push(m) });
  preview2.update("hello");
  vi.advanceTimersByTime(400);
  await Promise.resolve();
  await Promise.resolve();
  expect(sent2.length).toBe(1);
  preview2.update("hello 2");
  vi.advanceTimersByTime(400);
  await Promise.resolve();
  await Promise.resolve();
  expect(warns2.some((w) => w.includes("edit_failed"))).toBe(true);
  preview2.update("hello 3");
  vi.advanceTimersByTime(400);
  await Promise.resolve();
  await Promise.resolve();
  vi.useRealTimers();
});

test("preview pending during create is flushed after create", async () => {
  const sentContents: string[] = [];
  const editedContents: string[] = [];
  const createGate = Promise.withResolvers<void>();
  const client: DiscordClientLike = {
    start: async () => ({ botUserId: "bot" }),
    probeBot: async () => ({ botUserId: "bot" }),
    sendMessage: async (_target, body) => {
      await createGate;
      sentContents.push(body.content ?? "");
      return { messageId: "m1" };
    },
    editMessage: async (_target, _id, body) => {
      editedContents.push(body.content ?? "");
    },
    deleteMessage: async () => {},
    startTyping: async () => () => {},
    addReaction: async () => {},
    destroy: async () => {},
  };
  const preview = createDiscordPreviewStream({ client, target, throttleMs: 300, minInitialChars: 1 });
  preview.update("hello");
  await new Promise((r) => setTimeout(r, 350));
  preview.update("hello world pending");
  createGate.resolve();
  await new Promise((r) => setTimeout(r, 500));
  expect(sentContents.length).toBe(1);
  expect(editedContents.length).toBe(1);
  expect(editedContents[0]).toBe("hello world pending");
});
test("short progress like '🚀 Starting' with minInitialChars=1 creates promptly", async () => {
  vi.useFakeTimers();
  const { client, sent } = createFakeClient();
  const preview = createDiscordPreviewStream({ client, target, throttleMs: 300, minInitialChars: 1 });
  preview.update("🚀 Starting omp…");
  vi.advanceTimersByTime(400);
  await Promise.resolve();
  await Promise.resolve();
  expect(sent.length).toBe(1);
  expect(sent[0]!.content).toBe("🚀 Starting omp…");
  vi.useRealTimers();
});

test("channel streaming default should be responsive with minInitialChars 20 but accumulated grows", async () => {
  vi.useFakeTimers();
  const { client, sent, edited } = createFakeClient();
  const preview = createDiscordPreviewStream({ client, target, throttleMs: 300, minInitialChars: 20 });
  preview.update("🚀 Starting omp…");
  vi.advanceTimersByTime(400);
  await Promise.resolve();
  await Promise.resolve();
  expect(sent.length).toBe(0);
  preview.update("🚀 Starting omp…\n\nℹ️ [acpx] agent advertised auth methods [agent] but no matching credentials found — skipping (waited 4s)");
  vi.advanceTimersByTime(400);
  await Promise.resolve();
  await Promise.resolve();
  expect(sent.length).toBe(1);
  expect(sent[0]!.content).toContain("ℹ️");
  vi.useRealTimers();
});
