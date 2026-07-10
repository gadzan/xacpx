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
import { CoordinatorRegistryService } from "./service/coordinator-registry-service";
import { GroupService } from "./service/group-service";
import { HumanDelegationService } from "./service/human-delegation-service";
import { HumanQuestionService } from "./service/human-question-service";
import { NoticeDeliveryService } from "./service/notice-delivery-service";
import { OrchestrationStateKernel } from "./service/orchestration-state-kernel";
import { QuestionFlowCore } from "./service/question-flow-core";
import { RpcDelegationService } from "./service/rpc-delegation-service";
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
  private readonly rpcDelegation: RpcDelegationService;
  private readonly humanDelegation: HumanDelegationService;

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
    this.rpcDelegation = new RpcDelegationService(deps, this.kernel, this.workerSessions);
    this.humanDelegation = new HumanDelegationService(deps, this.kernel, this.workerSessions, this.rpcDelegation);
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
    return await this.humanDelegation.requestDelegate(input);
  }

  async requestDelegateFromRpc(input: RequestDelegateRpcInput): Promise<RequestDelegateRpcResult> {
    return await this.rpcDelegation.requestDelegateFromRpc(input);
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

  async reconcileParallelSlots(): Promise<void> {
    return await this.workerSessions.reconcileParallelSlots();
  }

}
