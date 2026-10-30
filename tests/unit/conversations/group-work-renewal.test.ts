import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "bun:test";
import { SqliteConversationStore } from "../../../src/conversations/sqlite-conversation-store";

const NOW = "2026-10-05T00:00:00.000Z";
const LEASE = "2026-10-05T01:00:00.000Z";
const snapshot = { revision: 1, capturedAt: NOW, presentation: { name: "Member" }, behavior: {},
  execution: { agent: "codex", workspace: "backend" } };

/** Production behavior: the V2 flag is on. */
async function openStore() {
  const path = join(mkdtempSync(join(tmpdir(), "xacpx-renewal-")), "conversations.sqlite");
  return { store: await SqliteConversationStore.open(path, { followupRedispatch: true }), path };
}

async function leader(requestId: string, maxMemberTurns = 24) {
  const { store, path } = await openStore();
  const accepted = store.acceptRequest({ conversationId: "conversation_group", topicId: "topic_group",
    botId: "bot_a", requestId, content: "human request", profileSnapshot: snapshot,
    maxMemberTurns, now: NOW });
  const claim = store.claimNextDispatch({ owner: "owner", now: NOW, leaseExpiresAt: LEASE })!;
  const turn = store.markExecutionStarted({ dispatchId: claim.dispatch.id, owner: "owner",
    generation: claim.dispatch.generation, runId: accepted.run.id, memberTurnId: claim.memberTurn.id,
    sessionAlias: "session_a", logicalSessionId: "logical_a", sourceTurnId: "source_a", now: NOW });
  return { store, path, runId: accepted.run.id, leader: turn, claim };
}

function claimAs(store: SqliteConversationStore, runId: string, turnId: string, session: string, sourceTurn: string) {
  const claim = store.claimNextDispatch({ owner: "owner", now: NOW, leaseExpiresAt: LEASE })!;
  expect(claim.memberTurn.id).toBe(turnId);
  return store.markExecutionStarted({ dispatchId: claim.dispatch.id, owner: "owner",
    generation: claim.dispatch.generation, runId, memberTurnId: turnId,
    sessionAlias: session, logicalSessionId: `logical_${session}`, sourceTurnId: sourceTurn, now: NOW });
}

function settle(store: SqliteConversationStore, runId: string, turnId: string, content: string, session: string, sourceTurn: string) {
  claimAs(store, runId, turnId, session, sourceTurn);
  return store.completeExecution({ runId, memberTurnId: turnId, content,
    sourceTurn: { sessionAlias: session, turnId: sourceTurn }, now: NOW });
}

test("work past the initial 24-turn window renews it once and invents no task", async () => {
  const { store, runId, leader: sender, claim } = await leader("renewal-window");
  try {
    expect(store.getRun(runId)).toMatchObject({ maxMemberTurns: 24, budgetEpoch: 0 });
    for (let index = 1; index <= 24; index++) {
      store.acceptPublicHandoff({ senderMemberTurnId: sender.id, sourceTurnId: "source_a",
        dispatchId: claim.dispatch.id, owner: "owner", generation: claim.dispatch.generation,
        invocationId: `handoff-${index}`, args: { to: "bot_b", task: `work ${index}` },
        profileSnapshot: snapshot, now: NOW });
    }
    // 24 admitted assignments + the sender. Renewal added slots, never a turn.
    const turns = store.listMemberTurns(runId);
    expect(turns).toHaveLength(25);
    expect(new Set(turns.map((turn) => turn.id)).size).toBe(25);
    expect(turns.filter((turn) => /^work \d+$/.test(turn.task ?? ""))).toHaveLength(24);
    expect(store.listDispatchesForRun(runId)).toHaveLength(25);
    expect(store.getRunWorkCapacity(runId)).toEqual({
      runId, window: 32, occurred: 25, reserved: 1, occupied: 26, budgetEpoch: 1,
    });
    const decisions = store.listRunBudgetDecisions(runId);
    expect(decisions).toHaveLength(1);
    expect(decisions[0]).toMatchObject({ epoch: 1, source: "handoff", previousLimit: 24,
      requestedDelta: 1, grantedDelta: 8, newLimit: 32, reason: "handoff:short-by-1" });
    // The sender's returning wake is reserved exactly once for the whole batch.
    const reservations = store.listFollowupReservations(runId);
    expect(reservations).toHaveLength(1);
    expect(reservations[0]).toMatchObject({ senderMemberTurnId: sender.id, status: "reserved" });
  } finally { store.close(); }
});

test("a wake owed at full capacity is reserved, then fulfilled exactly once", async () => {
  const { store, runId, leader: sender, claim } = await leader("renewal-reservation", 4);
  try {
    const children = ["bot_b", "bot_c"].map((to, index) => store.acceptPublicHandoff({
      senderMemberTurnId: sender.id, sourceTurnId: "source_a", dispatchId: claim.dispatch.id,
      owner: "owner", generation: claim.dispatch.generation, invocationId: `reserved-${index}`,
      args: { to, task: `child ${index}` }, profileSnapshot: snapshot, now: NOW }).memberTurn);
    store.completeExecution({ runId, memberTurnId: sender.id, content: "A dispatched",
      sourceTurn: { sessionAlias: "session_a", turnId: "source_a" }, now: NOW });
    expect(store.getRunWorkCapacity(runId)).toMatchObject({ window: 4, occurred: 3, reserved: 1, occupied: 4 });
    // Pause before the children settle: capacity is withheld, so the returning
    // wake may only exist as a durable reservation.
    claimAs(store, runId, children[0]!.id, "session_b", "source_b");
    claimAs(store, runId, children[1]!.id, "session_c", "source_c");
    const paused = store.pauseRun({ runId, requestId: "pause-1",
      expectedControlRevision: store.getRun(runId)!.controlRevision, now: NOW });
    expect(paused.run.state).toBe("running");
    const completeStarted = (turnId: string, content: string, session: string, sourceTurn: string) =>
      store.completeExecution({ runId, memberTurnId: turnId, content,
        sourceTurn: { sessionAlias: session, turnId: sourceTurn }, now: NOW });
    completeStarted(children[0]!.id, "B done", "session_b", "source_b");
    completeStarted(children[1]!.id, "C done", "session_c", "source_c");
    expect(store.getRun(runId)?.state).toBe("paused");
    // The report is owed: the Run may not seal while it is only reserved.
    expect(store.listMemberTurns(runId).filter((turn) => turn.followupSenderMemberTurnId === sender.id)).toHaveLength(0);
    expect(store.listFollowupReservations(runId)).toMatchObject([{ senderMemberTurnId: sender.id, status: "reserved" }]);
    const owed = store.getRunWorkOutcome(runId)!;
    expect(owed.closed).toBe(false);
    expect(owed.wakeOwedWorkIds).toEqual([sender.id]);
    // A shrunk window at fulfilment time must renew, never drop the report.
    store.directWriteForTest("runs", runId, { max_member_turns: "3" });
    const resumed = store.resumeRun({ runId, requestId: "resume-1", expectedControlRevision: paused.run.controlRevision, now: NOW });
    expect(resumed.changed).toBe(true);
    const wakes = store.listMemberTurns(runId).filter((turn) => turn.followupSenderMemberTurnId === sender.id);
    expect(wakes).toHaveLength(1);
    const reservations = store.listFollowupReservations(runId);
    expect(reservations).toHaveLength(1);
    expect(reservations[0]).toMatchObject({ status: "fulfilled", memberTurnId: wakes[0]!.id });
    expect(store.getRunWorkCapacity(runId)).toMatchObject({ window: 11, occurred: 4, reserved: 0, occupied: 4, budgetEpoch: 1 });
    expect(store.listRunBudgetDecisions(runId)).toMatchObject([{ epoch: 1, source: "followup",
      previousLimit: 3, requestedDelta: 1, grantedDelta: 8, newLimit: 11 }]);
    settle(store, runId, wakes[0]!.id, "summary", "session_a", "source_wake");
    expect(store.getRun(runId)?.state).toBe("completed");
  } finally { store.close(); }
});

test("a resource shortfall refuses the work and parks the Run recoverably", async () => {
  const { store, runId, leader: sender, claim } = await leader("renewal-resource");
  try {
    store.directWriteForTest("runs", runId, { unavailable_bot_ids_json: JSON.stringify(["bot_b"]) });
    expect(() => store.acceptPublicHandoff({ senderMemberTurnId: sender.id, sourceTurnId: "source_a",
      dispatchId: claim.dispatch.id, owner: "owner", generation: claim.dispatch.generation,
      invocationId: "refused", args: { to: "bot_b", task: "must not be admitted" },
      profileSnapshot: snapshot, now: NOW })).toThrow(expect.objectContaining({ code: "work_capacity_refused" }));
    // Refusal created nothing and is recoverable, never a budget failure.
    expect(store.listMemberTurns(runId)).toHaveLength(1);
    expect(store.listFollowupReservations(runId)).toEqual([]);
    expect(store.listRunBudgetDecisions(runId)).toEqual([]);
    expect(store.getRun(runId)).toMatchObject({ state: "running", pauseReason: "member-unavailable",
      budgetEpoch: 0, maxMemberTurns: 24 });
    expect(store.getRun(runId)?.pauseRequestedAt).toBe(NOW);
    store.completeExecution({ runId, memberTurnId: sender.id, content: "A gave up",
      sourceTurn: { sessionAlias: "session_a", turnId: "source_a" }, now: NOW });
    expect(store.getRun(runId)?.state).toBe("paused");
    store.directWriteForTest("runs", runId, { unavailable_bot_ids_json: "[]" });
    store.resumeRun({ runId, requestId: "resume-resource",
      expectedControlRevision: store.getRun(runId)!.controlRevision, now: NOW });
    expect(store.getRun(runId)?.state).toBe("running");
    const admitted = store.claimNextDispatch({ owner: "owner", now: NOW, leaseExpiresAt: LEASE });
    expect(admitted).toBeUndefined();
  } finally { store.close(); }
});

test("the work window backfills the epoch once per granted renewal", async () => {
  const { store, runId, leader: sender, claim } = await leader("renewal-epochs", 1);
  try {
    // A one-slot window forces a renewal on the very first dispatch.
    store.acceptPublicHandoff({ senderMemberTurnId: sender.id, sourceTurnId: "source_a",
      dispatchId: claim.dispatch.id, owner: "owner", generation: claim.dispatch.generation,
      invocationId: "first", args: { to: "bot_b", task: "first" }, profileSnapshot: snapshot, now: NOW });
    expect(store.getRun(runId)).toMatchObject({ maxMemberTurns: 9, budgetEpoch: 1 });
    store.acceptPublicHandoff({ senderMemberTurnId: sender.id, sourceTurnId: "source_a",
      dispatchId: claim.dispatch.id, owner: "owner", generation: claim.dispatch.generation,
      invocationId: "second", args: { to: "bot_b", task: "second" }, profileSnapshot: snapshot, now: NOW });
    // No second renewal: the granted window still has room.
    expect(store.getRun(runId)).toMatchObject({ maxMemberTurns: 9, budgetEpoch: 1 });
    expect(store.listRunBudgetDecisions(runId)).toHaveLength(1);
  } finally { store.close(); }
});
