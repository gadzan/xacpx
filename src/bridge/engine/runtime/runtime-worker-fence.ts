/**
 * Durable Runtime Worker ownership fence — a GENERATION-BOUND STATE MACHINE
 * (plan §43 / G10, review rounds 29-31). A crashed Bridge Host's worker
 * adapter subtree is fenced by an atomic on-disk record; the record's phase
 * carries the ownership transaction across Host restarts:
 *
 *   spawn    → phase "owned"       (durable BEFORE the worker is returned)
 *   admitted → phase "admitted"    (verified Windows identity ON DISK — the
 *                                   durable admission barrier: no business
 *                                   RPC enters the worker before this lands)
 *   EOF      → phase "discharging" (worker closes admission + drains before
 *                                   converging; a new Host seeing this phase
 *                                   must WAIT for the worker's own verdict)
 *   terminal → phase "discharged"  (worker PROVED convergence before exit —
 *                                   verified cleanup; safe to retire+respawn)
 *            → phase "spooled"     (unverified identities are durable
 *                                   residuals — respawn stays blocked until
 *                                   the daemon reaper converges them)
 *
 * Deciding rules (new Host, stale fence):
 *   discharged              → retire the record, allow respawn.
 *   spooled                 → refuse (residual tree ownership pending).
 *   discharging             → wait for the worker's own terminal phase; only
 *                             a worker that will not settle falls through to
 *                             the gated kill, and a DEAD worker without a
 *                             terminal phase is refused (crash leftovers
 *                             need the reaper — never a blind respawn).
 *   owned/admitted          → POSIX discharges via the process group (atomic
 *                             across the whole tree, immune to the spawn
 *                             race). Windows waits for self-discharge and
 *                             only kills a STILL-ALIVE root through the
 *                             in-transaction parent-identity gate, bracketed
 *                             by the descendants protocol's own snapshots.
 *
 * The phase writes are performed ONLY by the fence's owning generation (the
 * worker receives its fence path + generation through spawn env) — a stale
 * generation can never overwrite a newer owner's record.
 */
import { mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";

import {
  terminateWindowsDescendantsOf,
  type TerminateDescendantsResult,
} from "../../../process/windows-process-tree";

export type FencePhase = "owned" | "admitted" | "discharging" | "discharged" | "spooled";

export const FENCE_PHASES: readonly FencePhase[] = ["owned", "admitted", "discharging", "discharged", "spooled"];

export interface RuntimeWorkerFenceRecord {
  kind: "runtime-worker-owner";
  logicalSessionId: string;
  /** The owning worker client generation — phase writers must match it. */
  generation: string;
  pid: number;
  creationDate: string | null;
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
  /** Verified in-transaction subtree terminator; MUST gate on the parent fingerprint. */
  terminateDescendants?: (parentPid: number, expectedCreationDate: string) => Promise<TerminateDescendantsResult>;
  killGroup?: (pgid: number) => void;
  /** Tri-state POSIX group probe (round 31 Blocking 4): only ESRCH proves gone. */
  probeProcessGroup?: (pgid: number) => "alive" | "gone" | "unknown";
  waitMs?: (ms: number) => Promise<void>;
  now?: () => number;
  /** How long a new Host waits for the old worker's own EOF verdict (ms). */
  selfDischargeWaitMs?: number;
  /** Re-read the fence during the discharging wait (manager: same fence+key). */
  readBack?: () => Promise<FenceReadResult>;
  /** Persist the terminal "discharged" phase after an H2-side gated kill. */
  markDischarged?: (record: RuntimeWorkerFenceRecord) => Promise<void>;
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
 * "discharged" only when a terminal proof exists (worker's own phase, or a
 * verified in-transaction kill); "refused" means the caller MUST NOT spawn a
 * second owner.
 */
export async function dischargeRuntimeWorkerFence(
  record: RuntimeWorkerFenceRecord,
  deps: FenceDischargeDeps = {},
): Promise<FenceDischargeOutcome> {
  const platform = deps.platform ?? process.platform;
  if (platform !== "win32") {
    const probe = deps.probeProcessGroup ?? probeProcessGroupDefault;
    const state = probe(record.pid);
    if (state === "unknown") return "refused";
    if (state === "alive") {
      try {
        (deps.killGroup ?? ((pgid: number) => {
          process.kill(-pgid, "SIGKILL");
        }))(record.pid);
      } catch (error) {
        // ESRCH: group died between the probe and the kill — discharged.
        if ((error as { code?: unknown } | null)?.code === "ESRCH") return "discharged";
        return "refused";
      }
    }
    const now = deps.now ?? Date.now;
    const waitMs = deps.waitMs ?? defaultWaitMs;
    const deadline = now() + 5_000;
    while (now() < deadline) {
      if (probe(record.pid) === "gone") return "discharged";
      await waitMs(100);
    }
    return probe(record.pid) === "gone" ? "discharged" : "refused";
  }

  // Windows: the phase decision table. The self-discharge window is the
  // cross-Host quiescence handoff — the old worker's EOF gate drains its
  // in-flight ensure BEFORE converging, so its terminal phase is the proof
  // that the descendant set is final. H2 never snapshots a live, still-
  // admitting worker unless the wait expired (fallback gated kill).
  const waitMs = deps.waitMs ?? defaultWaitMs;
  const now = deps.now ?? Date.now;
  const waitSelfMs = deps.selfDischargeWaitMs ?? 90_000;
  let current = record;
  const phaseDeadline = now() + waitSelfMs;
  while (current.phase === "discharging" && now() < phaseDeadline) {
    await waitMs(500);
    const reread = await deps.readBack?.();
    if (!reread || reread.kind !== "present") break;
    current = reread.record;
  }
  if (current.phase === "discharged") return "discharged";
  if (current.phase === "spooled") return "refused";
  if (current.phase === "discharging") return "refused";

  if (!current.bootstrapVerified || !current.creationDate) {
    // The admission barrier (round 30 Blocking 2, phase-serialised per
    // round 31 Blocking 1) makes this a hard invariant: a fence that never
    // reached "admitted" cannot have entered a business RPC, so no adapter
    // descendant can exist. The worker itself (if still alive after a host
    // death) self-terminates via stdin-EOF convergence.
    return "discharged";
  }
  // Round 30 Blocking 3: identity is verified INSIDE the kill transaction
  // (retained parent handle vs expected creation date). A dead, replaced, or
  // unprobeable parent yields verified=false — refused, never a bare
  // historical-pid kill. A dead parent ALSO means the worker exited without
  // writing a terminal phase: crash leftovers stay fenced for the reaper.
  const result = await (deps.terminateDescendants ?? ((parentPid: number, expectedCreationDate: string) =>
    terminateWindowsDescendantsOf(parentPid, { expectedParentCreationDate: expectedCreationDate, workerDeadlineMs: null })))(
    current.pid,
    current.creationDate,
  );
  if (!result.verified) return "refused";
  // The gated kill succeeded (subtree + orphan root verified dead): persist
  // the terminal proof so later acquires retire instead of re-killing.
  await deps.markDischarged?.({ ...current, phase: "discharged" });
  return "discharged";
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
    if (!Number.isSafeInteger(parsed.pid) || (parsed.pid as number) <= 0) return { kind: "unreadable", reason: "invalid pid" };
    if (parsed.creationDate !== null && typeof parsed.creationDate !== "string") return { kind: "unreadable", reason: "invalid creationDate" };
    if (typeof parsed.bootstrapVerified !== "boolean") return { kind: "unreadable", reason: "invalid bootstrapVerified" };
    if (typeof parsed.phase !== "string" || !FENCE_PHASES.includes(parsed.phase as FencePhase)) return { kind: "unreadable", reason: "invalid phase" };
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
