import { expect, test } from "bun:test";

import { ControlService } from "../../../src/control/control-service";
import { createControlEventBus, type ControlEvent } from "../../../src/control/control-event-bus";
import type { ChatRequest, ChatResponse } from "../../../src/weixin/agent/interface";

// Harness mirrors control-service-prompt.test.ts's makeControl, but the fake
// agent.chat blocks on a gate so a turn can be held "in flight" while the test
// sends follow-up prompts / scheduled turns at it.
function makeService(opts?: {
  // Override the fake session bind so a test can make a specific turn's useSession throw
  // (e.g. simulate a transient session-bind failure on one drained queue item).
  useSession?: (chatKey: string, alias: string) => Promise<unknown>;
  // Override the fake session lookup. Returning a session with a `transportSession` makes the
  // executeTurn finally's post-turn `await getSession` window actually run (the C3 drain
  // hand-off window), so a test can act during that await.
  getSession?: (alias: string) => Promise<unknown>;
}) {
  const events = createControlEventBus();
  const seen: ControlEvent[] = [];
  events.subscribe((event) => seen.push(event));

  // Each in-flight agent.chat parks a resolver on `pending`. `nextChat` resolves them
  // one at a time IN ORDER (FIFO) so a test can finish turn N and watch the drain start
  // turn N+1 deterministically — no setTimeout races. `releaseChat` drains them all (used
  // by the single-turn Task 1 tests that never enqueue+drain).
  const pending: Array<() => void> = [];
  const chat = async (_request: ChatRequest): Promise<ChatResponse> => {
    await new Promise<void>((resolve) => {
      pending.push(resolve);
    });
    return { text: "done" };
  };

  const service = new ControlService({
    agent: { chat },
    sessions: {
      listAllResolvedSessions: () => [],
      useSession:
        opts?.useSession ??
        (async (_chatKey: string, alias: string) => ({ alias, agent: "claude", workspace: "/ws" })),
      resolveAliasForChat: async (_chatKey: string, alias: string) => alias,
      getSession: opts?.getSession ?? (async () => null),
    },
    activeTurns: { isActiveAnywhere: () => false },
    scheduled: {} as never,
    orchestration: {} as never,
    events,
  } as never);

  return {
    service,
    events: seen,
    releaseChat: () => {
      while (pending.length) pending.shift()!();
    },
    nextChat: () => {
      pending.shift()?.();
    },
  };
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

test("a second prompt while a turn is running is queued, not rejected, and emits queue-updated", async () => {
  const { service, events, releaseChat } = makeService();
  const p1 = service.prompt({ chatKey: "c", sessionAlias: "s", text: "first", senderId: "u" });
  // let turn 1 register as in-flight before sending the second
  await tick();
  const r2 = await service.prompt({ chatKey: "c", sessionAlias: "s", text: "second", senderId: "u" });
  expect(r2.ok).toBe(true);
  expect(r2.queued).toBe(true);
  expect(typeof r2.queueItemId).toBe("string");
  const qEvents = events.filter((e) => e.type === "queue-updated");
  expect(qEvents.at(-1)).toMatchObject({ chatKey: "c", sessionAlias: "s" });
  expect((qEvents.at(-1) as Extract<ControlEvent, { type: "queue-updated" }>).items.map((i) => i.textPreview)).toEqual([
    "second",
  ]);
  releaseChat();
  await p1;
});

test("scheduled turns are NOT queued (still reject) while a turn runs", async () => {
  const { service, releaseChat } = makeService();
  const p1 = service.prompt({ chatKey: "c", sessionAlias: "s", text: "first", senderId: "u" });
  await tick();
  const r = await service.runScheduledTurn({
    chatKey: "c",
    sessionAlias: "s",
    promptText: "sched",
    taskId: "t1",
    executeAt: "2026-07-01T00:00:00Z",
  });
  expect(r.ok).toBe(false);
  expect(r.errorMessage).toBe("turn-already-running");
  releaseChat();
  await p1;
});

type TurnStarted = Extract<ControlEvent, { type: "turn-started" }>;
type QueueUpdated = Extract<ControlEvent, { type: "queue-updated" }>;

test("queued prompts drain FIFO after the running turn finishes, each as its own turn", async () => {
  const { service, events, nextChat } = makeService();
  const p1 = service.prompt({ chatKey: "c", sessionAlias: "s", text: "first", senderId: "u" });
  await tick();
  await service.prompt({ chatKey: "c", sessionAlias: "s", text: "second", senderId: "u" });
  await service.prompt({ chatKey: "c", sessionAlias: "s", text: "third", senderId: "u" });
  nextChat();
  await tick(); // finish turn 1 → drain "second"
  const started = events.filter((e) => e.type === "turn-started") as TurnStarted[];
  // Drained turn carries queueItemId but NOT prompt (persistence already happened at
  // enqueue in the hub; re-emitting prompt would double-persist).
  expect(started.at(-1)!.queueItemId).toBeDefined();
  expect(started.at(-1)!.prompt).toBeUndefined();
  // queue now shows only "third"
  const q = (events.filter((e) => e.type === "queue-updated") as QueueUpdated[]).at(-1)!;
  expect(q.items.map((i) => i.textPreview)).toEqual(["third"]);
  nextChat();
  await tick(); // finish "second" → drain "third"
  nextChat();
  await tick(); // finish "third" → queue empty
  expect((events.filter((e) => e.type === "queue-updated") as QueueUpdated[]).at(-1)!.items).toEqual([]);
  await p1;
});

test("a prompt arriving during the drain hand-off is queued (no parallel turn)", async () => {
  const { service, nextChat } = makeService();
  const p1 = service.prompt({ chatKey: "c", sessionAlias: "s", text: "first", senderId: "u" });
  await tick();
  await service.prompt({ chatKey: "c", sessionAlias: "s", text: "second", senderId: "u" });
  nextChat(); // finish turn1; drain starts "second"
  const r3 = await service.prompt({ chatKey: "c", sessionAlias: "s", text: "third", senderId: "u" });
  expect(r3.queued).toBe(true); // saw the session busy, enqueued
  nextChat();
  nextChat();
  await p1;
});

test("a drained turn whose useSession fails still drains the following queued item (no stranded tail)", async () => {
  // Turn 1 (the running "first") binds fine on call 1. When it finishes, "second" drains and
  // its useSession throws (call 2). The tail ("third") must NOT be stranded: it should still
  // drain and start its own turn, and the queue must end empty. Without the fix, the drained
  // "second" turn early-returns before the finally's drain logic, orphaning "third".
  let useCount = 0;
  const { service, events, nextChat } = makeService({
    useSession: async (_chatKey: string, alias: string) => {
      useCount += 1;
      if (useCount === 2) throw new Error("transient bind failure");
      return { alias, agent: "claude", workspace: "/ws" };
    },
  });
  const p1 = service.prompt({ chatKey: "c", sessionAlias: "s", text: "first", senderId: "u" });
  await tick();
  await service.prompt({ chatKey: "c", sessionAlias: "s", text: "second", senderId: "u" });
  await service.prompt({ chatKey: "c", sessionAlias: "s", text: "third", senderId: "u" });

  nextChat(); // finish turn 1 → drain "second" (its useSession throws) → must go on to "third"
  await tick();

  // "first" started (no queueItemId); "second" failed at useSession BEFORE emitting
  // turn-started; "third" must still have started as its own drained turn.
  const started = events.filter((e) => e.type === "turn-started") as TurnStarted[];
  expect(started.length).toBe(2);
  expect(started.at(-1)!.queueItemId).toBeDefined(); // the drained "third"

  // The queue drained down to empty — nothing stranded behind the failed "second".
  const q = (events.filter((e) => e.type === "queue-updated") as QueueUpdated[]).at(-1)!;
  expect(q.items).toEqual([]);

  nextChat(); // finish "third" cleanly so no turn is left parked
  await tick();
  await p1;
});

test("a cancel that empties the queue during the drain hand-off clears draining (no wedge)", async () => {
  // C3 regression. When a turn finishes with a queued head, the `finally` sets `draining` and
  // then awaits a post-turn `getSession` (the sessions-changed detection). If a cancel empties
  // the queue DURING that await, advanceQueue takes its empty `else` branch — which must clear
  // `draining` too, else the guard leaks and every future prompt enqueues forever (the session
  // wedges: shows idle on web but nothing ever drains).
  const chatKey = "c";
  const alias = "s";
  const ref: { service?: ControlService; queuedId?: string } = {};
  // Armed right before we finish "first", so ONLY the finally's post-turn getSession (the drain
  // hand-off window, after `draining` was set) performs the cancel — not the earlier pre-turn or
  // streamMode getSession calls. Robust to how many getSession calls executeTurn makes.
  let armCancel = false;
  const { service, events, nextChat } = makeService({
    // Returning a transportSession makes the finally's post-turn getSession window actually run.
    getSession: async (a: string) => {
      if (armCancel && ref.queuedId) {
        armCancel = false;
        ref.service!.cancelQueuedItem(chatKey, alias, ref.queuedId);
      }
      return { alias: a, transportSession: "t1" };
    },
  });
  ref.service = service;

  const p1 = service.prompt({ chatKey, sessionAlias: alias, text: "first", senderId: "u" });
  await tick(); // "first" registers in-flight (pre-turn + streamMode getSession already ran, unarmed)
  const r2 = await service.prompt({ chatKey, sessionAlias: alias, text: "second", senderId: "u" });
  expect(r2.queued).toBe(true);
  ref.queuedId = r2.queueItemId!;

  armCancel = true;
  nextChat(); // finish "first": finally sets draining → next getSession cancels "second" → advanceQueue empty else
  await tick();
  await p1;

  // A fresh prompt must START a new turn, not enqueue. Pre-fix, `draining` leaked and this
  // prompt would resolve immediately with {queued:true}; post-fix it parks on the chat gate.
  let afterResult: unknown = "unresolved";
  const pAfter = service
    .prompt({ chatKey, sessionAlias: alias, text: "after", senderId: "u" })
    .then((r) => { afterResult = r; });
  await tick();
  expect(afterResult).toBe("unresolved"); // parked → a real turn started (not wedged/queued)
  const started = events.filter((e) => e.type === "turn-started") as TurnStarted[];
  expect(started.length).toBe(2); // "first" + the fresh "after"; the cancelled "second" never started
  expect(started.at(-1)!.queueItemId).toBeUndefined(); // a fresh user turn, not a drained queue item

  nextChat(); // release "after" so no turn is left parked
  await pAfter;
});

test("cancelQueuedItem removes a queued item and emits queue-updated; false for unknown id", async () => {
  const { service, events, releaseChat } = makeService();
  const p1 = service.prompt({ chatKey: "c", sessionAlias: "s", text: "first", senderId: "u" });
  await tick();
  const r2 = await service.prompt({ chatKey: "c", sessionAlias: "s", text: "second", senderId: "u" });
  expect(service.cancelQueuedItem("c", "s", r2.queueItemId!)).toEqual({ cancelled: true });
  expect((events.filter((e) => e.type === "queue-updated") as QueueUpdated[]).at(-1)!.items).toEqual([]);
  expect(service.cancelQueuedItem("c", "s", "nope")).toEqual({ cancelled: false });
  releaseChat();
  await p1;
});
