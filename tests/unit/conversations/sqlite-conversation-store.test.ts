import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "bun:test";

import { snapshotBotProfile } from "../../../src/bots/bot-types";
import { SqliteConversationStore } from "../../../src/conversations/sqlite-conversation-store";
import { createDirectConversationId, createDirectTopicId } from "../../../src/domain/ids";

const NOW = "2026-09-15T12:00:00.000Z";
const BOT_ID = "bot_reviewer";
const CONV = createDirectConversationId(BOT_ID);
const TOPIC = createDirectTopicId(BOT_ID);

function snapshot() {
  return snapshotBotProfile({
    id: BOT_ID,
    name: "Reviewer",
    agent: "codex",
    workspace: "backend",
    enabled: true,
    profileRevision: 1,
    createdAt: NOW,
    updatedAt: NOW,
  }, NOW);
}

function tempDb(): string {
  return join(mkdtempSync(join(tmpdir(), "xacpx-conv-")), "conversation.sqlite");
}

test("acceptRequest atomically persists message, run, member turn, and pending dispatch", async () => {
  const store = await SqliteConversationStore.open(":memory:");
  const accepted = store.acceptRequest({
    conversationId: CONV,
    topicId: TOPIC,
    requestId: "req-1",
    botId: BOT_ID,
    content: "review this",
    profileSnapshot: snapshot(),
    now: NOW,
  });
  expect(accepted.reused).toBe(false);
  expect(accepted.message.seq).toBe(1);
  expect(accepted.message.role).toBe("human");
  expect(accepted.run.state).toBe("queued");
  expect(accepted.run.mode).toBe("explicit");
  expect(accepted.run.profileRevision).toBe(1);
  expect(accepted.memberTurn.origin).toBe("human");
  expect(accepted.dispatch.state).toBe("pending");
  expect(store.listMessages({ conversationId: CONV, topicId: TOPIC, limit: 10 })).toHaveLength(1);
  store.close();
});

test("duplicate requestId sequential retry reuses the same Run", async () => {
  const store = await SqliteConversationStore.open(":memory:");
  const first = store.acceptRequest({
    conversationId: CONV,
    topicId: TOPIC,
    requestId: "req-dup",
    botId: BOT_ID,
    content: "hello",
    profileSnapshot: snapshot(),
    now: NOW,
  });
  const second = store.acceptRequest({
    conversationId: CONV,
    topicId: TOPIC,
    requestId: "req-dup",
    botId: BOT_ID,
    content: "hello again",
    profileSnapshot: snapshot(),
    now: NOW,
  });
  expect(second.reused).toBe(true);
  expect(second.run.id).toBe(first.run.id);
  expect(second.message.id).toBe(first.message.id);
  expect(second.dispatch.id).toBe(first.dispatch.id);
  expect(store.listMessages({ conversationId: CONV, topicId: TOPIC, limit: 10 })).toHaveLength(1);
  store.close();
});

test("duplicate requestId concurrent retry creates one Run/message/dispatch", async () => {
  const path = tempDb();
  const left = await SqliteConversationStore.open(path);
  const right = await SqliteConversationStore.open(path);
  const input = {
    conversationId: CONV,
    topicId: TOPIC,
    requestId: "req-race",
    botId: BOT_ID,
    content: "race",
    profileSnapshot: snapshot(),
    now: NOW,
  };
  const [a, b] = await Promise.all([
    Promise.resolve().then(() => left.acceptRequest(input)),
    Promise.resolve().then(() => right.acceptRequest(input)),
  ]);
  expect(new Set([a.run.id, b.run.id]).size).toBe(1);
  expect(new Set([a.message.id, b.message.id]).size).toBe(1);
  expect(new Set([a.dispatch.id, b.dispatch.id]).size).toBe(1);
  expect(left.listMessages({ conversationId: CONV, topicId: TOPIC, limit: 10 })).toHaveLength(1);
  left.close();
  right.close();
});

test("concurrent seq allocation is unique and monotonic", async () => {
  const path = tempDb();
  const left = await SqliteConversationStore.open(path);
  const right = await SqliteConversationStore.open(path);
  const [a, b] = await Promise.all([
    Promise.resolve().then(() => left.acceptRequest({
      conversationId: CONV,
      topicId: TOPIC,
      requestId: "req-a",
      botId: BOT_ID,
      content: "a",
      profileSnapshot: snapshot(),
      now: NOW,
    })),
    Promise.resolve().then(() => right.acceptRequest({
      conversationId: CONV,
      topicId: TOPIC,
      requestId: "req-b",
      botId: BOT_ID,
      content: "b",
      profileSnapshot: snapshot(),
      now: NOW,
    })),
  ]);
  const seqs = [a.message.seq, b.message.seq].sort((x, y) => x - y);
  expect(seqs).toEqual([1, 2]);
  const replay = left.listMessages({ conversationId: CONV, topicId: TOPIC, afterSeq: 0, limit: 10 });
  expect(replay.map((message) => message.seq)).toEqual([1, 2]);
  expect(new Set(replay.map((message) => message.id)).size).toBe(2);
  left.close();
  right.close();
});

test("store write failure does not publish an accepted Run", async () => {
  const store = await SqliteConversationStore.open(":memory:", {
    beforeAcceptCommit: () => {
      throw new Error("simulated conversation-store write failure");
    },
  });
  expect(() => store.acceptRequest({
    conversationId: CONV,
    topicId: TOPIC,
    requestId: "req-fail",
    botId: BOT_ID,
    content: "nope",
    profileSnapshot: snapshot(),
    now: NOW,
  })).toThrow("simulated conversation-store write failure");
  expect(store.getRunByRequestId(CONV, TOPIC, "req-fail")).toBeUndefined();
  expect(store.listMessages({ conversationId: CONV, topicId: TOPIC, limit: 10 })).toEqual([]);
  store.close();
});

test("store restart preserves Run and MemberTurn state", async () => {
  const path = tempDb();
  const store = await SqliteConversationStore.open(path);
  const accepted = store.acceptRequest({
    conversationId: CONV,
    topicId: TOPIC,
    requestId: "req-restart",
    botId: BOT_ID,
    content: "persist",
    profileSnapshot: snapshot(),
    now: NOW,
  });
  store.close();
  const reopened = await SqliteConversationStore.open(path);
  const run = reopened.getRun(accepted.run.id);
  const member = reopened.getMemberTurn(accepted.memberTurn.id);
  expect(run?.state).toBe("queued");
  expect(run?.requestId).toBe("req-restart");
  expect(member?.state).toBe("queued");
  expect(member?.triggerMessageIds).toEqual([accepted.message.id]);
  reopened.close();
});

test("listMessages afterSeq/beforeSeq/limit is the replay cursor", async () => {
  const store = await SqliteConversationStore.open(":memory:");
  store.acceptRequest({
    conversationId: CONV,
    topicId: TOPIC,
    requestId: "r1",
    botId: BOT_ID,
    content: "one",
    profileSnapshot: snapshot(),
    now: NOW,
  });
  store.acceptRequest({
    conversationId: CONV,
    topicId: TOPIC,
    requestId: "r2",
    botId: BOT_ID,
    content: "two",
    profileSnapshot: snapshot(),
    now: NOW,
  });
  const after = store.listMessages({ conversationId: CONV, topicId: TOPIC, afterSeq: 1, limit: 10 });
  expect(after.map((message) => message.seq)).toEqual([2]);
  const before = store.listMessages({ conversationId: CONV, topicId: TOPIC, beforeSeq: 2, limit: 10 });
  expect(before.map((message) => message.seq)).toEqual([1]);
  const limited = store.listMessages({ conversationId: CONV, topicId: TOPIC, limit: 1 });
  expect(limited).toHaveLength(1);
  store.close();
});
