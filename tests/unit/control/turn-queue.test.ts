// tests/unit/control/turn-queue.test.ts
// White-box tests for TurnQueue: the three-state concurrency gate (inFlight/queues/draining)
// extracted out of ControlService.executeTurn. Drives TurnQueue directly with a controllable
// fake runTurn — no ControlService, no SessionTurnRunner, no sessions dependency (TurnQueue is
// session-free by design; the sessions-changed compare is threaded in via
// deps.detectSessionsChanged).
import { expect, test } from "bun:test";
import { TurnQueue, type TurnQueueDeps } from "../../../src/control/turn-queue";
import type { TurnRequest, TurnResult } from "../../../src/control/session-turn-runner";
import { TURN_IDLE_TIMEOUT_REASON } from "../../../src/control/turn-support";

// Wires a TurnQueue to a controllable deferred runTurn. `runTurn` records each turn's text into
// `started` (so drain-order tests can assert it) and parks on a pending promise the test resolves
// by hand via `resolveNext`. Deps default to no-ops; pass `overrides` to inject behavior (e.g. a
// detectSessionsChanged that cancels a queued item). Models SessionTurnRunner.run's real
// contract: it never rejects — it always resolves with a TurnResult (ok:false + errorMessage on
// failure), so there is no reject path to fake.
function makeQueue(overrides?: Partial<TurnQueueDeps>) {
  const started: string[] = [];
  const pending: Array<{ req: TurnRequest; resolve: (r: TurnResult) => void; signal: AbortSignal; onActivity?: () => void }> = [];
  // Single-slot fake idle timer (the watchdog arms at most one live timer per turn),
  // with call counters so a reset (clear old + arm new) is observable.
  let idleFn: (() => void) | null = null;
  let setCount = 0;
  let clearCount = 0;
  const setTimer = (fn: () => void, _ms: number): unknown => { idleFn = fn; setCount++; return 1; };
  const clearTimer = (_id: unknown) => { idleFn = null; clearCount++; };
  const queue = new TurnQueue({
    runTurn: (req: TurnRequest, signal: AbortSignal, onActivity?: () => void) => {
      started.push(req.text);
      return new Promise<TurnResult>((resolve) => pending.push({ req, resolve, signal, onActivity }));
    },
    emitQueueUpdated: () => {},
    detectSessionsChanged: async () => {},
    setTimer,
    clearTimer,
    ...overrides,
  });
  return {
    queue,
    started,
    resolveNext: (r: TurnResult = { ok: true }) => pending.shift()?.resolve(r),
    pendingCount: () => pending.length,
    pendingReqs: () => pending.map((p) => p.req),
    head: () => pending[0],
    fireIdle: () => { const fn = idleFn; idleFn = null; fn?.(); },
    idleArmed: () => idleFn !== null,
    setCount: () => setCount,
    clearCount: () => clearCount,
  };
}

const BASE = { chatKey: "c", sessionAlias: "s", senderId: "u" };
const tick = () => new Promise((r) => setTimeout(r, 0));

test("submit's busy-decision + enqueue is a synchronous prefix (same tick, zero await)", () => {
  const { queue } = makeQueue();
  const req = { ...BASE, text: "A", queueable: true };
  void queue.submit(req); // sync inFlight.set
  void queue.submit({ ...req, text: "B" }); // sync enqueue
  // ZERO await between submit and this assertion — pins the synchronous prefix.
  expect(queue.queueLength("c", "s")).toBe(1);
  expect(queue.isBusy("c", "s")).toBe(true);
});

test("a busy second submit enqueues and reports queued:true with an id", async () => {
  const { queue, resolveNext } = makeQueue();
  const p1 = queue.submit({ ...BASE, text: "first", queueable: true });
  await tick();
  const r2 = await queue.submit({ ...BASE, text: "second", queueable: true });
  expect(r2).toMatchObject({ ok: true, queued: true });
  expect(typeof (r2 as { queueItemId: string }).queueItemId).toBe("string");
  expect(queue.queueLength("c", "s")).toBe(1);
  resolveNext();
  await p1;
});

test("a non-queueable submit while busy rejects immediately with turn-already-running", async () => {
  const { queue, resolveNext } = makeQueue();
  const p1 = queue.submit({ ...BASE, text: "first", queueable: true });
  await tick();
  const r2 = await queue.submit({ ...BASE, text: "sched" }); // no queueable flag
  expect(r2).toEqual({ ok: false, errorMessage: "turn-already-running" });
  expect(queue.queueLength("c", "s")).toBe(0);
  resolveNext();
  await p1;
});

test("FIFO drain: queued items each run their own turn in order", async () => {
  const { queue, started, resolveNext } = makeQueue();
  const p1 = queue.submit({ ...BASE, text: "first", queueable: true });
  await tick();
  const p2 = queue.submit({ ...BASE, text: "second", queueable: true });
  const p3 = queue.submit({ ...BASE, text: "third", queueable: true });

  resolveNext(); // finish "first" -> drain "second"
  await tick();
  resolveNext(); // finish "second" -> drain "third"
  await tick();
  resolveNext(); // finish "third" -> empty
  await tick();

  await Promise.all([p1, p2, p3]);
  expect(started).toEqual(["first", "second", "third"]);
  expect(queue.queueLength("c", "s")).toBe(0);
  expect(queue.isBusy("c", "s")).toBe(false);
});

test("a submit arriving during the drain hand-off enqueues (no parallel turn)", async () => {
  const { queue, started, resolveNext } = makeQueue();
  const p1 = queue.submit({ ...BASE, text: "first", queueable: true });
  await tick();
  const p2 = queue.submit({ ...BASE, text: "second", queueable: true });
  resolveNext(); // finish "first"; drain hands off to "second" (still async before it registers)
  const r3 = await queue.submit({ ...BASE, text: "third", queueable: true }); // saw busy -> queued
  expect(r3).toMatchObject({ ok: true, queued: true });
  resolveNext();
  await tick();
  resolveNext();
  await Promise.all([p1, p2]);
  expect(started).toEqual(["first", "second", "third"]);
});

test("stranded-tail: a drained head whose turn fails still drains the following item", async () => {
  const { queue, started, resolveNext } = makeQueue();
  const p1 = queue.submit({ ...BASE, text: "first", queueable: true });
  await tick();
  // "second"/"third" submit while busy -> both return the enqueue ack immediately, NOT the
  // eventual drained-turn outcome (mirrors the oracle harness's q2/q3 recording).
  const r2 = await queue.submit({ ...BASE, text: "second", queueable: true });
  const r3 = await queue.submit({ ...BASE, text: "third", queueable: true });
  expect(r2).toMatchObject({ ok: true, queued: true });
  expect(r3).toMatchObject({ ok: true, queued: true });

  resolveNext(); // finish "first" -> drain "second"
  await tick();
  // "second"'s turn fails (e.g. a transient bind failure inside SessionTurnRunner.run, which
  // never rejects — it always resolves ok:false) -> must still reach "third", not strand it.
  resolveNext({ ok: false, errorMessage: "transient bind failure" });
  await tick();
  expect(started).toEqual(["first", "second", "third"]);
  resolveNext(); // finish "third"
  await tick();

  await p1;
  expect(queue.queueLength("c", "s")).toBe(0);
  expect(queue.isBusy("c", "s")).toBe(false);
});

test("cancel-empties-queue (wedge #3): a cancel emptying the queue during hand-off clears draining", async () => {
  // Mirrors the golden fixture "cancel-empties-queue-clears-draining": the finally sets
  // `draining`, then awaits detectSessionsChanged. If that await cancels the only queued item,
  // advanceQueue's empty `else` branch must clear `draining` too, or the guard leaks and every
  // future submit enqueues forever.
  let queueItemId: string | undefined;
  let armCancel = false;
  const h = makeQueue({
    detectSessionsChanged: async () => {
      if (armCancel && queueItemId) {
        armCancel = false;
        h.queue.cancelQueuedItem("c", "s", queueItemId);
      }
    },
  });

  const p1 = h.queue.submit({ ...BASE, text: "first", queueable: true });
  await tick();
  const r2 = await h.queue.submit({ ...BASE, text: "second", queueable: true });
  queueItemId = (r2 as { queueItemId: string }).queueItemId;

  armCancel = true;
  // "first"'s result carries no postTurnDetection by default, so detectSessionsChanged would
  // never be called — force a detection by giving the resolved result a postTurnDetection.
  h.resolveNext({ ok: true, postTurnDetection: { internalAlias: "a", priorTransportSession: "t0" } });
  await tick();
  await p1;

  // A fresh submit must START a real turn (park on runTurn), not enqueue — proving draining
  // cleared and the cancelled "second" never ran.
  expect(h.queue.queueLength("c", "s")).toBe(0);
  expect(h.queue.isBusy("c", "s")).toBe(false);
  const after = h.queue.submit({ ...BASE, text: "after", queueable: true });
  await tick();
  expect(h.pendingCount()).toBe(1); // parked on runTurn, not resolved via queue
  expect(h.pendingReqs().at(-1)?.text).toBe("after");
  h.resolveNext();
  await after;
});

test("Stop-then-followup: a submit after cancelTurn waits (raceWithTimeout) then runs fresh", async () => {
  const { queue, pendingCount, resolveNext } = makeQueue();
  const first = queue.submit({ ...BASE, text: "long", queueable: true });
  await tick();
  expect(queue.cancelTurn("c", "s")).toBe(true); // aborts turn 1's controller; it stays in inFlight until settled
  const second = queue.submit({ ...BASE, text: "next", queueable: true }); // waits on settled via raceWithTimeout
  await tick();
  expect(pendingCount()).toBe(1); // "second" has NOT started a turn yet — it's parked on raceWithTimeout
  // Simulate teardown completing: turn 1's runTurn resolves ok:false (SessionTurnRunner.run
  // never rejects, even on abort) -> its finally resolves `settled`.
  resolveNext({ ok: false, errorMessage: "aborted" });
  await tick();
  expect(pendingCount()).toBe(1); // now "second" has started its own turn
  resolveNext();
  const [r1, r2] = await Promise.all([first, second]);
  expect(r1).toEqual({ ok: false, errorMessage: "aborted" });
  expect((r2 as TurnResult).ok).toBe(true);
});

test("watchdog: a turn silent past the idle timeout is aborted with TURN_IDLE_TIMEOUT_REASON", async () => {
  const q = makeQueue({ turnIdleTimeoutMs: () => 1000 });
  void q.queue.submit({ ...BASE, text: "A", queueable: true });
  const h = q.head()!;
  expect(q.idleArmed()).toBe(true);     // armed at submit
  q.fireIdle();                          // no activity → watchdog fires
  expect(h.signal.aborted).toBe(true);
  expect(h.signal.reason).toBe(TURN_IDLE_TIMEOUT_REASON);
});

test("watchdog: onActivity resets the timer (clears the old, arms a new one)", async () => {
  const q = makeQueue({ turnIdleTimeoutMs: () => 1000 });
  void q.queue.submit({ ...BASE, text: "A", queueable: true });
  const h = q.head()!;
  expect(q.setCount()).toBe(1);          // armed once at submit
  expect(q.clearCount()).toBe(0);
  h.onActivity!();                        // agent activity → clear old + arm new
  expect(q.clearCount()).toBe(1);
  expect(q.setCount()).toBe(2);
  expect(q.idleArmed()).toBe(true);
  expect(h.signal.aborted).toBe(false);  // not aborted — the deadline was pushed out
});

test("watchdog: turnIdleTimeoutMs 0 disables it (no timer armed)", async () => {
  const q = makeQueue({ turnIdleTimeoutMs: () => 0 });
  void q.queue.submit({ ...BASE, text: "A", queueable: true });
  expect(q.idleArmed()).toBe(false);
});

test("watchdog: the idle timer is cleared when the turn settles normally", async () => {
  const q = makeQueue({ turnIdleTimeoutMs: () => 1000 });
  void q.queue.submit({ ...BASE, text: "A", queueable: true });
  expect(q.idleArmed()).toBe(true);
  q.resolveNext({ ok: true });           // turn finishes
  await tick();
  expect(q.idleArmed()).toBe(false);     // no dangling timer
});

test("watchdog: absent turnIdleTimeoutMs dep = disabled (no timer, backward-compat)", async () => {
  const q = makeQueue();                 // no turnIdleTimeoutMs override
  void q.queue.submit({ ...BASE, text: "A", queueable: true });
  expect(q.idleArmed()).toBe(false);
});

test("watchdog lifecycle: a timed-out turn releases its slot and drains the queued head", async () => {
  const q = makeQueue({ turnIdleTimeoutMs: () => 1000 });
  void q.queue.submit({ ...BASE, text: "A", queueable: true });
  await tick();
  void q.queue.submit({ ...BASE, text: "B", queueable: true }); // enqueued behind the running A
  expect(q.queue.queueLength("c", "s")).toBe(1);
  const hA = q.head()!;
  q.fireIdle();                                    // A silent → its watchdog fires
  expect(hA.signal.reason).toBe(TURN_IDLE_TIMEOUT_REASON);
  // The runner (faked) resolves ok:false when its signal aborts — unwinds A's turn.
  q.resolveNext({ ok: false, errorMessage: "Turn timed out due to inactivity" });
  await tick();
  expect(q.started).toEqual(["A", "B"]);           // B drained only AFTER A's timeout freed the slot
  expect(q.queue.queueLength("c", "s")).toBe(0);
});

test("watchdog lifecycle: repeated activity across many windows keeps renewing (never aborts)", async () => {
  const q = makeQueue({ turnIdleTimeoutMs: () => 1000 });
  void q.queue.submit({ ...BASE, text: "A", queueable: true });
  const h = q.head()!;
  // Three activity beats, each clearing the prior timer and arming a fresh one. A mutation that
  // let only the FIRST activity reset the deadline would stop re-arming after beat 1.
  h.onActivity!();
  h.onActivity!();
  h.onActivity!();
  expect(q.setCount()).toBe(4);          // 1 arm at submit + 3 re-arms
  expect(q.clearCount()).toBe(3);        // each beat cleared the prior timer
  expect(q.idleArmed()).toBe(true);      // a live deadline is still pending
  expect(h.signal.aborted).toBe(false);  // never aborted — the deadline kept moving out
});

test("watchdog lifecycle: a drained head arms its OWN fresh watchdog", async () => {
  const q = makeQueue({ turnIdleTimeoutMs: () => 1000 });
  void q.queue.submit({ ...BASE, text: "A", queueable: true });
  await tick();
  void q.queue.submit({ ...BASE, text: "B", queueable: true }); // queued behind A
  q.resolveNext({ ok: true });           // A finishes normally → hands off / drains B
  await tick();
  expect(q.started).toEqual(["A", "B"]); // B is now the in-flight drained turn
  expect(q.idleArmed()).toBe(true);      // it armed its own timer (not inherited from A, which was cleared)
  const hB = q.head()!;
  q.fireIdle();                          // B silent → its independent watchdog fires
  expect(hB.signal.aborted).toBe(true);
  expect(hB.signal.reason).toBe(TURN_IDLE_TIMEOUT_REASON);
});

test("watchdog: onIdleTimeout fires with the concrete threshold when it reclaims a turn", async () => {
  const fired: Array<{ chatKey: string; sessionAlias: string; idleMs: number }> = [];
  const q = makeQueue({ turnIdleTimeoutMs: () => 1000, onIdleTimeout: (d) => fired.push(d) });
  void q.queue.submit({ ...BASE, text: "A", queueable: true });
  q.fireIdle();
  expect(fired).toEqual([{ chatKey: "c", sessionAlias: "s", idleMs: 1000 }]);
});

test("watchdog exactly-once: a late onActivity after the timeout fires neither re-arms nor re-logs", async () => {
  // The abort is cooperative, so a final agent event can still land AFTER the watchdog fired.
  // It must NOT arm a second timer or emit a second onIdleTimeout — the watchdog is one-shot.
  const fired: number[] = [];
  const q = makeQueue({ turnIdleTimeoutMs: () => 1000, onIdleTimeout: () => fired.push(1) });
  void q.queue.submit({ ...BASE, text: "A", queueable: true });
  const h = q.head()!;
  q.fireIdle();                       // watchdog fires: onIdleTimeout once + abort
  expect(fired.length).toBe(1);
  expect(h.signal.aborted).toBe(true);
  h.onActivity!();                    // a late event arrives during the cooperative unwind
  expect(q.idleArmed()).toBe(false); // it did NOT arm a second watchdog
  q.fireIdle();                       // and even a stray fire is a no-op
  expect(fired.length).toBe(1);      // still exactly once
});

test("watchdog: a throwing onIdleTimeout still aborts the turn (abort runs in finally)", async () => {
  // The observability hook is untrusted: if it throws, the wedged turn must STILL be aborted —
  // the abort lives in a `finally` around the hook. Moving it after the hook (out of finally)
  // would let a throwing observer strand the wedged turn forever.
  const q = makeQueue({
    turnIdleTimeoutMs: () => 1000,
    onIdleTimeout: () => { throw new Error("observer boom"); },
  });
  void q.queue.submit({ ...BASE, text: "A", queueable: true });
  const h = q.head()!;
  expect(() => q.fireIdle()).toThrow("observer boom"); // the hook throws out of the timer...
  expect(h.signal.aborted).toBe(true);                 // ...but the finally aborted first
  expect(h.signal.reason).toBe(TURN_IDLE_TIMEOUT_REASON);
});

test("watchdog: after a user Stop, a late onActivity does not re-arm or surface an idle timeout", async () => {
  // A user Stop aborts the controller with no reason. A final agent event arriving during the
  // unwind must NOT re-arm the watchdog (the `signal.aborted` guard) — otherwise the turn would
  // later be reported as an idle timeout, mislabelling a user cancel.
  const fired: number[] = [];
  const q = makeQueue({ turnIdleTimeoutMs: () => 1000, onIdleTimeout: () => fired.push(1) });
  void q.queue.submit({ ...BASE, text: "A", queueable: true });
  const h = q.head()!;
  expect(q.setCount()).toBe(1);                    // armed once at submit
  expect(q.queue.cancelTurn("c", "s")).toBe(true); // user Stop → controller aborted (no reason)
  h.onActivity!();                                 // a late agent event during the cooperative unwind
  expect(q.setCount()).toBe(1);                    // did NOT arm a second watchdog after the Stop
  q.fireIdle();                                    // firing the stale submit-time timer is a no-op
  expect(fired.length).toBe(0);                    // a Stop never surfaces as an idle timeout
});

test("watchdog: a turn whose external abortSignal is already aborted arms no watchdog", async () => {
  // The scheduled path links an external abortSignal; if it is already aborted at submit, the
  // controller aborts synchronously before armIdle runs, so the `signal.aborted` guard must keep
  // armIdle from arming a timer for an already-doomed turn.
  const pre = new AbortController();
  pre.abort();
  const q = makeQueue({ turnIdleTimeoutMs: () => 1000 });
  void q.queue.submit({ ...BASE, text: "A", queueable: true, abortSignal: pre.signal });
  expect(q.setCount()).toBe(0);      // armIdle short-circuited on the already-aborted controller
  expect(q.idleArmed()).toBe(false);
});
