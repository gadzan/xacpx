import { statSync } from "node:fs";

import { RuntimeWorkerClient, type WorkerLifecycle, type RuntimeWorkerRef, type RuntimeWorkerClientDeps } from "./runtime-worker-client";

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
}

export class RuntimeWorkerManager {
  private readonly workersByKey = new Map<string, RuntimeWorkerClient>();
  private readonly restarts = new Map<string, number[]>();

  constructor(private readonly options: RuntimeWorkerManagerOptions) {
    if (!options.entryPath || !fileExists(options.entryPath)) {
      throw new Error(`runtime worker entry not found: ${options.entryPath} (build the project first)`);
    }
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
    return worker !== undefined && (worker.lifecycle === "ready" || worker.lifecycle === "busy" || worker.lifecycle === "idle") && worker.alive;
  }

  ensureWorker(logicalSessionId: string): RuntimeWorkerClient {
    const existing = this.workersByKey.get(logicalSessionId);
    if (existing && existing.alive) {
      // If the current worker is still alive but undergoing teardown (cooling,
      // stopped, or termination failed), fail closed — never spawn a concurrent
      // duplicate owner for the same logical session (plan §3-R1 / §9.1).
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

    this.assertRestartBudget(logicalSessionId);
    const worker = new RuntimeWorkerClient(
      this.options.entryPath,
      logicalSessionId,
      undefined,
      (client, code) => this.handleExit(logicalSessionId, client, code),
      this.options.clientDeps,
    );
    worker.spawn();
    this.workersByKey.set(logicalSessionId, worker);
    return worker;
  }

  async shutdownAll(graceMs = 2_000): Promise<void> {
    await Promise.allSettled([...this.workersByKey.values()].map((worker) => worker.shutdown(graceMs)));
    this.workersByKey.clear();
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
    // Identity guard: only drop the map entry if the exiting client is STILL
    // the registered client for this session. A stale exit from an older
    // generation must never delete a newer replacement worker.
    if (this.workersByKey.get(logicalSessionId) === client) {
      this.workersByKey.delete(logicalSessionId);
    }
    // Plan §43 scopes the guard to REAL crashes. Deliberate stops (graceful
    // shutdown, freeWarm cooling) exit 0 and are NOT charged; a nonzero/signal
    // exit while calls were in flight is.
    if (client.lifecycle !== "failed") return;
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

export class WorkerTeardownPendingError extends Error {
  readonly code = "RUNTIME_WORKER_TEARDOWN_PENDING";
  constructor(message: string) {
    super(message);
    this.name = "WorkerTeardownPendingError";
  }
}

function fileExists(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

