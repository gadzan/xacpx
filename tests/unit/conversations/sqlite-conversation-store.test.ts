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

test("getAcceptedRequest returns the durable accepted rows without accepting again", async () => {
  const store = await SqliteConversationStore.open(":memory:");
  const extraTopic = "topic_manual_second";
  const accepted = store.acceptRequest({
    conversationId: CONV,
    topicId: extraTopic,
    requestId: "req-lookup",
    botId: BOT_ID,
    content: "hello",
    profileSnapshot: snapshot(),
    now: NOW,
  });
  store.markConversationDeleting(CONV, NOW);
  store.markTopicDeleting(extraTopic, CONV, NOW);
  const found = store.getAcceptedRequest(CONV, extraTopic, "req-lookup");
  expect(found?.reused).toBe(true);
  expect(found?.run.id).toBe(accepted.run.id);
  expect(found?.message.id).toBe(accepted.message.id);
  expect(found?.dispatch.id).toBe(accepted.dispatch.id);
  expect(store.getAcceptedRequest(CONV, extraTopic, "req-missing")).toBeUndefined();
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

test("listMessages beforeSeq returns the nearest previous page in ascending order", async () => {
  const store = await SqliteConversationStore.open(":memory:");
  for (const [requestId, content] of [
    ["r1", "one"],
    ["r2", "two"],
    ["r3", "three"],
    ["r4", "four"],
    ["r5", "five"],
  ] as const) {
    store.acceptRequest({
      conversationId: CONV,
      topicId: TOPIC,
      requestId,
      botId: BOT_ID,
      content,
      profileSnapshot: snapshot(),
      now: NOW,
    });
  }
  const page = store.listMessages({ conversationId: CONV, topicId: TOPIC, beforeSeq: 5, limit: 2 });
  expect(page.map((message) => message.seq)).toEqual([3, 4]);
  expect(page.map((message) => message.content)).toEqual(["three", "four"]);
  store.close();
});

test("claimNextDispatch follows message seq when timestamps and run ids disagree", async () => {
  let messages = 0;
  let members = 0;
  let dispatches = 0;
  const runIds = ["run_zzz", "run_aaa"];
  const store = await SqliteConversationStore.open(":memory:", {
    ids: {
      messageId: () => `cmsg_${messages++}`,
      runId: () => runIds.shift() ?? `run_${messages}`,
      memberTurnId: () => `mturn_${members++}`,
      dispatchId: () => `pdsp_${dispatches++}`,
    },
  });
  const first = store.acceptRequest({
    conversationId: CONV,
    topicId: TOPIC,
    requestId: "req-seq-1",
    botId: BOT_ID,
    content: "first",
    profileSnapshot: snapshot(),
    now: NOW,
  });
  const second = store.acceptRequest({
    conversationId: CONV,
    topicId: TOPIC,
    requestId: "req-seq-2",
    botId: BOT_ID,
    content: "second",
    profileSnapshot: snapshot(),
    now: NOW,
  });
  expect(first.message.seq).toBe(1);
  expect(second.message.seq).toBe(2);
  expect(first.run.id).toBe("run_zzz");
  expect(second.run.id).toBe("run_aaa");
  const claimed = store.claimNextDispatch({
    authorityEpoch: "epoch-a",
    now: NOW,
    owner: "dispatcher-a",
    leaseExpiresAt: "2026-09-15T12:00:30.000Z",
  });
  expect(claimed?.run.id).toBe(first.run.id);
  expect(claimed?.run.id).not.toBe(second.run.id);
  store.close();
});

test("markExecutionStarted rejects a stale owner/generation after reclaim", async () => {
  const store = await SqliteConversationStore.open(":memory:");
  const accepted = store.acceptRequest({
    conversationId: CONV,
    topicId: TOPIC,
    requestId: "req-cas",
    botId: BOT_ID,
    content: "hello",
    profileSnapshot: snapshot(),
    now: NOW,
  });
  const firstClaim = store.claimNextDispatch({
    authorityEpoch: "epoch-a",
    now: NOW,
    owner: "owner-a",
    leaseExpiresAt: "2026-09-15T12:00:01.000Z",
  });
  expect(firstClaim?.dispatch.generation).toBe(1);
  const recovered = store.recoverExpiredClaims("2026-09-15T12:00:02.000Z");
  expect(recovered).toHaveLength(1);
  expect(recovered[0]?.outcome).toBe("requeued");
  const secondClaim = store.claimNextDispatch({
    authorityEpoch: "epoch-a",
    now: "2026-09-15T12:00:03.000Z",
    owner: "owner-b",
    leaseExpiresAt: "2026-09-15T12:01:03.000Z",
  });
  expect(secondClaim?.dispatch.owner).toBe("owner-b");
  expect(secondClaim?.dispatch.generation).toBe(2);
  expect(() => store.markExecutionStarted({
    dispatchId: firstClaim!.dispatch.id,
    owner: "owner-a",
    generation: firstClaim!.dispatch.generation,
    runId: accepted.run.id,
    memberTurnId: accepted.memberTurn.id,
    sessionAlias: "alias",
    logicalSessionId: "11111111-1111-4111-8111-111111111111",
    sourceTurnId: "sturn_old",
    now: "2026-09-15T12:00:04.000Z",
  })).toThrow(/live claim/);
  const started = store.markExecutionStarted({
    dispatchId: secondClaim!.dispatch.id,
    owner: "owner-b",
    generation: secondClaim!.dispatch.generation,
    runId: accepted.run.id,
    memberTurnId: accepted.memberTurn.id,
    sessionAlias: "alias",
    logicalSessionId: "11111111-1111-4111-8111-111111111111",
    sourceTurnId: "sturn_new",
    now: "2026-09-15T12:00:04.000Z",
  });
  expect(started.sourceTurnId).toBe("sturn_new");
  store.close();
});

test("stale releaseClaimToPending and failClaimBeforeStart do not mutate a newer claim", async () => {
  const store = await SqliteConversationStore.open(":memory:");
  const accepted = store.acceptRequest({
    conversationId: CONV,
    topicId: TOPIC,
    requestId: "req-prestart-cas",
    botId: BOT_ID,
    content: "hello",
    profileSnapshot: snapshot(),
    now: NOW,
  });
  expect(store.hasDurableBotWork(BOT_ID)).toBe(true);
  const firstClaim = store.claimNextDispatch({
    authorityEpoch: "epoch-a",
    now: NOW,
    owner: "owner-a",
    leaseExpiresAt: "2026-09-15T12:00:01.000Z",
  });
  store.recoverExpiredClaims("2026-09-15T12:00:02.000Z");
  const secondClaim = store.claimNextDispatch({
    authorityEpoch: "epoch-a",
    now: "2026-09-15T12:00:03.000Z",
    owner: "owner-b",
    leaseExpiresAt: "2026-09-15T12:01:03.000Z",
  });
  expect(secondClaim?.dispatch.generation).toBe(2);
  expect(() => store.releaseClaimToPending({
    dispatchId: firstClaim!.dispatch.id,
    owner: "owner-a",
    generation: firstClaim!.dispatch.generation,
    now: "2026-09-15T12:00:04.000Z",
  })).toThrow(/live claim/);
  expect(() => store.failClaimBeforeStart({
    dispatchId: firstClaim!.dispatch.id,
    owner: "owner-a",
    generation: firstClaim!.dispatch.generation,
    runId: accepted.run.id,
    memberTurnId: accepted.memberTurn.id,
    now: "2026-09-15T12:00:04.000Z",
    reason: "runtime_revision_mismatch",
  })).toThrow(/live claim/);
  const live = store.getDispatchForRun(accepted.run.id);
  expect(live?.state).toBe("claimed");
  expect(live?.owner).toBe("owner-b");
  expect(live?.generation).toBe(2);
  expect(store.getRun(accepted.run.id)?.state).toBe("queued");
  store.failClaimBeforeStart({
    dispatchId: secondClaim!.dispatch.id,
    owner: "owner-b",
    generation: secondClaim!.dispatch.generation,
    runId: accepted.run.id,
    memberTurnId: accepted.memberTurn.id,
    now: "2026-09-15T12:00:05.000Z",
    reason: "runtime_revision_mismatch",
  });
  expect(store.getRun(accepted.run.id)?.state).toBe("failed");
  expect(store.getRun(accepted.run.id)?.completionReason).toBe("runtime_revision_mismatch");
  store.deleteConversationRows(CONV);
  expect(store.hasDurableBotWork(BOT_ID)).toBe(false);
  store.close();
});

test("matching authority epoch keeps human origin; mismatch and recovery revoke it", async () => {
  const store = await SqliteConversationStore.open(":memory:");
  const accepted = store.acceptRequest({
    conversationId: CONV,
    topicId: TOPIC,
    requestId: "req-epoch",
    botId: BOT_ID,
    content: "hello",
    profileSnapshot: snapshot(),
    now: NOW,
    authorityEpoch: "boot-1",
  });
  expect(accepted.dispatch.authorityEpoch).toBe("boot-1");
  expect(accepted.memberTurn.origin).toBe("human");
  const fresh = store.claimNextDispatch({
    authorityEpoch: "boot-1",
    now: NOW,
    owner: "owner-a",
    leaseExpiresAt: "2026-09-15T12:00:30.000Z",
  });
  expect(fresh?.memberTurn.origin).toBe("human");
  expect(fresh?.dispatch.generation).toBe(1);
  store.releaseClaimToPending({
    dispatchId: fresh!.dispatch.id,
    owner: "owner-a",
    generation: fresh!.dispatch.generation,
    now: NOW,
  });
  expect(store.getMemberTurn(accepted.memberTurn.id)?.origin).toBe("recovery");
  expect(store.getDispatchForRun(accepted.run.id)?.authorityEpoch).toBeUndefined();
  const retried = store.claimNextDispatch({
    authorityEpoch: "boot-1",
    now: "2026-09-15T12:00:32.000Z",
    owner: "owner-a",
    leaseExpiresAt: "2026-09-15T12:01:32.000Z",
  });
  expect(retried?.memberTurn.origin).toBe("recovery");
  store.close();
});

test("crash-before-claim with a new epoch is recovery even at generation 1", async () => {
  const store = await SqliteConversationStore.open(":memory:");
  const accepted = store.acceptRequest({
    conversationId: CONV,
    topicId: TOPIC,
    requestId: "req-boot-mismatch",
    botId: BOT_ID,
    content: "hello",
    profileSnapshot: snapshot(),
    now: NOW,
    authorityEpoch: "boot-old",
  });
  expect(accepted.dispatch.generation).toBe(1);
  const claimed = store.claimNextDispatch({
    authorityEpoch: "boot-new",
    now: NOW,
    owner: "owner-restart",
    leaseExpiresAt: "2026-09-15T12:00:30.000Z",
  });
  expect(claimed?.dispatch.generation).toBe(1);
  expect(claimed?.memberTurn.origin).toBe("recovery");
  store.close();
});

test("claimNextDispatch skipTopicIds defers a Topic without claiming it", async () => {
  const store = await SqliteConversationStore.open(":memory:");
  const extra = "topic_skip_second";
  store.acceptRequest({
    conversationId: CONV,
    topicId: TOPIC,
    requestId: "req-skip-a",
    botId: BOT_ID,
    content: "alpha",
    profileSnapshot: snapshot(),
    now: NOW,
    authorityEpoch: "epoch-a",
  });
  const b = store.acceptRequest({
    conversationId: CONV,
    topicId: extra,
    requestId: "req-skip-b",
    botId: BOT_ID,
    content: "beta",
    profileSnapshot: snapshot(),
    now: NOW,
    authorityEpoch: "epoch-a",
  });
  const claimed = store.claimNextDispatch({
    now: NOW,
    owner: "owner-a",
    leaseExpiresAt: "2026-09-15T12:00:30.000Z",
    authorityEpoch: "epoch-a",
    skipTopicIds: [TOPIC],
  });
  expect(claimed?.run.id).toBe(b.run.id);
  expect(claimed?.run.topicId).toBe(extra);
  expect(store.getDispatchForRun(b.run.id)?.state).toBe("claimed");
  store.close();
});

test("deleteTopicRows is a no-op when conversationId does not own the topic", async () => {
  const store = await SqliteConversationStore.open(":memory:");
  store.acceptRequest({
    conversationId: CONV,
    topicId: TOPIC,
    requestId: "req-topic-rows",
    botId: BOT_ID,
    content: "keep me",
    profileSnapshot: snapshot(),
    now: NOW,
  });
  store.deleteTopicRows("conversation_other", TOPIC);
  expect(store.listMessages({ conversationId: CONV, topicId: TOPIC, limit: 10 })).toHaveLength(1);
  expect(store.listRuns(CONV)).toHaveLength(1);
  store.deleteTopicRows(CONV, TOPIC);
  expect(store.listMessages({ conversationId: CONV, topicId: TOPIC, limit: 10 })).toHaveLength(0);
  expect(store.listRuns(CONV)).toHaveLength(0);
  store.close();
});

test("assertLiveDispatchForMaterialize refuses deleting or cancelled work", async () => {
  const store = await SqliteConversationStore.open(":memory:");
  const accepted = store.acceptRequest({
    conversationId: CONV,
    topicId: TOPIC,
    requestId: "req-live-dispatch",
    botId: BOT_ID,
    content: "hello",
    profileSnapshot: snapshot(),
    now: NOW,
    authorityEpoch: "epoch-a",
  });
  const claimed = store.claimNextDispatch({
    now: NOW,
    owner: "owner-a",
    leaseExpiresAt: "2026-09-15T12:00:30.000Z",
    authorityEpoch: "epoch-a",
  });
  expect(claimed?.run.id).toBe(accepted.run.id);
  store.assertLiveDispatchForMaterialize({
    dispatchId: claimed!.dispatch.id,
    owner: "owner-a",
    generation: claimed!.dispatch.generation,
    runId: claimed!.run.id,
    memberTurnId: claimed!.memberTurn.id,
    conversationId: CONV,
    topicId: TOPIC,
    now: NOW,
  });
  store.markConversationDeleting(CONV, NOW);
  expect(() => store.assertLiveDispatchForMaterialize({
    dispatchId: claimed!.dispatch.id,
    owner: "owner-a",
    generation: claimed!.dispatch.generation,
    runId: claimed!.run.id,
    memberTurnId: claimed!.memberTurn.id,
    conversationId: CONV,
    topicId: TOPIC,
    now: NOW,
  })).toThrow(/deleting/);
  store.close();
});
