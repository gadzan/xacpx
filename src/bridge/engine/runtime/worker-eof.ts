/**
 * Worker-side orphan convergence on host EOF (plan §16 / G10).
 *
 * The host is gone — no RuntimeWorkerClient, no graceful shutdown. The worker
 * is the ONLY remaining process that knows its adapter descendant tree, and it
 * must not exit until either (a) cleanup is VERIFIED, or (b) every unverified
 * descendant identity is spooled as a durable `ResidualRecord` in the xacpx
 * orphan registry, where the daemon reaper (`sweepWindowsOrphans`) reconciles
 * it by handle-bound identity at the next startup/periodic sweep — a primitive
 * that survives both worker AND host death.
 *
 *   POSIX: the worker is its own process-group leader and adapter descendants
 *     inherit the group; kill the group (verified by construction).
 *   Windows: no parent-exit-kills-tree semantics; converge the transitive
 *     descendant tree via the verified CIM terminator, retry once for
 *     transient CIM/worker failures, then spool whatever remains unverified.
 *
 * Exiting after spooling is correct: a hostless worker that never exits would
 * itself leak, and the residual record is exactly the "ownership evidence that
 * outlives both processes" the fail-closed policy requires.
 */
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";

import { resolveConfigPathForCurrentEnv } from "../../../config/config-path";
import { terminateWindowsDescendantsOf, type TerminateDescendantsResult } from "../../../process/windows-process-tree";
import {
  OrphanRegistry,
  decodeResidualRecord,
  type ResidualRecord,
} from "../../../transport/orphan-registry";

export type OrphanConvergenceOutcome = "verified" | "spooled" | "unresolved";

export interface ConvergeOrphansOptions {
  platform?: NodeJS.Platform;
  /** POSIX path: kill the worker's own process group. */
  killProcessGroup?: () => void;
  /** Windows path override (tests). Defaults to the real CIM terminator. */
  terminateDescendants?: (parentPid: number) => Promise<TerminateDescendantsResult>;
  /** xacpx runtime dir holding `orphans/residuals` (tests). Defaults to `<config dir>/runtime`. */
  runtimeDir?: string;
  /** Agent command recorded on spooled residuals (worker ensure identity). */
  agentCommand?: () => string | undefined;
  generationId?: string;
  ownerToken?: string;
  delayBeforeRetryMs?: number;
  /** Deadline for each real CIM convergence attempt (ms). */
  attemptDeadlineMs?: number;
  now?: () => number;
}

function defaultRuntimeDir(): string {
  return join(dirname(resolveConfigPathForCurrentEnv()), "runtime");
}

interface SpoolCandidate {
  pid: number;
  creationDate: string | null;
  commandLine: string | null;
  executablePath: string | null;
}

/**
 * Persist durable ownership records for every descendant whose cleanup could
 * not be verified. Records lacking a complete CIM fingerprint (pid +
 * creationDate + commandLine + executablePath) are skipped: the reaper's
 * handle-bound kill requires independently captured identity, and fabricating
 * one would violate it.
 */
async function spoolResidualRecords(result: TerminateDescendantsResult, options: ConvergeOrphansOptions): Promise<number> {
  const runtimeDir = options.runtimeDir ?? defaultRuntimeDir();
  const record: Omit<ResidualRecord, "pid" | "creationDate" | "commandLine" | "executablePath"> = {
    kind: "residual",
    ownerToken: options.ownerToken ?? randomUUID(),
    agentCommand: options.agentCommand?.() ?? "runtime-worker-orphan",
    generationId: options.generationId ?? randomUUID(),
    killAttempts: 0,
  };
  const unsafe = result.outcomes
    .filter((item) => item.outcome !== "killed" && item.outcome !== "already-exited")
    .map((item): SpoolCandidate => ({ pid: item.pid, creationDate: item.creationDate, commandLine: item.commandLine, executablePath: item.executablePath }));
  const candidates: SpoolCandidate[] = [
    ...unsafe,
    ...result.leftover.map((item): SpoolCandidate => ({ pid: item.pid, creationDate: item.creationDate, commandLine: item.commandLine, executablePath: item.executablePath })),
  ];
  const registry = new OrphanRegistry(runtimeDir);
  await registry.initialize();
  let written = 0;
  for (const candidate of candidates) {
    if (candidate.creationDate === null || candidate.commandLine === null || candidate.executablePath === null) continue;
    const residual: ResidualRecord = {
      ...record,
      pid: candidate.pid,
      creationDate: candidate.creationDate,
      commandLine: candidate.commandLine,
      executablePath: candidate.executablePath,
    };
    if (!decodeResidualRecord(residual)) continue;
    try {
      await registry.writeResidual(residual);
      written += 1;
    } catch {
      // Keep spooling siblings; a single durable-write failure must not
      // abandon the remaining identities.
    }
  }
  return written;
}

export async function convergeOrphansBeforeExit(options: ConvergeOrphansOptions = {}): Promise<OrphanConvergenceOutcome> {
  const platform = options.platform ?? process.platform;
  if (platform !== "win32") {
    try {
      (options.killProcessGroup ?? ((): void => {
        process.kill(-process.pid, "SIGKILL");
      }))();
    } catch {
      // Best-effort: nothing else can be done once the host is gone.
    }
    return "verified";
  }
  const terminate = options.terminateDescendants
    ?? ((parentPid: number): Promise<TerminateDescendantsResult> =>
      terminateWindowsDescendantsOf(parentPid, { workerDeadlineMs: options.attemptDeadlineMs ?? 6_000 }));
  let result = await terminate(process.pid).catch(() => ({ verified: false, outcomes: [], leftover: [] }) as TerminateDescendantsResult);
  if (!result.verified) {
    const { promise, resolve } = Promise.withResolvers<void>();
    setTimeout(resolve, options.delayBeforeRetryMs ?? 250);
    await promise;
    result = await terminate(process.pid).catch(() => ({ verified: false, outcomes: [], leftover: [] }) as TerminateDescendantsResult);
  }
  if (result.verified) return "verified";
  try {
    const spooled = await spoolResidualRecords(result, options);
    return spooled > 0 ? "spooled" : "unresolved";
  } catch {
    return "unresolved";
  }
}
