/**
 * Shared session-ensure orchestration (Phase 3a of the CLI/Bridge driver unification).
 *
 * Before: `AcpxCliTransport.runEnsureSession` (src/transport/acpx-cli/acpx-cli-transport.ts)
 * and `BridgeRuntime.attemptEnsureSession` (src/bridge/bridge-runtime.ts) each ran the
 * same ensure → show-probe → new skeleton with per-lane policy baked in. The skeleton
 * now lives here, parameterized by injected I/O plus an explicit policy; both lanes
 * keep their own argv builders, runners, error mapping, and progress wiring, so
 * behaviour is bit-identical by construction.
 *
 * Lane differences, preserved as policy (not papered over):
 * - Spawn vehicle: the CLI creates sessions through `run` (agentCommand set) or
 *   `runWithPty` (bare agent); the bridge uses `run` for ensure and
 *   `runSessionCreate` (cwd-carrying) for new. Expressed structurally — each lane
 *   passes its own closures — so there is no `usePtyForCreate` boolean to branch on.
 * - `verboseFallback` (bridge only): older acpx builds reject `--verbose`; the
 *   bridge probes once per runtime lifetime and retries without the flag. The CLI
 *   has no such flag, so its closures ignore `verbose`.
 * - `epermRepair` (bridge only): a Windows EPERM-torn session index is repaired
 *   and re-probed. The CLI never does this.
 * - `tolerateEnsureFailure` / `tolerateShowFailure` (CLI only): any ensure or
 *   show-probe failure — missing session, timeout, crash, thrown spawn error —
 *   falls through to the next step (`show`, then `sessions new`). The bridge
 *   only creates on a clean non-zero exit and propagates probe failures
 *   (timeouts mapped to its session-init error, anything else raw).
 * - `showTimeoutCapMs` (CLI only): the CLI caps the show probe at the management
 *   bound; the bridge grants it the full remaining session-init budget.
 * - Progress/stderr notes: the bridge forwards `onProgress` lifecycle events and
 *   child stderr lines; the CLI passes neither (its ensure callers ignore them).
 * - Failure mapping stays per-lane by design: the flow returns the settled
 *   `{ ensured, created }` pair (or throws through `mapTimeoutError`) and each
 *   lane throws its own error — `EnsureSessionFailedError` (with the
 *   missing-optional-dep parse) on the bridge, the raw control-command error
 *   (wrapped by `explainSessionSpawnFailure` in the outer) on the CLI.
 *
 * This module never spawns: every subprocess step runs through the injected
 * `runEnsure` / `runShow` / `runCreate` closures, which own argv construction,
 * environment, and result-vs-throw conventions.
 */

import { CommandTimeoutError } from "./command-timeouts";
import type { AcpxSpawnResult } from "./acpx-spawn";
import type { EnsureSessionProgress } from "./types";

/** One settled acpx invocation. Closures resolve (never throw) on non-zero
 *  exits; only timeouts and spawn failures reject. */
export type EnsureCommandResult = Pick<AcpxSpawnResult, "code" | "stdout" | "stderr">;

export interface EnsureSessionRunnerOpts {
  timeoutMs: number;
  onStderrLine?: (line: string) => void;
  /** Bridge-only `--verbose` probe flag; the CLI ignores it (no such flag). */
  verbose: boolean;
}

export interface EnsureSessionFlowDeps {
  migrateLegacyArgv(): Promise<void>;
  runEnsure(tail: string[], opts: EnsureSessionRunnerOpts): Promise<EnsureCommandResult>;
  runShow(tail: string[], opts: { timeoutMs: number }): Promise<EnsureCommandResult>;
  runCreate(tail: string[], opts: EnsureSessionRunnerOpts): Promise<EnsureCommandResult>;
  repairSessionIndex(): Promise<boolean>;
  now?: () => number;
}

export interface EnsureSessionFlowPolicy {
  sessionName: string;
  sessionInitTimeoutMs: number;
  /** CLI caps the show probe at the management bound; the bridge leaves it
   *  undefined (full remaining session-init budget). */
  showTimeoutCapMs?: number;
  /** Bridge retries ensure/new once without `--verbose` on "unknown option". */
  verboseFallback: boolean;
  /** Bridge repairs a Windows EPERM-torn session index and re-probes. */
  epermRepair: boolean;
  /** CLI treats any ensure failure as "probe, then maybe create"; the bridge propagates. */
  tolerateEnsureFailure: boolean;
  /** CLI treats any show-probe failure as "must create"; the bridge propagates. */
  tolerateShowFailure: boolean;
  isVerboseSupported?: () => boolean | undefined;
  setVerboseSupported?: (supported: boolean) => void;
  onProgress?: (progress: EnsureSessionProgress) => void;
  onStderrLine?: (line: string) => void;
  /** Lane maps a mid-flow spawn timeout to its own error (bridge: its
   *  session-init failure; CLI: the raw timeout, wrapped by the outer). */
  mapTimeoutError(error: CommandTimeoutError): never;
}

export interface EnsureSessionFlowFailure {
  ensured: EnsureCommandResult | undefined;
  created: EnsureCommandResult | undefined;
}

export type EnsureSessionFlowResult =
  | { ok: true }
  | { ok: false; failure: EnsureSessionFlowFailure };

/** Commander-style ("error: unknown option '--verbose'"), yargs, and generic
 *  "unrecognized". Moved here from bridge-runtime.ts (its only consumer). */
export function isUnknownVerboseOption(stderr: string, stdout: string): boolean {
  const combined = `${stderr}\n${stdout}`;
  // Commander-style ("error: unknown option '--verbose'"), yargs, and generic "unrecognized".
  return /(unknown|unrecognized)\b[^\n]*--verbose/i.test(combined);
}

/**
 * ensure → show-probe → new, bounded end-to-end by one shared
 * sessionInitTimeoutMs deadline (each step only gets the remaining budget; the
 * 1ms floor makes an expired deadline fail fast through the normal per-spawn
 * timeout instead of granting a fresh slice). Returns the settled pair on
 * total failure so each lane can throw its own error.
 */
export async function runEnsureSessionFlow(
  deps: EnsureSessionFlowDeps,
  policy: EnsureSessionFlowPolicy,
): Promise<EnsureSessionFlowResult> {
  await deps.migrateLegacyArgv();
  const timeoutMs = policy.sessionInitTimeoutMs;
  const now = deps.now ?? Date.now;
  const deadline = now() + timeoutMs;
  const remainingTimeoutMs = () => Math.max(deadline - now(), 1);
  const onProgress = policy.onProgress;
  const onStderrLine = policy.onStderrLine;

  const runWithVerboseFallback = async (
    tail: string[],
    runner: (tail: string[], opts: EnsureSessionRunnerOpts) => Promise<EnsureCommandResult>,
  ): Promise<EnsureCommandResult> => {
    if (!policy.verboseFallback) {
      return await runner(tail, {
        timeoutMs: remainingTimeoutMs(),
        ...(onStderrLine ? { onStderrLine } : {}),
        verbose: false,
      });
    }
    const useVerbose = policy.isVerboseSupported?.() !== false;
    const runOnce = (verbose: boolean): Promise<EnsureCommandResult> =>
      runner(tail, {
        timeoutMs: remainingTimeoutMs(),
        ...(onStderrLine ? { onStderrLine } : {}),
        verbose,
      });
    const result = await runOnce(useVerbose);
    if (result.code === 0) {
      if (useVerbose) policy.setVerboseSupported?.(true);
      return result;
    }
    if (useVerbose && isUnknownVerboseOption(result.stderr, result.stdout)) {
      policy.setVerboseSupported?.(false);
      return await runOnce(false);
    }
    return result;
  };

  const runMappedStep = async (
    tail: string[],
    runner: (tail: string[], opts: EnsureSessionRunnerOpts) => Promise<EnsureCommandResult>,
  ): Promise<EnsureCommandResult> => {
    try {
      return await runWithVerboseFallback(tail, runner);
    } catch (error) {
      // Agent init hung (auth prompt, network stall): the spawn was already
      // killed by the runner; the lane maps it to its own timeout error.
      if (error instanceof CommandTimeoutError) throw policy.mapTimeoutError(error);
      throw error;
    }
  };

  onProgress?.("spawn");
  let ensured: EnsureCommandResult | undefined;
  try {
    ensured = await runMappedStep(
      ["sessions", "ensure", "--name", policy.sessionName],
      deps.runEnsure,
    );
  } catch (error) {
    if (!policy.tolerateEnsureFailure) throw error;
    // CLI: a failed ensure (missing session, timeout, crash, thrown spawn
    // error) means the session may already exist or must be created fresh —
    // probe, then create.
  }
  if (ensured && ensured.code === 0) {
    onProgress?.("ready");
    return { ok: true };
  }

  const showTimeoutMs = policy.showTimeoutCapMs === undefined
    ? remainingTimeoutMs()
    : Math.min(policy.showTimeoutCapMs, remainingTimeoutMs());
  let existing: EnsureCommandResult | undefined;
  try {
    // The show probe gets its own bound (CLI: management cap; bridge: full
    // remaining budget) instead of the step default.
    existing = await runMappedStep(
      ["sessions", "show", policy.sessionName],
      (tail) => deps.runShow(tail, { timeoutMs: showTimeoutMs }),
    );
  } catch (error) {
    if (!policy.tolerateShowFailure) throw error;
    // CLI: a failed show probe (missing session, timeout, crash) means the
    // session must be created fresh — fall through to `sessions new`.
  }
  if (existing && existing.code === 0) {
    onProgress?.("ready");
    return { ok: true };
  }

  onProgress?.("initializing");
  const created = await runMappedStep(
    ["sessions", "new", "--name", policy.sessionName],
    deps.runCreate,
  );
  if (created.code === 0) {
    onProgress?.("ready");
    return { ok: true };
  }

  if (policy.epermRepair) {
    const output = created.stderr || created.stdout || "";
    if (output.includes("EPERM") && await deps.repairSessionIndex()) {
      const repaired = await runMappedStep(
        ["sessions", "show", policy.sessionName],
        (tail) => deps.runShow(tail, { timeoutMs: remainingTimeoutMs() }),
      );
      if (repaired.code === 0) {
        onProgress?.("ready");
        return { ok: true };
      }
    }
  }

  return { ok: false, failure: { ensured, created } };
}
