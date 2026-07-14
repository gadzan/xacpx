// src/orchestration/service/task-cancellation-service.ts
// Task cancellation lifecycle: request → propagate to the worker → complete or fail.
// Takes two collaborators (WorkerSessionManager, QuestionFlowCore) plus the kernel.
// `reconcileParallelSlots` and the detached `startWorkerCancellation` chain both run
// OUTSIDE the kernel's `mutate` critical section — the kernel guard is non-reentrant,
// so nesting either one would throw on every cancellation.
import { sameCoordinatorSession } from "../coordinator-identity";
import type { OrchestrationTaskRecord } from "../orchestration-types";
import type { CancelTaskInput, OrchestrationServiceDeps } from "../orchestration-service";
import type { OrchestrationStateKernel } from "./orchestration-state-kernel";
import type { QuestionFlowCore } from "./question-flow-core";
import type { WorkerSessionManager } from "./worker-session-manager";

export type TaskCancellationDeps = Pick<
  OrchestrationServiceDeps,
  | "now"
  | "createId"
  | "loadState"
  | "saveState"
  | "cancelWorkerTask"
  | "interruptWorkerTask"
  | "wakeCoordinatorSession"
>;

export class TaskCancellationService {
  constructor(
    private readonly deps: TaskCancellationDeps,
    private readonly kernel: OrchestrationStateKernel,
    private readonly workerSessions: WorkerSessionManager,
    private readonly questionFlow: QuestionFlowCore,
  ) {}

  async cancelTask(input: CancelTaskInput): Promise<OrchestrationTaskRecord> {
    return await this.requestTaskCancellation(input);
  }

  async requestTaskCancellation(input: CancelTaskInput): Promise<OrchestrationTaskRecord> {
    const { task, shouldPropagate } = await this.applyCancellationRequest(input);
    if (shouldPropagate) {
      // Detached, bare, unawaited on purpose: this fires a chain that opens its own mutate,
      // so it must stay outside every critical section. It is fired LAST (after applyCancellationRequest's
      // awaited tail) so a group caller can log group.cancelled before any chain begins.
      this.startWorkerCancellation(task);
    }
    return task;
  }

  /** The awaited, deterministic half of a cancellation: state transition + cancel_requested log +
   *  queued-question handoff + post-terminal reconcile — WITHOUT firing the detached
   *  startWorkerCancellation chain. `requestTaskCancellation` fires it right after; `cancelGroup`
   *  fires it AFTER its group.cancelled log so the log/save order is provable, not hop-lucky (#150). */
  async applyCancellationRequest(input: CancelTaskInput): Promise<{ task: OrchestrationTaskRecord; shouldPropagate: boolean }> {
    const prepared = await this.kernel.mutate(async () => {
      const state = await this.deps.loadState();
      const task = state.orchestration.tasks[input.taskId];
      if (!task) {
        throw new Error(`task "${input.taskId}" does not exist`);
      }

      if (input.sourceHandle === undefined && input.coordinatorSession === undefined) {
        throw new Error(`task "${input.taskId}" cancel request must include sourceHandle or coordinatorSession`);
      }

      if (input.sourceHandle !== undefined && task.sourceHandle !== input.sourceHandle) {
        throw new Error(
          `task "${input.taskId}" belongs to source "${task.sourceHandle}", not "${input.sourceHandle}"`,
        );
      }

      if (
        input.coordinatorSession !== undefined &&
        !sameCoordinatorSession(task.coordinatorSession, input.coordinatorSession)
      ) {
        throw new Error(
          `task "${input.taskId}" belongs to coordinator "${task.coordinatorSession}", not "${input.coordinatorSession}"`,
        );
      }

      if (this.kernel.isTerminalStatus(task.status)) {
        return { task: { ...task }, shouldPropagate: false, closedPackageId: undefined as string | undefined };
      }

      const now = this.deps.now().toISOString();

      if (task.status === "running") {
        const shouldPropagate = task.cancelRequestedAt === undefined;
        task.cancelRequestedAt = task.cancelRequestedAt ?? now;
        task.updatedAt = now;
        if (shouldPropagate) {
          this.kernel.appendTaskEvent(task, now, "cancel_requested", {
            status: task.status,
            message: "Cancellation requested",
          });
        }
        this.kernel.bumpGroupUpdated(state, task.groupId, now);
        await this.deps.saveState(state);
        return { task: { ...task }, shouldPropagate, closedPackageId: undefined as string | undefined };
      }

      const closedPackageId = this.questionFlow.detachTaskFromQuestionFlows(state, task, now);
      const wasNeedsConfirmation = task.status === "needs_confirmation";
      task.status = "cancelled";
      if (wasNeedsConfirmation && task.summary.trim().length === 0) {
        task.summary = "rejected";
      }
      task.openQuestion = undefined;
      task.cancelRequestedAt = task.cancelRequestedAt ?? now;
      task.cancelCompletedAt = now;
      task.lastCancelError = undefined;
      task.updatedAt = now;
      this.kernel.appendTaskEvent(task, now, "status_changed", {
        status: "cancelled",
        message: "Task cancelled",
      });
      this.kernel.bumpGroupUpdated(state, task.groupId, now);
      await this.deps.saveState(state);
      return { task: { ...task }, shouldPropagate: false, closedPackageId };
    });

    this.kernel.logEvent(
      "orchestration.task.cancel_requested",
      "task cancellation requested",
      this.kernel.taskContext(prepared.task),
    );

    if (prepared.closedPackageId) {
      await this.questionFlow.handoffQueuedQuestions(prepared.task.coordinatorSession, prepared.closedPackageId);
    }

    // I-2: non-running cancel transitions directly to a terminal state without launchWorkerTurn.
    // Fire reconcile so the ephemeral acpx session closes and queued parallel tasks drain.
    if (!prepared.shouldPropagate && this.kernel.isTerminalStatus(prepared.task.status)) {
      try {
        await this.workerSessions.reconcileParallelSlots();
      } catch (error) {
        this.kernel.logEvent("orchestration.parallel.reconcile_failed", "reconcile failed after non-running cancel", {
          taskId: prepared.task.taskId,
          message: error instanceof Error ? error.message : String(error),
        });
      }
    }

    return { task: prepared.task, shouldPropagate: prepared.shouldPropagate };
  }

  async completeTaskCancellation(taskId: string): Promise<OrchestrationTaskRecord> {
    const prepared = await this.kernel.mutate(async () => {
      const state = await this.deps.loadState();
      const task = state.orchestration.tasks[taskId];
      if (!task) {
        throw new Error(`task "${taskId}" does not exist`);
      }

      if (this.kernel.isTerminalStatus(task.status)) {
        return { task: { ...task } };
      }

      const now = this.deps.now().toISOString();
      let replacementQuestionId: string | undefined;
      if (task.correctionPending?.reason === "misrouted_answer") {
        replacementQuestionId = this.deps.createId();
        const packageId = this.questionFlow.reopenActiveHumanPackageForTask(state, task, now);
        task.status = packageId ? "waiting_for_human" : "blocked";
        task.openQuestion = this.questionFlow.buildReplacementOpenQuestion(task, replacementQuestionId, now, packageId);
        task.correctionPending = undefined;
        task.cancelRequestedAt = undefined;
        task.cancelCompletedAt = undefined;
        task.lastCancelError = undefined;
        this.kernel.appendTaskEvent(task, now, "attention_required", {
          status: task.status,
          message: task.openQuestion.question,
        });
      } else {
        task.status = "cancelled";
        task.cancelCompletedAt = now;
        task.lastCancelError = undefined;
        this.kernel.appendTaskEvent(task, now, "status_changed", {
          status: "cancelled",
          message: "Task cancelled",
        });
      }
      task.updatedAt = now;
      this.kernel.bumpGroupUpdated(state, task.groupId, now);
      await this.deps.saveState(state);
      return {
        task: { ...task },
        replacementQuestionId,
        externalCoordinator: this.kernel.isExternalCoordinatorSession(state, task.coordinatorSession),
      };
    });

    if (prepared.replacementQuestionId) {
      this.kernel.logEvent("orchestration.task.correction_reopened", "task correction reopened blocker", {
        ...this.kernel.taskContext(prepared.task),
        replacement_question_id: prepared.replacementQuestionId,
      });
      if (!prepared.externalCoordinator) {
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
      return prepared.task;
    }

    this.kernel.logEvent(
      "orchestration.task.cancel_completed",
      "task cancellation completed",
      this.kernel.taskContext(prepared.task),
    );

    // I-2: running-task cancel completes here. Fire reconcile so the ephemeral acpx
    // session is closed promptly and queued parallel tasks can drain.
    try {
      await this.workerSessions.reconcileParallelSlots();
    } catch (error) {
      this.kernel.logEvent("orchestration.parallel.reconcile_failed", "reconcile failed after cancel completion", {
        taskId: prepared.task.taskId,
        message: error instanceof Error ? error.message : String(error),
      });
    }

    return prepared.task;
  }

  async failTaskCancellation(taskId: string, errorMessage: string): Promise<OrchestrationTaskRecord> {
    const task = await this.kernel.mutate(async () => {
      const state = await this.deps.loadState();
      const task = state.orchestration.tasks[taskId];
      if (!task) {
        throw new Error(`task "${taskId}" does not exist`);
      }

      if (this.kernel.isTerminalStatus(task.status)) {
        return { ...task };
      }

      task.lastCancelError = errorMessage;
      task.updatedAt = this.deps.now().toISOString();
      this.kernel.appendTaskEvent(task, task.updatedAt, "progress", {
        status: task.status,
        message: `Cancellation failed: ${errorMessage}`,
      });
      await this.deps.saveState(state);
      return { ...task };
    });

    this.kernel.logEvent("orchestration.task.cancel_failed", "task cancellation failed", {
      ...this.kernel.taskContext(task),
      error: errorMessage,
    });

    return task;
  }

  startWorkerCancellation(task: OrchestrationTaskRecord): void {
    const resolveCancelFn =
      task.correctionPending?.reason === "misrouted_answer"
        ? () => this.deps.interruptWorkerTask ?? this.deps.cancelWorkerTask
        : () => this.deps.cancelWorkerTask;
    if (!task.workerSession || !resolveCancelFn()) {
      void (async () => {
        try {
          await this.completeTaskCancellation(task.taskId);
        } catch (error) {
          this.kernel.logEvent("orchestration.task.cancel_early_fail", "early cancellation completion failed", {
            task_id: task.taskId,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      })();
      return;
    }

    void (async () => {
      try {
        // Re-read the task from current state to avoid stale workerSession
        const state = await this.deps.loadState();
        const freshTask = state.orchestration.tasks[task.taskId];
        if (!freshTask || !freshTask.workerSession) {
          await this.completeTaskCancellation(task.taskId);
          return;
        }
        const cancelFn = resolveCancelFn();
        if (!cancelFn) {
          await this.completeTaskCancellation(task.taskId);
          return;
        }
        await cancelFn({
          taskId: task.taskId,
          workerSession: freshTask.workerSession,
          workspace: freshTask.workspace,
          ...(freshTask.cwd ? { cwd: freshTask.cwd } : {}),
          targetAgent: freshTask.targetAgent,
        });
        await this.completeTaskCancellation(task.taskId);
      } catch (error) {
        await this.failTaskCancellation(task.taskId, error instanceof Error ? error.message : String(error));
      }
    })();
  }
}
