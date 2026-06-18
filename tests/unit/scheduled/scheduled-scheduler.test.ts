import { expect, test, mock } from "bun:test";

import { ScheduledTaskScheduler } from "../../../src/scheduled/scheduled-scheduler";
import { ScheduledTaskService } from "../../../src/scheduled/scheduled-service";
import { createEmptyState } from "../../../src/state/types";

class MemoryStore {
  saves = 0;
  async save(): Promise<void> {
    this.saves += 1;
  }
}

function createFakeSetInterval() {
  const callbacks: Array<{ fn: () => void | Promise<void>; delay: number }> = [];
  let nextId = 1;
  const active = new Map<number, { fn: () => void | Promise<void>; delay: number }>();

  const setIntervalFn = mock((fn: () => void | Promise<void>, delay: number) => {
    const id = nextId++;
    const entry = { fn, delay };
    callbacks.push(entry);
    active.set(id, entry);
    return id;
  });

  const clearIntervalFn = mock((id: unknown) => {
    if (typeof id === "number") {
      active.delete(id);
    }
  });

  return { setIntervalFn, clearIntervalFn, callbacks, active };
}

test("start calls markStartupMissed and schedules interval", async () => {
  const state = createEmptyState();
  state.scheduled_tasks.old = {
    id: "old",
    chat_key: "c",
    session_alias: "s",
    execute_at: "2026-05-23T09:00:00.000Z",
    message: "old task",
    status: "pending",
    created_at: "2026-05-23T08:00:00.000Z",
  };

  const store = new MemoryStore();
  const service = new ScheduledTaskService(state, store, {
    now: () => new Date("2026-05-23T10:00:00.000Z"),
  });

  const dispatchTask = mock(async () => {});
  const { setIntervalFn, clearIntervalFn } = createFakeSetInterval();

  const scheduler = new ScheduledTaskScheduler(service, {
    dispatchTask,
    intervalMs: 5000,
    setIntervalFn,
    clearIntervalFn,
  });

  await scheduler.start();

  // markStartupMissed should have been called
  expect(state.scheduled_tasks.old?.status).toBe("missed");

  // interval should have been scheduled
  expect(setIntervalFn).toHaveBeenCalledTimes(1);
  expect(setIntervalFn.mock.calls[0]?.[1]).toBe(5000);

  scheduler.stop();
});


test("start is idempotent while already running", async () => {
  const state = createEmptyState();
  const store = new MemoryStore();
  const service = new ScheduledTaskService(state, store);
  const dispatchTask = mock(async () => {});
  const { setIntervalFn, clearIntervalFn, active } = createFakeSetInterval();

  const scheduler = new ScheduledTaskScheduler(service, {
    dispatchTask,
    setIntervalFn,
    clearIntervalFn,
  });

  await scheduler.start();
  await scheduler.start();

  expect(setIntervalFn).toHaveBeenCalledTimes(1);
  expect(active.size).toBe(1);

  scheduler.stop();
});

test("stop clears the interval", async () => {
  const state = createEmptyState();
  const store = new MemoryStore();
  const service = new ScheduledTaskService(state, store);

  const dispatchTask = mock(async () => {});
  const { setIntervalFn, clearIntervalFn, active } = createFakeSetInterval();

  const scheduler = new ScheduledTaskScheduler(service, {
    dispatchTask,
    setIntervalFn,
    clearIntervalFn,
  });

  await scheduler.start();
  expect(active.size).toBe(1);

  scheduler.stop();
  expect(clearIntervalFn).toHaveBeenCalledTimes(1);
  expect(active.size).toBe(0);
});

test("tick dispatches due tasks and marks executed on success", async () => {
  const state = createEmptyState();
  state.scheduled_tasks.due1 = {
    id: "due1",
    chat_key: "weixin:user-1",
    session_alias: "main",
    execute_at: "2026-05-23T09:59:00.000Z",
    message: "check CI",
    status: "pending",
    created_at: "2026-05-23T09:00:00.000Z",
    account_id: "wx-1",
    reply_context_token: "ctx-1",
  };
  state.scheduled_tasks.future = {
    id: "future",
    chat_key: "c",
    session_alias: "s",
    execute_at: "2026-05-23T10:01:00.000Z",
    message: "future task",
    status: "pending",
    created_at: "2026-05-23T09:00:00.000Z",
  };

  const store = new MemoryStore();
  const service = new ScheduledTaskService(state, store, {
    now: () => new Date("2026-05-23T10:00:00.000Z"),
  });

  const dispatchTask = mock(async () => {});
  const { setIntervalFn, clearIntervalFn } = createFakeSetInterval();

  const scheduler = new ScheduledTaskScheduler(service, {
    dispatchTask,
    setIntervalFn,
    clearIntervalFn,
  });

  await scheduler.tick();

  expect(dispatchTask).toHaveBeenCalledTimes(1);
  expect(dispatchTask.mock.calls[0]?.[0]).toMatchObject({
    id: "due1",
    status: "triggering",
  });
  expect(state.scheduled_tasks.due1?.status).toBe("executed");
  expect(state.scheduled_tasks.future?.status).toBe("pending");
});

test("tick marks task failed on dispatch error", async () => {
  const state = createEmptyState();
  state.scheduled_tasks.fail1 = {
    id: "fail1",
    chat_key: "c",
    session_alias: "s",
    execute_at: "2026-05-23T09:59:00.000Z",
    message: "will fail",
    status: "pending",
    created_at: "2026-05-23T09:00:00.000Z",
  };

  const store = new MemoryStore();
  const service = new ScheduledTaskService(state, store, {
    now: () => new Date("2026-05-23T10:00:00.000Z"),
  });

  const dispatchTask = mock(async () => {
    throw new Error("channel unavailable");
  });
  const { setIntervalFn, clearIntervalFn } = createFakeSetInterval();

  const scheduler = new ScheduledTaskScheduler(service, {
    dispatchTask,
    setIntervalFn,
    clearIntervalFn,
  });

  await scheduler.tick();

  expect(dispatchTask).toHaveBeenCalledTimes(1);
  expect(state.scheduled_tasks.fail1?.status).toBe("failed");
  expect(state.scheduled_tasks.fail1?.last_error).toBe("channel unavailable");
});

test("onSettled fires after a task reaches a terminal state (executed and failed)", async () => {
  const state = createEmptyState();
  state.scheduled_tasks.ok1 = {
    id: "ok1", chat_key: "relay:acc", session_alias: "s",
    execute_at: "2026-05-23T09:59:00.000Z", message: "ok", status: "pending", created_at: "2026-05-23T09:00:00.000Z",
  };
  state.scheduled_tasks.bad1 = {
    id: "bad1", chat_key: "relay:acc", session_alias: "s",
    execute_at: "2026-05-23T09:59:00.000Z", message: "bad", status: "pending", created_at: "2026-05-23T09:00:00.000Z",
  };
  const store = new MemoryStore();
  const service = new ScheduledTaskService(state, store, { now: () => new Date("2026-05-23T10:00:00.000Z") });

  const settled: Array<{ id: string; chatKey: string }> = [];
  const dispatchTask = mock(async (task: { id: string }) => { if (task.id === "bad1") throw new Error("boom"); });
  const { setIntervalFn, clearIntervalFn } = createFakeSetInterval();
  const scheduler = new ScheduledTaskScheduler(service, {
    dispatchTask,
    onSettled: (task) => settled.push({ id: task.id, chatKey: task.chat_key }),
    setIntervalFn, clearIntervalFn,
  });

  await scheduler.tick();

  // Both the executed and the failed task notify, carrying their chat_key so the
  // wiring in main.ts can emit a scheduled-changed event for the web panel.
  expect(settled).toEqual(expect.arrayContaining([
    { id: "ok1", chatKey: "relay:acc" },
    { id: "bad1", chatKey: "relay:acc" },
  ]));
  expect(settled).toHaveLength(2);
});

test("tick coalesces overlapping calls", async () => {
  const state = createEmptyState();
  state.scheduled_tasks.due1 = {
    id: "due1",
    chat_key: "c",
    session_alias: "s",
    execute_at: "2026-05-23T09:59:00.000Z",
    message: "task",
    status: "pending",
    created_at: "2026-05-23T09:00:00.000Z",
  };

  const store = new MemoryStore();
  const service = new ScheduledTaskService(state, store, {
    now: () => new Date("2026-05-23T10:00:00.000Z"),
  });

  let resolveDispatch!: () => void;
  const dispatchStarted = new Promise<void>((resolve) => {
    resolveDispatch = () => resolve();
  });
  const dispatchTask = mock(async () => {
    resolveDispatch();
    await new Promise((resolve) => setTimeout(resolve, 50));
  });
  const { setIntervalFn, clearIntervalFn } = createFakeSetInterval();

  const scheduler = new ScheduledTaskScheduler(service, {
    dispatchTask,
    setIntervalFn,
    clearIntervalFn,
  });

  // Start two concurrent ticks
  const tick1 = scheduler.tick();
  await dispatchStarted;
  const tick2 = scheduler.tick();

  await tick1;
  await tick2;

  // dispatchTask should only be called once due to coalescing
  expect(dispatchTask).toHaveBeenCalledTimes(1);
});

test("start runs an immediate tick", async () => {
  const state = createEmptyState();
  state.scheduled_tasks.due1 = {
    id: "due1",
    chat_key: "c",
    session_alias: "s",
    execute_at: "2026-05-23T10:00:00.000Z",
    message: "immediate task",
    status: "pending",
    created_at: "2026-05-23T09:00:00.000Z",
  };

  const store = new MemoryStore();
  const service = new ScheduledTaskService(state, store, {
    now: () => new Date("2026-05-23T10:00:00.000Z"),
  });

  const dispatchTask = mock(async () => {});
  const { setIntervalFn, clearIntervalFn } = createFakeSetInterval();

  const scheduler = new ScheduledTaskScheduler(service, {
    dispatchTask,
    setIntervalFn,
    clearIntervalFn,
  });

  await scheduler.start();

  // The immediate tick should have dispatched the due task (execute_at == now)
  expect(dispatchTask).toHaveBeenCalledTimes(1);
  expect(state.scheduled_tasks.due1?.status).toBe("executed");

  scheduler.stop();
});

test("tick times out a hung dispatch, aborts it, and marks it failed", async () => {
  const state = createEmptyState();
  state.scheduled_tasks.hung = {
    id: "hung",
    chat_key: "c",
    session_alias: "s",
    execute_at: "2026-05-23T09:59:00.000Z",
    message: "hung task",
    status: "pending",
    created_at: "2026-05-23T09:00:00.000Z",
  };

  const store = new MemoryStore();
  const service = new ScheduledTaskService(state, store, {
    now: () => new Date("2026-05-23T10:00:00.000Z"),
  });

  let abortObserved = false;
  const dispatchTask = mock((_task: unknown, signal: AbortSignal) => {
    return new Promise<void>((_resolve, reject) => {
      signal.addEventListener("abort", () => {
        abortObserved = true;
        reject(new Error("dispatch aborted"));
      });
    });
  });
  const { setIntervalFn, clearIntervalFn } = createFakeSetInterval();

  const scheduler = new ScheduledTaskScheduler(service, {
    dispatchTask,
    dispatchTimeoutMs: 20,
    setIntervalFn,
    clearIntervalFn,
  });

  await scheduler.tick();

  expect(abortObserved).toBe(true);
  expect(state.scheduled_tasks.hung?.status).toBe("failed");
  expect(state.scheduled_tasks.hung?.last_error).toContain("timed out");
});

test("tick does not wedge when a dispatch ignores its abort signal", async () => {
  const state = createEmptyState();
  state.scheduled_tasks.stuck = {
    id: "stuck",
    chat_key: "c",
    session_alias: "s",
    execute_at: "2026-05-23T09:59:00.000Z",
    message: "stuck task",
    status: "pending",
    created_at: "2026-05-23T09:00:00.000Z",
  };

  const store = new MemoryStore();
  const service = new ScheduledTaskService(state, store, {
    now: () => new Date("2026-05-23T10:00:00.000Z"),
  });

  // Never resolves and never observes the abort signal — the scheduler must
  // still recover via the dispatch timeout instead of wedging forever.
  const dispatchTask = mock(() => new Promise<void>(() => {}));
  const { setIntervalFn, clearIntervalFn } = createFakeSetInterval();

  const scheduler = new ScheduledTaskScheduler(service, {
    dispatchTask,
    dispatchTimeoutMs: 20,
    setIntervalFn,
    clearIntervalFn,
  });

  // If the tick can wedge, this await never settles and the test times out.
  await scheduler.tick();

  expect(state.scheduled_tasks.stuck?.status).toBe("failed");
});

// tick() resilience: state-store errors must never escape tick() — an escaped
// rejection from the interval callback would terminate the daemon process.

test("tick survives claimDueTasks throwing — no unhandled rejection", async () => {
  // Build a fake service whose claimDueTasks always throws.
  // If tick() lets the error escape as an unhandled rejection, bun:test detects
  // it and fails the file.  The await below would also throw if tick() rethrows.
  const throwingService = {
    markStartupMissed: async () => {},
    claimDueTasks: async (): Promise<never> => {
      throw new Error("state-store EBUSY");
    },
    markExecuted: async () => {},
    markFailed: async () => {},
  } as unknown as ScheduledTaskService;

  const dispatchTask = mock(async () => {});
  const { setIntervalFn, clearIntervalFn } = createFakeSetInterval();

  const scheduler = new ScheduledTaskScheduler(throwingService, {
    dispatchTask,
    setIntervalFn,
    clearIntervalFn,
  });

  // tick() must not throw (the daemon must survive a transient store error).
  await expect(scheduler.tick()).resolves.toBeUndefined();

  // A second tick must also execute (the ticking lock must have been released).
  await expect(scheduler.tick()).resolves.toBeUndefined();

  // dispatchTask was never reached because claimDueTasks threw before it.
  expect(dispatchTask).toHaveBeenCalledTimes(0);
});

test("tick leaves a dispatched task alone when markExecuted throws — no markFailed", async () => {
  // Dispatch SUCCEEDS, then markExecuted's state save throws. The task was
  // delivered, so it must NOT be recorded as failed; startup reconciliation
  // handles the stale "triggering" record.
  const events: Array<{ event: string; context?: Record<string, unknown> }> = [];
  const logger = {
    debug: async () => {},
    info: async () => {},
    error: async (event: string, _message: string, context?: Record<string, unknown>) => {
      events.push({ event, ...(context ? { context } : {}) });
    },
    cleanup: async () => {},
    flush: async () => {},
  };

  const task = {
    id: "ok-but-save-fails",
    chat_key: "c",
    session_alias: "s",
    execute_at: "2026-05-23T09:59:00.000Z",
    message: "delivered",
    status: "triggering",
    created_at: "2026-05-23T09:00:00.000Z",
  };
  const markFailed = mock(async () => {});
  const service = {
    markStartupMissed: async () => {},
    claimDueTasks: async () => [task],
    markExecuted: async () => {
      throw new Error("disk full");
    },
    markFailed,
  } as unknown as ScheduledTaskService;

  const dispatchTask = mock(async () => {});
  const { setIntervalFn, clearIntervalFn } = createFakeSetInterval();

  const scheduler = new ScheduledTaskScheduler(service, {
    dispatchTask,
    setIntervalFn,
    clearIntervalFn,
    logger,
  });

  await expect(scheduler.tick()).resolves.toBeUndefined();

  expect(dispatchTask).toHaveBeenCalledTimes(1);
  expect(markFailed).toHaveBeenCalledTimes(0);
  const markExecutedFailures = events.filter((entry) => entry.event === "scheduled.dispatch.mark_executed_failed");
  expect(markExecutedFailures).toHaveLength(1);
  expect(markExecutedFailures[0]?.context?.taskId).toBe("ok-but-save-fails");
  expect(events.filter((entry) => entry.event === "scheduled.dispatch.failed")).toHaveLength(0);

  // Ticking lock released — a later tick still runs.
  await expect(scheduler.tick()).resolves.toBeUndefined();
});

test("tick still marks the task failed when the dispatch itself throws", async () => {
  const task = {
    id: "dispatch-throws",
    chat_key: "c",
    session_alias: "s",
    execute_at: "2026-05-23T09:59:00.000Z",
    message: "boom",
    status: "triggering",
    created_at: "2026-05-23T09:00:00.000Z",
  };
  const markExecuted = mock(async () => {});
  const markFailed = mock(async () => {});
  const service = {
    markStartupMissed: async () => {},
    claimDueTasks: async () => [task],
    markExecuted,
    markFailed,
  } as unknown as ScheduledTaskService;

  const dispatchTask = mock(async () => {
    throw new Error("channel unavailable");
  });
  const { setIntervalFn, clearIntervalFn } = createFakeSetInterval();

  const scheduler = new ScheduledTaskScheduler(service, {
    dispatchTask,
    setIntervalFn,
    clearIntervalFn,
  });

  await expect(scheduler.tick()).resolves.toBeUndefined();

  expect(markFailed).toHaveBeenCalledTimes(1);
  expect(markExecuted).toHaveBeenCalledTimes(0);
});

test("tick survives dispatch failure AND markFailed throwing — no unhandled rejection", async () => {
  // Simulate: dispatch throws, then markFailed also throws (e.g. disk full during
  // the error-recording write). Neither error should escape tick().
  const state = createEmptyState();
  state.scheduled_tasks.fail2 = {
    id: "fail2",
    chat_key: "c",
    session_alias: "s",
    execute_at: "2026-05-23T09:59:00.000Z",
    message: "will fail",
    status: "pending",
    created_at: "2026-05-23T09:00:00.000Z",
  };

  const saveCalls: number[] = [];
  const store = {
    async save(): Promise<void> {
      saveCalls.push(Date.now());
      // First save (claimDueTasks) succeeds; second save (markFailed) throws.
      if (saveCalls.length >= 2) throw new Error("disk full");
    },
  };
  const service = new ScheduledTaskService(state, store, {
    now: () => new Date("2026-05-23T10:00:00.000Z"),
  });

  const dispatchTask = mock(async () => {
    throw new Error("channel unavailable");
  });
  const { setIntervalFn, clearIntervalFn } = createFakeSetInterval();

  const scheduler = new ScheduledTaskScheduler(service, {
    dispatchTask,
    setIntervalFn,
    clearIntervalFn,
  });

  // Must not throw even though markFailed's save also throws.
  await expect(scheduler.tick()).resolves.toBeUndefined();

  // Subsequent tick must still work (ticking lock released).
  await expect(scheduler.tick()).resolves.toBeUndefined();
});
