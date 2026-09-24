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
import { dirname, join, basename } from "node:path";
import { resolveConfigPathForCurrentEnv } from "../../../config/config-path";
import { RuntimeWorkerFence } from "./runtime-worker-fence";
import {
  terminateWindowsDescendantsOf,
  type KillOutcome,
  type TerminateDescendantsResult,
  type WindowsDescendantFingerprintSource,
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
  // Derive the fence key from the file name and mark under the per-file
  // lock: a successor generation's claim between our read and our rename
  // can no longer be overwritten — the mark reports "stale" instead and the
  // worker converges its own tree and exits without touching the fence.
  // Crash-window hardening is preserved: a pid-less "claiming" record means
  // the host died after spawn() but before the "owned" upgrade durably
  // landed, so the owning worker upgrades the claim with its own real pid
  // BEFORE transitioning — never manufacture a pid-less non-claiming fence.
  const file = basename(path);
  const key = file.endsWith(".json") ? decodeURIComponent(file.slice(0, -".json".length)) : file;
  const fence = new RuntimeWorkerFence(dirname(path));
  return await fence.markPhase(key, generation, phase, { pid: process.pid });
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
 * A process identity, NOT a fingerprint. `commandLine` and `executablePath` are
 * deliberately excluded: both are OBSERVATION fields whose value depends on how
 * the process was reached (a shim alias vs the resolved image) or on what the
 * CIM row happened to publish yet (the row can lag the handle-derived identity),
 * so keying on them splits ONE process into several identities. A split leaves
 * a stale record required forever — it is spooled as a residual for a process
 * that is already dead, and two "identities" for one pid compete for the single
 * durable filename `${ownerToken}-${pid}.json`, which read-back can never
 * satisfy.
 *
 * `pid` alone is not identity either on Windows (reuse), so the creation time is
 * part of it. `fingerprintSource` records HOW that creation time was obtained,
 * which decides what equality means: CIM quantizes 6-digit microseconds down to
 * a FILETIME tick grid, so a CIM value can be 0–9 ticks BELOW the kernel value
 * for the SAME process. Comparing without that attribution is not an
 * equivalence relation — it is a plain `abs(delta) <= 9` band, which can bridge
 * two distinct pid incarnations (CIM_A ~ handle_A and handle_A ~ CIM_B "proves"
 * CIM_A ~ CIM_B even when the kernel values are 18 ticks apart).
 */
export interface ProcessIdentity {
  pid: number;
  creationDate: string | null;
  fingerprintSource?: WindowsDescendantFingerprintSource;
}

/** CIM creationDate precision: 6-digit microseconds vs FILETIME's 100ns. */
export const CREATION_IDENTITY_TOLERANCE_TICKS = 9n;

/**
 * True when both records name the same process. A null creation time is only
 * compatible with ANOTHER null: two null-creation records DO collapse into one
 * entry (neither can be matched against a non-null one, so there is nothing to
 * separate them), while a null never merges with a timestamped record.
 *
 * Attribution decides what timestamp equality means, because the relation must
 * stay transitive — merge compares each new observation against the SURVIVOR,
 * which a previous round may have canonicalized:
 *   handle ↔ handle — exact. The kernel value has no quantization.
 *   cim ↔ cim       — exact. Both CIM rows for one process quantize the same
 *                      way, so one timestamped value represents the process.
 *   handle ↔ cim     — the CIM value may be 0–9 ticks BELOW the kernel value, so
 *                      only `0 <= handle - cim <= 9` is the same process. A NEGATIVE
 *                      delta is impossible for one process and proves a different one.
 *   unknown/absent  — exact: no attribution means no tolerance may be granted.
 *
 * With that, CIM_A ~ handle_A and handle_A ~ CIM_B imply handle_A ~ handle_B,
 * which requires `handle_B - handle_A == 0`; a pid reused 18 ticks later is
 * correctly a DIFFERENT process and both records stay required evidence.
 */
export function sameProcessIdentity(a: ProcessIdentity, b: ProcessIdentity): boolean {
  if (a.pid !== b.pid) return false;
  if (a.creationDate === null || b.creationDate === null) return a.creationDate === b.creationDate;
  const aHandle = a.fingerprintSource === "handle";
  const bHandle = b.fingerprintSource === "handle";
  if (aHandle === bHandle) {
    // Same attribution: both values come from one source, so they must match
    // bit for bit. Two CIM rows of one process quantize to the same number.
    return a.creationDate === b.creationDate;
  }
  // One kernel value, one quantized value: the quantized one can only sit
  // below, within the quantization window. Anything else is a different
  // process (see the three-observation bridge regression).
  const [handle, cim] = aHandle
    ? [a.creationDate, b.creationDate] as const
    : [b.creationDate, a.creationDate] as const;
  const offset = BigInt(handle) - BigInt(cim);
  return offset >= 0n && offset <= CREATION_IDENTITY_TOLERANCE_TICKS;
}

/**
 * Exact publication identity: `pid` + the retained creation time, with NO
 * tolerance.
 *
 * This is deliberately stricter than `sameProcessIdentity`, because it answers a
 * different question — "is THIS record durable?", not "is this the same
 * process?". A residual file is keyed by pid alone (`${ownerToken}-${pid}.json`),
 * so two distinct identities that share a pid (a reused pid, creation times 10+
 * ticks apart) cannot both be durable. Any tolerance here would let one file
 * prove both were published, i.e. a false proof of ownership for the process
 * whose evidence was silently overwritten.
 *
 * Deliberately NOT exported: publication has exactly one decision point
 * (`publishRequired`), and a second consumer would have to re-derive the
 * filename/read-back correspondence to stay correct.
 */
function publicationIdentity(item: ProcessIdentity): string {
  return `${item.pid}|${item.creationDate ?? ""}`;
}

/**
 * Merge one convergence attempt into the accumulated evidence. Monotonic: a
 * later attempt can only ADD identities or RESOLVE previously unsafe ones —
 * it can never erase evidence, so a total failure on a retry cannot discard
 * what an earlier attempt already captured.
 */
export function mergeEvidence(a: TerminateDescendantsResult, b: TerminateDescendantsResult): TerminateDescendantsResult {
  // Both lists participate in ONE arbitration per process, so provenance and
  // completeness decide any collision — including an outcome meeting a leftover.
  // An outcome carrying a weaker fingerprint must not silently displace a
  // stronger leftover: the discarded record is exactly what would have been
  // spooled with exact handle fencing.
  const arbitrated = mergeByIdentity<MergedEvidence>([
    ...a.outcomes,
    ...a.leftover,
  ], [
    ...b.outcomes,
    ...b.leftover,
  ]);
  // The survivor keeps the KIND it won as, so a process is represented once and
  // only once: either resolved (an outcome) or still required (a leftover). This
  // is what keeps the durable filename `${ownerToken}-${pid}.json` unambiguous —
  // two records for one pid could never both be proven published.
  return {
    verified: a.verified || b.verified,
    outcomes: arbitrated.filter((item): item is WindowsDescendantOutcome => "outcome" in item),
    leftover: arbitrated.filter((item): item is WindowsDescendantLeftover => !("outcome" in item)),
  };
}

/**
 * An arbitrated evidence record: either kind, discriminated by `parentPid`
 * (present only on leftovers) as `mergeByIdentity` preserves the input object
 * verbatim.
 */
type MergedEvidence = WindowsDescendantOutcome | WindowsDescendantLeftover;

/**
 * The evidence shape shared by outcomes and leftovers: a process identity plus
 * the observation fields `winsOver` compares when picking the survivor. An
 * `outcome` is absent on a leftover, which is correct: a leftover is by
 * definition an unresolved process, i.e. never "resolved".
 */
interface MergeableEvidence extends ProcessIdentity {
  outcome?: KillOutcome;
  fingerprintSource?: WindowsDescendantFingerprintSource;
  commandLine: string | null;
  executablePath: string | null;
  /** Present only on leftovers; carried through so the kind survives arbitration. */
  parentPid?: number;
}

/**
 * Merge two evidence lists by process identity: two records naming the same
 * process collapse to one (`winsOver` picks the survivor), and records naming
 * DIFFERENT processes all survive.
 *
 * This is a linear scan over `sameProcessIdentity` rather than a bucketed map.
 * A bucket cannot serve as a map key: its width is `2 * tolerance + 1` ticks, so
 * two creation times 10–18 ticks apart — provably DIFFERENT processes by the
 * comparator — land in the same bucket and one would silently overwrite the
 * other's evidence, discarding an unresolved ownership record. Evidence sets
 * here are tiny (an adapter tree), so the scan costs nothing and correctness is
 * directly readable from the comparator it calls.
 */
function mergeByIdentity<T extends MergeableEvidence>(a: readonly T[], b: readonly T[]): T[] {
  const merged: T[] = [];
  for (const item of [...a, ...b]) {
    const index = merged.findIndex((existing) => sameProcessIdentity(existing, item));
    if (index === -1) {
      merged.push(item);
      continue;
    }
    if (winsOver(item, merged[index]!)) merged[index] = item;
  }
  return merged;
}

/**
 * True when `next` should replace `current` as the retained record for one
 * process identity, in order:
 *   1. resolution  — an explicitly SAFE outcome resolves the process; a leftover
 *                    (no outcome) is unresolved and must stay required evidence;
 *   2. completeness — a full fingerprint can become durable evidence, an
 *                     incomplete one cannot, and must NOT sit in the way of one
 *                     that can, regardless of provenance. An incomplete
 *                     handle-derived record blocking a complete CIM one is a
 *                     livelock: the survivor could never be spooled while the
 *                     discarded one publishes cleanly;
 *   3. provenance   — handle > cim > unknown (kernel values are authoritative);
 *   4. incumbent    — otherwise keep the first observation (deterministic).
 *
 * Completeness outranks provenance precisely where provenance alone is not a
 * discharge criterion but publishability is: `residualFor` records every
 * non-handle provenance as "cim" anyway, so a complete CIM fingerprint becomes
 * fully durable evidence while an incomplete handle one publishes nothing.
 */
function winsOver(next: MergeableEvidence, current: MergeableEvidence): boolean {
  const nextResolved = next.outcome !== undefined && next.outcome in SAFE_OUTCOMES;
  const currentResolved = current.outcome !== undefined && current.outcome in SAFE_OUTCOMES;
  if (nextResolved !== currentResolved) return nextResolved;
  // A complete fingerprint can become durable evidence; an incomplete one
  // cannot, and must not sit in the way of one that can.
  const nextComplete = next.creationDate !== null && next.commandLine !== null && next.executablePath !== null;
  const currentComplete = current.creationDate !== null && current.commandLine !== null && current.executablePath !== null;
  if (nextComplete !== currentComplete) return nextComplete;
  const nextRank = provenanceRank(next.fingerprintSource);
  const currentRank = provenanceRank(current.fingerprintSource);
  if (nextRank !== currentRank) return nextRank > currentRank;
  return false;
}

function provenanceRank(source: WindowsDescendantFingerprintSource | undefined): number {
  if (source === "handle") return 2;
  if (source === "cim") return 1;
  return 0;
}
/**
 * Spawn a durable residual from one evidence record. The provenance is carried
 * through verbatim so the reaper's replay can pick the tolerance that matches
 * how the fingerprint was obtained — an exact compare against a CIM-quantized
 * creationDate would condemn every legitimate record.
 */
function residualFor(
  candidate: WindowsDescendantOutcome | WindowsDescendantLeftover,
  base: Omit<ResidualRecord, "pid" | "creationDate" | "commandLine" | "executablePath" | "fingerprintSource">,
): ResidualRecord {
  return {
    ...base,
    pid: candidate.pid,
    creationDate: candidate.creationDate ?? "",
    commandLine: candidate.commandLine ?? "",
    executablePath: candidate.executablePath ?? "",
    // Only a handle-derived fingerprint is trustworthy under an exact compare;
    // anything else (including an unattributed one) is recorded as CIM-derived,
    // which demands the WIDER replay match (±9 ticks, no path equality). That is
    // the intended default for a record whose provenance is unknown.
    fingerprintSource: candidate.fingerprintSource === "handle" ? "handle" : "cim",
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
  } satisfies Omit<ResidualRecord, "pid" | "creationDate" | "commandLine" | "executablePath" | "fingerprintSource">;
  // The registry is the ONLY authority on what is durable. `published` is not a
  // cross-round cache: a residual file is keyed by pid alone, so a later write
  // for a DIFFERENT identity of the same pid silently overwrites an earlier one.
  // "A write succeeded once" is therefore not "A is still durable", and trusting
  // it would leave a required identity unwritten forever while the read-back
  // keeps failing — the worker keeps ownership (correct) but can never converge
  // even once writing would succeed (livelock). Deciding solely from the current
  // registry content keeps the state model one-layered, and the evidence set is
  // small enough that the extra reads cost nothing.
  const passes = options.spoolRetryPasses ?? 3;
  for (let pass = 0; pass < passes; pass += 1) {
    const present = await durableIdentities(registry, discharge);
    // A read that fails must not be mistaken for "everything is written".
    if (present === null) return false;
    const pending = complete.filter((item) => !present.has(publicationIdentity(item)));
    let failed = 0;
    for (const candidate of pending) {
      const record = residualFor(candidate, base);
      if (!decodeResidualRecord(record)) return false;
      try {
        await registry.writeResidual(record);
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
  // Final proof: every required identity must be present in the registry RIGHT
  // NOW, by exact identity AND as a record THIS discharge wrote. A residual file
  // is keyed by pid alone, so two distinct identities sharing a pid cannot both
  // be durable — proving them from one file would be a false proof of ownership
  // for the record that was overwritten.
  const present = await durableIdentities(registry, discharge);
  return fullyPublishable && present !== null && complete.every((item) => present.has(publicationIdentity(item)));
}

/**
 * Exact identities currently durable **for this discharge**, or null when the
 * registry cannot be read (which is NOT the same as "nothing is written").
 *
 * Scoped by `generationId` and `ownerToken`: a residual left by an EARLIER
 * generation names the same process with the same fingerprint, and treating it
 * as proof would let the current discharge skip writing its own record and then
 * claim "spooled". The fence handshake that lifts the fence is generation-bound
 * (`runtime-worker-manager` only counts records whose `generationId` matches),
 * so it would not see the foreign record — a false terminal proof that then lets
 * a successor owner in.
 */
async function durableIdentities(
  registry: OrphanRegistry,
  discharge: { ownerToken: string; generationId: string },
): Promise<Set<string> | null> {
  const records = await registry.readCategory("residuals").catch(() => null);
  if (!records) return null;
  return new Set(
    records.flatMap(({ record }) => ("pid" in record && "creationDate" in record
      && record.generationId === discharge.generationId
      && record.ownerToken === discharge.ownerToken
      ? [publicationIdentity({ pid: record.pid, creationDate: record.creationDate })]
      : [])),
  );
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
      if (await publishRequired(evidence, discharge, options)) return "spooled";
      if (options.maxRounds !== undefined && round + 1 >= options.maxRounds) return "unresolved";
    }
    await delay(options.roundDelayMs ?? 2_000);
  }
}
