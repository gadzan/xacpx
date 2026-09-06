import { randomUUID } from "node:crypto";
import { statSync } from "node:fs";
import { join } from "node:path";

import { RuntimeWorkerClient, type WorkerLifecycle, type RuntimeWorkerRef, type RuntimeWorkerClientDeps, WorkerTeardownPendingError } from "./runtime-worker-client";
import { RuntimeWorkerFence, dischargeRuntimeWorkerFence, probeProcessGroupDefault, StaleFenceGenerationError, FenceUnreadableError, type FenceLiveness, type RuntimeWorkerFenceRecord } from "./runtime-worker-fence";
import { defaultRuntimeDir } from "./worker-eof";
import { OrphanRegistry } from "../../../transport/orphan-registry";
import { probeWindowsProcessIdentity } from "../../../process/windows-process-tree";

/**
 * Host-side registry of per-session Runtime Workers (plan PR3). One session →
 * one worker; same session reuses its worker; different sessions never share.
 * The manager owns spawn/shutdownAll and crash-loop guarding.
 */
export interface RuntimeWorkerManagerOptions {
  /** Resolved path of dist/runtime-worker-main.js. */
  entryPath: string;
  maxRestartsPerWindow?: number;
  restartWindowMs?: number;
  clientDeps?: RuntimeWorkerClientDeps;
  /**
   * Directory for durable worker-ownership fences (plan §43 / G10). When
   * provided, every spawn writes a crash-safe fence record and every acquire
   * first discharges (or refuses over) an undischarged fence, so a Bridge
   * Host restart can never spawn a second owner while the previous worker's
   * adapter tree is unverified. A supplier form is evaluated lazily on first
   * use (the engine derives it from stateDir, which is validated at operation
   * time, not construction). Omitting it keeps the in-memory-only behavior.
   */
  fenceDir?: string | (() => string);
}
export class RuntimeWorkerManager {
  private readonly workersByKey = new Map<string, RuntimeWorkerClient>();
  private readonly physicalFenceKeys = new Map<string, string>();
  private readonly restarts = new Map<string, number[]>();
  private fenceInstance?: RuntimeWorkerFence;
  /** Per-session fence write chains — initial/upgrade/retire never interleave. */
  private readonly fenceWriteChains = new Map<string, Promise<void>>();
  constructor(private readonly options: RuntimeWorkerManagerOptions) {
    if (!options.entryPath || !fileExists(options.entryPath)) {
      throw new Error(`runtime worker entry not found: ${options.entryPath} (build the project first)`);
    }
  }

  /** Lazily-built fence store; undefined when fencing is disabled. */
  private fence(): RuntimeWorkerFence | undefined {
    if (!this.options.fenceDir) return undefined;
    this.fenceInstance ??= new RuntimeWorkerFence(
      typeof this.options.fenceDir === "function" ? this.options.fenceDir() : this.options.fenceDir,
    );
    return this.fenceInstance;
  }

  private fenceDirValue(): string | undefined {
    if (!this.options.fenceDir) return undefined;
    return typeof this.options.fenceDir === "function" ? this.options.fenceDir() : this.options.fenceDir;
  }
  /**
   * Tri-state liveness of a claiming host pid. POSIX: signal 0 on the exact
   * pid (ESRCH proves gone; EPERM proves the pid exists, so alive).
   * Windows: handle-stable identity probe; missing proves gone,
   * unavailable refuses.
   */
  private probeClaimantHost = async (pid: number): Promise<FenceLiveness> => {
    const deps = this.options.clientDeps;
    if ((deps?.platform ?? process.platform) === "win32" || deps?.probeWindowsIdentity) {
      try {
        const res = await (deps?.probeWindowsIdentity ?? probeWindowsProcessIdentity)(pid);
        if (res.status === "found") return "alive";
        if (res.status === "missing") return "gone";
        return "unknown";
      } catch {
        return "unknown";
      }
    }
    try {
      process.kill(pid, 0);
      return "alive";
    } catch (error) {
      const code = (error as { code?: unknown } | null)?.code;
      if (code === "ESRCH") return "gone";
      if (code === "EPERM") return "alive";
      return "unknown";
    }
  };
  /**
   * Tri-state liveness of a pre-bootstrap worker behind an `owned` fence.
   * POSIX reuses the process-group probe (detached worker is group leader).
   * Windows requires the fence's creationDate to disambiguate pid reuse;
   * without it the answer is unknown (fail closed — the worker's own EOF
   * gate remains the authority that publishes the terminal phase).
   */
  private probeFencedWorker = async (record: RuntimeWorkerFenceRecord): Promise<FenceLiveness> => {
    const deps = this.options.clientDeps;
    if ((deps?.platform ?? process.platform) === "win32" || deps?.probeWindowsIdentity) {
      if (!record.creationDate) return "unknown";
      try {
        const res = await (deps?.probeWindowsIdentity ?? probeWindowsProcessIdentity)(record.pid!);
        if (res.status !== "found") return res.status === "missing" ? "gone" : "unknown";
        return res.identity.creationDate === record.creationDate ? "alive" : "gone";
      } catch {
        return "unknown";
      }
    }
    return (deps?.probeProcessGroup ?? probeProcessGroupDefault)(record.pid!);
  };

  get(key: string): RuntimeWorkerClient | undefined {
    return this.workersByKey.get(key);
  }
  /** Returns the physical fence key registered for this logical worker, if an acquire mapping exists. */
  physicalFenceKeyFor(logicalWorkerKey: string): string | undefined {
    return this.physicalFenceKeys.get(logicalWorkerKey);
  }
  /**
   * Finds a live local worker holding the same physical fence under a
   * DIFFERENT logical key (sibling alias sharing one physical acpx
   * session). The durable fence cannot distinguish "my own sibling's live
   * admitted fence" from cross-host stale ownership, so acquire() would
   * otherwise burn the cross-host self-discharge wait (up to 90s) and
   * refuse — for what is provably our own worker. Returns undefined when
   * the physical key is locally unowned, owned by the requesting key
   * itself, or only mapped without a live worker (heals on next acquire).
   */
  findSiblingPhysicalOwner(
    physicalFenceKey: string,
    exceptLogicalKey: string,
  ): { logicalKey: string; client: RuntimeWorkerClient } | undefined {
    for (const [logicalKey, registered] of this.physicalFenceKeys) {
      if (logicalKey === exceptLogicalKey || registered !== physicalFenceKey) continue;
      const client = this.workersByKey.get(logicalKey);
      if (client && client.alive && client.lifecycle !== "failed" && client.lifecycle !== "stopped") {
        return { logicalKey, client };
      }
    }
    return undefined;
  }

  /**
   * Asserts that ONE logical alias holds no ownership: no live worker and
   * no registered fence mapping remain for it. Unlike
   * assertOwnershipQuiescent (which requires the whole PHYSICAL namespace
   * to be empty), this deliberately tolerates a surviving sibling alias
   * legitimately owning the same physical fence.
   */
  assertLogicalOwnershipReleased(logicalWorkerKey: string): void {
    const worker = this.workersByKey.get(logicalWorkerKey);
    if (worker && worker.alive && worker.lifecycle !== "stopped" && worker.lifecycle !== "failed") {
      throw new WorkerTeardownPendingError(
        `runtime worker for session "${logicalWorkerKey}" is still live; refusing logical release`,
      );
    }
    if (this.physicalFenceKeys.has(logicalWorkerKey)) {
      throw new WorkerTeardownPendingError(
        `fence mapping for session "${logicalWorkerKey}" is still registered; refusing logical release`,
      );
    }
  }
  /**
   * Asserts that ownership for logical session `logicalWorkerKey` (physical fence `physicalFenceKey`)
   * is quiescent: worker process is absent or stopped, and durable fence is absent or discharged.
   * Discharged fences are retired best-effort.
   * Throws WorkerTeardownPendingError if worker active, fence present non-discharged, or fence unreadable.
   */
  async assertOwnershipQuiescent(
    logicalWorkerKey: string,
    physicalFenceKey: string,
    options: { allowDeleting?: boolean } = {},
  ): Promise<void> {
    const worker = this.workersByKey.get(logicalWorkerKey);
    if (worker && (worker.alive || worker.lifecycle !== "stopped")) {
      throw new WorkerTeardownPendingError(
        `runtime worker for session "${logicalWorkerKey}" is still active (lifecycle: ${worker.lifecycle})`,
      );
    }
    const fence = this.fence();
    if (!fence) return;
    const read = await fence.read(physicalFenceKey);
    if (read.kind === "absent") {
      return;
    }
    if (read.kind === "unreadable") {
      throw new WorkerTeardownPendingError(
        `durable ownership fence for session "${logicalWorkerKey}" (physical key "${physicalFenceKey}") is unreadable: ${read.reason}`,
      );
    }
    if (read.kind === "present") {
      // A "deleting" fence is the hard-delete admission barrier, not a live
      // owner. The delete path passes allowDeleting (it will adopt the
      // in-place barrier at claim time); every other quiescence observer
      // (logical release) keeps refusing while a hard delete is in flight.
      if (read.record.phase === "deleting") {
        if (options.allowDeleting) return;
        throw new WorkerTeardownPendingError(
          `durable ownership fence for session "${logicalWorkerKey}" (physical key "${physicalFenceKey}") is under hard deletion; refusing concurrent lifecycle change`,
        );
      }
      if (read.record.phase === "discharged") {
        try {
          await this.enqueueFenceWrite(physicalFenceKey, () => fence.retire(physicalFenceKey, read.record.generation));
        } catch {
          // Best-effort retirement of discharged fence
        }
        return;
      }
      throw new WorkerTeardownPendingError(
        `durable ownership fence for session "${logicalWorkerKey}" (physical key "${physicalFenceKey}") is present and not discharged (phase: ${read.record.phase}, pid: ${read.record.pid})`,
      );
    }
  }

  /**
   * Claim the durable physical-deletion barrier, or adopt the in-place one.
   * The fence key scopes the delete target (one physical session ⇒ one
   * record name), so a pre-existing "deleting" fence is always the SAME
   * interrupted delete: adopt it (same barrier, no gap) instead of
   * failing. Any other present phase means a live owner or a successor
   * claim won the race — throw without touching anything (never unlink).
   * Returns null when fencing is disabled (no durable namespace exists,
   * matching claimOwnedFence's no-op contract).
   */
  async claimPhysicalDeletion(physicalFenceKey: string): Promise<{ generation: string; adopted: boolean } | null> {
    const fence = this.fence();
    if (!fence) return null;
    const generation = randomUUID();
    const record: RuntimeWorkerFenceRecord = {
      kind: "runtime-worker-owner",
      logicalSessionId: physicalFenceKey,
      generation,
      pid: process.pid,
      bootstrapVerified: false,
      phase: "deleting",
      startedAt: new Date().toISOString(),
      agent: "runtime-worker",
    };
    try {
      await this.enqueueFenceWrite(physicalFenceKey, () => fence.claim(record));
      return { generation, adopted: false };
    } catch {
      // EEXIST or I/O: re-read to decide adopt vs abort (never overwrite).
    }
    const read = await fence.read(physicalFenceKey);
    if (read.kind === "present" && read.record.phase === "deleting") {
      return { generation: read.record.generation, adopted: true };
    }
    throw new WorkerTeardownPendingError(
      `cannot claim physical-deletion barrier for session "${physicalFenceKey}": ` +
        (read.kind === "present"
          ? `fence is live (phase ${read.record.phase}); a successor owner won the race — refusing to unlink`
          : `fence is ${read.kind}; refusing to unlink over unverifiable evidence`),
    );
  }

  /**
   * Revalidate the deletion barrier immediately before unlinking: the fence
   * must still carry our (claimed or adopted) generation in phase
   * "deleting". A slow adopter whose barrier was retired and replaced by a
   * successor's owner fence aborts here instead of unlinking live records.
   */
  async revalidatePhysicalDeletion(physicalFenceKey: string, generation: string): Promise<void> {
    const fence = this.fence();
    if (!fence) return;
    const read = await fence.read(physicalFenceKey);
    if (read.kind !== "present" || read.record.phase !== "deleting" || read.record.generation !== generation) {
      throw new WorkerTeardownPendingError(
        `physical-deletion barrier for session "${physicalFenceKey}" changed before unlink (now ${read.kind === "present" ? `phase ${read.record.phase}` : read.kind}); refusing to unlink`,
      );
    }
  }

  /**
   * Retire the deletion barrier after record + streams + tombstone removal
   * verified. Strict generation+phase retire: a successor-owned fence is
   * never unlinked (throws, file intact).
   */
  async retirePhysicalDeletion(physicalFenceKey: string, generation: string): Promise<void> {
    const fence = this.fence();
    if (!fence) return;
    await this.enqueueFenceWrite(physicalFenceKey, () => fence.retireDeletion(physicalFenceKey, generation));
  }

  /**
   * Read the deletion barrier generation when one stands, else null. Used
   * by the no-record delete tail (crashed deleter completed the unlink but
   * never retired): unreadable evidence fails closed — lifting a barrier
   * we cannot attribute could strand a live deleter's successors-refused
   * window open over half-deleted records.
   */
  async readDeletionBarrier(physicalFenceKey: string): Promise<string | null> {
    const fence = this.fence();
    if (!fence) return null;
    const read = await fence.read(physicalFenceKey);
    if (read.kind === "absent") return null;
    if (read.kind === "unreadable") {
      throw new WorkerTeardownPendingError(
        `durable ownership fence for session "${physicalFenceKey}" is unreadable (${read.reason}); refusing to lift a possible deletion barrier`,
      );
    }
    return read.record.phase === "deleting" ? read.record.generation : null;
  }

  lifecycleFor(key: string): WorkerLifecycle {
    return this.workersByKey.get(key)?.lifecycle ?? "stopped";
  }

  /** Warm = process alive AND bootstrap complete AND not shutting down (plan §15). */
  isWarm(key: string): boolean {
    const worker = this.workersByKey.get(key);
    return (
      worker !== undefined &&
      worker.alive &&
      worker.isBootstrapVerified &&
      (worker.lifecycle === "ready" || worker.lifecycle === "busy" || worker.lifecycle === "idle")
    );
  }

  ensureWorker(logicalSessionId: string): RuntimeWorkerClient {
    return this.ensureWorkerWithStatus(logicalSessionId).worker;
  }

  private ensureWorkerWithStatus(logicalSessionId: string): { worker: RuntimeWorkerClient; created: boolean } {
    const existing = this.workersByKey.get(logicalSessionId);
    if (existing) {
      if (existing.alive) {
        if (
          existing.lifecycle === "cooling" ||
          existing.lifecycle === "stopped" ||
          existing.lifecycle === "failed"
        ) {
          throw new WorkerTeardownPendingError(
            `runtime worker for session "${logicalSessionId}" is still shutting down (lifecycle: ${existing.lifecycle}); refusing duplicate worker spawn`,
          );
        }
        return { worker: existing, created: false };
      }
      // Not alive: if still in teardown or failed termination, refuse spawn
      if (existing.lifecycle === "cooling" || existing.lifecycle === "failed") {
        throw new WorkerTeardownPendingError(
          `runtime worker for session "${logicalSessionId}" is in teardown or failed termination (lifecycle: ${existing.lifecycle}); refusing duplicate worker spawn`,
        );
      }
      // If it fully finished stopping (!alive && lifecycle === "stopped"), clean it up and allow fresh spawn
      if (existing.lifecycle === "stopped" && !existing.alive) {
        this.workersByKey.delete(logicalSessionId);
      }
    }

    this.assertRestartBudget(logicalSessionId);
    const workerGeneration = randomUUID();
    const worker = new RuntimeWorkerClient(
      this.options.entryPath,
      logicalSessionId,
      workerGeneration,
      (client, code) => this.handleExit(logicalSessionId, client, code),
      {
        ...this.options.clientDeps,
        spawnEnv: this.fenceDirValue() === undefined
          ? this.options.clientDeps?.spawnEnv
          : {
              ...this.options.clientDeps?.spawnEnv,
              XACPX_WORKER_FENCE: join(this.fenceDirValue()!, `${encodeURIComponent(logicalSessionId)}.json`),
              XACPX_WORKER_FENCE_GENERATION: workerGeneration,
            },
        onIdentityVerified: async (client) => {
          await this.options.clientDeps?.onIdentityVerified?.(client);
          if (!this.fence()) return;
          await this.enqueueFenceWrite(logicalSessionId, async () => {
            await this.fence()!.compareAndSwap(
              logicalSessionId,
              { generation: workerGeneration, from: ["owned"] },
              {
                kind: "runtime-worker-owner",
                logicalSessionId,
                generation: workerGeneration,
                pid: client.ref.pid,
                creationDate: client.ref.creationDate ?? null,
                bootstrapVerified: true,
                phase: "admitted",
                startedAt: client.ref.startedAt,
                agent: "runtime-worker",
              },
            );
            const read = await this.fence()!.read(logicalSessionId);
            if (read.kind !== "present" || read.record.phase !== "admitted" || read.record.creationDate !== client.ref.creationDate) {
              throw new Error(`admitted fence read-back failed (${read.kind === "present" ? `phase=${read.record.phase}` : read.kind})`);
            }
          });
        },
      },
    );
    worker.spawn();
    this.workersByKey.set(logicalSessionId, worker);
    return { worker, created: true };
  }

  /**
   * Fence-aware spawn entry (plan §43 / G10 / review G2): discharge any
   * undischarged durable fence for this session BEFORE a new owner can exist,
   * then claim the owned fence with O_EXCL BEFORE spawn. Acquire is the ONLY
   * spawn path.
   */
  async acquire(logicalWorkerKey: string, physicalFenceKey = logicalWorkerKey): Promise<RuntimeWorkerClient> {
    // Warm reuse must not be blocked by discharging its own fence.
    // Check existing alive worker first (logical key) before touching the
    // physical fence. This keeps the stable-hash G2 path (logical != physical)
    // from trying to discharge its own admitted fence on every reuse.
    if (this.fence()) {
      const existing = this.workersByKey.get(logicalWorkerKey);
      if (
        existing &&
        existing.alive &&
        existing.lifecycle !== "failed" &&
        existing.lifecycle !== "cooling" &&
        existing.lifecycle !== "stopped"
      ) {
        return existing;
      }
      // Our own worker is mid-teardown (cooling) but still alive: its fence is
      // ours, so discharging it would burn the self-discharge window only to
      // refuse. Fail fast like the unfenced path instead (same error contract
      // as ensureWorkerWithStatus).
      if (existing?.alive && existing.lifecycle === "cooling") {
        throw new WorkerTeardownPendingError(
          `runtime worker for session "${logicalWorkerKey}" is still shutting down (lifecycle: cooling); refusing duplicate worker spawn`,
        );
      }
    }
    await this.dischargeStaleFence(physicalFenceKey);
    if (this.fence()) {
      const existing = this.workersByKey.get(logicalWorkerKey);
      if (
        existing &&
        existing.alive &&
        existing.lifecycle !== "failed" &&
        existing.lifecycle !== "cooling" &&
        existing.lifecycle !== "stopped"
      ) {
        return existing;
      }
      this.assertRestartBudget(logicalWorkerKey);
      const workerGeneration = randomUUID();
      const worker = new RuntimeWorkerClient(
        this.options.entryPath,
        logicalWorkerKey,
        workerGeneration,
        (client, code) => this.handleExit(logicalWorkerKey, client, code),
        {
          ...this.options.clientDeps,
          spawnEnv: {
            ...this.options.clientDeps?.spawnEnv,
            XACPX_WORKER_FENCE: join(this.fenceDirValue()!, `${encodeURIComponent(physicalFenceKey)}.json`),
            XACPX_WORKER_FENCE_GENERATION: workerGeneration,
            XACPX_WORKER_GENERATION: workerGeneration,
          },
          onIdentityVerified: async (client) => {
            await this.options.clientDeps?.onIdentityVerified?.(client);
            await this.enqueueFenceWrite(physicalFenceKey, async () => {
              await this.fence()!.compareAndSwap(
                physicalFenceKey,
                { generation: workerGeneration, from: ["owned"] },
                {
                  kind: "runtime-worker-owner",
                  logicalSessionId: physicalFenceKey,
                  generation: workerGeneration,
                  pid: client.ref.pid,
                  creationDate: client.ref.creationDate ?? null,
                  bootstrapVerified: true,
                  phase: "admitted",
                  startedAt: client.ref.startedAt,
                  agent: "runtime-worker",
                },
              );
              const read = await this.fence()!.read(physicalFenceKey);
              if (read.kind !== "present" || read.record.phase !== "admitted" || read.record.creationDate !== client.ref.creationDate) {
                throw new Error(`admitted fence read-back failed (${read.kind === "present" ? `phase=${read.record.phase}` : read.kind})`);
              }
            });
          },
        },
      );
      // G2 pre-spawn atomic physical claim: write "claiming" fence with O_EXCL BEFORE spawn.
      // If another Host races and creates fence first, claimOwnedFence throws and spawn() is NEVER called.
      await this.claimOwnedFence(physicalFenceKey, workerGeneration);
      try {
        worker.spawn();
        await this.enqueueFenceWrite(physicalFenceKey, () =>
          this.fence()!.compareAndSwap(
            physicalFenceKey,
            { generation: workerGeneration, from: ["claiming"] },
            {
              kind: "runtime-worker-owner",
              logicalSessionId: physicalFenceKey,
              generation: workerGeneration,
              pid: worker.ref.pid,
              creationDate: worker.ref.creationDate ?? null,
              bootstrapVerified: worker.isBootstrapVerified,
              phase: "owned",
              startedAt: worker.ref.startedAt,
              agent: "runtime-worker",
            },
          ),
        );
      } catch (spawnError) {
        if (spawnError instanceof StaleFenceGenerationError) {
          // A successor generation owns the fence now: our claim was recycled
          // while we were stalled. Our just-spawned worker is an orphan that
          // must die verified — and the fence must NEVER be touched (no
          // retire: it belongs to the successor).
          if (worker.alive) {
            try {
              await worker.terminate();
            } catch {
              this.workersByKey.set(logicalWorkerKey, worker);
              this.physicalFenceKeys.set(logicalWorkerKey, physicalFenceKey);
            }
            if (worker.alive || worker.lifecycle !== "stopped") {
              this.workersByKey.set(logicalWorkerKey, worker);
              this.physicalFenceKeys.set(logicalWorkerKey, physicalFenceKey);
            }
          }
          throw new WorkerTeardownPendingError(
            `runtime worker for session "${logicalWorkerKey}" lost its fence to a successor generation; orphan worker ${worker.alive ? "retained for teardown" : "terminated"}, refusing replacement spawn`,
          );
        }
        if (worker.alive) {
          // spawn() succeeded but the owned-fence upgrade failed afterwards.
          // The worker is alive yet untracked: terminate it with verification
          // BEFORE retiring the claim. Retiring first would leave a live,
          // untracked worker next to a released fence (silent second owner
          // on the next acquire).
          try {
            await worker.terminate();
          } catch (termError) {
            // Termination unverified: retain tracking AND the fence so no
            // replacement can spawn over an unproven tree; surface pending.
            this.workersByKey.set(logicalWorkerKey, worker);
            this.physicalFenceKeys.set(logicalWorkerKey, physicalFenceKey);
            throw new WorkerTeardownPendingError(
              `runtime worker for session "${logicalWorkerKey}" spawned but fence upgrade failed and termination is unverified; refusing replacement spawn`,
            );
          }
          if (worker.alive || worker.lifecycle !== "stopped") {
            this.workersByKey.set(logicalWorkerKey, worker);
            this.physicalFenceKeys.set(logicalWorkerKey, physicalFenceKey);
            throw new WorkerTeardownPendingError(
              `runtime worker for session "${logicalWorkerKey}" spawned but fence upgrade failed and worker did not reach stopped; refusing replacement spawn`,
            );
          }
        }
        this.workersByKey.delete(logicalWorkerKey);
        this.physicalFenceKeys.delete(logicalWorkerKey);
        if (this.fence()) {
          await this.enqueueFenceWrite(physicalFenceKey, () => this.fence()!.retire(physicalFenceKey, workerGeneration)).catch(() => {});
        }
        throw spawnError;
      }
      this.workersByKey.set(logicalWorkerKey, worker);
      this.physicalFenceKeys.set(logicalWorkerKey, physicalFenceKey);
      return worker;
    }
    const { worker } = this.ensureWorkerWithStatus(logicalWorkerKey);
    return worker;
  }

  /**
   * Verified release: the worker reached lifecycle "stopped" (tree cleanup
   * verified), so its durable fence is retired. Round 31 High: retirement is
   * never a silent best-effort — a transient unlink failure persists the
   * terminal "discharged" phase first, so the next acquire retires instead
   * of bricking against a dead root.
   */
  async release(logicalWorkerKey: string, client?: RuntimeWorkerClient): Promise<void> {
    const fenced = client !== undefined && this.workersByKey.get(logicalWorkerKey) === client;
    const physicalFenceKey = this.physicalFenceKeys.get(logicalWorkerKey) ?? logicalWorkerKey;
    if (client && client.lifecycle === "stopped") {
      const fence = this.fence();
      // Guarded by our own generation: never unlink a successor's fence if
      // ownership moved on while we were stopping. The durable retire MUST
      // settle before the in-memory mappings are dropped: an unreadable
      // fence is NOT a proven handoff, so it keeps the mappings (and throws)
      // for a genuine retry instead of reporting success with evidence
      // still on disk that will brick the next acquire.
      if (fence) {
        try {
          await this.enqueueFenceWrite(physicalFenceKey, () => fence.retire(physicalFenceKey, client.ref.generation));
        } catch (error) {
          if (error instanceof StaleFenceGenerationError) {
            // Successor generation owns the fence: our ownership already
            // ended; fall through to mapping cleanup.
          } else if (error instanceof FenceUnreadableError) {
            throw new WorkerTeardownPendingError(
              `durable ownership fence for session "${physicalFenceKey}" is unreadable; ` +
                `refusing to drop ownership evidence — repair or remove the fence file, then retry`,
            );
          } else {
            throw error;
          }
        }
      }
    }
    if (!client || fenced) {
      this.workersByKey.delete(logicalWorkerKey);
      this.physicalFenceKeys.delete(logicalWorkerKey);
    }
  }

  /**
   * Serialized fence writes (round 31 Blocking 1): the initial "owned" write
   * and the post-probe "admitted" upgrade are chained per session, so a slow
   * initial write can never rename AFTER the upgrade and downgrade the disk
   * record back to pre-admission.
   */
  private enqueueFenceWrite(logicalSessionId: string, write: () => Promise<void>): Promise<void> {
    const previous = this.fenceWriteChains.get(logicalSessionId) ?? Promise.resolve();
    const next = previous.then(write, write);
    this.fenceWriteChains.set(logicalSessionId, next);
    return next;
  }

  private async dischargeStaleFence(logicalSessionId: string): Promise<void> {
    const fence = this.fence();
    if (!fence) return;
    // Round 30 Blocking 1: only a PROVEN absence skips the fence check.
    // Corrupt JSON, a schema mismatch, or any read failure refuses the spawn
    // — unreadable ownership evidence never means "no owner".
    const read = await fence.read(logicalSessionId);
    if (read.kind === "absent") return;
    if (read.kind === "unreadable") {
      throw new WorkerTeardownPendingError(
        `durable ownership fence for session "${logicalSessionId}" is UNREADABLE (${read.reason}); ` +
          `refusing to spawn a second owner over evidence that cannot be read`,
      );
    }
    const record = read.record;
    // Physical-deletion barrier: a "deleting" fence is a live hard-delete's
    // admission lock — never discharge, retire, or probe it. A gone deleter
    // must STILL refuse here: the delete retry (same physical target) adopts
    // the in-place barrier and completes it; a successor owner must never be
    // admitted over a half-deleted record. Fail fast without touching the file.
    if (record.phase === "deleting") {
      throw new WorkerTeardownPendingError(
        `durable ownership fence for session "${logicalSessionId}" is under hard deletion; refusing admission until the delete completes`,
      );
    }
    const existing = this.workersByKey.get(logicalSessionId);
    const deps = this.options.clientDeps;
    const outcome = await dischargeRuntimeWorkerFence(record, {
      platform: deps?.platform,
      probeProcessGroup: deps?.probeProcessGroup,
      probeClaimant: this.probeClaimantHost,
      probeWorker: this.probeFencedWorker,
      selfDischargeWaitMs: deps?.selfDischargeWaitMs,
      readBack: async () => await fence.read(logicalSessionId),
      markDischarged: async (current, from) => {
        await this.enqueueFenceWrite(logicalSessionId, () =>
          fence.compareAndSwap(
            logicalSessionId,
            { generation: current.generation, from },
            { ...current, phase: "discharged" },
          ),
        );
      },
      spooledResidualsRemaining: deps?.spooledResidualsRemaining ?? (async (generationId) => {
        // Round 32 Blocking 3 default handshake: residuals whose
        // generationId matches the fence generation are THIS worker's spool
        // namespace; any survivor keeps the session fenced. An unreadable
        // registry counts as pending (fail closed).
        const registry = new OrphanRegistry(defaultRuntimeDir());
        const records = await registry.readCategory("residuals").catch(() => null);
        if (!records) return true;
        return records.some(({ record }) => record.generationId === generationId);
      }),
    });
    if (outcome === "discharged") {
      await this.enqueueFenceWrite(logicalSessionId, () => fence.retire(logicalSessionId, record.generation));
      return;
    }
    // Dead-root recovery is intentionally disabled: historical ParentProcessId
    // + creationDate cannot prove ownership of a surviving child after the
    // root died (PID reuse, I1/I2). Without a root-independent proof (Job
    // Object or descendant-carried generation token), the fence stays
    // fail-closed. H2 waits for the live worker's terminal phase instead of
    // guessing the subtree.
    throw new WorkerTeardownPendingError(
      `durable ownership fence for session "${logicalSessionId}" is undischarged ` +
        `(worker pid ${record.pid}, phase ${record.phase}, started ${record.startedAt}); refusing to spawn a second owner` +
        ` — automatic Windows dead-root recovery is disabled because historical parent PID does not prove descendant ownership`,
    );
  }

  private async claimOwnedFence(physicalFenceKey: string, workerGeneration: string): Promise<void> {
    const fence = this.fence();
    if (!fence) return;
    // The claim names the claimant host pid: a successor host only recycles
    // this claim after proving the claimant dead (never on timeout alone),
    // and every later transition is a generation CAS.
    const record: RuntimeWorkerFenceRecord = {
      kind: "runtime-worker-owner",
      logicalSessionId: physicalFenceKey,
      generation: workerGeneration,
      pid: process.pid,
      bootstrapVerified: false,
      phase: "claiming",
      startedAt: new Date().toISOString(),
      agent: "runtime-worker",
    };
    try {
      await this.enqueueFenceWrite(physicalFenceKey, () => fence.claim(record));
    } catch (error) {
      throw new WorkerTeardownPendingError(
        `cannot claim durable ownership fence for session "${physicalFenceKey}": ` +
          `${error instanceof Error ? error.message : String(error)}; refusing unfenced worker`,
      );
    }
  }
  async shutdownAll(graceMs = 2_000): Promise<void> {
    const entries = [...this.workersByKey.entries()];
    const results = await Promise.allSettled(
      entries.map(async ([key, worker]) => {
        await worker.shutdown(graceMs);
        if (!worker.alive && worker.lifecycle === "stopped") {
          await this.release(key, worker);
        }
      }),
    );
    const failures = results
      .map((r, i) => (r.status === "rejected" ? { key: entries[i]![0], error: r.reason } : null))
      .filter((f): f is { key: string; error: unknown } => f !== null);
    if (failures.length > 0) {
      const messages = failures
        .map(({ key, error }) => `session "${key}": ${error instanceof Error ? error.message : String(error)}`)
        .join("; ");
      throw new Error(`failed to shutdown ${failures.length} runtime worker(s) (ownership retained): ${messages}`);
    }
  }

  deleteWorker(logicalWorkerKey: string, client?: RuntimeWorkerClient): void {
    if (!client || this.workersByKey.get(logicalWorkerKey) === client) {
      this.workersByKey.delete(logicalWorkerKey);
      this.physicalFenceKeys.delete(logicalWorkerKey);
    }
  }

  /** Live worker clients, for policy fan-out and shutdown orchestration. */
  workers(): RuntimeWorkerClient[] {
    return [...this.workersByKey.values()];
  }
  private assertRestartBudget(logicalSessionId: string): void {
    const windowMs = this.options.restartWindowMs ?? 60_000;
    const max = this.options.maxRestartsPerWindow ?? 5;
    const now = Date.now();
    const recent = (this.restarts.get(logicalSessionId) ?? []).filter((t) => now - t < windowMs);
    if (recent.length >= max) {
      throw new Error(
        `runtime worker for session "${logicalSessionId}" crashed ${recent.length} times in ${windowMs / 1000}s; marking unhealthy`,
      );
    }
  }

  private handleExit(logicalSessionId: string, client: RuntimeWorkerClient, code: number | null): void {
    const isCrash = client.lifecycle === "failed" || !client.isDeliberateShutdown;
    if (isCrash) {
      // Unexpected crash: asynchronously clean up any orphan process group/tree descendants
      void client.terminate().then(async () => {
        if (this.workersByKey.get(logicalSessionId) === client && client.lifecycle === "stopped") {
          await this.release(logicalSessionId, client);
        }
      }).catch(() => {});
    }
    // Plan §43 scopes the guard to REAL crashes. Deliberate stops (graceful
    // shutdown, freeWarm cooling) exit 0 and are NOT charged; a nonzero/signal
    // exit while calls were in flight is.
    if (!isCrash) return;
    const windowMs = this.options.restartWindowMs ?? 60_000;
    const now = Date.now();
    const recent = (this.restarts.get(logicalSessionId) ?? []).filter((t) => now - t < windowMs);
    recent.push(now);
    this.restarts.set(logicalSessionId, recent);
    if (recent.length > (this.options.maxRestartsPerWindow ?? 5)) {
      throw new Error(
        `runtime worker for session "${logicalSessionId}" crashed ${recent.length} times in ${windowMs / 1000}s; marking unhealthy`,
      );
    }
  }
}

export { WorkerTeardownPendingError };

function fileExists(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

