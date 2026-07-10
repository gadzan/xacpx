import type { AppConfig } from "../config/types";
import type { AppLogger } from "../logging/app-logger";
import type { AppState } from "../state/types";
import type {
  ExternalCoordinatorRecord,
  OrchestrationCoordinatorRouteContextRecord,
  OrchestrationGroupRecord,
  OrchestrationGroupSummary,
  OrchestrationSourceKind,
  OrchestrationTaskEventRecord,
  OrchestrationTaskRecord,
  OrchestrationTaskStatus,
} from "./orchestration-types";
import { AsyncMutex } from "./async-mutex";
import { sameCoordinatorSession, stableCoordinatorSession } from "./coordinator-identity";
import { CoordinatorRegistryService } from "./service/coordinator-registry-service";
import { GroupService } from "./service/group-service";
import { HumanQuestionService } from "./service/human-question-service";
import { NoticeDeliveryService } from "./service/notice-delivery-service";
import { OrchestrationStateKernel } from "./service/orchestration-state-kernel";
import { QuestionFlowCore } from "./service/question-flow-core";
import { TaskApprovalService } from "./service/task-approval-service";
import { TaskCancellationService } from "./service/task-cancellation-service";
import { TaskLifecycleService } from "./service/task-lifecycle-service";
import { WorkerSessionManager } from "./service/worker-session-manager";

export { clampWatchTimeout } from "./task-watch-timeouts";

export interface RequestDelegateInput {
  sourceHandle: string;
  sourceKind: OrchestrationSourceKind;
  coordinatorSession: string;
  workspace: string;
  cwd?: string;
  targetAgent: string;
  task: string;
  role?: string;
  groupId?: string;
  chatKey?: string;
  replyContextToken?: string;
  accountId?: string;
  parallel?: boolean;
}

export interface RequestDelegateRpcInput {
  sourceHandle: string;
  targetAgent: string;
  task: string;
  cwd?: string;
  role?: string;
  groupId?: string;
  parallel?: boolean;
}

export interface RequestDelegateResult {
  taskId: string;
  status: OrchestrationTaskStatus;
  workerSession: string;
}

export interface RegisterExternalCoordinatorInput {
  coordinatorSession: string;
  workspace?: string;
  defaultTargetAgent?: string;
}

export interface RequestDelegateRpcResult {
  taskId: string;
  status: Extract<OrchestrationTaskStatus, "needs_confirmation" | "running" | "queued">;
  workerSession?: string;
}

export interface RecordWorkerReplyInput {
  taskId: string;
  sourceHandle: string;
  status?: Extract<OrchestrationTaskStatus, "completed" | "failed" | "cancelled">;
  summary?: string;
  resultText?: string;
}

export interface RecordTaskNoticeDeliveryInput {
  taskId: string;
  deliveryAccountId: string;
}

export interface MarkTaskErrorInput {
  taskId: string;
  errorMessage: string;
}

export interface CancelTaskInput {
  taskId: string;
  sourceHandle?: string;
  coordinatorSession?: string;
}

export interface CancelWorkerTaskRequest {
  taskId: string;
  workerSession: string;
  workspace: string;
  cwd?: string;
  targetAgent: string;
}

export interface ResumeWorkerTaskRequest {
  taskId: string;
  workerSession: string;
  coordinatorSession: string;
  workspace: string;
  cwd?: string;
  targetAgent: string;
  answer: string;
}

export interface WakeCoordinatorRequest {
  coordinatorSession: string;
}

export interface DeliverCoordinatorMessageRequest {
  coordinatorSession: string;
  chatKey: string;
  accountId?: string;
  replyContextToken?: string;
  text: string;
}

export type FrozenCoordinatorDeliveryRoute = Pick<
  DeliverCoordinatorMessageRequest,
  "chatKey" | "accountId" | "replyContextToken"
>;

export interface ConfirmTaskInput {
  taskId: string;
  coordinatorSession: string;
}

export interface WorkerRaiseQuestionInput {
  taskId: string;
  sourceHandle: string;
  question: string;
  whyBlocked: string;
  whatIsNeeded: string;
}

export interface CoordinatorTaskQuestionRef {
  taskId: string;
  questionId: string;
}

export interface CoordinatorRequestHumanInputResult {
  packageId?: string;
  queuedTaskIds: string[];
}

export interface RetryHumanQuestionPackageDeliveryResult {
  packageId: string;
  messageId: string;
}

export interface ClaimedActiveHumanReply {
  coordinatorSession: string;
  packageId: string;
  messageId: string;
  chatKey: string;
  promptText: string;
  taskQuestions: CoordinatorTaskQuestionRef[];
  queuedCount: number;
}

export interface ActiveHumanQuestionPackage {
  packageId: string;
  promptText: string;
  awaitingReplyMessageId?: string;
  deliveredChatKey?: string;
  deliveryAccountId?: string;
  routeReplyContextToken?: string;
  deliveredAt?: string;
  openTaskIds: string[];
  messageTaskQuestions?: Array<{
    taskId: string;
    questionId: string;
  }>;
  openTaskQuestions?: Array<{
    taskId: string;
    questionId: string;
    question: string;
    whyBlocked: string;
    whatIsNeeded: string;
  }>;
  queuedCount: number;
}

export interface OrchestrationServiceDeps {
  now: () => Date;
  createId: () => string;
  loadState: () => Promise<AppState>;
  saveState: (state: AppState) => Promise<void>;
  stateMutex?: AsyncMutex;
  config: AppConfig;
  ensureWorkerSession: (request: EnsureWorkerSessionRequest) => Promise<string>;
  dispatchWorkerTask: (request: DispatchWorkerTaskRequest) => Promise<void>;
  cancelWorkerTask?: (request: CancelWorkerTaskRequest) => Promise<void>;
  resumeWorkerTask?: (request: ResumeWorkerTaskRequest) => Promise<void>;
  closeWorkerSession?: (request: {
    workerSession: string;
    coordinatorSession: string;
    workspace: string;
    cwd?: string;
    targetAgent: string;
    role?: string;
  }) => Promise<void>;
  wakeCoordinatorSession?: (request: WakeCoordinatorRequest) => Promise<void>;
  deliverCoordinatorMessage?: (
    request: DeliverCoordinatorMessageRequest,
  ) => Promise<FrozenCoordinatorDeliveryRoute | void>;
  interruptWorkerTask?: (request: CancelWorkerTaskRequest) => Promise<void>;
  findReusableWorkerSession?: (
    request: ReusableWorkerLookupRequest,
  ) => Promise<string | null | undefined> | string | null | undefined;
  logger?: AppLogger;
}

export interface EnsureWorkerSessionRequest {
  workerSession: string;
  sourceHandle: string;
  sourceKind: OrchestrationSourceKind;
  coordinatorSession: string;
  workspace: string;
  cwd?: string;
  targetAgent: string;
  role?: string;
}

export interface ReusableWorkerLookupRequest {
  sourceHandle: string;
  sourceKind: OrchestrationSourceKind;
  coordinatorSession: string;
  workspace: string;
  cwd?: string;
  targetAgent: string;
  role?: string;
}

export interface DispatchWorkerTaskRequest {
  taskId: string;
  workerSession: string;
  coordinatorSession: string;
  workspace: string;
  cwd?: string;
  targetAgent: string;
  role?: string;
  task: string;
}

export interface CancelGroupResult {
  summary: OrchestrationGroupSummary;
  cancelledTaskIds: string[];
  skippedTaskIds: string[];
}

export interface CleanTasksResult {
  removedTasks: number;
  removedBindings: number;
}

export interface OrchestrationTaskFilter {
  sourceHandle?: string;
  coordinatorSession?: string;
  workspace?: string;
  targetAgent?: string;
  role?: string;
  status?: OrchestrationTaskStatus;
  stuck?: boolean;
  sort?: "updatedAt" | "createdAt";
  order?: "asc" | "desc";
}

export interface WatchTaskInput {
  coordinatorSession: string;
  taskId: string;
  afterSeq?: number;
  mode?: "next_event" | "until_attention_or_terminal";
  includeProgress?: boolean;
  timeoutMs?: number;
  pollIntervalMs?: number;
}

export interface WatchTaskResult {
  status: "event" | "attention_required" | "terminal" | "timeout" | "not_found";
  task: OrchestrationTaskRecord | null;
  events: OrchestrationTaskEventRecord[];
  nextAfterSeq: number;
  historyTruncated?: boolean;
}

export interface OrchestrationGroupListFilter {
  coordinatorSession: string;
  status?: "pending" | "running" | "terminal";
  stuck?: boolean;
  sort?: "updatedAt" | "createdAt";
  order?: "asc" | "desc";
}

export class OrchestrationService {
  private readonly kernel: OrchestrationStateKernel;
  private readonly workerSessions: WorkerSessionManager;
  private readonly questionFlow: QuestionFlowCore;
  private readonly notices: NoticeDeliveryService;
  private readonly lifecycle: TaskLifecycleService;
  private readonly coordinators: CoordinatorRegistryService;
  private readonly cancellation: TaskCancellationService;
  private readonly humanQuestions: HumanQuestionService;
  private readonly groups: GroupService;
  private readonly approvals: TaskApprovalService;

  constructor(private readonly deps: OrchestrationServiceDeps) {
    this.kernel = new OrchestrationStateKernel({ logger: deps.logger }, deps.stateMutex);
    this.workerSessions = new WorkerSessionManager(deps, this.kernel);
    this.questionFlow = new QuestionFlowCore(deps, this.kernel);
    this.notices = new NoticeDeliveryService(deps, this.kernel);
    this.lifecycle = new TaskLifecycleService(deps, this.kernel);
    this.coordinators = new CoordinatorRegistryService(deps, this.kernel, this.workerSessions);
    this.cancellation = new TaskCancellationService(deps, this.kernel, this.workerSessions, this.questionFlow);
    this.humanQuestions = new HumanQuestionService(deps, this.kernel, this.workerSessions, this.questionFlow, this.cancellation);
    this.groups = new GroupService(deps, this.kernel, this.cancellation);
    this.approvals = new TaskApprovalService(deps, this.kernel, this.workerSessions, this.questionFlow, this.lifecycle);
  }


  async registerExternalCoordinator(input: RegisterExternalCoordinatorInput): Promise<ExternalCoordinatorRecord> {
    return await this.coordinators.registerExternalCoordinator(input);
  }

  async createGroup(input: {
    coordinatorSession: string;
    title: string;
  }): Promise<OrchestrationGroupRecord> {
    return await this.groups.createGroup(input);
  }

  async getGroupSummary(input: {
    groupId: string;
    coordinatorSession: string;
  }): Promise<OrchestrationGroupSummary | null> {
    return await this.groups.getGroupSummary(input);
  }

  async listGroupSummaries(input: OrchestrationGroupListFilter): Promise<OrchestrationGroupSummary[]> {
    return await this.groups.listGroupSummaries(input);
  }

  async cancelGroup(input: {
    groupId: string;
    coordinatorSession: string;
  }): Promise<CancelGroupResult> {
    return await this.groups.cancelGroup(input);
  }

  async requestDelegate(input: RequestDelegateInput): Promise<RequestDelegateResult>;
  async requestDelegate(input: RequestDelegateRpcInput): Promise<RequestDelegateRpcResult>;
  async requestDelegate(
    input: RequestDelegateInput | RequestDelegateRpcInput,
  ): Promise<RequestDelegateResult | RequestDelegateRpcResult> {
    if (isRequestDelegateInput(input)) {
      return await this.requestDelegateForHuman(input);
    }

    return await this.requestDelegateFromRpc(input);
  }

  private async requestDelegateForHuman(input: RequestDelegateInput): Promise<RequestDelegateResult> {
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
    try {
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
        if (prepared.previousBinding) {
          state.orchestration.workerBindings[ensuredWorkerSession] = prepared.previousBinding;
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

  async recordWorkerReply(input: RecordWorkerReplyInput): Promise<OrchestrationTaskRecord> {
    return await this.lifecycle.recordWorkerReply(input);
  }

  async markTaskNoticePending(taskId: string): Promise<OrchestrationTaskRecord> {
    return await this.notices.markTaskNoticePending(taskId);
  }

  async markTaskNoticeDelivered(taskId: string, deliveryAccountId: string): Promise<OrchestrationTaskRecord> {
    return await this.notices.markTaskNoticeDelivered(taskId, deliveryAccountId);
  }

  async markTaskNoticeFailed(input: MarkTaskErrorInput): Promise<OrchestrationTaskRecord> {
    return await this.notices.markTaskNoticeFailed(input);
  }

  async listPendingTaskNotices(): Promise<OrchestrationTaskRecord[]> {
    return await this.notices.listPendingTaskNotices();
  }

  async recordTaskNoticeDelivery(input: RecordTaskNoticeDeliveryInput): Promise<OrchestrationTaskRecord> {
    return await this.notices.recordTaskNoticeDelivery(input);
  }

  async getTask(taskId: string): Promise<OrchestrationTaskRecord | null> {
    return await this.lifecycle.getTask(taskId);
  }


  async watchTask(input: WatchTaskInput): Promise<WatchTaskResult> {
    return await this.lifecycle.watchTask(input);
  }

  async recordCoordinatorRouteContext(input: {
    coordinatorSession: string;
    chatKey: string;
    sessionAlias?: string;
    accountId?: string;
    replyContextToken?: string;
    channel?: string;
    chatType?: "direct" | "group";
    senderId?: string;
    senderName?: string;
    groupId?: string;
    isOwner?: boolean;
  }): Promise<OrchestrationCoordinatorRouteContextRecord> {
    return await this.coordinators.recordCoordinatorRouteContext(input);
  }

  async workerRaiseQuestion(
    input: WorkerRaiseQuestionInput,
  ): Promise<{ taskId: string; questionId: string; status: "blocked" }> {
    return await this.humanQuestions.workerRaiseQuestion(input);
  }

  async coordinatorAnswerQuestion(input: {
    coordinatorSession: string;
    taskId: string;
    questionId: string;
    answer: string;
  }): Promise<OrchestrationTaskRecord> {
    return await this.humanQuestions.coordinatorAnswerQuestion(input);
  }

  async coordinatorRetractAnswer(input: {
    coordinatorSession: string;
    taskId: string;
    questionId: string;
  }): Promise<OrchestrationTaskRecord> {
    return await this.humanQuestions.coordinatorRetractAnswer(input);
  }

  async coordinatorRequestHumanInput(input: {
    coordinatorSession: string;
    taskQuestions: CoordinatorTaskQuestionRef[];
    promptText: string;
    expectedActivePackageId?: string;
  }): Promise<CoordinatorRequestHumanInputResult> {
    return await this.humanQuestions.coordinatorRequestHumanInput(input);
  }

  async retryHumanQuestionPackageDelivery(input: {
    coordinatorSession: string;
    packageId: string;
    messageId: string;
  }): Promise<RetryHumanQuestionPackageDeliveryResult> {
    return await this.humanQuestions.retryHumanQuestionPackageDelivery(input);
  }

  async claimActiveHumanReply(input: {
    coordinatorSession: string;
    chatKey: string;
    packageId: string;
    messageId: string;
    accountId?: string;
    replyContextToken?: string;
  }): Promise<ClaimedActiveHumanReply | null> {
    return await this.humanQuestions.claimActiveHumanReply(input);
  }

  async getActiveHumanQuestionPackage(
    coordinatorSession: string,
  ): Promise<ActiveHumanQuestionPackage | null> {
    return await this.humanQuestions.getActiveHumanQuestionPackage(coordinatorSession);
  }

  async coordinatorReviewContestedResult(input: {
    coordinatorSession: string;
    taskId: string;
    reviewId: string;
    decision: "accept" | "discard";
  }): Promise<OrchestrationTaskRecord> {
    return await this.humanQuestions.coordinatorReviewContestedResult(input);
  }

  async listTasks(filter?: OrchestrationTaskFilter): Promise<OrchestrationTaskRecord[]> {
    return await this.lifecycle.listTasks(filter);
  }

  async cleanTasks(coordinatorSession: string): Promise<CleanTasksResult> {
    return await this.lifecycle.cleanTasks(coordinatorSession);
  }

  async listSessionBlockingTasks(transportSession: string): Promise<OrchestrationTaskRecord[]> {
    return await this.lifecycle.listSessionBlockingTasks(transportSession);
  }

  async purgeSessionReferences(transportSession: string): Promise<CleanTasksResult> {
    return await this.lifecycle.purgeSessionReferences(transportSession);
  }

  async listPendingCoordinatorResults(coordinatorSession: string): Promise<OrchestrationTaskRecord[]> {
    return await this.notices.listPendingCoordinatorResults(coordinatorSession);
  }

  async listPendingCoordinatorBlockers(coordinatorSession: string): Promise<OrchestrationTaskRecord[]> {
    return await this.notices.listPendingCoordinatorBlockers(coordinatorSession);
  }

  async listContestedCoordinatorResults(coordinatorSession: string): Promise<OrchestrationTaskRecord[]> {
    return await this.notices.listContestedCoordinatorResults(coordinatorSession);
  }

  async listPendingCoordinatorGroups(coordinatorSession: string): Promise<OrchestrationGroupRecord[]> {
    return await this.notices.listPendingCoordinatorGroups(coordinatorSession);
  }

  async markCoordinatorResultsInjected(taskIds: string[]): Promise<void> {
    await this.notices.markCoordinatorResultsInjected(taskIds);
  }

  async markCoordinatorGroupsInjected(groupIds: string[]): Promise<void> {
    await this.notices.markCoordinatorGroupsInjected(groupIds);
  }

  async markCoordinatorGroupsInjectionFailed(groupIds: string[], errorMessage: string): Promise<void> {
    await this.notices.markCoordinatorGroupsInjectionFailed(groupIds, errorMessage);
  }

  async markTaskInjectionApplied(taskIds: string[]): Promise<void> {
    await this.notices.markTaskInjectionApplied(taskIds);
  }

  async markTaskInjectionFailed(taskIds: string[], errorMessage: string): Promise<void> {
    await this.notices.markTaskInjectionFailed(taskIds, errorMessage);
  }

  async recordTaskProgress(taskId: string, summary?: string): Promise<OrchestrationTaskRecord> {
    return await this.lifecycle.recordTaskProgress(taskId, summary);
  }

  async listHeartbeatTasks(thresholdSeconds: number): Promise<OrchestrationTaskRecord[]> {
    return await this.lifecycle.listHeartbeatTasks(thresholdSeconds);
  }

  async cancelTask(input: CancelTaskInput): Promise<OrchestrationTaskRecord> {
    return await this.cancellation.cancelTask(input);
  }

  async requestTaskCancellation(input: CancelTaskInput): Promise<OrchestrationTaskRecord> {
    return await this.cancellation.requestTaskCancellation(input);
  }

  async completeTaskCancellation(taskId: string): Promise<OrchestrationTaskRecord> {
    return await this.cancellation.completeTaskCancellation(taskId);
  }

  async failTaskCancellation(taskId: string, errorMessage: string): Promise<OrchestrationTaskRecord> {
    return await this.cancellation.failTaskCancellation(taskId, errorMessage);
  }

  async approveTask(input: ConfirmTaskInput): Promise<OrchestrationTaskRecord> {
    return await this.approvals.approveTask(input);
  }

  /**
   * Resolves the transport worker-session name for a delegation.
   *
   * For parallel delegations a fresh unique name is minted by appending a
   * `:p-<id>` suffix. That suffix is purely a naming convention for
   * human/log readability — it MUST NOT be treated as the source of truth
   * for ephemerality. `WorkerBindingRecord.ephemeral` is the authoritative
   * marker for whether a session is an ephemeral parallel slot; no code
   * should detect ephemerality by string-matching the session name.
   */
  async reserveLogicalTransportSession(transportSession: string): Promise<() => Promise<void>> {
    return await this.workerSessions.reserveLogicalTransportSession(transportSession);
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

  async reconcileParallelSlots(): Promise<void> {
    return await this.workerSessions.reconcileParallelSlots();
  }

}


function isRequestDelegateInput(
  input: RequestDelegateInput | RequestDelegateRpcInput,
): input is RequestDelegateInput {
  return "sourceKind" in input;
}
