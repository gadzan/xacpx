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

test("constructible with only its six ports, and resolves the awaited active package", async () => {
  // Asserting `null` against an empty state proves nothing -- a method that constantly
  // returns `null` passes. Seed a live package whose `awaitingReplyMessageId` points at the
  // *first* of two messages, so the assertion also pins that the awaited message wins over
  // the `messages.at(-1)` fallback.
  //
  // getActiveHumanQuestionPackage is the only method of the eight that opens no kernel.mutate.
  const initialState = createEmptyState();
  initialState.orchestration.coordinatorQuestionState["coord-1"] = {
    activePackageId: "pkg-1",
    queuedQuestions: [],
  };
  initialState.orchestration.humanQuestionPackages["pkg-1"] = {
    packageId: "pkg-1",
    coordinatorSession: "coord-1",
    status: "active",
    createdAt: "2026-04-13T09:00:00.000Z",
    updatedAt: "2026-04-13T09:00:00.000Z",
    initialTaskIds: [],
    openTaskIds: [],
    resolvedTaskIds: [],
    awaitingReplyMessageId: "msg-1",
    messages: [
      { messageId: "msg-1", kind: "initial", promptText: "which db?", createdAt: "2026-04-13T09:00:00.000Z" },
      { messageId: "msg-2", kind: "follow_up", promptText: "never asked", createdAt: "2026-04-13T09:30:00.000Z" },
    ],
  };

  const { humanQuestions } = makeService(initialState);

  const active = await humanQuestions.getActiveHumanQuestionPackage("coord-1");
  expect(active?.packageId).toBe("pkg-1");
  expect(active?.awaitingReplyMessageId).toBe("msg-1");
  expect(active?.promptText).toBe("which db?");

  expect(await humanQuestions.getActiveHumanQuestionPackage("coord-unknown")).toBeNull();
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

test("active-message fallback prefers the last DELIVERED message over a later failed one (#151)", async () => {
  // awaitingReplyMessageId is absent. msg-2 (the last message) FAILED delivery (no deliveredAt);
  // msg-1 was delivered. The active message must be msg-1, not the undelivered msg-2.
  const initialState = createEmptyState();
  initialState.orchestration.coordinatorQuestionState["coord-1"] = {
    activePackageId: "pkg-1",
    queuedQuestions: [],
  };
  initialState.orchestration.humanQuestionPackages["pkg-1"] = {
    packageId: "pkg-1",
    coordinatorSession: "coord-1",
    status: "active",
    createdAt: "2026-04-13T09:00:00.000Z",
    updatedAt: "2026-04-13T09:00:00.000Z",
    initialTaskIds: [],
    openTaskIds: [],
    resolvedTaskIds: [],
    messages: [
      { messageId: "msg-1", kind: "initial", promptText: "delivered one", createdAt: "2026-04-13T09:00:00.000Z", deliveredAt: "2026-04-13T09:00:01.000Z" },
      { messageId: "msg-2", kind: "follow_up", promptText: "failed one", createdAt: "2026-04-13T09:30:00.000Z" },
    ],
  };
  const { humanQuestions } = makeService(initialState);
  const active = await humanQuestions.getActiveHumanQuestionPackage("coord-1");
  expect(active?.promptText).toBe("delivered one");
});

test("active-message fallback returns the last message when NOTHING is delivered yet (#151 edge)", async () => {
  const initialState = createEmptyState();
  initialState.orchestration.coordinatorQuestionState["coord-2"] = {
    activePackageId: "pkg-2",
    queuedQuestions: [],
  };
  initialState.orchestration.humanQuestionPackages["pkg-2"] = {
    packageId: "pkg-2",
    coordinatorSession: "coord-2",
    status: "active",
    createdAt: "2026-04-13T09:00:00.000Z",
    updatedAt: "2026-04-13T09:00:00.000Z",
    initialTaskIds: [],
    openTaskIds: [],
    resolvedTaskIds: [],
    messages: [
      { messageId: "m1", kind: "initial", promptText: "pending, not delivered", createdAt: "2026-04-13T09:00:00.000Z" },
    ],
  };
  const { humanQuestions } = makeService(initialState);
  const active = await humanQuestions.getActiveHumanQuestionPackage("coord-2");
  expect(active?.promptText).toBe("pending, not delivered"); // last resort: not hidden
});
