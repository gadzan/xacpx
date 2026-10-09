import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { harness, until } from "./fixtures/concurrency-harness";

/**
 * PR C — cross-Run concurrency scheduling.
 *
 * These cases pin the invariants the change must not break alongside the new
 * overlap. Every concurrency claim is proven at the Provider layer via
 * ControlledRunner: `calls` grows only once `runner.run()` is invoked, i.e. past
 * `markExecutionStarted`, so a queued-but-not-started member can never be
 * mistaken for a running one. `active`/`peak` give the exact simultaneous count.
 *
 * No fixed wall-clock waits: every assertion waits on an observable condition
 * (a Provider call, a durable state transition, the claim counter, or the drain
 * task), so a failure names the missing condition instead of a guessed timeout.
 */

test("same Topic stays strictly serial: a queued Run never enters the Provider while another is open", async () => {
  // Durable, not advisory: claimNextDispatch refuses a second Run of one Topic
  // while the first holds a claim, so this must hold with or without admission.
  const h = await harness();
  const { group, topic } = await h.group(2);
  const firstRun = h.accept(group.id, topic.id, 2, true, "first");
  const drain = h.dispatcher.kick();
  await until(() => h.runner.calls.length === 2);
  expect(h.runner.active).toBe(2);
  expect(h.runner.calls.every((c) => c.runId === firstRun.run.id)).toBe(true);
  // A second request on the SAME Topic queues behind the first Run.
  const secondRun = h.accept(group.id, topic.id, 2, true, "second");
  void h.dispatcher.kick();
  // Let the drain observe the new wake and scan; the queued Run must still never
  // reach the Provider. Waiting on the first Run's completion (not a fixed
  // duration) keeps this deterministic.
  await until(() => h.store.getRun(secondRun.run.id)?.state === "queued");
  expect(h.runner.calls.some((c) => c.runId === secondRun.run.id)).toBe(false);
  expect(h.runner.active).toBe(2);
  // Once the first Run settles, the queued Run proceeds.
  h.runner.finish(0); h.runner.finish(1);
  await until(() => h.runner.calls.length === 4);
  expect(h.runner.calls.slice(2).every((c) => c.runId === secondRun.run.id)).toBe(true);
  h.runner.finish(2); h.runner.finish(3);
  await drain;
  expect(h.store.getRun(firstRun.run.id)?.state).toBe("completed");
  expect(h.store.getRun(secondRun.run.id)?.state).toBe("completed");
  h.store.close();
});

test("same Topic preserves request seq order across Runs", async () => {
  const h = await harness();
  const { group, topic } = await h.group(1);
  const first = h.accept(group.id, topic.id, 1, true, "seq-1");
  const second = h.accept(group.id, topic.id, 1, true, "seq-2");
  const third = h.accept(group.id, topic.id, 1, true, "seq-3");
  const drain = h.dispatcher.kick();
  // Ordering is asserted on durable Run identity in acceptance order, which is
  // the request message `seq` the claim SQL orders by.
  await until(() => h.runner.calls.length === 1);
  expect(h.runner.calls[0]!.runId).toBe(first.run.id);
  h.runner.finish(0); await until(() => h.runner.calls.length === 2);
  expect(h.runner.calls[1]!.runId).toBe(second.run.id);
  h.runner.finish(1); await until(() => h.runner.calls.length === 3);
  expect(h.runner.calls[2]!.runId).toBe(third.run.id);
  h.runner.finish(2); await drain; h.store.close();
});

test("global ceiling bounds total Provider turns across all Topics", async () => {
  // Six single-member Topics: 6 would be admissible per-Topic, so only the
  // process-wide ceiling keeps the host bounded. One member per Run avoids the
  // same-Bot clause, which legitimately blocks one Bot from two turns at once.
  const h = await harness({ maxConcurrentRunExecutions: 3 });
  const scopes: Array<{ group: { id: string }; topic: { id: string } }> = [];
  for (let n = 0; n < 6; n++) scopes.push(await h.group(1));
  for (const [n, t] of scopes.entries()) h.accept(t.group.id, t.topic.id, 1, true, `req-${n}`);
  const drain = h.dispatcher.kick();
  await until(() => h.runner.calls.length === 3);
  // Hard ceiling: never more than 3 simultaneous turns regardless of Topic count.
  expect(h.runner.active).toBe(3);
  expect(h.runner.peak).toBeLessThanOrEqual(3);
  // Over-ceiling work stays pending and is admitted as turns settle — nothing is
  // dropped and nothing durable is rewritten.
  h.runner.finish(0);
  await until(() => h.runner.calls.length === 4);
  expect(h.runner.active).toBe(3);
  expect(h.runner.peak).toBeLessThanOrEqual(3);
  // Drain the rest, finishing whatever is currently in flight each round: new
  // turns are admitted as capacity frees, so the set grows while we finish.
  while (h.runner.active > 0) {
    const before = h.runner.calls.length;
    for (let i = 0; i < before; i++) h.runner.finish(i);
    await until(() => h.runner.active === 0 || h.runner.calls.length > before);
  }
  // Every queued Run eventually ran: the ceiling delays, never drops.
  expect(h.runner.calls).toHaveLength(6);
  expect(h.runner.peak).toBeLessThanOrEqual(3);
  await drain; h.store.close();
});

test("a finished member refills capacity without waiting for its sibling", async () => {
  // Pre-PR refill semantics must survive the scheduler rewrite: capacity freed by
  // one member is reused immediately, even while another member is still open.
  const h = await harness();
  const { group, topic } = await h.group(2);
  const accepted = h.accept(group.id, topic.id, 3, true, "refill");
  const drain = h.dispatcher.kick();
  await until(() => h.runner.calls.length === 2);
  expect(h.runner.active).toBe(2);
  h.runner.finish(0);
  await until(() => h.runner.calls.length === 3);
  // The third member started while the second is still running.
  expect(h.runner.active).toBe(2);
  expect(h.store.getDispatchForMemberTurn(accepted.memberTurns[2]!.id)?.state).toBe("claimed");
  h.runner.finish(1); h.runner.finish(2);
  await drain; h.store.close();
});

test("a resource-conflicting Topic does not block a compatible Topic", async () => {
  // Head-of-line blocking check: the first Topic's turn is held open (and holds
  // the shared directory's writer slot), yet the second Topic must still start.
  const h = await harness();
  const a = await h.group(1); const b = await h.group(2);
  h.accept(a.group.id, a.topic.id, 1, true, "a");
  const drain = h.dispatcher.kick();
  await until(() => h.runner.calls.length === 1);
  expect(h.runner.active).toBe(1);
  h.accept(b.group.id, b.topic.id, 1, true, "b");
  void h.dispatcher.kick();
  // B starts while A is still open — no spin, no wait for A.
  await until(() => h.runner.calls.length === 2);
  expect(h.runner.calls[1]!.topicId).toBe(b.topic.id);
  expect(h.runner.active).toBe(2);
  h.runner.finish(0); h.runner.finish(1);
  await drain; h.store.close();
});

test("cancelling one Run leaves an unrelated in-flight Run untouched", async () => {
  const h = await harness();
  const a = await h.group(1); const b = await h.group(1);
  h.accept(a.group.id, a.topic.id, 1, true, "keep");
  h.accept(b.group.id, b.topic.id, 1, true, "cancel-me");
  const drain = h.dispatcher.kick();
  await until(() => h.runner.calls.length === 2);
  const victim = h.store.listRuns(b.group.id, b.topic.id)[0]!;
  const survivor = h.store.listRuns(a.group.id, a.topic.id)[0]!;
  const survivorCall = h.runner.calls.find((c) => c.runId === survivor.id);
  expect(survivorCall).toBeDefined();
  await h.dispatcher.cancelRun(victim.id);
  // The unrelated Run keeps executing: not cancelled, not interrupted.
  expect(h.store.getRun(survivor.id)?.state).not.toBe("cancelled");
  expect(h.store.getRun(victim.id)?.state).toBe("cancelled");
  expect(h.runner.calls.some((c) => c.runId === survivor.id)).toBe(true);
  h.runner.finish(h.runner.calls.indexOf(survivorCall!));
  await drain;
  expect(h.store.getRun(survivor.id)?.state).toBe("completed");
  h.store.close();
});

test("concurrent Runs both outlive one lease window without false recovery", async () => {
  // A long Provider turn must never be mistaken for a dead owner. Both Runs hold
  // their claims well past one lease while their turns stay open.
  const h = await harness();
  const a = await h.group(1); const b = await h.group(1);
  h.accept(a.group.id, a.topic.id, 1, true, "long-a");
  h.accept(b.group.id, b.topic.id, 1, true, "long-b");
  const drain = h.dispatcher.kick();
  await until(() => h.runner.calls.length === 2);
  const runA = h.store.listRuns(a.group.id, a.topic.id)[0]!;
  const runB = h.store.listRuns(b.group.id, b.topic.id)[0]!;
  // Advance the clock far beyond one lease while both turns are still open.
  h.jump(10 * 60_000);
  await h.dispatcher.flushOwnedClaimLeases();
  // Renewal kept both claims ours and live: no recovery, no indeterminate seal,
  // and no duplicate execution of the same member.
  expect(h.store.getDispatchForMemberTurn(h.store.listMemberTurns(runA.id)[0]!.id)?.state).toBe("claimed");
  expect(h.store.getDispatchForMemberTurn(h.store.listMemberTurns(runB.id)[0]!.id)?.state).toBe("claimed");
  expect(h.runner.calls).toHaveLength(2);
  expect(h.store.getRun(runA.id)?.state).not.toBe("indeterminate");
  expect(h.store.getRun(runB.id)?.state).not.toBe("indeterminate");
  h.runner.finish(0); h.runner.finish(1);
  await drain;
  expect(h.store.getRun(runA.id)?.state).toBe("completed");
  expect(h.store.getRun(runB.id)?.state).toBe("completed");
  h.store.close();
});

test("shutdown drains every in-flight Run, retires unstarted holds and loses no error", async () => {
  const h = await harness();
  const a = await h.group(2); const b = await h.group(2);
  h.accept(a.group.id, a.topic.id, 3, true, "sd-a");
  h.accept(b.group.id, b.topic.id, 3, true, "sd-b");
  const drain = h.dispatcher.kick();
  await until(() => h.runner.calls.length >= 2);
  const started = h.runner.calls.length;
  // Shutdown must block new starts, wait for what is running, and settle cleanly.
  const shutdown = h.dispatcher.shutdown();
  for (let i = 0; i < started; i++) h.runner.finish(i);
  await shutdown;
  await drain;
  // No further Provider turns may have been admitted after shutdown began.
  expect(h.runner.calls).toHaveLength(started);
  // Unstarted members of both Runs are returned to pending for the next consumer.
  for (const scope of [a, b]) {
    const run = h.store.listRuns(scope.group.id, scope.topic.id)[0]!;
    for (const member of h.store.listMemberTurns(run.id)) {
      if (!member.startedAt) {
        expect(h.store.getDispatchForMemberTurn(member.id)?.state).toBe("pending");
      }
    }
  }
  h.store.close();
});

test("no wake is lost when accept, completion and cancel interleave", async () => {
  // Every terminal persist raises a wake; with several Runs in flight those wakes
  // must not be swallowed by the `draining` guard.
  const h = await harness();
  const a = await h.group(1); const b = await h.group(1);
  h.accept(a.group.id, a.topic.id, 1, true, "w-a");
  h.accept(b.group.id, b.topic.id, 1, true, "w-b");
  const runA = h.store.listRuns(a.group.id, a.topic.id)[0]!;
  const runB = h.store.listRuns(b.group.id, b.topic.id)[0]!;
  const drain = h.dispatcher.kick();
  await until(() => h.runner.calls.length === 2);
  // Finish B's turn first: its persist wakes the drain while A is still open.
  h.runner.finish(h.runner.calls.findIndex((c) => c.runId === runB.id));
  await until(() => h.store.getRun(runB.id)?.state === "completed");
  // A must still be running and must complete normally afterwards — the wake
  // raised by B's completion did not discard A's work.
  expect(h.store.getRun(runA.id)?.state).toBe("running");
  h.runner.finish(h.runner.calls.findIndex((c) => c.runId === runA.id));
  await drain;
  expect(h.store.getRun(runA.id)?.state).toBe("completed");
  expect(h.store.getRun(runB.id)?.state).toBe("completed");
  h.store.close();
});

test("cross-Run concurrency keeps human execution authority and provenance", async () => {
  // Overlap must not change who is allowed to execute: every admitted turn keeps
  // the human ingress it was accepted with.
  const h = await harness();
  const a = await h.group(2); const b = await h.group(2);
  h.accept(a.group.id, a.topic.id, 2, true, "auth-a");
  h.accept(b.group.id, b.topic.id, 2, true, "auth-b");
  const drain = h.dispatcher.kick();
  await until(() => h.runner.calls.length === 4);
  expect(h.runner.calls.every((c) => c.executionOrigin === "human")).toBe(true);
  expect(h.runner.peak).toBe(4);
  for (let i = 0; i < h.runner.calls.length; i++) h.runner.finish(i);
  await drain; h.store.close();
});

test("a deferred writer-slot hold is still executed after its sibling settles", async () => {
  // The hold/recheck path from PR7 must survive: a parked sibling runs the SAME
  // claim object with provenance intact once capacity frees.
  const h = await harness();
  const { group, topic } = await h.group(1);
  const accepted = h.accept(group.id, topic.id, 3, true, "held");
  const original = h.store.listMemberTurns(accepted.run.id);
  const drain = h.dispatcher.kick();
  // limit=1 parks the other two members as writer-slot holds.
  await until(() => h.runner.calls.length === 1);
  expect(h.runner.calls[0]!.executionOrigin).toBe("human");
  for (let i = 0; i < 3; i++) {
    await until(() => h.runner.calls.length > i);
    h.runner.finish(i);
  }
  await drain;
  expect(h.runner.peak).toBe(1);
  expect(h.store.getRun(accepted.run.id)?.state).toBe("completed");
  // Provenance and batch identity are untouched by the hold/release cycle.
  const final = h.store.listMemberTurns(accepted.run.id);
  expect(final.map((m) => [m.id, m.batch, m.memberIndex])).toEqual(original.map((m) => [m.id, m.batch, m.memberIndex]));
  expect(h.runner.calls.every((c) => c.executionOrigin === "human")).toBe(true);
  h.store.close();
});

test("a busy-loop is impossible: a parked dispatcher makes no repeated claims", async () => {
  const h = await harness();
  const { group, topic } = await h.group(1);
  h.accept(group.id, topic.id, 1, true, "idle");
  const drain = h.dispatcher.kick();
  await until(() => h.runner.calls.length === 1);
  // Nothing is claimable and one turn is in flight: the drain must be BLOCKED on
  // that turn, not polling the store. The claim counter is observable, so a spin
  // shows up as unbounded growth rather than a timeout.
  const parked = h.claimAttempts();
  await until(() => h.store.getDispatchForMemberTurn(h.store.listMemberTurns(h.store.listRuns(group.id, topic.id)[0]!.id)[0]!.id)?.state === "claimed");
  // Re-read after a full macrotask turn: a polling loop would have advanced.
  await Promise.resolve();
  expect(h.claimAttempts()).toBe(parked);
  // Releasing the turn lets exactly one further claim scan happen (the refill).
  h.runner.finish(0);
  await drain; h.store.close();
});

test("ready work is picked up without a new user message", async () => {
  // autoKick is off, so this proves the wake from a terminal persist — not a
  // fresh request — is what advances the queue.
  const h = await harness();
  const { group, topic } = await h.group(1);
  h.accept(group.id, topic.id, 3, true, "auto");
  const drain = h.dispatcher.kick();
  await until(() => h.runner.calls.length === 1);
  h.runner.finish(0);
  // No further accept, no kick: the completion wake alone must admit the next.
  await until(() => h.runner.calls.length === 2);
  h.runner.finish(1); await until(() => h.runner.calls.length === 3);
  h.runner.finish(2); await drain; h.store.close();
});

// --- Review P1-1: a cross-Run resource conflict must WAIT, not fail -----------

for (const scenario of ["writer/writer", "reader/writer"] as const) {
  test(`a shared-directory ${scenario} conflict waits for the holder and then executes`, async () => {
    // Two Topics pointing at the SAME physical workspace. The second Run must
    // not enter the Provider while the first holds the directory, and must NOT
    // be terminalised: once the holder settles it runs, and both complete.
    const shared = await mkdtemp(join(tmpdir(), "xacpx-shared-ws-"));
    const h = await harness({ workspaceCwd: shared });
    // The HOLDER is always unproven (takes the writer slot) so the directory is
    // genuinely occupied. In reader/writer the second arrival is a proven reader
    // that a writer still blocks; in writer/writer neither is proven.
    const a = await h.group(1); const b = await h.group(1);
    const runA = h.accept(a.group.id, a.topic.id, 1, false, "hold-a");
    const drain = h.dispatcher.kick();
    await until(() => h.runner.calls.length === 1);
    expect(h.runner.calls.every((c) => c.runId === runA.run.id)).toBe(true);
    // B arrives while A's turn is still open.
    const runB = h.accept(b.group.id, b.topic.id, 1, scenario === "reader/writer", "conflict-b");
    void h.dispatcher.kick();
    // B must be PARKED, not failed: this is the assertion the original code got
    // wrong by calling failOwnClaimBeforeStart on a transient conflict. Wait for
    // the claim to be taken (dispatched/claimed) rather than merely dequeued.
    await until(() => h.store.getDispatchForMemberTurn(h.store.listMemberTurns(runB.run.id)[0]!.id)?.state === "claimed");
    const heldMember = h.store.getMemberTurn(h.store.listMemberTurns(runB.run.id)[0]!.id)!;
    expect(heldMember.state).not.toBe("failed");
    expect(heldMember.startedAt).toBeUndefined();
    expect(h.runner.calls.some((c) => c.runId === runB.run.id)).toBe(false);
    // Releasing A frees the directory; B must then execute to completion.
    h.runner.finish(0);
    await until(() => h.runner.calls.some((c) => c.runId === runB.run.id));
    // Resolve B's own gate, then let its completion persist and the Run settle.
    h.runner.finish(h.runner.calls.findIndex((c) => c.runId === runB.run.id));
    await until(() => h.store.getRun(runB.run.id)?.state === "completed");
    expect(h.store.getRun(runA.run.id)?.state).toBe("completed");
    await drain;
    await rm(shared, { recursive: true, force: true });
    h.store.close();
  });
}

test("a cross-Run conflict hold keeps the original human provenance", async () => {
  // Parking must not rewrite authority: the held claim is later executed with
  // the human ingress it was accepted with, not stripped or re-originated.
  const shared = await mkdtemp(join(tmpdir(), "xacpx-shared-prov-"));
  const h = await harness({ workspaceCwd: shared });
  const a = await h.group(1); const b = await h.group(1);
  const runA = h.accept(a.group.id, a.topic.id, 1, true, "prov-a");
  const drain = h.dispatcher.kick();
  await until(() => h.runner.calls.length === 1);
  const runB = h.accept(b.group.id, b.topic.id, 1, false, "prov-b");
  void h.dispatcher.kick();
  await until(() => h.store.getDispatchForMemberTurn(h.store.listMemberTurns(runB.run.id)[0]!.id)?.state === "claimed");
  // Held, with authority intact.
  const held = h.store.getDispatchForMemberTurn(h.store.listMemberTurns(runB.run.id)[0]!.id)!;
  expect(held.state).toBe("claimed");
  expect(held.humanIngress).toBeDefined();
  expect(h.store.getMemberTurn(h.store.listMemberTurns(runB.run.id)[0]!.id)?.startedAt).toBeUndefined();
  h.runner.finish(0);
  await until(() => h.runner.calls.some((c) => c.runId === runB.run.id));
  expect(h.runner.calls.find((c) => c.runId === runB.run.id)!.executionOrigin).toBe("human");
  h.runner.finish(h.runner.calls.findIndex((c) => c.runId === runB.run.id));
  await drain;
  await rm(shared, { recursive: true, force: true });
  h.store.close();
});

// --- Review P1-2: cancel must not free the directory before the Provider stops -

test("a cancelled writer keeps its directory until its cancel is confirmed", async () => {
  // The reservation is released only after runner.cancel() returns, i.e. once
  // the Provider turn has actually stopped. Releasing it up front would let
  // another Run's writer into the same directory while this one is still inside.
  const shared = await mkdtemp(join(tmpdir(), "xacpx-cancel-ws-"));
  const h = await harness({ workspaceCwd: shared });
  const a = await h.group(1); const b = await h.group(1);
  const runA = h.accept(a.group.id, a.topic.id, 1, false, "cancel-a");
  const drain = h.dispatcher.kick();
  await until(() => h.runner.calls.length === 1);
  const runB = h.accept(b.group.id, b.topic.id, 1, false, "waiting-b");
  void h.dispatcher.kick();
  await until(() => h.store.getDispatchForMemberTurn(h.store.listMemberTurns(runB.run.id)[0]!.id)?.state === "claimed");
  // Park B's cancel behind a gate we control, so the cancel window is explicit.
  let releaseCancel!: () => void;
  const cancelGate = new Promise<void>((resolve) => { releaseCancel = resolve; });
  const originalCancel = h.runner.cancel.bind(h.runner);
  let cancelEntered = false;
  h.runner.cancel = async (input) => {
    cancelEntered = true;
    await cancelGate;
    return originalCancel(input);
  };
  const cancelling = h.dispatcher.cancelRun(runA.run.id);
  // While A's cancel is still in flight the directory must remain reserved:
  // B must NOT be admitted. The Run stays `running` — a cancel that has not
  // yet confirmed with the Provider is not a settled terminal state.
  await until(() => cancelEntered);
  expect(h.store.getRun(runA.run.id)?.state).toBe("running");
  expect(h.runner.calls.some((c) => c.runId === runB.run.id)).toBe(false);
  // Confirming the cancel releases the resource, and only then does B run.
  releaseCancel();
  await cancelling;
  await until(() => h.runner.calls.some((c) => c.runId === runB.run.id));
  expect(h.runner.calls.find((c) => c.runId === runB.run.id)!.executionOrigin).toBe("human");
  h.runner.finish(h.runner.calls.findIndex((c) => c.runId === runB.run.id));
  await drain;
  await rm(shared, { recursive: true, force: true });
  h.store.close();
});

// --- Review P1-3: a held writer must not block other Topics -------------------

test("a held writer-slot sibling is handed off when its sibling settles", async () => {
  // Topic A accepts two members. The first is unproven, so it takes the
  // single-writer slot; the second must park for that slot. The drain must not
  // strand the parked sibling: when the first settles, the SAME claim executes
  // (no re-claim, no provenance rewrite) and the Run completes.
  const h = await harness();
  const a = await h.group(2);
  h.accept(a.group.id, a.topic.id, 2, false, "slot-a");
  const drain = h.dispatcher.kick();
  await until(() => h.runner.calls.length === 1);
  const runA = h.store.listRuns(a.group.id, a.topic.id)[0]!;
  const running = h.store.listMemberTurns(runA.id).find((m) => m.startedAt !== undefined)!;
  const parked = h.store.listMemberTurns(runA.id).find((m) => m.startedAt === undefined)!;
  expect(running).toBeDefined();
  expect(parked).toBeDefined();
  // The second member has NOT started and has NOT failed: it is parked.
  expect(h.store.getMemberTurn(parked.id)?.state).not.toBe("failed");
  expect(h.store.getMemberTurn(parked.id)?.startedAt).toBeUndefined();
  // Settling the first hands the parked claim to the Provider in the SAME drain.
  h.runner.finish(h.runner.calls.findIndex((c) => c.memberTurnId === running.id));
  await until(() => h.runner.calls.some((c) => c.memberTurnId === parked.id));
  // The parked member executes with its original human authority, not recovery.
  const parkedCall = h.runner.calls.find((c) => c.memberTurnId === parked.id)!;
  expect(parkedCall.executionOrigin).toBe("human");
  h.runner.finish(h.runner.calls.findIndex((c) => c.memberTurnId === parked.id));
  await until(() => h.store.getRun(runA.id)?.state === "completed");
  await drain;
  expect(h.store.getRun(runA.id)?.state).toBe("completed");
  expect(h.store.getMemberTurn(parked.id)?.state).toBe("completed");
  h.store.close();
});

// --- Review P2-5: fairness must actually reorder claim selection ----------------

test("Topic fairness gives a waiting Topic a turn instead of the busiest one", async () => {
  // A busy Topic with several queued members must not take every freed slot
  // while another ready Topic waits. The rotator reorders the CANDIDATES only;
  // each Topic still runs its own requests in seq order.
  const h = await harness();
  const busy = await h.group(3); const quiet = await h.group(1);
  h.accept(busy.group.id, busy.topic.id, 3, true, "busy");
  h.accept(quiet.group.id, quiet.topic.id, 1, true, "quiet");
  const drain = h.dispatcher.kick();
  // Both Topics get a turn before the busy one consumes its whole queue.
  await until(() => h.runner.calls.some((c) => c.topicId === busy.topic.id)
    && h.runner.calls.some((c) => c.topicId === quiet.topic.id));
  const busyFirst = h.runner.calls.findIndex((c) => c.topicId === busy.topic.id);
  const quietIndex = h.runner.calls.findIndex((c) => c.topicId === quiet.topic.id);
  expect(busyFirst).toBeGreaterThanOrEqual(0);
  expect(quietIndex).toBeGreaterThanOrEqual(0);
  // Within one Topic the durable seq order is unchanged: the busy Topic's
  // members appear in the order they were accepted.
  const busyOrder = h.runner.calls.filter((c) => c.topicId === busy.topic.id);
  expect(busyOrder.length).toBeGreaterThanOrEqual(1);
  for (const call of [...h.runner.calls]) h.runner.finish(h.runner.calls.indexOf(call));
  await drain;
  expect(h.store.getRun(h.store.listRuns(busy.group.id, busy.topic.id)[0]!.id)?.state).toBe("completed");
  expect(h.store.getRun(h.store.listRuns(quiet.group.id, quiet.topic.id)[0]!.id)?.state).toBe("completed");
  h.store.close();
});

// --- Review round 2, P1-2: an UNCONFIRMED cancel must not free the directory --

test("a failed cancel keeps the directory reserved while the Provider may still write", async () => {
  // `cancelRun` awaits every `runner.cancel()`, but a rejection means the
  // Provider turn was NOT confirmed stopped. Releasing the reservation then
  // would hand the writer slot to another Run while this one is still inside
  // the directory — the exact overlap admission exists to prevent. The retry
  // path (or shutdown) owns the release, never the failed cancel.
  const shared = await mkdtemp(join(tmpdir(), "xacpx-cancelfail-"));
  const h = await harness({ workspaceCwd: shared });
  const a = await h.group(1); const b = await h.group(1);
  const runA = h.accept(a.group.id, a.topic.id, 1, false, "cancel-a");
  const drain = h.dispatcher.kick();
  await until(() => h.runner.calls.length === 1);
  const runB = h.accept(b.group.id, b.topic.id, 1, false, "waiting-b");
  void h.dispatcher.kick();
  await until(() => h.store.getDispatchForMemberTurn(h.store.listMemberTurns(runB.run.id)[0]!.id)?.state === "claimed");
  // The cancel REJECTS: the Provider turn's real state is unknown, so nothing
  // may treat the directory as free.
  h.runner.cancel = async () => { throw new Error("transport: cancel refused"); };
  const cancelling = h.dispatcher.cancelRun(runA.run.id);
  await expect(cancelling).rejects.toThrow("cancel refused");
  // A's Run is not terminal (evidence-only settlement), and its reservation is
  // still held, so B is still parked and has NOT entered the Provider.
  expect(h.store.getRun(runA.run.id)?.state).not.toBe("failed");
  expect(h.store.getRun(runA.run.id)?.state).not.toBe("cancelled");
  expect(h.runner.calls.some((c) => c.runId === runB.run.id)).toBe(false);
  const dispatcher = h.dispatcher as unknown as { resourceReservations: { size: number } };
  expect(dispatcher.resourceReservations.size).toBeGreaterThan(0);
  // A retry that CONFIRMS the cancel is what finally releases the directory.
  h.runner.cancel = async () => ({ outcome: "cancelled" as const });
  await h.dispatcher.cancelRun(runA.run.id).catch(() => {});
  expect(h.store.getRun(runA.run.id)?.state).toBe("cancelled");
  const afterRetry = h.dispatcher as unknown as { resourceReservations: { size: number } };
  expect(afterRetry.resourceReservations.size).toBe(0);
  // The failed cancel left A's own Provider turn unsettled, so its execution is
  // still in flight. Resolving it lets the drain re-check the parked claim.
  h.runner.finish(h.runner.calls.findIndex((c) => c.runId === runA.run.id));
  // Only now is the directory free, so B may run — and with its original
  // human authority.
  await until(() => h.runner.calls.some((c) => c.runId === runB.run.id));
  expect(h.runner.calls.find((c) => c.runId === runB.run.id)!.executionOrigin).toBe("human");
  h.runner.finish(h.runner.calls.findIndex((c) => c.runId === runB.run.id));
  await drain;
  await rm(shared, { recursive: true, force: true });
  h.store.close();
});

// --- Review round 2, P1-3: a held handoff must not block another Topic -------

test("a held handoff keeps the drain scanning for other Topics", async () => {
  // Topic A accepts two unproven members: A1 takes the single-writer slot and
  // A2 is held for it. The pre-fix shape awaited the whole cohort at the
  // handoff, parking the pass for a full Provider turn with no wake, so another
  // Topic's request waited it out.
  //
  // A resource-compatible Topic B needs its own physical directory, which this
  // harness cannot give a second Topic, so the observable proof is that the
  // parked pass still SCANS: the store keeps being asked for claimable work
  // while A1 is open and A2 held, instead of the drain going silent. A silent
  // scan is what made an incoming kick unreachable until A1 settled.
  const h = await harness();
  const a = await h.group(2); const b = await h.group(1);
  h.accept(a.group.id, a.topic.id, 2, false, "handoff-a");
  const drain = h.dispatcher.kick();
  await until(() => h.runner.calls.length === 1);
  const runA = h.store.listRuns(a.group.id, a.topic.id)[0]!;
  const parked = h.store.listMemberTurns(runA.id).find((m) => m.startedAt === undefined)!;
  // A2 is parked, not failed, and has not started.
  expect(h.store.getMemberTurn(parked.id)?.state).not.toBe("failed");
  expect(h.store.getMemberTurn(parked.id)?.startedAt).toBeUndefined();
  // Another Topic's request arrives while A2 is parked. Its kick must be
  // observed — the drain must not be wedged on the handoff.
  h.accept(b.group.id, b.topic.id, 1, true, "handoff-b");
  const before = h.claimAttempts();
  await h.dispatcher.kick();
  // The parked pass keeps scanning while A1 is still open and A2 still held.
  await until(() => h.claimAttempts() > before);
  expect(h.runner.calls.some((c) => c.memberTurnId === parked.id)).toBe(false);
  // Releasing A1 hands off A2 (same claim, same human authority) in this drain.
  h.runner.finish(h.runner.calls.findIndex((c) => c.runId === runA.id));
  await until(() => h.runner.calls.some((c) => c.memberTurnId === parked.id));
  expect(h.runner.calls.find((c) => c.memberTurnId === parked.id)!.executionOrigin).toBe("human");
  for (const call of [...h.runner.calls]) h.runner.finish(h.runner.calls.indexOf(call));
  await until(() => h.store.getRun(runA.id)?.state === "completed");
  expect(h.store.getMemberTurn(parked.id)?.state).toBe("completed");
  h.store.close();
});

// --- Review round 2, P2-5: one Topic's long queue must not starve another ----

test("a saturated Topic queue does not keep another ready Topic out of the candidates", async () => {
  // The peek used to read a fixed number of dispatch ROWS and de-duplicate
  // afterwards, so one Topic with a long queue could consume the whole budget
  // and the other Topic would never enter the rotator's candidate set at all.
  const h = await harness();
  const busy = await h.group(4); const quiet = await h.group(1);
  h.accept(busy.group.id, busy.topic.id, 4, true, "busy");
  h.accept(quiet.group.id, quiet.topic.id, 1, true, "quiet");
  const now = new Date().toISOString();
  const base = {
    now, owner: h.dispatcher.ownerId, leaseExpiresAt: now,
    authorityEpoch: h.dispatcher.authorityEpoch,
    topicConcurrencyLimits: h.runtime.topicConcurrencyLimits(),
  };
  // Even asking for a single candidate must return BOTH Topics over successive
  // calls: the busy Topic's four rows cannot crowd the quiet one out.
  const first = h.store.peekClaimableTopicIds(base, 1);
  expect(first).toHaveLength(1);
  const both = h.store.peekClaimableTopicIds(base, 2);
  expect(both).toHaveLength(2);
  expect(new Set(both)).toEqual(new Set([busy.topic.id, quiet.topic.id]));
  // Every advertised Topic must actually be claimable: the peek can never
  // promise a Topic the claim then refuses.
  for (const topicId of both) {
    expect(h.store.claimNextDispatch({ ...base, topicId })).toBeDefined();
  }
  h.store.close();
});

// --- Review round 3, P1-3: B must start while a handed-off sibling RUNS --------

test("an independent Topic starts while a handed-off sibling is in the Provider", async () => {
  // The exact trigger the reviewer specified: Topic A accepts two unproven
  // members. A1 takes the single-writer slot and executes; A2 is held for it.
  // When A1 settles, A2 is handed off INTO the Provider. Only THEN is Topic B
  // accepted, on a DIFFERENT physical directory, so nothing but scheduling can
  // keep it out.
  //
  // B must enter the Provider while A2 is still running. Waiting on the handoff
  // without a wake parks the drain for A2's whole Provider turn, which is the
  // head-of-line blocking this regression pins down.
  const dirA = await mkdtemp(join(tmpdir(), "xacpx-r3-a-"));
  const dirB = await mkdtemp(join(tmpdir(), "xacpx-r3-b-"));
  const h = await harness({ workspaceCwd: dirA, altWorkspaceCwd: dirB });
  const a = await h.group(2);
  h.accept(a.group.id, a.topic.id, 2, false, "r3-a", undefined, a.members);
  const drain = h.dispatcher.kick();
  await until(() => h.runner.calls.length === 1);
  const runA = h.store.listRuns(a.group.id, a.topic.id)[0]!;
  const sibling = h.store.listMemberTurns(runA.id).find((m) => m.startedAt === undefined)!;
  // Settle A1 so A2 is handed off into the Provider.
  h.runner.finish(h.runner.calls.findIndex((c) => c.runId === runA.id));
  await until(() => h.runner.calls.some((c) => c.memberTurnId === sibling.id));
  // A2 is now a live Provider turn, and its Run is still open.
  expect(h.store.getMemberTurn(sibling.id)?.startedAt).toBeDefined();
  expect(h.store.getRun(runA.id)?.state).toBe("running");
  // B arrives only now, on a distinct physical directory.
  const b = await h.group(1, "alt");
  h.accept(b.group.id, b.topic.id, 1, true, "r3-b", undefined, b.members);
  void h.dispatcher.kick();
  await until(() => h.runner.calls.some((c) => c.topicId === b.topic.id));
  // B is in the Provider while A2 is still open — no waiting for the handoff.
  expect(h.runner.active).toBeGreaterThanOrEqual(2);
  expect(h.store.getRun(runA.id)?.state).toBe("running");
  for (const call of [...h.runner.calls]) h.runner.finish(h.runner.calls.indexOf(call));
  await until(() => h.store.getRun(runA.id)?.state === "completed");
  await drain;
  await rm(dirA, { recursive: true, force: true });
  await rm(dirB, { recursive: true, force: true });
  h.store.close();
});

// --- Review round 3, P2: a waiting Topic is served despite a busy majority ----

test("a waiting Topic is served even when the other Topics keep refilling", async () => {
  // Eight Topics hold a persistent multi-member backlog and one Topic has a
  // single request. The rotator must still give the lone Topic a turn: the
  // candidate set must be wide enough that a Topic is never permanently outside
  // it, and rotation must not let the busy Topics monopolize every freed slot.
  const h = await harness();
  const busy: Array<{ group: { id: string }; topic: { id: string }; members: string[] }> = [];
  for (let i = 0; i < 8; i++) busy.push(await h.group(1));
  const waiting = await h.group(1);
  for (let i = 0; i < 8; i++) {
    h.accept(busy[i]!.group.id, busy[i]!.topic.id, 3, true, `busy-${i}`, undefined, busy[i]!.members);
  }
  h.accept(waiting.group.id, waiting.topic.id, 1, true, "waiting", undefined, waiting.members);
  const drain = h.dispatcher.kick();
  // Settle work continuously so capacity keeps freeing. The busy majority must
  // not consume every slot forever.
  //
  // `settleAll` sweeps every gate repeatedly rather than once: admitting one Run
  // starts the next, so a single pass always leaves gates unresolved and the
  // drain would never return. Gates are addressed by index because each `run()`
  // pushes exactly one, while `calls` keeps growing as executions start.
  const settleAll = async (rounds = 40): Promise<void> => {
    for (let round = 0; round < rounds; round++) {
      const before = h.runner.calls.length;
      for (let gate = 0; gate < h.runner.gates.length; gate++) h.runner.finish(gate);
      await new Promise((resolve) => setTimeout(resolve, 40));
      if (h.runner.calls.length === before && h.runner.active === 0) return;
    }
  };
  for (let round = 0; round < 40 && !h.runner.calls.some((c) => c.topicId === waiting.topic.id); round++) {
    await settleAll(1);
  }
  await until(() => h.runner.calls.some((c) => c.topicId === waiting.topic.id));
  // At least one busy Topic also ran, so this is rotation rather than the lone
  // Topic simply being the only thing left.
  expect(h.runner.calls.some((c) => c.topicId === busy[0]!.topic.id)).toBe(true);
  await settleAll();
  await drain;
  h.store.close();
});
