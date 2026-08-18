// tests/unit/control/terminal-service.test.ts
import { test, expect, mock } from "bun:test";
import {
  createTerminalService,
  resolveShell,
  type PtyHandle,
} from "../../../src/control/terminal-service";
import {
  createControlEventBus,
  type ControlEvent,
} from "../../../src/control/control-event-bus";

function fakePty() {
  let dataCb: (d: string) => void = () => {};
  let exitCb: (e: { exitCode: number }) => void = () => {};
  const handle: PtyHandle & {
    emitData: (d: string) => void;
    emitExit: (c: number) => void;
  } = {
    onData: (cb) => {
      dataCb = cb;
    },
    onExit: (cb) => {
      exitCb = cb;
    },
    write: mock(() => {}),
    resize: mock(() => {}),
    kill: mock(() => {}),
    emitData: (d) => dataCb(d),
    emitExit: (c) => exitCb({ exitCode: c }),
  };
  return handle;
}

function setup(opts?: {
  idle?: number;
  platform?: NodeJS.Platform;
  shell?: () => string | undefined;
}) {
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
  const opts = call[2] as {
    cwd: string;
    cols: number;
    rows: number;
    env: Record<string, string>;
  };
  expect(opts.cwd).toBe("/tmp/ws");
  expect(opts.cols).toBe(100);
  expect(opts.rows).toBe(30);
  expect(opts.env.ANTHROPIC_API_KEY).toBeUndefined();
  expect(opts.env.TERM).toBe("xterm-256color");
  delete process.env.ANTHROPIC_API_KEY;
});

test("coalesces multiple output chunks within a window into one terminal-output", () => {
  const { svc, pty, captured, fireFlush } = setupWithFakeTimer();
  const { terminalId } = svc.create({ cwd: "/tmp/ws", cols: 80, rows: 24 });
  pty.emitData("foo");
  pty.emitData("bar");
  pty.emitData("baz");
  // Still inside the coalesce window — nothing emitted yet.
  expect(captured.filter((e) => e.type === "terminal-output").length).toBe(0);
  fireFlush();
  const outs = captured.filter((e) => e.type === "terminal-output") as Extract<
    ControlEvent,
    { type: "terminal-output" }
  >[];
  expect(outs.length).toBe(1);
  expect(outs[0]).toEqual({
    type: "terminal-output",
    terminalId,
    seq: 0,
    data: "foobarbaz",
  });
});

test("seq is monotonic across coalesced windows", () => {
  const { svc, pty, captured, fireFlush } = setupWithFakeTimer();
  svc.create({ cwd: "/tmp/ws", cols: 80, rows: 24 });
  pty.emitData("a");
  fireFlush();
  pty.emitData("b");
  fireFlush();
  const outs = captured.filter((e) => e.type === "terminal-output") as Extract<
    ControlEvent,
    { type: "terminal-output" }
  >[];
  expect(outs.map((o) => [o.seq, o.data])).toEqual([
    [0, "a"],
    [1, "b"],
  ]);
});

test("a burst >= COALESCE_MAX_BYTES flushes immediately (no window wait)", () => {
  const { svc, pty, captured } = setupWithFakeTimer();
  svc.create({ cwd: "/tmp/ws", cols: 80, rows: 24 });
  const big = "x".repeat(64 * 1024); // 64KB of ascii == COALESCE_MAX_BYTES
  pty.emitData(big);
  const outs = captured.filter((e) => e.type === "terminal-output") as Extract<
    ControlEvent,
    { type: "terminal-output" }
  >[];
  expect(outs.length).toBe(1); // emitted synchronously, before any fireFlush()
  expect(outs[0]!.seq).toBe(0);
  expect(outs[0]!.data).toBe(big);
});

test("exit flushes pending output before emitting terminal-exit", () => {
  const { svc, pty, captured } = setupWithFakeTimer();
  const { terminalId } = svc.create({ cwd: "/tmp/ws", cols: 80, rows: 24 });
  pty.emitData("tail-end"); // armed in the window, not yet flushed
  pty.emitExit(0);
  const types = captured.map((e) => e.type);
  const outIdx = types.indexOf("terminal-output");
  const exitIdx = types.indexOf("terminal-exit");
  expect(outIdx).toBeGreaterThanOrEqual(0);
  expect(exitIdx).toBeGreaterThan(outIdx); // output strictly BEFORE exit
  expect(captured[outIdx]).toEqual({
    type: "terminal-output",
    terminalId,
    seq: 0,
    data: "tail-end",
  });
});

test("disposeAll clears a pending flush timer (no stale flush after dispose)", () => {
  const { svc, pty, hasFlushPending } = setupWithFakeTimer();
  svc.create({ cwd: "/tmp/ws", cols: 80, rows: 24 });
  pty.emitData("pending"); // arms a flush timer
  expect(hasFlushPending()).toBe(true);
  svc.disposeAll();
  expect(hasFlushPending()).toBe(false);
});

test("write/resize/close proxy to the PTY; exit emits terminal-exit", () => {
  const { svc, pty, captured } = setup();
  const { terminalId } = svc.create({ cwd: "/tmp/ws", cols: 80, rows: 24 });
  svc.write(terminalId, "ls\n");
  expect((pty.write as ReturnType<typeof mock>).mock.calls[0][0]).toBe("ls\n");
  svc.resize(terminalId, 120, 40);
  expect((pty.resize as ReturnType<typeof mock>).mock.calls[0]).toEqual([
    120, 40,
  ]);
  svc.close(terminalId);
  expect((pty.kill as ReturnType<typeof mock>).mock.calls.length).toBe(1);
  pty.emitExit(0);
  const exit = captured.find((e) => e.type === "terminal-exit") as Extract<
    ControlEvent,
    { type: "terminal-exit" }
  >;
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

test("attach returns buffered output + lastSeq for a live terminal (coalesced)", () => {
  const { svc, pty } = setupWithFakeTimer();
  const { terminalId } = svc.create({ cwd: "/tmp/ws", cols: 80, rows: 24 });
  pty.emitData("hello\n");
  pty.emitData("world\n"); // both pending; attach flushes them as ONE event (seq 0)
  const res = svc.attach(terminalId);
  expect(res).toEqual({ ok: true, buffer: "hello\nworld\n", lastSeq: 0 });
});

test("attach flushes pending first so lastSeq covers the buffer (no double-render)", () => {
  const { svc, pty, captured } = setupWithFakeTimer();
  const { terminalId } = svc.create({ cwd: "/tmp/ws", cols: 80, rows: 24 });
  pty.emitData("live-");
  pty.emitData("bytes"); // pending, window not fired
  const res = svc.attach(terminalId);
  // attach emitted exactly one coalesced event at seq 0...
  const outs = captured.filter((e) => e.type === "terminal-output") as Extract<
    ControlEvent,
    { type: "terminal-output" }
  >[];
  expect(outs.length).toBe(1);
  expect(outs[0]).toEqual({
    type: "terminal-output",
    terminalId,
    seq: 0,
    data: "live-bytes",
  });
  // ...and lastSeq === that seq, so the client's `seq > lastSeq` filter drops the flush
  // event it queued during the attach RPC — the bytes render once (from the buffer), not twice.
  expect(res).toEqual({ ok: true, buffer: "live-bytes", lastSeq: 0 });
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
  for (let i = 0; i < 300; i++)
    pty.emitData("L" + i + ":" + "x".repeat(1000) + "\n");
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
  const { svc, spawn } = setup({
    platform: "win32",
    shell: () => "C:/win/pwsh.exe",
  });
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

function setupWithFakeTimer(opts?: {
  idle?: number;
  platform?: NodeJS.Platform;
}) {
  // Multiple timers can be live at once: the idle timer (idleTimeoutSeconds*1000,
  // i.e. >=1000ms) and the coalesce flush timer (COALESCE_MS = 16ms). Track them by
  // id and split on ms so a test can fire/inspect each kind independently.
  const timers = new Map<number, { fn: () => void; ms: number }>();
  let timerId = 0;
  let idleSetCount = 0;
  const setTimer = (fn: () => void, ms: number): unknown => {
    const id = ++timerId;
    timers.set(id, { fn, ms });
    if (ms >= 1000) idleSetCount++; // idle timer only; the 16ms flush timer is excluded
    return id;
  };
  const clearTimer = (id: unknown) => {
    timers.delete(id as number);
  };
  const fireWhere = (pred: (ms: number) => boolean) => {
    for (const [id, t] of [...timers])
      if (pred(t.ms)) {
        timers.delete(id);
        t.fn();
      }
  };
  /** Fire the pending idle timer(s) (>=1000ms). */
  const tick = () => fireWhere((ms) => ms >= 1000);
  /** Fire the pending coalesce flush timer(s) (<1000ms). */
  const fireFlush = () => fireWhere((ms) => ms < 1000);
  /** True when an idle timer is pending. */
  const hasPending = () => [...timers.values()].some((t) => t.ms >= 1000);
  /** True when a coalesce flush timer is pending. */
  const hasFlushPending = () => [...timers.values()].some((t) => t.ms < 1000);

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
    setTimer,
    clearTimer,
  });
  return {
    svc,
    pty,
    spawn,
    captured,
    tick,
    fireFlush,
    hasPending,
    hasFlushPending,
    getIdleSetCount: () => idleSetCount,
  };
}

test("idle: PTY output (onData) does NOT reset the idle timer", () => {
  const { svc, pty, tick, getIdleSetCount } = setupWithFakeTimer();
  svc.create({ cwd: "/tmp/ws", cols: 80, rows: 24 });

  pty.emitData("line1\r\n");
  pty.emitData("line2\r\n");
  pty.emitData("line3\r\n");

  // The IDLE timer is armed exactly once (at create); output must not re-arm it.
  // (Output DOES arm a separate coalesce flush timer — excluded from this count.)
  expect(getIdleSetCount()).toBe(1);

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
  pty.emitData("a");
  pty.emitData("b");
  pty.emitData("c");
  // User input resets idle.
  svc.write(terminalId, "\r");
  // More output — still must not reset idle.
  pty.emitData("d");
  pty.emitData("e");
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
  (pty.write as ReturnType<typeof mock>).mockImplementation(() => {
    throw new Error("PTY already dead");
  });
  const spawn = mock(() => pty);
  const svc = createTerminalService({
    events,
    idleTimeoutSeconds: () => 900,
    spawn: spawn as never,
    platform: "darwin",
  });
  const { terminalId } = svc.create({ cwd: "/tmp/ws", cols: 80, rows: 24 });
  expect(() => svc.write(terminalId, "x")).not.toThrow();
});

test("resize(): a throwing PTY handle does not propagate out of the service", () => {
  const events = createControlEventBus();
  const pty = fakePty();
  (pty.resize as ReturnType<typeof mock>).mockImplementation(() => {
    throw new Error("PTY already dead");
  });
  const spawn = mock(() => pty);
  const svc = createTerminalService({
    events,
    idleTimeoutSeconds: () => 900,
    spawn: spawn as never,
    platform: "darwin",
  });
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
  expect(
    resolveShell({
      platform: "win32",
      env: {},
      shellOverride: "C:/tools/nu.exe",
      exists: noExist,
    }),
  ).toBe("C:/tools/nu.exe");
  expect(
    resolveShell({
      platform: "darwin",
      env: { SHELL: "/bin/zsh" },
      shellOverride: "/bin/fish",
    }),
  ).toBe("/bin/fish");
  // blank override is ignored (falls through to platform default)
  expect(
    resolveShell({
      platform: "linux",
      env: { SHELL: "/bin/bash" },
      shellOverride: "   ",
    }),
  ).toBe("/bin/bash");
});

test("resolveShell: unix honors SHELL then falls to zsh(darwin)/bash(other) — unchanged", () => {
  expect(
    resolveShell({
      platform: "darwin",
      env: { SHELL: "/opt/homebrew/bin/fish" },
    }),
  ).toBe("/opt/homebrew/bin/fish");
  expect(resolveShell({ platform: "darwin", env: {} })).toBe("/bin/zsh");
  expect(resolveShell({ platform: "linux", env: {} })).toBe("/bin/bash");
});

test("resolveShell: win32 IGNORES SHELL and scans PATH pwsh -> powershell -> ComSpec -> cmd", () => {
  const PATH = "C:\\Windows\\System32;C:\\PS7";
  // SHELL set to an MSYS path (git-bash) must be ignored on win32
  const env = {
    SHELL: "/usr/bin/bash",
    PATH,
    ComSpec: "C:\\Windows\\System32\\cmd.exe",
  };
  // pwsh present anywhere in PATH wins
  const pwshExists = (p: string) => p === "C:\\PS7\\pwsh.exe";
  expect(resolveShell({ platform: "win32", env, exists: pwshExists })).toBe(
    "C:\\PS7\\pwsh.exe",
  );
  // no pwsh, powershell present in System32
  const psExists = (p: string) => p === "C:\\Windows\\System32\\powershell.exe";
  expect(resolveShell({ platform: "win32", env, exists: psExists })).toBe(
    "C:\\Windows\\System32\\powershell.exe",
  );
  // neither present -> ComSpec
  expect(resolveShell({ platform: "win32", env, exists: noExist })).toBe(
    "C:\\Windows\\System32\\cmd.exe",
  );
  // neither present and no ComSpec -> literal cmd.exe
  expect(
    resolveShell({ platform: "win32", env: { PATH }, exists: noExist }),
  ).toBe("cmd.exe");
});

test("resolveShell: win32 prefers pwsh over powershell when both exist", () => {
  const env = { PATH: "C:\\A;C:\\B" };
  const bothExist = (p: string) =>
    p === "C:\\B\\pwsh.exe" || p === "C:\\A\\powershell.exe";
  expect(resolveShell({ platform: "win32", env, exists: bothExist })).toBe(
    "C:\\B\\pwsh.exe",
  );
});

test("resolveShell: win32 strips surrounding quotes from PATH entries", () => {
  const env = { PATH: '"C:\\PS7";C:\\Windows\\System32' };
  const exists = (p: string) => p === "C:\\PS7\\pwsh.exe"; // unquoted form
  expect(resolveShell({ platform: "win32", env, exists })).toBe(
    "C:\\PS7\\pwsh.exe",
  );
});
