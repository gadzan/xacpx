import { expect, test } from "bun:test";

import { OrchestrationStateKernel } from "../../../../src/orchestration/service/orchestration-state-kernel";
import { QuestionFlowCore } from "../../../../src/orchestration/service/question-flow-core";
import { TaskApprovalService } from "../../../../src/orchestration/service/task-approval-service";
import { TaskLifecycleService } from "../../../../src/orchestration/service/task-lifecycle-service";
import { WorkerSessionManager } from "../../../../src/orchestration/service/worker-session-manager";
import type { OrchestrationTaskRecord } from "../../../../src/orchestration/orchestration-types";
import { createEmptyState } from "../../../../src/state/types";
import { makeGoldenHarness } from "../golden/golden-harness";

// Construct the service from a bare object literal of exactly its seven ports — never
// `harness.deps` wholesale — plus the kernel and its three collaborators. This is the
// isolation-testability deliverable of the split: the service must build without
// `config`, `wakeCoordinatorSession`, or the other ports, and it must
// not silently reach for a dep outside its declared TaskApprovalDeps.
function makeService(initialState = createEmptyState()) {
  const harness = makeGoldenHarness({ endpointIds: ["worker-endpoint-1"], initialState });
  const kernel = new OrchestrationStateKernel({ logger: harness.deps.logger });
  const workerSessions = new WorkerSessionManager(harness.deps, kernel);
  const questionFlow = new QuestionFlowCore(harness.deps, kernel);
  const lifecycle = new TaskLifecycleService(harness.deps, kernel);
  const approvals = new TaskApprovalService(
    {
      now: harness.deps.now,
      createId: harness.deps.createId,
      createAgentEndpointId: harness.deps.createAgentEndpointId,
      loadState: harness.deps.loadState,
      saveState: harness.deps.saveState,
      dispatchWorkerTask: harness.deps.dispatchWorkerTask,
      resolveWorkerBindingEngine: harness.deps.resolveWorkerBindingEngine,
    },
    kernel,
    workerSessions,
    questionFlow,
    lifecycle,
  );
  return { harness, approvals };
}

function seedTask(overrides: Partial<OrchestrationTaskRecord> = {}): OrchestrationTaskRecord {
  return {
    taskId: "t1",
    sourceHandle: "wx:user-1",
    sourceKind: "human",
    coordinatorSession: "coord-1",
    workerSession: "backend:codex:coord-1",
    workspace: "backend",
    targetAgent: "codex",
    task: "do the thing",
    status: "needs_confirmation",
    summary: "",
    resultText: "",
    createdAt: "2026-04-13T09:00:00.000Z",
    updatedAt: "2026-04-13T09:00:00.000Z",
    ...overrides,
  };
}
test("constructible with only its six ports and approves a needs_confirmation task", async () => {
  const initialState = createEmptyState();
  const seeded = seedTask();
  initialState.orchestration.tasks[seeded.taskId] = seeded;
  const { harness, approvals } = makeService(initialState);

  const approved = await approvals.approveTask({
    taskId: "t1",
    coordinatorSession: "coord-1",
  });

  expect(approved.status).toBe("running");
  expect(approved.workerSession).toBe("backend:codex:coord-1");
  const persisted = harness.getState().orchestration.tasks["t1"];
  expect(persisted.status).toBe("running");
  expect(
    harness.getState().orchestration.workerBindings[persisted.workerSession!]?.agentEndpointId,
  ).toBe("endpoint_worker-endpoint-1");
  expect(harness.calls.some((call) => call.port === "dispatchWorkerTask")).toBe(true);
});

test("approveTask rejects a task that is not awaiting confirmation", async () => {
  const initialState = createEmptyState();
  const seeded = seedTask({ status: "running" });
  initialState.orchestration.tasks[seeded.taskId] = seeded;
  const { approvals } = makeService(initialState);

  await expect(
    approvals.approveTask({ taskId: "t1", coordinatorSession: "coord-1" }),
  ).rejects.toThrow('task "t1" is running, not needs_confirmation');
});
