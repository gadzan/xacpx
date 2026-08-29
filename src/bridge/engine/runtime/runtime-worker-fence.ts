/**
 * Durable Runtime Worker ownership fence (plan §43 / G10, review round 29
 * Blocking 1). A crashed worker's adapter subtree is fenced by an atomic
 * on-disk record so a Bridge Host restart can never spawn a second owner for
 * the same session while the old tree is not verifiably discharged:
 *
 *   spawn  → fence written (pid; creationDate + bootstrapVerified after the
 *            Windows identity probe verifies)
 *   release→ fence removed ONLY after verified tree termination
 *   acquire→ an undischarged fence MUST be discharged (orphan tree killed by
 *            verified primitives) or the spawn REFUSES (fail closed)
 *
 * Discharge is identity-safe:
 *   POSIX    the worker is a detached group leader; adapters inherit the
 *            group, so a group SIGKILL + liveness verification discharges.
 *   Windows  the parentPid edge is only unambiguous when the worker pid is
 *            NOT reused: probe first. Same creationDate (worker still alive —
 *            orphaned by host death) or missing (gone, not reused) →
 *            terminate-descendants-of converges the whole tree; reused or
 *            unavailable identity → refuse (never a wrong-process kill).
 */
import { mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";

import {
  terminateWindowsDescendantsOf,
  type TerminateDescendantsResult,
} from "../../../process/windows-process-tree";

export interface RuntimeWorkerFenceRecord {
  kind: "runtime-worker-owner";
  logicalSessionId: string;
  pid: number;
  creationDate: string | null;
  /** True once a business RPC could have entered (adapter tree possible). */
  bootstrapVerified: boolean;
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
  isProcessGroupAlive?: (pgid: number) => boolean;
  waitMs?: (ms: number) => Promise<void>;
  now?: () => number;
}

function defaultIsProcessGroupAlive(pgid: number): boolean {
  try {
    process.kill(-pgid, 0);
    return true;
  } catch {
    return false;
  }
}

async function defaultWaitMs(ms: number): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, ms);
  await promise;
}

/**
 * Discharge one fenced worker tree. Resolves "discharged" only when verified
 * primitives prove the tree is gone (or could never have existed);
 * "refused" means the caller MUST NOT spawn a second owner.
 */
export async function dischargeRuntimeWorkerFence(
  record: RuntimeWorkerFenceRecord,
  deps: FenceDischargeDeps = {},
): Promise<FenceDischargeOutcome> {
  const platform = deps.platform ?? process.platform;
  if (platform !== "win32") {
    const alive = deps.isProcessGroupAlive ?? defaultIsProcessGroupAlive;
    if (!alive(record.pid)) return "discharged";
    try {
      (deps.killGroup ?? ((pgid: number) => {
        process.kill(-pgid, "SIGKILL");
      }))(record.pid);
    } catch (error) {
      // ESRCH: group died between the probe and the kill — discharged.
      if ((error as { code?: unknown } | null)?.code === "ESRCH") return "discharged";
      return "refused";
    }
    const now = deps.now ?? Date.now;
    const waitMs = deps.waitMs ?? defaultWaitMs;
    const deadline = now() + 5_000;
    while (now() < deadline) {
      if (!alive(record.pid)) return "discharged";
      await waitMs(100);
    }
    return !alive(record.pid) ? "discharged" : "refused";
  }
  if (!record.bootstrapVerified || !record.creationDate) {
    // The admission barrier (round 30 Blocking 2) makes this a hard
    // invariant: a fence that never saw a verified bootstrap cannot have
    // entered a business RPC, so no adapter descendant can exist. The worker
    // itself (if still alive after a host death) self-terminates via
    // stdin-EOF convergence.
    return "discharged";
  }
  // Round 30 Blocking 3: identity is verified INSIDE the kill transaction
  // (retained parent handle vs expected creation date). A dead, replaced, or
  // unprobeable parent yields verified=false — refused, never a bare
  // historical-pid kill. A momentary probe result is not an identity
  // capability, so no separate probe pre-check exists.
  const result = await (deps.terminateDescendants ?? ((parentPid: number, expectedCreationDate: string) =>
    terminateWindowsDescendantsOf(parentPid, { expectedParentCreationDate: expectedCreationDate, workerDeadlineMs: null })))(
    record.pid,
    record.creationDate,
  );
  return result.verified ? "discharged" : "refused";
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
    const tmp = `${path}.tmp-${randomUUID()}`;
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
   * Round 30 Blocking 1: fence evidence is NEVER interpreted as absent when
   * it cannot be PROVEN absent. Only ENOENT reads as "absent"; corrupt JSON,
   * an invalid schema, or any I/O failure reads as "unreadable" — the caller
   * MUST refuse to spawn a second owner over evidence it cannot read.
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
    if (!Number.isSafeInteger(parsed.pid) || (parsed.pid as number) <= 0) return { kind: "unreadable", reason: "invalid pid" };
    if (parsed.creationDate !== null && typeof parsed.creationDate !== "string") return { kind: "unreadable", reason: "invalid creationDate" };
    if (typeof parsed.bootstrapVerified !== "boolean") return { kind: "unreadable", reason: "invalid bootstrapVerified" };
    if (typeof parsed.startedAt !== "string" || typeof parsed.agent !== "string") return { kind: "unreadable", reason: "invalid metadata" };
    return { kind: "present", record: parsed as unknown as RuntimeWorkerFenceRecord };
  }

  async remove(logicalSessionId: string): Promise<void> {
    try {
      await unlink(this.pathFor(logicalSessionId));
    } catch {
      // Removal failure is benign: discharge is idempotent and re-runs.
    }
  }
}
