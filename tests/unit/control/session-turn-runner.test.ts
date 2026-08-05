import { expect, test } from "bun:test";
import { SessionTurnRunner } from "../../../src/control/session-turn-runner";
import { TURN_IDLE_TIMEOUT_REASON } from "../../../src/control/turn-support";
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

test("a clean turn with no abort emits turn-finished ok:true carrying the reply text", async () => {
  const { runner, captured } = makeRunner(async () => ({ text: "final" }));
  const result = await runner.run(REQ as never, new AbortController().signal);
  expect(result.ok).toBe(true);
  const fin = captured.find((e) => e.type === "turn-finished") as Extract<ControlEvent, { type: "turn-finished" }>;
  expect(fin.ok).toBe(true);
  // The final reply rides along so a relay hub that lost the streamed chunks can persist it.
  expect(fin.text).toBe("final");
});

test("turn-finished.text accumulates ALL emitted chunks when response.text is missing", async () => {
  const { runner, captured } = makeRunner(async (opts) => {
    await opts.reply("part 1");
    await opts.reply("part 2");
    return { text: undefined }; // streaming adapter: the final text is never set
  });
  const result = await runner.run(REQ as never, new AbortController().signal);
  expect(result.ok).toBe(true);
  const fin = captured.find((e) => e.type === "turn-finished") as Extract<ControlEvent, { type: "turn-finished" }>;
  // stream mode concatenates verbatim — the relay hub's no-buffer fallback must get
  // the FULL reply, not an empty or last-segment-only text.
  expect(fin.text).toBe("part 1part 2");
  expect(captured.filter((e) => e.type === "turn-output")).toHaveLength(2);
});

test("a TURN_IDLE_TIMEOUT_REASON abort surfaces as ok:false + timeout errorMessage, NOT cancelled", async () => {
  const controller = new AbortController();
  const { runner, captured } = makeRunner(async () => {
    controller.abort(TURN_IDLE_TIMEOUT_REASON); // simulate the watchdog firing mid-chat
    throw new Error("aborted");           // the transport throws on abort
  });
  await runner.run(REQ as never, controller.signal);
  const fin = captured.find((e) => e.type === "turn-finished") as Extract<ControlEvent, { type: "turn-finished" }>;
  expect(fin.ok).toBe(false);
  expect(fin.errorMessage).toBe("Turn timed out due to inactivity");
  expect("cancelled" in fin).toBe(false); // distinct from a user Stop
  expect("text" in fin).toBe(false); // failure paths never carry reply text
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
  expect("text" in fin).toBe(false); // failure paths never carry reply text
});
