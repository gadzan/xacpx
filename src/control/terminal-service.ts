import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { statSync } from "node:fs";
import { spawn as spawnPty } from "node-pty";
import { resolveNodePtyHelperPath, ensureNodePtyHelperExecutable } from "../transport/acpx-cli/node-pty-helper";
import type { ControlEventBus } from "./control-event-bus";

const require = createRequire(import.meta.url);

/**
 * Secret-bearing env keys stripped before handing the shell its environment.
 * Best-effort denylist only — a real shell still inherits the full process env;
 * custom secrets (DATABASE_URL, *_TOKEN, ~/.ssh keys, etc.) not on this list
 * pass through. Do not treat env scrubbing as a security guarantee.
 */
export const SENSITIVE_ENV_KEYS = [
  "ANTHROPIC_API_KEY", "OPENAI_API_KEY", "OPENROUTER_API_KEY", "GEMINI_API_KEY",
  "GOOGLE_API_KEY", "DEEPSEEK_API_KEY", "GROQ_API_KEY", "AWS_SECRET_ACCESS_KEY",
  "AWS_SESSION_TOKEN", "GH_TOKEN", "GITHUB_TOKEN", "NPM_TOKEN",
];

export interface PtyHandle {
  onData(cb: (data: string) => void): void;
  onExit(cb: (e: { exitCode: number }) => void): void;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(): void;
}

export type PtySpawn = (
  file: string,
  args: string[],
  opts: { name: string; cols: number; rows: number; cwd: string; env: Record<string, string> },
) => PtyHandle;

export interface TerminalCreateInput { cwd: string; cols: number; rows: number }

export type TerminalAttachResult =
  | { ok: false }
  | { ok: true; buffer: string; lastSeq: number };

export interface TerminalService {
  create(input: TerminalCreateInput): { terminalId: string };
  attach(terminalId: string): TerminalAttachResult;
  write(terminalId: string, data: string): void;
  resize(terminalId: string, cols: number, rows: number): void;
  close(terminalId: string): void;
  disposeAll(): void;
}

export interface TerminalServiceDeps {
  events: ControlEventBus;
  idleTimeoutSeconds: () => number;
  /** Optional explicit shell override from config (terminal.shell). */
  shell?: () => string | undefined;
  spawn?: PtySpawn;
  platform?: NodeJS.Platform;
  /** Injectable timer primitives; defaults to global setTimeout/clearTimeout. */
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (id: unknown) => void;
}

function scrubEnv(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v === undefined) continue;
    if (SENSITIVE_ENV_KEYS.includes(k) || k.startsWith("XACPX_")) continue;
    out[k] = v;
  }
  out.TERM = "xterm-256color";
  out.LANG = out.LANG ?? "en_US.UTF-8";
  return out;
}

function defaultExists(p: string): boolean {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
}

export interface ResolveShellArgs {
  platform: NodeJS.Platform;
  env: NodeJS.ProcessEnv;
  /** Explicit override from config terminal.shell — wins on every platform. */
  shellOverride?: string;
  /** Injectable executable-existence predicate (defaults to fs statSync). */
  exists?: (p: string) => boolean;
}

/** Pick the shell to spawn. Priority: explicit override -> platform default.
 *  win32 deliberately ignores SHELL (git-bash sets it to an MSYS path that
 *  node-pty can't spawn on Windows) and scans PATH for pwsh -> powershell,
 *  falling back to %ComSpec% (cmd.exe). Never throws — always returns a value. */
export function resolveShell(args: ResolveShellArgs): string {
  const { platform, env, shellOverride } = args;
  const exists = args.exists ?? defaultExists;
  if (shellOverride && shellOverride.trim()) return shellOverride;
  if (platform === "win32") {
    const pathValue = env.PATH ?? env.Path ?? "";
    const dirs = pathValue.split(";").filter(Boolean);
    for (const name of ["pwsh.exe", "powershell.exe"]) {
      for (const dir of dirs) {
        const clean = dir.replace(/^"|"$/g, "");
        const full = `${clean}\\${name}`;
        if (exists(full)) return full;
      }
    }
    return env.ComSpec ?? "cmd.exe";
  }
  if (env.SHELL) return env.SHELL;
  return platform === "darwin" ? "/bin/zsh" : "/bin/bash";
}

function realPtySpawn(file: string, args: string[], opts: { name: string; cols: number; rows: number; cwd: string; env: Record<string, string> }): PtyHandle {
  const helperPath = resolveNodePtyHelperPath(require.resolve("node-pty/package.json"), process.platform, process.arch);
  void ensureNodePtyHelperExecutable(helperPath);
  return spawnPty(file, args, opts) as unknown as PtyHandle;
}

// idleTimer is typed as unknown so the type is compatible with both Node.js Timeout and Bun Timer.
interface Session { handle: PtyHandle; seq: number; idleTimer: unknown; buffer: string; bufBytes: number; pending: string; pendingBytes: number; flushTimer: unknown }

const MAX_BUFFER_BYTES = 256 * 1024;

// Output coalescing: accumulate PTY output into ~one-frame windows and emit a single
// terminal-output per window instead of one per chunk. A noisy process (yes, tail -f,
// a build log) otherwise produces a firehose of tiny events across every downstream hop.
const COALESCE_MS = 16;
// Flush a large burst immediately rather than sit on it and add latency. Well under the
// 256KB replay cap so a single window never dominates the buffer.
const COALESCE_MAX_BYTES = 64 * 1024;

function appendToBuffer(session: Session, data: string): void {
  session.buffer += data;
  session.bufBytes += Buffer.byteLength(data, "utf8");
  if (session.bufBytes <= MAX_BUFFER_BYTES) return;
  // Drop oldest WHOLE lines (cut at "\n") to avoid slicing mid-escape-sequence.
  while (session.bufBytes > MAX_BUFFER_BYTES) {
    const nl = session.buffer.indexOf("\n");
    if (nl === -1) break; // single line longer than the cap → hard-cut below
    const removed = session.buffer.slice(0, nl + 1);
    session.buffer = session.buffer.slice(nl + 1);
    session.bufBytes -= Buffer.byteLength(removed, "utf8");
  }
  // Degenerate single huge line: hard-cut leading chars until within cap.
  while (session.bufBytes > MAX_BUFFER_BYTES && session.buffer.length > 0) {
    const ch = session.buffer[0]!;
    session.buffer = session.buffer.slice(1);
    session.bufBytes -= Buffer.byteLength(ch, "utf8");
  }
}

export function createTerminalService(deps: TerminalServiceDeps): TerminalService {
  const spawn = deps.spawn ?? realPtySpawn;
  const platform = deps.platform ?? process.platform;
  const sessions = new Map<string, Session>();
  const setTimer: (fn: () => void, ms: number) => unknown =
    deps.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
  const clearTimer: (id: unknown) => void =
    deps.clearTimer ?? ((id) => clearTimeout(id as ReturnType<typeof setTimeout>));

  // Idle timer is reset ONLY by user input (write/resize), not by PTY output.
  // This ensures an abandoned terminal running a noisy process (top, tail -f)
  // is still reaped after idleTimeoutSeconds of no user interaction.
  const resetIdle = (terminalId: string) => {
    const s = sessions.get(terminalId);
    if (!s) return;
    if (s.idleTimer) clearTimer(s.idleTimer);
    const ms = deps.idleTimeoutSeconds() * 1000;
    s.idleTimer = setTimer(() => { try { s.handle.kill(); } catch { /* already gone */ } }, ms);
    const t = s.idleTimer as { unref?: () => void };
    if (typeof t.unref === "function") t.unref();
  };

  // Emit the coalesced output window as a single terminal-output event. Disarms the
  // window timer FIRST so a throwing consumer cannot strand it (state stays clean:
  // pending cleared, timer null). No-op when nothing is pending. Callers: the window
  // timer, the size-cap in onData, attach (flush-before-snapshot), and onExit.
  const flushOutput = (terminalId: string) => {
    const s = sessions.get(terminalId);
    if (!s) return;
    if (s.flushTimer) { clearTimer(s.flushTimer); s.flushTimer = null; }
    if (s.pending.length === 0) return;
    const data = s.pending;
    s.pending = "";
    s.pendingBytes = 0;
    deps.events.emit({ type: "terminal-output", terminalId, seq: s.seq++, data });
  };

  return {
    create({ cwd, cols, rows }) {
      const shell = resolveShell({ platform, env: process.env, shellOverride: deps.shell?.() });
      const terminalId = randomUUID();
      const handle = spawn(shell, [], { name: "xterm-256color", cols, rows, cwd, env: scrubEnv() });
      const session: Session = { handle, seq: 0, idleTimer: null, buffer: "", bufBytes: 0, pending: "", pendingBytes: 0, flushTimer: null };
      sessions.set(terminalId, session);
      handle.onData((data) => {
        // NOTE: resetIdle is intentionally NOT called here (output ≠ user interaction).
        appendToBuffer(session, data); // every byte still lands in the replay buffer
        // Coalesce: accumulate and emit one event per window instead of per chunk.
        session.pending += data;
        session.pendingBytes += Buffer.byteLength(data, "utf8");
        if (session.pendingBytes >= COALESCE_MAX_BYTES) {
          flushOutput(terminalId); // large burst: flush now, don't add window latency
          return;
        }
        if (!session.flushTimer) {
          session.flushTimer = setTimer(() => flushOutput(terminalId), COALESCE_MS);
          const t = session.flushTimer as { unref?: () => void };
          if (typeof t.unref === "function") t.unref();
        }
      });
      handle.onExit(({ exitCode }) => {
        flushOutput(terminalId); // emit any coalesced-but-unflushed output BEFORE the exit event
        if (session.idleTimer) clearTimer(session.idleTimer);
        sessions.delete(terminalId);
        deps.events.emit({ type: "terminal-exit", terminalId, code: exitCode });
      });
      resetIdle(terminalId);
      return { terminalId };
    },
    attach(terminalId) {
      const s = sessions.get(terminalId);
      if (!s) return { ok: false };
      // Assign the pending bytes a seq BEFORE snapshotting buffer/lastSeq, so the
      // returned lastSeq covers the whole buffer. The client queues live events during
      // the attach RPC and applies only those with seq > lastSeq, so this flush event
      // (seq === returned lastSeq) is correctly dropped — the bytes render once.
      flushOutput(terminalId);
      resetIdle(terminalId); // reattaching counts as activity
      return { ok: true, buffer: s.buffer, lastSeq: s.seq - 1 };
    },
    write(terminalId, data) {
      const s = sessions.get(terminalId);
      if (!s) return;
      try { s.handle.write(data); } catch { /* PTY already gone */ }
      resetIdle(terminalId);
    },
    resize(terminalId, cols, rows) {
      const s = sessions.get(terminalId);
      if (!s) return;
      try { s.handle.resize(cols, rows); } catch { /* PTY already gone */ }
      resetIdle(terminalId);
    },
    close(terminalId) {
      const s = sessions.get(terminalId);
      if (!s) return;
      try { s.handle.kill(); } catch { /* already gone */ }
    },
    disposeAll() {
      for (const s of sessions.values()) {
        if (s.idleTimer) clearTimer(s.idleTimer);
        if (s.flushTimer) clearTimer(s.flushTimer);
        try { s.handle.kill(); } catch { /* ignore */ }
      }
      sessions.clear();
    },
  };
}
