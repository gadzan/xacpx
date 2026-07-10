// src/orchestration/service/task-approval-service.ts
// Task-approval leaf service: the `approveTask` state machine that turns a
// `needs_confirmation` task into a `running` one (or a `queued` one when the target
// agent is at parallel capacity), reserving and ensuring the worker session and
// dispatching the worker turn. Takes three collaborators (WorkerSessionManager,
// QuestionFlowCore, TaskLifecycleService) plus the kernel.
//
// `approveTask` opens `kernel.mutate` more than once and the kernel's mutate is
// non-reentrant. The expensive work — reserveProposedWorkerSession,
// ensureReservedWorkerSession, dispatchWorkerTask — deliberately sits OUTSIDE the
// critical sections (a comment in the body says so). Do not merge or relocate a mutate.
import type { AppState } from "../../state/types";
import type {
  OrchestrationTaskRecord,
  OrchestrationTaskStatus,
} from "../orchestration-types";
import type {
  ConfirmTaskInput,
  OrchestrationServiceDeps,
} from "../orchestration-service";
import type { OrchestrationStateKernel } from "./orchestration-state-kernel";
import type { QuestionFlowCore } from "./question-flow-core";
import type { TaskLifecycleService } from "./task-lifecycle-service";
import type { WorkerSessionManager } from "./worker-session-manager";

export type TaskApprovalDeps = Pick<
  OrchestrationServiceDeps,
  "now" | "loadState" | "saveState" | "dispatchWorkerTask"
>;

export class TaskApprovalService {
  constructor(
    private readonly deps: TaskApprovalDeps,
    private readonly kernel: OrchestrationStateKernel,
    private readonly workerSessions: WorkerSessionManager,
    private readonly questionFlow: QuestionFlowCore,
    private readonly lifecycle: TaskLifecycleService,
  ) {}

  async approveTask(input: ConfirmTaskInput): Promise<OrchestrationTaskRecord> {
    // Pre-check outside the mutex as a fail-fast gate.  The snapshot may be stale
    // by the time we acquire the lock (e.g. a concurrent cancellation), but this
    // avoids entering the mutex — and the expensive ensureWorkerSession I/O — for
    // obviously invalid requests.  Ownership and status are re-validated inside
    // the mutex below.
    const currentTask = await this.lifecycle.getTask(input.taskId);
    if (!currentTask) {
      throw new Error(`task "${input.taskId}" does not exist`);
    }
    this.questionFlow.assertCoordinatorOwnership(currentTask, input.coordinatorSession);
    this.assertNeedsConfirmation(currentTask);

    const workerSession =
      currentTask.workerSession ??
      (await this.workerSessions.resolveWorkerSession({
        sourceHandle: currentTask.sourceHandle,
        sourceKind: currentTask.sourceKind,
        coordinatorSession: currentTask.coordinatorSession,
        workspace: currentTask.workspace,
        ...(currentTask.cwd ? { cwd: currentTask.cwd } : {}),
        targetAgent: currentTask.targetAgent,
        task: currentTask.task,
        ...(currentTask.role ? { role: currentTask.role } : {}),
      }));

    // Parallel gate: if this is a parallel `needs_confirmation` task and the agent
    // is at capacity, queue it instead of starting it. This gate covers parallel
    // tasks regardless of source — both human-initiated and worker-sourced — since
    // any `needs_confirmation` parallel task funnels through approveTask. It
    // complements the requestDelegateFromRpc gate, which is coordinator/autoRun-only
    // (those tasks never enter `needs_confirmation`). We check here, before
    // ensureReservedWorkerSession and dispatch, so those expensive operations are
    // skipped for queued tasks.
    if (currentTask.ephemeralWorkerSession === true) {
      const queuedResult = await this.kernel.mutate(async () => {
        const state = await this.deps.loadState();
        const task = state.orchestration.tasks[input.taskId];
        if (!task) {
          throw new Error(`task "${input.taskId}" does not exist`);
        }
        this.questionFlow.assertCoordinatorOwnership(task, input.coordinatorSession);
        this.assertNeedsConfirmation(task);
        if (this.workerSessions.canStartParallelTask(state, task.targetAgent)) {
          return null; // capacity available — fall through to normal start
        }
        const now = this.deps.now().toISOString();
        // Defensive no-op: a parallel task's workerSession is already set at
        // creation time. Re-assigning here future-proofs the path for any caller
        // that reaches approveTask with an unset workerSession.
        task.workerSession = workerSession;
        task.status = "queued";
        task.updatedAt = now;
        this.kernel.appendTaskEvent(task, now, "status_changed", {
          status: "queued",
          message: "Task queued at parallel capacity",
        });
        await this.deps.saveState(state);
        return { ...task };
      });
      if (queuedResult) {
        this.kernel.logEvent("orchestration.task.queued", "parallel task queued at capacity on approve", { taskId: input.taskId, targetAgent: currentTask.targetAgent });
        return queuedResult;
      }
    }

    const releaseWorkerReservation = await this.workerSessions.reserveProposedWorkerSession(workerSession, input.taskId);
    let ensuredWorkerSession = workerSession;
    let prepared: {
      task: OrchestrationTaskRecord;
      previousStatus: OrchestrationTaskStatus;
      previousUpdatedAt: string;
      previousWorkerSession?: string;
      previousBinding?: AppState["orchestration"]["workerBindings"][string];
    };
    try {
      ensuredWorkerSession = await this.workerSessions.ensureReservedWorkerSession({
        workerSession,
        sourceHandle: currentTask.sourceHandle,
        sourceKind: currentTask.sourceKind,
        coordinatorSession: currentTask.coordinatorSession,
        workspace: currentTask.workspace,
        ...(currentTask.cwd ? { cwd: currentTask.cwd } : {}),
        targetAgent: currentTask.targetAgent,
        role: currentTask.role,
      });
      prepared = await this.kernel.mutate(async () => {
        const state = await this.deps.loadState();
        const task = state.orchestration.tasks[input.taskId];
        if (!task) {
          throw new Error(`task "${input.taskId}" does not exist`);
        }
        this.questionFlow.assertCoordinatorOwnership(task, input.coordinatorSession);
        this.assertNeedsConfirmation(task);
        const previousStatus = task.status;
        const previousUpdatedAt = task.updatedAt;
        const previousWorkerSession = task.workerSession;
        const previousBinding = state.orchestration.workerBindings[ensuredWorkerSession];
        this.workerSessions.assertWorkerSessionDoesNotConflictExternalCoordinator(state, ensuredWorkerSession);
        this.workerSessions.assertWorkerSessionAvailable(state, ensuredWorkerSession, input.taskId, { allowCurrentReservation: true });
        task.workerSession = ensuredWorkerSession;
        task.status = "running";
        task.updatedAt = this.deps.now().toISOString();
        this.kernel.appendTaskEvent(task, task.updatedAt, "status_changed", {
          status: "running",
          message: "Task approved",
        });
        state.orchestration.workerBindings[ensuredWorkerSession] = {
          sourceHandle: ensuredWorkerSession,
          coordinatorSession: task.coordinatorSession,
          workspace: task.workspace,
          ...(task.cwd ? { cwd: task.cwd } : {}),
          targetAgent: task.targetAgent,
          role: task.role,
          ...(task.ephemeralWorkerSession ? { ephemeral: true } : {}),
        };

        await this.deps.saveState(state);

        return {
          task: { ...task },
          previousStatus,
          previousUpdatedAt,
          previousWorkerSession,
          previousBinding,
        };
      });
    } catch (error) {
      await releaseWorkerReservation();
      throw error;
    }
    await releaseWorkerReservation();

    try {
      await this.deps.dispatchWorkerTask({
        taskId: prepared.task.taskId,
        workerSession: ensuredWorkerSession,
        coordinatorSession: prepared.task.coordinatorSession,
        workspace: prepared.task.workspace,
        ...(prepared.task.cwd ? { cwd: prepared.task.cwd } : {}),
        targetAgent: prepared.task.targetAgent,
        ...(prepared.task.role ? { role: prepared.task.role } : {}),
        task: prepared.task.task,
      });
    } catch (error) {
      await this.kernel.mutate(async () => {
        const state = await this.deps.loadState();
        const task = state.orchestration.tasks[input.taskId];
        if (task) {
          task.status = prepared.previousStatus;
          task.updatedAt = prepared.previousUpdatedAt;
          if (prepared.previousWorkerSession === undefined) {
            delete task.workerSession;
          } else {
            task.workerSession = prepared.previousWorkerSession;
          }
        }
        if (prepared.previousBinding) {
          state.orchestration.workerBindings[ensuredWorkerSession] = prepared.previousBinding;
        } else {
          delete state.orchestration.workerBindings[ensuredWorkerSession];
        }
        await this.deps.saveState(state);
      });
      throw error;
    }

    this.kernel.logEvent("orchestration.task.approved", "task approved", this.kernel.taskContext(prepared.task));

    return prepared.task;
  }

  private assertNeedsConfirmation(task: OrchestrationTaskRecord): void {
    if (task.status !== "needs_confirmation") {
      throw new Error(`task "${task.taskId}" is ${task.status}, not needs_confirmation`);
    }
  }
}
