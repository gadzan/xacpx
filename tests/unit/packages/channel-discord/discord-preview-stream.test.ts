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
    start: async () => {},
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
  preview.update("hello");
  vi.advanceTimersByTime(400);
  // allow async flush microtask to complete
  await Promise.resolve();
  await Promise.resolve();
  expect(sent.length).toBe(1);
  await preview.cleanup();
  expect(deleted.length).toBe(1);
  await preview.cleanup();
  expect(deleted.length).toBe(1);
  vi.useRealTimers();
});

test("preview create/edit failure degrades silently", () => {
  vi.useFakeTimers();
  const warns: string[] = [];
  const { client, sent } = createFakeClient({ failCreate: true });
  const preview = createDiscordPreviewStream({ client, target, throttleMs: 300, minInitialChars: 1, onWarn: (m) => warns.push(m) });
  preview.update("hello");
  vi.advanceTimersByTime(400);
  expect(sent.length).toBe(0);
  expect(warns.some((w) => w.includes("create_failed"))).toBe(true);
  vi.useRealTimers();

  vi.useFakeTimers();
  const { client: client2, sent: sent2, edited: edited2 } = createFakeClient({ failEdit: true });
  const warns2: string[] = [];
  const preview2 = createDiscordPreviewStream({ client: client2, target, throttleMs: 300, minInitialChars: 1, onWarn: (m) => warns2.push(m) });
  preview2.update("hello");
  vi.advanceTimersByTime(400);
  expect(sent2.length).toBe(1);
  preview2.update("hello 2");
  vi.advanceTimersByTime(400);
  expect(edited2.length).toBe(0);
  expect(warns2.some((w) => w.includes("edit_failed"))).toBe(true);
  preview2.update("hello 3");
  vi.advanceTimersByTime(400);
  expect(edited2.length).toBe(0);
  vi.useRealTimers();
});

test("preview pending during create is flushed after create", async () => {
  const sentContents: string[] = [];
  const editedContents: string[] = [];
  let resolveCreate: (() => void) | null = null;
  const createGate = new Promise<void>((resolve) => {
    resolveCreate = resolve;
  });
  const client: DiscordClientLike = {
    start: async () => {},
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
  resolveCreate?.();
  await new Promise((r) => setTimeout(r, 500));
  expect(sentContents.length).toBe(1);
  expect(editedContents.length).toBe(1);
  expect(editedContents[0]).toBe("hello world pending");
});
