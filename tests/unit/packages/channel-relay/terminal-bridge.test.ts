import { test, expect, mock } from "bun:test";
import { MSG, RELAY_PROTOCOL_VERSION, type RelayEnvelope } from "@ganglion/xacpx-relay-protocol";
import { dispatchControlEvent } from "../../../../packages/channel-relay/src/control-bridge";
import {
  handleTerminalEvent,
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

test("resumed controller is resized to requested geometry before terminal-open succeeds", async () => {
  const order: string[] = [];
  const resize = mock(async () => { order.push("resize"); });
  const detach = mock(() => { order.push("detach"); });
  const runtime = {
    openOrResume: mock(async () => {
      order.push("open");
      return {
        terminalId: "term-1",
        generation: "g1",
        attachmentId: "att-1",
        role: "controller" as const,
        viewerCount: 1,
        openKind: "resumed" as const,
      };
    }),
    resize,
    detach,
  };
  const responses: unknown[] = [];
  await handleTerminalRequest(
    runtime as never,
    {
      protocolVersion: RELAY_PROTOCOL_VERSION,
      kind: "req",
      id: "t-resume",
      type: MSG.terminalOpen,
      payload: {
        chatKey: "relay:u1",
        sessionAlias: "demo",
        viewerId: "v1",
        cols: 132,
        rows: 47,
      },
    },
    (payload) => responses.push(payload),
  );

  expect(order).toEqual(["open", "resize"]);
  expect(resize).toHaveBeenCalledWith("att-1", "g1", 132, 47);
  expect(detach).not.toHaveBeenCalled();
  expect(responses[0]).toEqual({
    terminalId: "term-1",
    generation: "g1",
    attachmentId: "att-1",
    role: "controller",
    viewerCount: 1,
  });
});

test("resumed spectator never resizes the shared pane", async () => {
  const resize = mock(async () => {});
  const runtime = {
    openOrResume: mock(async () => ({
      terminalId: "term-1",
      generation: "g1",
      attachmentId: "att-2",
      role: "spectator" as const,
      viewerCount: 2,
      openKind: "resumed" as const,
    })),
    resize,
  };
  const responses: unknown[] = [];
  await handleTerminalRequest(
    runtime as never,
    {
      protocolVersion: RELAY_PROTOCOL_VERSION,
      kind: "req",
      id: "t-spectator",
      type: MSG.terminalOpen,
      payload: {
        chatKey: "relay:u1",
        sessionAlias: "demo",
        viewerId: "v2",
        cols: 150,
        rows: 50,
      },
    },
    (payload) => responses.push(payload),
  );

  expect(resize).not.toHaveBeenCalled();
  expect(responses).toHaveLength(1);
});

test("resumed controller resize failure rolls back the unpublished attachment", async () => {
  const detach = mock(() => {});
  const runtime = {
    openOrResume: mock(async () => ({
      terminalId: "term-1",
      generation: "g1",
      attachmentId: "att-1",
      role: "controller" as const,
      viewerCount: 1,
      openKind: "resumed" as const,
    })),
    resize: mock(async () => {
      throw new Error("resize failed");
    }),
    detach,
  };
  const responses: unknown[] = [];
  await handleTerminalRequest(
    runtime as never,
    {
      protocolVersion: RELAY_PROTOCOL_VERSION,
      kind: "req",
      id: "t-resume-fail",
      type: MSG.terminalOpen,
      payload: {
        chatKey: "relay:u1",
        sessionAlias: "demo",
        viewerId: "v1",
        cols: 132,
        rows: 47,
      },
    },
    (payload) => responses.push(payload),
  );

  expect(detach).toHaveBeenCalledWith("att-1");
  expect(responses).toEqual([
    { error: { code: "terminal-rmux-unavailable", message: "resize failed" } },
  ]);
});

test("malformed terminal-open payload returns invalid-payload and does not call runtime", async () => {
  const runtime = {
    openOrResume: mock(async () => {
      throw new Error("should not run");
    }),
  };
  const responses: unknown[] = [];
  await handleTerminalRequest(
    runtime as never,
    {
      protocolVersion: RELAY_PROTOCOL_VERSION,
      kind: "req",
      id: "t-open-bad",
      type: MSG.terminalOpen,
      payload: {
        chatKey: "relay:u1",
        sessionAlias: "demo",
        viewerId: "v1",
        cols: 9999,
        rows: 24,
      },
    },
    (payload) => responses.push(payload),
  );
  expect(responses[0]).toEqual({
    error: { code: "invalid-payload", message: `${MSG.terminalOpen}: malformed payload` },
  });
  expect((runtime.openOrResume as ReturnType<typeof mock>).mock.calls.length).toBe(0);
});

test("malformed terminal event is dropped with zero runtime side effects", async () => {
  const runtime = {
    resize: mock(async () => {
      throw new Error("should not run");
    }),
    input: mock(async () => {
      throw new Error("should not run");
    }),
    startRecovery: mock(async () => {
      throw new Error("should not run");
    }),
    heartbeat: mock(() => {
      throw new Error("should not run");
    }),
    detach: mock(() => {
      throw new Error("should not run");
    }),
  };
  const consumed = await handleTerminalEvent(runtime as never, {
    protocolVersion: RELAY_PROTOCOL_VERSION,
    kind: "event",
    type: MSG.terminalResize,
    payload: {
      attachmentId: "att-1",
      generation: "g1",
      viewerId: "v1",
      cols: 9999,
      rows: 24,
    },
  });
  expect(consumed).toBe(true);
  expect((runtime.resize as ReturnType<typeof mock>).mock.calls.length).toBe(0);
});