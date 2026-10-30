import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "bun:test";

import { snapshotBotProfile } from "../../../src/bots/bot-types";
import type { ClaimedWork } from "../../../src/conversations/conversation-store";
import { ConversationError } from "../../../src/conversations/conversation-error";
import { SqliteConversationStore } from "../../../src/conversations/sqlite-conversation-store";
import { createDirectConversationId, createDirectTopicId } from "../../../src/domain/ids";

const NOW = "2026-09-15T12:00:00.000Z";
const LATER = "2026-09-15T12:00:05.000Z";
const OWNER = "owner-a";
const NEXT_OWNER = "owner-b";
const LEASE = "2026-09-15T12:01:00.000Z";
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

function accept(store: SqliteConversationStore, requestId = "req-1") {
  return store.acceptRequest({
    conversationId: CONV,
    topicId: TOPIC,
    requestId,
    botId: BOT_ID,
    content: "review this",
    profileSnapshot: snapshot(),
    now: NOW,
  });
}

function claim(store: SqliteConversationStore, owner = OWNER) {
  const work = store.claimNextDispatch({ now: NOW, owner, leaseExpiresAt: LEASE, authorityEpoch: "epoch-1" });
  if (!work) throw new Error("expected a claimable dispatch");
  return work;
}

function start(store: SqliteConversationStore, work: ClaimedWork) {
  store.markExecutionStarted({
    dispatchId: work.dispatch.id,
    owner: work.dispatch.owner!,
    generation: work.dispatch.generation,
    runId: work.run.id,
    memberTurnId: work.memberTurn.id,
    sessionAlias: "reviewer",
    logicalSessionId: "logical-1",
    sourceTurnId: "turn-1",
    now: NOW,
  });
}

function expectCode(fn: () => unknown, code: string): void {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(ConversationError);
    expect((error as ConversationError).code).toBe(code);
    return;
  }
  throw new Error(`expected ${code}`);
}

test("pausing and resuming twice each produce one state change and one revision bump", async () => {
  const store = await SqliteConversationStore.open(":memory:");
  const accepted = accept(store);

  const paused = store.pauseRun({ runId: accepted.run.id, requestId: "pause-1", expectedControlRevision: 0, now: NOW });
  expect(paused.changed).toBe(true);
  expect(paused.run.state).toBe("paused");
  expect(paused.run.pausedAt).toBe(NOW);
  expect(paused.run.controlRevision).toBe(1);

  const replay = store.pauseRun({ runId: accepted.run.id, requestId: "pause-1", expectedControlRevision: 0, now: LATER });
  expect(replay.changed).toBe(false);
  expect(replay.run.controlRevision).toBe(1);
  const secondPause = store.pauseRun({ runId: accepted.run.id, requestId: "pause-2", expectedControlRevision: 0, now: LATER });
  expect(secondPause.changed).toBe(false);
  expect(secondPause.run.controlRevision).toBe(1);

  const resumed = store.resumeRun({ runId: accepted.run.id, requestId: "resume-1", expectedControlRevision: 1, now: LATER });
  expect(resumed.changed).toBe(true);
  expect(resumed.run.state).toBe("queued");
  expect(resumed.run.pausedAt).toBeUndefined();
  expect(resumed.run.controlRevision).toBe(2);

  const resumeReplay = store.resumeRun({ runId: accepted.run.id, requestId: "resume-1", expectedControlRevision: 1, now: LATER });
  expect(resumeReplay.changed).toBe(false);
  expect(resumeReplay.run.controlRevision).toBe(2);
  // A fresh resume on a Run that is not paused is a clear error, never a
  // silent no-op.
  expectCode(
    () => store.resumeRun({ runId: accepted.run.id, requestId: "resume-2", expectedControlRevision: 2, now: LATER }),
    "run_not_paused",
  );
  // A stale CAS token is refused instead of overwriting newer control state.
  expectCode(
    () => store.pauseRun({ runId: accepted.run.id, requestId: "pause-3", expectedControlRevision: 1, now: LATER }),
    "stale_control_revision",
  );
  store.close();
});

test("a pause during an active member turn drains before the Run becomes paused", async () => {
  const store = await SqliteConversationStore.open(":memory:");
  const accepted = accept(store);
  const work = claim(store);
  start(store, work);

  const paused = store.pauseRun({ runId: accepted.run.id, requestId: "pause-1", expectedControlRevision: 0, now: NOW });
  expect(paused.changed).toBe(true);
  expect(paused.run.state).toBe("running");
  expect(paused.run.pauseRequestedAt).toBe(NOW);
  expect(paused.run.pausedAt).toBeUndefined();
  expect(paused.run.finishedAt).toBeUndefined();
  // The intent is durable and observable while the turn still runs.
  expect(store.getRun(accepted.run.id)?.pauseRequestedAt).toBe(NOW);
  // Nothing new may be claimed mid-drain.
  expect(store.claimNextDispatch({ now: NOW, owner: NEXT_OWNER, leaseExpiresAt: LEASE, authorityEpoch: "epoch-1" })).toBeUndefined();

  const settled = store.completeExecution({
    runId: accepted.run.id,
    memberTurnId: work.memberTurn.id,
    content: "review done",
    sourceTurn: { sessionAlias: "reviewer", turnId: "turn-1" },
    now: LATER,
  });
  expect(settled.run.state).toBe("paused");
  expect(settled.run.pausedAt).toBe(LATER);
  expect(settled.run.pauseRequestedAt).toBe(NOW);
  // Paused is not a terminal seal: no outcome was invented.
  expect(settled.run.finishedAt).toBeUndefined();
  expect(settled.run.completionReason).toBeUndefined();
  expect(settled.run.controlRevision).toBe(1);
  store.close();
});

test("a paused Run keeps its Topic and cannot be claimed until resume", async () => {
  const store = await SqliteConversationStore.open(":memory:");
  const accepted = accept(store);
  store.pauseRun({ runId: accepted.run.id, requestId: "pause-1", expectedControlRevision: 0, now: NOW });

  // New work cannot slip behind the paused Run.
  expectCode(() => accept(store, "req-2"), "topic_paused");
  expect(store.claimNextDispatch({ now: NOW, owner: OWNER, leaseExpiresAt: LEASE, authorityEpoch: "epoch-1" })).toBeUndefined();
  expect(store.peekClaimableTopicIds({ now: NOW, owner: OWNER, leaseExpiresAt: LEASE, authorityEpoch: "epoch-1" }, 10)).toEqual([]);

  store.resumeRun({ runId: accepted.run.id, requestId: "resume-1", expectedControlRevision: 1, now: LATER });
  const claimed = store.claimNextDispatch({ now: LATER, owner: OWNER, leaseExpiresAt: LEASE, authorityEpoch: "epoch-1" });
  expect(claimed?.run.id).toBe(accepted.run.id);
  store.close();
});

test("a paused Run reopens as paused after restart and nothing replays", async () => {
  const path = join(mkdtempSync(join(tmpdir(), "xacpx-pause-")), "conversation.sqlite");
  const first = await SqliteConversationStore.open(path);
  const accepted = accept(first);
  first.pauseRun({ runId: accepted.run.id, requestId: "pause-1", expectedControlRevision: 0, now: NOW });
  first.close();

  const reopened = await SqliteConversationStore.open(path);
  const run = reopened.getRun(accepted.run.id);
  expect(run?.state).toBe("paused");
  expect(run?.controlRevision).toBe(1);
  expect(run?.pausedAt).toBe(NOW);
  // Recovery must not re-drive it: no claim, no automatic routing step, and
  // the member turn is still untouched in the queue.
  expect(reopened.claimNextDispatch({ now: LATER, owner: OWNER, leaseExpiresAt: LEASE, authorityEpoch: "epoch-1" })).toBeUndefined();
  expect(reopened.automaticRunsAwaitingRouting()).toEqual([]);
  expect(reopened.listMemberTurns(accepted.run.id)[0]?.state).toBe("queued");
  expect(reopened.reconcilePauseIntents(LATER)).toEqual([]);
  expect(reopened.getRun(accepted.run.id)?.state).toBe("paused");
  reopened.close();
});

test("a crash during drain settles the pause only after the abandoned attempt is sealed", async () => {
  const path = join(mkdtempSync(join(tmpdir(), "xacpx-pause-drain-")), "conversation.sqlite");
  const first = await SqliteConversationStore.open(path);
  const accepted = accept(first);
  const work = claim(first);
  start(first, work);
  first.pauseRun({ runId: accepted.run.id, requestId: "pause-1", expectedControlRevision: 0, now: NOW });
  first.close();

  const reopened = await SqliteConversationStore.open(path);
  // The previous owner is gone; the started attempt is unproven, so the
  // unknown seal outranks the pause intent.
  reopened.convergePreviousOwnerClaims(NEXT_OWNER, LATER);
  const run = reopened.getRun(accepted.run.id);
  expect(run?.state).toBe("indeterminate");
  expect(run?.pauseRequestedAt).toBe(NOW);
  expect(run?.pausedAt).toBeUndefined();
  reopened.close();
});
