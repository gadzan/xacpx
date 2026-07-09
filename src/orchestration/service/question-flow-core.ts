// src/orchestration/service/question-flow-core.ts
// Coordinator question state + human-question-package lifecycle: the shared layer the
// cancellation, group, and lifecycle clusters all reach into (cancelling a task must
// detach it from the question flow; discarding a contested result reopens a package).
// It is a layer rather than part of HumanQuestionService so those callers do not form a
// backwards dependency. The facade constructs one and injects it everywhere.
import type { AppState } from "../../state/types";
import { isQuotaDeferredError } from "../../weixin/messaging/quota-errors";
import { sameCoordinatorSession } from "../coordinator-identity";
import type {
  OrchestrationCoordinatorRouteContextRecord,
  OrchestrationHumanQuestionPackageMessageRecord,
  OrchestrationHumanQuestionPackageRecord,
  OrchestrationOpenQuestionRecord,
  OrchestrationTaskRecord,
} from "../orchestration-types";
import type {
  FrozenCoordinatorDeliveryRoute,
  OrchestrationServiceDeps,
} from "../orchestration-service";
import type { OrchestrationStateKernel } from "./orchestration-state-kernel";

export type QuestionFlowDeps = Pick<
  OrchestrationServiceDeps,
  "now" | "loadState" | "saveState" | "wakeCoordinatorSession" | "deliverCoordinatorMessage"
>;

export class QuestionFlowCore {
  constructor(
    private readonly deps: QuestionFlowDeps,
    private readonly kernel: OrchestrationStateKernel,
  ) {}

  assertCoordinatorQuestionMatch(task: OrchestrationTaskRecord, questionId: string): OrchestrationOpenQuestionRecord {
    const openQuestion = task.openQuestion;
    if (!openQuestion) {
      throw new Error(`task "${task.taskId}" does not have an open question`);
    }
    if (openQuestion.questionId !== questionId) {
      throw new Error(`task "${task.taskId}" open question is "${openQuestion.questionId}", not "${questionId}"`);
    }
    if (openQuestion.status !== "open") {
      throw new Error(`task "${task.taskId}" question "${questionId}" is ${openQuestion.status}, not open`);
    }
    return openQuestion;
  }

  assertTaskAnswerIsWithinAwaitedHumanSnapshot(
    state: AppState,
    task: OrchestrationTaskRecord,
    questionId: string,
  ): void {
    if (task.status !== "waiting_for_human") {
      return;
    }

    const packageId = task.openQuestion?.packageId;
    if (!packageId) {
      return;
    }

    const coordinatorState = this.kernel.ensureCoordinatorQuestionState(state, task.coordinatorSession);
    if (coordinatorState.activePackageId !== packageId) {
      return;
    }

    const packageRecord = this.kernel.ensureHumanQuestionPackages(state)[packageId];
    const awaitingMessageId = packageRecord?.awaitingReplyMessageId;
    if (!packageRecord || !awaitingMessageId) {
      return;
    }

    const awaitingMessage = packageRecord.messages.find((message) => message.messageId === awaitingMessageId);
    const inSnapshot = awaitingMessage?.taskQuestions?.some(
      (entry) => entry.taskId === task.taskId && entry.questionId === questionId,
    );
    if (!inSnapshot) {
      throw new Error(
        `task "${task.taskId}" question "${questionId}" is outside awaited message "${awaitingMessageId}" for package "${packageId}"`,
      );
    }
  }

  assertCoordinatorOwnership(task: OrchestrationTaskRecord, coordinatorSession: string): void {
    if (!sameCoordinatorSession(task.coordinatorSession, coordinatorSession)) {
      throw new Error(
        `task "${task.taskId}" belongs to coordinator "${task.coordinatorSession}", not "${coordinatorSession}"`,
      );
    }
  }

  snapshotCoordinatorDeliveryRoute(
    route: OrchestrationCoordinatorRouteContextRecord | undefined,
  ): FrozenCoordinatorDeliveryRoute | undefined {
    if (!route) {
      return undefined;
    }

    return {
      chatKey: route.chatKey,
      ...(route.accountId ? { accountId: route.accountId } : {}),
      ...(route.replyContextToken ? { replyContextToken: route.replyContextToken } : {}),
    };
  }

  normalizeFrozenDeliveryRoute(route: FrozenCoordinatorDeliveryRoute): FrozenCoordinatorDeliveryRoute {
    return {
      chatKey: route.chatKey,
      ...(route.accountId && route.replyContextToken
        ? {
            accountId: route.accountId,
            replyContextToken: route.replyContextToken,
          }
        : {}),
    };
  }

  serializeFrozenDeliveryRoute(
    route: FrozenCoordinatorDeliveryRoute,
  ): Pick<
    OrchestrationHumanQuestionPackageMessageRecord,
    "routeChatKey" | "routeAccountId" | "routeReplyContextToken"
  > {
    const normalized = this.normalizeFrozenDeliveryRoute(route);
    return {
      routeChatKey: normalized.chatKey,
      ...(normalized.accountId && normalized.replyContextToken
        ? {
            routeAccountId: normalized.accountId,
            routeReplyContextToken: normalized.replyContextToken,
          }
        : {}),
    };
  }

  resolveFrozenPackageMessageRoute(
    message: OrchestrationHumanQuestionPackageMessageRecord,
  ): FrozenCoordinatorDeliveryRoute | null {
    if (message.routeChatKey) {
      return this.normalizeFrozenDeliveryRoute({
        chatKey: message.routeChatKey,
        ...(message.routeAccountId ? { accountId: message.routeAccountId } : {}),
        ...(message.routeReplyContextToken ? { replyContextToken: message.routeReplyContextToken } : {}),
      });
    }

    if (message.deliveredChatKey) {
      return {
        chatKey: message.deliveredChatKey,
        ...(message.deliveryAccountId ? { accountId: message.deliveryAccountId } : {}),
      };
    }

    return null;
  }

  async deliverHumanQuestionPackageMessage(input: {
    coordinatorSession: string;
    packageId: string;
    messageId: string;
    promptText: string;
    route: FrozenCoordinatorDeliveryRoute | null;
  }): Promise<void> {
    if (!input.route) {
      const errorMessage = `coordinator "${input.coordinatorSession}" does not have a delivery route for human question packages`;
      await this.recordPackageMessageDeliveryError(
        input.coordinatorSession,
        input.packageId,
        input.messageId,
        errorMessage,
      );
      throw new Error(errorMessage);
    }
    if (!this.deps.deliverCoordinatorMessage) {
      const errorMessage = "deliverCoordinatorMessage dependency is required for human question package delivery";
      await this.recordPackageMessageDeliveryError(
        input.coordinatorSession,
        input.packageId,
        input.messageId,
        errorMessage,
      );
      throw new Error(errorMessage);
    }

    try {
      const deliveredRoute =
        (await this.deps.deliverCoordinatorMessage({
          coordinatorSession: input.coordinatorSession,
          chatKey: input.route.chatKey,
          accountId: input.route.accountId,
          replyContextToken: input.route.replyContextToken,
          text: input.promptText,
        })) ?? input.route;
      await this.recordPackageMessageDeliverySuccess({
        coordinatorSession: input.coordinatorSession,
        packageId: input.packageId,
        messageId: input.messageId,
        route: this.normalizeFrozenDeliveryRoute(deliveredRoute),
        deliveryAccountId: deliveredRoute.accountId,
      });
    } catch (error) {
      if (isQuotaDeferredError(error)) {
        // Quota deferred is not a delivery failure: leave the package's
        // delivery state pending so the next wake retries cleanly after the
        // user's next inbound resets the quota window. Upstream callers
        // (coordinatorRequestHumanInput, retryHumanQuestionPackageDelivery)
        // will receive the deferred error
        // and may need their own propagation handling — see follow-up TODO.
        throw error;
      }
      await this.recordPackageMessageDeliveryError(
        input.coordinatorSession,
        input.packageId,
        input.messageId,
        error instanceof Error ? error.message : String(error),
      );
      throw error;
    }
  }

  async recordPackageMessageDeliverySuccess(input: {
    coordinatorSession: string;
    packageId: string;
    messageId: string;
    route: FrozenCoordinatorDeliveryRoute;
    deliveryAccountId?: string;
  }): Promise<void> {
    await this.kernel.mutate(async () => {
      const state = await this.deps.loadState();
      const coordinatorState = this.kernel.ensureCoordinatorQuestionState(state, input.coordinatorSession);
      if (coordinatorState.activePackageId !== input.packageId) {
        return;
      }

      const packageRecord = this.kernel.ensureHumanQuestionPackages(state)[input.packageId];
      if (!packageRecord || packageRecord.status !== "active") {
        return;
      }

      const message = packageRecord.messages.find((entry) => entry.messageId === input.messageId);
      if (!message) {
        return;
      }

      const now = this.deps.now().toISOString();
      message.deliveredAt = now;
      message.deliveredChatKey = input.route.chatKey;
      message.deliveryAccountId = input.deliveryAccountId;
      message.routeChatKey = input.route.chatKey;
      message.routeAccountId = input.route.accountId && input.route.replyContextToken ? input.route.accountId : undefined;
      message.routeReplyContextToken = input.route.replyContextToken;
      message.lastDeliveryError = undefined;
      packageRecord.awaitingReplyMessageId = input.messageId;
      packageRecord.updatedAt = now;
      await this.deps.saveState(state);
    });
  }

  async recordPackageMessageDeliveryError(
    coordinatorSession: string,
    packageId: string,
    messageId: string,
    errorMessage: string,
  ): Promise<void> {
    await this.kernel.mutate(async () => {
      const state = await this.deps.loadState();
      const coordinatorState = this.kernel.ensureCoordinatorQuestionState(state, coordinatorSession);
      if (coordinatorState.activePackageId !== packageId) {
        return;
      }

      const packageRecord = this.kernel.ensureHumanQuestionPackages(state)[packageId];
      if (!packageRecord || packageRecord.status !== "active") {
        return;
      }

      const message = packageRecord.messages.find((entry) => entry.messageId === messageId);
      if (!message) {
        return;
      }

      const now = this.deps.now().toISOString();
      message.lastDeliveryError = errorMessage;
      if (packageRecord.messages.at(-1)?.messageId === messageId) {
        packageRecord.awaitingReplyMessageId = undefined;
      }
      packageRecord.updatedAt = now;
      await this.deps.saveState(state);
    });
  }

  async recordOpenQuestionWakeError(taskId: string, questionId: string, errorMessage: string): Promise<void> {
    await this.kernel.mutate(async () => {
      const state = await this.deps.loadState();
      const task = state.orchestration.tasks[taskId];
      if (!task || task.openQuestion?.questionId !== questionId || task.openQuestion.status !== "open") {
        return;
      }

      task.openQuestion = {
        ...task.openQuestion,
        lastWakeError: errorMessage,
      };
      task.updatedAt = this.deps.now().toISOString();
      await this.deps.saveState(state);
    });
  }

  async handoffQueuedQuestions(coordinatorSession: string, closedPackageId: string): Promise<void> {
    const prepared = await this.kernel.mutate(async () => {
      const state = await this.deps.loadState();
      const coordinatorState = this.kernel.ensureCoordinatorQuestionState(state, coordinatorSession);
      if (coordinatorState.activePackageId === closedPackageId) {
        return { externalCoordinator: this.kernel.isExternalCoordinatorSession(state, coordinatorSession), queuedQuestions: [] };
      }

      const validQueuedQuestions = coordinatorState.queuedQuestions.filter((entry) => {
        const task = state.orchestration.tasks[entry.taskId];
        return (
          task !== undefined &&
          sameCoordinatorSession(task.coordinatorSession, coordinatorSession) &&
          task.status === "blocked" &&
          task.openQuestion?.status === "open" &&
          task.openQuestion.questionId === entry.questionId
        );
      });
      if (validQueuedQuestions.length !== coordinatorState.queuedQuestions.length) {
        coordinatorState.queuedQuestions = validQueuedQuestions;
        await this.deps.saveState(state);
      }
      return {
        externalCoordinator: this.kernel.isExternalCoordinatorSession(state, coordinatorSession),
        queuedQuestions: validQueuedQuestions,
      };
    });

    if (prepared.queuedQuestions.length === 0 || prepared.externalCoordinator) {
      return;
    }

    try {
      await this.deps.wakeCoordinatorSession?.({
        coordinatorSession,
      });
      await this.kernel.mutate(async () => {
        const state = await this.deps.loadState();
        const coordinatorState = this.kernel.ensureCoordinatorQuestionState(state, coordinatorSession);
        coordinatorState.queuedQuestions = coordinatorState.queuedQuestions.filter(
          (entry) =>
            !prepared.queuedQuestions.some(
              (queued) => queued.taskId === entry.taskId && queued.questionId === entry.questionId,
            ),
        );
        await this.deps.saveState(state);
      });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      await Promise.all(
        prepared.queuedQuestions.map(async ({ taskId, questionId }) => {
          const state = await this.deps.loadState();
          const task = state.orchestration.tasks[taskId];
          if (!task?.openQuestion || task.openQuestion.status !== "open" || task.openQuestion.questionId !== questionId) {
            return;
          }
          await this.recordOpenQuestionWakeError(taskId, questionId, errorMessage);
        }),
      );
    }
  }

  async restoreBlockedQuestionAfterResumeFailure(
    taskId: string,
    questionId: string,
    errorMessage: string,
    packageRestore?: {
      packageId: string;
      packageRecord: OrchestrationHumanQuestionPackageRecord;
      activePackageId?: string;
    },
  ): Promise<void> {
    await this.kernel.mutate(async () => {
      const state = await this.deps.loadState();
      const task = state.orchestration.tasks[taskId];
      if (!task || task.openQuestion?.questionId !== questionId || task.openQuestion.status !== "answered") {
        return;
      }

      task.status = packageRestore ? "waiting_for_human" : "blocked";
      task.openQuestion = {
        ...task.openQuestion,
        status: "open",
        answeredAt: undefined,
        answerSource: undefined,
        answerText: undefined,
        lastResumeError: errorMessage,
      };
      const now = this.deps.now().toISOString();
      task.updatedAt = now;
      if (packageRestore) {
        const packageRecord = {
          ...packageRestore.packageRecord,
          initialTaskIds: [...packageRestore.packageRecord.initialTaskIds],
          openTaskIds: [...packageRestore.packageRecord.openTaskIds],
          resolvedTaskIds: [...packageRestore.packageRecord.resolvedTaskIds],
          messages: packageRestore.packageRecord.messages.map((message) => ({ ...message })),
          updatedAt: now,
        };
        this.kernel.ensureHumanQuestionPackages(state)[packageRestore.packageId] = packageRecord;
        const coordinatorState = this.kernel.ensureCoordinatorQuestionState(state, task.coordinatorSession);
        coordinatorState.activePackageId = packageRestore.activePackageId;
      }
      await this.deps.saveState(state);
    });
  }

  captureTaskHumanPackageContext(
    state: AppState,
    task: OrchestrationTaskRecord,
  ):
    | {
        packageId: string;
        packageRecord: OrchestrationHumanQuestionPackageRecord;
        activePackageId?: string;
      }
    | undefined {
    const packageId = task.openQuestion?.packageId;
    if (!packageId) {
      return undefined;
    }

    const packageRecord = this.kernel.ensureHumanQuestionPackages(state)[packageId];
    if (!packageRecord) {
      return undefined;
    }

    const coordinatorState = this.kernel.ensureCoordinatorQuestionState(state, task.coordinatorSession);
    return {
      packageId,
      packageRecord: {
        ...packageRecord,
        initialTaskIds: [...packageRecord.initialTaskIds],
        openTaskIds: [...packageRecord.openTaskIds],
        resolvedTaskIds: [...packageRecord.resolvedTaskIds],
        messages: packageRecord.messages.map((message) => ({ ...message })),
      },
      activePackageId: coordinatorState.activePackageId,
    };
  }

  resolveTaskFromHumanPackage(state: AppState, task: OrchestrationTaskRecord, now: string): void {
    const packageId = task.openQuestion?.packageId;
    if (!packageId) {
      return;
    }

    const packageRecord = this.kernel.ensureHumanQuestionPackages(state)[packageId];
    if (!packageRecord) {
      return;
    }

    packageRecord.openTaskIds = packageRecord.openTaskIds.filter((taskId) => taskId !== task.taskId);
    if (!packageRecord.resolvedTaskIds.includes(task.taskId)) {
      packageRecord.resolvedTaskIds.push(task.taskId);
    }
    packageRecord.updatedAt = now;

    const coordinatorState = this.kernel.ensureCoordinatorQuestionState(state, task.coordinatorSession);
    if (packageRecord.openTaskIds.length === 0) {
      packageRecord.status = "closed";
      packageRecord.closedAt = now;
      packageRecord.awaitingReplyMessageId = undefined;
      if (coordinatorState.activePackageId === packageId) {
        coordinatorState.activePackageId = undefined;
      }
    }
  }

  detachTaskFromQuestionFlows(state: AppState, task: OrchestrationTaskRecord, now: string): string | undefined {
    const questionId = task.openQuestion?.questionId;
    const coordinatorState = this.kernel.ensureCoordinatorQuestionState(state, task.coordinatorSession);
    if (questionId) {
      coordinatorState.queuedQuestions = coordinatorState.queuedQuestions.filter(
        (entry) => !(entry.taskId === task.taskId && entry.questionId === questionId),
      );
    }

    const packageId = task.openQuestion?.packageId;
    if (!packageId) {
      return undefined;
    }

    const packageRecord = this.kernel.ensureHumanQuestionPackages(state)[packageId];
    if (!packageRecord) {
      return undefined;
    }

    packageRecord.openTaskIds = packageRecord.openTaskIds.filter((taskId) => taskId !== task.taskId);
    packageRecord.resolvedTaskIds = packageRecord.resolvedTaskIds.filter((taskId) => taskId !== task.taskId);
    packageRecord.updatedAt = now;

    if (packageRecord.openTaskIds.length === 0) {
      packageRecord.status = "closed";
      packageRecord.closedAt = now;
      packageRecord.awaitingReplyMessageId = undefined;
      if (coordinatorState.activePackageId === packageId) {
        coordinatorState.activePackageId = undefined;
      }
      return packageId;
    }

    return undefined;
  }

  reopenActiveHumanPackageForTask(
    state: AppState,
    task: OrchestrationTaskRecord,
    now: string,
  ): string | undefined {
    const packageId = task.openQuestion?.packageId;
    if (!packageId) {
      return undefined;
    }

    const coordinatorState = this.kernel.ensureCoordinatorQuestionState(state, task.coordinatorSession);
    if (coordinatorState.activePackageId !== packageId) {
      return undefined;
    }

    const packageRecord = this.kernel.ensureHumanQuestionPackages(state)[packageId];
    if (!packageRecord || packageRecord.status !== "active") {
      return undefined;
    }

    if (!packageRecord.openTaskIds.includes(task.taskId)) {
      packageRecord.openTaskIds.push(task.taskId);
    }
    packageRecord.resolvedTaskIds = packageRecord.resolvedTaskIds.filter((taskId) => taskId !== task.taskId);
    packageRecord.updatedAt = now;
    return packageId;
  }

  buildReplacementOpenQuestion(
    task: OrchestrationTaskRecord,
    questionId: string,
    askedAt: string,
    packageId?: string,
  ): OrchestrationOpenQuestionRecord {
    const current = task.openQuestion;
    return {
      questionId,
      question: current?.question ?? task.task,
      whyBlocked: current?.whyBlocked ?? "Coordinator discarded the contested result",
      whatIsNeeded: current?.whatIsNeeded ?? "A corrected answer from the worker",
      askedAt,
      status: "open",
      ...(packageId ? { packageId } : {}),
    };
  }

  resolveLiveMessageTaskQuestions(
    state: AppState,
    packageRecord: OrchestrationHumanQuestionPackageRecord,
    message: OrchestrationHumanQuestionPackageMessageRecord,
  ): Array<{ taskId: string; questionId: string }> {
    return (message.taskQuestions ?? [])
      .filter((entry) => packageRecord.openTaskIds.includes(entry.taskId))
      .filter((entry) => {
        const task = state.orchestration.tasks[entry.taskId];
        return (
          task?.openQuestion !== undefined &&
          task.openQuestion.status === "open" &&
          task.openQuestion.questionId === entry.questionId
        );
      })
      .map((entry) => ({ ...entry }));
  }
}
