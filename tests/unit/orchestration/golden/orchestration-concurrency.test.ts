// tests/unit/orchestration/golden/orchestration-concurrency.test.ts
// Pins the concurrency behaviour of OrchestrationService. The 185-test oracle drives the
// service sequentially, so none of this is covered there — yet Task 8 (mutex extraction)
// and Task 9 (pending-* map relocation) are exactly the changes that can break it.
//
// Technique: deps.loadState / deps.saveState are the only yield points inside a critical
// section (`mutate()`, backed by `AsyncMutex.run` in src/orchestration/async-mutex.ts —
// a promise-chain mutex, not a real lock). Gating them on a deferred promise turns a race
// into a deterministic interleaving.
//
// Deviation from the task-6 brief's example code for test 1 (recorded here, not silently
// "fixed prettier"): direct measurement showed a SINGLE, uncontested, non-parallel
// requestDelegate call already performs TWO loadState calls before its ONE saveState call.
// `reserveProposedWorkerSession`'s own mutate() (orchestration-service.ts:3107-3113) loads
// state but never saves it — it only touches the in-memory `pendingWorkerSessions` map —
// and the later persist-mutate (:644-707) does the real load+save. So even a single,
// fully-serialized delegation's trace already reads "load load save"; two SEQUENTIAL
// (fully-awaited, non-overlapping) delegations produce "load load save load load save",
// which trivially contains "load load save" twice. The brief's proposed
// `expect(trace.join(" ")).not.toContain("load load save")` is therefore a false-positive
// detector: it would fail on provably-correct, non-overlapping behaviour, because
// substring matching on the merged trace cannot distinguish "one delegation's own two
// mutate() sections" from "two delegations' critical sections unsafely overlapping".
// Test 1 below instead asserts directly on what mutual exclusion actually guarantees:
// while delegation A's first mutate() is gated open (holding the mutex), delegation B's
// own mutate() must not have run its loadState yet, no matter how many event-loop turns
// elapse waiting for it to.
import { expect, test } from "bun:test";

import { createConfig } from "../../commands/command-router-test-support";
import { OrchestrationService } from "../../../../src/orchestration/orchestration-service";
import { makeGoldenHarness } from "./golden-harness";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

const cappedConfig = {
  ...createConfig(),
  orchestration: { ...createConfig().orchestration, maxParallelTasksPerAgent: 1 },
};

test("concurrency: the state mutex serializes two overlapping delegations", async () => {
  // Different targetAgent (claude vs codex) so the two delegations resolve to different
  // worker-session names and don't collide on assertWorkerSessionAvailable — that
  // collision is a separate, already-characterized business rule (see the golden human
  // path fixtures) and is not what this test pins.
  const harness = makeGoldenHarness({ ids: ["task-1", "task-2"] });
  let firstLoadGated = false;
  let loadCountWhileGated = 0;
  const gate = deferred<void>();

  const baseLoad = harness.deps.loadState;
  harness.deps.loadState = async () => {
    loadCountWhileGated += 1;
    if (!firstLoadGated) {
      firstLoadGated = true;
      await gate.promise;
    }
    return await baseLoad();
  };

  const service = new OrchestrationService(harness.deps);
  const a = service.requestDelegate({
    sourceHandle: "wx:user-1",
    sourceKind: "human",
    coordinatorSession: "backend:main",
    workspace: "backend",
    targetAgent: "claude",
    task: "first",
  });
  const b = service.requestDelegate({
    sourceHandle: "wx:user-1",
    sourceKind: "human",
    coordinatorSession: "backend:main",
    workspace: "backend",
    targetAgent: "codex",
    task: "second",
  });

  // Churn the event loop well past the point where B would have reached its own
  // reserveProposedWorkerSession mutate() call if nothing were blocking it (measured:
  // 2-3 ticks is enough; 20 leaves a wide margin with no timing-dependent false pass).
  // A's first mutate() is gated open the whole time, holding the mutex — if the mutex
  // were lost, B's loadState would fire during this window and the count below would be 2.
  for (let i = 0; i < 20; i += 1) {
    await Bun.sleep(0);
  }
  expect(loadCountWhileGated).toBe(1);

  gate.resolve();
  await Promise.all([a, b]);

  const state = harness.getState();
  expect(state.orchestration.tasks["task-1"]?.status).toBe("running");
  expect(state.orchestration.tasks["task-2"]?.status).toBe("running");
});

test("concurrency: two parallel delegations at cap 1 dispatch exactly one and queue the other", async () => {
  // The parallel gate reads capacity in one mutate() and persists `running` in another.
  // pendingParallelStarts (orchestration-service.ts:330-337) exists to close that window.
  // Drive both delegations concurrently and assert exactly one dispatches while the other
  // queues — not sequentially, like the existing golden "at parallel capacity" fixture.
  const harness = makeGoldenHarness({
    ids: ["task-1", "task-1-slot", "task-2", "task-2-slot"],
    config: cappedConfig,
  });
  const service = new OrchestrationService(harness.deps);

  await Promise.all([
    service.requestDelegate({
      sourceHandle: "wx:user-1",
      sourceKind: "human",
      coordinatorSession: "backend:main",
      workspace: "backend",
      targetAgent: "claude",
      task: "first",
      parallel: true,
    }),
    service.requestDelegate({
      sourceHandle: "wx:user-1",
      sourceKind: "human",
      coordinatorSession: "backend:main",
      workspace: "backend",
      targetAgent: "claude",
      task: "second",
      parallel: true,
    }),
  ]);

  const state = harness.getState();
  const statuses = Object.values(state.orchestration.tasks).map((t) => t.status).sort();
  const dispatches = harness.calls.filter((c) => c.port === "dispatchWorkerTask").length;

  // Whatever the real capacity is, dispatch count must equal the number of running tasks,
  // and both tasks must exist (one running, one queued) — never both running, never both
  // queued.
  expect(statuses).toEqual(["queued", "running"]);
  expect(dispatches).toBe(statuses.filter((s) => s === "running").length);
});

test("concurrency: reconcileParallelSlots racing a delegation never over-dispatches", async () => {
  const harness = makeGoldenHarness({
    ids: ["task-1", "task-1-slot", "task-2", "task-2-slot", "task-3", "task-3-slot"],
    config: cappedConfig,
  });
  const service = new OrchestrationService(harness.deps);

  await service.requestDelegate({
    sourceHandle: "wx:user-1",
    sourceKind: "human",
    coordinatorSession: "backend:main",
    workspace: "backend",
    targetAgent: "claude",
    task: "first",
    parallel: true,
  });
  await service.requestDelegate({
    sourceHandle: "wx:user-1",
    sourceKind: "human",
    coordinatorSession: "backend:main",
    workspace: "backend",
    targetAgent: "claude",
    task: "second",
    parallel: true,
  });
  // recordWorkerReply requires the caller's sourceHandle to match the task's assigned
  // workerSession exactly — read it back from state rather than hardcoding the `:p-<id>`
  // suffix the harness generated.
  const task1 = harness.getState().orchestration.tasks["task-1"]!;
  await service.recordWorkerReply({
    taskId: "task-1",
    sourceHandle: task1.workerSession!,
    summary: "done",
    resultText: "ok",
  });

  await Promise.all([
    service.reconcileParallelSlots(),
    service.requestDelegate({
      sourceHandle: "wx:user-1",
      sourceKind: "human",
      coordinatorSession: "backend:main",
      workspace: "backend",
      targetAgent: "claude",
      task: "third",
      parallel: true,
    }),
  ]);

  const state = harness.getState();
  const tasks = Object.values(state.orchestration.tasks);
  const running = tasks.filter((t) => t.status === "running");
  const dispatches = harness.calls.filter((c) => c.port === "dispatchWorkerTask").length;

  // Each running task was dispatched exactly once; a lost pendingParallelStarts shows up
  // as more dispatches than non-queued tasks, or as two tasks running at capacity 1.
  expect(dispatches).toBe(tasks.filter((t) => t.status !== "queued").length);
  expect(running.length).toBeLessThanOrEqual(harness.deps.config.orchestration.maxParallelTasksPerAgent);
});
