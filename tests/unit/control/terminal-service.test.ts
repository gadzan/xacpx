// tests/unit/control/terminal-service.test.ts
import { test, expect, mock } from "bun:test";
import { createTerminalService, type PtyHandle } from "../../../src/control/terminal-service";
import { createControlEventBus, type ControlEvent } from "../../../src/control/control-event-bus";

function fakePty() {
  let dataCb: (d: string) => void = () => {};
  let exitCb: (e: { exitCode: number }) => void = () => {};
  const handle: PtyHandle & { emitData: (d: string) => void; emitExit: (c: number) => void } = {
    onData: (cb) => { dataCb = cb; },
    onExit: (cb) => { exitCb = cb; },
    write: mock(() => {}),
    resize: mock(() => {}),
    kill: mock(() => {}),
    emitData: (d) => dataCb(d),
    emitExit: (c) => exitCb({ exitCode: c }),
  };
  return handle;
}

function setup(opts?: { idle?: number; platform?: NodeJS.Platform }) {
  const events = createControlEventBus();
  const captured: ControlEvent[] = [];
  events.subscribe((e) => captured.push(e));
  const pty = fakePty();
  const spawn = mock(() => pty);
  const svc = createTerminalService({
    events,
    idleTimeoutSeconds: () => opts?.idle ?? 900,
    spawn: spawn as never,
    platform: opts?.platform ?? "darwin",
  });
  return { svc, pty, spawn, captured };
}

test("create spawns a PTY with scrubbed env + cwd and returns a terminalId", () => {
  const { svc, spawn } = setup();
  process.env.ANTHROPIC_API_KEY = "secret";
  const { terminalId } = svc.create({ cwd: "/tmp/ws", cols: 100, rows: 30 });
  expect(typeof terminalId).toBe("string");
  expect(terminalId.length).toBeGreaterThan(0);
  const call = (spawn as ReturnType<typeof mock>).mock.calls[0];
  const opts = call[2] as { cwd: string; cols: number; rows: number; env: Record<string, string> };
  expect(opts.cwd).toBe("/tmp/ws");
  expect(opts.cols).toBe(100);
  expect(opts.rows).toBe(30);
  expect(opts.env.ANTHROPIC_API_KEY).toBeUndefined();
  expect(opts.env.TERM).toBe("xterm-256color");
  delete process.env.ANTHROPIC_API_KEY;
});

test("PTY data emits terminal-output with monotonic seq", () => {
  const { svc, pty, captured } = setup();
  const { terminalId } = svc.create({ cwd: "/tmp/ws", cols: 80, rows: 24 });
  pty.emitData("hello");
  pty.emitData("world");
  const outs = captured.filter((e) => e.type === "terminal-output") as Extract<ControlEvent, { type: "terminal-output" }>[];
  expect(outs.map((o) => [o.terminalId, o.seq, o.data])).toEqual([
    [terminalId, 0, "hello"],
    [terminalId, 1, "world"],
  ]);
});

test("write/resize/close proxy to the PTY; exit emits terminal-exit", () => {
  const { svc, pty, captured } = setup();
  const { terminalId } = svc.create({ cwd: "/tmp/ws", cols: 80, rows: 24 });
  svc.write(terminalId, "ls\n");
  expect((pty.write as ReturnType<typeof mock>).mock.calls[0][0]).toBe("ls\n");
  svc.resize(terminalId, 120, 40);
  expect((pty.resize as ReturnType<typeof mock>).mock.calls[0]).toEqual([120, 40]);
  svc.close(terminalId);
  expect((pty.kill as ReturnType<typeof mock>).mock.calls.length).toBe(1);
  pty.emitExit(0);
  const exit = captured.find((e) => e.type === "terminal-exit") as Extract<ControlEvent, { type: "terminal-exit" }>;
  expect(exit).toEqual({ type: "terminal-exit", terminalId, code: 0 });
});

test("write/resize/close on an unknown terminalId are no-ops (no throw)", () => {
  const { svc } = setup();
  expect(() => svc.write("nope", "x")).not.toThrow();
  expect(() => svc.resize("nope", 1, 1)).not.toThrow();
  expect(() => svc.close("nope")).not.toThrow();
});

test("create throws terminal-unsupported-platform on win32", () => {
  const { svc } = setup({ platform: "win32" });
  expect(() => svc.create({ cwd: "/tmp/ws", cols: 80, rows: 24 })).toThrow("terminal-unsupported-platform");
});

// ── Idle timer behavior (Fix 1) ──────────────────────────────────────────────
// Uses fake timer injection so tests are deterministic, not real-time.

function setupWithFakeTimer(opts?: { idle?: number; platform?: NodeJS.Platform }) {
  let pendingFn: (() => void) | null = null;
  let timerId = 0;
  let setTimerCount = 0;
  const setTimer = (fn: () => void, _ms: number): unknown => {
    pendingFn = fn;
    setTimerCount++;
    return ++timerId;
  };
  const clearTimer = (_id: unknown) => { pendingFn = null; };
  /** Fire the currently pending idle timer, if any. */
  const tick = () => { const fn = pendingFn; pendingFn = null; fn?.(); };
  /** True when a pending timer exists. */
  const hasPending = () => pendingFn !== null;

  const events = createControlEventBus();
  const pty = fakePty();
  const spawn = mock(() => pty);
  const svc = createTerminalService({
    events,
    idleTimeoutSeconds: () => opts?.idle ?? 900,
    spawn: spawn as never,
    platform: opts?.platform ?? "darwin",
    setTimer,
    clearTimer,
  });
  return { svc, pty, spawn, tick, hasPending, getSetTimerCount: () => setTimerCount };
}

test("idle: PTY output (onData) does NOT reset the idle timer", () => {
  // Create a terminal — this queues the initial idle timer.
  const { svc, pty, tick, getSetTimerCount } = setupWithFakeTimer();
  svc.create({ cwd: "/tmp/ws", cols: 80, rows: 24 });

  // Emit several output frames — must NOT replace the pending idle timer.
  pty.emitData("line1\r\n");
  pty.emitData("line2\r\n");
  pty.emitData("line3\r\n");

  // Verify that setTimer was called exactly once (at create), not again on output.
  // If output handler incorrectly calls resetIdle, this count would be >1.
  expect(getSetTimerCount()).toBe(1);

  // The original idle timer is still pending; firing it kills the PTY.
  tick();
  expect((pty.kill as ReturnType<typeof mock>).mock.calls.length).toBe(1);
});

test("idle: write() DOES reset the idle timer", () => {
  const { svc, pty, tick, hasPending } = setupWithFakeTimer();
  const { terminalId } = svc.create({ cwd: "/tmp/ws", cols: 80, rows: 24 });
  // Timer queued from create; write() clears and resets it.
  svc.write(terminalId, "ls\n");
  // A fresh timer should still be pending.
  expect(hasPending()).toBe(true);
  // Firing it kills the PTY.
  tick();
  expect((pty.kill as ReturnType<typeof mock>).mock.calls.length).toBe(1);
});

test("idle: resize() DOES reset the idle timer", () => {
  const { svc, pty, tick, hasPending } = setupWithFakeTimer();
  const { terminalId } = svc.create({ cwd: "/tmp/ws", cols: 80, rows: 24 });

  // resize() should clear the initial timer and install a fresh one.
  svc.resize(terminalId, 120, 40);
  expect(hasPending()).toBe(true);
  tick();
  expect((pty.kill as ReturnType<typeof mock>).mock.calls.length).toBe(1);
});

test("idle: output does not block kill; only user input extends lifetime", () => {
  // Comprehensive: output + then write; only write extends lifetime.
  const { svc, pty, tick } = setupWithFakeTimer();
  const { terminalId } = svc.create({ cwd: "/tmp/ws", cols: 80, rows: 24 });

  // Output spam — must not reset idle.
  pty.emitData("a"); pty.emitData("b"); pty.emitData("c");
  // User input resets idle.
  svc.write(terminalId, "\r");
  // More output — still must not reset idle.
  pty.emitData("d"); pty.emitData("e");
  // Kill not yet called.
  expect((pty.kill as ReturnType<typeof mock>).mock.calls.length).toBe(0);
  // Fire idle → kill called.
  tick();
  expect((pty.kill as ReturnType<typeof mock>).mock.calls.length).toBe(1);
});

// ── disposeAll (Fix 2) ────────────────────────────────────────────────────────

test("disposeAll clears timers and kills all PTYs without throwing", () => {
  const { svc, pty, hasPending } = setupWithFakeTimer();
  svc.create({ cwd: "/tmp/ws", cols: 80, rows: 24 });
  expect(hasPending()).toBe(true);
  svc.disposeAll();
  // Idle timer must be cleared (no stale fire after dispose).
  expect(hasPending()).toBe(false);
  expect((pty.kill as ReturnType<typeof mock>).mock.calls.length).toBe(1);
});
