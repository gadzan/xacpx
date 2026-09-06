import type { SessionTransportEngine } from "../state/types";

export type OrchestrationTaskStatus =
  | "needs_confirmation"
  | "queued"
  | "running"
  | "blocked"
  | "waiting_for_human"
  | "completed"
  | "failed"
  | "cancelled";

export type OrchestrationSourceKind = "human" | "coordinator" | "worker";

export interface OrchestrationOpenQuestionRecord {
  questionId: string;
  question: string;
  whyBlocked: string;
  whatIsNeeded: string;
  askedAt: string;
  status: "open" | "answered" | "superseded";
  answeredAt?: string;
  answerSource?: "coordinator" | "human";
  answerText?: string;
  packageId?: string;
  lastWakeError?: string;
  lastResumeError?: string;
}

export interface OrchestrationReviewPendingRecord {
  reviewId: string;
  reason: "misrouted_answer";
  createdAt: string;
  resultId: string;
  resultText: string;
}

export interface OrchestrationCorrectionPendingRecord {
  requestedAt: string;
  reason: "misrouted_answer";
}

export interface OrchestrationTaskRecord {
  taskId: string;
  sourceHandle: string;
  sourceKind: OrchestrationSourceKind;
  coordinatorSession: string;
  workerSession?: string;
  workspace: string;
  cwd?: string;
  targetAgent: string;
  role?: string;
  task: string;
  status: OrchestrationTaskStatus;
  summary: string;
  resultText: string;
  createdAt: string;
  updatedAt: string;
  chatKey?: string;
  replyContextToken?: string;
  accountId?: string;
  deliveryAccountId?: string;
  coordinatorInjectedAt?: string;
  cancelRequestedAt?: string;
  cancelCompletedAt?: string;
  lastCancelError?: string;
  noticePending?: boolean;
  noticeSentAt?: string;
  lastNoticeError?: string;
  injectionPending?: boolean;
  injectionAppliedAt?: string;
  lastInjectionError?: string;
  lastProgressAt?: string;
  lastProgressSummary?: string;
  groupId?: string;
  /** True when this task owns an ephemeral parallel-slot worker session that must be closed on terminal. */
  ephemeralWorkerSession?: boolean;
  /** Idempotency guard: set once the ephemeral worker session has been closed. */
  ephemeralWorkerSessionClosed?: boolean;
  openQuestion?: OrchestrationOpenQuestionRecord;
  reviewPending?: OrchestrationReviewPendingRecord;
  correctionPending?: OrchestrationCorrectionPendingRecord;
  eventSeq?: number;
  events?: OrchestrationTaskEventRecord[];
}

export type OrchestrationTaskEventType =
  | "created"
  | "progress"
  | "status_changed"
  | "attention_required"
  | "cancel_requested";

export interface OrchestrationTaskEventRecord {
  seq: number;
  at: string;
  type: OrchestrationTaskEventType;
  status?: OrchestrationTaskStatus;
  summary?: string;
  message?: string;
}

export interface OrchestrationGroupRecord {
  groupId: string;
  coordinatorSession: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  coordinatorInjectedAt?: string;
  injectionPending?: boolean;
  injectionAppliedAt?: string;
  lastInjectionError?: string;
}

export interface OrchestrationGroupSummary {
  group: OrchestrationGroupRecord;
  tasks: OrchestrationTaskRecord[];
  totalTasks: number;
  pendingApprovalTasks: number;
  runningTasks: number;
  completedTasks: number;
  failedTasks: number;
  cancelledTasks: number;
  terminal: boolean;
}

export interface ExternalCoordinatorRecord {
  coordinatorSession: string;
  /** Stable Agent Messaging identity. Missing only while a legacy state record is migrated. */
  agentEndpointId?: string;
  workspace?: string;
  createdAt: string;
  updatedAt: string;
  defaultTargetAgent?: string;
}

export interface WorkerBindingRecord {
  sourceHandle: string;
  /** Stable Agent Messaging identity. Missing only while a legacy state record is migrated. */
  agentEndpointId?: string;
  coordinatorSession: string;
  workspace: string;
  cwd?: string;
  targetAgent: string;
  role?: string;
  /** True for ephemeral parallel-slot sessions; excluded from findReusableWorkerSession matching. */
  ephemeral?: boolean;
  /** New bindings use the ACP stdout guard; absent means a legacy unguarded binding. */
  guardAcpOutput?: boolean;
  logicalSessionId?: string;
  transportEngine?: SessionTransportEngine;
}

export interface OrchestrationQueuedQuestionRecord {
  taskId: string;
  questionId: string;
  enqueuedAt: string;
}

export interface OrchestrationCoordinatorQuestionStateRecord {
  activePackageId?: string;
  queuedQuestions: OrchestrationQueuedQuestionRecord[];
}

export interface OrchestrationCoordinatorRouteContextRecord {
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
  updatedAt: string;
}

export interface OrchestrationHumanQuestionPackageMessageRecord {
  messageId: string;
  kind: "initial" | "follow_up";
  promptText: string;
  createdAt: string;
  taskQuestions?: Array<{
    taskId: string;
    questionId: string;
  }>;
  routeChatKey?: string;
  routeAccountId?: string;
  routeReplyContextToken?: string;
  deliveredAt?: string;
  deliveredChatKey?: string;
  deliveryAccountId?: string;
  lastDeliveryError?: string;
}

export interface OrchestrationHumanQuestionPackageRecord {
  packageId: string;
  coordinatorSession: string;
  status: "active" | "closed";
  createdAt: string;
  updatedAt: string;
  closedAt?: string;
  initialTaskIds: string[];
  openTaskIds: string[];
  resolvedTaskIds: string[];
  messages: OrchestrationHumanQuestionPackageMessageRecord[];
  awaitingReplyMessageId?: string;
}

export interface OrchestrationState {
  tasks: Record<string, OrchestrationTaskRecord>;
  workerBindings: Record<string, WorkerBindingRecord>;
  groups: Record<string, OrchestrationGroupRecord>;
  humanQuestionPackages: Record<string, OrchestrationHumanQuestionPackageRecord>;
  coordinatorQuestionState: Record<string, OrchestrationCoordinatorQuestionStateRecord>;
  coordinatorRoutes: Record<string, OrchestrationCoordinatorRouteContextRecord>;
  externalCoordinators: Record<string, ExternalCoordinatorRecord>;
}

export function createEmptyOrchestrationState(): OrchestrationState {
  return {
    tasks: {},
    workerBindings: {},
    groups: {},
    humanQuestionPackages: {},
    coordinatorQuestionState: {},
    coordinatorRoutes: {},
    externalCoordinators: {},
  };
}

export function isTerminalTaskStatus(status: OrchestrationTaskStatus): boolean {
  return status === "completed" || status === "failed" || status === "cancelled";
}

export function isAttentionRequiredTask(task: OrchestrationTaskRecord): boolean {
  return (
    task.reviewPending !== undefined ||
    task.status === "needs_confirmation" ||
    task.status === "blocked" ||
    task.status === "waiting_for_human"
  );
}
