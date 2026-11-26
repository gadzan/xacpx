/**
 * Unified acpx child-process spawn primitives (Phase 1 of the CLI/Bridge driver unification).
 *
 * Before: `src/transport/acpx-cli/acpx-cli-transport.ts` (`defaultRunner` +
 * `defaultPtyRunner` + `runCommandWithTimeout`) and
 * `src/bridge/bridge-runtime.ts` (`spawnCapture` + `defaultRunner` +
 * `shellSessionCreateRunner`) each reimplemented the same three things:
 *   1. plain `child_process.spawn` capture with timeout → kill-the-tree → CommandTimeoutError;
 *   2. node-pty capture (CLI lane only, for session create/resume);
 *   3. AbortSignal-racing timeout around an injected runner (CLI lane
 *      `runCommandWithTimeout`; the bridge did the equivalent inside `spawnCapture`).
 *
 * After: both lanes import from here. Behaviour is bit-identical, with ONE
 * deliberate merge delta documented below (signal-abort support in
 * `spawnCapture`, which the bridge never triggers). Covered by the pre-existing
 * suites (`tests/unit/transport/acpx-cli/*`,
 * `tests/unit/bridge/bridge-runtime*.test.ts`) plus the new differential tests
 * in `tests/unit/transport/acpx-spawn.test.ts`.
 */

import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { spawn as spawnPty } from "node-pty";

import { getLocale } from "../i18n";
import { resolveSpawnCommand } from "../process/spawn-command";
import { terminateProcessTree } from "../process/terminate-process-tree";
import { ensureNodePtyHelperExecutable, resolveNodePtyHelperPath } from "./acpx-cli/node-pty-helper";
import {
  CommandTimeoutError,
  type AcpxCommandStage,
} from "./command-timeouts";

const require = createRequire(import.meta.url);

/** One finished child process: exit code plus captured stdio. Shared by both lanes. */
export interface AcpxSpawnResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** Timeout + abort + env contract shared by both lanes' runners. */
export interface AcpxSpawnOptions {
  timeoutMs?: number;
  signal?: AbortSignal;
  stage?: AcpxCommandStage;
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  /** Per-line stderr callback (bridge ensure progress). CLI lane passes none. */
  onStderrLine?: (line: string) => void;
}

/** Matches `CommandRunner` in acpx-cli-transport and `CommandRunner` in bridge-runtime. */
export type AcpxRunner = (command: string, args: string[], options?: AcpxSpawnOptions) => Promise<AcpxSpawnResult>;
export type AcpxPtyRunner = (command: string, args: string[], options?: AcpxSpawnOptions) => Promise<AcpxSpawnResult>;

function renderCommandForError(args: string[]): string {
  const rendered: string[] = [];

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === undefined) {
      continue;
    }

    if (arg === "--format") {
      index += 1;
      continue;
    }

    if (arg === "--cwd") {
      index += 1;
      continue;
    }

    rendered.push(/\s/.test(arg) || arg.includes(":") ? `"${arg}"` : arg);
  }

  return rendered.join(" ");
}

/**
 * PTY child env: the filtered/agent env is authoritative (inherits nothing),
 * with the active locale stamped for acpx diagnostics. Relocated verbatim
 * from `resolveChildEnvironment` in acpx-cli-transport (renamed to mark the
 * PTY-only scope; the old name stays available as a test-seam alias).
 */
export function resolvePtyChildEnvironment(
  baseEnv: NodeJS.ProcessEnv,
  explicitEnv: NodeJS.ProcessEnv | undefined,
  locale: string,
): Record<string, string> {
  const source = explicitEnv ?? baseEnv;
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(source)) {
    if (typeof value === "string") env[key] = value;
  }
  env.XACPX_LANG = locale;
  return env;
}

/**
 * Plain `child_process.spawn` capture. This is `spawnCapture` from
 * bridge-runtime (the superset: it supports `onStderrLine`, `cwd`, and the
 * `spawnFn`/`killProcessTreeFn` test seams), plus ONE merge delta: it now also
 * honors `options.signal` by killing the tree, which is what acpx-cli's
 * `defaultRunner` did. The bridge never passes a signal, so its behaviour is
 * unchanged; the CLI keeps its abort-kills-tree contract (`runControl`
 * deadline path) without keeping a second spawn implementation.
 */
export interface SpawnCaptureOptions extends AcpxSpawnOptions {
  /** Test seam: replaces node:child_process spawn. */
  spawnFn?: typeof spawn;
  /** Test seam: replaces terminateProcessTree for timeout kills. */
  killProcessTreeFn?: (pid: number) => Promise<void>;
}

export function spawnCapture(
  command: string,
  args: string[],
  options?: SpawnCaptureOptions,
): Promise<AcpxSpawnResult> {
  return new Promise((resolve, reject) => {
    const spawnFn = options?.spawnFn ?? spawn;
    const killTree = options?.killProcessTreeFn
      ?? ((pid: number) => terminateProcessTree(pid, { detachedProcessGroup: false }));
    const child = spawnFn(command, args, {
      cwd: options?.cwd,
      env: options?.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    let stdout = "";
    let stderr = "";
    let stderrTail = "";

    // Merge delta vs bridge-runtime's original: honor an abort signal by
    // killing the tree (acpx-cli `defaultRunner` contract). No rejection here —
    // the aborter (runWithSpawnTimeout / runControl deadline) owns the error.
    const onAbort = () => {
      void killTree(child.pid ?? 0);
    };
    options?.signal?.addEventListener("abort", onAbort, { once: true });

    const timeoutId =
      typeof options?.timeoutMs === "number" && Number.isFinite(options.timeoutMs) && options.timeoutMs > 0
        ? setTimeout(() => {
            // Same kill semantics as the acpx-cli transport's timed-out runner:
            // tear down the whole spawned tree so no orphan keeps holding the lane.
            void killTree(child.pid ?? 0);
            reject(new CommandTimeoutError(options.timeoutMs!, [command, ...args].join(" "), {
              stage: options.stage,
              stdout,
              stderr,
            }));
          }, options.timeoutMs)
        : undefined;

    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on("data", (chunk) => {
      const text = String(chunk);
      stderr += text;
      if (!options?.onStderrLine) return;
      stderrTail += text;
      // Split on both \n and \r so Windows CRLF and bare-\r progress bars both emit lines.
      const matches = stderrTail.split(/\r\n|\r|\n/);
      // Last element is the unterminated tail (or "" if input ended on a separator).
      stderrTail = matches.pop() ?? "";
      for (const line of matches) {
        options.onStderrLine(line);
      }
    });
    child.on("error", (error) => {
      options?.signal?.removeEventListener("abort", onAbort);
      if (timeoutId) clearTimeout(timeoutId);
      reject(error);
    });
    child.on("close", (code) => {
      options?.signal?.removeEventListener("abort", onAbort);
      if (timeoutId) clearTimeout(timeoutId);
      if (options?.onStderrLine && stderrTail.length > 0) {
        options.onStderrLine(stderrTail);
      }
      resolve({ code: code ?? 1, stdout, stderr });
    });
  });
}

/**
 * Default plain runner. acpx-cli's `defaultRunner` resolved the command first;
 * bridge-runtime's `defaultRunner` was bare `spawnCapture` (its callers
 * pre-resolve). Resolution is idempotent for non-script commands, so resolving
 * here preserves the CLI contract with zero effect on bridge callers.
 */
export async function defaultAcpxRunner(
  command: string,
  args: string[],
  options?: AcpxSpawnOptions,
): Promise<AcpxSpawnResult> {
  const spawnSpec = resolveSpawnCommand(command, args);
  return await spawnCapture(spawnSpec.command, spawnSpec.args, options);
}

/** `sessions new`/`ensure` with an explicit cwd (bridge `shellSessionCreateRunner`). */
export async function shellSessionCreateRunner(
  command: string,
  args: string[],
  cwd: string,
  options?: AcpxSpawnOptions,
): Promise<AcpxSpawnResult> {
  return await spawnCapture(command, args, { ...options, cwd });
}

/**
 * node-pty runner for session create/resume (CLI lane only — the bridge never
 * used a PTY). Relocated verbatim from `defaultPtyRunner` in
 * acpx-cli-transport, including the Windows no-op (`resolveNodePtyHelperPath`
 * returns null on win32, `ensureNodePtyHelperExecutable` then no-ops).
 */
export async function defaultAcpxPtyRunner(
  command: string,
  args: string[],
  options?: AcpxSpawnOptions,
): Promise<AcpxSpawnResult> {
  const helperPath = resolveNodePtyHelperPath(
    require.resolve("node-pty/package.json"),
    process.platform,
    process.arch,
  );
  await ensureNodePtyHelperExecutable(helperPath);

  return await new Promise((resolve, reject) => {
    const spawnSpec = resolveSpawnCommand(command, args);
    const child = spawnPty(spawnSpec.command, spawnSpec.args, {
      name: "xterm-color",
      cols: 80,
      rows: 24,
      cwd: process.cwd(),
      env: resolvePtyChildEnvironment(process.env, options?.env, getLocale()),
    });
    let output = "";

    const onAbort = () => {
      child.kill();
    };
    options?.signal?.addEventListener("abort", onAbort, { once: true });

    const timeoutId = options?.timeoutMs
      ? setTimeout(() => {
          onAbort();
          reject(managementTimeoutError(args, options, { stdout: output }));
        }, options.timeoutMs)
      : undefined;

    child.onData((chunk) => {
      output += chunk;
    });

    child.onExit(({ exitCode }) => {
      options?.signal?.removeEventListener("abort", onAbort);
      if (timeoutId) clearTimeout(timeoutId);
      resolve({ code: exitCode, stdout: output, stderr: "" });
    });
  });
}

/**
 * Factory for the redacted timeout error (skips `--format`/`--cwd` values).
 * Exported so `runControl`-style deadline paths keep the identical message
 * without reimplementing the redaction.
 */
export function managementTimeoutError(
  args: string[],
  options: AcpxSpawnOptions,
  output: { stdout?: string; stderr?: string } = {},
): CommandTimeoutError {
  return new CommandTimeoutError(options.timeoutMs!, renderCommandForError(args), {
    stage: options.stage,
    ...output,
  });
}

/**
 * Abort-racing timeout wrapper around an injected runner (CLI lane
 * `runCommandWithTimeout`). Relocated verbatim: without `timeoutMs` the runner
 * is called directly; otherwise a sibling AbortController races the deadline
 * and rejects with the redacted `managementTimeoutError` (the rendered argv
 * skips `--format`/`--cwd` values, so the message stays stable).
 */
export async function runWithSpawnTimeout(
  runner: AcpxRunner | AcpxPtyRunner,
  command: string,
  args: string[],
  options?: AcpxSpawnOptions,
): Promise<AcpxSpawnResult> {
  const spawnSpec = resolveSpawnCommand(command, args);

  if (!options?.timeoutMs) {
    return await runner(spawnSpec.command, spawnSpec.args, options);
  }

  const abortController = new AbortController();
  let timeoutId: NodeJS.Timeout | undefined;

  return await Promise.race([
    runner(spawnSpec.command, spawnSpec.args, {
      ...options,
      signal: options.signal
        ? AbortSignal.any([options.signal, abortController.signal])
        : abortController.signal,
    }).finally(() => {
      if (timeoutId) clearTimeout(timeoutId);
    }),
    new Promise<AcpxSpawnResult>((_, reject) => {
      timeoutId = setTimeout(() => {
        reject(
          managementTimeoutError(args, options),
        );
        abortController.abort();
      }, options.timeoutMs);
    }),
  ]);
}
