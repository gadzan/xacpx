// src/orchestration/service/human-question-service.ts
// Human-question state machine: the coordinatorAnswerQuestion <-> workerRaiseQuestion
// loop plus the human-input package lifecycle (request, retry delivery, claim reply,
// read active package, and contested-result review). The largest leaf service; its eight
// methods share the coordinator/worker question state and splitting further would only
// add round trips. Takes three collaborators (WorkerSessionManager, QuestionFlowCore,
// TaskCancellationService) plus the kernel.
//
// Two calls run OUTSIDE the kernel's non-reentrant `mutate`:
//   - coordinatorReviewContestedResult ends with `this.workerSessions.reconcileParallelSlots()`
//     (reconcile opens its own mutate; nesting it would throw on every accepted review).
//   - coordinatorRetractAnswer fires a bare, unawaited `this.cancellation.startWorkerCancellation(...)`
//     detached chain whose interleaving the golden fixtures pin.
// Both point straight at their collaborator — routing them through a facade delegation
// would add a microtask hop and reorder the detached chain against the synchronous log.
import { sameCoordinatorSession, stableCoordinatorSession } from "../coordinator-identity";
import type {
  OrchestrationHumanQuestionPackageRecord,
  OrchestrationTaskRecord,
} from "../orchestration-types";
import type {
  ActiveHumanQuestionPackage,
  ClaimedActiveHumanReply,
  CoordinatorRequestHumanInputResult,
  CoordinatorTaskQuestionRef,
  FrozenCoordinatorDeliveryRoute,
  OrchestrationServiceDeps,
  RetryHumanQuestionPackageDeliveryResult,
  WorkerRaiseQuestionInput,
} from "../orchestration-service";
import type { OrchestrationStateKernel } from "./orchestration-state-kernel";
import type { QuestionFlowCore } from "./question-flow-core";
import type { TaskCancellationService } from "./task-cancellation-service";
import type { WorkerSessionManager } from "./worker-session-manager";

export type HumanQuestionDeps = Pick<
  OrchestrationServiceDeps,
  "now" | "createId" | "loadState" | "saveState" | "resumeWorkerTask" | "wakeCoordinatorSession"
>;

export class HumanQuestionService {
  constructor(
    private readonly deps: HumanQuestionDeps,
    private readonly kernel: OrchestrationStateKernel,
    private readonly workerSessions: WorkerSessionManager,
    private readonly questionFlow: QuestionFlowCore,
    private readonly cancellation: TaskCancellationService,
  ) {}

  async workerRaiseQuestion(
    input: WorkerRaiseQuestionInput,
  ): Promise<{ taskId: string; questionId: string; status: "blocked" }> {
    if (input.taskId.trim().length === 0) {
      throw new Error("taskId must be a non-empty string");
    }
    if (input.sourceHandle.trim().length === 0) {
      throw new Error("sourceHandle must be a non-empty string");
    }
    if (input.question.trim().length === 0) {
      throw new Error("question must be a non-empty string");
    }
    if (input.whyBlocked.trim().length === 0) {
      throw new Error("whyBlocked must be a non-empty string");
    }
    if (input.whatIsNeeded.trim().length === 0) {
      throw new Error("whatIsNeeded must be a non-empty string");
    }

    const prepared = await this.kernel.mutate(async () => {
      const state = await this.deps.loadState();
      const task = state.orchestration.tasks[input.taskId];
      if (!task) {
        throw new Error(`task "${input.taskId}" does not exist`);
      }
      if (!task.workerSession) {
        throw new Error(`task "${input.taskId}" does not have an assigned worker session`);
      }
      if (task.workerSession !== input.sourceHandle) {
        throw new Error(`task "${input.taskId}" belongs to worker "${task.workerSession}", not "${input.sourceHandle}"`);
      }
      if (task.status !== "running") {
        throw new Error(`task "${input.taskId}" is ${task.status}, not running`);
      }
      if (task.openQuestion?.status === "open") {
        throw new Error(`task "${input.taskId}" already has an open question`);
      }

      const now = this.deps.now().toISOString();
      const questionId = this.deps.createId();
      task.status = "blocked";
      task.openQuestion = {
        questionId,
        question: input.question.trim(),
        whyBlocked: input.whyBlocked.trim(),
        whatIsNeeded: input.whatIsNeeded.trim(),
        askedAt: now,
        status: "open",
      };
      task.updatedAt = now;
      this.kernel.appendTaskEvent(task, now, "attention_required", {
        status: "blocked",
        message: input.question.trim(),
      });
      this.kernel.bumpGroupUpdated(state, task.groupId, now);
      await this.deps.saveState(state);

      return {
        taskId: task.taskId,
        questionId,
        coordinatorSession: task.coordinatorSession,
        externalCoordinator: this.kernel.isExternalCoordinatorSession(state, task.coordinatorSession),
      };
    });

    try {
      if (!prepared.externalCoordinator) {
        await this.deps.wakeCoordinatorSession?.({
          coordinatorSession: prepared.coordinatorSession,
        });
      }
    } catch (error) {
      await this.questionFlow.recordOpenQuestionWakeError(
        prepared.taskId,
        prepared.questionId,
        error instanceof Error ? error.message : String(error),
      );
    }

    return {
      taskId: prepared.taskId,
      questionId: prepared.questionId,
      status: "blocked",
    };
  }

  async coordinatorAnswerQuestion(input: {
    coordinatorSession: string;
    taskId: string;
    questionId: string;
    answer: string;
  }): Promise<OrchestrationTaskRecord> {
    const answer = input.answer.trim();
    if (answer.length === 0) {
      throw new Error("answer must be a non-empty string");
    }

    const prepared = await this.kernel.mutate(async () => {
      const state = await this.deps.loadState();
      const task = state.orchestration.tasks[input.taskId];
      if (!task) {
        throw new Error(`task "${input.taskId}" does not exist`);
      }

      this.questionFlow.assertCoordinatorOwnership(task, input.coordinatorSession);
      if (task.status !== "blocked" && task.status !== "waiting_for_human") {
        throw new Error(`task "${input.taskId}" is ${task.status}, not blocked or waiting_for_human`);
      }
      this.questionFlow.assertCoordinatorQuestionMatch(task, input.questionId);
      this.questionFlow.assertTaskAnswerIsWithinAwaitedHumanSnapshot(state, task, input.questionId);
      if (!task.workerSession) {
        throw new Error(`task "${input.taskId}" does not have an assigned worker session`);
      }

      const now = this.deps.now().toISOString();
      const packageRestore = this.questionFlow.captureTaskHumanPackageContext(state, task);
      this.questionFlow.resolveTaskFromHumanPackage(state, task, now);
      task.status = "running";
      task.openQuestion = {
        ...task.openQuestion!,
        status: "answered",
        answeredAt: now,
        answerSource: "coordinator",
        answerText: answer,
        lastResumeError: undefined,
      };
      task.updatedAt = now;
      this.kernel.appendTaskEvent(task, now, "status_changed", {
        status: "running",
        message: "Blocker question answered",
      });
      this.kernel.bumpGroupUpdated(state, task.groupId, now);
      await this.deps.saveState(state);

      return {
        task: { ...task },
        packageRestore,
        closedPackageId:
          packageRestore && packageRestore.packageRecord.openTaskIds.includes(task.taskId)
            && packageRestore.packageRecord.openTaskIds.length === 1
            ? packageRestore.packageId
            : undefined,
      };
    });

    try {
      await this.deps.resumeWorkerTask?.({
        taskId: prepared.task.taskId,
        workerSession: prepared.task.workerSession!,
        coordinatorSession: prepared.task.coordinatorSession,
        workspace: prepared.task.workspace,
        ...(prepared.task.cwd ? { cwd: prepared.task.cwd } : {}),
        targetAgent: prepared.task.targetAgent,
        answer,
      });
    } catch (error) {
      await this.questionFlow.restoreBlockedQuestionAfterResumeFailure(
        prepared.task.taskId,
        input.questionId,
        error instanceof Error ? error.message : String(error),
        prepared.packageRestore,
      );
      throw error;
    }

    if (prepared.closedPackageId) {
      await this.questionFlow.handoffQueuedQuestions(prepared.task.coordinatorSession, prepared.closedPackageId);
    }

    return prepared.task;
  }

  async coordinatorRetractAnswer(input: {
    coordinatorSession: string;
    taskId: string;
    questionId: string;
  }): Promise<OrchestrationTaskRecord> {
    const prepared = await this.kernel.mutate(async () => {
      const state = await this.deps.loadState();
      const task = state.orchestration.tasks[input.taskId];
      if (!task) {
        throw new Error(`task "${input.taskId}" does not exist`);
      }

      this.questionFlow.assertCoordinatorOwnership(task, input.coordinatorSession);
      const openQuestion = task.openQuestion;
      if (!openQuestion) {
        throw new Error(`task "${input.taskId}" does not have an open question`);
      }
      if (openQuestion.questionId !== input.questionId) {
        throw new Error(`task "${task.taskId}" open question is "${openQuestion.questionId}", not "${input.questionId}"`);
      }
      if (openQuestion.status !== "answered") {
        throw new Error(`task "${input.taskId}" question "${input.questionId}" is not answered`);
      }

      const now = this.deps.now().toISOString();
      if (task.status === "running") {
        const shouldPropagate = task.correctionPending === undefined;
        task.correctionPending = task.correctionPending ?? {
          requestedAt: now,
          reason: "misrouted_answer",
        };
        task.cancelRequestedAt = task.cancelRequestedAt ?? now;
        task.updatedAt = now;
        this.kernel.appendTaskEvent(task, now, "cancel_requested", {
          status: task.status,
          message: "Correction requested for misrouted answer",
        });
        this.kernel.bumpGroupUpdated(state, task.groupId, now);
        await this.deps.saveState(state);

        return {
          task: { ...task },
          shouldPropagate,
        };
      }

      if (
        (task.status === "completed" || task.status === "failed") &&
        task.reviewPending === undefined &&
        task.coordinatorInjectedAt === undefined
      ) {
        task.reviewPending = {
          reviewId: this.deps.createId(),
          reason: "misrouted_answer",
          createdAt: now,
          resultId: this.deps.createId(),
          resultText: task.resultText,
        };
        task.noticePending = false;
        task.lastNoticeError = undefined;
        task.updatedAt = now;
        this.kernel.appendTaskEvent(task, now, "attention_required", {
          status: task.status,
          message: "Task result requires contested review",
        });
        this.kernel.bumpGroupUpdated(state, task.groupId, now);
        await this.deps.saveState(state);

        return {
          task: { ...task },
          shouldPropagate: false,
        };
      }

      throw new Error(`task "${input.taskId}" is ${task.status}, not running or contestable`);
    });

    this.kernel.logEvent("orchestration.task.correction_requested", "task answer marked for correction", {
      ...this.kernel.taskContext(prepared.task),
      question_id: input.questionId,
    });

    if (prepared.shouldPropagate) {
      this.cancellation.startWorkerCancellation(prepared.task);
    }

    return prepared.task;
  }

  async coordinatorRequestHumanInput(input: {
    coordinatorSession: string;
    taskQuestions: CoordinatorTaskQuestionRef[];
    promptText: string;
    expectedActivePackageId?: string;
  }): Promise<CoordinatorRequestHumanInputResult> {
    const promptText = input.promptText.trim();
    if (promptText.length === 0) {
      throw new Error("promptText must be a non-empty string");
    }
    if (input.taskQuestions.length === 0) {
      throw new Error("taskQuestions must contain at least one question");
    }

    const prepared = await this.kernel.mutate(async () => {
      const state = await this.deps.loadState();
      if (this.kernel.isExternalCoordinatorSession(state, input.coordinatorSession)) {
        throw new Error("human input routing is not configured for external coordinator");
      }
      const coordinatorState = this.kernel.ensureCoordinatorQuestionState(state, input.coordinatorSession);
      if (input.expectedActivePackageId !== undefined && coordinatorState.activePackageId !== input.expectedActivePackageId) {
        throw new Error(
          `coordinator "${input.coordinatorSession}" active package is "${coordinatorState.activePackageId ?? ""}", not "${input.expectedActivePackageId}"`,
        );
      }

      const tasks = input.taskQuestions.map(({ taskId, questionId }) => {
        const task = state.orchestration.tasks[taskId];
        if (!task) {
          throw new Error(`task "${taskId}" does not exist`);
        }
        this.questionFlow.assertCoordinatorOwnership(task, input.coordinatorSession);
        if (task.status !== "blocked") {
          throw new Error(`task "${taskId}" is ${task.status}, not blocked`);
        }
        this.questionFlow.assertCoordinatorQuestionMatch(task, questionId);
        return task;
      });

      const now = this.deps.now().toISOString();
      const route = this.questionFlow.snapshotCoordinatorDeliveryRoute(
        this.kernel.ensureCoordinatorRoutes(state)[stableCoordinatorSession(input.coordinatorSession)],
      );
      if (coordinatorState.activePackageId) {
        const activePackage = this.kernel.ensureHumanQuestionPackages(state)[coordinatorState.activePackageId];
        if (!activePackage) {
          throw new Error(`active package "${coordinatorState.activePackageId}" does not exist`);
        }

        for (const task of tasks) {
          if (activePackage.openTaskIds.includes(task.taskId)) {
            throw new Error(`task "${task.taskId}" already belongs to active package "${activePackage.packageId}"`);
          }
          if (!coordinatorState.queuedQuestions.some((entry) => entry.taskId === task.taskId && entry.questionId === task.openQuestion!.questionId)) {
            coordinatorState.queuedQuestions.push({
              taskId: task.taskId,
              questionId: task.openQuestion!.questionId,
              enqueuedAt: now,
            });
          }
          task.updatedAt = now;
          this.kernel.bumpGroupUpdated(state, task.groupId, now);
        }

        await this.deps.saveState(state);
        return {
          kind: "queued" as const,
          queuedTaskIds: tasks.map((task) => task.taskId),
        };
      }

      const packageId = this.deps.createId();
      const messageId = this.deps.createId();
      const packageRecord: OrchestrationHumanQuestionPackageRecord = {
        packageId,
        coordinatorSession: input.coordinatorSession,
        status: "active",
        createdAt: now,
        updatedAt: now,
        initialTaskIds: tasks.map((task) => task.taskId),
        openTaskIds: tasks.map((task) => task.taskId),
        resolvedTaskIds: [],
        messages: [
          {
            messageId,
            kind: "initial",
            promptText,
            createdAt: now,
            taskQuestions: tasks.map((task) => ({
              taskId: task.taskId,
              questionId: task.openQuestion!.questionId,
            })),
            ...(route ? this.questionFlow.serializeFrozenDeliveryRoute(route) : {}),
          },
        ],
      };

      for (const task of tasks) {
        task.status = "waiting_for_human";
        task.openQuestion = {
          ...task.openQuestion!,
          packageId,
        };
        task.updatedAt = now;
        this.kernel.appendTaskEvent(task, now, "attention_required", {
          status: "waiting_for_human",
          message: task.openQuestion.question,
        });
        this.kernel.bumpGroupUpdated(state, task.groupId, now);
      }

      this.kernel.ensureHumanQuestionPackages(state)[packageId] = packageRecord;
      coordinatorState.activePackageId = packageId;
      await this.deps.saveState(state);

      return {
        kind: "deliver" as const,
        coordinatorSession: input.coordinatorSession,
        packageId,
        messageId,
        promptText,
        queuedTaskIds: [],
        route: route ?? null,
      };
    });

    if (prepared.kind === "queued") {
      return {
        queuedTaskIds: prepared.queuedTaskIds,
      };
    }

    await this.questionFlow.deliverHumanQuestionPackageMessage(prepared);
    return {
      packageId: prepared.packageId,
      queuedTaskIds: prepared.queuedTaskIds,
    };
  }

  async retryHumanQuestionPackageDelivery(input: {
    coordinatorSession: string;
    packageId: string;
    messageId: string;
  }): Promise<RetryHumanQuestionPackageDeliveryResult> {
    const prepared = await this.kernel.mutate(async () => {
      const state = await this.deps.loadState();
      if (this.kernel.isExternalCoordinatorSession(state, input.coordinatorSession)) {
        throw new Error("human input routing is not configured for external coordinator");
      }
      const coordinatorState = this.kernel.ensureCoordinatorQuestionState(state, input.coordinatorSession);
      if (coordinatorState.activePackageId !== input.packageId) {
        throw new Error(
          `package "${input.packageId}" is not the active package for coordinator "${input.coordinatorSession}"`,
        );
      }

      const packageRecord = this.kernel.ensureHumanQuestionPackages(state)[input.packageId];
      if (!packageRecord) {
        throw new Error(`package "${input.packageId}" does not exist`);
      }
      if (!sameCoordinatorSession(packageRecord.coordinatorSession, input.coordinatorSession)) {
        throw new Error(
          `package "${input.packageId}" belongs to coordinator "${packageRecord.coordinatorSession}", not "${input.coordinatorSession}"`,
        );
      }
      if (packageRecord.status !== "active") {
        throw new Error(`package "${input.packageId}" is not active`);
      }

      const message = packageRecord.messages.find((entry) => entry.messageId === input.messageId);
      if (!message) {
        throw new Error(`message "${input.messageId}" does not exist in package "${input.packageId}"`);
      }
      if (message.deliveredAt !== undefined) {
        throw new Error(`message "${input.messageId}" in package "${input.packageId}" is already delivered`);
      }

      let route: FrozenCoordinatorDeliveryRoute | null = this.questionFlow.resolveFrozenPackageMessageRoute(message);
      if (!route) {
        route = this.questionFlow.snapshotCoordinatorDeliveryRoute(
          this.kernel.ensureCoordinatorRoutes(state)[stableCoordinatorSession(input.coordinatorSession)],
        ) ?? null;
        if (route) {
          Object.assign(message, this.questionFlow.serializeFrozenDeliveryRoute(route));
        }
      }

      packageRecord.awaitingReplyMessageId = undefined;
      packageRecord.updatedAt = this.deps.now().toISOString();
      await this.deps.saveState(state);
      return {
        coordinatorSession: input.coordinatorSession,
        packageId: input.packageId,
        messageId: input.messageId,
        promptText: message.promptText,
        route: route ?? null,
      };
    });

    await this.questionFlow.deliverHumanQuestionPackageMessage(prepared);
    return {
      packageId: prepared.packageId,
      messageId: prepared.messageId,
    };
  }

  async claimActiveHumanReply(input: {
    coordinatorSession: string;
    chatKey: string;
    packageId: string;
    messageId: string;
    accountId?: string;
    replyContextToken?: string;
  }): Promise<ClaimedActiveHumanReply | null> {
    return await this.kernel.mutate(async () => {
      const state = await this.deps.loadState();
      if (this.kernel.isExternalCoordinatorSession(state, input.coordinatorSession)) {
        return null;
      }
      const coordinatorState = this.kernel.ensureCoordinatorQuestionState(state, input.coordinatorSession);
      if (!coordinatorState.activePackageId || coordinatorState.activePackageId !== input.packageId) {
        return null;
      }

      const packageRecord = this.kernel.ensureHumanQuestionPackages(state)[coordinatorState.activePackageId];
      if (!packageRecord?.awaitingReplyMessageId || packageRecord.awaitingReplyMessageId !== input.messageId) {
        return null;
      }

      const message = packageRecord.messages.find((entry) => entry.messageId === input.messageId);
      if (!message || message.deliveredChatKey !== input.chatKey) {
        return null;
      }
      if (message.deliveryAccountId !== undefined && message.deliveryAccountId !== input.accountId) {
        return null;
      }
      if (
        message.routeReplyContextToken !== undefined &&
        message.routeReplyContextToken !== input.replyContextToken
      ) {
        return null;
      }
      const messageTaskQuestions = this.questionFlow.resolveLiveMessageTaskQuestions(state, packageRecord, message);
      if (messageTaskQuestions.length === 0) {
        return null;
      }

      packageRecord.awaitingReplyMessageId = undefined;
      packageRecord.updatedAt = this.deps.now().toISOString();
      await this.deps.saveState(state);
      return {
        coordinatorSession: input.coordinatorSession,
        packageId: packageRecord.packageId,
        messageId: message.messageId,
        chatKey: input.chatKey,
        promptText: message.promptText,
        queuedCount: coordinatorState.queuedQuestions.length,
        taskQuestions: messageTaskQuestions,
      };
    });
  }

  async getActiveHumanQuestionPackage(
    coordinatorSession: string,
  ): Promise<ActiveHumanQuestionPackage | null> {
    const state = await this.deps.loadState();
    if (this.kernel.isExternalCoordinatorSession(state, coordinatorSession)) {
      return null;
    }
    const coordinatorState =
      state.orchestration.coordinatorQuestionState[stableCoordinatorSession(coordinatorSession)];
    const activePackageId = coordinatorState?.activePackageId;
    if (!activePackageId) {
      return null;
    }

    const packageRecord = state.orchestration.humanQuestionPackages[activePackageId];
    if (!packageRecord) {
      return null;
    }

    const activeMessage =
      (packageRecord.awaitingReplyMessageId
        ? packageRecord.messages.find((message) => message.messageId === packageRecord.awaitingReplyMessageId)
        : undefined) ?? packageRecord.messages.at(-1);
    if (!activeMessage) {
      return null;
    }
    const messageTaskQuestions = this.questionFlow.resolveLiveMessageTaskQuestions(state, packageRecord, activeMessage);

    const openTaskQuestions = packageRecord.openTaskIds
      .map((taskId) => {
        const task = state.orchestration.tasks[taskId];
        if (!task?.openQuestion || task.openQuestion.status !== "open") {
          return null;
        }
        return {
          taskId,
          questionId: task.openQuestion.questionId,
          question: task.openQuestion.question,
          whyBlocked: task.openQuestion.whyBlocked,
          whatIsNeeded: task.openQuestion.whatIsNeeded,
        };
      })
      .filter(
        (
          entry,
        ): entry is NonNullable<ActiveHumanQuestionPackage["openTaskQuestions"]>[number] => entry !== null,
      );

    return {
      packageId: packageRecord.packageId,
      promptText: activeMessage.promptText,
      ...(packageRecord.awaitingReplyMessageId
        ? { awaitingReplyMessageId: packageRecord.awaitingReplyMessageId }
        : {}),
      ...(activeMessage.deliveredChatKey ? { deliveredChatKey: activeMessage.deliveredChatKey } : {}),
      ...(activeMessage.deliveryAccountId ? { deliveryAccountId: activeMessage.deliveryAccountId } : {}),
      ...(activeMessage.routeReplyContextToken
        ? { routeReplyContextToken: activeMessage.routeReplyContextToken }
        : {}),
      ...(activeMessage.deliveredAt ? { deliveredAt: activeMessage.deliveredAt } : {}),
      openTaskIds: [...packageRecord.openTaskIds],
      ...(messageTaskQuestions.length > 0 ? { messageTaskQuestions } : {}),
      ...(openTaskQuestions.length > 0 ? { openTaskQuestions } : {}),
      queuedCount: coordinatorState?.queuedQuestions.length ?? 0,
    };
  }

  async coordinatorReviewContestedResult(input: {
    coordinatorSession: string;
    taskId: string;
    reviewId: string;
    decision: "accept" | "discard";
  }): Promise<OrchestrationTaskRecord> {
    if (input.decision !== "accept" && input.decision !== "discard") {
      throw new Error(`unsupported contested-result decision "${input.decision}"`);
    }

    const prepared = await this.kernel.mutate(async () => {
      const state = await this.deps.loadState();
      const task = state.orchestration.tasks[input.taskId];
      if (!task) {
        throw new Error(`task "${input.taskId}" does not exist`);
      }
      this.questionFlow.assertCoordinatorOwnership(task, input.coordinatorSession);
      if (!task.reviewPending) {
        throw new Error(`task "${input.taskId}" does not have a contested result`);
      }
      if (task.reviewPending.reviewId !== input.reviewId) {
        throw new Error(
          `task "${input.taskId}" review is "${task.reviewPending.reviewId}", not "${input.reviewId}"`,
        );
      }

      const now = this.deps.now().toISOString();
      let replacementQuestionId: string | undefined;
      task.reviewPending = undefined;

      if (input.decision === "discard") {
        replacementQuestionId = this.deps.createId();
        const packageId = this.questionFlow.reopenActiveHumanPackageForTask(state, task, now);
        task.status = packageId ? "waiting_for_human" : "blocked";
        task.summary = "";
        task.resultText = "";
        task.openQuestion = this.questionFlow.buildReplacementOpenQuestion(task, replacementQuestionId, now, packageId);
        this.kernel.appendTaskEvent(task, now, "attention_required", {
          status: task.status,
          message: task.openQuestion.question,
        });
      } else if (
        (task.status === "completed" || task.status === "failed") &&
        task.chatKey &&
        task.replyContextToken &&
        task.noticeSentAt === undefined
      ) {
        task.noticePending = true;
        task.lastNoticeError = undefined;
      }

      task.updatedAt = now;
      if (input.decision === "accept") {
        this.kernel.appendTaskEvent(task, now, "status_changed", {
          status: task.status,
          message: "Contested result accepted",
        });
      }
      this.kernel.bumpGroupUpdated(state, task.groupId, now);
      await this.deps.saveState(state);

      return {
        task: { ...task },
        replacementQuestionId,
        externalCoordinator: this.kernel.isExternalCoordinatorSession(state, task.coordinatorSession),
      };
    });

    if (prepared.replacementQuestionId && !prepared.externalCoordinator) {
      try {
        await this.deps.wakeCoordinatorSession?.({
          coordinatorSession: prepared.task.coordinatorSession,
        });
      } catch (error) {
        await this.questionFlow.recordOpenQuestionWakeError(
          prepared.task.taskId,
          prepared.replacementQuestionId,
          error instanceof Error ? error.message : String(error),
        );
      }
    }

    // I-2: when a contested result is accepted, the task's reviewPending is cleared
    // and the task becomes terminally resolved (no further launchWorkerTurn fires).
    // Fire reconcile so the ephemeral session is closed and queued tasks can drain.
    if (input.decision === "accept") {
      try {
        await this.workerSessions.reconcileParallelSlots();
      } catch (error) {
        this.kernel.logEvent("orchestration.parallel.reconcile_failed", "reconcile failed after contested result accepted", {
          taskId: prepared.task.taskId,
          message: error instanceof Error ? error.message : String(error),
        });
      }
    }

    return prepared.task;
  }
}
