// tests/unit/control/turn-queue.test.ts
// White-box tests for TurnQueue: the three-state concurrency gate (inFlight/queues/draining)
// extracted out of ControlService.executeTurn. Drives TurnQueue directly with a controllable
// fake runTurn — no ControlService, no SessionTurnRunner, no sessions dependency (TurnQueue is
// session-free by design; the sessions-changed compare is threaded in via
// deps.detectSessionsChanged).
import { expect, test } from "bun:test";
import { TurnQueue, type TurnQueueDeps } from "../../../src/control/turn-queue";
import type { TurnRequest, TurnResult } from "../../../src/control/session-turn-runner";

// Wires a TurnQueue to a controllable deferred runTurn. `runTurn` records each turn's text into
// `started` (so drain-order tests can assert it) and parks on a pending promise the test resolves
// by hand via `resolveNext`. Deps default to no-ops; pass `overrides` to inject behavior (e.g. a
// detectSessionsChanged that cancels a queued item). Models SessionTurnRunner.run's real
// contract: it never rejects — it always resolves with a TurnResult (ok:false + errorMessage on
// failure), so there is no reject path to fake.
function makeQueue(overrides?: Partial<TurnQueueDeps>) {
  const started: string[] = [];
  const pending: Array<{ req: TurnRequest; resolve: (r: TurnResult) => void }> = [];
  const queue = new TurnQueue({
    runTurn: (req: TurnRequest, _s: AbortSignal) => {
      started.push(req.text);
      return new Promise<TurnResult>((resolve) => pending.push({ req, resolve }));
    },
    emitQueueUpdated: () => {},
    detectSessionsChanged: async () => {},
    ...overrides,
  });
  return {
    queue,
    started,
    resolveNext: (r: TurnResult = { ok: true }) => pending.shift()?.resolve(r),
    pendingCount: () => pending.length,
    pendingReqs: () => pending.map((p) => p.req),
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
