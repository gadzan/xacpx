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
  // This variant crosses a macrotask boundary; the same-microtask single-`.then` case (the exact
  // shape Issue #149 names) is covered by the test below and is also allowed by the deferred
  // re-check guard.
  const kernel = new OrchestrationStateKernel({});
  let detached!: Promise<string>;
  await kernel.mutate(async () => {
    // Created inside the section, but deliberately NOT awaited here — it runs after this returns.
    detached = (async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
      return await kernel.mutate(async () => "ran-after");
    })();
  });
  expect(await detached).toBe("ran-after");
});

test("mutate lets a detached .then() chain re-enter AFTER its section returns, in the same microtask turn (#149 filed hazard)", async () => {
  // The exact construct Issue #149 names: a promise created inside the section, chained with a
  // single `.then` and NOT awaited, that calls mutate() once the section body has returned. It
  // inherits the section's async context, so at the instant it calls mutate the section's
  // `runningToken` reset is still enqueued one microtask behind (the `.then` callback was queued
  // during the body's synchronous run, strictly before the section's own teardown). The OLD guard
  // threw synchronously here; the deferred re-check yields once, sees the section has returned
  // (runningToken cleared), and lets the chain run. This test throws under the old guard —
  // deleting the yield/re-check reddens it.
  const kernel = new OrchestrationStateKernel({});
  let ran: string | undefined;
  let threw: string | undefined;
  await kernel.mutate(async () => {
    void Promise.resolve().then(async () => {
      try {
        ran = await kernel.mutate(async () => "ran-after-return");
      } catch (error) {
        threw = error instanceof Error ? error.message : String(error);
      }
    });
  });
  // Drain the detached chain.
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(threw).toBeUndefined();
  expect(ran).toBe("ran-after-return");
});

test("mutate still throws on a nested reentry issued after an INTERNAL await inside the section", async () => {
  // Guards the reset-in-finally contract: runningToken must stay set until critical() has fully
  // settled. If the reset were moved to run synchronously right after invoking held.run (instead
  // of in the finally after `await`), this nested call — issued after the section suspends and
  // resumes — would slip through and deadlock. The synchronous-nested test above cannot catch that.
  const kernel = new OrchestrationStateKernel({});
  let message = "no throw";
  await kernel.mutate(async () => {
    await new Promise((r) => setTimeout(r, 0)); // suspend the section, then re-enter
    try {
      await kernel.mutate(async () => "inner");
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
  });
  expect(message).toContain("nested mutate()");
});
