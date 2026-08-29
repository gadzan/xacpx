import { statSync } from "node:fs";
import { join } from "node:path";

import { RuntimeWorkerClient, type WorkerLifecycle, type RuntimeWorkerRef, type RuntimeWorkerClientDeps, WorkerTeardownPendingError } from "./runtime-worker-client";
import { RuntimeWorkerFence, dischargeRuntimeWorkerFence, type RuntimeWorkerFenceRecord } from "./runtime-worker-fence";

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

  get(key: string): RuntimeWorkerClient | undefined {
    return this.workersByKey.get(key);
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
        return existing;
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
    // Generation-bound: the fence's phase writes are tied to THIS client
    // generation, and the worker's own EOF marker uses it via spawn env.
    const workerGeneration = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    const worker = new RuntimeWorkerClient(
      this.options.entryPath,
      logicalSessionId,
      workerGeneration,
      (client, code) => this.handleExit(logicalSessionId, client, code),
      {
        ...this.options.clientDeps,
        // Fence identity + durable state: the worker's own EOF phase writes
        // are generation-bound via spawn env.
        spawnEnv: this.fenceDirValue() === undefined
          ? undefined
          : {
              XACPX_WORKER_FENCE: join(this.fenceDirValue()!, `${encodeURIComponent(logicalSessionId)}.json`),
              XACPX_WORKER_FENCE_GENERATION: workerGeneration,
            },
        // Round 30/31 Blocking 2 — durable admission barrier: the "admitted"
        // fence (verified identity + phase) MUST be on disk AND read back
        // verified before bootstrap admissibility, so no business RPC can
        // enter a worker whose ownership record still reads pre-admission.
        onIdentityVerified: async (client) => {
          await this.options.clientDeps?.onIdentityVerified?.(client);
          // Fencing disabled (tests): nothing durable to admit — bootstrap
          // admissibility is immediate, matching the non-fenced contract.
          if (!this.fence()) return;
          await this.enqueueFenceWrite(logicalSessionId, async () => {
            await this.fence()!.write({
              kind: "runtime-worker-owner",
              logicalSessionId,
              generation: workerGeneration,
              pid: client.ref.pid,
              creationDate: client.ref.creationDate ?? null,
              bootstrapVerified: true,
              phase: "admitted",
              startedAt: client.ref.startedAt,
              agent: "runtime-worker",
            });
            // Read-back: the barrier holds until the DISK copy is proven
            // admitted — never trust the in-memory flag alone.
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
    return worker;
  }


  /**
   * Fence-aware spawn entry (plan §43 / G10): discharge any undischarged
   * durable fence for this session BEFORE a new owner can exist, then write
   * the fence for the fresh worker. Acquire is the ONLY spawn path.
   */
  async acquire(logicalSessionId: string): Promise<RuntimeWorkerClient> {
    await this.dischargeStaleFence(logicalSessionId);
    const worker = this.ensureWorker(logicalSessionId);
    await this.writeOwnedFence(logicalSessionId, worker);
    return worker;
  }

  /**
   * Verified release: the worker reached lifecycle "stopped" (tree cleanup
   * verified), so its durable fence is retired. Round 31 High: retirement is
   * never a silent best-effort — a transient unlink failure persists the
   * terminal "discharged" phase first, so the next acquire retires instead
   * of bricking against a dead root.
   */
  async release(logicalSessionId: string, client?: RuntimeWorkerClient): Promise<void> {
    const fenced = client !== undefined && this.workersByKey.get(logicalSessionId) === client;
    if (!client || fenced) {
      this.workersByKey.delete(logicalSessionId);
    }
    if (client && client.lifecycle === "stopped") {
      const fence = this.fence();
      if (fence) await this.enqueueFenceWrite(logicalSessionId, () => fence.retire(logicalSessionId));
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
    // A live, healthy client for this key means the fence is ours and current.
    const existing = this.workersByKey.get(logicalSessionId);
    if (existing?.alive && existing.lifecycle !== "failed" && existing.lifecycle !== "cooling") return;
    const deps = this.options.clientDeps;
    const outcome = await dischargeRuntimeWorkerFence(record, {
      platform: deps?.platform,
      terminateDescendants: deps?.terminateDescendantsOf
        ? (parentPid, expectedCreationDate) => deps.terminateDescendantsOf!(parentPid, { expectedParentCreationDate: expectedCreationDate })
        : undefined,
      killGroup: deps?.killProcessGroup,
      probeProcessGroup: deps?.probeProcessGroup,
      selfDischargeWaitMs: deps?.selfDischargeWaitMs,
      readBack: async () => {
        const reread = await fence.read(logicalSessionId);
        return reread;
      },
      markDischarged: async (current) => {
        await this.enqueueFenceWrite(logicalSessionId, () => fence.write({ ...current, phase: "discharged" }));
      },
    });
    if (outcome === "discharged") {
      await this.enqueueFenceWrite(logicalSessionId, () => fence.retire(logicalSessionId));
      return;
    }
    throw new WorkerTeardownPendingError(
      `durable ownership fence for session "${logicalSessionId}" is undischarged ` +
        `(worker pid ${record.pid}, phase ${record.phase}, started ${record.startedAt}); refusing to spawn a second owner`,
    );
  }

  private async writeOwnedFence(logicalSessionId: string, worker: RuntimeWorkerClient): Promise<void> {
    const fence = this.fence();
    if (!fence) return;
    if (!worker.alive) return;
    // Round 31 Blocking 1: the record is built from EXPLICIT fields (never
    // sampled from mutable client state) — the initial durable phase is
    // "owned"; the "admitted" upgrade happens only through the barrier.
    const record: RuntimeWorkerFenceRecord = {
      kind: "runtime-worker-owner",
      logicalSessionId,
      generation: worker.ref.generation,
      pid: worker.ref.pid,
      creationDate: worker.ref.creationDate ?? null,
      bootstrapVerified: worker.isBootstrapVerified,
      phase: "owned",
      startedAt: worker.ref.startedAt,
      agent: "runtime-worker",
    };
    try {
      await this.enqueueFenceWrite(logicalSessionId, () => fence.write(record));
    } catch (error) {
      // Without a durable fence we cannot enforce cross-restart single
      // ownership — fail closed: kill the freshly spawned worker instead of
      // running it unfenced (plan §43).
      this.workersByKey.delete(logicalSessionId);
      void worker.terminate().catch(() => {});
      throw new WorkerTeardownPendingError(
        `cannot persist durable ownership fence for session "${logicalSessionId}": ` +
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

  deleteWorker(logicalSessionId: string, client?: RuntimeWorkerClient): void {
    if (!client || this.workersByKey.get(logicalSessionId) === client) {
      this.workersByKey.delete(logicalSessionId);
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

