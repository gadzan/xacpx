// src/orchestration/service/rpc-delegation-service.ts
// RPC-delegation leaf service: the `requestDelegateFromRpc` entry point that turns an
// agent- or coordinator-originated delegation RPC into a persisted task, plus the
// detached `runAutoRunRpcWorkerTask` startup chain that ensures the worker session and
// dispatches the coordinator (autoRun) turn. Takes two collaborators (the kernel and
// WorkerSessionManager).
//
// `requestDelegateFromRpc` opens `kernel.mutate` more than once, and the kernel's mutate
// is non-reentrant. The autoRun dispatch fires as a detached `void
// this.runAutoRunRpcWorkerTask(...)` OUTSIDE every critical section: that method opens its
// own `mutate`, so a promise created and chained inside a mutate would inherit the
// AsyncLocalStorage store and throw. Do not add `await`, remove `void`, add `.catch()`, or
// merge/relocate a mutate.
import type { AppState } from "../../state/types";
import type {
  OrchestrationSourceKind,
  OrchestrationTaskRecord,
  OrchestrationTaskStatus,
} from "../orchestration-types";
import type {
  OrchestrationServiceDeps,
  RequestDelegateRpcInput,
  RequestDelegateRpcResult,
} from "../orchestration-service";
import { sameCoordinatorSession, stableCoordinatorSession } from "../coordinator-identity";
import type { OrchestrationStateKernel } from "./orchestration-state-kernel";
import type { WorkerSessionManager } from "./worker-session-manager";

export type RpcDelegationDeps = Pick<
  OrchestrationServiceDeps,
  "now" | "createId" | "loadState" | "saveState" | "config" | "dispatchWorkerTask"
>;

export class RpcDelegationService {
  constructor(
    private readonly deps: RpcDelegationDeps,
    private readonly kernel: OrchestrationStateKernel,
    private readonly workerSessions: WorkerSessionManager,
  ) {}

  async requestDelegateFromRpc(input: RequestDelegateRpcInput): Promise<RequestDelegateRpcResult> {
    this.validateRpcRequest(input);

    const preflight = await this.kernel.mutate(async () => {
      const state = await this.deps.loadState();
      const sourceContext = this.resolveRpcSourceContext(state, input.sourceHandle);
      const targetLocation = this.resolveRpcTargetLocation(sourceContext, input.cwd);
      const role = this.workerSessions.normalizeRole(input.role);
      this.assertRpcRequestAllowed(
        state,
        sourceContext.sourceKind,
        sourceContext.coordinatorSession,
        input.targetAgent,
        role,
      );
      const normalizedGroupId = this.kernel.normalizeGroupId(input.groupId);
      if (normalizedGroupId) {
        this.kernel.assertGroupOwnership(
          this.kernel.ensureGroups(state)[normalizedGroupId],
          normalizedGroupId,
          sourceContext.coordinatorSession,
        );
      }
      return { sourceContext, targetLocation, role, normalizedGroupId };
    });

    // Coordinator-originated RPC delegation is treated as authorized: the human
    // already approved the coordinator turn, so chained requests from that
    // turn dispatch immediately. Worker-originated chains still require
    // explicit approval.
    const autoRun = preflight.sourceContext.sourceKind === "coordinator";

    const taskId = this.deps.createId();
    const workerSessionName = await this.workerSessions.resolveWorkerSession({
      sourceHandle: input.sourceHandle,
      sourceKind: preflight.sourceContext.sourceKind,
      coordinatorSession: preflight.sourceContext.coordinatorSession,
      workspace: preflight.targetLocation.workspace,
      ...(preflight.targetLocation.cwd ? { cwd: preflight.targetLocation.cwd } : {}),
      targetAgent: input.targetAgent,
      task: input.task,
      ...(preflight.role ? { role: preflight.role } : {}),
      ...(input.parallel ? { parallel: true } : {}),
    });

    // Parallel gate (coordinator/autoRun path only): when the agent is at capacity,
    // persist the task as "queued" and return immediately — no reservation, no
    // ensureReservedWorkerSession, no dispatchWorkerTask.
    // Worker-sourced (autoRun === false) parallel tasks are NOT gated here because
    // they hold no session yet; the gate runs in approveTask instead.
    if (input.parallel && autoRun) {
      const queuedResult = await this.kernel.mutate(async () => {
        const state = await this.deps.loadState();
        if (this.workerSessions.canStartParallelTask(state, input.targetAgent)) {
          // Slot available — increment the pending counter atomically with this
          // mutate so that concurrent gate checks see this slot as taken until
          // the task is persisted as `running` in the inner mutate below.
          this.workerSessions.claimParallelStart(input.targetAgent);
          return null; // capacity available — fall through to normal start
        }
        const now = this.deps.now().toISOString();
        const queuedTask: OrchestrationTaskRecord = {
          taskId,
          sourceHandle: input.sourceHandle,
          sourceKind: preflight.sourceContext.sourceKind,
          coordinatorSession: preflight.sourceContext.coordinatorSession,
          // `workerSession` here is the *intended* ephemeral session name only —
          // it is NOT reserved or ensured yet, and no acpx session exists for it
          // while the task is queued. The future queue-drain path must call
          // reserveProposedWorkerSession + ensureReservedWorkerSession on it
          // before dispatching.
          workerSession: workerSessionName,
          workspace: preflight.targetLocation.workspace,
          ...(preflight.targetLocation.cwd ? { cwd: preflight.targetLocation.cwd } : {}),
          targetAgent: input.targetAgent,
          ...(preflight.role ? { role: preflight.role } : {}),
          ...(preflight.normalizedGroupId ? { groupId: preflight.normalizedGroupId } : {}),
          task: input.task,
          status: "queued",
          ephemeralWorkerSession: true,
          summary: "",
          resultText: "",
          createdAt: now,
          updatedAt: now,
          eventSeq: 1,
          events: [{ seq: 1, at: now, type: "created", status: "queued", message: "Task queued at parallel capacity" }],
        };
        state.orchestration.tasks[taskId] = queuedTask;
        await this.deps.saveState(state);
        return { taskId, status: "queued" as const, workerSession: workerSessionName };
      });
      if (queuedResult) {
        this.kernel.logEvent("orchestration.task.queued", "parallel task queued at capacity", { taskId, targetAgent: input.targetAgent });
        return queuedResult;
      }
    }

    // Decrement the pending-parallel-start counter on completion (success or
    // error). Only applicable when parallel + autoRun (that is when we incremented
    // above). The counter is released once the task is persisted or on any error.
    const releasePendingParallelStart = (input.parallel && autoRun)
      ? () => {
          this.workerSessions.releaseParallelStart(input.targetAgent);
        }
      : undefined;

    let prepared: {
      task: OrchestrationTaskRecord;
      status: OrchestrationTaskStatus;
      previousBinding?: AppState["orchestration"]["workerBindings"][string];
      normalizedGroupId?: string;
    };

    const releaseWorkerReservation = await this.workerSessions.reserveProposedWorkerSession(workerSessionName);
    try {
      try {
        prepared = await this.kernel.mutate(async () => {
          const state = await this.deps.loadState();
          this.assertRpcRequestAllowed(
            state,
            preflight.sourceContext.sourceKind,
            preflight.sourceContext.coordinatorSession,
            input.targetAgent,
            preflight.role,
          );
          const now = this.deps.now().toISOString();
          const status: OrchestrationTaskStatus = autoRun ? "running" : "needs_confirmation";
          const task: OrchestrationTaskRecord = {
            taskId,
            sourceHandle: input.sourceHandle,
            sourceKind: preflight.sourceContext.sourceKind,
            coordinatorSession: preflight.sourceContext.coordinatorSession,
            workerSession: workerSessionName,
            workspace: preflight.targetLocation.workspace,
            ...(preflight.targetLocation.cwd ? { cwd: preflight.targetLocation.cwd } : {}),
            targetAgent: input.targetAgent,
            ...(preflight.role ? { role: preflight.role } : {}),
            ...(preflight.normalizedGroupId ? { groupId: preflight.normalizedGroupId } : {}),
            task: input.task,
            status,
            summary: "",
            resultText: "",
            createdAt: now,
            updatedAt: now,
            eventSeq: 1,
            events: [{ seq: 1, at: now, type: "created", status, message: "Task created" }],
            ...(input.parallel ? { ephemeralWorkerSession: true } : {}),
          };

          if (preflight.normalizedGroupId) {
            const group = this.kernel.ensureGroups(state)[preflight.normalizedGroupId]!;
            group.updatedAt = now;
            group.coordinatorInjectedAt = undefined;
            group.injectionPending = undefined;
            group.injectionAppliedAt = undefined;
            group.lastInjectionError = undefined;
          }
          let previousBinding: AppState["orchestration"]["workerBindings"][string] | undefined;
          if (autoRun) {
            previousBinding = state.orchestration.workerBindings[workerSessionName];
            this.workerSessions.assertWorkerSessionDoesNotConflictExternalCoordinator(state, workerSessionName);
            this.workerSessions.assertWorkerSessionAvailable(state, workerSessionName, undefined, { allowCurrentReservation: true });
            state.orchestration.tasks[taskId] = task;
            state.orchestration.workerBindings[workerSessionName] = {
              sourceHandle: workerSessionName,
              coordinatorSession: preflight.sourceContext.coordinatorSession,
              workspace: preflight.targetLocation.workspace,
              ...(preflight.targetLocation.cwd ? { cwd: preflight.targetLocation.cwd } : {}),
              targetAgent: input.targetAgent,
              role: preflight.role,
              ...(input.parallel ? { ephemeral: true } : {}),
            };
          } else {
            this.workerSessions.assertWorkerSessionDoesNotConflictExternalCoordinator(state, workerSessionName);
            this.workerSessions.assertWorkerSessionAvailable(state, workerSessionName, undefined, { allowCurrentReservation: true });
            state.orchestration.tasks[taskId] = task;
          }
          await this.deps.saveState(state);

          return { task: { ...task }, status, previousBinding, normalizedGroupId: preflight.normalizedGroupId };
        });
      } catch (error) {
        await releaseWorkerReservation();
        throw error;
      }
      await releaseWorkerReservation();
    } finally {
      // The pending-start slot is consumed once the task is persisted or on error.
      releasePendingParallelStart?.();
    }

    if (autoRun) {
      void this.runAutoRunRpcWorkerTask({
        task: prepared.task,
        previousBinding: prepared.previousBinding,
      });
    }

    this.kernel.logEvent(
      "orchestration.task.created",
      "delegated task created",
      this.kernel.taskContext(prepared.task),
    );

    return {
      taskId: prepared.task.taskId,
      status: prepared.status as RequestDelegateRpcResult["status"],
      ...(autoRun ? { workerSession: workerSessionName } : {}),
    };
  }

  private async runAutoRunRpcWorkerTask(input: {
    task: OrchestrationTaskRecord;
    previousBinding?: AppState["orchestration"]["workerBindings"][string];
  }): Promise<void> {
    const { task } = input;
    try {
      const ensuredWorkerSession = await this.workerSessions.ensureReservedWorkerSession({
        workerSession: task.workerSession!,
        sourceHandle: task.sourceHandle,
        sourceKind: task.sourceKind,
        coordinatorSession: task.coordinatorSession,
        workspace: task.workspace,
        ...(task.cwd ? { cwd: task.cwd } : {}),
        targetAgent: task.targetAgent,
        ...(task.role ? { role: task.role } : {}),
      });
      const startupAction = await this.kernel.mutate(async () => {
        const state = await this.deps.loadState();
        const current = state.orchestration.tasks[task.taskId];
        if (
          current?.workerSession === ensuredWorkerSession &&
          current.status === "running" &&
          current.cancelRequestedAt !== undefined
        ) {
          return "completeCancellation" as const;
        }
        return current !== undefined &&
          current.workerSession === ensuredWorkerSession &&
          current.status === "running"
          ? "dispatch" as const
          : "skip" as const;
      });
      if (startupAction === "completeCancellation") {
        const completed = await this.completeAutoRunStartupCancellation({
          task,
          previousBinding: input.previousBinding,
        });
        if (completed) {
          this.kernel.logEvent("orchestration.task.cancel_completed", "task cancellation completed", {
            ...this.kernel.taskContext(task),
            status: "cancelled",
          });
        }
        return;
      }
      if (startupAction !== "dispatch") {
        await this.cleanupAutoRunStartupBinding({
          task,
          previousBinding: input.previousBinding,
        });
        return;
      }
      const preDispatchAction = await this.kernel.mutate(async () => {
        const state = await this.deps.loadState();
        const current = state.orchestration.tasks[task.taskId];
        if (
          current?.workerSession === ensuredWorkerSession &&
          current.status === "running" &&
          current.cancelRequestedAt !== undefined
        ) {
          return "completeCancellation" as const;
        }
        return current !== undefined &&
          current.workerSession === ensuredWorkerSession &&
          current.status === "running"
          ? "dispatch" as const
          : "skip" as const;
      });
      if (preDispatchAction === "completeCancellation") {
        const completed = await this.completeAutoRunStartupCancellation({
          task,
          previousBinding: input.previousBinding,
        });
        if (completed) {
          this.kernel.logEvent("orchestration.task.cancel_completed", "task cancellation completed", {
            ...this.kernel.taskContext(task),
            status: "cancelled",
          });
        }
        return;
      }
      if (preDispatchAction !== "dispatch") {
        await this.cleanupAutoRunStartupBinding({
          task,
          previousBinding: input.previousBinding,
        });
        return;
      }
      await this.deps.dispatchWorkerTask({
        taskId: task.taskId,
        workerSession: ensuredWorkerSession,
        coordinatorSession: task.coordinatorSession,
        workspace: task.workspace,
        ...(task.cwd ? { cwd: task.cwd } : {}),
        targetAgent: task.targetAgent,
        ...(task.role ? { role: task.role } : {}),
        task: task.task,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const completedCancellation = await this.completeAutoRunStartupCancellation({
        task,
        previousBinding: input.previousBinding,
      });
      if (completedCancellation) {
        this.kernel.logEvent("orchestration.task.cancel_completed", "task cancellation completed", {
          ...this.kernel.taskContext(task),
          status: "cancelled",
        });
        return;
      }
      const taskMarkedFailed = await this.kernel.mutate(async () => {
        const state = await this.deps.loadState();
        const current = state.orchestration.tasks[task.taskId];
        const workerSession = task.workerSession!;
        const taskStillOwnsWorkerSession = current?.workerSession === workerSession;
        const currentBinding = state.orchestration.workerBindings[workerSession];
        const bindingStillBelongsToThisStartup =
          currentBinding?.sourceHandle === workerSession &&
          sameCoordinatorSession(currentBinding.coordinatorSession, task.coordinatorSession) &&
          currentBinding.workspace === task.workspace &&
          currentBinding.cwd === task.cwd &&
          currentBinding.targetAgent === task.targetAgent &&
          currentBinding.role === task.role;
        const otherActiveOwner = Object.values(state.orchestration.tasks).some((candidate) =>
          candidate.taskId !== task.taskId &&
          candidate.workerSession === workerSession &&
          (!this.kernel.isTerminalStatus(candidate.status) || candidate.reviewPending !== undefined)
        );
        const restoreOrDeleteBinding = () => {
          if (!bindingStillBelongsToThisStartup || otherActiveOwner) {
            return;
          }
          if (input.previousBinding) {
            state.orchestration.workerBindings[workerSession] = input.previousBinding;
          } else {
            delete state.orchestration.workerBindings[workerSession];
          }
        };
        if (current && taskStillOwnsWorkerSession && current.status === "cancelled") {
          restoreOrDeleteBinding();
          await this.deps.saveState(state);
          return false;
        }
        if (
          current &&
          taskStillOwnsWorkerSession &&
          current.cancelRequestedAt === undefined &&
          !this.kernel.isTerminalStatus(current.status)
        ) {
          const now = this.deps.now().toISOString();
          current.status = "failed";
          current.summary = message;
          current.resultText = "";
          current.updatedAt = now;
          this.kernel.appendTaskEvent(current, now, "status_changed", {
            status: "failed",
            summary: message,
            message: "Task failed during startup",
          });
          restoreOrDeleteBinding();
          await this.deps.saveState(state);
          return true;
        }
        await this.deps.saveState(state);
        return false;
      });
      if (taskMarkedFailed) {
        this.kernel.logEvent("orchestration.task.failed", "task failed", {
          ...this.kernel.taskContext(task),
          error: message,
        });
      }
    }
  }

  private async completeAutoRunStartupCancellation(input: {
    task: OrchestrationTaskRecord;
    previousBinding?: AppState["orchestration"]["workerBindings"][string];
  }): Promise<boolean> {
    const { task } = input;
    return await this.kernel.mutate(async () => {
      const state = await this.deps.loadState();
      const workerSession = task.workerSession!;
      const current = state.orchestration.tasks[task.taskId];
      if (
        !current ||
        current.workerSession !== workerSession ||
        current.status !== "running" ||
        current.cancelRequestedAt === undefined
      ) {
        return false;
      }

      const now = this.deps.now().toISOString();
      current.status = "cancelled";
      current.cancelCompletedAt = now;
      current.lastCancelError = undefined;
      current.updatedAt = now;
      this.kernel.bumpGroupUpdated(state, current.groupId, now);

      const currentBinding = state.orchestration.workerBindings[workerSession];
      const bindingStillBelongsToThisStartup =
        currentBinding?.sourceHandle === workerSession &&
        sameCoordinatorSession(currentBinding.coordinatorSession, task.coordinatorSession) &&
        currentBinding.workspace === task.workspace &&
        currentBinding.cwd === task.cwd &&
        currentBinding.targetAgent === task.targetAgent &&
        currentBinding.role === task.role;
      const otherActiveOwner = Object.values(state.orchestration.tasks).some((candidate) =>
        candidate.taskId !== task.taskId &&
        candidate.workerSession === workerSession &&
        (!this.kernel.isTerminalStatus(candidate.status) || candidate.reviewPending !== undefined)
      );
      if (bindingStillBelongsToThisStartup && !otherActiveOwner) {
        if (input.previousBinding) {
          state.orchestration.workerBindings[workerSession] = input.previousBinding;
        } else {
          delete state.orchestration.workerBindings[workerSession];
        }
      }
      await this.deps.saveState(state);
      return true;
    });
  }

  private async cleanupAutoRunStartupBinding(input: {
    task: OrchestrationTaskRecord;
    previousBinding?: AppState["orchestration"]["workerBindings"][string];
  }): Promise<boolean> {
    const { task } = input;
    return await this.kernel.mutate(async () => {
      const state = await this.deps.loadState();
      const workerSession = task.workerSession!;
      const currentBinding = state.orchestration.workerBindings[workerSession];
      const bindingStillBelongsToThisStartup =
        currentBinding?.sourceHandle === workerSession &&
        sameCoordinatorSession(currentBinding.coordinatorSession, task.coordinatorSession) &&
        currentBinding.workspace === task.workspace &&
        currentBinding.cwd === task.cwd &&
        currentBinding.targetAgent === task.targetAgent &&
        currentBinding.role === task.role;
      if (!bindingStillBelongsToThisStartup) {
        return false;
      }
      const otherActiveOwner = Object.values(state.orchestration.tasks).some((candidate) =>
        candidate.taskId !== task.taskId &&
        candidate.workerSession === workerSession &&
        (!this.kernel.isTerminalStatus(candidate.status) || candidate.reviewPending !== undefined)
      );
      if (otherActiveOwner) {
        return false;
      }
      if (input.previousBinding) {
        state.orchestration.workerBindings[workerSession] = input.previousBinding;
      } else {
        delete state.orchestration.workerBindings[workerSession];
      }
      await this.deps.saveState(state);
      return true;
    });
  }

  private resolveRpcSourceContext(
    state: AppState,
    sourceHandle: string,
  ): { sourceKind: OrchestrationSourceKind; coordinatorSession: string; workspace?: string; cwd?: string } {
    const binding = state.orchestration.workerBindings[sourceHandle];
    if (binding) {
      return {
        sourceKind: "worker",
        coordinatorSession: binding.coordinatorSession,
        workspace: binding.workspace,
        ...(binding.cwd ? { cwd: binding.cwd } : {}),
      };
    }

    const coordinatorSession = Object.values(state.sessions).find((session) =>
      sameCoordinatorSession(session.transport_session, sourceHandle),
    );
    if (coordinatorSession) {
      return {
        sourceKind: "coordinator",
        coordinatorSession: stableCoordinatorSession(sourceHandle),
        workspace: coordinatorSession.workspace,
      };
    }

    const externalCoordinator = this.kernel.ensureExternalCoordinators(state)[sourceHandle];
    if (externalCoordinator) {
      return {
        sourceKind: "coordinator",
        coordinatorSession: externalCoordinator.coordinatorSession,
        ...(externalCoordinator.workspace ? { workspace: externalCoordinator.workspace } : {}),
      };
    }

    throw new Error(`sourceHandle "${sourceHandle}" is not a registered coordinator or worker session`);
  }

  private resolveRpcTargetLocation(
    sourceContext: { workspace?: string; cwd?: string },
    rawCwd: string | undefined,
  ): { workspace: string; cwd?: string } {
    const cwd = rawCwd !== undefined ? this.workerSessions.normalizeWorkingDirectory(rawCwd) : sourceContext.cwd;
    if (cwd) {
      return {
        workspace: sourceContext.workspace ?? this.workerSessions.workspaceLabelFromCwd(cwd),
        cwd,
      };
    }
    if (sourceContext.workspace) {
      return { workspace: sourceContext.workspace };
    }
    throw new Error("workingDirectory is required when the external coordinator has no default workspace");
  }

  private assertRpcRequestAllowed(
    state: AppState,
    sourceKind: OrchestrationSourceKind,
    coordinatorSession: string,
    targetAgent: string,
    role: string | undefined,
  ): void {
    const policy = this.deps.config.orchestration;

    if (sourceKind === "worker" && !policy.allowWorkerChainedRequests) {
      throw new Error("worker-originated delegation is disabled by orchestration policy");
    }

    if (policy.allowedAgentRequestTargets.length > 0 && !policy.allowedAgentRequestTargets.includes(targetAgent)) {
      throw new Error(`target agent "${targetAgent}" is not allowed for agent-requested delegation`);
    }

    if (role && policy.allowedAgentRequestRoles.length > 0 && !policy.allowedAgentRequestRoles.includes(role)) {
      throw new Error(`role "${role}" is not allowed for agent-requested delegation`);
    }

    const outstandingRequests = Object.values(state.orchestration.tasks).filter(
      (task) =>
        sameCoordinatorSession(task.coordinatorSession, coordinatorSession) &&
        task.sourceKind !== "human" &&
        // `queued` counts: an accepted, persisted, pending delegation. Omitting it
        // would let a coordinator accumulate unbounded queued tasks at a capped
        // agent and defeat maxPendingAgentRequestsPerCoordinator.
        (task.status === "needs_confirmation" || task.status === "running" || task.status === "queued"),
    );

    if (outstandingRequests.length >= policy.maxPendingAgentRequestsPerCoordinator) {
      throw new Error("agent-requested delegation quota exceeded for this coordinator");
    }
  }

  private validateRpcRequest(input: RequestDelegateRpcInput): void {
    if (input.sourceHandle.trim().length === 0) {
      throw new Error("sourceHandle must be a non-empty string");
    }

    if (input.targetAgent.trim().length === 0) {
      throw new Error("targetAgent must be a non-empty string");
    }

    if (input.task.trim().length === 0) {
      throw new Error("task must be a non-empty string");
    }
  }
}
