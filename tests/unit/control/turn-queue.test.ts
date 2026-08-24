// tests/unit/control/turn-queue.test.ts
// White-box tests for TurnQueue: the three-state concurrency gate (inFlight/queues/draining)
// extracted out of ControlService.executeTurn. Drives TurnQueue directly with a controllable
// fake runTurn — no ControlService, no SessionTurnRunner, no sessions dependency (TurnQueue is
// session-free by design; the sessions-changed compare is threaded in via
// deps.detectSessionsChanged).
import { expect, test } from "bun:test";
import { TurnQueue, type TurnQueueDeps } from "../../../src/control/turn-queue";
import type {
  TurnRequest,
  TurnResult,
} from "../../../src/control/session-turn-runner";
import {
  QUEUE_MAX_DEPTH,
  TURN_IDLE_TIMEOUT_REASON,
} from "../../../src/control/turn-support";

// Wires a TurnQueue to a controllable deferred runTurn. `runTurn` records each turn's text into
// `started` (so drain-order tests can assert it) and parks on a pending promise the test resolves
// by hand via `resolveNext`. Deps default to no-ops; pass `overrides` to inject behavior (e.g. a
// detectSessionsChanged that cancels a queued item). Models SessionTurnRunner.run's real
// contract: it never rejects — it always resolves with a TurnResult (ok:false + errorMessage on
// failure), so there is no reject path to fake.
function makeQueue(overrides?: Partial<TurnQueueDeps>) {
  const started: string[] = [];
  const pending: Array<{
    req: TurnRequest;
    resolve: (r: TurnResult) => void;
    signal: AbortSignal;
    onActivity?: () => void;
  }> = [];
  // Single-slot fake idle timer (the watchdog arms at most one live timer per turn),
  // with call counters so a reset (clear old + arm new) is observable.
  let idleFn: (() => void) | null = null;
  let setCount = 0;
  let clearCount = 0;
  const setTimer = (fn: () => void, _ms: number): unknown => {
    idleFn = fn;
    setCount++;
    return 1;
  };
  const clearTimer = (_id: unknown) => {
    idleFn = null;
    clearCount++;
  };
  const queue = new TurnQueue({
    runTurn: (
      req: TurnRequest,
      signal: AbortSignal,
      onActivity?: () => void,
    ) => {
      started.push(req.text);
      return new Promise<TurnResult>((resolve) =>
        pending.push({ req, resolve, signal, onActivity }),
      );
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
    fireIdle: () => {
      const fn = idleFn;
      idleFn = null;
      fn?.();
    },
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

test("a queued prompt carries promptRequestId onto the drained turn-started", async () => {
  const { queue, pendingReqs, resolveNext } = makeQueue();
  const p1 = queue.submit({ ...BASE, text: "first", queueable: true });
  await tick();
  await queue.submit({
    ...BASE,
    text: "second",
    queueable: true,
    promptRequestId: "req-1",
  });
  expect(queue.queueLength("c", "s")).toBe(1);
  resolveNext(); // first turn finishes → drains the queue head
  await p1; // p1 settles only after the drain hand-off (drained submit registered)
  await tick();
  const drained = pendingReqs()[0]?.turnStarted;
  expect(drained).toMatchObject({ prompt: "second", promptRequestId: "req-1" });
  expect(drained?.queueItemId).toBeString();
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
  h.resolveNext({
    ok: true,
    postTurnDetection: { internalAlias: "a", priorTransportSession: "t0" },
  });
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
  expect(q.idleArmed()).toBe(true); // armed at submit
  q.fireIdle(); // no activity → watchdog fires
  expect(h.signal.aborted).toBe(true);
  expect(h.signal.reason).toBe(TURN_IDLE_TIMEOUT_REASON);
});

test("watchdog: onActivity resets the timer (clears the old, arms a new one)", async () => {
  const q = makeQueue({ turnIdleTimeoutMs: () => 1000 });
  void q.queue.submit({ ...BASE, text: "A", queueable: true });
  const h = q.head()!;
  expect(q.setCount()).toBe(1); // armed once at submit
  expect(q.clearCount()).toBe(0);
  h.onActivity!(); // agent activity → clear old + arm new
  expect(q.clearCount()).toBe(1);
  expect(q.setCount()).toBe(2);
  expect(q.idleArmed()).toBe(true);
  expect(h.signal.aborted).toBe(false); // not aborted — the deadline was pushed out
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
  q.resolveNext({ ok: true }); // turn finishes
  await tick();
  expect(q.idleArmed()).toBe(false); // no dangling timer
});

test("watchdog: absent turnIdleTimeoutMs dep = disabled (no timer, backward-compat)", async () => {
  const q = makeQueue(); // no turnIdleTimeoutMs override
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
  q.fireIdle(); // A silent → its watchdog fires
  expect(hA.signal.reason).toBe(TURN_IDLE_TIMEOUT_REASON);
  // The runner (faked) resolves ok:false when its signal aborts — unwinds A's turn.
  q.resolveNext({
    ok: false,
    errorMessage: "Turn timed out due to inactivity",
  });
  await tick();
  expect(q.started).toEqual(["A", "B"]); // B drained only AFTER A's timeout freed the slot
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
  expect(q.setCount()).toBe(4); // 1 arm at submit + 3 re-arms
  expect(q.clearCount()).toBe(3); // each beat cleared the prior timer
  expect(q.idleArmed()).toBe(true); // a live deadline is still pending
  expect(h.signal.aborted).toBe(false); // never aborted — the deadline kept moving out
});

test("watchdog lifecycle: a drained head arms its OWN fresh watchdog", async () => {
  const q = makeQueue({ turnIdleTimeoutMs: () => 1000 });
  void q.queue.submit({ ...BASE, text: "A", queueable: true });
  await tick();
  void q.queue.submit({ ...BASE, text: "B", queueable: true }); // queued behind A
  q.resolveNext({ ok: true }); // A finishes normally → hands off / drains B
  await tick();
  expect(q.started).toEqual(["A", "B"]); // B is now the in-flight drained turn
  expect(q.idleArmed()).toBe(true); // it armed its own timer (not inherited from A, which was cleared)
  const hB = q.head()!;
  q.fireIdle(); // B silent → its independent watchdog fires
  expect(hB.signal.aborted).toBe(true);
  expect(hB.signal.reason).toBe(TURN_IDLE_TIMEOUT_REASON);
});

test("watchdog: onIdleTimeout fires with the concrete threshold when it reclaims a turn", async () => {
  const fired: Array<{
    chatKey: string;
    sessionAlias: string;
    idleMs: number;
  }> = [];
  const q = makeQueue({
    turnIdleTimeoutMs: () => 1000,
    onIdleTimeout: (d) => fired.push(d),
  });
  void q.queue.submit({ ...BASE, text: "A", queueable: true });
  q.fireIdle();
  expect(fired).toEqual([{ chatKey: "c", sessionAlias: "s", idleMs: 1000 }]);
});

test("watchdog exactly-once: a late onActivity after the timeout fires neither re-arms nor re-logs", async () => {
  // The abort is cooperative, so a final agent event can still land AFTER the watchdog fired.
  // It must NOT arm a second timer or emit a second onIdleTimeout — the watchdog is one-shot.
  const fired: number[] = [];
  const q = makeQueue({
    turnIdleTimeoutMs: () => 1000,
    onIdleTimeout: () => fired.push(1),
  });
  void q.queue.submit({ ...BASE, text: "A", queueable: true });
  const h = q.head()!;
  q.fireIdle(); // watchdog fires: onIdleTimeout once + abort
  expect(fired.length).toBe(1);
  expect(h.signal.aborted).toBe(true);
  h.onActivity!(); // a late event arrives during the cooperative unwind
  expect(q.idleArmed()).toBe(false); // it did NOT arm a second watchdog
  q.fireIdle(); // and even a stray fire is a no-op
  expect(fired.length).toBe(1); // still exactly once
});

test("watchdog: a throwing onIdleTimeout still aborts the turn (abort runs in finally)", async () => {
  // The observability hook is untrusted: if it throws, the wedged turn must STILL be aborted —
  // the abort lives in a `finally` around the hook. Moving it after the hook (out of finally)
  // would let a throwing observer strand the wedged turn forever.
  const q = makeQueue({
    turnIdleTimeoutMs: () => 1000,
    onIdleTimeout: () => {
      throw new Error("observer boom");
    },
  });
  void q.queue.submit({ ...BASE, text: "A", queueable: true });
  const h = q.head()!;
  expect(() => q.fireIdle()).toThrow("observer boom"); // the hook throws out of the timer...
  expect(h.signal.aborted).toBe(true); // ...but the finally aborted first
  expect(h.signal.reason).toBe(TURN_IDLE_TIMEOUT_REASON);
});

test("watchdog: after a user Stop, a late onActivity does not re-arm or surface an idle timeout", async () => {
  // A user Stop aborts the controller with no reason. A final agent event arriving during the
  // unwind must NOT re-arm the watchdog (the `signal.aborted` guard) — otherwise the turn would
  // later be reported as an idle timeout, mislabelling a user cancel.
  const fired: number[] = [];
  const q = makeQueue({
    turnIdleTimeoutMs: () => 1000,
    onIdleTimeout: () => fired.push(1),
  });
  void q.queue.submit({ ...BASE, text: "A", queueable: true });
  const h = q.head()!;
  expect(q.setCount()).toBe(1); // armed once at submit
  expect(q.queue.cancelTurn("c", "s")).toBe(true); // user Stop → controller aborted (no reason)
  h.onActivity!(); // a late agent event during the cooperative unwind
  expect(q.setCount()).toBe(1); // did NOT arm a second watchdog after the Stop
  q.fireIdle(); // firing the stale submit-time timer is a no-op
  expect(fired.length).toBe(0); // a Stop never surfaces as an idle timeout
});

test("watchdog: a turn whose external abortSignal is already aborted arms no watchdog", async () => {
  // The scheduled path links an external abortSignal; if it is already aborted at submit, the
  // controller aborts synchronously before armIdle runs, so the `signal.aborted` guard must keep
  // armIdle from arming a timer for an already-doomed turn.
  const pre = new AbortController();
  pre.abort();
  const q = makeQueue({ turnIdleTimeoutMs: () => 1000 });
  void q.queue.submit({
    ...BASE,
    text: "A",
    queueable: true,
    abortSignal: pre.signal,
  });
  expect(q.setCount()).toBe(0); // armIdle short-circuited on the already-aborted controller
  expect(q.idleArmed()).toBe(false);
});

test("queue depth cap: the submit that would exceed QUEUE_MAX_DEPTH rejects with queue-full", async () => {
  const { queue, resolveNext } = makeQueue();
  const p1 = queue.submit({ ...BASE, text: "running", queueable: true });
  await tick();
  for (let i = 0; i < QUEUE_MAX_DEPTH; i++) {
    const r = await queue.submit({ ...BASE, text: `q${i}`, queueable: true });
    expect(r).toMatchObject({ ok: true, queued: true });
  }
  const overflow = await queue.submit({
    ...BASE,
    text: "overflow",
    queueable: true,
  });
  expect(overflow).toEqual({ ok: false, errorMessage: "queue-full" });
  expect(queue.queueLength("c", "s")).toBe(QUEUE_MAX_DEPTH);
  // Drain one item — the queue is below the cap again, so the next submit enqueues.
  resolveNext();
  await tick();
  const afterDrain = await queue.submit({
    ...BASE,
    text: "fits-now",
    queueable: true,
  });
  expect(afterDrain).toMatchObject({ ok: true, queued: true });
  for (let i = 0; i <= QUEUE_MAX_DEPTH; i++) {
    resolveNext();
    await tick();
  }
  await p1;
});

test("clearSession drops queued prompts, aborts the running turn, and starts no drained turn", async () => {
  const emitted: Array<Array<{ id: string }>> = [];
  const h = makeQueue({
    emitQueueUpdated: (_chatKey, _sessionAlias, items) => emitted.push(items),
  });
  const p1 = h.queue.submit({ ...BASE, text: "running", queueable: true });
  await tick();
  await h.queue.submit({ ...BASE, text: "queued-1", queueable: true });
  await h.queue.submit({ ...BASE, text: "queued-2", queueable: true });
  expect(h.queue.queueLength("c", "s")).toBe(2);
  const runningSignal = h.head()!.signal;

  const cleared = h.queue.clearSession("c", "s");
  // Synchronous part: queue emptied (badge cleared) and running turn aborted.
  expect(h.queue.queueLength("c", "s")).toBe(0);
  expect(emitted.at(-1)).toEqual([]);
  expect(runningSignal.aborted).toBe(true);

  // clearSession resolves only after the aborted turn unwinds (settled).
  h.resolveNext({ ok: false, errorMessage: "aborted" });
  expect(await cleared).toEqual({ cleared: true });
  await p1;
  await tick();
  expect(h.started).toEqual(["running"]); // neither queued item started a drained turn
  expect(h.queue.isBusy("c", "s")).toBe(false);
});

test("clearSession on an idle session with an empty queue is a no-op", async () => {
  const emitted: unknown[] = [];
  const { queue } = makeQueue({
    emitQueueUpdated: (_c, _s, items) => emitted.push(items),
  });
  expect(await queue.clearSession("c", "s")).toEqual({ cleared: true });
  expect(emitted).toEqual([]); // no spurious queue-updated for a session that had nothing
  expect(queue.isBusy("c", "s")).toBe(false);
});

test("clearSession reports cleared:false when the aborted turn outlives the drain timeout", async () => {
  const h = makeQueue({ cancelDrainTimeoutMs: 20 });
  const p1 = h.queue.submit({ ...BASE, text: "wedged", queueable: true });
  await tick();
  await h.queue.submit({ ...BASE, text: "queued", queueable: true });

  // The turn never settles within the (shortened) timeout — the caller must not delete.
  expect(await h.queue.clearSession("c", "s")).toEqual({ cleared: false });
  expect(h.queue.queueLength("c", "s")).toBe(0); // queued prompts still dropped

  // Once the wedged turn finally unwinds, a retry succeeds.
  h.resolveNext({ ok: false, errorMessage: "aborted" });
  await p1;
  expect(await h.queue.clearSession("c", "s")).toEqual({ cleared: true });
});

test("clearSession arms a teardown guard that rejects new turns until finishClear", async () => {
  const { queue, started } = makeQueue();
  // Idle session -> cleared, guard armed.
  expect(await queue.clearSession("c", "s")).toEqual({ cleared: true });
  expect(queue.isBusy("c", "s")).toBe(false); // guard is not surfaced via isBusy

  // A non-queueable (scheduled) submit must be rejected while the guard holds — it must not
  // cold-start a turn on the session being torn down.
  const rejected = await queue.submit({ ...BASE, text: "scheduled" });
  expect(rejected).toEqual({ ok: false, errorMessage: "turn-already-running" });
  expect(started).toEqual([]); // runTurn never invoked under the guard

  // Releasing the guard makes the session usable again.
  queue.finishClear("c", "s");
  void queue.submit({ ...BASE, text: "after", queueable: true });
  await tick();
  expect(started).toEqual(["after"]);
});

test("queued prompt preserves full execution context and all metadata fields when drained into runTurn", async () => {
  let drainedReq: unknown;
  const h = makeQueue();
  const origRun = (h.queue as unknown as { deps: { runTurn: (req: unknown, sig: unknown, act: unknown) => Promise<unknown> } }).deps.runTurn;
  (h.queue as unknown as { deps: { runTurn: (req: unknown, sig: unknown, act: unknown) => Promise<unknown> } }).deps.runTurn = async (req, sig, act) => {
    drainedReq = req;
    return await origRun(req as never, sig as never, act as never);
  };

  const p1 = h.queue.submit({
    chatKey: "relay:chat-user",
    sessionAlias: "backend",
    concurrencyKey: "relay:backend",
    senderId: "bob",
    text: "first",
    queueable: true,
  });
  await tick();

  const fullMetadata = {
    chatKey: "relay:chat-user",
    sessionAlias: "backend",
    boundSessionAlias: "relay:backend",
    concurrencyKey: "relay:backend",
    text: "second",
    senderId: "alice",
    isOwner: true,
    accountId: "acct-999",
    preserveCoordinatorRoute: true,
    media: [{ id: "m1", kind: "image" as const, filePath: "/tmp/img.png", mimeType: "image/png", size: 100 }],
    agentMentions: [{ range: [0, 8] as [number, number], handle: "agent:node:ep1" }],
    promptRequestId: "req-12345",
    queueable: true,
  };

  const p2 = h.queue.submit(fullMetadata);
  expect(h.queue.queueLength("relay:chat-user", "backend", "relay:backend")).toBe(1);
  h.resolveNext();
  await p1;
  await tick();
  h.resolveNext();
  await p2;

  expect(drainedReq).toMatchObject({
    chatKey: "relay:chat-user",
    sessionAlias: "backend",
    boundSessionAlias: "relay:backend",
    text: "second",
    senderId: "alice",
    isOwner: true,
    accountId: "acct-999",
    preserveCoordinatorRoute: true,
    media: [{ id: "m1", kind: "image", filePath: "/tmp/img.png", mimeType: "image/png", size: 100 }],
    agentMentions: [{ range: [0, 8], handle: "agent:node:ep1" }],
    turnStarted: {
      prompt: "second",
      promptRequestId: "req-12345",
    },
  });
});
test("Phase 6: busy target with peer request R1 and human prompt preserves FIFO drain order and exact peerOrigin", async () => {
  const h = makeQueue();
  let drainedRequests: any[] = [];
  const origRun = (h.queue as any).deps.runTurn;
  (h.queue as any).deps.runTurn = async (req: any, sig: any, act: any) => {
    drainedRequests.push(req);
    return await origRun(req, sig, act);
  };

  const peerOriginR1 = {
    requestMessageId: "msg_r1",
    completion: "none" as const,
    source: { nodeId: "node-a", endpointId: "agent-a" },
    target: { nodeId: "node-b", endpointId: "agent-b" },
  };

  // 1. Start running a human prompt
  const p1 = h.queue.submit({
    chatKey: "relay:chat-user",
    sessionAlias: "backend",
    concurrencyKey: "relay:backend",
    senderId: "human-user",
    text: "human 1",
    queueable: true,
  });
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(h.pendingCount()).toBe(1);

  // 2. Peer request R1 arrives while busy → queued
  const r1Res = h.queue.submitPeerTurn({
    chatKey: "relay:chat-user",
    sessionAlias: "backend",
    boundSessionAlias: "relay:backend",
    concurrencyKey: "relay:backend",
    text: "<xacpx-message>r1</xacpx-message>",
    senderId: "agent-messaging",
    promptRequestId: "msg_r1",
    peerOrigin: peerOriginR1,
  });
  expect(r1Res).toEqual({ status: "queued" });
  expect(h.queue.queueLength("relay:chat-user", "backend", "relay:backend")).toBe(1);

  // 3. Another human prompt arrives while busy → queued
  const p3 = h.queue.submit({
    chatKey: "relay:chat-user",
    sessionAlias: "backend",
    concurrencyKey: "relay:backend",
    senderId: "human-user",
    text: "human 2",
    queueable: true,
  });
  expect(h.queue.queueLength("relay:chat-user", "backend", "relay:backend")).toBe(2);

  // Drain 1st (human 1)
  h.resolveNext();
  await p1;
  await new Promise((resolve) => setTimeout(resolve, 0));

  // Now R1 should be running as the drained head
  expect(h.pendingCount()).toBe(1);
  expect(drainedRequests.length).toBe(2);
  expect(drainedRequests[0].text).toBe("human 1");
  expect(drainedRequests[0].peerOrigin).toBeUndefined();

  expect(drainedRequests[1].text).toBe("<xacpx-message>r1</xacpx-message>");
  expect(drainedRequests[1].peerOrigin).toEqual(peerOriginR1);
  expect(drainedRequests[1].turnStarted.prompt).toBeUndefined(); // peer prompt masked
  expect(drainedRequests[1].turnStarted.promptRequestId).toBe("msg_r1");

  // Drain 2nd (R1)
  h.resolveNext();
  await new Promise((resolve) => setTimeout(resolve, 0));

  // Now human 2 should be running
  expect(h.pendingCount()).toBe(1);
  expect(drainedRequests.length).toBe(3);
  expect(drainedRequests[2].text).toBe("human 2");
  expect(drainedRequests[2].peerOrigin).toBeUndefined();
  expect(drainedRequests[2].turnStarted.prompt).toBe("human 2"); // human prompt unmasked

  // Drain 3rd (human 2)
  h.resolveNext();
  await p3;
  expect(h.started).toEqual(["human 1", "<xacpx-message>r1</xacpx-message>", "human 2"]);
});

test("Phase 6: multiple queued peer requests R1 and R2 maintain exact peerOrigin without cross-assignment", async () => {
  const h = makeQueue();
  let drainedRequests: any[] = [];
  const origRun = (h.queue as any).deps.runTurn;
  (h.queue as any).deps.runTurn = async (req: any, sig: any, act: any) => {
    drainedRequests.push(req);
    return await origRun(req, sig, act);
  };

  const peerOriginR1 = {
    requestMessageId: "msg_r1",
    completion: "none" as const,
    source: { nodeId: "node-a", endpointId: "agent-a" },
    target: { nodeId: "node-b", endpointId: "agent-b" },
  };
  const peerOriginR2 = {
    requestMessageId: "msg_r2",
    completion: "notify" as const,
    source: { nodeId: "node-c", endpointId: "agent-c" },
    target: { nodeId: "node-b", endpointId: "agent-b" },
  };

  // Start turn 1
  const p1 = h.queue.submit({
    chatKey: "relay:chat-user",
    sessionAlias: "backend",
    concurrencyKey: "relay:backend",
    senderId: "user",
    text: "first",
    queueable: true,
  });
  await new Promise((resolve) => setTimeout(resolve, 0));

  // Queue R1 and R2
  h.queue.submitPeerTurn({
    chatKey: "relay:chat-user",
    sessionAlias: "backend",
    concurrencyKey: "relay:backend",
    text: "r1",
    senderId: "agent-messaging",
    promptRequestId: "msg_r1",
    peerOrigin: peerOriginR1,
  });
  h.queue.submitPeerTurn({
    chatKey: "relay:chat-user",
    sessionAlias: "backend",
    concurrencyKey: "relay:backend",
    text: "r2",
    senderId: "agent-messaging",
    promptRequestId: "msg_r2",
    peerOrigin: peerOriginR2,
  });

  expect(h.queue.queueLength("relay:chat-user", "backend", "relay:backend")).toBe(2);

  h.resolveNext();
  await p1;
  await new Promise((resolve) => setTimeout(resolve, 0));

  expect(drainedRequests[1].peerOrigin).toEqual(peerOriginR1);
  expect(drainedRequests[1].peerOrigin.requestMessageId).toBe("msg_r1");

  h.resolveNext();
  await new Promise((resolve) => setTimeout(resolve, 0));

  expect(drainedRequests[2].peerOrigin).toEqual(peerOriginR2);
  expect(drainedRequests[2].peerOrigin.requestMessageId).toBe("msg_r2");

  h.resolveNext();
});

test("Phase 6: cross-session concurrency isolates peerOrigin per session lane", async () => {
  const h = makeQueue();
  let drainedRequests: any[] = [];
  const origRun = (h.queue as any).deps.runTurn;
  (h.queue as any).deps.runTurn = async (req: any, sig: any, act: any) => {
    drainedRequests.push(req);
    return await origRun(req, sig, act);
  };

  const peerOriginS1 = {
    requestMessageId: "msg_s1",
    completion: "none" as const,
    source: { nodeId: "node-1", endpointId: "ep-1" },
    target: { nodeId: "node-target", endpointId: "session-1" },
  };
  const peerOriginS2 = {
    requestMessageId: "msg_s2",
    completion: "result" as const,
    source: { nodeId: "node-2", endpointId: "ep-2" },
    target: { nodeId: "node-target", endpointId: "session-2" },
  };

  // Submit on session 1
  h.queue.submitPeerTurn({
    chatKey: "relay:s1",
    sessionAlias: "session-1",
    concurrencyKey: "session-1",
    text: "turn s1",
    senderId: "agent-messaging",
    peerOrigin: peerOriginS1,
  });

  // Submit on session 2
  h.queue.submitPeerTurn({
    chatKey: "relay:s2",
    sessionAlias: "session-2",
    concurrencyKey: "session-2",
    text: "turn s2",
    senderId: "agent-messaging",
    peerOrigin: peerOriginS2,
  });

  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(h.pendingCount()).toBe(2);

  const req1 = drainedRequests.find((r) => r.sessionAlias === "session-1");
  const req2 = drainedRequests.find((r) => r.sessionAlias === "session-2");

  expect(req1?.peerOrigin).toEqual(peerOriginS1);
  expect(req2?.peerOrigin).toEqual(peerOriginS2);

  h.resolveNext();
  h.resolveNext();
});

test("Phase 6: injected peer turn on idle target attaches peerOrigin directly", async () => {
  const h = makeQueue();
  let capturedReq: any = null;
  const origRun = (h.queue as any).deps.runTurn;
  (h.queue as any).deps.runTurn = async (req: any, sig: any, act: any) => {
    capturedReq = req;
    return await origRun(req, sig, act);
  };

  const peerOrigin = {
    requestMessageId: "msg_idle",
    completion: "none" as const,
    source: { nodeId: "node-a", endpointId: "agent-a" },
    target: { nodeId: "node-b", endpointId: "agent-b" },
  };

  const res = h.queue.submitPeerTurn({
    chatKey: "relay:idle",
    sessionAlias: "backend",
    concurrencyKey: "relay:backend",
    text: "immediate peer prompt",
    senderId: "agent-messaging",
    promptRequestId: "msg_idle",
    peerOrigin,
  });

  expect(res).toEqual({ status: "injected" });
  await new Promise((resolve) => setTimeout(resolve, 0));

  expect(capturedReq).toMatchObject({
    sessionAlias: "backend",
    text: "immediate peer prompt",
    peerOrigin,
  });

  h.resolveNext();
});


test("Round-6 (request-id admission dedupe): same-promptRequestId peer retry is absorbed as injected — no second turn", async () => {
  const h = makeQueue();
  const executedRequests: Array<{ text: string; turnStarted?: { promptRequestId?: string } }> = [];
  const origRun = (h.queue as any).deps.runTurn;
  (h.queue as any).deps.runTurn = async (req: any, sig: any, act: any) => {
    executedRequests.push(req);
    return await origRun(req, sig, act);
  };

  const params = {
    chatKey: "relay:source-lane",
    sessionAlias: "source-lane",
    concurrencyKey: "source-lane",
    text: "",
    senderId: "agent-messaging",
    promptRequestId: "msg_dedupe_1",
    isPeerMessage: true,
    allowRestoreArchived: false,
  };

  // First admission on an idle session → injected, turn runs.
  const first = h.queue.submitPeerTurn(params);
  expect(first.status).toBe("injected");
  await tick();
  expect(executedRequests).toHaveLength(1);

  // Retry while the completion turn is IN FLIGHT → absorbed idempotently.
  const retryInFlight = h.queue.submitPeerTurn(params);
  expect(retryInFlight.status).toBe("injected");
  expect(h.queue.queueLength("relay:source-lane", "source-lane")).toBe(0);

  h.resolveNext({ ok: true, text: "done" });
  await tick();

  // Exactly ONE turn ran for this request id.
  expect(executedRequests).toHaveLength(1);
});

test("B1 (settled request-id tombstone): after the first completion turn RESOLVES, a same-requestId retry produces no second runTurn", async () => {
  const h = makeQueue();
  const executedRequests: Array<{ text: string }> = [];
  const origRun = (h.queue as any).deps.runTurn;
  (h.queue as any).deps.runTurn = async (req: any, sig: any, act: any) => {
    executedRequests.push(req);
    return await origRun(req, sig, act);
  };

  const params = {
    chatKey: "relay:source-lane",
    sessionAlias: "source-lane",
    concurrencyKey: "source-lane",
    text: "",
    senderId: "agent-messaging",
    promptRequestId: "msg_b1_tombstone",
    isPeerMessage: true,
    allowRestoreArchived: false,
  };

  // First admission + full resolution of runTurn.
  const first = h.queue.submitPeerTurn(params);
  expect(first.status).toBe("injected");
  h.resolveNext({ ok: true, text: "done" });
  await tick();
  expect(executedRequests).toHaveLength(1);

  // Late target retry AFTER the first turn settled: absorbed by the settled
  // request-id tombstone — no second turn, no queue growth.
  const retry = h.queue.submitPeerTurn(params);
  expect(retry.status).toBe("injected");
  await tick();
  expect(executedRequests).toHaveLength(1);
  expect(h.queue.queueLength("relay:source-lane", "source-lane")).toBe(0);

  h.resolveNext({ ok: true, text: "ignored" });
});

test("B1 (aborted-but-unsettled predecessor): completion X is NOT false-injected and NOT tombstone-poisoned; exactly one X turn runs after unwind", async () => {
  const h = makeQueue();
  const executedRequests: Array<{ text: string }> = [];
  const origRun = (h.queue as any).deps.runTurn;
  (h.queue as any).deps.runTurn = async (req: any, sig: any, act: any) => {
    executedRequests.push(req);
    return await origRun(req, sig, act);
  };

  // Running turn on the lane.
  const p1 = h.queue.submit({
    chatKey: "relay:abort-lane",
    sessionAlias: "abort-lane",
    concurrencyKey: "abort-lane",
    text: "running",
    senderId: "user",
    queueable: true,
    isPeerMessage: false,
    allowRestoreArchived: false,
  });
  await tick();

  // Abort the live turn but keep its runTurn UNRESOLVED (Stop unwinding).
  const entry = (h.queue as any).inFlight.get("abort-lane") as {
    controller: AbortController;
  };
  expect(entry).toBeDefined();
  entry.controller.abort();

  // Completion X arrives in the aborted-but-unsettled window.
  const x = h.queue.submitPeerTurn({
    chatKey: "relay:abort-lane",
    sessionAlias: "abort-lane",
    concurrencyKey: "abort-lane",
    text: "request X",
    senderId: "agent-messaging",
    promptRequestId: "msg_b1_abort_window",
    isPeerMessage: true,
    allowRestoreArchived: false,
  });
  // Synchronous admission only: X must be QUEUED (never a false injected).
  expect(x).toEqual({ status: "queued" });

  // The predecessor unwinds.
  h.resolveNext({ ok: false, cancelled: true });
  await p1;

  // Drain until X executes — exactly one X turn, no duplicates.
  let guard = 0;
  while (executedRequests.every((r) => r.text !== "request X") && guard++ < 50) {
    h.resolveNext({ ok: true, text: "x ran" });
    await tick();
  }
  expect(
    executedRequests.filter((r) => r.text === "request X"),
  ).toHaveLength(1);
});

test("B2-1 (cancelQueuedItem): a queued peer completion=result item cancelled before start resolves its contract exactly once and never executes", async () => {
  const cancelled: Array<{ peerOrigin: unknown; promptRequestId?: string }> = [];
  const h = makeQueue({
    cancelDrainTimeoutMs: 10,
    onQueuedPeerCancelled: (detail) => cancelled.push(detail),
  });
  const executedRequests: Array<{ text: string }> = [];
  const origRun = (h.queue as any).deps.runTurn;
  (h.queue as any).deps.runTurn = async (req: any, sig: any, act: any) => {
    executedRequests.push(req);
    return await origRun(req, sig, act);
  };

  const peerOrigin = {
    requestMessageId: "msg_b2_cancel",
    completion: "result",
    source: { nodeId: "n", endpointId: "src" },
    target: { nodeId: "n", endpointId: "tgt" },
  };

  // Running turn A keeps the lane busy; the completion-bearing B queues.
  const p1 = h.queue.submit({
    chatKey: "relay:b2-lane",
    sessionAlias: "b2-lane",
    concurrencyKey: "b2-lane",
    text: "turn A",
    senderId: "user",
    queueable: true,
    isPeerMessage: false,
    allowRestoreArchived: false,
  });
  await tick();
  const admission = h.queue.submitPeerTurn({
    chatKey: "relay:b2-lane",
    sessionAlias: "b2-lane",
    concurrencyKey: "b2-lane",
    text: "request B",
    senderId: "agent-messaging",
    promptRequestId: "msg_b2_cancel",
    isPeerMessage: true,
    allowRestoreArchived: false,
    peerOrigin,
  });
  expect(admission.status).toBe("queued");

  // Snapshot the queue to find B's item id, then cancel it pre-start.
  const q = (h.queue as any).queues.get("b2-lane") as Array<{ id: string }>;
  const itemId = q.find(() => true)!.id;
  expect(h.queue.cancelQueuedItem("relay:b2-lane", "b2-lane", itemId, "b2-lane")).toEqual({ cancelled: true });

  // Exactly ONE terminal cancellation carries B's contract.
  expect(cancelled).toHaveLength(1);
  expect(cancelled[0]!.peerOrigin).toEqual(peerOrigin);
  expect(cancelled[0]!.promptRequestId).toBe("msg_b2_cancel");

  // A unwinds; B NEVER executes.
  h.resolveNext({ ok: true, text: "A done" });
  await p1;
  await tick();
  await tick();
  expect(executedRequests.filter((r) => r.text === "request B")).toHaveLength(0);
  // And no late duplicate cancellation from the drain of an empty queue.
  expect(cancelled).toHaveLength(1);
});

test("B2-2 (clearSession/archive): queued peer completion=result items dropped by clearSession resolve their contracts exactly once", async () => {
  const cancelled: Array<{ peerOrigin: unknown }> = [];
  const h = makeQueue({
    cancelDrainTimeoutMs: 10,
    onQueuedPeerCancelled: (detail) => cancelled.push(detail),
  });

  const peerOrigin = {
    requestMessageId: "msg_b2_clear",
    completion: "result",
    source: { nodeId: "n", endpointId: "src" },
    target: { nodeId: "n", endpointId: "tgt" },
  };

  const p1 = h.queue.submit({
    chatKey: "relay:b2c-lane",
    sessionAlias: "b2c-lane",
    concurrencyKey: "b2c-lane",
    text: "turn A",
    senderId: "user",
    queueable: true,
    isPeerMessage: false,
    allowRestoreArchived: false,
  });
  await tick();
  const admission = h.queue.submitPeerTurn({
    chatKey: "relay:b2c-lane",
    sessionAlias: "b2c-lane",
    concurrencyKey: "b2c-lane",
    text: "request B",
    senderId: "agent-messaging",
    promptRequestId: "msg_b2_clear",
    isPeerMessage: true,
    allowRestoreArchived: false,
    peerOrigin,
  });
  expect(admission.status).toBe("queued");

  // Archive/teardown clears the session — the queued peer item is dropped.
  await h.queue.clearSession("relay:b2c-lane", "b2c-lane", "b2c-lane");
  h.resolveNext({ ok: false, cancelled: true });
  await p1;
  h.queue.finishClear("relay:b2c-lane", "b2c-lane", "b2c-lane");

  // Exactly ONE terminal cancellation, carrying the contract.
  expect(cancelled).toHaveLength(1);
  expect(cancelled[0]!.peerOrigin).toEqual(peerOrigin);
});

test("B1a (tombstone admission ordering): queue-full rejection does NOT poison the request id — retry after capacity frees gets a real turn", async () => {
  const h = makeQueue();
  const executedRequests: Array<{ text: string }> = [];
  const origRun = (h.queue as any).deps.runTurn;
  (h.queue as any).deps.runTurn = async (req: any, sig: any, act: any) => {
    executedRequests.push(req);
    return await origRun(req, sig, act);
  };

  // One live turn + a FULL queue on the lane.
  const fill = (id: string) => ({
    chatKey: "relay:poison-lane",
    sessionAlias: "poison-lane",
    concurrencyKey: "poison-lane",
    text: `filler ${id}`,
    senderId: "user",
    queueable: true,
    isPeerMessage: false,
    allowRestoreArchived: false,
  });
  // submit() settles only when the TURN settles — park the live one.
  const pLive = h.queue.submit(fill("live"));
  await tick();
  expect(h.queue.isBusy("relay:poison-lane", "poison-lane", "poison-lane")).toBe(true);
  for (let i = 0; i < QUEUE_MAX_DEPTH; i++) {
    expect(await h.queue.submit(fill(`q${i}`))).toMatchObject({ ok: true, queued: true });
  }

  // X arrives against the full lane: rejected queue-full — the tombstone
  // must NOT be recorded for a rejected admission.
  const x = h.queue.submitPeerTurn({
    chatKey: "relay:poison-lane",
    sessionAlias: "poison-lane",
    concurrencyKey: "poison-lane",
    text: "request X",
    senderId: "agent-messaging",
    promptRequestId: "msg_b1a_reject_then_retry",
    isPeerMessage: true,
    allowRestoreArchived: false,
  });
  expect(x).toEqual({ status: "rejected", reason: "queue-full" });

  // Capacity frees: the live turn resolves and drains the queue.
  h.resolveNext({ ok: true, text: "done" });
  await pLive;
  let guard = 0;
  while (h.queue.queueLength("relay:poison-lane", "poison-lane", "poison-lane") > 0 && guard++ < 50) {
    h.resolveNext({ ok: true, text: "drained" });
    await tick();
  }
  expect(guard).toBeLessThan(50);

  // Retry X: a REAL admission (injected or queued behind the last filler),
  // never a poisoned injected no-op. Drain until X actually RUNS.
  const retry = h.queue.submitPeerTurn({
    chatKey: "relay:poison-lane",
    sessionAlias: "poison-lane",
    concurrencyKey: "poison-lane",
    text: "request X",
    senderId: "agent-messaging",
    promptRequestId: "msg_b1a_reject_then_retry",
    isPeerMessage: true,
    allowRestoreArchived: false,
  });
  expect(["injected", "queued"]).toContain(retry.status);
  let xDrain = 0;
  while (
    executedRequests.every((r) => r.text !== "request X") &&
    xDrain++ < 50
  ) {
    h.resolveNext({ ok: true, text: "turn" });
    await tick();
  }
  const xRuns = executedRequests.filter((r) => r.text === "request X");
  expect(xRuns).toHaveLength(1);
});

test("B1b (tombstone TTL): an expired settled tombstone no longer absorbs a retry", async () => {
  const h = makeQueue();
  const executedRequests: Array<{ text: string }> = [];
  const origRun = (h.queue as any).deps.runTurn;
  (h.queue as any).deps.runTurn = async (req: any, sig: any, act: any) => {
    executedRequests.push(req);
    return await origRun(req, sig, act);
  };
  const params = {
    chatKey: "relay:ttl-lane",
    sessionAlias: "ttl-lane",
    concurrencyKey: "ttl-lane",
    text: "ttl probe",
    senderId: "agent-messaging",
    promptRequestId: "msg_b1b_ttl",
    isPeerMessage: true,
    allowRestoreArchived: false,
  };

  expect(h.queue.submitPeerTurn(params).status).toBe("injected");
  h.resolveNext({ ok: true, text: "done" });
  await tick();
  expect(executedRequests).toHaveLength(1);

  // Age the tombstone past its 24h TTL.
  const tombstones = (h.queue as any).settledRequestIds as Map<string, number>;
  expect(tombstones.has("msg_b1b_ttl")).toBe(true);
  tombstones.set("msg_b1b_ttl", Date.now() - 1);

  // The retry now runs a REAL turn again.
  expect(h.queue.submitPeerTurn(params).status).toBe("injected");
  h.resolveNext({ ok: true, text: "second real turn" });
  await tick();
  expect(executedRequests).toHaveLength(2);
});

test("Phase 7 (Gate L): busy source session queues completion turn and drains sequentially without parallel turn", async () => {
  const h = makeQueue();
  const executedRequests: Array<{ text: string; isPeerMessage?: boolean; peerOrigin?: unknown }> = [];
  const origRun = (h.queue as any).deps.runTurn;
  (h.queue as any).deps.runTurn = async (req: any, sig: any, act: any) => {
    executedRequests.push(req);
    return await origRun(req, sig, act);
  };

  // 1. Start an active human turn on session "source-lane"
  void h.queue.submit({
    chatKey: "relay:source-lane",
    sessionAlias: "source-lane",
    concurrencyKey: "source-lane",
    text: "human running turn",
    senderId: "user",
    queueable: true,
  });
  await tick();
  expect(h.queue.isBusy("relay:source-lane", "source-lane")).toBe(true);
  expect(executedRequests).toHaveLength(1);
  expect(executedRequests[0]!.text).toBe("human running turn");

  // 2. Completion turn arrives while busy
  const completionAdmission = h.queue.submitPeerTurn({
    chatKey: "relay:source-lane",
    sessionAlias: "source-lane",
    concurrencyKey: "source-lane",
    text: "<xacpx-peer-result>computed value</xacpx-peer-result>",
    senderId: "agent-messaging",
    promptRequestId: "msg_comp_123",
    isPeerMessage: true,
    allowRestoreArchived: false,
    preserveCoordinatorRoute: true,
  });

  expect(completionAdmission).toEqual({ status: "queued" });
  expect(h.queue.queueLength("relay:source-lane", "source-lane")).toBe(1);
  // No parallel turn started
  expect(executedRequests).toHaveLength(1);

  // 3. Current turn finishes -> completion drains next in the same lane
  h.resolveNext({ ok: true, text: "human turn finished" });
  await tick();
  expect(executedRequests).toHaveLength(2);
  expect(executedRequests[1]!.text).toBe("<xacpx-peer-result>computed value</xacpx-peer-result>");
  expect(executedRequests[1]!.turnStarted?.promptRequestId).toBe("msg_comp_123");
  expect(executedRequests[1]!.peerOrigin).toBeUndefined();
  h.resolveNext({ ok: true, text: "completion turn finished" });
  await tick();
  expect(h.queue.isBusy("relay:source-lane", "source-lane")).toBe(false);
});

// ---------------------------------------------------------------------------
// v0.4 Peer Interrupt Delivery — TurnQueue lane semantics (spec §19 hard gates).
// submitPeerInterrupt owns atomic reserve→abort→true-settle→priority-drain; the
// tests below pin that state machine at the TurnQueue seam before implementation.
// -------------------------------------------------------------------------

// Count abort signals on the currently running turn's controller.
function trackAborts(h: { head(): { signal: AbortSignal } | undefined }): () => number {
  let aborts = 0;
  h.head()?.signal.addEventListener("abort", () => aborts++);
  return () => aborts;
}

test("v0.4 idle-interrupt: an interrupt on an idle target starts an ordinary peer turn with zero cancellations", async () => {
  const h = makeQueue();
  const res = h.queue.submitPeerInterrupt({
    ...BASE,
    text: "I",
    senderId: "agent-messaging",
    promptRequestId: "msg_idle_i",
    isPeerMessage: true,
  });
  expect(res).toEqual({ status: "injected", modeUsed: "prompt" });
  await tick();
  expect(h.started).toEqual(["I"]);
  expect(h.head()!.signal.aborted).toBe(false);
  h.resolveNext();
});

test("v0.4 G1.1: busy interrupt reserves, aborts the predecessor exactly once, and starts only after true settlement", async () => {
  const h = makeQueue();
  const pOld = h.queue.submit({ ...BASE, text: "old", queueable: true });
  await tick();
  const aborts = trackAborts(h);
  const res = h.queue.submitPeerInterrupt({
    ...BASE,
    text: "X",
    senderId: "agent-messaging",
    promptRequestId: "msg_x",
    isPeerMessage: true,
  });
  // Synchronous acceptance: reservation owned + predecessor signalled, ACK returned
  // before the predecessor has unwound.
  expect(res).toEqual({ status: "queued", modeUsed: "interrupt" });
  expect(aborts()).toBe(1);
  expect(h.started).toEqual(["old"]);
  // Old runTurn deliberately held unresolved: no X execution may start.
  await tick();
  expect(h.started).toEqual(["old"]);
  h.resolveNext({ ok: false, errorMessage: "aborted" });
  await pOld;
  await tick();
  expect(h.started).toEqual(["old", "X"]);
  expect(h.pendingReqs()[1]!.turnStarted?.promptRequestId).toBe("msg_x");
  h.resolveNext();
});

test("v0.4 G1.2: aborted-but-unsettled predecessor is NOT aborted again; interrupt reserves and waits for true settle", async () => {
  const h = makeQueue();
  const pOld = h.queue.submit({ ...BASE, text: "old", queueable: true });
  await tick();
  h.queue.cancelTurn("c", "s"); // first (user Stop) abort; runTurn still unresolved
  const aborts = trackAborts(h);
  const res = h.queue.submitPeerInterrupt({
    ...BASE,
    text: "X",
    senderId: "agent-messaging",
    promptRequestId: "msg_x2",
    isPeerMessage: true,
  });
  expect(res).toEqual({ status: "queued", modeUsed: "interrupt" });
  expect(aborts()).toBe(0); // no second abort in the aborted-but-unsettled window
  expect(h.started).toEqual(["old"]); // no false admission before settle
  await tick();
  expect(h.started).toEqual(["old"]);
  h.resolveNext({ ok: false, errorMessage: "aborted" });
  await pOld;
  await tick();
  expect(h.started).toEqual(["old", "X"]); // exactly one X execution after settle
  h.resolveNext();
});

test("v0.4 G1.3: a reserved interrupt drains ahead of ordinary queued prompts without evicting them", async () => {
  const h = makeQueue();
  const pCur = h.queue.submit({ ...BASE, text: "cur", queueable: true });
  await tick();
  expect(h.queue.submitPeerTurn({ ...BASE, text: "Q1", senderId: "agent-messaging", promptRequestId: "q1", isPeerMessage: true }).status).toBe("queued");
  expect(h.queue.submitPeerTurn({ ...BASE, text: "Q2", senderId: "agent-messaging", promptRequestId: "q2", isPeerMessage: true }).status).toBe("queued");
  expect(h.queue.submitPeerInterrupt({ ...BASE, text: "I", senderId: "agent-messaging", promptRequestId: "msg_i3", isPeerMessage: true }).status).toBe("queued");
  h.resolveNext();
  await pCur;
  await tick();
  expect(h.started).toEqual(["cur", "I"]);
  h.resolveNext();
  await tick();
  expect(h.started).toEqual(["cur", "I", "Q1"]);
  h.resolveNext();
  await tick();
  expect(h.started).toEqual(["cur", "I", "Q1", "Q2"]);
  h.resolveNext();
});

test("v0.4 G1.4: a full normal queue does not consume or block the free interrupt slot", async () => {
  const h = makeQueue();
  const pCur = h.queue.submit({ ...BASE, text: "cur", queueable: true });
  await tick();
  for (let i = 0; i < QUEUE_MAX_DEPTH; i++) {
    expect(h.queue.submitPeerTurn({ ...BASE, text: `Q${i}`, senderId: "agent-messaging", promptRequestId: `q${i}`, isPeerMessage: true }).status).toBe("queued");
  }
  expect(h.queue.queueLength("c", "s")).toBe(QUEUE_MAX_DEPTH);
  const res = h.queue.submitPeerInterrupt({
    ...BASE,
    text: "I",
    senderId: "agent-messaging",
    promptRequestId: "msg_i4",
    isPeerMessage: true,
  });
  expect(res).toEqual({ status: "queued", modeUsed: "interrupt" });
  expect(h.queue.queueLength("c", "s")).toBe(QUEUE_MAX_DEPTH); // normal queue unchanged
  h.resolveNext();
  await pCur;
  await tick();
  const expected = ["cur", "I", ...Array.from({ length: QUEUE_MAX_DEPTH }, (_, i) => `Q${i}`)];
  for (let i = 1; i < expected.length; i++) {
    expect(h.started).toEqual(expected.slice(0, i + 1));
    h.resolveNext();
    await tick();
  }
});

test("v0.4 G1.5: a second DISTINCT interrupt is rejected queue-full while one is reserved; the reservation survives", async () => {
  const h = makeQueue();
  const pOld = h.queue.submit({ ...BASE, text: "old", queueable: true });
  await tick();
  const aborts = trackAborts(h);
  expect(h.queue.submitPeerInterrupt({ ...BASE, text: "I1", senderId: "agent-messaging", promptRequestId: "msg_i1", isPeerMessage: true })).toEqual({
    status: "queued",
    modeUsed: "interrupt",
  });
  expect(h.queue.submitPeerInterrupt({ ...BASE, text: "I2", senderId: "agent-messaging", promptRequestId: "msg_i2", isPeerMessage: true })).toEqual({
    status: "rejected",
    reason: "queue-full",
  });
  expect(aborts()).toBe(1); // no second cancel
  h.resolveNext();
  await pOld;
  await tick();
  expect(h.started).toEqual(["old", "I1"]); // I1 kept, I2 never runs (not downgraded)
  h.resolveNext();
  await tick();
  expect(h.started).toEqual(["old", "I1"]);
});

test("v0.4 G1.6: a duplicate interrupt retry (same promptRequestId) is deduped — one reservation, one abort, one run", async () => {
  const h = makeQueue();
  const pOld = h.queue.submit({ ...BASE, text: "old", queueable: true });
  await tick();
  const aborts = trackAborts(h);
  expect(h.queue.submitPeerInterrupt({ ...BASE, text: "I1", senderId: "agent-messaging", promptRequestId: "msg_p", isPeerMessage: true })).toEqual({
    status: "queued",
    modeUsed: "interrupt",
  });
  expect(h.queue.submitPeerInterrupt({ ...BASE, text: "I1", senderId: "agent-messaging", promptRequestId: "msg_p", isPeerMessage: true })).toEqual({
    status: "queued",
    modeUsed: "interrupt",
  });
  expect(aborts()).toBe(1);
  h.resolveNext();
  await pOld;
  await tick();
  expect(h.started).toEqual(["old", "I1"]);
  h.resolveNext();
  await tick();
  // Retry after the interrupt turn started/completed: still deduped, never a second turn.
  expect(h.queue.submitPeerInterrupt({ ...BASE, text: "I1", senderId: "agent-messaging", promptRequestId: "msg_p", isPeerMessage: true })).toEqual({
    status: "injected",
    modeUsed: "prompt",
  });
  await tick();
  expect(h.started).toEqual(["old", "I1"]);
});

test("v0.4 G1.7a: cancelQueuedItem removes a pending interrupt before it runs and resolves its completion contract once", async () => {
  const cancelled: Array<{ peerOrigin: unknown; promptRequestId?: string }> = [];
  const h = makeQueue({
    cancelDrainTimeoutMs: 10,
    onQueuedPeerCancelled: (detail) => cancelled.push(detail),
  });
  const pOld = h.queue.submit({ ...BASE, text: "old", queueable: true });
  await tick();
  const peerOrigin = {
    requestMessageId: "msg_i7",
    completion: "result" as const,
    source: { nodeId: "n", endpointId: "src" },
    target: { nodeId: "n", endpointId: "dst" },
  };
  const res = h.queue.submitPeerInterrupt({
    ...BASE,
    text: "I",
    senderId: "agent-messaging",
    promptRequestId: "msg_i7",
    isPeerMessage: true,
    peerOrigin,
  });
  if (res.status !== "queued") throw new Error("expected queued");
  const removed = h.queue.cancelQueuedItem("c", "s", res.queueItemId);
  expect(removed.cancelled).toBe(true);
  expect(cancelled).toHaveLength(1);
  expect(cancelled[0]!.peerOrigin).toEqual(peerOrigin);
  expect(cancelled[0]!.promptRequestId).toBe("msg_i7");
  h.resolveNext();
  await pOld;
  await tick();
  expect(h.started).toEqual(["old"]); // the interrupt never executes
});

test("v0.4 G1.7b: clearSession drops the pending interrupt and resolves its completion contract once", async () => {
  const cancelled: Array<{ peerOrigin: unknown }> = [];
  const h = makeQueue({
    cancelDrainTimeoutMs: 10,
    onQueuedPeerCancelled: (detail) => cancelled.push(detail),
  });
  const pOld = h.queue.submit({ ...BASE, text: "old", queueable: true });
  await tick();
  const peerOrigin = {
    requestMessageId: "msg_i8",
    completion: "result" as const,
    source: { nodeId: "n", endpointId: "src" },
    target: { nodeId: "n", endpointId: "dst" },
  };
  expect(h.queue.submitPeerInterrupt({
    ...BASE,
    text: "I",
    senderId: "agent-messaging",
    promptRequestId: "msg_i8",
    isPeerMessage: true,
    peerOrigin,
  }).status).toBe("queued");
  expect(await h.queue.clearSession("c", "s")).toEqual({ cleared: true });
  expect(cancelled).toHaveLength(1);
  expect(cancelled[0]!.peerOrigin).toEqual(peerOrigin);
  h.resolveNext({ ok: false, errorMessage: "aborted" });
  await pOld;
  await tick();
  expect(h.started).toEqual(["old"]); // never executed on the dead session
});

test("v0.4 lifecycle: interrupt on a removing/archived target is rejected target-unavailable", async () => {
  const h = makeQueue();
  // Arm the teardown guard the real way: a successful clearSession on an idle lane.
  expect(await h.queue.clearSession("c", "s")).toEqual({ cleared: true });
  expect(h.queue.submitPeerInterrupt({
    ...BASE,
    text: "I",
    senderId: "agent-messaging",
    promptRequestId: "msg_i9",
    isPeerMessage: true,
  })).toEqual({ status: "rejected", reason: "target-unavailable" });
  h.queue.finishClear("c", "s");
});

test("v0.4 state hygiene: the interrupt slot empties on start, on cancel, and on clear — no stale keys", async () => {
  const h = makeQueue();
  expect(h.queue.pendingInterruptCount("c", "s")).toBe(0);
  const pOld = h.queue.submit({ ...BASE, text: "old", queueable: true });
  await tick();
  h.queue.submitPeerInterrupt({ ...BASE, text: "I", senderId: "agent-messaging", promptRequestId: "msg_h1", isPeerMessage: true });
  expect(h.queue.pendingInterruptCount("c", "s")).toBe(1);
  h.resolveNext();
  await pOld;
  await tick();
  expect(h.started).toEqual(["old", "I"]); // slot consumed by start
  expect(h.queue.pendingInterruptCount("c", "s")).toBe(0);
  h.resolveNext();
  await tick();
  // Reserve again, then cancel via lifecycle and confirm the map is empty.
  const p2 = h.queue.submit({ ...BASE, text: "old2", queueable: true });
  await tick();
  const res = h.queue.submitPeerInterrupt({ ...BASE, text: "I2", senderId: "agent-messaging", promptRequestId: "msg_h2", isPeerMessage: true });
  if (res.status !== "queued") throw new Error("expected queued");
  h.queue.cancelQueuedItem("c", "s", res.queueItemId);
  expect(h.queue.pendingInterruptCount("c", "s")).toBe(0);
  h.resolveNext();
  await p2;
  await tick();
  expect(h.queue.pendingInterruptCount("c", "s")).toBe(0);
});
