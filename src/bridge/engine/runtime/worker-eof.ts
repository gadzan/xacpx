/**
 * Worker-side orphan convergence on host EOF (plan §16 / G10).
 *
 * The host is gone — no RuntimeWorkerClient, no graceful shutdown. The worker
 * is the ONLY remaining process that knows its adapter descendant tree, and it
 * may exit ONLY after reaching one of exactly two terminal discharge states:
 *
 *   "verified"  — every discovered descendant reached a verified safe outcome
 *                 and a fresh final CIM snapshot shows none remain.
 *   "spooled"   — every still-unverified descendant identity has been durably
 *                 published as a `ResidualRecord` in the xacpx orphan registry
 *                 (all-or-nothing: publication counts only when EVERY required
 *                 identity is confirmed present), where the daemon reaper
 *                 (`sweepWindowsOrphans`) reconciles it by handle-bound
 *                 identity at the next sweep — surviving both worker AND host
 *                 death.
 *
 * Anything else — transient CIM/worker failure, a record that cannot be
 * published — keeps the worker ALIVE and retrying. A live worker is not an
 * orphan condition: the descendant tree still has its parent, and the worker
 * remains the sole holder of tree knowledge. Avoiding worker self-leak must
 * never take priority over discharging ownership evidence.
 *
 * Evidence is MONOTONIC: each convergence attempt is merged into the
 * accumulated result (never overwritten), so a later total failure cannot
 * erase identities an earlier attempt already captured.
 *
 *   POSIX: the worker is its own process-group leader and adapter descendants
 *     inherit the group; kill the group (verified by construction).
 *   Windows: no parent-exit-kills-tree semantics; converge the transitive
 *     descendant tree via the verified CIM terminator, then publish whatever
 *     remains unverified.
 */
import { randomUUID } from "node:crypto";
import { open, readFile, rename } from "node:fs/promises";
import { dirname, join } from "node:path";
import { resolveConfigPathForCurrentEnv } from "../../../config/config-path";
import {
  terminateWindowsDescendantsOf,
  type KillOutcome,
  type TerminateDescendantsResult,
  type WindowsDescendantLeftover,
  type WindowsDescendantOutcome,
} from "../../../process/windows-process-tree";
import {
  OrphanRegistry,
  decodeResidualRecord,
  type ResidualRecord,
} from "../../../transport/orphan-registry";


/**
 * Round 31 Blocking 2/3 — the worker's OWN durable phase marking. The fence
 * path and generation arrive via spawn env; writes are generation-bound so a
 * stale worker can never touch a newer owner's fence.
 *   discharging: written at EOF start (BEFORE convergence snapshots) so a
 *                new Host waits for the worker's verdict instead of racing
 *                an in-flight ensure with its own kill transaction.
 *   discharged / spooled: the terminal proof — the worker converged the
 *                tree (safe respawn) or durably published the leftovers.
 */
export type FenceMarkResult = "updated" | "stale";

/**
 * Round 32 High — fence phase marking is a TRI-STATE durable write:
 *   "updated"  the phase is durably on disk.
 *   "stale"    the fence is absent or belongs to another generation —
 *              nothing to mark (a newer owner owns the transaction).
 *   throws     the write FAILED (disk full, EACCES, rename error...). The
 *              caller MUST NOT treat this as success: the worker keeps
 *              living and retrying the mark rather than exiting with a
 *              "discharging" fence that no later Host can lift.
 */
export async function markRuntimeWorkerFence(phase: "discharging" | "discharged" | "spooled"): Promise<FenceMarkResult> {
  const path = process.env.XACPX_WORKER_FENCE;
  const generation = process.env.XACPX_WORKER_FENCE_GENERATION;
  if (!path || !generation) return "stale";
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (error) {
    if (error !== null && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      return "stale";
    }
    throw error;
  }
  const parsedRaw = JSON.parse(raw);
  if (typeof parsedRaw !== "object" || parsedRaw === null) throw new Error("corrupt fence JSON");
  const parsed = parsedRaw as Record<string, unknown>; // validated object, generation/kind checked next line
  if (parsed.generation !== generation || parsed.kind !== "runtime-worker-owner") return "stale";
  // Crash-window hardening: the host may have died after spawn() but before
  // the "owned" upgrade durably landed, leaving a pid-less "claiming"
  // record. A non-claiming phase without a pid reads as "unreadable"
  // forever (permanent wedge), so the owning worker upgrades the claim with
  // its own real pid BEFORE transitioning — never manufacture a pid-less
  // non-claiming fence.
  if (parsed.phase === "claiming") {
    parsed.pid = process.pid;
  }
  parsed.phase = phase;
  const tmp = `${path}.tmp-${randomUUID()}`;
  const handle = await open(tmp, "wx", 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(parsed, null, 2)}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(tmp, path);
  return "updated";
}
/** Default runtime dir for the orphan registry (config-dir based). */
export function defaultRuntimeDir(): string {
  return join(dirname(resolveConfigPathForCurrentEnv()), "runtime");
}

export type OrphanConvergenceOutcome = "verified" | "spooled" | "unresolved";
const SAFE_OUTCOMES: Partial<Record<KillOutcome, true>> = { killed: true, "already-exited": true };

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
  /**
   * Deadline for each real CIM convergence attempt (ms). Defaults to null:
   * EOF convergence deliberately sets NO outer hard-kill deadline — the
   * in-script snapshot watchdog (8s) and per-handle WaitDead (2s) bound the
   * action, and a mid-traversal SIGKILL would lose ancestry reachability
   * AND any partially-collected evidence. A numeric value is honored for
   * tests and non-EOF callers.
   */
  attemptDeadlineMs?: number | null;
  /** Delay between convergence rounds when discharge is still incomplete (ms). */
  roundDelayMs?: number;
  /**
   * Bound on convergence rounds for TESTS; production leaves this undefined so
   * the worker lingers until "verified" or "spooled" instead of exiting with
   * ownership undischarged.
   */
  maxRounds?: number;
  spoolRetryPasses?: number;
  spoolRetryDelayMs?: number;
  now?: () => number;
}

const EMPTY_EVIDENCE: TerminateDescendantsResult = { verified: false, outcomes: [], leftover: [] };

/**
 * Merge one convergence attempt into the accumulated evidence. Monotonic: a
 * later attempt can only ADD identities or RESOLVE previously unsafe ones —
 * it can never erase evidence, so a total failure on a retry cannot discard
 * what an earlier attempt already captured.
 */
/**
 * Stable evidence identity: pid is NOT identity on Windows (reuse), so every
 * merge/publication/verification decision is keyed on the full observed
 * fingerprint. Two records sharing a pid but differing in creationDate are
 * DIFFERENT processes and both stay required evidence.
 */
export function evidenceIdentity(item: { pid: number; creationDate: string | null; commandLine: string | null; executablePath: string | null }): string {
  return `${item.pid}|${item.creationDate ?? ""}|${item.executablePath ?? ""}|${item.commandLine ?? ""}`;
}

export function mergeEvidence(a: TerminateDescendantsResult, b: TerminateDescendantsResult): TerminateDescendantsResult {
  const byIdentity = new Map<string, WindowsDescendantOutcome>();
  for (const item of [...a.outcomes, ...b.outcomes]) {
    const key = evidenceIdentity(item);
    const existing = byIdentity.get(key);
    if (!existing || (SAFE_OUTCOMES[item.outcome] && !SAFE_OUTCOMES[existing.outcome])) byIdentity.set(key, item);
  }
  const leftover = new Map<string, WindowsDescendantLeftover>();
  for (const item of [...a.leftover, ...b.leftover]) {
    const key = evidenceIdentity(item);
    if (!byIdentity.has(key)) leftover.set(key, item);
  }
  for (const key of byIdentity.keys()) leftover.delete(key);
  const outcomes = [...byIdentity.values()];
  const remaining = [...leftover.values()];
  return {
    // Attempt-level proof, never recomputed from accumulated evidence: an
    // empty merged set must NOT count as a verified empty tree. Only a real
    // terminate-descendants-of attempt whose own final snapshot showed every
    // discovered descendant safe and none remaining proves discharge.
    verified: a.verified || b.verified,
    outcomes,
    leftover: remaining,
  };
}
function residualFor(candidate: WindowsDescendantOutcome | WindowsDescendantLeftover, base: Omit<ResidualRecord, "pid" | "creationDate" | "commandLine" | "executablePath">): ResidualRecord {
  return {
    ...base,
    pid: candidate.pid,
    creationDate: candidate.creationDate ?? "",
    commandLine: candidate.commandLine ?? "",
    executablePath: candidate.executablePath ?? "",
  };
}

/**
 * Publish EVERY still-unverified identity as a durable residual record.
 * All-or-nothing: returns true only when all required records were written AND
 * confirmed present by reading the registry back. Partial publication is
 * failure — the caller must not exit with some required identity unpublished.
 */
async function publishRequired(
  evidence: TerminateDescendantsResult,
  published: Set<string>,
  discharge: { ownerToken: string; generationId: string },
  options: ConvergeOrphansOptions,
): Promise<boolean> {
  const required: Array<WindowsDescendantOutcome | WindowsDescendantLeftover> = [
    ...evidence.outcomes.filter((item) => !SAFE_OUTCOMES[item.outcome]),
    ...evidence.leftover,
  ];
  if (required.length === 0) return false;
  const complete = required.filter((item) => item.creationDate !== null && item.commandLine !== null && item.executablePath !== null);
  // An unverified identity without a complete CIM fingerprint cannot become a
  // handle-bound record. Every completable record is still written (durable
  // evidence is strictly additive), but full discharge stays impossible, so
  // the caller can never observe "spooled" while a required identity is
  // unpublished.
  const fullyPublishable = complete.length === required.length;
  const registry = new OrphanRegistry(options.runtimeDir ?? defaultRuntimeDir());
  try {
    await registry.initialize();
  } catch {
    return false;
  }
  const base = {
    kind: "residual",
    ownerToken: discharge.ownerToken,
    agentCommand: options.agentCommand?.() ?? "runtime-worker-orphan",
    generationId: discharge.generationId,
    killAttempts: 0,
  } satisfies Omit<ResidualRecord, "pid" | "creationDate" | "commandLine" | "executablePath">;
  const passes = options.spoolRetryPasses ?? 3;
  for (let pass = 0; pass < passes; pass += 1) {
    const pending = complete.filter((item) => !published.has(evidenceIdentity(item)));
    let failed = 0;
    for (const candidate of pending) {
      const record = residualFor(candidate, base);
      if (!decodeResidualRecord(record)) return false;
      try {
        await registry.writeResidual(record);
        published.add(evidenceIdentity(candidate));
      } catch {
        failed += 1;
      }
    }
    if (pending.length === 0 || (failed === 0 && pass > 0)) break;
    if (failed > 0) {
      const { promise, resolve } = Promise.withResolvers<void>();
      setTimeout(resolve, options.spoolRetryDelayMs ?? 100);
      await promise;
    }
  }
  // Read-back verification: publication is proven by registry content whose
  // FULL fingerprint (pid + creationDate + executablePath + commandLine)
  // matches the required identity — a same-pid record from a different
  // (reused) process proves nothing.
  const records = await registry.readCategory("residuals").catch(() => null);
  if (!records) return false;
  const present = new Set(
    records.flatMap(({ record }) => ("pid" in record && "creationDate" in record
      ? [evidenceIdentity({ pid: record.pid, creationDate: record.creationDate, commandLine: record.commandLine ?? null, executablePath: record.executablePath ?? null })]
      : [])),
  );
  return fullyPublishable && complete.every((item) => present.has(evidenceIdentity(item)));
}

async function attemptOnce(options: ConvergeOrphansOptions): Promise<TerminateDescendantsResult> {
  const attempt = options.terminateDescendants
    ?? ((parentPid: number): Promise<TerminateDescendantsResult> =>
      terminateWindowsDescendantsOf(parentPid, { workerDeadlineMs: options.attemptDeadlineMs ?? null }));
  return Promise.resolve(attempt(process.pid)).catch(() => ({ ...EMPTY_EVIDENCE }));
}

async function delay(ms: number): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, ms);
  await promise;
}

/**
 * Discharge the orphan tree. Resolves ONLY on a terminal discharge state:
 * "verified" or "spooled". When discharge remains impossible (and `maxRounds`
 * is undefined — production), the promise stays pending and the worker lingers
 * as the live, knowledgeable owner instead of exiting with evidence lost.
 */
export async function convergeOrphansBeforeExit(options: ConvergeOrphansOptions = {}): Promise<OrphanConvergenceOutcome> {
  const platform = options.platform ?? process.platform;
  if (platform !== "win32") {
    // G10 (cross-platform): the group kill IS the ownership discharge on
    // POSIX. A throwing kill must NOT be upgraded to "verified" — that would
    // let runtime-worker-main exit its root while adapter descendants may
    // still be alive with no durable evidence. Reject instead: the caller's
    // retry wiring (runtime-worker-main re-attempts every second) keeps the
    // worker alive and still the accountable owner.
    (options.killProcessGroup ?? ((): void => {
      process.kill(-process.pid, "SIGKILL");
    }))();
    return "verified";
  }
  // Convergence gets two bounded attempts (fresh CIM snapshots) BEFORE
  // publication, so a transient failure on a retry cannot discard evidence
  // an earlier attempt captured — the merge is monotonic, and publication
  // then discharges everything still unverified in one all-or-nothing step.
  // After the first publication pass, every further round retries both
  // convergence and publication until discharge is terminal.
  let evidence = EMPTY_EVIDENCE;
  // One stable proof namespace for the whole discharge: records published by
  // different rounds share it, so the read-back can match them exactly.
  const published = new Set<string>();
  const discharge = {
    ownerToken: options.ownerToken ?? randomUUID(),
    generationId: options.generationId ?? randomUUID(),
  };
  for (let round = 0; ; round += 1) {
    evidence = mergeEvidence(evidence, await attemptOnce(options));
    if (evidence.verified) return "verified";
    // Publication only after the bounded convergence attempts: a transient
    // failure on the retry must not be outrun by an early spool, and the
    // retry must not be skipped because round zero already published.
    if (round >= 1) {
      if (await publishRequired(evidence, published, discharge, options)) return "spooled";
      if (options.maxRounds !== undefined && round + 1 >= options.maxRounds) return "unresolved";
    }
    await delay(options.roundDelayMs ?? 2_000);
  }
}
