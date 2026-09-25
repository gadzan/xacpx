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
 * which decides what equality means: a CIM `datetime` is quantized to
 * microseconds, so a CIM value differs from the kernel FILETIME by up to 9
 * ticks for the SAME process. Comparing timestamps without that attribution is
 * not an equivalence relation — a plain `abs(delta) <= 9` band can bridge two
 * distinct pid incarnations (CIM_A ~ handle_A and handle_A ~ CIM_B "proves"
 * CIM_A ~ CIM_B even when the kernel values are 18 ticks apart).
 */
export interface ProcessIdentity {
  pid: number;
  creationDate: string | null;
  fingerprintSource?: WindowsDescendantFingerprintSource;
  /**
   * Every creation-time print this identity has carried across merge rounds,
   * deduplicated on (pid, creationDate, provenance). Internal to merge: it is
   * what makes cluster matching transitive and keeps an established boundary
   * from being re-derived on a later round.
   */
  identityPrints?: readonly ProcessIdentity[];
}

/** CIM creationDate precision: 6-digit microseconds vs FILETIME's 100ns. */
export const CREATION_IDENTITY_TOLERANCE_TICKS = 9n;

/**
 * True when both records name the same process. A null creation time is only
 * compatible with ANOTHER null: two null-creation records DO collapse into one
 * entry (neither can be matched against a non-null one, so there is nothing to
 * separate them), while a null never merges with a timestamped record.
 *
 * Attribution decides what timestamp equality means:
 *   handle ↔ handle — exact. Both are the kernel value.
 *   cim ↔ cim       — exact. Both rows quantize the same instant identically.
 *   handle ↔ cim     — within the quantization window, SYMMETRICALLY. Which way
 *                      a provider rounds a FILETIME down to microseconds is not
 *                      a documented guarantee (`ManagementDateTimeConverter`
 *                      rounds to nearest), so the direction is never assumed.
 *   unattributed    — exact, on either side. `"unknown"` and an absent field
 *                      make no claim about quantization, so they grant no
 *                      tolerance.
 *
 * CAUTION: this pairwise relation is NOT transitive on its own, and merge does
 * not rely on it alone. A survivor may have been canonicalized from CIM to the
 * kernel value, so a later observation must be matched against the identity's
 * WHOLE print history, per provenance — see `joinsCluster`, which is what keeps
 * a reused pid from being bridged into an earlier incarnation.
 */
export function sameProcessIdentity(a: ProcessIdentity, b: ProcessIdentity): boolean {
  if (a.pid !== b.pid) return false;
  if (a.creationDate === null || b.creationDate === null) return a.creationDate === b.creationDate;
  if (a.fingerprintSource === b.fingerprintSource) return a.creationDate === b.creationDate;
  // An unattributed print (explicit "unknown" or an absent field) makes no claim
  // about quantization, so it grants no tolerance.
  const attributed = (source: ProcessIdentity["fingerprintSource"]): boolean =>
    source === "handle" || source === "cim";
  if (!attributed(a.fingerprintSource) || !attributed(b.fingerprintSource)) return a.creationDate === b.creationDate;
  // handle vs cim: the same instant through two quantizations. The window is
  // symmetric because the rounding direction is not guaranteed.
  const delta = BigInt(a.creationDate) - BigInt(b.creationDate);
  const magnitude = delta < 0n ? -delta : delta;
  return magnitude <= CREATION_IDENTITY_TOLERANCE_TICKS;
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
  /** Every creation-time print this identity has carried across merge rounds. */
  identityPrints?: readonly ProcessIdentity[];
}

/**
 * True when `item` names the same process as the identity that accumulated
 * `prints`.
 *
 * The print history is what makes matching transitive, because
 * `sameProcessIdentity` is pairwise and is NOT. A survivor may have been
 * canonicalized (the worker writes both kernel values back once it holds a
 * handle), and the superseded CIM print it replaced is exactly the benchmark a
 * later pid incarnation must be refused against: without it, tolerance would
 * bridge CIM_A ~ handle_A and handle_A ~ CIM_B into "CIM_A ~ CIM_B" for
 * processes whose kernel values are 18 ticks apart.
 *
 * The rule is decisive per provenance:
 *   - a print whose provenance the cluster ALREADY has joins only on exact
 *     equality — one instant quantizes one way, so two different values from the
 *     same source are two different processes, with no tolerance;
 *   - the cluster's FIRST print of a provenance joins the other provenance's
 *     benchmark inside the quantization window, in EITHER direction: which way a
 *     provider rounds a FILETIME down to microseconds is not a documented
 *     guarantee, so no direction is assumed;
 *   - unattributed prints (explicit "unknown", or an absent field) claim nothing
 *     about quantization and join only on exact equality — including against an
 *     attributed print of the same value.
 *
 * `distance` reports HOW WELL the item fits the cluster, so that a print matching
 * several incarnations of one pid can be assigned to the closest one instead of
 * the first.
 */
function clusterFit(item: ProcessIdentity, prints: readonly ProcessIdentity[]): { joins: boolean; distance: bigint } {
  // Identity is per process: a pid never joins another pid's cluster, whatever
  // the timestamps look like.
  if (!prints.some((record) => record.pid === item.pid)) return { joins: false, distance: -1n };
  // An exactly equal timestamp always joins. One instant prints one value through
  // any single source, so equality is identity in every attribution pairing —
  // including an unattributed print meeting an attributed one.
  const exact = prints.find((record) => record.creationDate === item.creationDate);
  if (exact) return { joins: true, distance: 0n };
  const print = (record: ProcessIdentity): { value: bigint; source: "handle" | "cim" } | null => {
    if (record.creationDate === null) return null;
    const source = record.fingerprintSource;
    if (source !== "handle" && source !== "cim") return null;
    return { value: BigInt(record.creationDate), source };
  };
  const itemPrint = print(item);
  // Unattributed item: no benchmark, so only exact-identical values join.
  if (!itemPrint) return { joins: false, distance: -1n };
  // An item arriving with its OWN history may carry a print of the cluster's
  // provenance: the two must agree, exactly, or they are different processes.
  // Without this, an observation carrying a foreign incarnation's history could
  // join on tolerance and silently bridge across a boundary an earlier round had
  // already established.
  const itemPrints = item.identityPrints ?? [item];
  if (false && !clustersCompatible(prints, itemPrints)) return { joins: false, distance: -1n };
  const same = prints.filter((record) => print(record)?.source === itemPrint.source);
  const other = prints.filter((record) => {
    const source = print(record)?.source;
    return source !== undefined && source !== itemPrint.source;
  });
  if (same.length > 0) {
    // The cluster already carries this provenance: exact equality only, which the
    // `exact` scan above already ruled out.
    return { joins: false, distance: -1n };
  }
  const magnitude = (a: bigint, b: bigint): bigint => (a > b ? a - b : b - a);
  const nearest = other
    .map((record) => magnitude(BigInt(record.creationDate!), itemPrint.value))
    .reduce<bigint | null>((best, distance) => (best === null || distance < best ? distance : best), null);
  if (nearest === null || nearest > CREATION_IDENTITY_TOLERANCE_TICKS) return { joins: false, distance: -1n };
  // Otherwise this is the cluster's FIRST print of the item's provenance, matched
  // against the other provenance's benchmark inside the window.
  return { joins: true, distance: nearest };
}

/**
 * A record's deduplicated print history: the same (pid, creationDate,
 * provenance) observation seen again adds nothing, because a cluster's decision
 * can only ever use one instance of a value.
 *
 * Deduplication is not cosmetic. `convergeOrphansBeforeExit` runs an UNBOUNDED
 * loop in production (no `maxRounds`, one round every `roundDelayMs`), and a
 * process that keeps failing convergence re-reports the same observation every
 * round. Appending without deduplication grows the history linearly with uptime
 * — and every cluster test scans it — so the comparison cost per round would grow
 * linearly too, quadratically in total. A legal identity needs at most one print
 * per provenance plus any unattributed exact ones, so the history is tiny by
 * construction.
 */
function dedupePrints(prints: readonly ProcessIdentity[]): ProcessIdentity[] {
  const seen = new Set<string>();
  return prints.filter((record) => {
    const key = `${record.pid}|${record.creationDate ?? ""}|${record.fingerprintSource ?? ""}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * True when two ALREADY-FORMED clusters may be treated as one process.
 *
 * Cluster↔cluster compatibility is a different question from "does a new
 * observation join a cluster", and it must be answered from BOTH histories: two
 * prints of the same provenance that disagree are two different processes, so
 * touching or overlapping histories alone cannot make the clusters compatible.
 * This is what keeps a boundary that an earlier round already established —
 * it is checked on every later round, because every round re-runs the merge.
 */
function clustersCompatible(left: readonly ProcessIdentity[], right: readonly ProcessIdentity[]): boolean {
  const print = (record: ProcessIdentity): { value: bigint; source: "handle" | "cim" } | null => {
    if (record.creationDate === null) return null;
    const source = record.fingerprintSource;
    if (source !== "handle" && source !== "cim") return null;
    return { value: BigInt(record.creationDate), source };
  };
  for (const source of ["handle", "cim"] as const) {
    const leftValues = new Set(left.filter((record) => print(record)?.source === source).map((record) => record.creationDate));
    if (leftValues.size === 0) continue;
    // Both clusters print this provenance: they must agree EXACTLY, in which case
    // one of them is redundant rather than a second incarnation.
    for (const record of right) {
      if (print(record)?.source !== source) continue;
      if (!leftValues.has(record.creationDate)) return false;
    }
  }
  return true;
}

/**
 * Merge two evidence lists by process identity: two records naming the same
 * process collapse to one (`winsOver` picks the survivor), and records naming
 * DIFFERENT processes all survive.
 *
 * This is a linear scan over a cluster test rather than a bucketed map. A bucket
 * cannot serve as a map key: its width is `2 * tolerance + 1` ticks, so two
 * creation times 10–18 ticks apart — provably DIFFERENT processes by the
 * comparator — land in the same bucket and one would silently overwrite the
 * other's evidence, discarding an unresolved ownership record. Evidence sets
 * here are tiny (an adapter tree), so the scan costs nothing and correctness is
 * directly readable from the comparator it calls.
 *
 * Cluster membership is decided by the print history carried on the record
 * (`identityPrints`), not by a per-call map, because merge runs once per
 * convergence round and the history must survive across all of them. A record
 * that merges in inherits the union of both print histories and keeps carrying
 * it, so a later round still sees the CIM print an earlier canonicalization
 * superseded.
 *
 * **The accumulated side is never re-clustered.** `a` already holds the clusters
 * earlier rounds established — each with the history that proved its boundary —
 * so it seeds the merge verbatim, and only `b`'s new observations are inserted.
 * Re-clustering `a` from scratch would let a cluster's SURVIVOR be matched
 * against another cluster, while the evidence that separated them (the superseded
 * CIM print inside its own history) is never consulted — so two incarnations that
 * an earlier round correctly kept apart would bridge back together, and the safe
 * record of the earlier one would erase the live one's unsafe evidence. That is a
 * false terminal proof, not merely a retry artefact. The worker protocol agrees:
 * a real round never repeats a pid (`decodeWindowsDescendantsResponse` keeps a
 * `seen` set), so nothing in `b` can require re-partitioning `a`.
 *
 * One pid can hold SEVERAL clusters (a reused pid), and a new print can sit
 * within tolerance of more than one of them. The CLOSEST cluster wins: taking the
 * first match would assign an observation to an earlier incarnation, leaving the
 * real one's unsafe evidence behind — a residual the reaper can never retire,
 * because replaying it against a root that already exited is retained
 * (`rootOutcome: already-exited` proves nothing about descendants), which would
 * keep the fence generation's spool namespace non-empty forever.
 */
function mergeByIdentity<T extends MergeableEvidence>(a: readonly T[], b: readonly T[]): T[] {
  // Seed with `a` exactly as-is: its clusters, their survivors, and their
  // boundaries are already established and must not be re-derived.
  const merged: T[] = a.map((item) => ({ ...item, identityPrints: dedupePrints(item.identityPrints ?? [item]) }));
  for (const item of [...b]) {
    const fits = merged
      .map((existing, index) => ({ index, ...clusterFit(item, existing.identityPrints ?? [existing]) }))
      .filter((fit) => fit.joins)
      .sort((left, right) => (left.distance < right.distance ? -1 : left.distance > right.distance ? 1 : left.index - right.index))[0];
    if (fits === undefined) {
      merged.push({ ...item, identityPrints: dedupePrints([...(item.identityPrints ?? []), item]) } as T);
      continue;
    }
    const current = merged[fits.index]!;
    const prints = dedupePrints([
      ...current.identityPrints ?? [current],
      ...item.identityPrints ?? [item],
    ]);
    // The survivor keeps its own observation, plus the deduplicated union of both
    // histories so a later round still sees what this one superseded.
    const survivor = (winsOver(item, current) ? item : current) as T;
    merged[fits.index] = { ...survivor, identityPrints: prints } as T;
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
