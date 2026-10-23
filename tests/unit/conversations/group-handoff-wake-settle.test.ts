import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "bun:test";
import { SqliteConversationStore } from "../../../src/conversations/sqlite-conversation-store";

const NOW = "2026-10-05T00:00:00.000Z";
const LEASE = "2026-10-05T01:00:00.000Z";
const TERMINAL_RUN = ["completed", "failed", "cancelled", "indeterminate"];
const snapshot = { revision: 1, capturedAt: NOW, presentation: { name: "Member" }, behavior: {},
  execution: { agent: "codex", workspace: "backend" } };

/** Leader bot_a running with TWO dispatched assignments (bot_b, bot_c). */
async function leaderWithTwoAssignments(maxMemberTurns = 6) {
  const path = join(mkdtempSync(join(tmpdir(), "xacpx-handoff-wake-settle-")), "conversations.sqlite");
  const store = await SqliteConversationStore.open(path);
  const accepted = store.acceptRequest({ conversationId: "conversation_group", topicId: "topic_group",
    botId: "bot_a", requestId: "wake-settle", content: "human request", profileSnapshot: snapshot, maxMemberTurns, now: NOW });
  const claim = store.claimNextDispatch({ owner: "owner", now: NOW, leaseExpiresAt: LEASE })!;
  const leader = store.markExecutionStarted({ dispatchId: claim.dispatch.id, owner: "owner",
    generation: claim.dispatch.generation, runId: accepted.run.id, memberTurnId: claim.memberTurn.id,
    sessionAlias: "session_a", logicalSessionId: "logical_a", sourceTurnId: "source_a", now: NOW });
  const assignments = ["bot_b", "bot_c"].map((to, i) => store.acceptPublicHandoff({ senderMemberTurnId: leader.id,
    sourceTurnId: "source_a", dispatchId: claim.dispatch.id, owner: "owner", generation: claim.dispatch.generation,
    invocationId: `handoff-${i}`, args: { to, task: `work ${to}` }, profileSnapshot: snapshot, now: NOW }).memberTurn);
  return { store, accepted, leader, assignments };
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

const wakes = (store: SqliteConversationStore, runId: string) =>
  store.listMemberTurns(runId).filter((turn) => turn.followupSenderMemberTurnId !== undefined);

test("a leader with multiple assignments is woken exactly once, only after ALL of them settle", async () => {
  const { store, accepted, leader, assignments } = await leaderWithTwoAssignments();
  const runId = accepted.run.id;
  try {
    store.completeExecution({ runId, memberTurnId: leader.id, content: "A dispatched",
      sourceTurn: { sessionAlias: "session_a", turnId: "source_a" }, now: NOW });
    expect(wakes(store, runId)).toHaveLength(0);
    settle(store, runId, assignments[0]!, "session_b", "source_b", "B done");
    // One assignment is still queued: the leader is not done yet.
    expect(wakes(store, runId)).toHaveLength(0);
    expect(store.getRun(runId)?.state).toBe("running");
    settle(store, runId, assignments[1]!, "session_c", "source_c", "C done");
    const inserted = wakes(store, runId);
    expect(inserted).toHaveLength(1);
    expect(inserted[0]).toMatchObject({ botId: "bot_a", origin: "followup", state: "queued", followupSenderMemberTurnId: leader.id });
    // The single wake's manifest names BOTH assignments.
    for (const turn of assignments) expect(inserted[0]!.task).toContain(turn.assignmentId!);
    expect(store.getRun(runId)?.state).toBe("running");

    settle(store, runId, inserted[0]!, "session_a", "source_wake", "summary");
    // Completing the wake never re-derives a second one.
    expect(wakes(store, runId)).toHaveLength(1);
    expect(store.listMemberTurns(runId)).toHaveLength(4);
    expect(store.getRun(runId)?.state).toBe("completed");
    expect(store.claimNextDispatch({ owner: "owner", now: NOW, leaseExpiresAt: LEASE })).toBeUndefined();
  } finally { store.close(); }
});

for (const runnerOutcome of ["cancelled", "late-completed"] as const) {
  test(`stopping a RUNNING leader (${runnerOutcome}) means its settled assignments never wake it`, async () => {
    const { store, accepted, leader, assignments } = await leaderWithTwoAssignments();
    const runId = accepted.run.id;
    try {
      // The user stops the leader while its turn is still running.
      const stopping = store.cancelMemberTurn(runId, leader.id, NOW);
      expect(stopping).toMatchObject({ state: "running", cancellationReason: "human-cancelled" });
      if (runnerOutcome === "cancelled") {
        store.completeCancel(runId, leader.id, NOW);
        expect(store.getMemberTurn(leader.id)?.state).toBe("cancelled");
      } else {
        // The provider finished before the cancel landed: the stop intent still holds.
        store.completeExecution({ runId, memberTurnId: leader.id, content: "A late",
          sourceTurn: { sessionAlias: "session_a", turnId: "source_a" }, now: NOW });
        expect(store.getMemberTurn(leader.id)?.cancellationReason).toBe("human-cancelled");
      }
      // A scoped stop is not a Run cancel: the assignments still run and settle.
      settle(store, runId, assignments[0]!, "session_b", "source_b", "B done");
      settle(store, runId, assignments[1]!, "session_c", "source_c", "C done");
      expect(wakes(store, runId)).toHaveLength(0);
      expect(store.listMemberTurns(runId)).toHaveLength(3);
      expect(TERMINAL_RUN).toContain(store.getRun(runId)!.state);
      expect(store.claimNextDispatch({ owner: "owner", now: NOW, leaseExpiresAt: LEASE })).toBeUndefined();
      for (const turn of assignments) expect(store.getMemberTurn(turn.id)?.state).toBe("completed");
    } finally { store.close(); }
  });
}

test("an exhausted work budget skips the wake but the Run terminates with every assignment result readable", async () => {
  // Leader + 2 assignments consume the whole budget of 3: no room for a wake.
  const { store, accepted, leader, assignments } = await leaderWithTwoAssignments(3);
  const runId = accepted.run.id;
  try {
    store.completeExecution({ runId, memberTurnId: leader.id, content: "A dispatched",
      sourceTurn: { sessionAlias: "session_a", turnId: "source_a" }, now: NOW });
    settle(store, runId, assignments[0]!, "session_b", "source_b", "B done");
    settle(store, runId, assignments[1]!, "session_c", "source_c", "C done");
    expect(wakes(store, runId)).toHaveLength(0);
    expect(store.listMemberTurns(runId)).toHaveLength(3);
    const run = store.getRun(runId)!;
    expect(TERMINAL_RUN).toContain(run.state);
    // The wake is a summary convenience: skipping it never reports the
    // successfully settled work as failed.
    expect(run.state).toBe("completed");
    expect(store.claimNextDispatch({ owner: "owner", now: NOW, leaseExpiresAt: LEASE })).toBeUndefined();
    expect(assignments.map((turn) => store.getMemberResult(store.getMemberTurn(turn.id)!)?.content)).toEqual(["B done", "C done"]);
  } finally { store.close(); }
});
