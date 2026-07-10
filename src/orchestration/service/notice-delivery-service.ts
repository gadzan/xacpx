// src/orchestration/service/notice-delivery-service.ts
// Task notices and coordinator injection bookkeeping. Pure state transitions over
// AppState -- it calls no outbound port beyond loading and saving state, which is why
// its Pick<> is three members wide rather than sixteen.
import type { AppState } from "../../state/types";
import { sameCoordinatorSession, stableCoordinatorSession } from "../coordinator-identity";
import type { OrchestrationGroupRecord, OrchestrationTaskRecord } from "../orchestration-types";
import type {
  MarkTaskErrorInput,
  OrchestrationServiceDeps,
  RecordTaskNoticeDeliveryInput,
} from "../orchestration-service";
import type { OrchestrationStateKernel } from "./orchestration-state-kernel";

export type NoticeDeliveryDeps = Pick<
  OrchestrationServiceDeps,
  "now" | "loadState" | "saveState"
>;

export class NoticeDeliveryService {
  constructor(
    private readonly deps: NoticeDeliveryDeps,
    private readonly kernel: OrchestrationStateKernel,
  ) {}

  async markTaskNoticePending(taskId: string): Promise<OrchestrationTaskRecord> {
    return await this.kernel.mutate(async () => {
      const state = await this.deps.loadState();
      const task = state.orchestration.tasks[taskId];
      if (!task) {
        throw new Error(`task "${taskId}" does not exist`);
      }

      task.noticePending = true;
      task.noticeSentAt = undefined;
      task.updatedAt = this.deps.now().toISOString();
      await this.deps.saveState(state);
      return { ...task };
    });
  }

  async markTaskNoticeDelivered(taskId: string, deliveryAccountId: string): Promise<OrchestrationTaskRecord> {
    const task = await this.kernel.mutate(async () => {
      const state = await this.deps.loadState();
      const task = state.orchestration.tasks[taskId];
      if (!task) {
        throw new Error(`task "${taskId}" does not exist`);
      }

      const now = this.deps.now().toISOString();
      task.noticePending = false;
      task.noticeSentAt = now;
      task.deliveryAccountId = deliveryAccountId;
      task.lastNoticeError = undefined;
      task.updatedAt = now;
      await this.deps.saveState(state);
      return { ...task };
    });

    this.kernel.logEvent("orchestration.notice.sent", "task notice delivered", {
      ...this.kernel.taskContext(task),
      delivery_account_id: deliveryAccountId,
    });

    return task;
  }

  async markTaskNoticeFailed(input: MarkTaskErrorInput): Promise<OrchestrationTaskRecord> {
    const task = await this.kernel.mutate(async () => {
      const state = await this.deps.loadState();
      const task = state.orchestration.tasks[input.taskId];
      if (!task) {
        throw new Error(`task "${input.taskId}" does not exist`);
      }

      task.noticePending = true;
      task.lastNoticeError = input.errorMessage;
      task.updatedAt = this.deps.now().toISOString();
      await this.deps.saveState(state);
      return { ...task };
    });

    this.kernel.logEvent("orchestration.notice.failed", "task notice delivery failed", {
      ...this.kernel.taskContext(task),
      error: input.errorMessage,
    });

    return task;
  }

  async listPendingTaskNotices(): Promise<OrchestrationTaskRecord[]> {
    const state = await this.deps.loadState();
    return Object.values(state.orchestration.tasks)
      .filter((task) => task.noticePending === true)
      .sort((left, right) => left.updatedAt.localeCompare(right.updatedAt))
      .map((task) => ({ ...task }));
  }

  async recordTaskNoticeDelivery(input: RecordTaskNoticeDeliveryInput): Promise<OrchestrationTaskRecord> {
    return await this.markTaskNoticeDelivered(input.taskId, input.deliveryAccountId);
  }

  async listPendingCoordinatorResults(coordinatorSession: string): Promise<OrchestrationTaskRecord[]> {
    const state = await this.deps.loadState();
    if (this.kernel.isExternalCoordinatorSession(state, coordinatorSession)) {
      return [];
    }
    return Object.values(state.orchestration.tasks)
      .filter(
        (task) =>
          sameCoordinatorSession(task.coordinatorSession, coordinatorSession) &&
          this.canInjectTaskIntoCoordinator(state, task) &&
          (task.injectionPending === true || task.coordinatorInjectedAt === undefined),
      )
      .sort((left, right) => left.updatedAt.localeCompare(right.updatedAt))
      .map((task) => ({ ...task }));
  }

  async listPendingCoordinatorBlockers(coordinatorSession: string): Promise<OrchestrationTaskRecord[]> {
    const state = await this.deps.loadState();
    if (this.kernel.isExternalCoordinatorSession(state, coordinatorSession)) {
      return [];
    }
    const coordinatorState =
      state.orchestration.coordinatorQuestionState[stableCoordinatorSession(coordinatorSession)];
    const hiddenQueuedQuestionKeys = coordinatorState?.activePackageId
      ? new Set((coordinatorState.queuedQuestions ?? []).map((entry) => `${entry.taskId}:${entry.questionId}`))
      : null;
    return Object.values(state.orchestration.tasks)
      .filter(
        (task) =>
          sameCoordinatorSession(task.coordinatorSession, coordinatorSession) &&
          task.status === "blocked" &&
          task.openQuestion?.status === "open" &&
          !hiddenQueuedQuestionKeys?.has(`${task.taskId}:${task.openQuestion.questionId}`),
      )
      .sort((left, right) => left.updatedAt.localeCompare(right.updatedAt))
      .map((task) => ({ ...task }));
  }

  async listContestedCoordinatorResults(coordinatorSession: string): Promise<OrchestrationTaskRecord[]> {
    const state = await this.deps.loadState();
    if (this.kernel.isExternalCoordinatorSession(state, coordinatorSession)) {
      return [];
    }
    return Object.values(state.orchestration.tasks)
      .filter((task) => sameCoordinatorSession(task.coordinatorSession, coordinatorSession) && task.reviewPending !== undefined)
      .sort((left, right) => left.updatedAt.localeCompare(right.updatedAt))
      .map((task) => ({ ...task }));
  }

  async listPendingCoordinatorGroups(coordinatorSession: string): Promise<OrchestrationGroupRecord[]> {
    const state = await this.deps.loadState();
    if (this.kernel.isExternalCoordinatorSession(state, coordinatorSession)) {
      return [];
    }
    const groups = this.kernel.ensureGroups(state);
    const tasks = Object.values(state.orchestration.tasks);

    return Object.values(groups)
      .filter((group) => sameCoordinatorSession(group.coordinatorSession, coordinatorSession))
      .filter((group) => {
        const groupTasks = tasks.filter((task) => task.groupId === group.groupId);
        return this.canInjectGroupIntoCoordinator(state, group.groupId, groupTasks);
      })
      .sort((left, right) => left.updatedAt.localeCompare(right.updatedAt))
      .map((group) => ({ ...group }));
  }

  async markCoordinatorResultsInjected(taskIds: string[]): Promise<void> {
    await this.markTaskInjectionApplied(taskIds);
  }

  async markCoordinatorGroupsInjected(groupIds: string[]): Promise<void> {
    if (groupIds.length === 0) {
      return;
    }

    const appliedTasks = await this.kernel.mutate(async () => {
      const state = await this.deps.loadState();
      const groups = this.kernel.ensureGroups(state);
      const injectedAt = this.deps.now().toISOString();
      let changed = false;
      const appliedTasks: OrchestrationTaskRecord[] = [];

      for (const groupId of groupIds) {
        const group = groups[groupId];
        if (!group) {
          continue;
        }
        if (group.coordinatorInjectedAt !== undefined) {
          continue;
        }
        if (!this.canInjectGroupIntoCoordinator(state, groupId)) {
          continue;
        }

        const groupTasks = Object.values(state.orchestration.tasks).filter((task) => task.groupId === groupId);
        group.coordinatorInjectedAt = injectedAt;
        group.injectionPending = false;
        group.injectionAppliedAt = injectedAt;
        group.lastInjectionError = undefined;
        group.updatedAt = injectedAt;
        for (const task of groupTasks) {
          if (task.coordinatorInjectedAt !== undefined) {
            continue;
          }
          task.coordinatorInjectedAt = injectedAt;
          task.injectionPending = false;
          task.injectionAppliedAt = injectedAt;
          task.lastInjectionError = undefined;
          task.updatedAt = injectedAt;
          appliedTasks.push({ ...task });
        }
        changed = true;
      }

      if (changed) {
        await this.deps.saveState(state);
      }

      return appliedTasks;
    });

    for (const task of appliedTasks) {
      this.kernel.logEvent(
        "orchestration.injection.applied",
        "coordinator injection applied",
        this.kernel.taskContext(task),
      );
    }
  }

  async markCoordinatorGroupsInjectionFailed(groupIds: string[], errorMessage: string): Promise<void> {
    if (groupIds.length === 0) {
      return;
    }

    await this.kernel.mutate(async () => {
      const state = await this.deps.loadState();
      const groups = this.kernel.ensureGroups(state);
      const failedAt = this.deps.now().toISOString();
      let changed = false;

      for (const groupId of groupIds) {
        const group = groups[groupId];
        if (!group) {
          continue;
        }
        if (!this.canInjectGroupIntoCoordinator(state, groupId)) {
          continue;
        }

        group.injectionPending = true;
        group.lastInjectionError = errorMessage;
        group.updatedAt = failedAt;
        changed = true;
      }

      if (changed) {
        await this.deps.saveState(state);
      }
    });
  }

  async markTaskInjectionApplied(taskIds: string[]): Promise<void> {
    if (taskIds.length === 0) {
      return;
    }

    const applied = await this.kernel.mutate(async () => {
      const state = await this.deps.loadState();
      const injectedAt = this.deps.now().toISOString();
      let changed = false;
      const applied: OrchestrationTaskRecord[] = [];

      for (const taskId of taskIds) {
        const task = state.orchestration.tasks[taskId];
        if (!task) {
          continue;
        }

        if (task.coordinatorInjectedAt !== undefined) {
          continue;
        }

        if (!this.canInjectTaskIntoCoordinator(state, task)) {
          continue;
        }

        task.coordinatorInjectedAt = injectedAt;
        task.injectionPending = false;
        task.injectionAppliedAt = injectedAt;
        task.lastInjectionError = undefined;
        task.updatedAt = injectedAt;
        changed = true;
        applied.push({ ...task });
      }

      if (changed) {
        await this.deps.saveState(state);
      }

      return applied;
    });

    for (const task of applied) {
      this.kernel.logEvent(
        "orchestration.injection.applied",
        "coordinator injection applied",
        this.kernel.taskContext(task),
      );
    }
  }

  async markTaskInjectionFailed(taskIds: string[], errorMessage: string): Promise<void> {
    if (taskIds.length === 0) {
      return;
    }

    const failed = await this.kernel.mutate(async () => {
      const state = await this.deps.loadState();
      const failedAt = this.deps.now().toISOString();
      let changed = false;
      const failed: OrchestrationTaskRecord[] = [];

      for (const taskId of taskIds) {
        const task = state.orchestration.tasks[taskId];
        if (!task) {
          continue;
        }

        if (!this.canInjectTaskIntoCoordinator(state, task)) {
          continue;
        }

        task.injectionPending = true;
        task.lastInjectionError = errorMessage;
        task.updatedAt = failedAt;
        changed = true;
        failed.push({ ...task });
      }

      if (changed) {
        await this.deps.saveState(state);
      }

      return failed;
    });

    for (const task of failed) {
      this.kernel.logEvent("orchestration.injection.failed", "coordinator injection failed", {
        ...this.kernel.taskContext(task),
        error: errorMessage,
      });
    }
  }

  private canInjectGroupIntoCoordinator(
    state: AppState,
    groupId: string,
    groupTasks = Object.values(state.orchestration.tasks).filter((task) => task.groupId === groupId),
  ): boolean {
    const group = this.kernel.ensureGroups(state)[groupId];
    if (!group) {
      return false;
    }
    if (this.kernel.isExternalCoordinatorSession(state, group.coordinatorSession)) {
      return false;
    }
    if (groupTasks.length === 0) {
      return false;
    }
    if (group.coordinatorInjectedAt !== undefined && group.injectionPending !== true) {
      return false;
    }
    if (groupTasks.some((task) => task.reviewPending !== undefined)) {
      return false;
    }
    return groupTasks.every((task) => task.status === "completed" || task.status === "failed");
  }

  private canInjectTaskIntoCoordinator(state: AppState, task: OrchestrationTaskRecord): boolean {
    if (this.kernel.isExternalCoordinatorSession(state, task.coordinatorSession)) {
      return false;
    }
    if ((task.status !== "completed" && task.status !== "failed") || task.reviewPending !== undefined) {
      return false;
    }
    if (task.groupId) {
      return this.canInjectGroupIntoCoordinator(state, task.groupId);
    }
    return true;
  }
}
