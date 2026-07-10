// src/orchestration/service/task-lifecycle-service.ts
// Task lifecycle reads and mutations: worker replies, progress, watch/list queries,
// and coordinator/session cleanup. A leaf service that depends only on the kernel;
// it moves no instance state and calls no worker/question-flow collaborator.
import type { AppState } from "../../state/types";
import { sameCoordinatorSession, stableCoordinatorSession } from "../coordinator-identity";
import { isAttentionRequiredTask, isTerminalTaskStatus } from "../orchestration-types";
import type { OrchestrationTaskRecord } from "../orchestration-types";
import { sanitizeProgressSummary, stripProgressLines } from "../progress-line-parser";
import { clampWatchPollInterval, clampWatchTimeout } from "../task-watch-timeouts";
import type {
  CleanTasksResult,
  OrchestrationServiceDeps,
  OrchestrationTaskFilter,
  RecordWorkerReplyInput,
  WatchTaskInput,
  WatchTaskResult,
} from "../orchestration-service";
import type { OrchestrationStateKernel } from "./orchestration-state-kernel";

export type TaskLifecycleDeps = Pick<
  OrchestrationServiceDeps,
  "now" | "createId" | "loadState" | "saveState" | "config"
>;

export class TaskLifecycleService {
  constructor(
    private readonly deps: TaskLifecycleDeps,
    private readonly kernel: OrchestrationStateKernel,
  ) {}

  async recordWorkerReply(input: RecordWorkerReplyInput): Promise<OrchestrationTaskRecord> {
    const task = await this.kernel.mutate(async () => {
      const state = await this.deps.loadState();
      const task = state.orchestration.tasks[input.taskId];
      if (!task) {
        throw new Error(`task "${input.taskId}" does not exist`);
      }

      const expectedSourceHandle = task.workerSession;
      if (!expectedSourceHandle) {
        throw new Error(`task "${input.taskId}" does not have an assigned worker session`);
      }

      if (expectedSourceHandle !== input.sourceHandle) {
        throw new Error(
          `task "${input.taskId}" belongs to worker "${expectedSourceHandle}", not "${input.sourceHandle}"`,
        );
      }

      if (this.kernel.isTerminalStatus(task.status)) {
        throw new Error(`task "${input.taskId}" is already ${task.status}`);
      }

      if (task.status !== "running") {
        throw new Error(`task "${input.taskId}" is ${task.status}, not running`);
      }

      const updatedAt = this.deps.now().toISOString();
      const isContestedResult = task.correctionPending?.reason === "misrouted_answer";
      task.status = input.status ?? "completed";
      task.summary = input.summary ?? "";
      task.resultText = stripProgressLines(input.resultText ?? "");
      this.kernel.appendTaskEvent(task, updatedAt, "status_changed", {
        status: task.status,
        summary: task.summary,
        message: task.status === "completed" ? "Task completed" : task.status === "failed" ? "Task failed" : "Task cancelled",
      });
      if (task.status === "completed" || task.status === "failed") {
        if (!this.kernel.isExternalCoordinatorSession(state, task.coordinatorSession)) {
          task.injectionPending = true;
          task.injectionAppliedAt = undefined;
          task.lastInjectionError = undefined;
        } else {
          task.injectionPending = undefined;
          task.injectionAppliedAt = undefined;
          task.lastInjectionError = undefined;
        }
        if (!isContestedResult && task.chatKey && task.replyContextToken) {
          task.noticePending = true;
          task.noticeSentAt = undefined;
          task.lastNoticeError = undefined;
        } else if (isContestedResult) {
          task.noticePending = false;
          task.noticeSentAt = undefined;
          task.lastNoticeError = undefined;
        }
      }
      if (isContestedResult) {
        task.reviewPending = {
          reviewId: this.deps.createId(),
          reason: "misrouted_answer",
          createdAt: updatedAt,
          resultId: this.deps.createId(),
          resultText: task.resultText,
        };
        this.kernel.appendTaskEvent(task, updatedAt, "attention_required", {
          status: task.status,
          message: "Task result requires contested review",
        });
        task.correctionPending = undefined;
        task.cancelRequestedAt = undefined;
        task.cancelCompletedAt = undefined;
        task.lastCancelError = undefined;
      }
      task.updatedAt = updatedAt;
      this.kernel.bumpGroupUpdated(state, task.groupId, updatedAt);

      await this.deps.saveState(state);

      return { ...task };
    });

    if (task.status === "completed") {
      this.kernel.logEvent("orchestration.task.completed", "task completed", this.kernel.taskContext(task));
    } else if (task.status === "failed") {
      this.kernel.logEvent("orchestration.task.failed", "task failed", this.kernel.taskContext(task));
    }

    return task;
  }

  async getTask(taskId: string): Promise<OrchestrationTaskRecord | null> {
    const state = await this.deps.loadState();
    const task = state.orchestration.tasks[taskId];
    return task ? { ...task } : null;
  }


  async watchTask(input: WatchTaskInput): Promise<WatchTaskResult> {
    const timeoutMs = clampWatchTimeout(input.timeoutMs);
    const pollIntervalMs = clampWatchPollInterval(input.pollIntervalMs);
    const afterSeq = Math.max(0, Math.floor(input.afterSeq ?? 0));
    const mode = input.mode ?? "until_attention_or_terminal";
    const includeProgress = input.includeProgress ?? true;
    const deadline = Date.now() + timeoutMs;

    while (true) {
      const state = await this.deps.loadState();
      const task = state.orchestration.tasks[input.taskId];
      if (!task || !sameCoordinatorSession(task.coordinatorSession, input.coordinatorSession)) {
        return { status: "not_found", task: null, events: [], nextAfterSeq: afterSeq };
      }

      const snapshot = { ...task };
      const allEvents = task.events ?? [];
      const filteredEvents = allEvents
        .filter((event) => event.seq > afterSeq)
        .filter((event) => includeProgress || event.type !== "progress");
      const nextAfterSeq = task.eventSeq ?? allEvents.at(-1)?.seq ?? afterSeq;
      const historyTruncated = allEvents.length > 0 && afterSeq < allEvents[0]!.seq - 1;

      if (isTerminalTaskStatus(task.status) && task.reviewPending === undefined) {
        return {
          status: "terminal",
          task: snapshot,
          events: filteredEvents.map((event) => ({ ...event })),
          nextAfterSeq,
          ...(historyTruncated ? { historyTruncated } : {}),
        };
      }
      if (isAttentionRequiredTask(task)) {
        return {
          status: "attention_required",
          task: snapshot,
          events: filteredEvents.map((event) => ({ ...event })),
          nextAfterSeq,
          ...(historyTruncated ? { historyTruncated } : {}),
        };
      }
      if (filteredEvents.length > 0 && mode === "next_event") {
        return {
          status: "event",
          task: snapshot,
          events: filteredEvents.map((event) => ({ ...event })),
          nextAfterSeq,
          ...(historyTruncated ? { historyTruncated } : {}),
        };
      }

      const remainingMs = deadline - Date.now();
      if (remainingMs <= 0) {
        return {
          status: "timeout",
          task: snapshot,
          events: filteredEvents.map((event) => ({ ...event })),
          nextAfterSeq,
          ...(historyTruncated ? { historyTruncated } : {}),
        };
      }
      await sleep(Math.min(pollIntervalMs, remainingMs));
    }
  }

  async listTasks(filter?: OrchestrationTaskFilter): Promise<OrchestrationTaskRecord[]> {
    const state = await this.deps.loadState();
    const threshold = this.deps.config.orchestration.progressHeartbeatSeconds;
    const now = this.deps.now().getTime();
    const sortField = filter?.sort ?? "updatedAt";
    const order = filter?.order ?? "desc";

    return Object.values(state.orchestration.tasks)
      .filter((task) => this.matchesFilter(task, filter))
      .filter((task) => {
        if (filter?.stuck !== true) return true;
        if (task.status !== "running") return false;
        const reference = task.lastProgressAt ?? task.createdAt;
        const elapsed = (now - new Date(reference).getTime()) / 1000;
        return elapsed >= threshold;
      })
      .sort((left, right) => {
        const leftValue = sortField === "createdAt" ? left.createdAt : left.updatedAt;
        const rightValue = sortField === "createdAt" ? right.createdAt : right.updatedAt;
        const compare = leftValue.localeCompare(rightValue);
        return order === "asc" ? compare : -compare;
      })
      .map((task) => ({ ...task }));
  }

  async cleanTasks(coordinatorSession: string): Promise<CleanTasksResult> {
    return await this.kernel.mutate(async () => {
      const state = await this.deps.loadState();
      const tasks = state.orchestration.tasks;
      const bindings = state.orchestration.workerBindings;

      const terminalTaskIds: string[] = [];
      for (const [taskId, task] of Object.entries(tasks)) {
        if (
          sameCoordinatorSession(task.coordinatorSession, coordinatorSession) &&
          this.kernel.isTerminalStatus(task.status) &&
          task.reviewPending === undefined
        ) {
          terminalTaskIds.push(taskId);
        }
      }

      for (const taskId of terminalTaskIds) {
        delete tasks[taskId];
      }

      const remainingWorkerSessions = new Set(
        Object.values(tasks).map((task) => task.workerSession).filter(Boolean) as string[],
      );

      let removedBindings = 0;
      for (const [workerSession, binding] of Object.entries(bindings)) {
        if (!sameCoordinatorSession(binding.coordinatorSession, coordinatorSession)) {
          continue;
        }
        if (!remainingWorkerSessions.has(workerSession)) {
          delete bindings[workerSession];
          removedBindings += 1;
        }
      }

      const removedEmptyGroups = this.removeEmptyGroupsForCoordinator(state, coordinatorSession);

      if (terminalTaskIds.length > 0 || removedBindings > 0 || removedEmptyGroups) {
        await this.deps.saveState(state);
      }

      return {
        removedTasks: terminalTaskIds.length,
        removedBindings,
      };
    });
  }

  async listSessionBlockingTasks(transportSession: string): Promise<OrchestrationTaskRecord[]> {
    const state = await this.deps.loadState();
    return Object.values(state.orchestration.tasks)
      .filter(
        (task) =>
          (!this.kernel.isTerminalStatus(task.status) || task.reviewPending !== undefined) &&
          (sameCoordinatorSession(task.coordinatorSession, transportSession) ||
            (task.workerSession !== undefined &&
              sameCoordinatorSession(task.workerSession, transportSession))),
      )
      .map((task) => ({ ...task }));
  }

  async purgeSessionReferences(transportSession: string): Promise<CleanTasksResult> {
    return await this.kernel.mutate(async () => {
      const state = await this.deps.loadState();
      const sessionIdentity = stableCoordinatorSession(transportSession);
      const tasks = state.orchestration.tasks;
      const bindings = state.orchestration.workerBindings;

      const removedTaskIds: string[] = [];
      for (const [taskId, task] of Object.entries(tasks)) {
        if (
          this.kernel.isTerminalStatus(task.status) &&
          task.reviewPending === undefined &&
          (sameCoordinatorSession(task.coordinatorSession, transportSession) ||
            (task.workerSession !== undefined &&
              sameCoordinatorSession(task.workerSession, transportSession)))
        ) {
          removedTaskIds.push(taskId);
        }
      }
      for (const taskId of removedTaskIds) {
        delete tasks[taskId];
      }

      const remainingWorkerSessions = new Set(
        Object.values(tasks).map((task) => task.workerSession).filter(Boolean) as string[],
      );

      let removedBindings = 0;
      for (const [workerSession, binding] of Object.entries(bindings)) {
        const shouldPurgeBinding =
          sameCoordinatorSession(workerSession, transportSession) ||
          sameCoordinatorSession(binding.coordinatorSession, transportSession);
        if (shouldPurgeBinding && !remainingWorkerSessions.has(workerSession)) {
          delete bindings[workerSession];
          removedBindings += 1;
        }
      }

      const removedEmptyGroups = this.removeEmptyGroupsForCoordinator(state, sessionIdentity);
      const removedCoordinatorMetadata = this.removeCoordinatorMetadataIfUnused(state, sessionIdentity);

      if (removedTaskIds.length > 0 || removedBindings > 0 || removedEmptyGroups || removedCoordinatorMetadata) {
        await this.deps.saveState(state);
      }

      return {
        removedTasks: removedTaskIds.length,
        removedBindings,
      };
    });
  }

  async recordTaskProgress(taskId: string, summary?: string): Promise<OrchestrationTaskRecord> {
    return await this.kernel.mutate(async () => {
      const state = await this.deps.loadState();
      const task = state.orchestration.tasks[taskId];
      if (!task) {
        throw new Error(`task "${taskId}" does not exist`);
      }

      task.lastProgressAt = this.deps.now().toISOString();
      if (summary !== undefined) {
        const cleaned = sanitizeProgressSummary(summary);
        if (cleaned.length > 0) {
          task.lastProgressSummary = cleaned;
          this.kernel.appendTaskEvent(task, task.lastProgressAt, "progress", {
            status: task.status,
            summary: cleaned,
          });
        }
      } else {
        this.kernel.appendTaskEvent(task, task.lastProgressAt, "progress", {
          status: task.status,
          message: "heartbeat",
        });
      }
      task.updatedAt = task.lastProgressAt;
      await this.deps.saveState(state);
      return { ...task };
    });
  }

  async listHeartbeatTasks(thresholdSeconds: number): Promise<OrchestrationTaskRecord[]> {
    if (thresholdSeconds <= 0) {
      return [];
    }

    const state = await this.deps.loadState();
    const now = this.deps.now().getTime();
    return Object.values(state.orchestration.tasks)
      .filter((task) => {
        if (task.status !== "running") {
          return false;
        }

        const reference = task.lastProgressAt ?? task.createdAt;
        const elapsed = (now - new Date(reference).getTime()) / 1000;
        return elapsed >= thresholdSeconds;
      })
      .map((task) => ({ ...task }));
  }

  private matchesFilter(task: OrchestrationTaskRecord, filter?: OrchestrationTaskFilter): boolean {
    if (!filter) {
      return true;
    }

    return (
      (filter.sourceHandle === undefined || task.sourceHandle === filter.sourceHandle) &&
      (filter.coordinatorSession === undefined ||
        sameCoordinatorSession(task.coordinatorSession, filter.coordinatorSession)) &&
      (filter.workspace === undefined || task.workspace === filter.workspace) &&
      (filter.targetAgent === undefined || task.targetAgent === filter.targetAgent) &&
      (filter.role === undefined || task.role === filter.role) &&
      (filter.status === undefined || task.status === filter.status)
    );
  }

  private removeEmptyGroupsForCoordinator(state: AppState, coordinatorSession: string): boolean {
    const groups = this.kernel.ensureGroups(state);
    const referencedGroupIds = new Set(
      Object.values(state.orchestration.tasks)
        .map((task) => task.groupId)
        .filter((groupId): groupId is string => typeof groupId === "string"),
    );
    let removedAny = false;
    for (const [groupId, group] of Object.entries(groups)) {
      if (!sameCoordinatorSession(group.coordinatorSession, coordinatorSession)) {
        continue;
      }
      if (!referencedGroupIds.has(groupId)) {
        delete groups[groupId];
        removedAny = true;
      }
    }
    return removedAny;
  }

  private removeCoordinatorMetadataIfUnused(state: AppState, coordinatorSession: string): boolean {
    const key = stableCoordinatorSession(coordinatorSession);
    const hasCoordinatorTasks = Object.values(state.orchestration.tasks).some((task) =>
      sameCoordinatorSession(task.coordinatorSession, coordinatorSession),
    );
    const hasCoordinatorBindings = Object.values(state.orchestration.workerBindings).some((binding) =>
      sameCoordinatorSession(binding.coordinatorSession, coordinatorSession),
    );
    if (hasCoordinatorTasks || hasCoordinatorBindings) {
      return false;
    }

    let removedAny = false;

    const packages = this.kernel.ensureHumanQuestionPackages(state);
    for (const [packageId, packageRecord] of Object.entries(packages)) {
      if (sameCoordinatorSession(packageRecord.coordinatorSession, coordinatorSession)) {
        delete packages[packageId];
        removedAny = true;
      }
    }

    if (state.orchestration.coordinatorQuestionState?.[key] !== undefined) {
      delete state.orchestration.coordinatorQuestionState[key];
      removedAny = true;
    }

    if (state.orchestration.coordinatorRoutes?.[key] !== undefined) {
      delete state.orchestration.coordinatorRoutes[key];
      removedAny = true;
    }

    return removedAny;
  }
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}
