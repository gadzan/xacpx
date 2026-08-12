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

test("late timed-out create compensates via compensateTimedOutOpen", async () => {
  let release!: (value: {
    terminalId: string;
    generation: string;
    attachmentId: string;
    role: "controller";
    viewerCount: number;
    openKind: "created";
  }) => void;
  const openGate = new Promise<{
    terminalId: string;
    generation: string;
    attachmentId: string;
    role: "controller";
    viewerCount: number;
    openKind: "created";
  }>((resolve) => {
    release = resolve;
  });
  const compensateTimedOutOpen = mock(async () => {});
  const runtime = {
    openOrResume: mock(async () => openGate),
    compensateTimedOutOpen,
    terminate: mock(async () => ({ status: "terminated" })),
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
  timers[0]!.fn();
  expect(responses).toEqual([
    expect.objectContaining({ error: expect.objectContaining({ code: "timeout" }) }),
  ]);

  const result = {
    terminalId: "term-1",
    generation: "g1",
    attachmentId: "att-1",
    role: "controller" as const,
    viewerCount: 1,
    openKind: "created" as const,
  };
  release(result);
  await done;
  expect(compensateTimedOutOpen).toHaveBeenCalledWith(result);
  expect(runtime.terminate).not.toHaveBeenCalled();
  expect(responses).toHaveLength(1);
});

test("late timed-out open strips openKind from successful wire responses", async () => {
  const runtime = {
    openOrResume: mock(async () => ({
      terminalId: "term-1",
      generation: "g1",
      attachmentId: "att-1",
      role: "controller" as const,
      viewerCount: 1,
      openKind: "created" as const,
    })),
    compensateTimedOutOpen: mock(async () => {}),
  };
  const responses: unknown[] = [];
  await handleTerminalRequest(
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
    },
    (payload) => responses.push(payload),
  );
  expect(responses[0]).toEqual({
    terminalId: "term-1",
    generation: "g1",
    attachmentId: "att-1",
    role: "controller",
    viewerCount: 1,
  });
  expect((responses[0] as { openKind?: string }).openKind).toBeUndefined();
});
