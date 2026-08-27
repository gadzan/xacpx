import { statSync } from "node:fs";

import { RuntimeWorkerClient, type WorkerLifecycle, type RuntimeWorkerRef, type RuntimeWorkerClientDeps, WorkerTeardownPendingError } from "./runtime-worker-client";

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
    const entries = [...this.workersByKey.entries()];
    const results = await Promise.allSettled(
      entries.map(async ([key, worker]) => {
        await worker.shutdown(graceMs);
        if (!worker.alive && worker.lifecycle === "stopped") {
          this.deleteWorker(key, worker);
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
      void client.terminate().then(() => {
        if (this.workersByKey.get(logicalSessionId) === client && client.lifecycle === "stopped") {
          this.workersByKey.delete(logicalSessionId);
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

