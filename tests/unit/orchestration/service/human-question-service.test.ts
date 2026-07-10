import { expect, test } from "bun:test";

import { HumanQuestionService } from "../../../../src/orchestration/service/human-question-service";
import { OrchestrationStateKernel } from "../../../../src/orchestration/service/orchestration-state-kernel";
import { QuestionFlowCore } from "../../../../src/orchestration/service/question-flow-core";
import { TaskCancellationService } from "../../../../src/orchestration/service/task-cancellation-service";
import { WorkerSessionManager } from "../../../../src/orchestration/service/worker-session-manager";
import type { OrchestrationTaskRecord } from "../../../../src/orchestration/orchestration-types";
import { createEmptyState } from "../../../../src/state/types";
import { makeGoldenHarness } from "../golden/golden-harness";

// Construct the service from a bare object literal of exactly its six ports — never
// `harness.deps` wholesale — plus the kernel and its three collaborators. This is the
// isolation-testability deliverable of the split: the service must build without
// `deliverCoordinatorMessage`, `dispatchWorkerTask`, or the other ten ports, and it must
// not silently reach for a dep outside its declared HumanQuestionDeps.
function makeService(initialState = createEmptyState()) {
  const harness = makeGoldenHarness({ initialState });
  const kernel = new OrchestrationStateKernel({ logger: harness.deps.logger });
  const workerSessions = new WorkerSessionManager(harness.deps, kernel);
  const questionFlow = new QuestionFlowCore(harness.deps, kernel);
  const cancellation = new TaskCancellationService(harness.deps, kernel, workerSessions, questionFlow);
  const humanQuestions = new HumanQuestionService(
    {
      now: harness.deps.now,
      createId: harness.deps.createId,
      loadState: harness.deps.loadState,
      saveState: harness.deps.saveState,
      resumeWorkerTask: harness.deps.resumeWorkerTask,
      wakeCoordinatorSession: harness.deps.wakeCoordinatorSession,
    },
    kernel,
    workerSessions,
    questionFlow,
    cancellation,
  );
  return { harness, humanQuestions };
}

test("constructible with only its six ports and returns null for an empty active package", async () => {
  const { humanQuestions } = makeService();

  // getActiveHumanQuestionPackage is the only method that opens no kernel.mutate.
  const result = await humanQuestions.getActiveHumanQuestionPackage("coord-1");
  expect(result).toBeNull();
});

// The four-way compound guard in coordinatorReviewContestedResult re-arms the pending
// notice only when noticeSentAt === undefined. That sub-case — a notice already sent, so
// noticePending must NOT be re-armed — is pinned by nothing else in the suite. Seed an
// accepted contested result on a completed task with chatKey + replyContextToken set, and
// drive both sides of the noticeSentAt sub-case.
function seedContestedTask(overrides: Partial<OrchestrationTaskRecord> = {}): OrchestrationTaskRecord {
  return {
    taskId: "t1",
    sourceHandle: "worker:w1",
    sourceKind: "worker",
    coordinatorSession: "coord-1",
    workerSession: "worker:w1",
    workspace: "backend",
    targetAgent: "codex",
    task: "do the thing",
    status: "completed",
    summary: "done",
    resultText: "the result",
    createdAt: "2026-04-13T09:00:00.000Z",
    updatedAt: "2026-04-13T09:00:00.000Z",
    chatKey: "wx:owner",
    replyContextToken: "ctx-token",
    reviewPending: {
      reviewId: "rev-1",
      reason: "misrouted_answer",
      createdAt: "2026-04-13T09:30:00.000Z",
      resultId: "res-1",
      resultText: "the result",
    },
    ...overrides,
  };
}

test("accepting a contested result re-arms noticePending when no notice was sent", async () => {
  const initialState = createEmptyState();
  const seeded = seedContestedTask();
  initialState.orchestration.tasks[seeded.taskId] = seeded;
  const { harness, humanQuestions } = makeService(initialState);

  const result = await humanQuestions.coordinatorReviewContestedResult({
    coordinatorSession: "coord-1",
    taskId: "t1",
    reviewId: "rev-1",
    decision: "accept",
  });

  expect(result.noticePending).toBe(true);
  const persisted = harness.getState().orchestration.tasks["t1"];
  expect(persisted.noticePending).toBe(true);
  expect(persisted.noticeSentAt).toBeUndefined();
});

test("accepting a contested result does not re-arm noticePending when a notice was already sent", async () => {
  const initialState = createEmptyState();
  const seeded = seedContestedTask({ noticeSentAt: "2026-04-13T09:45:00.000Z" });
  initialState.orchestration.tasks[seeded.taskId] = seeded;
  const { harness, humanQuestions } = makeService(initialState);

  const result = await humanQuestions.coordinatorReviewContestedResult({
    coordinatorSession: "coord-1",
    taskId: "t1",
    reviewId: "rev-1",
    decision: "accept",
  });

  expect(result.noticePending).toBeFalsy();
  expect(result.noticeSentAt).toBe("2026-04-13T09:45:00.000Z");
  const persisted = harness.getState().orchestration.tasks["t1"];
  expect(persisted.noticePending).toBeFalsy();
  expect(persisted.noticeSentAt).toBe("2026-04-13T09:45:00.000Z");
});
