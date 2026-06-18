import type { AppLogger } from "../logging/app-logger";
import type { ScheduledTaskRecord } from "./scheduled-types";
import type { ScheduledTaskService } from "./scheduled-service";

// Upper bound on a single scheduled dispatch (notice + full agent turn). A
// scheduled prompt is non-interactive, so a turn that runs longer than this is
// almost certainly wedged (e.g. awaiting a permission approval no human will
// give, or a stuck transport). Bounding it prevents one task from holding the
// `ticking` lock forever and starving every later scheduled task.
const DEFAULT_DISPATCH_TIMEOUT_MS = 10 * 60 * 1000;

export interface ScheduledTaskSchedulerDeps {
  dispatchTask: (task: ScheduledTaskRecord, abortSignal: AbortSignal) => Promise<void>;
  // Fired after a task reaches a terminal state (executed/failed), so consumers can
  // refresh their view — e.g. emit a `scheduled-changed` control event so the web
  // panel reloads and the fired task shows its Done/Failed status instead of vanishing.
  onSettled?: (task: ScheduledTaskRecord) => void;
  intervalMs?: number;
  dispatchTimeoutMs?: number;
  setIntervalFn?: (fn: () => void | Promise<void>, delay: number) => unknown;
  clearIntervalFn?: (timer: unknown) => void;
  logger?: AppLogger;
}

export class ScheduledTaskScheduler {
  private readonly intervalMs: number;
  private readonly dispatchTimeoutMs: number;
  private readonly setIntervalFn: (fn: () => void | Promise<void>, delay: number) => unknown;
  private readonly clearIntervalFn: (timer: unknown) => void;
  private readonly dispatchTask: (task: ScheduledTaskRecord, abortSignal: AbortSignal) => Promise<void>;
  private readonly onSettled?: (task: ScheduledTaskRecord) => void;
  private readonly logger?: AppLogger;
  private intervalHandle: unknown = null;
  private ticking = false;

  constructor(
    private readonly service: ScheduledTaskService,
    deps: ScheduledTaskSchedulerDeps,
  ) {
    this.dispatchTask = deps.dispatchTask;
    this.onSettled = deps.onSettled;
    this.intervalMs = deps.intervalMs ?? 5000;
    this.dispatchTimeoutMs = deps.dispatchTimeoutMs ?? DEFAULT_DISPATCH_TIMEOUT_MS;
    this.setIntervalFn = deps.setIntervalFn ?? ((fn, delay) => setInterval(fn, delay));
    this.clearIntervalFn = deps.clearIntervalFn ?? ((timer) => clearInterval(timer as NodeJS.Timeout));
    this.logger = deps.logger;
  }

  async start(): Promise<void> {
    if (this.intervalHandle !== null) return;
    await this.service.markStartupMissed();
    this.intervalHandle = this.setIntervalFn(() => {
      void this.tick();
    }, this.intervalMs);
    await this.tick();
  }

  stop(): void {
    if (this.intervalHandle !== null) {
      this.clearIntervalFn(this.intervalHandle);
      this.intervalHandle = null;
    }
  }

  async tick(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      let dueTasks: ScheduledTaskRecord[];
      try {
        dueTasks = await this.service.claimDueTasks();
      } catch (claimError) {
        // A transient state-store failure (disk full, EBUSY, EPERM, …) must
        // never kill the daemon — skip this tick and wait for the next interval.
        await this.logger?.error(
          "scheduled.claim.failed",
          "claimDueTasks threw; skipping tick",
          { message: claimError instanceof Error ? claimError.message : String(claimError) },
        );
        return;
      }
      for (const task of dueTasks) {
        try {
          await this.dispatchWithTimeout(task);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          await this.logger?.error("scheduled.dispatch.failed", "failed to dispatch scheduled task", {
            taskId: task.id,
            message,
          });
          try {
            await this.service.markFailed(task.id, error);
            this.notifySettled(task);
          } catch (markError) {
            // markFailed itself may throw if the store write fails.  Swallow so
            // one bad task's error-recording write cannot escape tick() and
            // crash the daemon or prevent subsequent tasks from being processed.
            await this.logger?.error(
              "scheduled.dispatch.mark_failed",
              "markFailed threw; task state may be stale",
              {
                taskId: task.id,
                message: markError instanceof Error ? markError.message : String(markError),
              },
            );
          }
          continue;
        }
        try {
          await this.service.markExecuted(task.id);
          this.notifySettled(task);
        } catch (markError) {
          // The dispatch SUCCEEDED — only the bookkeeping write failed, so the
          // task must not be recorded as failed. Leave its state alone (disk
          // likely still says "triggering"); startup reconciliation handles
          // the stale record.
          await this.logger?.error(
            "scheduled.dispatch.mark_executed_failed",
            "markExecuted threw after a successful dispatch; leaving task state for startup reconciliation",
            {
              taskId: task.id,
              message: markError instanceof Error ? markError.message : String(markError),
            },
          );
        }
      }
    } finally {
      this.ticking = false;
    }
  }

  // Notify a settled task to the optional listener, isolating a throwing listener
  // so it can never escape tick() and crash the daemon or skip later tasks.
  private notifySettled(task: ScheduledTaskRecord): void {
    if (!this.onSettled) return;
    try {
      this.onSettled(task);
    } catch (error) {
      void this.logger?.error("scheduled.on_settled.failed", "scheduled onSettled listener threw", {
        taskId: task.id,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  // Runs one dispatch with a hard upper bound. `Promise.race` guarantees the
  // tick proceeds after at most `dispatchTimeoutMs` even if `dispatchTask`
  // never settles and ignores the abort signal; the AbortController is a
  // best-effort cancel so a cooperating turn (transport prompt) stops too.
  private async dispatchWithTimeout(task: ScheduledTaskRecord): Promise<void> {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        // Reject before aborting so the race adopts this deterministic message
        // rather than whatever error the aborted dispatch happens to throw.
        reject(new Error(`scheduled task dispatch timed out after ${this.dispatchTimeoutMs}ms`));
        controller.abort();
      }, this.dispatchTimeoutMs);
    });

    const dispatch = this.dispatchTask(task, controller.signal);
    // The losing side of the race stays pending/unhandled; swallow its eventual
    // rejection so a late abort error never becomes an unhandled rejection.
    dispatch.catch(() => {});

    try {
      await Promise.race([dispatch, timeout]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }
}
