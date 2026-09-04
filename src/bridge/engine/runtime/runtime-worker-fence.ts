/**
 * Durable Runtime Worker ownership fence — a GENERATION-BOUND STATE MACHINE
 * (plan §43 / G10, review rounds 29-32). A crashed Bridge Host's worker
 * adapter subtree is fenced by an atomic on-disk record; the record's phase
 * carries the ownership transaction across Host restarts.
 *
 * This function NEVER reconstructs ownership from a dead Windows parent PID.
 * If the owning generation did not publish a terminal phase or
 * generation-bound residual evidence before the root disappeared, the fence
 * remains fail-closed. Automatic dead-root recovery requires a
 * root-independent proof (Job Object or descendant-carried token) and is
 * intentionally disabled in this PR.
 *
 * The phase writes are performed ONLY by the fence's owning generation (the
 * worker receives its fence path + generation through spawn env) — a stale
 * generation can never overwrite a newer owner's record.
 */
import { mkdir, open, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import * as lockfile from "proper-lockfile";
/**
 * Per-fence-file cross-process mutex for generation CAS. Two-phase
 * acquisition: a single immediate attempt first, so deterministically
 * unwritable dirs (EACCES) fail fast and the read-only fail-closed tests
 * keep their timing; only a genuinely contested lock (ELOCKED) waits with
 * a generous budget (a live holder's critical section is sub-millisecond,
 * a crashed holder's lock goes stale after 10s). Never fail a legitimate
 * waiter with ELOCKED.
 */
async function withFenceLock<T>(path: string, fn: () => Promise<T>): Promise<T> {
  const acquire = (retries: number | { retries: number; factor: number; minTimeout: number; maxTimeout: number; randomize: boolean }): Promise<() => Promise<void>> =>
    lockfile.lock(path, {
      realpath: false,
      stale: 10_000,
      retries,
    });
  const run = async (release: () => Promise<void>): Promise<T> => {
    try {
      return await fn();
    } finally {
      await release();
    }
  };
  try {
    return await run(await acquire(0));
  } catch (error) {
    if ((error as { code?: unknown } | null)?.code !== "ELOCKED") throw error;
    return await run(
      await acquire({ retries: 200, factor: 1.2, minTimeout: 20, maxTimeout: 200, randomize: true }),
    );
  }
}
export type FencePhase = "claiming" | "owned" | "admitted" | "discharging" | "discharged" | "spooled";

export const FENCE_PHASES: readonly FencePhase[] = ["claiming", "owned", "admitted", "discharging", "discharged", "spooled"];

export interface RuntimeWorkerFenceRecord {
  kind: "runtime-worker-owner";
  logicalSessionId: string;
  /** The owning worker client generation — phase writers must match it. */
  generation: string;
  pid?: number;
  creationDate?: string | null;
  /** True once a business RPC could have entered (adapter tree possible). */
  bootstrapVerified: boolean;
  phase: FencePhase;
  startedAt: string;
  agent: string;
}

export type FenceReadResult =
  | { kind: "absent" }
  | { kind: "present"; record: RuntimeWorkerFenceRecord }
  | { kind: "unreadable"; reason: string };

export type FenceDischargeOutcome = "discharged" | "refused";
export type FenceLiveness = "alive" | "gone" | "unknown";
/**
 * Test-only interleaving hooks. Invoked while holding the per-fence
 * namespace lock, after validation and before mutation, so tests can pin
 * the exact H1-validated / H2-takeover / H1-resume schedule the production
 * lock makes impossible to observe otherwise. Never set in production.
 */
export interface FenceOpHooks {
  afterValidate?: (op: "retire" | "cas", key: string) => Promise<void>;
}
/**
 * Thrown when a fence mutation finds a different generation (or an illegal
 * predecessor phase) on disk. The caller MUST NOT retry blindly: a successor
 * generation owns the fence now, and any local worker spawned under the
 * stale generation is an orphan that must be terminated without touching
 * the fence.
 */
export class StaleFenceGenerationError extends Error {
  readonly code = "FENCE_STALE_GENERATION";
  constructor(message: string) {
    super(message);
    this.name = "StaleFenceGenerationError";
  }
}
export interface FenceDischargeDeps {
  platform?: NodeJS.Platform;
  /** Tri-state POSIX group probe (round 31 Blocking 4): only ESRCH proves gone. */
  probeProcessGroup?: (pgid: number) => "alive" | "gone" | "unknown";
  /**
   * Tri-state liveness probe for the claiming host that published a
   * pre-spawn claim (the claim record carries the claimant's pid). A LIVE
   * claimant may still be mid-spawn, so its claim is never time-stolen; a
   * PROVEN-GONE claimant lets the orphan claim discharge. Unknown (or no
   * probe for a pid-less legacy claim) keeps the legacy bounded wait.
   */
  probeClaimant?: (pid: number) => FenceLiveness | Promise<FenceLiveness>;
  /**
   * Tri-state liveness probe for a pre-bootstrap (unverified) worker behind
   * an `owned` fence. Same contract as probeClaimant: only a proven-gone
   * worker lets the never-admitted fence discharge without convergence.
   */
  probeWorker?: (record: RuntimeWorkerFenceRecord) => FenceLiveness | Promise<FenceLiveness>;
  waitMs?: (ms: number) => Promise<void>;
  now?: () => number;
  /** How long a new Host waits for the old worker's own EOF verdict (ms). */
  selfDischargeWaitMs?: number;
  /** Re-read the fence during the discharging wait (manager: same fence+key). */
  readBack?: () => Promise<FenceReadResult>;
  /** Persist the terminal "discharged" phase. `from` is the pre-image phase the table discharged from. */
  markDischarged?: (record: RuntimeWorkerFenceRecord, from: FencePhase[]) => Promise<void>;
  /**
   * Round 32 Blocking 3 — spool handshake: are residuals of this fence
   * generation still pending in the orphan registry? True = refuse, false =
   * the phase lifts to discharged.
   */
  spooledResidualsRemaining?: (generationId: string) => Promise<boolean>;
}

/** Default tri-state liveness: success=alive, ESRCH=gone, anything else=unknown. */
export function probeProcessGroupDefault(pgid: number): "alive" | "gone" | "unknown" {
  try {
    process.kill(-pgid, 0);
    return "alive";
  } catch (error) {
    if ((error as { code?: unknown } | null)?.code === "ESRCH") return "gone";
    // EPERM: the group may exist but we cannot verify — ownership evidence is
    // UNKNOWN, which must refuse, never silently discharge (round 31 B4).
    return "unknown";
  }
}

async function defaultWaitMs(ms: number): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, ms);
  await promise;
}

/**
 * Discharge one fenced worker tree per the phase decision table. Resolves
 * "discharged" only when a terminal proof exists; "refused" means the caller
 * MUST NOT spawn a second owner.
 *
 * Round 32 Blocking 2/4: the new Host NEVER externally kills a LIVE worker —
 * neither a POSIX process group by its bare historical PGID (reuse = wrong
 * group kill) nor a Windows root whose in-flight ensure may still spawn the
 * adapter (descendant-set quiescence). The live worker's own EOF gate is the
 * quiescence authority; H2 waits for its terminal phase, and a worker that
 * never settles leaves the fence in place (refuse). Without terminal/generation-bound proof, discharge is refused and
 * the fence is retained. Same-boot dead-root automated recovery requires
 * root-independent ownership proof and is intentionally unsupported here.
 */
export async function dischargeRuntimeWorkerFence(
  record: RuntimeWorkerFenceRecord,
  deps: FenceDischargeDeps = {},
): Promise<FenceDischargeOutcome> {
  const platform = deps.platform ?? process.platform;
  const waitMs = deps.waitMs ?? defaultWaitMs;
  const now = deps.now ?? Date.now;
  const waitSelfMs = deps.selfDischargeWaitMs ?? 90_000;

  // Pre-spawn claim (round 33 G2 crash-safe claim-before-spawn): a fence in
  // "claiming" phase has no worker yet — but it DOES name its claimant host
  // pid. A live claimant may still be mid-spawn, so its claim is never
  // time-stolen: after the wait window a still-live claimant refuses. Only
  // a proven-gone claimant (or a pid-less legacy claim past the window)
  // discharges. Even a wrong discharge is safe: the claimant's later owned
  if (record.phase === "claiming") {
    const claimantPid =
      typeof record.pid === "number" && Number.isSafeInteger(record.pid) && record.pid > 0
        ? record.pid
        : undefined;
    const claimWaitMs = Math.min(waitSelfMs, 2000);
    const deadline = now() + claimWaitMs;
    while (now() < deadline) {
      await waitMs(50);
      const reread = await deps.readBack?.();
      if (reread && reread.kind === "present" && reread.record.phase !== "claiming") {
        return await dischargeRuntimeWorkerFence(reread.record, deps);
      }
    }
    if (claimantPid !== undefined && deps.probeClaimant) {
      const state = await deps.probeClaimant(claimantPid);
      if (state !== "gone") return "refused";
    }
    await deps.markDischarged?.({ ...record, phase: "discharged" }, ["claiming"]);
    return "discharged";
  }


  // POSIX: the process group is only ever OBSERVED from out here. ESRCH is
  // the one proof of gone (round 31 Blocking 4); a live or unverifiable
  // group gets the self-discharge window, then refuses — never a kill(-pgid)
  // on a possibly-reused group id.
  if (platform !== "win32") {
    const probe = deps.probeProcessGroup ?? probeProcessGroupDefault;
    const deadline = now() + waitSelfMs;
    for (;;) {
      const state = probe(record.pid!);
      if (state === "gone") return "discharged";
      if (state === "unknown") return "refused";
      if (now() >= deadline) return "refused";
      await waitMs(500);
    }
  }
  // Windows: the phase decision table. The self-discharge window is the
  // cross-Host quiescence handoff — the old worker's EOF gate drains its
  // in-flight dispatches BEFORE converging, so its terminal phase is the
  // proof that the descendant set is final.
  let current = record;
  const phaseDeadline = now() + waitSelfMs;
  for (;;) {
    if (current.phase === "discharged") return "discharged";
    if (current.phase === "spooled") {
      // Round 32 Blocking 3: the spooled phase is NOT a permanent terminal —
      // the residual namespace is bound to the fence generation, and the
      // handshake asks the orphan registry whether EVERY residual of that
      // namespace has been converged. Empty → the phase lifts to discharged.
      const pending = (await deps.spooledResidualsRemaining?.(record.generation)) ?? true;
      if (pending) return "refused";
      await deps.markDischarged?.({ ...current, phase: "discharged" }, ["spooled"]);
      return "discharged";
    }
    if (current.phase === "owned" && !current.bootstrapVerified) {
      // The admission barrier (round 30 Blocking 2) makes this a hard
      // invariant: a fence that never reached "admitted" cannot have entered
      // a business RPC, so no adapter descendant can exist. The worker itself
      // (if still alive after a host death) self-terminates via stdin-EOF
      // convergence. Even so, a timeout alone never retires the fence: only
      // a PROVEN-GONE worker discharges here. A live worker gets the
      // quiescence window below; an unverifiable worker refuses (its EOF
      // gate is the authority that will publish the terminal phase).
      if (!deps.probeWorker) return "discharged";
      const workerState = await deps.probeWorker(current);
      if (workerState === "gone") return "discharged";
      if (workerState !== "alive") return "refused";
    }
    if (now() >= phaseDeadline) return "refused";
    await waitMs(500);
    const reread = await deps.readBack?.();
    if (!reread || reread.kind !== "present") return "refused";
    current = reread.record;
  }
}

/** Atomic crash-safe fence store: `<root>/<safeKey>.json` (temp + fsync + rename). */
export class RuntimeWorkerFence {
  readonly root: string;
  private readonly hooks?: FenceOpHooks;
  constructor(rootDir: string, hooks?: FenceOpHooks) {
    this.root = rootDir;
    if (hooks) this.hooks = hooks;
  }

  private pathFor(logicalSessionId: string): string {
    const safe = encodeURIComponent(logicalSessionId);
    if (!/^[A-Za-z0-9._-]+$/.test(safe)) throw new Error(`invalid fence key: ${logicalSessionId}`);
    return join(this.root, `${safe}.json`);
  }

  /**
   * G2 pre-spawn atomic physical claim: creates the fence file with O_EXCL.
   * Fails with EEXIST if another process/host claimed the fence first.
   * Holds the per-fence namespace lock across the check+create so a guarded
   * retire or CAS on the same key cannot interleave a delete between the
   * absence check and the create.
   */
  async claim(record: RuntimeWorkerFenceRecord): Promise<void> {
    const path = this.pathFor(record.logicalSessionId);
    await this.ensureDir(dirname(path));
    await withFenceLock(path, async () => {
      await this.claimLocked(path, record);
    });
  }
  private async claimLocked(path: string, record: RuntimeWorkerFenceRecord): Promise<void> {
    let handle;
    try {
      handle = await open(path, "wx", 0o600);
    } catch (error) {
      if ((error as { code?: unknown } | null)?.code === "EEXIST") {
        throw new Error(`fence for "${record.logicalSessionId}" already exists (cross-host race); refusing second owner`);
      }
      throw error;
    }
    // Only this O_EXCL creator may unlink: a write/sync failure below must
    // not leave a truncated file that reads "unreadable" (and bricks the
    // session) forever, and must never remove another host's fence.
    let created = true;
    try {
      await handle.writeFile(`${JSON.stringify(record, null, 2)}\n`, "utf8");
      await handle.sync();
      created = false;
    } catch (error) {
      if (created) {
        await unlink(path).catch(() => {});
      }
      throw error;
    } finally {
      await handle.close();
    }
  }

  async write(record: RuntimeWorkerFenceRecord): Promise<void> {
    const path = this.pathFor(record.logicalSessionId);
    await this.ensureDir(dirname(path));
    const tmp = `${path}.tmp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const handle = await open(tmp, "wx", 0o600);
    try {
      await handle.writeFile(`${JSON.stringify(record, null, 2)}\n`, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(tmp, path);
  }
  /**
   * Round 31 Blocking 1: only a PROVEN absence reads as "absent". Corrupt
   * JSON, an invalid schema/phase, or any I/O failure is "unreadable" — the
   * caller MUST refuse to spawn a second owner over evidence it cannot read.
   */
  async read(logicalSessionId: string): Promise<FenceReadResult> {
    let raw: string;
    try {
      raw = await readFile(this.pathFor(logicalSessionId), "utf8");
    } catch (error) {
      if ((error as { code?: unknown } | null)?.code === "ENOENT") return { kind: "absent" };
      return { kind: "unreadable", reason: error instanceof Error ? error.message : String(error) };
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return { kind: "unreadable", reason: "corrupt JSON" };
    }
    return parseFenceRecord(parsed, logicalSessionId);
  }

  /**
   * Generation-aware compare-and-swap: every post-claim phase transition
   * goes through here. Under the per-file lock, the current durable record
   * must still carry `expected.generation` and a phase in `expected.from`;
   * otherwise a StaleFenceGenerationError is thrown and the disk is left
   * untouched. A stalled claimant that wakes up after a successor took over
   * can therefore never overwrite the successor — it fails closed instead.
   * `record` itself must carry the expected generation.
   */
  async compareAndSwap(
    logicalSessionId: string,
    expected: { generation: string; from: FencePhase[] },
    record: RuntimeWorkerFenceRecord,
  ): Promise<void> {
    if (record.generation !== expected.generation || record.logicalSessionId !== logicalSessionId) {
      throw new StaleFenceGenerationError(
        `fence CAS for "${logicalSessionId}" carries generation "${record.generation}", expected "${expected.generation}"`,
      );
    }
    const path = this.pathFor(logicalSessionId);
    await this.ensureDir(dirname(path));
    await withFenceLock(path, async () => {
      let raw: string;
      try {
        raw = await readFile(path, "utf8");
      } catch (error) {
        if ((error as { code?: unknown } | null)?.code === "ENOENT") {
          throw new StaleFenceGenerationError(`fence CAS for "${logicalSessionId}" found no record (expected generation "${expected.generation}")`);
        }
        throw error;
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        throw new StaleFenceGenerationError(`fence CAS for "${logicalSessionId}" found an unreadable record; refusing to overwrite evidence`);
      }
      const current = parseFenceRecord(parsed, logicalSessionId);
      if (current.kind === "absent") {
        throw new StaleFenceGenerationError(`fence CAS for "${logicalSessionId}" found no record (expected generation "${expected.generation}")`);
      }
      if (current.kind !== "present") {
        throw new StaleFenceGenerationError(`fence CAS for "${logicalSessionId}" found an unreadable record (${current.reason}); refusing to overwrite evidence`);
      }
      if (current.record.generation !== expected.generation) {
        throw new StaleFenceGenerationError(
          `fence CAS for "${logicalSessionId}" found successor generation "${current.record.generation}", expected "${expected.generation}"; refusing overwrite`,
        );
      }
      if (!expected.from.includes(current.record.phase)) {
        throw new StaleFenceGenerationError(
          `fence CAS for "${logicalSessionId}" found phase "${current.record.phase}", expected one of [${expected.from.join(", ")}]; refusing overwrite`,
        );
      }
      await this.hooks?.afterValidate?.("cas", logicalSessionId);
      await this.writeAtomicLocked(path, `${JSON.stringify(record, null, 2)}\n`);
    });
  }
  /**
   * Worker-side phase mark (discharging/discharged/spooled) with the same
   * generation fencing as compareAndSwap. Returns "stale" (never throws)
   * when the fence no longer belongs to `generation` — the worker has lost
   * ownership and must converge its own tree and exit WITHOUT writing a
   * terminal mark over the successor. I/O failures still throw (the
   * durability retry contract in the worker EOF gate depends on it).
   */
  async markPhase(
    logicalSessionId: string,
    generation: string,
    phase: "discharging" | "discharged" | "spooled",
    opts: { pid?: number } = {},
  ): Promise<"updated" | "stale"> {
    const path = this.pathFor(logicalSessionId);
    return await withFenceLock(path, async () => {
      let raw: string;
      try {
        raw = await readFile(path, "utf8");
      } catch (error) {
        if ((error as { code?: unknown } | null)?.code === "ENOENT") return "stale" as const;
        throw error;
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        throw new Error("corrupt fence JSON");
      }
      if (typeof parsed !== "object" || parsed === null) throw new Error("corrupt fence JSON");
      const rec = parsed as Record<string, unknown>;
      if (rec.generation !== generation || rec.kind !== "runtime-worker-owner") return "stale" as const;
      // Crash-window hardening: a pid-less "claiming" record means the host
      // died after spawn() but before the "owned" upgrade durably landed.
      // The owning worker upgrades the claim with its own real pid BEFORE
      // transitioning — never manufacture a pid-less non-claiming fence.
      if (rec.phase === "claiming" && opts.pid !== undefined) {
        rec.pid = opts.pid;
      }
      rec.phase = phase;
      await this.writeAtomicLocked(path, `${JSON.stringify(rec, null, 2)}\n`);
      return "updated" as const;
    });
  }
  /**
   * Retire a fence. Pre-read first WITHOUT the namespace lock: an absent
   * fence (including a never-materialized fence dir) is idempotent success
   * and must not create the fence dir or lock files; an unreadable fence
   * fails closed without touching evidence. Only a present record enters
   * the per-fence namespace lock, where the whole re-read →
   * generation-check → unlink sequence holds the lock, so a concurrent
   * guarded retire or claim on the same key cannot interleave a
   * delete/create between our validation and our unlink. Round 31 High:
   * unlink failures are never silently swallowed — ENOENT is success,
   * anything else first persists the terminal "discharged" phase (durable
   * proof outranks the physical file), then retries once. A
   * still-unremovable file is left as a discharged record, which the next
   * acquire retires instead of bricking the session. When
   * `expectedGeneration` is given, a record owned by a different
   * (successor) generation is never unlinked:
   * StaleFenceGenerationError is thrown and the successor's fence is left
   * intact.
   */
  async retire(logicalSessionId: string, expectedGeneration?: string): Promise<void> {
    const path = this.pathFor(logicalSessionId);
    // Pre-read gate (no lock, no dir creation): absent (even with the fence
    // dir itself missing) is idempotent success. A G2 claimed between this
    // pre-read and our return is safe — we return without touching anything.
    // Unreadable fails closed: never unlink evidence we cannot attribute.
    const pre = await this.read(logicalSessionId);
    if (pre.kind === "absent") return;
    if (pre.kind === "unreadable") {
      if (expectedGeneration !== undefined) {
        throw new StaleFenceGenerationError(`guarded retire for "${logicalSessionId}" found an unreadable record (${pre.reason}); refusing to unlink evidence`);
      }
      throw new Error(`retire for "${logicalSessionId}" found an unreadable record (${pre.reason}); refusing to unlink evidence`);
    }
    await withFenceLock(path, async () => {
      // Re-read under the lock: a successor takeover between pre-read and
      // lock acquisition is caught by the generation check below.
      const read = await this.read(logicalSessionId);
      if (read.kind === "absent") return;
      if (read.kind === "unreadable") {
        if (expectedGeneration !== undefined) {
          throw new StaleFenceGenerationError(`guarded retire for "${logicalSessionId}" found an unreadable record (${read.reason}); refusing to unlink evidence`);
        }
        throw new Error(`retire for "${logicalSessionId}" found an unreadable record (${read.reason}); refusing to unlink evidence`);
      }
      if (expectedGeneration !== undefined && read.record.generation !== expectedGeneration) {
        throw new StaleFenceGenerationError(
          `guarded retire for "${logicalSessionId}" found successor generation "${read.record.generation}", expected "${expectedGeneration}"; refusing unlink`,
        );
      }
      await this.hooks?.afterValidate?.("retire", logicalSessionId);
      try {
        await unlink(path);
        return;
      } catch (error) {
        if ((error as { code?: unknown } | null)?.code === "ENOENT") return;
        // Still holding the lock: nobody else could have mutated the file,
        // so persisting the terminal phase here cannot clobber a successor.
        const reread = await this.read(logicalSessionId);
        if (reread.kind === "present" && reread.record.phase !== "discharged") {
          await this.writeAtomicLocked(path, `${JSON.stringify({ ...reread.record, phase: "discharged" }, null, 2)}\n`);
        }
        try {
          await unlink(path);
        } catch {
          // Left as a durable discharged record — the next acquire retires it.
        }
      }
    });
  }

  async remove(logicalSessionId: string): Promise<void> {
    try {
      await unlink(this.pathFor(logicalSessionId));
    } catch {
      // Removal failure is handled by retire(); kept for direct callers.
    }
  }
  private async ensureDir(dir: string): Promise<void> {
    // New fence dirs are user-private 0700; pre-existing dirs keep their
    // mode (production repair happens once at bridge startup, not on every
    // write, so read-only fault injection still fails closed).
    await mkdir(dir, { recursive: true, mode: 0o700 });
  }
  /**
   * Atomic tmp + fsync + rename write for use INSIDE withFenceLock (never
   * re-locks: proper-lockfile is not reentrant).
   */
  private async writeAtomicLocked(path: string, content: string): Promise<void> {
    const tmp = `${path}.tmp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const handle = await open(tmp, "wx", 0o600);
    try {
      await handle.writeFile(content, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(tmp, path);
  }
}
/**
 * Shared fence-record validation: every reader (plain read, CAS, worker
 * phase marks, guarded retire) agrees on what counts as present vs
 * unreadable, so a successor generation can never hide behind a parse
 * disagreement.
 */
function parseFenceRecord(parsed: unknown, logicalSessionId: string): FenceReadResult {
  if (typeof parsed !== "object" || parsed === null) return { kind: "unreadable", reason: "record is not an object" };
  const rec = parsed as Record<string, unknown>;
  if (rec.kind !== "runtime-worker-owner") return { kind: "unreadable", reason: "unknown record kind" };
  if (typeof rec.logicalSessionId !== "string" || rec.logicalSessionId !== logicalSessionId) {
    return { kind: "unreadable", reason: "logicalSessionId mismatch" };
  }
  if (typeof rec.generation !== "string" || rec.generation.length === 0) return { kind: "unreadable", reason: "invalid generation" };
  if (typeof rec.phase !== "string" || !FENCE_PHASES.includes(rec.phase as FencePhase)) return { kind: "unreadable", reason: "invalid phase" };
  if (rec.phase === "claiming") {
    if (rec.pid !== undefined && (!Number.isSafeInteger(rec.pid) || (rec.pid as number) <= 0)) {
      return { kind: "unreadable", reason: "invalid claiming pid" };
    }
  } else {
    if (!Number.isSafeInteger(rec.pid) || (rec.pid as number) <= 0) return { kind: "unreadable", reason: "invalid pid" };
  }
  if (rec.creationDate !== null && rec.creationDate !== undefined && typeof rec.creationDate !== "string") return { kind: "unreadable", reason: "invalid creationDate" };
  if (typeof rec.bootstrapVerified !== "boolean") return { kind: "unreadable", reason: "invalid bootstrapVerified" };
  if (typeof rec.startedAt !== "string" || typeof rec.agent !== "string") return { kind: "unreadable", reason: "invalid metadata" };
  return { kind: "present", record: parsed as unknown as RuntimeWorkerFenceRecord };
}
