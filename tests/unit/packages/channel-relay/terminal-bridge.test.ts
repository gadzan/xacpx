import { test, expect, mock } from "bun:test";
import { MSG, RELAY_PROTOCOL_VERSION, type RelayEnvelope } from "@ganglion/xacpx-relay-protocol";
import { dispatchControlEvent } from "../../../../packages/channel-relay/src/control-bridge";
import {
  handleTerminalRequest,
  terminalRequestDeadlineAt,
} from "../../../../packages/channel-relay/src/terminal-bridge";

function fakeControl() {
  return {
    createTerminal: mock(async () => ({ terminalId: "t1" })),
    writeTerminal: mock(() => {}),
    resizeTerminal: mock(() => {}),
    closeTerminal: mock(() => {}),
  };
}

test("dispatchControlEvent routes terminal.input to writeTerminal", () => {
  const control = fakeControl();
  const env: RelayEnvelope = { protocolVersion: RELAY_PROTOCOL_VERSION, kind: "event", type: MSG.terminalInput, payload: { terminalId: "t1", data: "ls\n" } };
  dispatchControlEvent(control as never, env);
  expect((control.writeTerminal as ReturnType<typeof mock>).mock.calls[0]).toEqual(["t1", "ls\n"]);
});

test("dispatchControlEvent routes terminal.resize and terminal.close", () => {
  const control = fakeControl();
  dispatchControlEvent(control as never, { protocolVersion: RELAY_PROTOCOL_VERSION, kind: "event", type: MSG.terminalResize, payload: { terminalId: "t1", cols: 90, rows: 20 } });
  dispatchControlEvent(control as never, { protocolVersion: RELAY_PROTOCOL_VERSION, kind: "event", type: MSG.terminalClose, payload: { terminalId: "t1" } });
  expect((control.resizeTerminal as ReturnType<typeof mock>).mock.calls[0]).toEqual(["t1", 90, 20]);
  expect((control.closeTerminal as ReturnType<typeof mock>).mock.calls[0]).toEqual(["t1"]);
});

test("dispatchControlEvent ignores unrelated event types", () => {
  const control = fakeControl();
  dispatchControlEvent(control as never, { protocolVersion: RELAY_PROTOCOL_VERSION, kind: "event", type: "instance.something", payload: {} });
  expect((control.writeTerminal as ReturnType<typeof mock>).mock.calls.length).toBe(0);
});

test("terminalRequestDeadlineAt prefers the nearer of absolute and received+budget", () => {
  const now = () => 1_000_000;
  expect(terminalRequestDeadlineAt({
    requestDeadlineAt: 1_000_500,
    requestBudgetMs: 30_000,
  }, now)).toBe(1_000_500);
  expect(terminalRequestDeadlineAt({
    requestDeadlineAt: 1_040_000,
    requestBudgetMs: 100,
  }, now)).toBe(1_000_100);
  expect(terminalRequestDeadlineAt({}, now)).toBeUndefined();
});

test("handleTerminalRequest times out open and compensate-kills late create", async () => {
  let release!: (value: { terminalId: string; generation: string }) => void;
  const openGate = new Promise<{ terminalId: string; generation: string }>((resolve) => {
    release = resolve;
  });
  const terminate = mock(async () => ({ ok: true }));
  const runtime = {
    openOrResume: mock(async () => openGate),
    terminate,
  };

  const responses: unknown[] = [];
  const timers: Array<{ fn: () => void; ms: number }> = [];
  const done = handleTerminalRequest(
    runtime as never,
    {
      protocolVersion: RELAY_PROTOCOL_VERSION,
      kind: "req",
      id: "t-open",
      type: MSG.terminalOpen,
      payload: {
        chatKey: "relay:u1",
        sessionAlias: "demo",
        viewerId: "v1",
        cols: 80,
        rows: 24,
      },
      requestDeadlineAt: 1_050,
      requestBudgetMs: 50,
    },
    (payload) => responses.push(payload),
    {
      now: () => 1_000,
      setTimeoutFn: (fn, ms) => {
        timers.push({ fn, ms });
        return timers.length;
      },
      clearTimeoutFn: () => {},
    },
  );

  expect(timers).toHaveLength(1);
  expect(timers[0]?.ms).toBe(50);
  timers[0]!.fn();
  expect(responses).toEqual([
    expect.objectContaining({ error: expect.objectContaining({ code: "timeout" }) }),
  ]);

  release({ terminalId: "term-1", generation: "g1" });
  await done;
  expect(terminate).toHaveBeenCalledWith({
    terminalId: "term-1",
    generation: "g1",
    reason: "explicit-close",
  });
  expect(responses).toHaveLength(1);
});
