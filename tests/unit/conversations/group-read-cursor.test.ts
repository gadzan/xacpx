import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "bun:test";
import { SqliteConversationStore } from "../../../src/conversations/sqlite-conversation-store";

const NOW = "2026-10-05T00:00:00.000Z";
const snapshot = { revision: 1, capturedAt: NOW, presentation: { name: "Leader" }, behavior: {},
  execution: { agent: "codex", workspace: "backend" } };

async function store(): Promise<SqliteConversationStore> {
  return await SqliteConversationStore.open(join(mkdtempSync(join(tmpdir(), "xacpx-group-cursor-")), "conversations.sqlite"));
}

test("a bot with no cursor reads from the start and is not marked pending", async () => {
  const db = await store();
  expect(db.getGroupReadCursor("topic", "bot_a")).toBeUndefined();
});

test("advancing the cursor moves the read position and clears a pending wake", async () => {
  const db = await store();
  db.setGroupPendingWake("topic", "bot_a", true);
  expect(db.getGroupReadCursor("topic", "bot_a")).toEqual({ lastSeq: 0, pendingWake: true, contextGeneration: 1 });

  db.advanceGroupReadCursor("topic", "bot_a", 7, 1);
  expect(db.getGroupReadCursor("topic", "bot_a")).toEqual({ lastSeq: 7, pendingWake: false, contextGeneration: 1 });

  db.setGroupPendingWake("topic", "bot_a", true);
  db.advanceGroupReadCursor("topic", "bot_a", 9, 1);
  expect(db.getGroupReadCursor("topic", "bot_a")).toEqual({ lastSeq: 9, pendingWake: false, contextGeneration: 1 });
});

test("cursors are independent per bot and per topic", async () => {
  const db = await store();
  db.advanceGroupReadCursor("topic", "bot_a", 4, 1);
  db.advanceGroupReadCursor("other", "bot_a", 5, 1);
  db.setGroupPendingWake("topic", "bot_b", true);

  expect(db.getGroupReadCursor("topic", "bot_a")).toEqual({ lastSeq: 4, pendingWake: false, contextGeneration: 1 });
  expect(db.getGroupReadCursor("other", "bot_a")).toEqual({ lastSeq: 5, pendingWake: false, contextGeneration: 1 });
  expect(db.getGroupReadCursor("topic", "bot_b")).toEqual({ lastSeq: 0, pendingWake: true, contextGeneration: 1 });
  expect(db.getGroupReadCursor("topic", "bot_c")).toBeUndefined();
});

test("clearing a topic's pending wakes leaves the read positions intact", async () => {
  const db = await store();
  db.advanceGroupReadCursor("topic", "bot_a", 3, 1);
  db.setGroupPendingWake("topic", "bot_a", true);
  db.setGroupPendingWake("topic", "bot_b", true);
  db.setGroupPendingWake("other", "bot_a", true);

  db.clearTopicGroupPendingWake("topic");

  expect(db.getGroupReadCursor("topic", "bot_a")).toEqual({ lastSeq: 3, pendingWake: false, contextGeneration: 1 });
  expect(db.getGroupReadCursor("topic", "bot_b")).toEqual({ lastSeq: 0, pendingWake: false, contextGeneration: 1 });
  expect(db.getGroupReadCursor("other", "bot_a")).toEqual({ lastSeq: 0, pendingWake: true, contextGeneration: 1 });
});

test("the cursor survives reopening the database", async () => {
  const path = join(mkdtempSync(join(tmpdir(), "xacpx-group-cursor-")), "conversations.sqlite");
  const first = await SqliteConversationStore.open(path);
  first.advanceGroupReadCursor("topic", "bot_a", 12, 1);
  first.close();

  const second = await SqliteConversationStore.open(path);
  expect(second.getGroupReadCursor("topic", "bot_a")).toEqual({ lastSeq: 12, pendingWake: false, contextGeneration: 1 });
  second.close();
});

test("an accepted human message is visible after the cursor it was written past", async () => {
  const db = await store();
  db.acceptRequest({ conversationId: "group", topicId: "topic", requestId: "request", botId: "bot_a",
    content: "hello", profileSnapshot: snapshot, now: NOW });
  const before = db.listMessages({ conversationId: "group", topicId: "topic", limit: 10 });
  expect(before.map((message) => message.content)).toEqual(["hello"]);

  db.advanceGroupReadCursor("topic", "bot_a", before[0]!.seq, 1);
  expect(db.listMessages({ conversationId: "group", topicId: "topic", afterSeq: db.getGroupReadCursor("topic", "bot_a")!.lastSeq, limit: 10 })).toEqual([]);

  db.acceptRequest({ conversationId: "group", topicId: "topic", requestId: "request2", botId: "bot_a",
    content: "world", profileSnapshot: snapshot, now: NOW });
  const after = db.listMessages({ conversationId: "group", topicId: "topic", afterSeq: before[0]!.seq, limit: 10 });
  expect(after.map((message) => message.content)).toEqual(["world"]);
});
