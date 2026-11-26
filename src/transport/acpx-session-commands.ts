/**
 * Shared thin session-command shells (Phase 4a of the CLI/Bridge driver unification).
 *
 * Before: `AcpxCliTransport` (src/transport/acpx-cli/acpx-cli-transport.ts) and
 * `BridgeRuntime` (src/bridge/bridge-runtime.ts) each implemented the same
 * twelve thin session commands — tailSessionHistory, getSessionModel,
 * listAgentSessions, removeSession, hasSession, deleteSession,
 * freeWarmProcess, isSessionWarm, cancel, getAgentSessionId, setMode,
 * resumeAgentSession — with token-identical shells around per-lane plumbing.
 * The shells now live here, parameterized by lane closures; behaviour is
 * bit-identical by construction.
 *
 * Lane differences, preserved as parameters (not papered over):
 * - argv construction: the CLI builds with `buildArgs(session, tail, fmt)`,
 *   the bridge with `buildSessionArgs(input, tail, { format })` plus
 *   `resolveSpawnCommand`. Each lane passes a `buildArgv(tail, format?)`
 *   closure; outputs are byte-identical (pinned by the cross-lane parity
 *   oracle).
 * - runner invocation: each lane passes an `execute(argv, timeoutMs)` closure
 *   owning its runner, environment, stage, and timeout. `control: true`
 *   routes the call through `runAcpxControlCommand` (the acpx 0.19.x
 *   queue-owner shutdown-race retry) — the CLI `runControl` without a
 *   deadline is exactly that plus the same throw-check, so both lanes share
 *   the same expression here.
 * - return contracts: the CLI returns `boolean`/`void`/`string|undefined`,
 *   the bridge `{ exists }`/`{}`/`{ agentSessionId }`. Each lane adapts the
 *   shared plain result at its call site.
 * - resume mapping: the CLI wraps failures in `explainSessionSpawnFailure`
 *   and propagates timeouts raw; the bridge throws bare normalized errors
 *   and converts timeouts to its session-init error. Both are injected as
 *   `mapFailure`/`mapTimeout` (pinned by cli-bridge-error-parity.test.ts).
 *
 * Lane-owned and deliberately NOT shared: CLI affinity guards, record-id
 * caches + invalidation, recovery guards, record reading, progress wiring.
 */

import { isProcessAlive } from "../daemon/daemon-files";
import { runAcpxControlCommand } from "./acpx-owner-control-retry";
import { deleteAcpxSessionFiles } from "./acpx-session-files";
import {
  CODEX_AGENT_NAME,
  codexSubagentPredicate,
} from "./codex-subagent-filter";
import { normalizeCommandError } from "./prompt-output";
import {
  readQueueOwnerPid,
  terminateAcpxQueueOwner,
} from "./acpx-queue-owner-launcher";
import {
  isMissingAcpxSessionError,
} from "./acpx-command-builder";
import {
  runAgentSessionList,
} from "./agent-session-list";
import { parseSessionStatusCatalog } from "./session-model-catalog";
import type { AcpxSpawnResult } from "./acpx-spawn";
import type {
  AgentSessionListQuery,
  AgentSessionListResult,
} from "./types";

/** One settled acpx invocation. Executors resolve (never throw) on non-zero
 *  exits; only timeouts and spawn failures reject. */
export type SessionCommandResult = Pick<AcpxSpawnResult, "code" | "stdout" | "stderr">;

/** Lane argv builder: the CLI ignores nothing, the bridge ignores nothing —
 *  both take the tail plus an optional format (default quiet). */
export type BuildSessionCommandArgv = (tail: string[], format?: "json" | "quiet") => string[];

/** Lane runner: argv plus a shared-computed timeout; env/stage are lane-owned. */
export type ExecuteSessionCommand = (argv: string[], timeoutMs: number) => Promise<SessionCommandResult>;

/** Throwing control-command execution shared by cancel/setMode/remove. */
async function executeThrowingControlCommand(
  argv: string[],
  timeoutMs: number,
  execute: ExecuteSessionCommand,
  control: boolean,
): Promise<string> {
  const result = control
    ? await runAcpxControlCommand(() => execute(argv, timeoutMs))
    : await execute(argv, timeoutMs);
  if (result.code !== 0) {
    throw new Error(normalizeCommandError(result) ?? `command failed with exit code ${result.code}`);
  }
  return result.stdout;
}

export interface TailSessionHistoryDeps {
  sessionName: string;
  lines: number;
  /** Shared-deadline budget (both lanes bound the six candidates end-to-end). */
  deadlineBudgetMs: number;
  buildArgv: BuildSessionCommandArgv;
  execute: ExecuteSessionCommand;
}

export async function runTailSessionHistory(deps: TailSessionHistoryDeps): Promise<{ text: string }> {
  const candidates = [
    ["sessions", "history", deps.sessionName, "--limit", String(deps.lines)],
    ["sessions", "history", "quiet", "-s", deps.sessionName, String(deps.lines)],
    ["sessions", "history", "quiet", deps.sessionName, String(deps.lines)],
    ["sessions", "history", "-s", deps.sessionName, "--tail", String(deps.lines)],
    ["sessions", "history", deps.sessionName, "--tail", String(deps.lines)],
    ["sessions", "history", "--name", deps.sessionName, "--tail", String(deps.lines)],
  ];

  // One shared deadline across all candidate invocations so a hung acpx
  // bounds the whole method at the management bound, not per candidate.
  const deadline = Date.now() + deps.deadlineBudgetMs;
  let lastResult: SessionCommandResult | undefined;
  for (const tail of candidates) {
    const result = await deps.execute(deps.buildArgv(tail), Math.max(deadline - Date.now(), 1));
    if (result.code === 0) {
      return { text: result.stdout.trimEnd() };
    }
    lastResult = result;
  }

  const detail = lastResult
    ? normalizeCommandError(lastResult) ?? `command failed with exit code ${lastResult.code}`
    : "command failed";
  throw new Error(detail);
}

export interface GetSessionModelDeps {
  sessionName: string;
  timeoutMs: number;
  buildArgv: BuildSessionCommandArgv;
  execute: ExecuteSessionCommand;
}

export async function runGetSessionModel(deps: GetSessionModelDeps): Promise<{ current?: string; available: string[] }> {
  const result = await deps.execute(deps.buildArgv(["status", "-s", deps.sessionName], "json"), deps.timeoutMs);
  if (result.code !== 0) {
    const detail = normalizeCommandError(result) ?? `command failed with exit code ${result.code}`;
    throw new Error(detail);
  }
  return parseSessionStatusCatalog(result.stdout, `session "${deps.sessionName}"`);
}

export interface ListAgentSessionsDeps {
  filterCwd?: string;
  cursor?: string;
  driver?: string;
  agent: string;
  timeoutMs: number;
  buildListArgv: (includeFilterCwd: boolean) => string[];
  execute: ExecuteSessionCommand;
}

export async function runListAgentSessions(deps: ListAgentSessionsDeps): Promise<AgentSessionListResult | undefined> {
  return await runAgentSessionList({
    filterCwd: deps.filterCwd,
    runList: async (includeFilterCwd) => deps.execute(deps.buildListArgv(includeFilterCwd), deps.timeoutMs),
    formatError: (result) => normalizeCommandError(result) ?? `command failed with exit code ${result.code}`,
    // Codex's session list leaks native subagent threads; hide them (fail-open).
    // Gate on driver so custom-named codex agents (driver "codex") are covered too.
    isSubagentSession: (deps.driver ?? deps.agent) === CODEX_AGENT_NAME ? codexSubagentPredicate() : undefined,
  });
}

/** Narrowed query input shared by both lanes' list closures. */
export type AgentSessionListIdentity = Pick<AgentSessionListQuery, "agent" | "driver" | "filterCwd" | "cursor">;

export interface RemoveSessionDeps {
  sessionName: string;
  timeoutMs: number;
  buildArgv: BuildSessionCommandArgv;
  execute: ExecuteSessionCommand;
  /** Both lanes retry the close through the owner-control path today. */
  control: boolean;
}

export async function runRemoveSession(deps: RemoveSessionDeps): Promise<void> {
  const argv = deps.buildArgv(["sessions", "close", deps.sessionName]);
  const result = deps.control
    ? await runAcpxControlCommand(() => deps.execute(argv, deps.timeoutMs))
    : await deps.execute(argv, deps.timeoutMs);
  if (result.code === 0) {
    return;
  }
  if (isMissingAcpxSessionError(result.stderr, result.stdout)) {
    return;
  }
  const detail = normalizeCommandError(result) ?? `command failed with exit code ${result.code}`;
  throw new Error(detail);
}

export interface HasSessionDeps {
  sessionName: string;
  timeoutMs: number;
  buildArgv: BuildSessionCommandArgv;
  execute: ExecuteSessionCommand;
}

export async function runHasSession(deps: HasSessionDeps): Promise<boolean> {
  const result = await deps.execute(deps.buildArgv(["sessions", "show", deps.sessionName]), deps.timeoutMs);
  return result.code === 0;
}

export interface DeleteSessionDeps {
  readRecord: () => Promise<{ acpxRecordId: string }>;
  remove: () => Promise<unknown>;
}

export async function runDeleteSession(deps: DeleteSessionDeps): Promise<void> {
  let acpxRecordId: string;
  try {
    ({ acpxRecordId } = await deps.readRecord());
  } catch {
    return; // acpx session already gone → nothing to delete
  }
  // Close the acpx session (terminates the queue owner + agent process since
  // acpx >=0.10), then unlink its on-disk files. See deleteAcpxSessionFiles for
  // the residual orphan-stream-file risk this leaves (a file-unlink timing /
  // Windows file-lock issue, not a live process — notably on Windows).
  await deps.remove();
  await deleteAcpxSessionFiles({ acpxRecordId });
}

export interface FreeWarmProcessDeps {
  readRecord: () => Promise<{ acpxRecordId: string }>;
}

export async function runFreeWarmProcess(deps: FreeWarmProcessDeps): Promise<void> {
  let acpxRecordId: string;
  try {
    ({ acpxRecordId } = await deps.readRecord());
  } catch {
    return; // acpx session already gone → no warm process to free
  }
  // Kill ONLY the warm queue-owner process; do NOT `sessions close` it (that
  // marks the record `closed` → unresumable, history lost). The record stays
  // open, so the next prompt resumes with full history.
  await terminateAcpxQueueOwner(acpxRecordId);
}

export interface IsSessionWarmDeps {
  /** Lane's cached record read: resolved id, or undefined when unknown/gone. */
  readCachedRecord: () => Promise<{ acpxRecordId: string } | undefined>;
}

export async function runIsSessionWarm(deps: IsSessionWarmDeps): Promise<boolean> {
  const record = await deps.readCachedRecord();
  if (!record) {
    return false;
  }
  const pid = await readQueueOwnerPid(record.acpxRecordId);
  if (pid === undefined) {
    return false;
  }
  return isProcessAlive(pid);
}

export interface CancelSessionDeps {
  sessionName: string;
  timeoutMs: number;
  buildArgv: BuildSessionCommandArgv;
  execute: ExecuteSessionCommand;
  /** Both lanes retry cancel through the owner-control path today. */
  control: boolean;
}

export async function runCancelSession(deps: CancelSessionDeps): Promise<{ cancelled: boolean; message: string }> {
  const output = await executeThrowingControlCommand(
    deps.buildArgv(["cancel", "-s", deps.sessionName]),
    deps.timeoutMs,
    deps.execute,
    deps.control,
  );
  return {
    cancelled: true,
    message: output.trim(),
  };
}

export interface GetAgentSessionIdDeps {
  readRecord: () => Promise<{ agentSessionId?: string }>;
}

export async function runGetAgentSessionId(deps: GetAgentSessionIdDeps): Promise<string | undefined> {
  const record = await deps.readRecord();
  return record.agentSessionId;
}

export interface SetSessionModeDeps {
  sessionName: string;
  modeId: string;
  timeoutMs: number;
  buildArgv: BuildSessionCommandArgv;
  execute: ExecuteSessionCommand;
  /** Both lanes retry set-mode through the owner-control path today. */
  control: boolean;
}

export async function runSetSessionMode(deps: SetSessionModeDeps): Promise<void> {
  await executeThrowingControlCommand(
    deps.buildArgv(["set-mode", "-s", deps.sessionName, deps.modeId]),
    deps.timeoutMs,
    deps.execute,
    deps.control,
  );
}

export interface ResumeAgentSessionDeps {
  sessionName: string;
  agentSessionId: string;
  timeoutMs: number;
  buildArgv: BuildSessionCommandArgv;
  execute: ExecuteSessionCommand;
  /** Lane maps a failed create to its own error (CLI: spawn diagnosis; bridge: bare). */
  mapFailure: (result: SessionCommandResult) => never;
  /**
   * Lane maps a rejected create to its own error. The CLI wraps every
   * rejection (spawn ENOENT included) in its spawn diagnosis and propagates
   * timeouts raw; the bridge converts timeouts to its session-init error and
   * rethrows the rest.
   */
  mapSpawnError: (error: unknown) => never;
}

export async function runResumeAgentSession(deps: ResumeAgentSessionDeps): Promise<void> {
  const argv = deps.buildArgv([
    "sessions",
    "new",
    "--name",
    deps.sessionName,
    "--resume-session",
    deps.agentSessionId,
  ]);
  let result: SessionCommandResult;
  try {
    result = await deps.execute(argv, deps.timeoutMs);
  } catch (error) {
    throw deps.mapSpawnError(error);
  }
  if (result.code !== 0) {
    throw deps.mapFailure(result);
  }
}
