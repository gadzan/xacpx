import type { AppState } from "./types";
import type { StateStore } from "./state-store";

export interface DebouncedStateStoreDeps {
  delegate: Pick<StateStore, "save">;
  intervalMs: number;
  onError?: (error: unknown) => void;
}

export class DebouncedStateStore {
  private pending: AppState | null = null;
  private timer: NodeJS.Timeout | null = null;
  private flushing: Promise<void> | null = null;
  private disposed = false;

  constructor(private readonly deps: DebouncedStateStoreDeps) {}

  /**
   * Commit `state` as the next snapshot to write and schedule the debounced
   * flush. Resolves as soon as the snapshot is accepted — NOT when it reaches
   * disk. Callers (SessionService / ScheduledTaskService / OrchestrationService)
   * persist while holding the shared state mutex; if save() only resolved after
   * the flush, every mutation would pay the full debounce interval and writes
   * would never coalesce (N mutations ~= N x intervalMs, serialized). Durability
   * is a shutdown concern: flush()/dispose() await the real disk write. Write
   * failures are reported through `onError` (main.ts wires it to the app log).
   */
  save(state: AppState): Promise<void> {
    if (this.disposed) {
      return Promise.reject(new Error("DebouncedStateStore is disposed"));
    }
    this.pending = state;
    this.scheduleFlush();
    return Promise.resolve();
  }

  /**
   * Immediate, durable write of `state` — no debounce. Awaits any in-flight
   * write first (keeping writes ordered), supersedes a pending debounced
   * snapshot (callers are mutex-serialized, so `state` is strictly newer),
   * and REJECTS on write failure. This is the path for durability-gated
   * callers: orchestration only exposes a task transition in memory after it
   * has been persisted, so its saves must not resolve at commit time.
   */
  async saveNow(state: AppState): Promise<void> {
    if (this.disposed) {
      throw new Error("DebouncedStateStore is disposed");
    }
    this.pending = null;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    while (this.flushing) {
      await this.flushing;
    }
    let failure: unknown;
    let failed = false;
    this.flushing = (async () => {
      try {
        await this.deps.delegate.save(state);
      } catch (error) {
        failed = true;
        failure = error;
        this.deps.onError?.(error);
      }
    })().finally(() => {
      this.flushing = null;
    });
    await this.flushing;
    if (this.pending && !this.disposed) {
      this.scheduleFlush();
    }
    if (failed) {
      throw failure;
    }
  }

  async flush(): Promise<void> {
    while (this.pending || this.flushing || this.timer) {
      if (this.timer) {
        clearTimeout(this.timer);
        this.timer = null;
      }
      if (this.flushing) {
        await this.flushing;
      } else if (this.pending) {
        await this.runOneFlushCycle();
      }
    }
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    await this.flush();
  }

  private scheduleFlush(): void {
    if (this.timer || this.flushing) {
      return;
    }
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.runOneFlushCycle();
    }, this.deps.intervalMs);
    this.timer.unref?.();
  }

  private async runOneFlushCycle(): Promise<void> {
    if (this.flushing) {
      return this.flushing;
    }
    if (!this.pending) {
      return;
    }

    const state = this.pending;
    this.pending = null;

    this.flushing = (async () => {
      try {
        await this.deps.delegate.save(state);
      } catch (error) {
        // save() already resolved at commit time, so this is the only place a
        // write failure can surface. Never rethrow: flush()/dispose() must not
        // fail shutdown over a logged write error.
        this.deps.onError?.(error);
      }
    })().finally(() => {
      this.flushing = null;
    });

    await this.flushing;

    if (this.pending && !this.disposed) {
      this.scheduleFlush();
    }
  }
}
