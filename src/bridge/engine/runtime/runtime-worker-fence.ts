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
import { mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";

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
export interface FenceDischargeDeps {
  platform?: NodeJS.Platform;
  /** Tri-state POSIX group probe (round 31 Blocking 4): only ESRCH proves gone. */
  probeProcessGroup?: (pgid: number) => "alive" | "gone" | "unknown";
  waitMs?: (ms: number) => Promise<void>;
  now?: () => number;
  /** How long a new Host waits for the old worker's own EOF verdict (ms). */
  selfDischargeWaitMs?: number;
  /** Re-read the fence during the discharging wait (manager: same fence+key). */
  readBack?: () => Promise<FenceReadResult>;
  /** Persist the terminal "discharged" phase. */
  markDischarged?: (record: RuntimeWorkerFenceRecord) => Promise<void>;
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
  // "claiming" phase has no worker PID yet. Wait briefly (up to selfDischargeWaitMs
  // or 2s) to allow a concurrent in-flight spawn to publish its "owned" PID.
  // If it transitions to another phase, evaluate that phase.
  // If it remains "claiming" past the wait window, the host crashed before spawn;
  // it is safe to discharge the orphan claim without orphan-tree convergence.
  if (record.phase === "claiming") {
    const claimWaitMs = Math.min(waitSelfMs, 2000);
    const deadline = now() + claimWaitMs;
    while (now() < deadline) {
      await waitMs(50);
      const reread = await deps.readBack?.();
      if (reread && reread.kind === "present" && reread.record.phase !== "claiming") {
        return await dischargeRuntimeWorkerFence(reread.record, deps);
      }
    }
    await deps.markDischarged?.({ ...record, phase: "discharged" });
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
      await deps.markDischarged?.({ ...current, phase: "discharged" });
      return "discharged";
    }
    if (current.phase === "owned" && !current.bootstrapVerified) {
      // The admission barrier (round 30 Blocking 2, phase-serialised per
      // round 31 Blocking 1) makes this a hard invariant: a fence that never
      // reached "admitted" cannot have entered a business RPC, so no adapter
      // descendant can exist. The worker itself (if still alive after a host
      // death) self-terminates via stdin-EOF convergence.
      return "discharged";
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

  constructor(rootDir: string) {
    this.root = rootDir;
  }

  private pathFor(logicalSessionId: string): string {
    const safe = encodeURIComponent(logicalSessionId);
    if (!/^[A-Za-z0-9._-]+$/.test(safe)) throw new Error(`invalid fence key: ${logicalSessionId}`);
    return join(this.root, `${safe}.json`);
  }

  /**
   * G2 pre-spawn atomic physical claim: creates the fence file with O_EXCL.
   * Fails with EEXIST if another process/host claimed the fence first.
   */
  async claim(record: RuntimeWorkerFenceRecord): Promise<void> {
    const path = this.pathFor(record.logicalSessionId);
    await mkdir(dirname(path), { recursive: true });
    let handle;
    try {
      handle = await open(path, "wx", 0o600);
    } catch (error) {
      if ((error as { code?: unknown } | null)?.code === "EEXIST") {
        throw new Error(`fence for "${record.logicalSessionId}" already exists (cross-host race); refusing second owner`);
      }
      throw error;
    }
    try {
      await handle.writeFile(`${JSON.stringify(record, null, 2)}\n`, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
  }

  async write(record: RuntimeWorkerFenceRecord): Promise<void> {
    const path = this.pathFor(record.logicalSessionId);
    await mkdir(dirname(path), { recursive: true });
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
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      return { kind: "unreadable", reason: "corrupt JSON" };
    }
    if (parsed.kind !== "runtime-worker-owner") return { kind: "unreadable", reason: "unknown record kind" };
    if (typeof parsed.logicalSessionId !== "string" || parsed.logicalSessionId !== logicalSessionId) {
      return { kind: "unreadable", reason: "logicalSessionId mismatch" };
    }
    if (typeof parsed.generation !== "string" || parsed.generation.length === 0) return { kind: "unreadable", reason: "invalid generation" };
    if (typeof parsed.phase !== "string" || !FENCE_PHASES.includes(parsed.phase as FencePhase)) return { kind: "unreadable", reason: "invalid phase" };
    if (parsed.phase === "claiming") {
      if (parsed.pid !== undefined && (!Number.isSafeInteger(parsed.pid) || (parsed.pid as number) <= 0)) {
        return { kind: "unreadable", reason: "invalid claiming pid" };
      }
    } else {
      if (!Number.isSafeInteger(parsed.pid) || (parsed.pid as number) <= 0) return { kind: "unreadable", reason: "invalid pid" };
    }
    if (parsed.creationDate !== null && parsed.creationDate !== undefined && typeof parsed.creationDate !== "string") return { kind: "unreadable", reason: "invalid creationDate" };
    if (typeof parsed.bootstrapVerified !== "boolean") return { kind: "unreadable", reason: "invalid bootstrapVerified" };
    if (typeof parsed.startedAt !== "string" || typeof parsed.agent !== "string") return { kind: "unreadable", reason: "invalid metadata" };
    return { kind: "present", record: parsed as unknown as RuntimeWorkerFenceRecord };
  }

  /**
   * Retire a discharged fence. Round 31 High: unlink failures are never
   * silently swallowed — ENOENT is success, anything else first persists the
   * terminal "discharged" phase (durable proof outranks the physical file),
   * then retries once. A still-unremovable file is left as a discharged
   * record, which the next acquire retires instead of bricking the session.
   */
  async retire(logicalSessionId: string): Promise<void> {
    try {
      await unlink(this.pathFor(logicalSessionId));
      return;
    } catch (error) {
      if ((error as { code?: unknown } | null)?.code === "ENOENT") return;
      const read = await this.read(logicalSessionId);
      if (read.kind === "present" && read.record.phase !== "discharged") {
        await this.write({ ...read.record, phase: "discharged" });
      }
      try {
        await unlink(this.pathFor(logicalSessionId));
      } catch {
        // Left as a durable discharged record — the next acquire retires it.
      }
    }
  }

  async remove(logicalSessionId: string): Promise<void> {
    try {
      await unlink(this.pathFor(logicalSessionId));
    } catch {
      // Removal failure is handled by retire(); kept for direct callers.
    }
  }
}
