import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "bun:test";
import { SqliteConversationStore } from "../../../src/conversations/sqlite-conversation-store";

const NOW = "2026-10-05T00:00:00.000Z";
const LEASE = "2026-10-05T01:00:00.000Z";
const snapshot = { revision: 1, capturedAt: NOW, presentation: { name: "Member" }, behavior: {},
  execution: { agent: "codex", workspace: "backend" } };

/** Leader bot_a running with ONE dispatched assignment to bot_b. */
async function leaderWithAssignment() {
  const path = join(mkdtempSync(join(tmpdir(), "xacpx-handoff-wake-cancel-")), "conversations.sqlite");
  const store = await SqliteConversationStore.open(path);
  const accepted = store.acceptRequest({ conversationId: "conversation_group", topicId: "topic_group",
    botId: "bot_a", requestId: "wake-cancel", content: "human request", profileSnapshot: snapshot, maxMemberTurns: 4, now: NOW });
  const claim = store.claimNextDispatch({ owner: "owner", now: NOW, leaseExpiresAt: LEASE })!;
  const leader = store.markExecutionStarted({ dispatchId: claim.dispatch.id, owner: "owner",
    generation: claim.dispatch.generation, runId: accepted.run.id, memberTurnId: claim.memberTurn.id,
    sessionAlias: "session_a", logicalSessionId: "logical_a", sourceTurnId: "source_a", now: NOW });
  const assignment = store.acceptPublicHandoff({ senderMemberTurnId: leader.id, sourceTurnId: "source_a",
    dispatchId: claim.dispatch.id, owner: "owner", generation: claim.dispatch.generation, invocationId: "handoff",
    args: { to: "bot_b", task: "finish the work" }, profileSnapshot: snapshot, now: NOW });
  return { store, accepted, leader, assignment: assignment.memberTurn };
}

function settle(store: SqliteConversationStore, runId: string, turn: { id: string }, session: string, sourceTurn: string, content: string) {
  const claim = store.claimNextDispatch({ owner: "owner", now: NOW, leaseExpiresAt: LEASE })!;
  expect(claim.memberTurn.id).toBe(turn.id);
  const started = store.markExecutionStarted({ dispatchId: claim.dispatch.id, owner: "owner",
    generation: claim.dispatch.generation, runId, memberTurnId: turn.id,
    sessionAlias: session, logicalSessionId: `logical_${session}`, sourceTurnId: sourceTurn, now: NOW });
  store.completeExecution({ runId, memberTurnId: started.id, content,
    sourceTurn: { sessionAlias: session, turnId: sourceTurn }, now: NOW });
}

test("cancelling a leader whose wake is queued cancels that wake, not the Run", async () => {
  const { store, accepted, leader, assignment } = await leaderWithAssignment();
  try {
    store.completeExecution({ runId: accepted.run.id, memberTurnId: leader.id, content: "A done",
      sourceTurn: { sessionAlias: "session_a", turnId: "source_a" }, now: NOW });
    settle(store, accepted.run.id, assignment, "session_b", "source_b", "B done");
    // Every assignment settled, so the leader earned exactly ONE queued wake.
    const wake = store.listMemberTurns(accepted.run.id).find((turn) => turn.followupSenderMemberTurnId === leader.id)!;
    expect(wake).toMatchObject({ botId: "bot_a", origin: "followup", state: "queued" });
    expect(store.getRun(accepted.run.id)?.state).toBe("running");

    const cancelled = store.cancelMemberTurn(accepted.run.id, leader.id, NOW);
    // The leader already earned and settled its wake row, so no further intent
    // is needed: the cancelled wake row itself blocks any re-insert.
    expect(cancelled).toMatchObject({ state: "completed" });
    expect(cancelled.cancellationReason).toBeUndefined();
    expect(store.getMemberTurn(wake.id)).toMatchObject({ state: "cancelled", cancellationReason: "human-cancelled", finishedAt: NOW });
    // A scoped cancel of the wake is not a Run-level cancellation: the proven
    // completion of the leader and its assignment keeps the Run completed.
    expect(store.getRun(accepted.run.id)?.state).toBe("completed");
    expect(store.getRun(accepted.run.id)?.cancellationReason).toBeUndefined();
    // The retired wake is no longer claimable work.
    expect(store.claimNextDispatch({ owner: "owner", now: NOW, leaseExpiresAt: LEASE })).toBeUndefined();
  } finally { store.close(); }
});

test("stopping a terminal leader with unsettled assignments never wakes it afterwards", async () => {
  const { store, accepted, leader, assignment } = await leaderWithAssignment();
  try {
    store.completeExecution({ runId: accepted.run.id, memberTurnId: leader.id, content: "A done",
      sourceTurn: { sessionAlias: "session_a", turnId: "source_a" }, now: NOW });
    // The leader is already terminal while its assignment is still queued, so
    // no wake row exists to cancel: the scoped intent must be recorded now.
    const stopped = store.cancelMemberTurn(accepted.run.id, leader.id, NOW);
    expect(stopped).toMatchObject({ state: "completed", cancellationReason: "human-cancelled" });
    expect(store.listMemberTurns(accepted.run.id).some((turn) => turn.followupSenderMemberTurnId === leader.id)).toBe(false);
    expect(store.getRun(accepted.run.id)?.state).toBe("running");
    expect(store.getRun(accepted.run.id)?.cancellationReason).toBeUndefined();

    settle(store, accepted.run.id, assignment, "session_b", "source_b", "B done");
    const turns = store.listMemberTurns(accepted.run.id);
    expect(turns).toHaveLength(2);
    expect(turns.some((turn) => turn.followupSenderMemberTurnId !== undefined)).toBe(false);
    expect(store.getRun(accepted.run.id)?.state).toBe("completed");
    expect(store.getRun(accepted.run.id)?.cancellationReason).toBeUndefined();
  } finally { store.close(); }
});
