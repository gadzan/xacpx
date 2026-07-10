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
import { makeGoldenHarness } from "../golden/golden-harness";

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
