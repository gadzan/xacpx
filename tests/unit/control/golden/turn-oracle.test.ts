// tests/unit/control/golden/turn-oracle.test.ts
// Eight concurrency scenarios for ControlService's turn machinery, each driving the public
// surface and asserting the whole recorded log against a baseline fixture. Fixtures were
// recorded on the pre-refactor executeTurn (54be207); a behaviour-equivalent refactor must
// reproduce them byte-for-byte (structurally). Each scenario mirrors an existing test in
// control-service-{queue,prompt}.test.ts — the oracle version records the ORDERED event +
// return log instead of asserting individual facts, so it also catches microtask-timing
// regressions those tests cannot see.
import { test } from "bun:test";
import { makeTurnOracle, expectMatchesFixture } from "./turn-oracle-harness";

const tick = () => new Promise((r) => setTimeout(r, 0));
const C = { chatKey: "c", sessionAlias: "s", senderId: "u" };

test("oracle: a busy second prompt enqueues", async () => {
  const o = makeTurnOracle();
  const p1 = o.service.prompt({ ...C, text: "first" });
  await tick();
  await o.record("second", o.service.prompt({ ...C, text: "second" }));
  o.controls.resolveChat();
  await p1;
  await tick();
  expectMatchesFixture("busy-second-enqueues", o.log);
});

test("oracle: same-tick two prompts — exactly one wins, the other queues", async () => {
  const o = makeTurnOracle();
  // Both submitted in ONE synchronous tick — never await the first before the second.
  // Recording each return under a stable label makes the fixture ENCODE the winner: the
  // first-submitted takes the slot synchronously (inFlight.set before its first await), the
  // second sees busy and enqueues. Reversing submit order flips the fixture — a plain
  // "exactly one wins" result assertion would not, which is why this scenario records order.
  const pA = o.record("promptA", o.service.prompt({ ...C, text: "A" }));
  const pB = o.record("promptB", o.service.prompt({ ...C, text: "B" }));
  await tick();
  o.controls.resolveChat(); // the winner's turn finishes → drains the loser
  await tick(); // let the loser's drained turn register + park on its own chat
  o.controls.resolveChat(); // the drained loser's turn finishes
  await Promise.all([pA, pB]);
  await tick();
  expectMatchesFixture("same-tick-one-wins", o.log);
});

test("oracle: a scheduled turn is not queued (still rejects)", async () => {
  const o = makeTurnOracle();
  const p1 = o.service.prompt({ ...C, text: "first" });
  await tick();
  await o.record(
    "scheduled",
    o.service.runScheduledTurn({
      chatKey: "c",
      sessionAlias: "s",
      promptText: "sched",
      taskId: "t1",
      executeAt: "2026-07-01T00:00:00Z",
    }),
  );
  o.controls.resolveChat();
  await p1;
  await tick();
  expectMatchesFixture("scheduled-not-queued", o.log);
});

test("oracle: queued prompts drain FIFO, each its own turn", async () => {
  const o = makeTurnOracle();
  const p1 = o.service.prompt({ ...C, text: "first" });
  await tick();
  await o.record("q2", o.service.prompt({ ...C, text: "second" }));
  await o.record("q3", o.service.prompt({ ...C, text: "third" }));
  o.controls.resolveChat();
  await tick(); // finish "first" → drain "second"
  o.controls.resolveChat();
  await tick(); // finish "second" → drain "third"
  o.controls.resolveChat();
  await tick(); // finish "third" → queue empty
  await p1;
  expectMatchesFixture("fifo-drain", o.log);
});

test("oracle: a prompt during the drain hand-off enqueues (no parallel turn)", async () => {
  const o = makeTurnOracle();
  const p1 = o.service.prompt({ ...C, text: "first" });
  await tick();
  await o.record("q2", o.service.prompt({ ...C, text: "second" }));
  o.controls.resolveChat(); // finish "first"; drain starts "second"
  await o.record("q3", o.service.prompt({ ...C, text: "third" })); // saw busy → queued
  o.controls.resolveChat();
  o.controls.resolveChat();
  await p1;
  await tick();
  expectMatchesFixture("drain-window-enqueue", o.log);
});

test("oracle: a drained head whose useSession fails still drains the following item", async () => {
  // Turn 1 binds on call 1. The drained "second" fails its bind (call 2). "third" (call 3)
  // must still drain — not be stranded behind the failed head. Mirrors the queue test's
  // useCount===2 override exactly.
  let useCount = 0;
  const o = makeTurnOracle({
    useSession: async (_c: string, alias: string) => {
      useCount += 1;
      if (useCount === 2) throw new Error("transient bind failure");
      return { alias, agent: "claude", workspace: "/ws" };
    },
  });
  const p1 = o.service.prompt({ ...C, text: "first" });
  await tick();
  await o.record("q2", o.service.prompt({ ...C, text: "second" }));
  await o.record("q3", o.service.prompt({ ...C, text: "third" }));
  o.controls.resolveChat(); // finish "first" → drain "second" (bind throws) → must reach "third"
  await tick();
  o.controls.resolveChat(); // finish "third"
  await tick();
  await p1;
  expectMatchesFixture("stranded-tail", o.log);
});

test("oracle: a cancel emptying the queue during hand-off clears draining (no wedge)", async () => {
  // The finally sets `draining`, then awaits a post-turn getSession. Cancelling the only
  // queued item during that await makes advanceQueue take its empty `else` branch, which
  // must clear `draining` too — else it leaks and every future prompt enqueues forever. The
  // getSession override arms the cancel ONLY for the post-turn window (mirrors the queue test).
  const ref: { itemId?: string } = {};
  let armCancel = false;
  const o = makeTurnOracle({
    getSession: async (a: string) => {
      if (armCancel && ref.itemId) {
        armCancel = false;
        o.service.cancelQueuedItem("c", "s", ref.itemId);
      }
      return { alias: a, transportSession: "t1" };
    },
  });
  const p1 = o.service.prompt({ ...C, text: "first" });
  await tick();
  const r2 = await o.record(
    "second",
    o.service.prompt({ ...C, text: "second" }),
  );
  ref.itemId = (r2 as { queueItemId?: string }).queueItemId;
  armCancel = true;
  o.controls.resolveChat(); // finish "first" → draining set → post-turn getSession cancels "second"
  await tick();
  await p1;
  // A fresh prompt must START a real turn (park on the chat), not enqueue — proving draining cleared.
  const after = o.record("after", o.service.prompt({ ...C, text: "after" }));
  await tick();
  o.controls.resolveChat(); // release "after"
  await after;
  await tick();
  expectMatchesFixture("cancel-empties-queue-clears-draining", o.log);
});

test("oracle: a follow-up after Stop waits for the cancelled turn to drain, then runs", async () => {
  // Stop aborts the turn, but teardown is async so it lingers in inFlight. A follow-up in
  // that window must wait (raceWithTimeout on settled) and then start fresh, not bounce with
  // "turn-already-running". Mirrors the prompt test: abort, then reject the chat to simulate
  // teardown completing, then the follow-up proceeds.
  const o = makeTurnOracle();
  const first = o.record("first", o.service.prompt({ ...C, text: "long" }));
  await tick();
  o.service.cancelTurn("c", "s"); // abort turn 1's controller
  const second = o.record("second", o.service.prompt({ ...C, text: "next" })); // waits on settled
  await tick();
  o.controls.rejectChat(); // teardown done: turn 1's chat rejects → turn-finished cancelled → settled
  await tick();
  o.controls.resolveChat(); // the follow-up's chat completes
  await Promise.all([first, second]);
  await tick();
  expectMatchesFixture("stop-then-followup", o.log);
});

test("oracle: an aborted turn's queued item — draining guards the post-turn sessions-changed window", async () => {
  // The post-turn sessions-changed detection takes a getSession await, and it must run with
  // `draining` already set. Otherwise an aborted turn (its inFlight entry no longer reads
  // busy) with a queued item leaves the session looking free during that await, and a fresh
  // prompt races in — enqueue turns into a block/reject. This fixture pins the guarded
  // ordering: the fresh "third" prompt arriving mid-window must ENQUEUE. The getSession
  // override holds ONLY the post-turn call open (armed right before the abort settles),
  // mirroring the cancel-empties scenario's arming technique.
  let armGate = false;
  let releaseGate!: () => void;
  const gate = new Promise<void>((r) => {
    releaseGate = r;
  });
  const o = makeTurnOracle({
    getSession: async (a: string) => {
      if (armGate) {
        armGate = false;
        await gate;
      }
      return { alias: a, transportSession: "t1" };
    },
  });
  const p1 = o.record("first", o.service.prompt({ ...C, text: "first" }));
  await tick();
  await o.record("second", o.service.prompt({ ...C, text: "second" })); // queued behind turn 1
  o.service.cancelTurn("c", "s"); // abort turn 1
  armGate = true; // the next getSession (turn 1's post-turn detection) holds open
  o.controls.rejectChat(); // turn 1 unwinds → finally sets draining, then awaits the gated getSession
  await tick();
  await tick();
  const third = o.record("third", o.service.prompt({ ...C, text: "third" })); // mid-window → must enqueue
  await tick();
  releaseGate(); // close the window
  await tick();
  o.controls.resolveChat(); // drain "second"
  await tick();
  o.controls.resolveChat(); // drain "third"
  await tick();
  await Promise.all([p1, third]);
  await tick();
  expectMatchesFixture("aborted-queue-sessions-window", o.log);
});
