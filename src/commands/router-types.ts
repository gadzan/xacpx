import type { ConfigStore } from "../config/config-store";
import type { AppConfig } from "../config/types";
import type { AppLogger } from "../logging/app-logger";
import type { OrchestrationService } from "../orchestration/orchestration-service";
import type { SessionService } from "../sessions/session-service";
import type { PromptMediaInput, PromptUsage, ReplyQuotaContext, SessionTransport } from "../transport/types";
import type { QuotaManager } from "../weixin/messaging/quota-manager.js";
import type { PlanEntry, ToolUseEvent } from "../channels/types.js";
import type { PerfSpan } from "../perf/perf-tracer";

export interface RouterResponse {
  text?: string;
}

export interface PromptRouteMetadata {
  chatKey: string;
  replyContextToken?: string;
  accountId?: string;
}

export interface CoordinatorTaskQuestionRef {
  taskId: string;
  questionId: string;
}

export interface ActiveHumanQuestionPackageContext {
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

export type WritableConfigStore = Pick<
  ConfigStore,
  | "load"
  | "upsertWorkspace"
  | "removeWorkspace"
  | "upsertAgent"
  | "removeAgent"
  | "updateTransport"
  | "updateChannel"
  | "getRawValue"
  | "setRawValue"
  | "unsetRawValue"
>;

export interface CommandRouterContext {
  sessions: SessionService;
  transport: SessionTransport;
  orchestration?: OrchestrationRouterOps;
  config?: AppConfig;
  configStore?: WritableConfigStore;
  logger: AppLogger;
  replaceConfig: (updated: AppConfig) => void;
  quota?: QuotaManager;
  /**
   * Resolves the render format for a chat's `/ssn` native session list. Backed
   * by the channel's declared capability (see MessageChannelRuntime
   * `nativeSessionListFormat`); handlers default to "table" when unset.
   */
  resolveNativeSessionListFormat?: (chatKey: string) => "cards" | "table";
}

export interface OrchestrationRouterOps {
  createGroup: OrchestrationService["createGroup"];
  getGroupSummary: OrchestrationService["getGroupSummary"];
  listGroupSummaries: OrchestrationService["listGroupSummaries"];
  cancelGroup: OrchestrationService["cancelGroup"];
  requestDelegate: OrchestrationService["requestDelegate"];
  getTask: OrchestrationService["getTask"];
  listTasks: OrchestrationService["listTasks"];
  requestTaskCancellation: OrchestrationService["requestTaskCancellation"];
  cancelTask: OrchestrationService["cancelTask"];
  approveTask: OrchestrationService["approveTask"];
  cleanTasks: OrchestrationService["cleanTasks"];
  listSessionBlockingTasks: OrchestrationService["listSessionBlockingTasks"];
  purgeSessionReferences: OrchestrationService["purgeSessionReferences"];
  listPendingTaskNotices: OrchestrationService["listPendingTaskNotices"];
  markTaskNoticeDelivered: OrchestrationService["markTaskNoticeDelivered"];
  markTaskNoticeFailed: OrchestrationService["markTaskNoticeFailed"];
  listPendingCoordinatorGroups?: OrchestrationService["listPendingCoordinatorGroups"];
  markCoordinatorGroupsInjected?: OrchestrationService["markCoordinatorGroupsInjected"];
  markCoordinatorGroupsInjectionFailed?: OrchestrationService["markCoordinatorGroupsInjectionFailed"];
  listPendingCoordinatorResults: OrchestrationService["listPendingCoordinatorResults"];
  listPendingCoordinatorBlockers?: OrchestrationService["listPendingCoordinatorBlockers"];
  listContestedCoordinatorResults?: OrchestrationService["listContestedCoordinatorResults"];
  markCoordinatorResultsInjected?: OrchestrationService["markCoordinatorResultsInjected"];
  markTaskInjectionApplied: OrchestrationService["markTaskInjectionApplied"];
  markTaskInjectionFailed: OrchestrationService["markTaskInjectionFailed"];
  recordCoordinatorRouteContext?: OrchestrationService["recordCoordinatorRouteContext"];
  claimActiveHumanReply?: OrchestrationService["claimActiveHumanReply"];
  getActiveHumanQuestionPackage?: (
    coordinatorSession: string,
  ) => Promise<ActiveHumanQuestionPackageContext | null>;
  reserveLogicalTransportSession?: OrchestrationService["reserveLogicalTransportSession"];
}

export interface SessionLifecycleOps {
  resolveSession: (alias: string, agent: string, workspace: string, transportSession: string) => import("../transport/types").ResolvedSession;
  ensureTransportSession: (
    session: import("../transport/types").ResolvedSession,
    reply?: (text: string) => Promise<void>,
    perfSpan?: PerfSpan,
  ) => Promise<void>;
  checkTransportSession: (session: import("../transport/types").ResolvedSession) => Promise<boolean>;
  markSessionReady?: (session: import("../transport/types").ResolvedSession) => void;
  reserveTransportSession: (transportSession: string) => Promise<() => Promise<void>>;
  handleSessionShortcut: (
    chatKey: string,
    agent: string,
    target: { cwd?: string; workspace?: string },
    createNew: boolean,
    reply?: (text: string) => Promise<void>,
  ) => Promise<RouterResponse>;
  resetCurrentSession: (chatKey: string, reply?: (text: string) => Promise<void>) => Promise<RouterResponse>;
  refreshSessionTransportAgentCommand: (alias: string) => Promise<void>;
}

export interface SessionInteractionOps {
  setModeTransportSession: (session: import("../transport/types").ResolvedSession, modeId: string) => Promise<void>;
  setModelTransportSession: (session: import("../transport/types").ResolvedSession, modelId: string) => Promise<void>;
  getModelTransportSession: (
    session: import("../transport/types").ResolvedSession,
  ) => Promise<{ current?: string; available: string[] }>;
  cancelTransportSession: (
    session: import("../transport/types").ResolvedSession,
  ) => Promise<{ cancelled: boolean; message: string }>;
  promptTransportSession: (
    session: import("../transport/types").ResolvedSession,
    text: string,
    reply?: (text: string) => Promise<void>,
    replyContext?: ReplyQuotaContext,
    media?: PromptMediaInput,
    abortSignal?: AbortSignal,
    onToolEvent?: (event: ToolUseEvent) => void | Promise<void>,
    onThought?: (chunk: string) => void | Promise<void>,
    perfSpan?: PerfSpan,
    onPlan?: (entries: PlanEntry[]) => void | Promise<void>,
    onUsage?: (usage: PromptUsage) => void | Promise<void>,
  ) => Promise<{ text: string }>;
}

export interface SessionRenderRecoveryOps {
  renderSessionCreationError: (session: import("../transport/types").ResolvedSession, error: unknown) => RouterResponse;
  renderSessionCreationVerificationError: (session: import("../transport/types").ResolvedSession) => RouterResponse;
  tryRecoverMissingSession: (
    session: import("../transport/types").ResolvedSession,
    error: unknown,
  ) => Promise<import("../transport/types").ResolvedSession | null>;
  renderTransportError: (session: import("../transport/types").ResolvedSession, error: unknown) => RouterResponse;
}

export interface SessionShortcutOps {
  resolveSession: (alias: string, agent: string, workspace: string, transportSession: string) => import("../transport/types").ResolvedSession;
  ensureTransportSession: (
    session: import("../transport/types").ResolvedSession,
    reply?: (text: string) => Promise<void>,
    perfSpan?: PerfSpan,
  ) => Promise<void>;
  checkTransportSession: (session: import("../transport/types").ResolvedSession) => Promise<boolean>;
  reserveTransportSession: (transportSession: string) => Promise<() => Promise<void>>;
  refreshSessionTransportAgentCommand: (alias: string) => Promise<void>;
}

export interface SessionRecoveryOps {
  resolveSessionAgentCommand: (
    session: import("../transport/types").ResolvedSession,
  ) => Promise<string | undefined | null>;
  setSessionTransportAgentCommand: (alias: string, command: string) => Promise<void>;
  getSession: (alias: string) => Promise<import("../transport/types").ResolvedSession | null>;
}


export interface SessionResetOps {
  ensureTransportSession: (
    session: import("../transport/types").ResolvedSession,
    reply?: (text: string) => Promise<void>,
    perfSpan?: PerfSpan,
  ) => Promise<void>;
  checkTransportSession: (session: import("../transport/types").ResolvedSession) => Promise<boolean>;
  reserveTransportSession: (transportSession: string) => Promise<() => Promise<void>>;
  resolveSession: (alias: string, agent: string, workspace: string, transportSession: string) => import("../transport/types").ResolvedSession;
  refreshSessionTransportAgentCommand: (alias: string) => Promise<void>;
  now: () => number;
}

export type ScheduledRouterOps = Pick<
  import("../scheduled/scheduled-service").ScheduledTaskService,
  "createTask" | "listPending" | "cancelPending"
>;

export interface ScheduledDeliveryCapabilityOps {
  supportsScheduledMessages(chatKey: string): boolean;
}
