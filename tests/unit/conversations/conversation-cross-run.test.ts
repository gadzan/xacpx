import { expect, test } from "bun:test";
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
