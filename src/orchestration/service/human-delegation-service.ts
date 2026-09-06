// src/orchestration/service/human-delegation-service.ts
// Human-delegation leaf service: the `requestDelegate` overload dispatcher plus the
// `requestDelegateForHuman` entry point that turns a human-originated delegation into a
// persisted `running` task and dispatches the worker turn. Takes three collaborators (the
// kernel, WorkerSessionManager, and RpcDelegationService — the RPC branch of the dispatcher
// forwards to it).
//
// `requestDelegateForHuman` opens `kernel.mutate` more than once, sequentially and never
// nested; the kernel's mutate is non-reentrant. `claimParallelStart` runs INSIDE a critical
// section; `releaseParallelStart`, `reserveProposedWorkerSession`,
// `ensureReservedWorkerSession` and `dispatchWorkerTask` run OUTSIDE. The
// binding-shell stage mutate runs BEFORE `ensureReservedWorkerSession` (G11
// persist-before-owner: the first owner must never start without a durable
// LID/engine); the task-persist mutate runs AFTER. Do not add, remove,
// merge, or relocate a mutate, and do not move any of those calls across a
// critical-section boundary.
import type { AppState } from "../../state/types";
import type {
  OrchestrationGroupRecord,
  OrchestrationTaskRecord,
} from "../orchestration-types";
import type {
  OrchestrationServiceDeps,
  RequestDelegateInput,
  RequestDelegateResult,
  RequestDelegateRpcInput,
  RequestDelegateRpcResult,
} from "../orchestration-service";
import type { OrchestrationStateKernel } from "./orchestration-state-kernel";
import {
  workerBindingEndpointIdentityFields,
  workerBindingEngineFields,
  workerBindingGuardFields,
  workerBindingIdentityFields,
} from "../worker-launch";
import type { RpcDelegationService } from "./rpc-delegation-service";
import type { WorkerSessionManager } from "./worker-session-manager";

export type HumanDelegationDeps = Pick<
  OrchestrationServiceDeps,
  "now" | "createId" | "createAgentEndpointId" | "loadState" | "saveState" | "dispatchWorkerTask" | "resolveWorkerBindingEngine"
>;
export class HumanDelegationService {
  constructor(
    private readonly deps: HumanDelegationDeps,
    private readonly kernel: OrchestrationStateKernel,
    private readonly workerSessions: WorkerSessionManager,
    private readonly rpcDelegation: RpcDelegationService,
  ) {}

  async requestDelegate(input: RequestDelegateInput): Promise<RequestDelegateResult>;
  async requestDelegate(input: RequestDelegateRpcInput): Promise<RequestDelegateRpcResult>;
  async requestDelegate(
    input: RequestDelegateInput | RequestDelegateRpcInput,
  ): Promise<RequestDelegateResult | RequestDelegateRpcResult> {
    if (isRequestDelegateInput(input)) {
      return await this.requestDelegateForHuman(input);
    }

    return await this.rpcDelegation.requestDelegateFromRpc(input);
  }

  async requestDelegateForHuman(input: RequestDelegateInput): Promise<RequestDelegateResult> {
    this.validateRequest(input);

    const role = this.workerSessions.normalizeRole(input.role);
    const normalizedGroupId = this.kernel.normalizeGroupId(input.groupId);
    const taskId = this.deps.createId();
    const workerSession = await this.workerSessions.resolveWorkerSession(input);

    // Parallel gate: when parallel is requested, check if a slot is available.
    // If at capacity, persist the task as "queued" and return immediately — no
    // session reservation, no ensureReservedWorkerSession, no dispatchWorkerTask.
    if (input.parallel) {
      const queuedResult = await this.kernel.mutate(async () => {
        const state = await this.deps.loadState();
        if (this.workerSessions.canStartParallelTask(state, input.targetAgent)) {
          // Slot available — increment the pending counter atomically with this
          // mutate so that concurrent gate checks (other delegations or
          // reconcileParallelSlots Phase 3) see this slot as taken until the task
          // is persisted as `running` in the inner mutate below. This closes the
          // TOCTOU window between the gate mutate exit and the inner persist mutate.
          this.workerSessions.claimParallelStart(input.targetAgent);
          return null; // capacity available — fall through to normal start
        }
        const now = this.deps.now().toISOString();
        const queuedTask: OrchestrationTaskRecord = {
          taskId,
          sourceHandle: input.sourceHandle,
          sourceKind: input.sourceKind,
          coordinatorSession: input.coordinatorSession,
          // `workerSession` here is the *intended* ephemeral session name only —
          // it is NOT reserved or ensured yet, and no acpx session exists for it
          // while the task is queued. The future queue-drain path must call
          // reserveProposedWorkerSession + ensureReservedWorkerSession on it
          // before dispatching.
          workerSession,
          workspace: input.workspace,
          ...(input.cwd ? { cwd: input.cwd } : {}),
          targetAgent: input.targetAgent,
          ...(role ? { role } : {}),
          ...(normalizedGroupId ? { groupId: normalizedGroupId } : {}),
          task: input.task,
          status: "queued",
          ephemeralWorkerSession: true,
          summary: "",
          resultText: "",
          createdAt: now,
          updatedAt: now,
          eventSeq: 1,
          events: [{ seq: 1, at: now, type: "created", status: "queued", message: "Task queued at parallel capacity" }],
          ...(input.chatKey ? { chatKey: input.chatKey } : {}),
          ...(input.replyContextToken ? { replyContextToken: input.replyContextToken } : {}),
          ...(input.accountId ? { accountId: input.accountId } : {}),
        };
        state.orchestration.tasks[taskId] = queuedTask;
        await this.deps.saveState(state);
        // `workerSession` is the intended ephemeral name; it is not yet reserved
        // or ensured (see the queuedTask.workerSession comment above).
        return { taskId, status: "queued" as const, workerSession };
      });
      if (queuedResult) {
        this.kernel.logEvent("orchestration.task.queued", "parallel task queued at capacity", { taskId, targetAgent: input.targetAgent });
        return queuedResult;
      }
    }

    // Decrement the pending-parallel-start counter on completion (success or
    // error). This mirrors the pendingWorkerSessions cleanup style. We only
    // decrement when `input.parallel` is true (i.e. when we incremented above).
    const releasePendingParallelStart = input.parallel
      ? () => {
          this.workerSessions.releaseParallelStart(input.targetAgent);
        }
      : undefined;

    let ensuredWorkerSession = workerSession;
    let prepared: {
      task: OrchestrationTaskRecord;
      previousBinding?: AppState["orchestration"]["workerBindings"][string];
      previousGroup?: OrchestrationGroupRecord;
      normalizedGroupId?: string;
    };

    const releaseWorkerReservation = await this.workerSessions.reserveProposedWorkerSession(workerSession);
    // Pre-shell identity for failure rollback: a failed delegation must
    // leave no trace (same atomicity as before the shell existed).
    let shellPreviousBinding: AppState["orchestration"]["workerBindings"][string] | undefined;
    let shellStaged = false;
    try {
      // G11 persist-before-owner: durably stage the binding shell (minted LID
      // + physical-group engine) BEFORE ensureReservedWorkerSession can start
      // the first owner. A first delegation used to ensure with no binding at
      // all, so the owner launched on a config-derived engine that a later
      // config change could contradict before the binding was ever written.
      // Reusable bindings keep their existing identity; only the missing
      // pieces are minted. A saveState rejection fails the delegation with
      // the reservation released and no owner started.
      try {
        shellPreviousBinding = await this.kernel.mutate(async () => {
          const state = await this.deps.loadState();
          const previousBinding = state.orchestration.workerBindings[workerSession];
          this.workerSessions.assertWorkerSessionDoesNotConflictExternalCoordinator(state, workerSession);
          this.workerSessions.assertWorkerSessionAvailable(state, workerSession, undefined, { allowCurrentReservation: true });
          state.orchestration.workerBindings[workerSession] = {
            sourceHandle: workerSession,
            coordinatorSession: input.coordinatorSession,
            workspace: input.workspace,
            ...(input.cwd ? { cwd: input.cwd } : {}),
            targetAgent: input.targetAgent,
            ...(role ? { role } : {}),
            ...workerBindingGuardFields(previousBinding),
            ...workerBindingEndpointIdentityFields(previousBinding, this.deps.createAgentEndpointId),
            ...workerBindingIdentityFields(
              previousBinding,
              () => this.deps.resolveWorkerBindingEngine({
                workerSession,
                targetAgent: input.targetAgent,
                workspace: input.workspace,
                ...(input.cwd ? { cwd: input.cwd } : {}),
              }),
              this.deps.createId,
            ),
            ...(input.parallel ? { ephemeral: true } : {}),
          };
          await this.deps.saveState(state);
          return previousBinding;
        });
        shellStaged = true;
      } catch (error) {
        await releaseWorkerReservation();
        throw error;
      }
      try {
        ensuredWorkerSession = await this.workerSessions.ensureReservedWorkerSession({
          workerSession,
          sourceHandle: input.sourceHandle,
          sourceKind: input.sourceKind,
          coordinatorSession: input.coordinatorSession,
          workspace: input.workspace,
          ...(input.cwd ? { cwd: input.cwd } : {}),
          targetAgent: input.targetAgent,
          role,
        });
        prepared = await this.kernel.mutate(async () => {
          const state = await this.deps.loadState();
          const now = this.deps.now().toISOString();
          if (normalizedGroupId) {
            this.kernel.assertGroupOwnership(this.kernel.ensureGroups(state)[normalizedGroupId], normalizedGroupId, input.coordinatorSession);
          }
          const task: OrchestrationTaskRecord = {
            taskId,
            sourceHandle: input.sourceHandle,
            sourceKind: input.sourceKind,
            coordinatorSession: input.coordinatorSession,
            workerSession: ensuredWorkerSession,
            workspace: input.workspace,
            ...(input.cwd ? { cwd: input.cwd } : {}),
            targetAgent: input.targetAgent,
            ...(role ? { role } : {}),
            ...(normalizedGroupId ? { groupId: normalizedGroupId } : {}),
            task: input.task,
            status: "running",
            summary: "",
            resultText: "",
            createdAt: now,
            updatedAt: now,
            eventSeq: 1,
            events: [{ seq: 1, at: now, type: "created", status: "running", message: "Task created" }],
            ...(input.chatKey ? { chatKey: input.chatKey } : {}),
            ...(input.replyContextToken ? { replyContextToken: input.replyContextToken } : {}),
            ...(input.accountId ? { accountId: input.accountId } : {}),
            ...(input.parallel ? { ephemeralWorkerSession: true } : {}),
          };

          let previousGroup: OrchestrationGroupRecord | undefined;
          if (normalizedGroupId) {
            const group = this.kernel.ensureGroups(state)[normalizedGroupId]!;
            previousGroup = { ...group };
            group.updatedAt = now;
            group.coordinatorInjectedAt = undefined;
            group.injectionPending = undefined;
            group.injectionAppliedAt = undefined;
            group.lastInjectionError = undefined;
          }
          const previousBinding = state.orchestration.workerBindings[ensuredWorkerSession];
          this.workerSessions.assertWorkerSessionDoesNotConflictExternalCoordinator(state, ensuredWorkerSession);
          this.workerSessions.assertWorkerSessionAvailable(state, ensuredWorkerSession, undefined, { allowCurrentReservation: true });
          state.orchestration.tasks[taskId] = task;
          state.orchestration.workerBindings[ensuredWorkerSession] = {
            sourceHandle: ensuredWorkerSession,
            coordinatorSession: input.coordinatorSession,
            workspace: input.workspace,
            ...(input.cwd ? { cwd: input.cwd } : {}),
            targetAgent: input.targetAgent,
            role,
            ...workerBindingGuardFields(previousBinding),
            ...workerBindingEndpointIdentityFields(previousBinding, this.deps.createAgentEndpointId),
            ...workerBindingEngineFields(previousBinding),
            ...(input.parallel ? { ephemeral: true } : {}),
          };

          await this.deps.saveState(state);

          return {
            task: { ...task },
            previousBinding,
            previousGroup,
            normalizedGroupId,
          };
        });
      } catch (error) {
        if (shellStaged) {
          // Best-effort: the original error is what the caller must see; a
          // failed restore only leaves a reusable shell behind.
          await this.kernel.mutate(async () => {
            const state = await this.deps.loadState();
            if (shellPreviousBinding) {
              state.orchestration.workerBindings[workerSession] = shellPreviousBinding;
            } else {
              delete state.orchestration.workerBindings[workerSession];
            }
            await this.deps.saveState(state);
          }).catch(() => {});
        }
        await releaseWorkerReservation();
        throw error;
      }
      await releaseWorkerReservation();
    } finally {
      // The pending-start slot is consumed once the task is persisted as
      // `running` (or on any error). The actual slot is now tracked by the
      // persisted task status, so the pending counter is no longer needed.
      releasePendingParallelStart?.();
    }

    try {
      await this.deps.dispatchWorkerTask({
        taskId,
        workerSession: ensuredWorkerSession,
        coordinatorSession: input.coordinatorSession,
        workspace: input.workspace,
        ...(input.cwd ? { cwd: input.cwd } : {}),
        targetAgent: input.targetAgent,
        ...(role ? { role } : {}),
        task: input.task,
      });
    } catch (error) {
      await this.kernel.mutate(async () => {
        const state = await this.deps.loadState();
        delete state.orchestration.tasks[taskId];
        // Roll back to before the shell existed (not to the shell): a
        // failed delegation leaves no trace.
        if (shellPreviousBinding) {
          state.orchestration.workerBindings[ensuredWorkerSession] = shellPreviousBinding;
        } else {
          delete state.orchestration.workerBindings[ensuredWorkerSession];
        }
        if (prepared.normalizedGroupId && prepared.previousGroup) {
          this.kernel.ensureGroups(state)[prepared.normalizedGroupId] = prepared.previousGroup;
        }
        await this.deps.saveState(state);
      });
      throw error;
    }

    this.kernel.logEvent("orchestration.task.created", "delegated task created", this.kernel.taskContext(prepared.task));

    return {
      taskId,
      status: prepared.task.status,
      workerSession: ensuredWorkerSession,
    };
  }

  private validateRequest(input: RequestDelegateInput): void {
    if (input.sourceHandle.trim().length === 0) {
      throw new Error("sourceHandle must be a non-empty string");
    }

    if (input.coordinatorSession.trim().length === 0) {
      throw new Error("coordinatorSession must be a non-empty string");
    }

    if (input.workspace.trim().length === 0) {
      throw new Error("workspace must be a non-empty string");
    }

    if (input.targetAgent.trim().length === 0) {
      throw new Error("targetAgent must be a non-empty string");
    }

    if (input.task.trim().length === 0) {
      throw new Error("task must be a non-empty string");
    }
  }
}

function isRequestDelegateInput(
  input: RequestDelegateInput | RequestDelegateRpcInput,
): input is RequestDelegateInput {
  return "sourceKind" in input;
}
