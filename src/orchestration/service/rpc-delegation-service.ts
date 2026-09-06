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
import {
  teardownStagedWorkerOwner,
  workerBindingEndpointIdentityFields,
  workerBindingGuardFields,
  workerBindingIdentityFields,
} from "../worker-launch";
import type { StagedWorkerIdentity } from "../worker-launch";
import type { WorkerSessionManager } from "./worker-session-manager";
import { releaseWorkerRetirement } from "../worker-binding-retirement";

export type RpcDelegationDeps = Pick<
  OrchestrationServiceDeps,
  | "now"
  | "createId"
  | "createAgentEndpointId"
  | "loadState"
  | "saveState"
  | "config"
  | "dispatchWorkerTask"
  | "resolveWorkerBindingEngine"
  | "releaseWorkerSession"
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
      stagedIdentity?: StagedWorkerIdentity;
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
          let stagedIdentity: StagedWorkerIdentity | undefined;
          if (autoRun) {
            previousBinding = state.orchestration.workerBindings[workerSessionName];
            this.workerSessions.assertWorkerSessionDoesNotConflictExternalCoordinator(state, workerSessionName);
            this.workerSessions.assertWorkerSessionAvailable(state, workerSessionName, undefined, { allowCurrentReservation: true });
            // First binding MUST already carry LID + physical-group engine
            // BEFORE the detached startup chain can ensure an owner: a crash
            // between this save and the async identity top-up would otherwise
            // restart as a misbound legacy CLI record.
            const identity = workerBindingIdentityFields(
              previousBinding,
              () => this.deps.resolveWorkerBindingEngine({
                workerSession: workerSessionName,
                targetAgent: input.targetAgent,
                workspace: preflight.targetLocation.workspace,
                ...(preflight.targetLocation.cwd ? { cwd: preflight.targetLocation.cwd } : {}),
              }),
              this.deps.createId,
            );
            state.orchestration.tasks[taskId] = task;
            state.orchestration.workerBindings[workerSessionName] = {
              sourceHandle: workerSessionName,
              coordinatorSession: preflight.sourceContext.coordinatorSession,
              workspace: preflight.targetLocation.workspace,
              ...(preflight.targetLocation.cwd ? { cwd: preflight.targetLocation.cwd } : {}),
              targetAgent: input.targetAgent,
              role: preflight.role,
              ...workerBindingGuardFields(previousBinding),
              ...workerBindingEndpointIdentityFields(previousBinding, this.deps.createAgentEndpointId),
              ...identity,
              ...(input.parallel ? { ephemeral: true } : {}),
            };
            stagedIdentity = identity;
          } else {
            this.workerSessions.assertWorkerSessionDoesNotConflictExternalCoordinator(state, workerSessionName);
            this.workerSessions.assertWorkerSessionAvailable(state, workerSessionName, undefined, { allowCurrentReservation: true });
            state.orchestration.tasks[taskId] = task;
          }
          await this.deps.saveState(state);

          return { task: { ...task }, status, previousBinding, stagedIdentity, normalizedGroupId: preflight.normalizedGroupId };
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
        stagedIdentity: prepared.stagedIdentity,
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
    stagedIdentity?: StagedWorkerIdentity;
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
          stagedIdentity: input.stagedIdentity,
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
          stagedIdentity: input.stagedIdentity,
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
          stagedIdentity: input.stagedIdentity,
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
          stagedIdentity: input.stagedIdentity,
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
        stagedIdentity: input.stagedIdentity,
      });
      if (completedCancellation) {
        this.kernel.logEvent("orchestration.task.cancel_completed", "task cancellation completed", {
          ...this.kernel.taskContext(task),
          status: "cancelled",
        });
        return;
      }
      // Claim the teardown lease BEFORE converging a first-binding owner:
      // ensure or dispatch threw, so an owner may exist with only this
      // staged identity as its handle — but our task may also be terminal
      // by now with a new delegation already reserved on the reused
      // binding. Converging without the lease would kill the new owner's
      // engine identity. A refused claim retains the shell (fail closed).
      const teardownLeaseHeld =
        !input.previousBinding && input.stagedIdentity
          ? await this.claimStartupTeardownLease(input)
          : false;
      let retainBinding = !teardownLeaseHeld && !input.previousBinding && !!input.stagedIdentity;
      if (teardownLeaseHeld) {
        retainBinding = !(await this.convergeStartupOwner({
          task,
          previousBinding: input.previousBinding,
          stagedIdentity: input.stagedIdentity,
          leaseAlreadyHeld: true,
        }));
      }
      try {
        const taskMarkedFailed = await this.kernel.mutate(async () => {
          const state = await this.deps.loadState();
          const current = state.orchestration.tasks[task.taskId];
          const workerSession = task.workerSession!;
          const taskStillOwnsWorkerSession = current?.workerSession === workerSession;
          const currentBinding = state.orchestration.workerBindings[workerSession];
          const bindingStillBelongsToThisStartup = this.startupBindingBelongsToStartup(
            currentBinding,
            task,
            input.stagedIdentity,
          );
          const otherActiveOwner = Object.values(state.orchestration.tasks).some((candidate) =>
            candidate.taskId !== task.taskId &&
            candidate.workerSession === workerSession &&
            (!this.kernel.isTerminalStatus(candidate.status) || candidate.reviewPending !== undefined)
          );
          const restoreOrDeleteBinding = () => {
            if (retainBinding || !bindingStillBelongsToThisStartup || otherActiveOwner) {
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
      } finally {
        if (teardownLeaseHeld) releaseWorkerRetirement(task.workerSession!);
      }
    }
  }
  /**
   * Verified-converge a detached startup's possibly-started owner BEFORE any
   * binding restore/delete below. First binding only (no previous durable
   * identity): any owner present was started or adopted by this startup's
   * ensure — including when ensure itself rejects (acquire/spawn precedes
   * the ensure RPC, so rejection never proves no owner). Returns true when
   * the caller may proceed with restore/delete; false retains the shell
   * (fail closed) after logging. Reuse returns true without teardown: the
   * retained previous binding keeps a surviving owner discoverable.
   */
  private async convergeStartupOwner(input: {
    task: OrchestrationTaskRecord;
    previousBinding?: AppState["orchestration"]["workerBindings"][string];
    stagedIdentity?: StagedWorkerIdentity;
    leaseAlreadyHeld?: boolean;
  }): Promise<boolean> {
    const { task } = input;
    if (input.previousBinding || !input.stagedIdentity) return true;
    try {
      await teardownStagedWorkerOwner(
        this.deps.releaseWorkerSession,
        {
          workerSession: task.workerSession!,
          targetAgent: task.targetAgent,
          workspace: task.workspace,
          ...(task.cwd ? { cwd: task.cwd } : {}),
          ...(task.role ? { role: task.role } : {}),
        },
        input.stagedIdentity,
        { leaseAlreadyHeld: input.leaseAlreadyHeld ?? false },
      );
      return true;
    } catch (error) {
      this.kernel.logEvent("orchestration.startup.teardown_failed", "startup owner teardown failed; staged binding retained", {
        taskId: task.taskId,
        workerSession: task.workerSession ?? "",
        message: error instanceof Error ? error.message : String(error),
      });
      return false;
    }
  }

  /**
   * Same-generation check for a startup-owned binding: the routing fields
   * must match AND, when the staged identity is known, the durable LID and
   * engine must match too. A replaced generation (same name, fresh LID)
   * must never be restored over or deleted by a stale startup path.
   */
  private startupBindingBelongsToStartup(
    currentBinding: AppState["orchestration"]["workerBindings"][string] | undefined,
    task: OrchestrationTaskRecord,
    stagedIdentity?: StagedWorkerIdentity,
  ): boolean {
    const workerSession = task.workerSession!;
    if (
      currentBinding?.sourceHandle !== workerSession ||
      !sameCoordinatorSession(currentBinding.coordinatorSession, task.coordinatorSession) ||
      currentBinding.workspace !== task.workspace ||
      currentBinding.cwd !== task.cwd ||
      currentBinding.targetAgent !== task.targetAgent ||
      currentBinding.role !== task.role
    ) {
      return false;
    }
    if (stagedIdentity) {
      return (
        currentBinding.logicalSessionId === stagedIdentity.logicalSessionId &&
        currentBinding.transportEngine === stagedIdentity.transportEngine
      );
    }
    return true;
  }
  private async completeAutoRunStartupCancellation(input: {
    task: OrchestrationTaskRecord;
    previousBinding?: AppState["orchestration"]["workerBindings"][string];
    stagedIdentity?: StagedWorkerIdentity;
  }): Promise<boolean> {
    const { task } = input;
    // Phase 1: read-only guard check — no state change, no save.
    const applies = await this.kernel.mutate(async () => {
      const state = await this.deps.loadState();
      const workerSession = task.workerSession!;
      const current = state.orchestration.tasks[task.taskId];
      return (
        !!current &&
        current.workerSession === workerSession &&
        current.status === "running" &&
        current.cancelRequestedAt !== undefined
      );
    });
    if (!applies) return false;
    // Phase 2: claim the teardown lease, then converge a first-binding
    // owner OUTSIDE the state mutex (transport I/O must never run under the
    // lock). A refused claim (new delegation starting, another teardown in
    // flight) retains the shell below — the task still flips to cancelled.
    const workerSession = task.workerSession!;
    let retainBinding = false;
    const teardownLeaseHeld =
      !input.previousBinding && input.stagedIdentity
        ? await this.claimStartupTeardownLease(input)
        : false;
    if (!input.previousBinding && input.stagedIdentity && !teardownLeaseHeld) {
      retainBinding = true;
    }
    if (teardownLeaseHeld) {
      retainBinding = !(await this.convergeStartupOwner({
        task,
        previousBinding: input.previousBinding,
        stagedIdentity: input.stagedIdentity,
        leaseAlreadyHeld: true,
      }));
    }
    // Phase 3: flip + conditional delete with full re-verification (the
    // world may have moved during teardown). The lease stays held across
    // this mutate so no admission slips between converge and delete.
    try {
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
      const otherActiveOwner = Object.values(state.orchestration.tasks).some((candidate) =>
        candidate.taskId !== task.taskId &&
        candidate.workerSession === workerSession &&
        (!this.kernel.isTerminalStatus(candidate.status) || candidate.reviewPending !== undefined)
      );
      if (
        !retainBinding &&
        this.startupBindingBelongsToStartup(currentBinding, task, input.stagedIdentity) &&
        !otherActiveOwner
      ) {
        if (input.previousBinding) {
          state.orchestration.workerBindings[workerSession] = input.previousBinding;
        } else {
          delete state.orchestration.workerBindings[workerSession];
        }
      }
      await this.deps.saveState(state);
      return true;
      });
    } finally {
      if (teardownLeaseHeld) releaseWorkerRetirement(workerSession);
    }
  }

  /**
   * Claim-before-teardown for the detached startup paths: the stale cleanup
   * owns nothing (its reservation was released before the detached chain
   * started), so it must prove — atomically, inside one state-mutex mutate
   * — that the live binding is still its stale generation, that no other
   * task owns the session, and that no new delegation holds the start
   * reservation, and take the retirement lease in the same step. True means
   * the caller holds the lease across its release I/O + verify mutate and
   * must release it in a finally; false means back off and retain without
   * touching the engine. This is the reverse-direction half of the lease:
   * start-first beats stale-teardown, just as lease-held beats fresh
   * admission.
   */
  private claimStartupTeardownLease(input: {
    task: OrchestrationTaskRecord;
    previousBinding?: AppState["orchestration"]["workerBindings"][string];
    stagedIdentity?: StagedWorkerIdentity;
  }): Promise<boolean> {
    const workerSession = input.task.workerSession!;
    return this.workerSessions.claimWorkerTeardownLease(
      workerSession,
      (binding) => this.startupBindingBelongsToStartup(binding, input.task, input.stagedIdentity),
      input.task.taskId,
    );
  }


  private async cleanupAutoRunStartupBinding(input: {
    task: OrchestrationTaskRecord;
    previousBinding?: AppState["orchestration"]["workerBindings"][string];
    stagedIdentity?: StagedWorkerIdentity;
  }): Promise<boolean> {
    const { task } = input;
    const workerSession = task.workerSession!;
    // Phase 1: applicability + atomic lease claim under ONE mutex hold. The
    // claim must land in the same mutate as the ownerless/reservation
    // checks: this stale cleanup owns nothing (its reservation was released
    // before the detached chain started), so a check-then-claim split would
    // let a new delegation reserve + persist between the two — and the
    // release below would then kill the new owner's reused engine identity.
    // Backing off here retains the shell without touching the engine.
    const leaseHeld = await this.claimStartupTeardownLease(input);
    if (!leaseHeld) return false;
    try {
      // Phase 2: converge a first-binding owner OUTSIDE the state mutex
      // (transport I/O must never run under the lock) with the lease held:
      // fresh admissions are barred for the whole window, so the release
      // cannot kill a newly admitted owner. Unverifiable teardown retains
      // the shell (returns false).
      if (!input.previousBinding && input.stagedIdentity) {
        const converged = await this.convergeStartupOwner({
          task,
          previousBinding: input.previousBinding,
          stagedIdentity: input.stagedIdentity,
          leaseAlreadyHeld: true,
        });
        if (!converged) return false;
      }
      // Phase 3: delete only if still ours and ownerless (re-verified).
      return await this.kernel.mutate(async () => {
        const state = await this.deps.loadState();
        const workerSession = task.workerSession!;
        const currentBinding = state.orchestration.workerBindings[workerSession];
        if (!this.startupBindingBelongsToStartup(currentBinding, task, input.stagedIdentity)) {
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
    } finally {
      releaseWorkerRetirement(workerSession);
    }
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
