import { expect, test } from "bun:test";

import { GroupService } from "../../../../src/orchestration/service/group-service";
import { OrchestrationStateKernel } from "../../../../src/orchestration/service/orchestration-state-kernel";
import { QuestionFlowCore } from "../../../../src/orchestration/service/question-flow-core";
import { TaskCancellationService } from "../../../../src/orchestration/service/task-cancellation-service";
import { WorkerSessionManager } from "../../../../src/orchestration/service/worker-session-manager";
import type {
  OrchestrationGroupRecord,
  OrchestrationTaskRecord,
} from "../../../../src/orchestration/orchestration-types";
import { createEmptyState } from "../../../../src/state/types";
import { makeGoldenHarness, type GoldenHarness } from "../golden/golden-harness";

// Construct the service from a bare object literal of exactly its five ports — never
// `harness.deps` wholesale — plus the kernel and a TaskCancellationService collaborator.
// This is the isolation-testability deliverable of the split: GroupService must build
// without dispatchWorkerTask, wakeCoordinatorSession, or the other facade ports.
test("constructible with only its five ports and persists a created group", async () => {
  const harness = makeGoldenHarness();
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

  const groups = new GroupService(
    {
      now: harness.deps.now,
      createId: harness.deps.createId,
      loadState: harness.deps.loadState,
      saveState: harness.deps.saveState,
      config: harness.deps.config,
    },
    kernel,
    cancellation,
  );

  const group = await groups.createGroup({ coordinatorSession: "coord-1", title: "  Ship it  " });
  expect(group.groupId).toBe("id-1");
  expect(group.coordinatorSession).toBe("coord-1");
  expect(group.title).toBe("Ship it");
  expect(group.createdAt).toBe("2026-04-13T10:00:00.000Z");
  expect(group.updatedAt).toBe("2026-04-13T10:00:00.000Z");

  const persisted = harness.getState().orchestration.groups["id-1"];
  expect(persisted).toBeDefined();
  expect(persisted!.coordinatorSession).toBe("coord-1");
  expect(persisted!.title).toBe("Ship it");
});

// Behaviour: drive listGroupSummaries against a seeded group whose tasks span both
// terminal (completed) and non-terminal (running / needs_confirmation) statuses, and
// assert the summary's counts and terminal flag that buildGroupSummary computes.
test("summarizes a group with mixed terminal and non-terminal tasks", async () => {
  const initialState = createEmptyState();

  const group: OrchestrationGroupRecord = {
    groupId: "g1",
    coordinatorSession: "coord-1",
    title: "Mixed group",
    createdAt: "2026-04-13T09:00:00.000Z",
    updatedAt: "2026-04-13T09:00:00.000Z",
  };
  initialState.orchestration.groups[group.groupId] = group;

  const makeTask = (
    taskId: string,
    status: OrchestrationTaskRecord["status"],
  ): OrchestrationTaskRecord => ({
    taskId,
    sourceHandle: "worker:w1",
    sourceKind: "worker",
    coordinatorSession: "coord-1",
    workspace: "backend",
    targetAgent: "codex",
    task: "do the thing",
    status,
    summary: "",
    resultText: "",
    groupId: "g1",
    createdAt: "2026-04-13T09:00:00.000Z",
    updatedAt: "2026-04-13T09:00:00.000Z",
  });

  initialState.orchestration.tasks["t-run"] = makeTask("t-run", "running");
  initialState.orchestration.tasks["t-conf"] = makeTask("t-conf", "needs_confirmation");
  initialState.orchestration.tasks["t-done"] = makeTask("t-done", "completed");

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

  const groups = new GroupService(
    {
      now: harness.deps.now,
      createId: harness.deps.createId,
      loadState: harness.deps.loadState,
      saveState: harness.deps.saveState,
      config: harness.deps.config,
    },
    kernel,
    cancellation,
  );

  const summaries = await groups.listGroupSummaries({ coordinatorSession: "coord-1" });
  expect(summaries.length).toBe(1);
  const summary = summaries[0]!;
  expect(summary.totalTasks).toBe(3);
  expect(summary.runningTasks).toBe(1);
  expect(summary.completedTasks).toBe(1);
  expect(summary.pendingApprovalTasks).toBe(1);
  expect(summary.terminal).toBe(false);
});

// Local copies — the frozen golden harness exports only its `makeGoldenHarness` factory and the
// `GoldenHarness` type (it must stay byte-identical as a regression oracle, so it carries no test
// helpers). These drain the detached worker-cancellation chains a cancelGroup fires.
async function waitForLogEvent(harness: GoldenHarness, eventName: string, afterIndex: number): Promise<void> {
  for (let i = 0; i < 40; i += 1) {
    if (
      harness.calls.slice(afterIndex).some(
        (c) => c.port.startsWith("logger.") && (c.request as { event?: unknown } | null)?.event === eventName,
      )
    ) return;
    await Bun.sleep(0);
  }
  throw new Error(`waitForLogEvent timed out waiting for "${eventName}"`);
}

async function waitForPort(
  harness: GoldenHarness,
  port: string,
  match: (request: unknown) => boolean,
): Promise<void> {
  for (let i = 0; i < 40; i += 1) {
    if (harness.calls.some((c) => c.port === port && match(c.request))) return;
    await Bun.sleep(0);
  }
  throw new Error(`waitForPort timed out waiting for "${port}"`);
}

test("cancelGroup logs group.cancelled BEFORE dispatching any worker-cancellation chain (#150)", async () => {
  const initialState = createEmptyState();
  initialState.orchestration.groups["g1"] = {
    groupId: "g1",
    coordinatorSession: "backend:coordinator",
    title: "T",
    createdAt: "2026-04-13T09:00:00.000Z",
    updatedAt: "2026-04-13T09:00:00.000Z",
  };
  initialState.orchestration.tasks["t-run"] = {
    taskId: "t-run",
    sourceHandle: "worker:w1",
    sourceKind: "worker",
    coordinatorSession: "backend:coordinator",
    workspace: "backend",
    targetAgent: "codex",
    task: "do the thing",
    status: "running",
    summary: "",
    resultText: "",
    groupId: "g1",
    workerSession: "w1-session", // assigned worker → cancellation propagates a detached chain
    createdAt: "2026-04-13T09:00:00.000Z",
    updatedAt: "2026-04-13T09:00:00.000Z",
  };

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
  const groups = new GroupService(
    {
      now: harness.deps.now,
      createId: harness.deps.createId,
      loadState: harness.deps.loadState,
      saveState: harness.deps.saveState,
      config: harness.deps.config,
    },
    kernel,
    cancellation,
  );

  // Observe the invariant AT THE CALL SITE: capture, at the first startWorkerCancellation, whether
  // group.cancelled is already logged. This is what kills the "move the dispatch loop before the
  // log" mutation — the downstream cancelWorkerTask port fires several awaits deep in the detached
  // chain, so its position relative to the log is unchanged by moving the (synchronous) dispatch
  // call, leaving that assertion mutation-blind.
  let groupCancelledLoggedAtFirstDispatch = -1;
  const realStart = cancellation.startWorkerCancellation.bind(cancellation);
  cancellation.startWorkerCancellation = (task) => {
    if (groupCancelledLoggedAtFirstDispatch === -1) {
      groupCancelledLoggedAtFirstDispatch = harness.calls.filter(
        (c) =>
          c.port.startsWith("logger.") &&
          (c.request as { event?: unknown } | null)?.event === "orchestration.group.cancelled",
      ).length;
    }
    return realStart(task);
  };

  const before = harness.calls.length;
  await groups.cancelGroup({ groupId: "g1", coordinatorSession: "backend:coordinator" });
  await waitForLogEvent(harness, "orchestration.task.cancel_completed", before); // drain the detached chain

  // group.cancelled was already in the log when the first chain STARTED (0 ⇒ dispatch ran first).
  expect(groupCancelledLoggedAtFirstDispatch).toBe(1);

  // (Kept as a smoke check) the downstream cancelWorkerTask port also lands after the log.
  const window = harness.calls.slice(before);
  const groupCancelledIdx = window.findIndex(
    (c) => c.port.startsWith("logger.") && (c.request as { event?: unknown } | null)?.event === "orchestration.group.cancelled",
  );
  const dispatchIdx = window.findIndex((c) => c.port === "cancelWorkerTask");
  expect(groupCancelledIdx).toBeGreaterThanOrEqual(0);
  expect(dispatchIdx).toBeGreaterThan(groupCancelledIdx); // dispatch deferred until AFTER the log — provable, not hop-luck
});

test("cancelGroup propagates an already-committed cancellation even when a later task's save fails, and a retry finishes the rest (#150)", async () => {
  // Regression: cancelGroup commits each task's cancel-request in its own atomic save, then
  // (before #150's fix) fired all worker-cancellation chains in a single batch AFTER the loop. If
  // a later task's save threw, an earlier task was already persisted as cancel-requested but its
  // chain never fired — and a retry sees `shouldPropagate === false` for it (already requested),
  // so it would be stranded, worker never cancelled. The `finally`-dispatch guarantees the
  // committed task's chain fires on THIS attempt; the retry then only needs to finish the rest.
  const createdAt = "2026-04-13T09:00:00.000Z";
  const initialState = createEmptyState();
  initialState.orchestration.groups["g1"] = {
    groupId: "g1",
    coordinatorSession: "backend:coordinator",
    title: "T",
    createdAt,
    updatedAt: createdAt,
  };
  for (const id of ["t1", "t2"]) {
    initialState.orchestration.tasks[id] = {
      taskId: id,
      sourceHandle: `worker:${id}`,
      sourceKind: "worker",
      coordinatorSession: "backend:coordinator",
      workspace: "backend",
      targetAgent: "codex",
      task: "do the thing",
      status: "running",
      summary: "",
      resultText: "",
      groupId: "g1",
      workerSession: `${id}-session`, // assigned worker → cancellation propagates a detached chain
      createdAt,
      updatedAt: createdAt,
    };
  }

  const harness = makeGoldenHarness({ initialState });

  // Fail the 2nd saveState of the run — that is t2's apply commit (t1's apply is save #1). The
  // failing save never delegates to the harness, so t2 stays un-persisted (as a real failed save
  // would). Set to null to heal for the retry.
  let saveCalls = 0;
  let failAtSave: number | null = 2;
  const saveState = async (next: Parameters<typeof harness.deps.saveState>[0]) => {
    saveCalls += 1;
    if (failAtSave !== null && saveCalls === failAtSave) {
      throw new Error("simulated save failure");
    }
    await harness.deps.saveState(next);
  };

  const kernel = new OrchestrationStateKernel({ logger: harness.deps.logger });
  const workerSessions = new WorkerSessionManager({ ...harness.deps, saveState }, kernel);
  const questionFlow = new QuestionFlowCore({ ...harness.deps, saveState }, kernel);
  const cancellation = new TaskCancellationService(
    {
      now: harness.deps.now,
      createId: harness.deps.createId,
      loadState: harness.deps.loadState,
      saveState,
      cancelWorkerTask: harness.deps.cancelWorkerTask,
      interruptWorkerTask: harness.deps.interruptWorkerTask,
      wakeCoordinatorSession: harness.deps.wakeCoordinatorSession,
    },
    kernel,
    workerSessions,
    questionFlow,
  );
  const groups = new GroupService(
    {
      now: harness.deps.now,
      createId: harness.deps.createId,
      loadState: harness.deps.loadState,
      saveState,
      config: harness.deps.config,
    },
    kernel,
    cancellation,
  );

  // Attempt 1: t2's save throws → cancelGroup rejects, but t1 was committed and must still be
  // dispatched by the finally (waitForPort would time out under the pre-fix batching).
  await expect(
    groups.cancelGroup({ groupId: "g1", coordinatorSession: "backend:coordinator" }),
  ).rejects.toThrow("simulated save failure");
  await waitForPort(harness, "cancelWorkerTask", (r) => (r as { taskId?: string }).taskId === "t1");

  // Retry with saves healthy: t1 is already cancel-requested (not re-fired), t2 now completes.
  failAtSave = null;
  await groups.cancelGroup({ groupId: "g1", coordinatorSession: "backend:coordinator" });
  await waitForPort(harness, "cancelWorkerTask", (r) => (r as { taskId?: string }).taskId === "t2");

  const cancelledWorkers = new Set(
    harness.calls
      .filter((c) => c.port === "cancelWorkerTask")
      .map((c) => (c.request as { taskId: string }).taskId),
  );
  expect(cancelledWorkers).toEqual(new Set(["t1", "t2"]));
});
