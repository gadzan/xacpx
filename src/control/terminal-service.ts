import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
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

export interface TerminalService {
  create(input: TerminalCreateInput): { terminalId: string };
  write(terminalId: string, data: string): void;
  resize(terminalId: string, cols: number, rows: number): void;
  close(terminalId: string): void;
  disposeAll(): void;
}

export interface TerminalServiceDeps {
  events: ControlEventBus;
  idleTimeoutSeconds: () => number;
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

function defaultShell(platform: NodeJS.Platform): string {
  if (process.env.SHELL) return process.env.SHELL;
  return platform === "darwin" ? "/bin/zsh" : "/bin/bash";
}

function realPtySpawn(file: string, args: string[], opts: { name: string; cols: number; rows: number; cwd: string; env: Record<string, string> }): PtyHandle {
  const helperPath = resolveNodePtyHelperPath(require.resolve("node-pty/package.json"), process.platform, process.arch);
  void ensureNodePtyHelperExecutable(helperPath);
  return spawnPty(file, args, opts) as unknown as PtyHandle;
}

// idleTimer is typed as unknown so the type is compatible with both Node.js Timeout and Bun Timer.
interface Session { handle: PtyHandle; seq: number; idleTimer: unknown }

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

  return {
    create({ cwd, cols, rows }) {
      if (platform === "win32") throw new Error("terminal-unsupported-platform");
      const terminalId = randomUUID();
      const handle = spawn(defaultShell(platform), [], { name: "xterm-256color", cols, rows, cwd, env: scrubEnv() });
      const session: Session = { handle, seq: 0, idleTimer: null };
      sessions.set(terminalId, session);
      handle.onData((data) => {
        // NOTE: resetIdle is intentionally NOT called here.
        // Output does not count as user interaction; only write/resize do.
        deps.events.emit({ type: "terminal-output", terminalId, seq: session.seq++, data });
      });
      handle.onExit(({ exitCode }) => {
        if (session.idleTimer) clearTimer(session.idleTimer);
        sessions.delete(terminalId);
        deps.events.emit({ type: "terminal-exit", terminalId, code: exitCode });
      });
      resetIdle(terminalId);
      return { terminalId };
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
        try { s.handle.kill(); } catch { /* ignore */ }
      }
      sessions.clear();
    },
  };
}
