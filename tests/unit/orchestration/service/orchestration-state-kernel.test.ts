import { expect, test } from "bun:test";

import { AsyncMutex } from "../../../../src/orchestration/async-mutex";
import { OrchestrationStateKernel } from "../../../../src/orchestration/service/orchestration-state-kernel";

test("mutate serializes concurrent callers", async () => {
  const kernel = new OrchestrationStateKernel({});
  const order: string[] = [];
  await Promise.all([
    kernel.mutate(async () => {
      order.push("a-start");
      await new Promise((r) => setTimeout(r, 10));
      order.push("a-end");
    }),
    kernel.mutate(async () => {
      order.push("b-start");
      order.push("b-end");
    }),
  ]);
  expect(order).toEqual(["a-start", "a-end", "b-start", "b-end"]);
});

test("mutate throws on reentry instead of deadlocking", async () => {
  const kernel = new OrchestrationStateKernel({});
  let message = "no throw";
  await kernel.mutate(async () => {
    try {
      await kernel.mutate(async () => "inner");
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
  });
  expect(message).toContain("nested mutate()");
});

test("mutate uses the injected mutex instance", async () => {
  const mutex = new AsyncMutex();
  let ran = 0;
  const original = mutex.run.bind(mutex);
  mutex.run = async <T>(critical: () => Promise<T>): Promise<T> => {
    ran += 1;
    return await original(critical);
  };
  const kernel = new OrchestrationStateKernel({}, mutex);
  await kernel.mutate(async () => undefined);
  expect(ran).toBe(1);
});

test("appendTaskEvent bumps eventSeq and caps the ring at MAX_TASK_EVENTS_PER_TASK", async () => {
  const kernel = new OrchestrationStateKernel({});
  const task = { taskId: "t", eventSeq: 0, events: [] } as unknown as Parameters<
    OrchestrationStateKernel["appendTaskEvent"]
  >[0];
  for (let i = 0; i < 205; i += 1) {
    kernel.appendTaskEvent(task, "2026-04-13T10:00:00.000Z", "created", { message: `m${i}` });
  }
  expect(task.eventSeq).toBe(205);
  expect(task.events!.length).toBe(200);
  expect(task.events![0]!.seq).toBe(6);
});

test("mutate lets a chain that OUTLIVES its critical section call mutate (no false deadlock throw)", async () => {
  // A promise created inside a critical section inherits the ALS store. Firing it detached and
  // letting it call mutate AFTER the section returns is not re-entrant — the mutex is free — so
  // it must run, not throw. The old boolean guard threw here (invisible to every prior test).
  const kernel = new OrchestrationStateKernel({});
  let detached!: Promise<string>;
  await kernel.mutate(async () => {
    // Created inside the section, but deliberately NOT awaited here — it runs after this returns.
    detached = (async () => {
      // A single microtask tick is NOT enough: the enclosing mutate()'s own cleanup (the
      // `finally` after `await held.run(...)`) also resolves in exactly one microtask hop, but
      // that hop is enqueued *after* this one (this callback's `await Promise.resolve()` is
      // scheduled while the enclosing critical() body is still synchronously executing, i.e.
      // strictly before the enclosing mutate() even reaches its own await). FIFO microtask
      // ordering then makes this resume first, observing runningToken not yet cleared — a false
      // "nested" throw (verified empirically: 1 tick always throws, 2+ ticks or a macrotask never
      // does). A macrotask boundary reliably drains all pending microtask cleanup first.
      await new Promise((resolve) => setTimeout(resolve, 0));
      return await kernel.mutate(async () => "ran-after");
    })();
  });
  expect(await detached).toBe("ran-after");
});

test("mutate still throws on a genuinely nested (awaited) reentry", async () => {
  const kernel = new OrchestrationStateKernel({});
  let message = "no throw";
  await kernel.mutate(async () => {
    try {
      await kernel.mutate(async () => "inner"); // awaited inside → would deadlock → must throw
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
  });
  expect(message).toContain("nested mutate()");
});
