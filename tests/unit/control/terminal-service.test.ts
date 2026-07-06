// tests/unit/control/terminal-service.test.ts
import { test, expect, mock } from "bun:test";
import { createTerminalService, resolveShell, type PtyHandle } from "../../../src/control/terminal-service";
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

function setup(opts?: { idle?: number; platform?: NodeJS.Platform; shell?: () => string | undefined }) {
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
    shell: opts?.shell,
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

// ── attach() / ring buffer (content replay, layer 3) ────────────────────────

test("attach returns ok:false for an unknown terminal", () => {
  const { svc } = setup();
  expect(svc.attach("nope")).toEqual({ ok: false });
});

test("attach returns buffered output + lastSeq for a live terminal", () => {
  const { svc, pty } = setup();
  const { terminalId } = svc.create({ cwd: "/tmp/ws", cols: 80, rows: 24 });
  pty.emitData("hello\n");
  pty.emitData("world\n");
  const res = svc.attach(terminalId);
  expect(res).toEqual({ ok: true, buffer: "hello\nworld\n", lastSeq: 1 }); // seq 0,1 emitted → lastSeq 1
});

test("attach on a terminal with no output yet returns lastSeq -1", () => {
  const { svc } = setup();
  const { terminalId } = svc.create({ cwd: "/tmp/ws", cols: 80, rows: 24 });
  expect(svc.attach(terminalId)).toEqual({ ok: true, buffer: "", lastSeq: -1 });
});

test("attach returns ok:false after close", () => {
  const { svc, pty } = setup();
  const { terminalId } = svc.create({ cwd: "/tmp/ws", cols: 80, rows: 24 });
  pty.emitData("x");
  pty.emitExit(0); // exit deletes the session
  expect(svc.attach(terminalId)).toEqual({ ok: false });
});

test("ring buffer trims oldest whole lines past 256KB (keeps tail, cuts at newline)", () => {
  const { svc, pty } = setup();
  const { terminalId } = svc.create({ cwd: "/tmp/ws", cols: 80, rows: 24 });
  // 300 lines of ~1KB each ≈ 300KB > 256KB cap
  for (let i = 0; i < 300; i++) pty.emitData("L" + i + ":" + "x".repeat(1000) + "\n");
  const res = svc.attach(terminalId);
  if (!res.ok) throw new Error("expected ok");
  expect(Buffer.byteLength(res.buffer, "utf8")).toBeLessThanOrEqual(256 * 1024);
  // oldest lines dropped, newest retained; buffer starts at a line boundary (no partial leading line)
  expect(res.buffer.startsWith("L")).toBe(true);
  expect(res.buffer.endsWith("\n")).toBe(true);
  expect(res.buffer).toContain("L299:");
  expect(res.buffer).not.toContain("L0:");
});

test("create no longer throws on win32 and spawns the resolved shell", () => {
  const { svc, spawn } = setup({ platform: "win32", shell: () => "C:/win/pwsh.exe" });
  expect(() => svc.create({ cwd: "C:/ws", cols: 80, rows: 24 })).not.toThrow();
  const call = (spawn as ReturnType<typeof mock>).mock.calls[0];
  expect(call[0]).toBe("C:/win/pwsh.exe"); // shellOverride from config wins
});

test("create uses resolveShell (darwin default /bin/zsh) when no override", () => {
  const { svc, spawn } = setup(); // darwin, no shell override, no SHELL guaranteed? force it
  const prev = process.env.SHELL;
  delete process.env.SHELL;
  svc.create({ cwd: "/tmp/ws", cols: 80, rows: 24 });
  const call = (spawn as ReturnType<typeof mock>).mock.calls[0];
  expect(call[0]).toBe("/bin/zsh");
  if (prev !== undefined) process.env.SHELL = prev;
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

// ── PTY throw safety (Fix 1b hardening) ─────────────────────────────────────

test("write(): a throwing PTY handle does not propagate out of the service", () => {
  const events = createControlEventBus();
  const pty = fakePty();
  (pty.write as ReturnType<typeof mock>).mockImplementation(() => { throw new Error("PTY already dead"); });
  const spawn = mock(() => pty);
  const svc = createTerminalService({ events, idleTimeoutSeconds: () => 900, spawn: spawn as never, platform: "darwin" });
  const { terminalId } = svc.create({ cwd: "/tmp/ws", cols: 80, rows: 24 });
  expect(() => svc.write(terminalId, "x")).not.toThrow();
});

test("resize(): a throwing PTY handle does not propagate out of the service", () => {
  const events = createControlEventBus();
  const pty = fakePty();
  (pty.resize as ReturnType<typeof mock>).mockImplementation(() => { throw new Error("PTY already dead"); });
  const spawn = mock(() => pty);
  const svc = createTerminalService({ events, idleTimeoutSeconds: () => 900, spawn: spawn as never, platform: "darwin" });
  const { terminalId } = svc.create({ cwd: "/tmp/ws", cols: 80, rows: 24 });
  expect(() => svc.resize(terminalId, 90, 20)).not.toThrow();
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

// ── resolveShell ─────────────────────────────────────────────────────────────
const noExist = () => false;

test("resolveShell: explicit shellOverride wins on any platform", () => {
  expect(resolveShell({ platform: "win32", env: {}, shellOverride: "C:/tools/nu.exe", exists: noExist })).toBe("C:/tools/nu.exe");
  expect(resolveShell({ platform: "darwin", env: { SHELL: "/bin/zsh" }, shellOverride: "/bin/fish" })).toBe("/bin/fish");
  // blank override is ignored (falls through to platform default)
  expect(resolveShell({ platform: "linux", env: { SHELL: "/bin/bash" }, shellOverride: "   " })).toBe("/bin/bash");
});

test("resolveShell: unix honors SHELL then falls to zsh(darwin)/bash(other) — unchanged", () => {
  expect(resolveShell({ platform: "darwin", env: { SHELL: "/opt/homebrew/bin/fish" } })).toBe("/opt/homebrew/bin/fish");
  expect(resolveShell({ platform: "darwin", env: {} })).toBe("/bin/zsh");
  expect(resolveShell({ platform: "linux", env: {} })).toBe("/bin/bash");
});

test("resolveShell: win32 IGNORES SHELL and scans PATH pwsh -> powershell -> ComSpec -> cmd", () => {
  const PATH = "C:\\Windows\\System32;C:\\PS7";
  // SHELL set to an MSYS path (git-bash) must be ignored on win32
  const env = { SHELL: "/usr/bin/bash", PATH, ComSpec: "C:\\Windows\\System32\\cmd.exe" };
  // pwsh present anywhere in PATH wins
  const pwshExists = (p: string) => p === "C:\\PS7\\pwsh.exe";
  expect(resolveShell({ platform: "win32", env, exists: pwshExists })).toBe("C:\\PS7\\pwsh.exe");
  // no pwsh, powershell present in System32
  const psExists = (p: string) => p === "C:\\Windows\\System32\\powershell.exe";
  expect(resolveShell({ platform: "win32", env, exists: psExists })).toBe("C:\\Windows\\System32\\powershell.exe");
  // neither present -> ComSpec
  expect(resolveShell({ platform: "win32", env, exists: noExist })).toBe("C:\\Windows\\System32\\cmd.exe");
  // neither present and no ComSpec -> literal cmd.exe
  expect(resolveShell({ platform: "win32", env: { PATH }, exists: noExist })).toBe("cmd.exe");
});

test("resolveShell: win32 prefers pwsh over powershell when both exist", () => {
  const env = { PATH: "C:\\A;C:\\B" };
  const bothExist = (p: string) => p === "C:\\B\\pwsh.exe" || p === "C:\\A\\powershell.exe";
  expect(resolveShell({ platform: "win32", env, exists: bothExist })).toBe("C:\\B\\pwsh.exe");
});

test("resolveShell: win32 strips surrounding quotes from PATH entries", () => {
  const env = { PATH: "\"C:\\PS7\";C:\\Windows\\System32" };
  const exists = (p: string) => p === "C:\\PS7\\pwsh.exe"; // unquoted form
  expect(resolveShell({ platform: "win32", env, exists })).toBe("C:\\PS7\\pwsh.exe");
});
