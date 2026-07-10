import { expect, test } from "bun:test";

import { OrchestrationStateKernel } from "../../../../src/orchestration/service/orchestration-state-kernel";
import { QuestionFlowCore } from "../../../../src/orchestration/service/question-flow-core";
import { TaskCancellationService } from "../../../../src/orchestration/service/task-cancellation-service";
import { WorkerSessionManager } from "../../../../src/orchestration/service/worker-session-manager";
import type { OrchestrationTaskRecord } from "../../../../src/orchestration/orchestration-types";
import { createEmptyState } from "../../../../src/state/types";
import { makeGoldenHarness } from "../golden/golden-harness";

// Construct the service from a bare object literal of exactly its seven ports — never
// `harness.deps` wholesale — plus the kernel and its two collaborators. This is the
// isolation-testability deliverable of the split: the service must not silently reach
// for a dep outside its declared TaskCancellationDeps.
test("constructible with only its seven ports and stamps a cancel failure", async () => {
  const initialState = createEmptyState();
  const seededTask: OrchestrationTaskRecord = {
    taskId: "t1",
    sourceHandle: "worker:w1",
    sourceKind: "worker",
    coordinatorSession: "coord-1",
    workspace: "backend",
    targetAgent: "codex",
    task: "do the thing",
    status: "running",
    summary: "",
    resultText: "",
    createdAt: "2026-04-13T09:00:00.000Z",
    updatedAt: "2026-04-13T09:00:00.000Z",
    cancelRequestedAt: "2026-04-13T09:30:00.000Z",
  };
  initialState.orchestration.tasks[seededTask.taskId] = seededTask;

  const harness = makeGoldenHarness({ initialState });
  const kernel = new OrchestrationStateKernel({ logger: harness.deps.logger });
  const workerSessions = new WorkerSessionManager(harness.deps, kernel);
  const questionFlow = new QuestionFlowCore(harness.deps, kernel);
  const cancellation = new TaskCancellationService(
    {
      now: harness.deps.now,
      createId: harness.deps.createId,
      loadState: harness.deps.loadState,
      saveState: harness.deps.saveState,
      cancelWorkerTask: harness.deps.cancelWorkerTask,
      interruptWorkerTask: harness.deps.interruptWorkerTask,
      wakeCoordinatorSession: harness.deps.wakeCoordinatorSession,
    },
    kernel,
    workerSessions,
    questionFlow,
  );

  const result = await cancellation.failTaskCancellation("t1", "boom");
  expect(result.lastCancelError).toBe("boom");
  expect(result.updatedAt).toBe("2026-04-13T10:00:00.000Z");

  const persisted = harness.getState().orchestration.tasks["t1"];
  expect(persisted.lastCancelError).toBe("boom");
  const progressEvents = (persisted.events ?? []).filter((event) => event.type === "progress");
  expect(progressEvents.length).toBe(1);
  expect(progressEvents[0]!.message).toBe("Cancellation failed: boom");
});

// Reentrancy — the load-bearing test. `requestTaskCancellation` calls
// `reconcileParallelSlots` (which opens its OWN kernel.mutate) only AFTER its own
// mutate block has closed, and fires the detached `startWorkerCancellation` chain
// outside the critical section too. `kernel.mutate` is non-reentrant: an
// AsyncLocalStorage guard throws `/nested mutate/` immediately on a nested call.
//
// The running-task path exercises the outside-mutate `startWorkerCancellation` call;
// the non-running (blocked) path exercises the synchronous outside-mutate
// `reconcileParallelSlots` call. If someone later moves either inside the mutate, this
// test throws `/nested mutate/` and NAMES the failure rather than hanging.
test("requestTaskCancellation resolves without a nested-mutate throw", async () => {
  const initialState = createEmptyState();
  const runningTask: OrchestrationTaskRecord = {
    taskId: "run-1",
    sourceHandle: "worker:w1",
    sourceKind: "worker",
    coordinatorSession: "coord-1",
    workspace: "backend",
    targetAgent: "codex",
    task: "long running work",
    status: "running",
    summary: "",
    resultText: "",
    createdAt: "2026-04-13T09:00:00.000Z",
    updatedAt: "2026-04-13T09:00:00.000Z",
  };
  const blockedTask: OrchestrationTaskRecord = {
    taskId: "blk-1",
    sourceHandle: "worker:w2",
    sourceKind: "worker",
    coordinatorSession: "coord-1",
    workspace: "backend",
    targetAgent: "codex",
    task: "waiting on a blocker",
    status: "blocked",
    summary: "",
    resultText: "",
    createdAt: "2026-04-13T09:00:00.000Z",
    updatedAt: "2026-04-13T09:00:00.000Z",
  };
  initialState.orchestration.tasks[runningTask.taskId] = runningTask;
  initialState.orchestration.tasks[blockedTask.taskId] = blockedTask;

  const harness = makeGoldenHarness({ initialState });
  const kernel = new OrchestrationStateKernel({ logger: harness.deps.logger });
  const workerSessions = new WorkerSessionManager(harness.deps, kernel);
  const questionFlow = new QuestionFlowCore(harness.deps, kernel);
  const cancellation = new TaskCancellationService(
    {
      now: harness.deps.now,
      createId: harness.deps.createId,
      loadState: harness.deps.loadState,
      saveState: harness.deps.saveState,
      cancelWorkerTask: harness.deps.cancelWorkerTask,
      interruptWorkerTask: harness.deps.interruptWorkerTask,
      wakeCoordinatorSession: harness.deps.wakeCoordinatorSession,
    },
    kernel,
    workerSessions,
    questionFlow,
  );

  // Running task: marks cancel-requested and fires the detached worker cancellation.
  const running = await cancellation.requestTaskCancellation({
    taskId: "run-1",
    coordinatorSession: "coord-1",
  });
  expect(running.status).toBe("running");
  expect(running.cancelRequestedAt).toBe("2026-04-13T10:00:00.000Z");

  // Blocked task: transitions straight to cancelled and synchronously calls
  // reconcileParallelSlots OUTSIDE the mutate.
  const blocked = await cancellation.requestTaskCancellation({
    taskId: "blk-1",
    coordinatorSession: "coord-1",
  });
  expect(blocked.status).toBe("cancelled");

  // Asserting only that the call above *resolves* would prove nothing. The reconcile
  // call sits inside a try/catch that swallows the error and logs it, so moving
  // reconcile inside the mutate makes the kernel's reentrancy guard throw, the catch
  // eat the throw, and this method return `cancelled` exactly as it does now.
  //
  // The swallowed throw is visible in one place: the failure log. Assert it never
  // fired. Verified by mutation -- wrapping the reconcile call in a kernel.mutate()
  // turns this assertion, and nothing else in this file, red.
  const reconcileFailures = harness.calls.filter(
    (call) =>
      call.port.startsWith("logger.") &&
      (call.request as { event?: string }).event === "orchestration.parallel.reconcile_failed",
  );
  expect(reconcileFailures).toEqual([]);
});
