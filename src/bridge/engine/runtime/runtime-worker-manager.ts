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
  private readonly workers = new Map<string, RuntimeWorkerClient>();
  private readonly restarts = new Map<string, number[]>();

  constructor(private readonly options: RuntimeWorkerManagerOptions) {
    if (!options.entryPath || !fileExists(options.entryPath)) {
      throw new Error(`runtime worker entry not found: ${options.entryPath} (build the project first)`);
    }
  }

  get(key: string): RuntimeWorkerClient | undefined {
    return this.workers.get(key);
  }

  lifecycleFor(key: string): WorkerLifecycle {
    return this.workers.get(key)?.lifecycle ?? "stopped";
  }

  /** Warm = process alive AND bootstrap complete AND not shutting down (plan §15). */
  isWarm(key: string): boolean {
    const worker = this.workers.get(key);
    return worker !== undefined && (worker.lifecycle === "ready" || worker.lifecycle === "busy" || worker.lifecycle === "idle") && worker.alive;
  }

  ensureWorker(logicalSessionId: string): RuntimeWorkerClient {
    let worker = this.workers.get(logicalSessionId);
    if (worker && worker.alive) return worker;
    this.assertRestartBudget(logicalSessionId);
    worker = new RuntimeWorkerClient(this.options.entryPath, logicalSessionId, undefined, () =>
      this.handleExit(logicalSessionId),
    );
    worker.spawn();
    this.workers.set(logicalSessionId, worker);
    return worker;
  }

  async shutdownAll(graceMs = 2_000): Promise<void> {
    await Promise.allSettled([...this.workers.values()].map((worker) => worker.shutdown(graceMs)));
    this.workers.clear();
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
    recent.push(now);
    this.restarts.set(logicalSessionId, recent);
  }

  private handleExit(logicalSessionId: string): void {
    // Crash bookkeeping happens at respawn (ensureWorker); here we only drop
    // the dead client so the next operation respawns cleanly.
    this.workers.delete(logicalSessionId);
  }
}

function fileExists(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

