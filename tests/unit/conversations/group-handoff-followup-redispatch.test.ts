import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "bun:test";
import { SqliteConversationStore } from "../../../src/conversations/sqlite-conversation-store";

const NOW = "2026-10-05T00:00:00.000Z";
const LEASE = "2026-10-05T01:00:00.000Z";
const snapshot = { revision: 1, capturedAt: NOW, presentation: { name: "Member" }, behavior: {},
  execution: { agent: "codex", workspace: "backend" } };

async function openFlagged() {
  const path = join(mkdtempSync(join(tmpdir(), "xacpx-p0b1-")), "conversations.sqlite");
  return SqliteConversationStore.open(path, { followupRedispatch: true });
}

interface Fixture {
  store: SqliteConversationStore;
  runId: string;
  leader: { id: string };
}

async function leaderAndAssignments(maxMemberTurns: number, childCount: 1 | 2): Promise<Fixture & { children: { id: string }[] }> {
  const store = await openFlagged();
  const accepted = store.acceptRequest({ conversationId: "conversation_group", topicId: "topic_group",
    botId: "bot_a", requestId: `p0b1-${Math.random()}`, content: "human request", profileSnapshot: snapshot, maxMemberTurns, now: NOW });
  const claim = store.claimNextDispatch({ owner: "owner", now: NOW, leaseExpiresAt: LEASE })!;
  const leader = store.markExecutionStarted({ dispatchId: claim.dispatch.id, owner: "owner",
    generation: claim.dispatch.generation, runId: accepted.run.id, memberTurnId: claim.memberTurn.id,
    sessionAlias: "session_a", logicalSessionId: "logical_a", sourceTurnId: "source_a", now: NOW });
  const children = ["bot_b", "bot_c"].slice(0, childCount).map((to, i) => store.acceptPublicHandoff({
    senderMemberTurnId: leader.id, sourceTurnId: "source_a", dispatchId: claim.dispatch.id,
    owner: "owner", generation: claim.dispatch.generation, invocationId: `handoff-${i}`,
    args: { to, task: `work ${to}` }, profileSnapshot: snapshot, now: NOW,
  }).memberTurn);
  store.completeExecution({ runId: accepted.run.id, memberTurnId: leader.id, content: "A dispatched",
    sourceTurn: { sessionAlias: "session_a", turnId: "source_a" }, now: NOW });
  return { store, runId: accepted.run.id, leader, children };
}

function claimAs(store: SqliteConversationStore, runId: string, turnId: string, session: string, sourceTurn: string) {
  const claim = store.claimNextDispatch({ owner: "owner", now: NOW, leaseExpiresAt: LEASE })!;
  expect(claim.memberTurn.id).toBe(turnId);
  expect(store.getDispatchForMemberTurn(turnId)?.generation).toBe(claim.dispatch.generation);
  return store.markExecutionStarted({ dispatchId: claim.dispatch.id, owner: "owner",
    generation: claim.dispatch.generation, runId, memberTurnId: turnId,
    sessionAlias: session, logicalSessionId: `logical_${session}`, sourceTurnId: sourceTurn, now: NOW });
}

/** Settle a queued assignment exactly the way production dispatch finishes it. */
function settleChild(store: SqliteConversationStore, runId: string, turnId: string, content: string, sourceTurn: string) {
  const started = claimAs(store, runId, turnId, "session_child", sourceTurn);
  return store.completeExecution({ runId, memberTurnId: started.id, content,
    sourceTurn: { sessionAlias: "session_child", turnId: sourceTurn }, now: NOW });
}

function settleWake(store: SqliteConversationStore, runId: string, wakeId: string, content: string, sourceTurn: string) {
  const started = claimAs(store, runId, wakeId, "session_a", sourceTurn);
  return store.completeExecution({ runId, memberTurnId: started.id, content,
    sourceTurn: { sessionAlias: "session_a", turnId: sourceTurn }, now: NOW });
}

function wakeFor(store: SqliteConversationStore, runId: string, senderId: string) {
  return store.listMemberTurns(runId).find((turn) => turn.followupSenderMemberTurnId === senderId);
}

test("A dispatches to B, B settles, A is woken, A dispatches to C, C settles, A summarizes, Run completes", async () => {
  const { store, runId, leader, children } = await leaderAndAssignments(8, 1);
  try {
    expect(store.getRun(runId)?.state).toBe("running");
    settleChild(store, runId, children[0]!.id, "B done", "source_b");
    const wake = wakeFor(store, runId, leader.id)!;
    expect(wake).toMatchObject({ botId: "bot_a", origin: "followup", state: "queued" });
    expect(wake.task!.split("\n")[0]).toBe(`All assignments sent by your member turn ${leader.id} have settled. Read each result with group_read_result using its assignmentId.`);
    expect(JSON.parse(wake.task!.split("\n")[1]!)).toEqual([
      { assignmentId: children[0]!.assignmentId, botId: "bot_b", state: "completed" },
    ]);
    const started = claimAs(store, runId, wake.id, "session_a", "source_wake");
    const repair = store.acceptPublicHandoff({ senderMemberTurnId: started.id, sourceTurnId: "source_wake",
      dispatchId: store.getDispatchForMemberTurn(started.id)!.id, owner: "owner",
      generation: store.getDispatchForMemberTurn(started.id)!.generation, invocationId: "wake-call",
      args: { to: "bot_c", task: "verify the fix" }, profileSnapshot: snapshot, now: NOW });
    expect(repair.reused).toBe(false);
    expect(store.getRun(runId)?.state).toBe("running");
    store.completeExecution({ runId, memberTurnId: started.id, content: "A dispatched followups",
      sourceTurn: { sessionAlias: "session_a", turnId: "source_wake" }, now: NOW });
    expect(wakeFor(store, runId, started.id)).toBeUndefined();
    settleChild(store, runId, repair.memberTurn.id, "C verified", "source_c");
    const wake2 = wakeFor(store, runId, started.id)!;
    expect(wake2).toMatchObject({ botId: "bot_a", origin: "followup", state: "queued" });
    settleWake(store, runId, wake2.id, "summary", "source_wake_2");
    expect(store.getRun(runId)).toMatchObject({ state: "completed", completionReason: "members-completed" });
    const turns = store.listMemberTurns(runId);
    expect(turns.map((turn) => turn.id)).toEqual([leader.id, children[0]!.id, wake.id, repair.memberTurn.id, wake2.id]);
    expect(store.claimNextDispatch({ owner: "owner", now: NOW, leaseExpiresAt: LEASE })).toBeUndefined();
  } finally { store.close(); }
});

test("parallel dispatch from one sender settles in either order with exactly one wake", async () => {
  for (const order of [[0, 1], [1, 0]] as const) {
    const { store, runId, leader, children } = await leaderAndAssignments(8, 2);
    try {
      // Claims follow Run order, but settlement order is what the wake counts:
      // start both children, then finish them in the requested order.
      const start = (turnId: string) => {
        const dispatch = store.claimNextDispatch({ owner: "owner", now: NOW, leaseExpiresAt: LEASE })!;
        expect(dispatch.memberTurn.id).toBe(turnId);
        return store.markExecutionStarted({ dispatchId: dispatch.dispatch.id, owner: "owner",
          generation: dispatch.dispatch.generation, runId, memberTurnId: turnId,
          sessionAlias: "session_child", logicalSessionId: "logical_session_child",
          sourceTurnId: `source_${turnId}`, now: NOW });
      };
      const complete = (turnId: string, content: string) =>
        store.completeExecution({ runId, memberTurnId: turnId, content,
          sourceTurn: { sessionAlias: "session_child", turnId: `source_${turnId}` }, now: NOW });
      const [first, second] = [children[order[0]]!, children[order[1]]!];
      const startedFirst = start(children[0]!.id);
      const startedSecond = start(children[1]!.id);
      const byId = new Map([[children[0]!.id, startedFirst.id], [children[1]!.id, startedSecond.id]]);
      if (order[0] === 1) {
        complete(byId.get(children[1]!.id)!, "second done");
        expect(wakeFor(store, runId, leader.id)).toBeUndefined();
        expect(store.getRun(runId)?.state).toBe("running");
        complete(byId.get(children[0]!.id)!, "first done");
      } else {
        complete(byId.get(children[0]!.id)!, "first done");
        expect(wakeFor(store, runId, leader.id)).toBeUndefined();
        expect(store.getRun(runId)?.state).toBe("running");
        complete(byId.get(children[1]!.id)!, "second done");
      }
      const wakes = store.listMemberTurns(runId).filter((turn) => turn.followupSenderMemberTurnId !== undefined);
      expect(wakes).toHaveLength(1);
      expect(wakes[0]).toMatchObject({ botId: "bot_a", followupSenderMemberTurnId: leader.id });
      expect(JSON.parse(wakes[0]!.task!.split("\n")[1]!).map((entry: { botId: string }) => entry.botId).sort())
        .toEqual(["bot_b", "bot_c"]);
      settleWake(store, runId, wakes[0]!.id, "summary", `source_wake_${order[0]}`);
      expect(store.getRun(runId)).toMatchObject({ state: "completed", completionReason: "members-completed" });
      expect(store.getRunWorkOutcome(runId)).toMatchObject({ closed: true });
    } finally { store.close(); }
  }
});

test("a failed child repaired through the wake ends completed, not failed", async () => {
  const { store, runId, leader, children } = await leaderAndAssignments(8, 1);
  try {
    const started = claimAs(store, runId, children[0]!.id, "session_child", "source_b");
    store.failExecution({ runId, memberTurnId: started.id, sourceTurnId: "source_b", reason: "broken", now: NOW });
    const wake = wakeFor(store, runId, leader.id)!;
    expect(wake).toBeDefined();
    const woken = claimAs(store, runId, wake.id, "session_a", "source_wake");
    const repair = store.acceptPublicHandoff({ senderMemberTurnId: woken.id, sourceTurnId: "source_wake",
      dispatchId: store.getDispatchForMemberTurn(woken.id)!.id, owner: "owner",
      generation: store.getDispatchForMemberTurn(woken.id)!.generation, invocationId: "repair",
      args: { to: "bot_c", task: "repair the failure" }, profileSnapshot: snapshot, now: NOW });
    store.completeExecution({ runId, memberTurnId: woken.id, content: "A re-dispatched",
      sourceTurn: { sessionAlias: "session_a", turnId: "source_wake" }, now: NOW });
    settleChild(store, runId, repair.memberTurn.id, "repaired", "source_c");
    settleWake(store, runId, wakeFor(store, runId, woken.id)!.id, "verified fix", "source_wake_2");
    expect(store.getRun(runId)).toMatchObject({ state: "completed", completionReason: "members-completed" });
  } finally { store.close(); }
});

test("a wake that dispatches and then fails leaves the Run failed", async () => {
  const { store, runId, leader, children } = await leaderAndAssignments(8, 1);
  try {
    settleChild(store, runId, children[0]!.id, "B done", "source_b");
    const wake = wakeFor(store, runId, leader.id)!;
    const woken = claimAs(store, runId, wake.id, "session_a", "source_wake");
    const repair = store.acceptPublicHandoff({ senderMemberTurnId: woken.id, sourceTurnId: "source_wake",
      dispatchId: store.getDispatchForMemberTurn(woken.id)!.id, owner: "owner",
      generation: store.getDispatchForMemberTurn(woken.id)!.generation, invocationId: "repair",
      args: { to: "bot_c", task: "repair" }, profileSnapshot: snapshot, now: NOW });
    store.failExecution({ runId, memberTurnId: woken.id, sourceTurnId: "source_wake", reason: "wake crashed", now: NOW });
    settleChild(store, runId, repair.memberTurn.id, "orphan result", "source_c");
    expect(store.getRun(runId)).toMatchObject({ state: "failed" });
  } finally { store.close(); }
});

test("a wake may redispatch to an open ancestor that is not waiting on it, but not into its own unresolved result", async () => {
  const store = await openFlagged();
  try {
    // ALLOWED: A is still executing; it waits on nothing in B's line, so the
    // new leaf simply queues behind A's current turn (§4.5 shared-Bot queue).
    const allowedRun = store.acceptRequest({ conversationId: "conversation_group", topicId: "topic_group",
      botId: "bot_a", requestId: "p0b1-cycle-allowed", content: "human request", profileSnapshot: snapshot, maxMemberTurns: 12, now: NOW });
    const allowedId = allowedRun.run.id;
    const firstClaim = store.claimNextDispatch({ owner: "owner", now: NOW, leaseExpiresAt: LEASE })!;
    const runningA = store.markExecutionStarted({ dispatchId: firstClaim.dispatch.id, owner: "owner",
      generation: firstClaim.dispatch.generation, runId: allowedId, memberTurnId: firstClaim.memberTurn.id,
      sessionAlias: "session_a", logicalSessionId: "logical_a", sourceTurnId: "source_a", now: NOW });
    const toB = store.acceptPublicHandoff({ senderMemberTurnId: runningA.id, sourceTurnId: "source_a",
      dispatchId: firstClaim.dispatch.id, owner: "owner", generation: firstClaim.dispatch.generation,
      invocationId: "to-b", args: { to: "bot_b", task: "work" }, profileSnapshot: snapshot, now: NOW });
    const bStarted = claimAs(store, allowedId, toB.memberTurn.id, "session_b", "source_b");
    const bDispatch = store.getDispatchForMemberTurn(bStarted.id)!;
    const toC = store.acceptPublicHandoff({ senderMemberTurnId: bStarted.id, sourceTurnId: "source_b",
      dispatchId: bDispatch.id, owner: "owner", generation: bDispatch.generation,
      invocationId: "to-c", args: { to: "bot_c", task: "nested" }, profileSnapshot: snapshot, now: NOW });
    store.completeExecution({ runId: allowedId, memberTurnId: bStarted.id, content: "B dispatched",
      sourceTurn: { sessionAlias: "session_b", turnId: "source_b" }, now: NOW });
    settleChild(store, allowedId, toC.memberTurn.id, "C done", "source_c");
    const wakeB = wakeFor(store, allowedId, bStarted.id)!;
    const wokenB = claimAs(store, allowedId, wakeB.id, "session_b", "source_wake_b");
    const allowed = store.acceptPublicHandoff({ senderMemberTurnId: wokenB.id, sourceTurnId: "source_wake_b",
      dispatchId: store.getDispatchForMemberTurn(wokenB.id)!.id, owner: "owner",
      generation: store.getDispatchForMemberTurn(wokenB.id)!.generation, invocationId: "leaf",
      args: { to: "bot_a", task: "verify the result" }, profileSnapshot: snapshot, now: NOW });
    expect(allowed.reused).toBe(false);
    expect(store.getMemberTurn(allowed.memberTurn.id)).toMatchObject({ botId: "bot_a", state: "queued" });
    expect(store.getRun(allowedId)?.state).toBe("running");

    // REFUSED: A waits on its own undelivered child B, the branch the sender's
    // line sits on. A would depend on its own unfinished result. A separate
    // store keeps the first Run from holding this Topic.
    const other = await openFlagged();
    try {
      const refusedRun = other.acceptRequest({ conversationId: "conversation_group", topicId: "topic_group",
        botId: "bot_a", requestId: "p0b1-cycle-refused", content: "human request", profileSnapshot: snapshot, maxMemberTurns: 12, now: NOW });
      const refusedId = refusedRun.run.id;
      const claimA = other.claimNextDispatch({ owner: "owner", now: NOW, leaseExpiresAt: LEASE })!;
      const waitingA = other.markExecutionStarted({ dispatchId: claimA.dispatch.id, owner: "owner",
        generation: claimA.dispatch.generation, runId: refusedId, memberTurnId: claimA.memberTurn.id,
        sessionAlias: "session_a", logicalSessionId: "logical_a", sourceTurnId: "source_a", now: NOW });
      const refusedB = other.acceptPublicHandoff({ senderMemberTurnId: waitingA.id, sourceTurnId: "source_a",
        dispatchId: claimA.dispatch.id, owner: "owner", generation: claimA.dispatch.generation,
        invocationId: "to-b", args: { to: "bot_b", task: "work" }, profileSnapshot: snapshot, now: NOW });
      // A finished its turn but still waits on B's undelivered result.
      other.completeExecution({ runId: refusedId, memberTurnId: waitingA.id, content: "A dispatched",
        sourceTurn: { sessionAlias: "session_a", turnId: "source_a" }, now: NOW });
      const runningB = claimAs(other, refusedId, refusedB.memberTurn.id, "session_b", "source_b");
      const refusedBDispatch = other.getDispatchForMemberTurn(runningB.id)!;
      const refusedC = other.acceptPublicHandoff({ senderMemberTurnId: runningB.id, sourceTurnId: "source_b",
        dispatchId: refusedBDispatch.id, owner: "owner", generation: refusedBDispatch.generation,
        invocationId: "to-c", args: { to: "bot_c", task: "nested" }, profileSnapshot: snapshot, now: NOW });
      const runningC = claimAs(other, refusedId, refusedC.memberTurn.id, "session_c", "source_c");
      const refusedCDispatch = other.getDispatchForMemberTurn(runningC.id)!;
      const refusedD = other.acceptPublicHandoff({ senderMemberTurnId: runningC.id, sourceTurnId: "source_c",
        dispatchId: refusedCDispatch.id, owner: "owner", generation: refusedCDispatch.generation,
        invocationId: "to-d", args: { to: "bot_d", task: "leaf" }, profileSnapshot: snapshot, now: NOW });
      other.completeExecution({ runId: refusedId, memberTurnId: runningC.id, content: "C dispatched",
        sourceTurn: { sessionAlias: "session_c", turnId: "source_c" }, now: NOW });
      settleChild(other, refusedId, refusedD.memberTurn.id, "D done", "source_d");
      const wakeC = wakeFor(other, refusedId, runningC.id)!;
      const wokenC = claimAs(other, refusedId, wakeC.id, "session_c", "source_wake_c");
      const before = other.listMemberTurns(refusedId).length;
      let thrown: unknown;
      try {
        other.acceptPublicHandoff({ senderMemberTurnId: wokenC.id, sourceTurnId: "source_wake_c",
          dispatchId: other.getDispatchForMemberTurn(wokenC.id)!.id, owner: "owner",
          generation: other.getDispatchForMemberTurn(wokenC.id)!.generation, invocationId: "cycle",
          args: { to: "bot_a", task: "cycle" }, profileSnapshot: snapshot, now: NOW });
      } catch (error) { thrown = error; }
      expect(thrown).toMatchObject({
        code: "handoff_waiting_cycle",
        details: { path: [waitingA.id, refusedB.memberTurn.id, runningC.id] },
      });
      expect(other.listMemberTurns(refusedId)).toHaveLength(before);
    } finally { other.close(); }
  } finally { store.close(); }
});

test("a Run with a wake owed never reaches completed", async () => {
  const { store, runId, leader, children } = await leaderAndAssignments(8, 1);
  try {
    settleChild(store, runId, children[0]!.id, "B done", "source_b");
    const wake = wakeFor(store, runId, leader.id)!;
    expect(wake.state).toBe("queued");
    expect(store.getRunWorkOutcome(runId)).toMatchObject({ decidingWorkIds: [leader.id], closed: false });
    store.cancelMemberTurn(runId, leader.id, NOW);
    const cancelled = store.getMemberTurn(wake.id)!;
    expect(cancelled.state).toBe("cancelled");
    expect(store.getRun(runId)?.state).toBe("completed");
  } finally { store.close(); }
});

test("legacy wake refusal stays intact while the flag is off", async () => {
  const path = join(mkdtempSync(join(tmpdir(), "xacpx-p0b1-off-")), "conversations.sqlite");
  const store = await SqliteConversationStore.open(path);
  try {
    const accepted = store.acceptRequest({ conversationId: "conversation_group", topicId: "topic_group",
      botId: "bot_a", requestId: "p0b1-off", content: "human request", profileSnapshot: snapshot, maxMemberTurns: 8, now: NOW });
    const claim = store.claimNextDispatch({ owner: "owner", now: NOW, leaseExpiresAt: LEASE })!;
    const leader = store.markExecutionStarted({ dispatchId: claim.dispatch.id, owner: "owner",
      generation: claim.dispatch.generation, runId: accepted.run.id, memberTurnId: claim.memberTurn.id,
      sessionAlias: "session_a", logicalSessionId: "logical_a", sourceTurnId: "source_a", now: NOW });
    const child = store.acceptPublicHandoff({ senderMemberTurnId: leader.id, sourceTurnId: "source_a",
      dispatchId: claim.dispatch.id, owner: "owner", generation: claim.dispatch.generation,
      invocationId: "handoff", args: { to: "bot_b", task: "work" }, profileSnapshot: snapshot, now: NOW });
    store.completeExecution({ runId: accepted.run.id, memberTurnId: leader.id, content: "A dispatched",
      sourceTurn: { sessionAlias: "session_a", turnId: "source_a" }, now: NOW });
    const started = claimAs(store, accepted.run.id, child.memberTurn.id, "session_child", "source_b");
    store.completeExecution({ runId: accepted.run.id, memberTurnId: started.id, content: "B done",
      sourceTurn: { sessionAlias: "session_child", turnId: "source_b" }, now: NOW });
    const wake = wakeFor(store, accepted.run.id, leader.id)!;
    const woken = claimAs(store, accepted.run.id, wake.id, "session_a", "source_wake");
    let thrown: unknown;
    try {
      store.acceptPublicHandoff({ senderMemberTurnId: woken.id, sourceTurnId: "source_wake",
        dispatchId: store.getDispatchForMemberTurn(woken.id)!.id, owner: "owner",
        generation: store.getDispatchForMemberTurn(woken.id)!.generation, invocationId: "wake-call",
        args: { to: "bot_c", task: "verify" }, profileSnapshot: snapshot, now: NOW });
    } catch (error) { thrown = error; }
    expect(thrown).toMatchObject({ code: "handoff_from_followup_refused" });
  } finally { store.close(); }
});
