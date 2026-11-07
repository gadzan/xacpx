import { expect, test } from "bun:test";
import {
  acceptRoundtable,
  claimNext,
  completeTurn,
  failTurn,
  openRoundtableStore,
  RT_NOW,
  RT_OWNER,
  RT_SNAPSHOT,
  startTurn,
} from "./fixtures/roundtable-harness";

test("a multi-round discussion never completes when round 1 settles", async () => {
  const store = await openRoundtableStore();
  try {
    const accepted = acceptRoundtable(store, { botIds: ["bot_a", "bot_b"], rounds: 2 });
    const turns = store.listMemberTurns(accepted.run.id);
    completeTurn(store, accepted.run.id, turns[0]!.id);
    completeTurn(store, accepted.run.id, turns[1]!.id);
    expect(store.getRun(accepted.run.id)?.state).toBe("running");
    expect(store.getRunWorkOutcome(accepted.run.id)).toMatchObject({ closed: false });
    completeTurn(store, accepted.run.id, turns[2]!.id);
    expect(store.getRun(accepted.run.id)?.state).toBe("running");
    completeTurn(store, accepted.run.id, turns[3]!.id);
    expect(store.getRun(accepted.run.id)).toMatchObject({ state: "completed", completionReason: "members-completed" });
  } finally {
    store.close();
  }
});

test("failure outranks the cancelled tail", async () => {
  const store = await openRoundtableStore();
  try {
    const accepted = acceptRoundtable(store, { botIds: ["bot_a", "bot_b"], rounds: 2 });
    const turns = store.listMemberTurns(accepted.run.id);
    completeTurn(store, accepted.run.id, turns[0]!.id);
    failTurn(store, accepted.run.id, turns[1]!.id, "provider-failed");
    expect(store.getRun(accepted.run.id)).toMatchObject({ state: "failed", completionReason: "execution-failed" });
    expect(store.listMemberTurns(accepted.run.id).map((turn) => turn.state))
      .toEqual(["completed", "failed", "cancelled", "cancelled"]);
  } finally {
    store.close();
  }
});

test("an indeterminate settlement seals the Run and blocks every later speaker", async () => {
  const store = await openRoundtableStore();
  try {
    const accepted = acceptRoundtable(store, { botIds: ["bot_a", "bot_b", "bot_c"] });
    const turns = store.listMemberTurns(accepted.run.id);
    const { started } = startTurn(store, accepted.run.id, turns[0]!.id);
    store.completeCancel(accepted.run.id, started.id, RT_NOW, true, true, started.sourceTurnId);
    expect(store.getRun(accepted.run.id)).toMatchObject({
      state: "indeterminate",
      completionReason: "started_result_unknown",
    });
    expect(store.listMemberTurns(accepted.run.id).map((turn) => turn.state))
      .toEqual(["indeterminate", "indeterminate", "indeterminate"]);
    expect(claimNext(store, { runId: accepted.run.id })).toBeUndefined();
  } finally {
    store.close();
  }
});

test("pause stops the floor and resume continues at the next speaker", async () => {
  const store = await openRoundtableStore();
  try {
    const accepted = acceptRoundtable(store, { botIds: ["bot_a", "bot_b"], rounds: 2 });
    const turns = store.listMemberTurns(accepted.run.id);
    completeTurn(store, accepted.run.id, turns[0]!.id);
    const paused = store.pauseRun({
      runId: accepted.run.id, requestId: "pause-1", expectedControlRevision: 0, now: RT_NOW,
    });
    expect(paused.run.state).toBe("paused");
    expect(claimNext(store, { runId: accepted.run.id })).toBeUndefined();
    const resumed = store.resumeRun({
      runId: accepted.run.id, requestId: "resume-1", expectedControlRevision: paused.run.controlRevision, now: RT_NOW,
    });
    expect(["queued", "running"]).toContain(resumed.run.state);
    expect(claimNext(store, { runId: accepted.run.id })?.memberTurn.id).toBe(turns[1]!.id);
  } finally {
    store.close();
  }
});

test("Stop all cancels every later speaker and terminals the Run", async () => {
  const store = await openRoundtableStore();
  try {
    const accepted = acceptRoundtable(store, { botIds: ["bot_a", "bot_b"], rounds: 2 });
    const turns = store.listMemberTurns(accepted.run.id);
    completeTurn(store, accepted.run.id, turns[0]!.id);
    const stopped = store.cancelRun(accepted.run.id, RT_NOW);
    expect(stopped.run).toMatchObject({ state: "cancelled", completionReason: "human-cancelled" });
    expect(store.listMemberTurns(accepted.run.id).map((turn) => turn.state))
      .toEqual(["completed", "cancelled", "cancelled", "cancelled"]);
    // Unstarted tail turns were never charged.
    expect(store.getRun(accepted.run.id)?.consumedMemberTurns).toBe(1);
    expect(claimNext(store, { runId: accepted.run.id })).toBeUndefined();
  } finally {
    store.close();
  }
});

test("scoped member stop is refused for a roundtable", async () => {
  const store = await openRoundtableStore();
  try {
    const accepted = acceptRoundtable(store, { botIds: ["bot_a", "bot_b"] });
    const turn = store.listMemberTurns(accepted.run.id)[0]!;
    expect(() => store.cancelMemberTurn(accepted.run.id, turn.id, RT_NOW))
      .toThrow(expect.objectContaining({ code: "roundtable_scoped_stop_unsupported" }));
  } finally {
    store.close();
  }
});

test("a roundtable turn cannot dispatch a public handoff", async () => {
  const store = await openRoundtableStore();
  try {
    const accepted = acceptRoundtable(store, { botIds: ["bot_a", "bot_b"] });
    const turn = store.listMemberTurns(accepted.run.id)[0]!;
    const { started, claim, sourceTurnId } = startTurn(store, accepted.run.id, turn.id);
    expect(() => store.acceptPublicHandoff({
      senderMemberTurnId: started.id,
      sourceTurnId,
      dispatchId: claim.dispatch.id,
      owner: RT_OWNER,
      generation: claim.dispatch.generation,
      invocationId: "handoff-1",
      args: { to: "bot_b", task: "do the work" },
      profileSnapshot: RT_SNAPSHOT,
      now: RT_NOW,
    })).toThrow(expect.objectContaining({ code: "handoff_from_roundtable_refused" }));
    expect(store.listMemberTurns(accepted.run.id)).toHaveLength(2);
    expect(store.listMessages({ conversationId: "conversation_roundtable", topicId: "topic_roundtable", limit: 20 }))
      .toHaveLength(1);
  } finally {
    store.close();
  }
});
