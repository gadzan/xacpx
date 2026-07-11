// tests/unit/control/turn-queue.test.ts
// White-box tests for TurnQueue: the three-state concurrency gate (inFlight/queues/draining)
// extracted out of ControlService.executeTurn. Drives TurnQueue directly with a controllable
// fake runTurn — no ControlService, no SessionTurnRunner, no sessions dependency (TurnQueue is
// session-free by design; the sessions-changed compare is threaded in via
// deps.detectSessionsChanged).
import { expect, test } from "bun:test";
import { TurnQueue } from "../../../src/control/turn-queue";
import type { TurnRequest, TurnResult } from "../../../src/control/session-turn-runner";

// Models SessionTurnRunner.run's real contract: it never rejects, even on an aborted or
// failed turn — it always resolves with a TurnResult (ok:false + errorMessage on failure).
// So the fake here only ever resolves; there is no reject path to fake.
function deferredRunTurn() {
  const pending: Array<{ req: TurnRequest; resolve: (r: TurnResult) => void }> = [];
  const runTurn = (req: TurnRequest, _s: AbortSignal) =>
    new Promise<TurnResult>((resolve) => pending.push({ req, resolve }));
  return {
    runTurn,
    resolveNext: (r: TurnResult = { ok: true }) => pending.shift()?.resolve(r),
    pendingCount: () => pending.length,
    pendingReqs: () => pending.map((p) => p.req),
  };
}

const C = { chatKey: "c", sessionAlias: "s", senderId: "u" };

test("submit's busy-decision + enqueue is a synchronous prefix (same tick, zero await)", () => {
  const d = deferredRunTurn();
  const tq = new TurnQueue({ runTurn: d.runTurn, emitQueueUpdated: () => {}, detectSessionsChanged: async () => {} });
  const req = { ...C, text: "A", queueable: true };
  void tq.submit(req); // sync inFlight.set
  void tq.submit({ ...req, text: "B" }); // sync enqueue
  // ZERO await between submit and this assertion — pins the synchronous prefix.
  expect(tq.queueLength("c", "s")).toBe(1);
  expect(tq.isBusy("c", "s")).toBe(true);
});

const tick = () => new Promise((r) => setTimeout(r, 0));

test("a busy second submit enqueues and reports queued:true with an id", async () => {
  const d = deferredRunTurn();
  const tq = new TurnQueue({ runTurn: d.runTurn, emitQueueUpdated: () => {}, detectSessionsChanged: async () => {} });
  const p1 = tq.submit({ ...C, text: "first", queueable: true });
  await tick();
  const r2 = await tq.submit({ ...C, text: "second", queueable: true });
  expect(r2).toMatchObject({ ok: true, queued: true });
  expect(typeof (r2 as { queueItemId: string }).queueItemId).toBe("string");
  expect(tq.queueLength("c", "s")).toBe(1);
  d.resolveNext();
  await p1;
});

test("a non-queueable submit while busy rejects immediately with turn-already-running", async () => {
  const d = deferredRunTurn();
  const tq = new TurnQueue({ runTurn: d.runTurn, emitQueueUpdated: () => {}, detectSessionsChanged: async () => {} });
  const p1 = tq.submit({ ...C, text: "first", queueable: true });
  await tick();
  const r2 = await tq.submit({ ...C, text: "sched" }); // no queueable flag
  expect(r2).toEqual({ ok: false, errorMessage: "turn-already-running" });
  expect(tq.queueLength("c", "s")).toBe(0);
  d.resolveNext();
  await p1;
});

test("FIFO drain: queued items each run their own turn in order", async () => {
  const d = deferredRunTurn();
  const started: string[] = [];
  const runTurn = (req: TurnRequest, s: AbortSignal) => {
    started.push(req.text);
    return d.runTurn(req, s);
  };
  const tq = new TurnQueue({ runTurn, emitQueueUpdated: () => {}, detectSessionsChanged: async () => {} });
  const p1 = tq.submit({ ...C, text: "first", queueable: true });
  await tick();
  const p2 = tq.submit({ ...C, text: "second", queueable: true });
  const p3 = tq.submit({ ...C, text: "third", queueable: true });

  d.resolveNext(); // finish "first" -> drain "second"
  await tick();
  d.resolveNext(); // finish "second" -> drain "third"
  await tick();
  d.resolveNext(); // finish "third" -> empty
  await tick();

  await Promise.all([p1, p2, p3]);
  expect(started).toEqual(["first", "second", "third"]);
  expect(tq.queueLength("c", "s")).toBe(0);
  expect(tq.isBusy("c", "s")).toBe(false);
});

test("a submit arriving during the drain hand-off enqueues (no parallel turn)", async () => {
  const d = deferredRunTurn();
  const started: string[] = [];
  const runTurn = (req: TurnRequest, s: AbortSignal) => {
    started.push(req.text);
    return d.runTurn(req, s);
  };
  const tq = new TurnQueue({ runTurn, emitQueueUpdated: () => {}, detectSessionsChanged: async () => {} });
  const p1 = tq.submit({ ...C, text: "first", queueable: true });
  await tick();
  const p2 = tq.submit({ ...C, text: "second", queueable: true });
  d.resolveNext(); // finish "first"; drain hands off to "second" (still async before it registers)
  const r3 = await tq.submit({ ...C, text: "third", queueable: true }); // saw busy -> queued
  expect(r3).toMatchObject({ ok: true, queued: true });
  d.resolveNext();
  await tick();
  d.resolveNext();
  await Promise.all([p1, p2]);
  expect(started).toEqual(["first", "second", "third"]);
});

test("stranded-tail: a drained head whose turn fails still drains the following item", async () => {
  const d = deferredRunTurn();
  const started: string[] = [];
  const runTurn = (req: TurnRequest, s: AbortSignal) => {
    started.push(req.text);
    return d.runTurn(req, s);
  };
  const tq = new TurnQueue({ runTurn, emitQueueUpdated: () => {}, detectSessionsChanged: async () => {} });
  const p1 = tq.submit({ ...C, text: "first", queueable: true });
  await tick();
  // "second"/"third" submit while busy -> both return the enqueue ack immediately, NOT the
  // eventual drained-turn outcome (mirrors the oracle harness's q2/q3 recording).
  const r2 = await tq.submit({ ...C, text: "second", queueable: true });
  const r3 = await tq.submit({ ...C, text: "third", queueable: true });
  expect(r2).toMatchObject({ ok: true, queued: true });
  expect(r3).toMatchObject({ ok: true, queued: true });

  d.resolveNext(); // finish "first" -> drain "second"
  await tick();
  // "second"'s turn fails (e.g. a transient bind failure inside SessionTurnRunner.run, which
  // never rejects — it always resolves ok:false) -> must still reach "third", not strand it.
  d.resolveNext({ ok: false, errorMessage: "transient bind failure" });
  await tick();
  expect(started).toEqual(["first", "second", "third"]);
  d.resolveNext(); // finish "third"
  await tick();

  await p1;
  expect(tq.queueLength("c", "s")).toBe(0);
  expect(tq.isBusy("c", "s")).toBe(false);
});

test("cancel-empties-queue (wedge #3): a cancel emptying the queue during hand-off clears draining", async () => {
  // Mirrors the golden fixture "cancel-empties-queue-clears-draining": the finally sets
  // `draining`, then awaits detectSessionsChanged. If that await cancels the only queued item,
  // advanceQueue's empty `else` branch must clear `draining` too, or the guard leaks and every
  // future submit enqueues forever.
  const d = deferredRunTurn();
  const ref: { queueItemId?: string; tq?: TurnQueue } = {};
  let armCancel = false;
  const tq = new TurnQueue({
    runTurn: d.runTurn,
    emitQueueUpdated: () => {},
    detectSessionsChanged: async () => {
      if (armCancel && ref.queueItemId) {
        armCancel = false;
        ref.tq!.cancelQueuedItem("c", "s", ref.queueItemId);
      }
    },
  });
  ref.tq = tq;

  const p1 = tq.submit({ ...C, text: "first", queueable: true });
  await tick();
  const r2 = await tq.submit({ ...C, text: "second", queueable: true });
  ref.queueItemId = (r2 as { queueItemId: string }).queueItemId;

  armCancel = true;
  // "first"'s result carries no postTurnDetection by default, so detectSessionsChanged would
  // never be called — force a detection by giving the resolved result a postTurnDetection.
  d.resolveNext({ ok: true, postTurnDetection: { internalAlias: "a", priorTransportSession: "t0" } });
  await tick();
  await p1;

  // A fresh submit must START a real turn (park on runTurn), not enqueue — proving draining
  // cleared and the cancelled "second" never ran.
  expect(tq.queueLength("c", "s")).toBe(0);
  expect(tq.isBusy("c", "s")).toBe(false);
  const after = tq.submit({ ...C, text: "after", queueable: true });
  await tick();
  expect(d.pendingCount()).toBe(1); // parked on runTurn, not resolved via queue
  expect(d.pendingReqs().at(-1)?.text).toBe("after");
  d.resolveNext();
  await after;
});

test("Stop-then-followup: a submit after cancelTurn waits (raceWithTimeout) then runs fresh", async () => {
  const d = deferredRunTurn();
  const tq = new TurnQueue({ runTurn: d.runTurn, emitQueueUpdated: () => {}, detectSessionsChanged: async () => {} });
  const first = tq.submit({ ...C, text: "long", queueable: true });
  await tick();
  expect(tq.cancelTurn("c", "s")).toBe(true); // aborts turn 1's controller; it stays in inFlight until settled
  const second = tq.submit({ ...C, text: "next", queueable: true }); // waits on settled via raceWithTimeout
  await tick();
  expect(d.pendingCount()).toBe(1); // "second" has NOT started a turn yet — it's parked on raceWithTimeout
  // Simulate teardown completing: turn 1's runTurn resolves ok:false (SessionTurnRunner.run
  // never rejects, even on abort) -> its finally resolves `settled`.
  d.resolveNext({ ok: false, errorMessage: "aborted" });
  await tick();
  expect(d.pendingCount()).toBe(1); // now "second" has started its own turn
  d.resolveNext();
  const [r1, r2] = await Promise.all([first, second]);
  expect(r1).toEqual({ ok: false, errorMessage: "aborted" });
  expect((r2 as TurnResult).ok).toBe(true);
});
