import { expect, test } from "bun:test";
import { SessionTurnRunner } from "../../../src/control/session-turn-runner";
import { TURN_IDLE_TIMEOUT } from "../../../src/control/turn-support";
import { createControlEventBus, type ControlEvent } from "../../../src/control/control-event-bus";

// Minimal deps: a fake agent whose chat() invokes the streaming callbacks we want to
// observe, then resolves; sessions/uploadStore stubbed just enough for run() to proceed.
function makeRunner(chat: (opts: any) => Promise<{ text?: string }>) {
  const events = createControlEventBus();
  const captured: ControlEvent[] = [];
  events.subscribe((e) => captured.push(e));
  const runner = new SessionTurnRunner({
    agent: { chat },
    sessions: {
      resolveAliasForChat: async (_c: string, a: string) => a,
      getSession: async () => ({ transportSession: "t", replyMode: "stream" }),
      useSession: async () => {},
    },
    events,
    uploadStore: { root: "/tmp/uploads" },
  } as never);
  return { runner, captured };
}

const REQ = { chatKey: "c", sessionAlias: "s", text: "hi", senderId: "u" };

test("onActivity is invoked on each agent event", async () => {
  let calls = 0;
  const { runner } = makeRunner(async (opts) => {
    await opts.reply("chunk");
    opts.onThought("t");
    opts.onToolEvent({ id: "x" });
    opts.onUsage({ used: 1, size: 2 });
    opts.onPlan([]);
    opts.onCommands([]);
    return { text: "done" };
  });
  await runner.run(REQ as never, new AbortController().signal, () => { calls++; });
  expect(calls).toBeGreaterThanOrEqual(6);
});

test("a clean turn with no abort emits turn-finished ok:true", async () => {
  const { runner, captured } = makeRunner(async () => ({ text: "final" }));
  const result = await runner.run(REQ as never, new AbortController().signal);
  expect(result.ok).toBe(true);
  const fin = captured.find((e) => e.type === "turn-finished") as Extract<ControlEvent, { type: "turn-finished" }>;
  expect(fin.ok).toBe(true);
});

test("a TURN_IDLE_TIMEOUT abort surfaces as ok:false + timeout errorMessage, NOT cancelled", async () => {
  const controller = new AbortController();
  const { runner, captured } = makeRunner(async () => {
    controller.abort(TURN_IDLE_TIMEOUT); // simulate the watchdog firing mid-chat
    throw new Error("aborted");           // the transport throws on abort
  });
  await runner.run(REQ as never, controller.signal);
  const fin = captured.find((e) => e.type === "turn-finished") as Extract<ControlEvent, { type: "turn-finished" }>;
  expect(fin.ok).toBe(false);
  expect(fin.errorMessage).toBe("Turn timed out due to inactivity");
  expect("cancelled" in fin).toBe(false); // distinct from a user Stop
});

test("a plain user-Stop abort still surfaces as cancelled:true", async () => {
  const controller = new AbortController();
  const { runner, captured } = makeRunner(async () => {
    controller.abort(); // user Stop — no reason
    throw new Error("aborted");
  });
  await runner.run(REQ as never, controller.signal);
  const fin = captured.find((e) => e.type === "turn-finished") as Extract<ControlEvent, { type: "turn-finished" }>;
  expect(fin.ok).toBe(false);
  expect(fin.cancelled).toBe(true);
});
