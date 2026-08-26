import { statSync } from "node:fs";

import { RuntimeWorkerClient, type WorkerLifecycle, type RuntimeWorkerRef } from "./runtime-worker-client";

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
    let worker = this.workersByKey.get(logicalSessionId);
    if (worker && worker.alive) return worker;
    this.assertRestartBudget(logicalSessionId);
    worker = new RuntimeWorkerClient(this.options.entryPath, logicalSessionId, undefined, (client, code) =>
      this.handleExit(logicalSessionId, client, code),
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
    this.workersByKey.delete(logicalSessionId);
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

function fileExists(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

