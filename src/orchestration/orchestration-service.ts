import type { AppConfig } from "../config/types";
import type { AppLogger } from "../logging/app-logger";
import type { AppState } from "../state/types";
import type {
  ExternalCoordinatorRecord,
  OrchestrationCoordinatorRouteContextRecord,
  OrchestrationGroupRecord,
  OrchestrationGroupSummary,
  OrchestrationHumanQuestionPackageRecord,
  OrchestrationSourceKind,
  OrchestrationTaskEventRecord,
  OrchestrationTaskRecord,
  OrchestrationTaskStatus,
} from "./orchestration-types";
import { AsyncMutex } from "./async-mutex";
import { sameCoordinatorSession, stableCoordinatorSession } from "./coordinator-identity";
import { sanitizeProgressSummary, stripProgressLines } from "./progress-line-parser";
import { NoticeDeliveryService } from "./service/notice-delivery-service";
import { OrchestrationStateKernel } from "./service/orchestration-state-kernel";
import { QuestionFlowCore } from "./service/question-flow-core";
import { WorkerSessionManager } from "./service/worker-session-manager";
import {
  DEFAULT_TASK_WATCH_POLL_INTERVAL_MS,
  DEFAULT_TASK_WATCH_TIMEOUT_MS,
  MAX_TASK_WATCH_POLL_INTERVAL_MS,
  MAX_TASK_WATCH_TIMEOUT_MS,
} from "./task-watch-timeouts";

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

// An invalid timeout collapses to 0 (an immediate single-shot watch), never to
// the 60s default, so a bad value cannot silently turn into a long-poll for
// direct callers of OrchestrationService.watchTask.
export function clampWatchTimeout(value: number | undefined): number {
  if (value === undefined) return DEFAULT_TASK_WATCH_TIMEOUT_MS;
  if (!Number.isFinite(value) || value < 0) return 0;
  return Math.min(Math.floor(value), MAX_TASK_WATCH_TIMEOUT_MS);
}

function clampWatchPollInterval(value: number | undefined): number {
  if (value === undefined) return DEFAULT_TASK_WATCH_POLL_INTERVAL_MS;
  if (!Number.isFinite(value) || value < 1) return DEFAULT_TASK_WATCH_POLL_INTERVAL_MS;
  return Math.min(value, MAX_TASK_WATCH_POLL_INTERVAL_MS);
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

  constructor(private readonly deps: OrchestrationServiceDeps) {
    this.kernel = new OrchestrationStateKernel({ logger: deps.logger }, deps.stateMutex);
    this.workerSessions = new WorkerSessionManager(deps, this.kernel);
    this.questionFlow = new QuestionFlowCore(deps, this.kernel);
    this.notices = new NoticeDeliveryService(deps, this.kernel);
  }


  async registerExternalCoordinator(input: RegisterExternalCoordinatorInput): Promise<ExternalCoordinatorRecord> {
    const coordinatorSession = input.coordinatorSession.trim();
    const workspace = input.workspace?.trim();
    const defaultTargetAgent = input.defaultTargetAgent?.trim();

    if (!coordinatorSession) {
      throw new Error("coordinatorSession must be a non-empty string");
    }
    if (workspace && !this.deps.config.workspaces[workspace]) {
      throw new Error(`workspace "${workspace}" is not configured`);
    }

    return await this.kernel.mutate(async () => {
      const state = await this.deps.loadState();
      const externalCoordinators = this.kernel.ensureExternalCoordinators(state);
      const existing = externalCoordinators[coordinatorSession];
      if (this.workerSessions.hasPendingWorkerSession(coordinatorSession)) {
        throw new Error(`coordinatorSession "${coordinatorSession}" conflicts with an existing worker session`);
      }
      if (state.orchestration.workerBindings[coordinatorSession]) {
        throw new Error(`coordinatorSession "${coordinatorSession}" conflicts with an existing worker session`);
      }
      if (this.workerSessions.hasActiveTaskWorkerSession(state, coordinatorSession)) {
        throw new Error(`coordinatorSession "${coordinatorSession}" conflicts with an existing worker session`);
      }
      if (this.workerSessions.hasPendingLogicalTransportSession(coordinatorSession)) {
        throw new Error(`coordinatorSession "${coordinatorSession}" conflicts with an existing logical session`);
      }
      if (Object.values(state.sessions).some((session) => session.transport_session === coordinatorSession)) {
        throw new Error(`coordinatorSession "${coordinatorSession}" conflicts with an existing logical session`);
      }
      if (existing?.workspace && workspace && existing.workspace !== workspace) {
        throw new Error(
          `coordinatorSession "${coordinatorSession}" is already bound to workspace "${existing.workspace}"; use a new coordinator session for workspace "${workspace}"`,
        );
      }
      const now = this.deps.now().toISOString();
      const effectiveDefaultTargetAgent = defaultTargetAgent || existing?.defaultTargetAgent;
      const record: ExternalCoordinatorRecord = {
        coordinatorSession,
        ...(workspace ? { workspace } : existing?.workspace ? { workspace: existing.workspace } : {}),
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
        ...(effectiveDefaultTargetAgent ? { defaultTargetAgent: effectiveDefaultTargetAgent } : {}),
      };

      externalCoordinators[coordinatorSession] = record;
      await this.deps.saveState(state);
      return { ...record };
    });
  }

  async createGroup(input: {
    coordinatorSession: string;
    title: string;
  }): Promise<OrchestrationGroupRecord> {
    if (input.coordinatorSession.trim().length === 0) {
      throw new Error("coordinatorSession must be a non-empty string");
    }
    if (input.title.trim().length === 0) {
      throw new Error("title must be a non-empty string");
    }

    const group = await this.kernel.mutate(async () => {
      const state = await this.deps.loadState();
      const now = this.deps.now().toISOString();
      const groupId = this.deps.createId();
      const nextGroup: OrchestrationGroupRecord = {
        groupId,
        coordinatorSession: input.coordinatorSession,
        title: input.title.trim(),
        createdAt: now,
        updatedAt: now,
      };

      const groups = this.kernel.ensureGroups(state);
      groups[groupId] = nextGroup;
      await this.deps.saveState(state);

      return { ...nextGroup };
    });

    this.kernel.logEvent("orchestration.group.created", "group created", this.kernel.groupContext(group));

    return group;
  }

  async getGroupSummary(input: {
    groupId: string;
    coordinatorSession: string;
  }): Promise<OrchestrationGroupSummary | null> {
    const state = await this.deps.loadState();
    const group = this.kernel.ensureGroups(state)[input.groupId];
    if (!group || !sameCoordinatorSession(group.coordinatorSession, input.coordinatorSession)) {
      return null;
    }

    return this.buildGroupSummary(
      group,
      Object.values(state.orchestration.tasks).filter((task) => task.groupId === input.groupId),
    );
  }

  async listGroupSummaries(input: OrchestrationGroupListFilter): Promise<OrchestrationGroupSummary[]> {
    const state = await this.deps.loadState();
    const tasks = Object.values(state.orchestration.tasks);
    const threshold = this.deps.config.orchestration.progressHeartbeatSeconds;
    const now = this.deps.now().getTime();
    const sortField = input.sort ?? "updatedAt";
    const order = input.order ?? "desc";

    return Object.values(this.kernel.ensureGroups(state))
      .filter((group) => sameCoordinatorSession(group.coordinatorSession, input.coordinatorSession))
      .map((group) => ({
        group,
        summary: this.buildGroupSummary(group, tasks.filter((task) => task.groupId === group.groupId)),
      }))
      .filter(({ summary }) => {
        if (input.status === undefined) return true;
        if (input.status === "pending") return summary.pendingApprovalTasks > 0;
        if (input.status === "running") return summary.runningTasks > 0;
        return summary.terminal === true;
      })
      .filter(({ group }) => {
        if (input.stuck !== true) return true;
        if (group.injectionPending !== true) return false;
        const elapsed = (now - new Date(group.updatedAt).getTime()) / 1000;
        return elapsed >= threshold;
      })
      .sort((left, right) => {
        const leftValue = sortField === "createdAt" ? left.group.createdAt : left.group.updatedAt;
        const rightValue = sortField === "createdAt" ? right.group.createdAt : right.group.updatedAt;
        const compare = leftValue.localeCompare(rightValue);
        return order === "asc" ? compare : -compare;
      })
      .map(({ summary }) => summary);
  }

  async cancelGroup(input: {
    groupId: string;
    coordinatorSession: string;
  }): Promise<CancelGroupResult> {
    const summary = await this.getGroupSummary(input);
    if (!summary) {
      throw new Error(`group "${input.groupId}" does not exist`);
    }

    const cancelledTaskIds: string[] = [];
    const skippedTaskIds: string[] = [];

    for (const task of summary.tasks) {
      if (this.kernel.isTerminalStatus(task.status)) {
        skippedTaskIds.push(task.taskId);
        continue;
      }

      await this.requestTaskCancellation({
        taskId: task.taskId,
        coordinatorSession: input.coordinatorSession,
      });
      cancelledTaskIds.push(task.taskId);
    }

    const refreshed = await this.getGroupSummary(input);
    if (!refreshed) {
      throw new Error(`group "${input.groupId}" does not exist`);
    }

    this.kernel.logEvent("orchestration.group.cancelled", "group cancelled", {
      ...this.kernel.groupContext(refreshed.group),
      cancelled_count: cancelledTaskIds.length,
      skipped_count: skippedTaskIds.length,
    });

    return {
      summary: refreshed,
      cancelledTaskIds,
      skippedTaskIds,
    };
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
    if (input.coordinatorSession.trim().length === 0) {
      throw new Error("coordinatorSession must be a non-empty string");
    }
    if (input.chatKey.trim().length === 0) {
      throw new Error("chatKey must be a non-empty string");
    }

    return await this.kernel.mutate(async () => {
      const state = await this.deps.loadState();
      const now = this.deps.now().toISOString();
      // Key the route by the stable identity so a route recorded before `/clear`
      // is still found when the coordinator resumes under its rotated transport.
      const routeKey = stableCoordinatorSession(input.coordinatorSession);
      const existing = this.kernel.ensureCoordinatorRoutes(state)[routeKey];
      const sameChat = existing?.chatKey === input.chatKey;
      const hasAccountId = input.accountId !== undefined;
      const hasReplyContextToken = input.replyContextToken !== undefined;
      const hasCompleteReplyRoute = hasAccountId && hasReplyContextToken;
      const shouldPreserveExistingReplyRoute =
        !hasAccountId &&
        !hasReplyContextToken &&
        sameChat;
      const replyRoute =
        hasCompleteReplyRoute
          ? {
              accountId: input.accountId,
              replyContextToken: input.replyContextToken,
            }
          : shouldPreserveExistingReplyRoute && existing?.accountId && existing?.replyContextToken
            ? {
                accountId: existing.accountId,
                replyContextToken: existing.replyContextToken,
              }
            : undefined;
      const route: OrchestrationCoordinatorRouteContextRecord = {
        coordinatorSession: routeKey,
        chatKey: input.chatKey,
        ...(input.sessionAlias ? { sessionAlias: input.sessionAlias } : {}),
        ...(replyRoute ? replyRoute : {}),
        ...buildCoordinatorRouteChatMetadata(input, sameChat ? existing : undefined),
        updatedAt: now,
      };
      this.kernel.ensureCoordinatorRoutes(state)[routeKey] = route;
      await this.deps.saveState(state);
      return { ...route };
    });
  }

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
      this.startWorkerCancellation(prepared.task);
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
        await this.reconcileParallelSlots();
      } catch (error) {
        this.kernel.logEvent("orchestration.parallel.reconcile_failed", "reconcile failed after contested result accepted", {
          taskId: prepared.task.taskId,
          message: error instanceof Error ? error.message : String(error),
        });
      }
    }

    return prepared.task;
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

  async cancelTask(input: CancelTaskInput): Promise<OrchestrationTaskRecord> {
    return await this.requestTaskCancellation(input);
  }

  async requestTaskCancellation(input: CancelTaskInput): Promise<OrchestrationTaskRecord> {
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

    if (prepared.shouldPropagate) {
      this.startWorkerCancellation(prepared.task);
    }
    if (prepared.closedPackageId) {
      await this.questionFlow.handoffQueuedQuestions(prepared.task.coordinatorSession, prepared.closedPackageId);
    }

    // I-2: non-running cancel transitions the task directly to `cancelled` without
    // going through launchWorkerTurn. Fire reconcile so the ephemeral acpx session
    // is closed promptly and any queued parallel tasks can drain. This also fires
    // for non-parallel tasks — reconcile is idempotent and cheap in that case.
    if (!prepared.shouldPropagate && this.kernel.isTerminalStatus(prepared.task.status)) {
      try {
        await this.reconcileParallelSlots();
      } catch (error) {
        this.kernel.logEvent("orchestration.parallel.reconcile_failed", "reconcile failed after non-running cancel", {
          taskId: prepared.task.taskId,
          message: error instanceof Error ? error.message : String(error),
        });
      }
    }

    return prepared.task;
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
      await this.reconcileParallelSlots();
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

  async approveTask(input: ConfirmTaskInput): Promise<OrchestrationTaskRecord> {
    // Pre-check outside the mutex as a fail-fast gate.  The snapshot may be stale
    // by the time we acquire the lock (e.g. a concurrent cancellation), but this
    // avoids entering the mutex — and the expensive ensureWorkerSession I/O — for
    // obviously invalid requests.  Ownership and status are re-validated inside
    // the mutex below.
    const currentTask = await this.getTask(input.taskId);
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

  private buildGroupSummary(
    group: OrchestrationGroupRecord,
    tasks: OrchestrationTaskRecord[],
  ): OrchestrationGroupSummary {
    const sortedTasks = tasks
      .slice()
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt))
      .map((task) => ({ ...task }));

    const pendingApprovalTasks = sortedTasks.filter(
      (task) => task.status === "needs_confirmation",
    ).length;
    const runningTasks = sortedTasks.filter((task) => task.status === "running").length;
    const completedTasks = sortedTasks.filter((task) => task.status === "completed").length;
    const failedTasks = sortedTasks.filter((task) => task.status === "failed").length;
    const cancelledTasks = sortedTasks.filter((task) => task.status === "cancelled").length;

    return {
      group: { ...group },
      tasks: sortedTasks,
      totalTasks: sortedTasks.length,
      pendingApprovalTasks,
      runningTasks,
      completedTasks,
      failedTasks,
      cancelledTasks,
      terminal:
        sortedTasks.length > 0 &&
        sortedTasks.every((task) => task.reviewPending === undefined) &&
        sortedTasks.every((task) => this.kernel.isTerminalStatus(task.status)),
    };
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

  private assertNeedsConfirmation(task: OrchestrationTaskRecord): void {
    if (task.status !== "needs_confirmation") {
      throw new Error(`task "${task.taskId}" is ${task.status}, not needs_confirmation`);
    }
  }

  async reconcileParallelSlots(): Promise<void> {
    return await this.workerSessions.reconcileParallelSlots();
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

  private startWorkerCancellation(task: OrchestrationTaskRecord): void {
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


function buildCoordinatorRouteChatMetadata(
  input: {
    channel?: string;
    chatType?: "direct" | "group";
    senderId?: string;
    senderName?: string;
    groupId?: string;
    isOwner?: boolean;
  },
  existing?: OrchestrationCoordinatorRouteContextRecord,
): Pick<
  OrchestrationCoordinatorRouteContextRecord,
  "channel" | "chatType" | "senderId" | "senderName" | "groupId" | "isOwner"
> {
  const channel = input.channel ?? existing?.channel;
  const chatType = input.chatType ?? existing?.chatType;
  const senderId = input.senderId ?? existing?.senderId;
  const senderName = input.senderName ?? existing?.senderName;
  const groupId = input.groupId ?? existing?.groupId;
  const isOwner = input.isOwner ?? existing?.isOwner;
  return {
    ...(channel !== undefined ? { channel } : {}),
    ...(chatType !== undefined ? { chatType } : {}),
    ...(senderId !== undefined ? { senderId } : {}),
    ...(senderName !== undefined ? { senderName } : {}),
    ...(groupId !== undefined ? { groupId } : {}),
    ...(isOwner !== undefined ? { isOwner } : {}),
  };
}

function isTerminalTaskStatus(status: OrchestrationTaskStatus): boolean {
  return status === "completed" || status === "failed" || status === "cancelled";
}

function isAttentionRequiredTask(task: OrchestrationTaskRecord): boolean {
  return (
    task.reviewPending !== undefined ||
    task.status === "needs_confirmation" ||
    task.status === "blocked" ||
    task.status === "waiting_for_human"
  );
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

function isRequestDelegateInput(
  input: RequestDelegateInput | RequestDelegateRpcInput,
): input is RequestDelegateInput {
  return "sourceKind" in input;
}
