// packages/relay-protocol/src/payload-validators.ts
// Runtime validators for hub→connector control RPCs. Each validator checks a payload's
// SHAPE (field presence + type, including literal unions and nested objects) and returns
// the narrowed payload, or null when malformed. Semantic checks (non-empty, valid ISO date,
// existence) stay in the connector's dispatch — these only guard the wire shape.
//
// The registry keys are the control-RPC MessageTypes; `satisfies Record<ControlRpcType, …>`
// makes tsc fail if a control RPC is added to the union without a validator (or vice versa),
// and `parseControlPayload` forces every connector dispatch arm to register its message type.
import {
  MSG,
  type AgentsCreatePayload,
  type AgentsRemovePayload,
  type BotsCreatePayload,
  type BotsDeletePayload,
  type BotsGetPayload,
  type BotsUpdatePayload,
  type CommandExecutePayload,
  type ConversationHistoryPayload,
  type ConversationPromptPayload,
  type ConversationsGetPayload,
  type ConversationsListPayload,
  type GroupsCreatePayload,
  type GroupsDeletePayload,
  type GroupsGetPayload,
  type GroupsUpdatePayload,
  type GroupTopicsArchivePayload,
  type GroupTopicsCreatePayload,
  type GroupTopicsTeardownPayload,
  type FsCopyPayload,
  type FsCreatePayload,
  type FsDeletePayload,
  type FsDiffPayload,
  type FsDownloadPayload,
  type FsBrowsePayload,
  type FsListPayload,
  type FsReadPayload,
  type FsRenamePayload,
  type FsSearchPayload,
  type FsWritePayload,
  type GitCheckoutPayload,
  type GitCommitPayload,
  type GitFetchPayload,
  type GitPathsPayload,
  type GitPullPayload,
  type GitPushPayload,
  type GitStatusPayload,
  type GitWorktreeCreatePayload,
  type OrchestrationCancelPayload,
  type OrchestrationGetPayload,
  type PromptCancelPayload,
  type PromptPayload,
  type QueueCancelPayload,
  type RunsCancelPayload,
  type RunsGetPayload,
  type RunsListPayload,
  type ScheduledCancelPayload,
  type ScheduledCreatePayload,
  type ScheduledListPayload,
  type SessionModelGetPayload,
  type SessionModelSetPayload,
  type SessionEffortGetPayload,
  type SessionEffortSetPayload,
  type SessionsArchivePayload,
  type SessionsCreatePayload,
  type SessionsListPayload,
  type SessionsNativeListPayload,
  type SessionsRemovePayload,
  type SessionsRenamePayload,
  type SessionsUnarchivePayload,
  type TerminalAttachPayload,
  type TerminalCreatePayload,
  type TerminalDetachPayload,
  type TerminalHeartbeatPayload,
  type TerminalInputPayload,
  type TerminalOpenPayload,
  type TerminalResyncPayload,
  type TerminalResizePayload,
  type TerminalResourceExitPayload,
  type TerminalStreamStartPayload,
  type TerminalTakeControlPayload,
  type TerminalTerminatePayload,
  type TerminalViewerEventInner,
  type TerminalViewerEventPayload,
  type TopicsCreatePayload,
  type TopicsListPayload,
  type UploadPayload,
  type WorkspacesCreatePayload,
  type WorkspacesRemovePayload,
} from "./messages.js";
import {
  MAX_TERMINAL_ATTACHMENT_ID_LENGTH,
  MAX_TERMINAL_COLS,
  MAX_TERMINAL_ERROR_MESSAGE_LENGTH,
  MAX_TERMINAL_GENERATION_LENGTH,
  MAX_TERMINAL_ID_LENGTH,
  MAX_TERMINAL_INPUT_BYTES,
  MAX_TERMINAL_REBASE_TOTAL_BYTES,
  MAX_TERMINAL_ROWS,
  MAX_TERMINAL_SESSION_ALIAS_LENGTH,
  MAX_TERMINAL_VIEWER_ID_LENGTH,
  MIN_TERMINAL_COLS,
  MIN_TERMINAL_ROWS,
  TERMINAL_REBASE_CHUNK_BYTES,
} from "./limits.js";
import {
  isBoundedStr,
  isIntInRange,
  isNonNegInt,
  isObj,
  isStr,
  optStr,
  optNum,
  optBool,
  parseCanonicalBase64,
} from "./validate-primitives.js";

export type Validator<T> = (payload: unknown) => T | null;

/** Non-null-object view for field access, or null. */
const fields = (p: unknown): Record<string, unknown> | null => (isObj(p) ? p : null);

const isArr = (v: unknown): boolean => Array.isArray(v);
const optArr = (v: unknown): boolean => v === undefined || Array.isArray(v);
const isStrArr = (v: unknown): boolean => Array.isArray(v) && v.every(isStr);
const optStrOrNull = (v: unknown): boolean => v === undefined || v === null || typeof v === "string";
const optBoolOrNull = (v: unknown): boolean => v === undefined || v === null || typeof v === "boolean";

// --- session / agent / workspace ---
const validateSessionsList: Validator<SessionsListPayload> = (p) => {
  const o = fields(p);
  return o && isStr(o.chatKey) && optNum(o.offset) && optNum(o.limit) && optBool(o.includeArchived)
    && optBool(o.archivedOnly) && optStr(o.workspace) && optStr(o.agent) ? (o as unknown as SessionsListPayload) : null;
};
const validateSessionsCreate: Validator<SessionsCreatePayload> = (p) => {
  const o = fields(p);
  return o && isStr(o.chatKey) && isStr(o.alias) && isStr(o.agent) && isStr(o.workspace)
    && optStr(o.agentSessionId) && optStr(o.model) ? (o as unknown as SessionsCreatePayload) : null;
};
const validateSessionsNativeList: Validator<SessionsNativeListPayload> = (p) => {
  const o = fields(p);
  return o && isStr(o.chatKey) && isStr(o.agent) && isStr(o.workspace) ? (o as unknown as SessionsNativeListPayload) : null;
};
const validateSessionsRemove: Validator<SessionsRemovePayload> = (p) => {
  const o = fields(p);
  return o && isStr(o.chatKey) && isStr(o.alias) ? (o as unknown as SessionsRemovePayload) : null;
};
const validateSessionsArchive: Validator<SessionsArchivePayload> = (p) => {
  const o = fields(p);
  return o && isStr(o.chatKey) && isStr(o.alias) ? (o as unknown as SessionsArchivePayload) : null;
};
const validateSessionsUnarchive: Validator<SessionsUnarchivePayload> = (p) => {
  const o = fields(p);
  return o && isStr(o.chatKey) && isStr(o.alias) ? (o as unknown as SessionsUnarchivePayload) : null;
};
const validateSessionsRename: Validator<SessionsRenamePayload> = (p) => {
  const o = fields(p);
  return o && isStr(o.chatKey) && isStr(o.alias) && isStr(o.displayName) ? (o as unknown as SessionsRenamePayload) : null;
};
const validateWorkspacesCreate: Validator<WorkspacesCreatePayload> = (p) => {
  const o = fields(p);
  return o && isStr(o.name) && isStr(o.cwd) && optStr(o.description) ? (o as unknown as WorkspacesCreatePayload) : null;
};
const validateAgentsCreate: Validator<AgentsCreatePayload> = (p) => {
  const o = fields(p);
  return o && isStr(o.name) && isStr(o.driver) ? (o as unknown as AgentsCreatePayload) : null;
};
const validateAgentsRemove: Validator<AgentsRemovePayload> = (p) => {
  const o = fields(p);
  return o && isStr(o.name) ? (o as unknown as AgentsRemovePayload) : null;
};
const validateWorkspacesRemove: Validator<WorkspacesRemovePayload> = (p) => {
  const o = fields(p);
  return o && isStr(o.name) ? (o as unknown as WorkspacesRemovePayload) : null;
};

// --- prompt / command / queue ---
const validatePrompt: Validator<PromptPayload> = (p) => {
  const o = fields(p);
  return o && isStr(o.chatKey) && isStr(o.sessionAlias) && isStr(o.text) && isStr(o.senderId)
    && optBool(o.isOwner) && optArr(o.media) && optArr(o.agentMentions) && optStr(o.promptRequestId) ? (o as unknown as PromptPayload) : null;
};
const validatePromptCancel: Validator<PromptCancelPayload> = (p) => {
  const o = fields(p);
  return o && isStr(o.chatKey) && isStr(o.sessionAlias) ? (o as unknown as PromptCancelPayload) : null;
};
const validateQueueCancel: Validator<QueueCancelPayload> = (p) => {
  const o = fields(p);
  return o && isStr(o.chatKey) && isStr(o.sessionAlias) && isStr(o.itemId) ? (o as unknown as QueueCancelPayload) : null;
};
const validateCommandExecute: Validator<CommandExecutePayload> = (p) => {
  const o = fields(p);
  return o && isStr(o.chatKey) && isStr(o.text) && isStr(o.senderId) && optBool(o.isOwner)
    ? (o as unknown as CommandExecutePayload) : null;
};

// --- scheduled ---
const validateScheduledList: Validator<ScheduledListPayload> = (p) => {
  const o = fields(p);
  return o && isStr(o.chatKey) ? (o as unknown as ScheduledListPayload) : null;
};
const validateScheduledCreate: Validator<ScheduledCreatePayload> = (p) => {
  const o = fields(p);
  return o && isStr(o.chatKey) && isStr(o.sessionAlias) && isStr(o.executeAt) && isStr(o.message)
    ? (o as unknown as ScheduledCreatePayload) : null;
};
const validateScheduledCancel: Validator<ScheduledCancelPayload> = (p) => {
  const o = fields(p);
  return o && isStr(o.id) && isStr(o.chatKey) ? (o as unknown as ScheduledCancelPayload) : null;
};

// --- orchestration ---
const validateOrchestrationGet: Validator<OrchestrationGetPayload> = (p) => {
  const o = fields(p);
  return o && isStr(o.taskId) ? (o as unknown as OrchestrationGetPayload) : null;
};
const validateOrchestrationCancel: Validator<OrchestrationCancelPayload> = (p) => {
  const o = fields(p);
  return o && isStr(o.taskId) ? (o as unknown as OrchestrationCancelPayload) : null;
};

// --- fs (read family: workspace + optional path) ---
const validateFsList: Validator<FsListPayload> = (p) => {
  const o = fields(p);
  return o && isStr(o.workspace) && optStr(o.path) ? (o as unknown as FsListPayload) : null;
};
const validateFsBrowse: Validator<FsBrowsePayload> = (p) => {
  const o = fields(p);
  return o && optStr(o.path) ? (o as unknown as FsBrowsePayload) : null;
};
const validateFsRead: Validator<FsReadPayload> = (p) => {
  const o = fields(p);
  return o && isStr(o.workspace) && isStr(o.path) ? (o as unknown as FsReadPayload) : null;
};
const validateFsDiff: Validator<FsDiffPayload> = (p) => {
  const o = fields(p);
  return o && isStr(o.workspace) && optStr(o.path) ? (o as unknown as FsDiffPayload) : null;
};
const validateFsSearch: Validator<FsSearchPayload> = (p) => {
  const o = fields(p);
  return o && isStr(o.workspace) && isStr(o.query)
    && (o.mode === undefined || o.mode === "name" || o.mode === "content")
    && optBool(o.matchCase) && optBool(o.wholeWord) && optBool(o.regex)
    && optStr(o.include) && optStr(o.exclude) && optStr(o.path)
    ? (o as unknown as FsSearchPayload) : null;
};

// --- fs (mutating family) ---
const validateFsCreate: Validator<FsCreatePayload> = (p) => {
  const o = fields(p);
  return o && isStr(o.workspace) && isStr(o.path) && (o.kind === "file" || o.kind === "dir")
    ? (o as unknown as FsCreatePayload) : null;
};
const validateFsRename: Validator<FsRenamePayload> = (p) => {
  const o = fields(p);
  return o && isStr(o.workspace) && isStr(o.path) && isStr(o.newName) ? (o as unknown as FsRenamePayload) : null;
};
const validateFsDelete: Validator<FsDeletePayload> = (p) => {
  const o = fields(p);
  return o && isStr(o.workspace) && isStr(o.path) ? (o as unknown as FsDeletePayload) : null;
};
const validateFsCopy: Validator<FsCopyPayload> = (p) => {
  const o = fields(p);
  return o && isStr(o.workspace) && isStr(o.path) ? (o as unknown as FsCopyPayload) : null;
};
const validateFsDownload: Validator<FsDownloadPayload> = (p) => {
  const o = fields(p);
  return o && isStr(o.workspace) && isStr(o.path) ? (o as unknown as FsDownloadPayload) : null;
};
const validateFsWrite: Validator<FsWritePayload> = (p) => {
  const o = fields(p);
  if (!o || !isStr(o.workspace) || !isStr(o.path) || !isStr(o.content)) return null;
  const exp = fields(o.expected);
  if (!exp || typeof exp.mtimeMs !== "number" || typeof exp.size !== "number") return null;
  return o as unknown as FsWritePayload;
};

// --- git (structured actions only; never accepts argv or a client-selected worktree path) ---
const validateGitStatus: Validator<GitStatusPayload> = (p) => {
  const o = fields(p);
  return o && isStr(o.workspace) ? (o as unknown as GitStatusPayload) : null;
};
const validateGitPaths: Validator<GitPathsPayload> = (p) => {
  const o = fields(p);
  return o && isStr(o.workspace) && isStrArr(o.paths) ? (o as unknown as GitPathsPayload) : null;
};
const validateGitCommit: Validator<GitCommitPayload> = (p) => {
  const o = fields(p);
  return o && isStr(o.workspace) && isStr(o.message) ? (o as unknown as GitCommitPayload) : null;
};
const validateGitFetch: Validator<GitFetchPayload> = (p) => {
  const o = fields(p);
  return o && isStr(o.workspace) && optStr(o.remote) ? (o as unknown as GitFetchPayload) : null;
};
const validateGitPull: Validator<GitPullPayload> = validateGitStatus;
const validateGitPush: Validator<GitPushPayload> = (p) => {
  const o = fields(p);
  return o && isStr(o.workspace) && optBool(o.setUpstream) && optStr(o.remote)
    ? (o as unknown as GitPushPayload) : null;
};
const validateGitCheckout: Validator<GitCheckoutPayload> = (p) => {
  const o = fields(p);
  return o && isStr(o.workspace) && isStr(o.branch) && optBool(o.create) && optStr(o.startPoint)
    ? (o as unknown as GitCheckoutPayload) : null;
};
const validateGitWorktreeCreate: Validator<GitWorktreeCreatePayload> = (p) => {
  const o = fields(p);
  return o && isStr(o.workspace) && isStr(o.workspaceName) && isStr(o.branch)
    && optBool(o.createBranch) && optStr(o.startPoint) && o.path === undefined
    ? (o as unknown as GitWorktreeCreatePayload) : null;
};

// --- model / terminal / upload ---
const validateSessionModelGet: Validator<SessionModelGetPayload> = (p) => {
  const o = fields(p);
  return o && isStr(o.chatKey) && isStr(o.sessionAlias) ? (o as unknown as SessionModelGetPayload) : null;
};
const validateSessionModelSet: Validator<SessionModelSetPayload> = (p) => {
  const o = fields(p);
  return o && isStr(o.chatKey) && isStr(o.sessionAlias) && isStr(o.modelId) ? (o as unknown as SessionModelSetPayload) : null;
};
const validateSessionEffortGet: Validator<SessionEffortGetPayload> = (p) => {
  const o = fields(p);
  return o && isStr(o.chatKey) && isStr(o.sessionAlias) ? (o as unknown as SessionEffortGetPayload) : null;
};
const validateSessionEffortSet: Validator<SessionEffortSetPayload> = (p) => {
  const o = fields(p);
  return o && isStr(o.chatKey) && isStr(o.sessionAlias) && isStr(o.effort)
    ? (o as unknown as SessionEffortSetPayload) : null;
};
const validateTerminalCreate: Validator<TerminalCreatePayload> = (p) => {
  const o = fields(p);
  return o && isStr(o.chatKey) && isStr(o.sessionAlias) && optNum(o.cols) && optNum(o.rows)
    ? (o as unknown as TerminalCreatePayload) : null;
};
const validateTerminalAttach: Validator<TerminalAttachPayload> = (p) => {
  const o = fields(p);
  return o && isStr(o.terminalId) ? (o as unknown as TerminalAttachPayload) : null;
};
const validateTerminalOpen: Validator<TerminalOpenPayload> = (p) => {
  const o = fields(p);
  return o
    && isStr(o.chatKey)
    && isBoundedStr(o.sessionAlias, MAX_TERMINAL_SESSION_ALIAS_LENGTH)
    && isBoundedStr(o.viewerId, MAX_TERMINAL_VIEWER_ID_LENGTH)
    && isIntInRange(o.cols, MIN_TERMINAL_COLS, MAX_TERMINAL_COLS)
    && isIntInRange(o.rows, MIN_TERMINAL_ROWS, MAX_TERMINAL_ROWS)
    && o.cwd === undefined
    ? (o as unknown as TerminalOpenPayload)
    : null;
};
const validateTerminalTakeControl: Validator<TerminalTakeControlPayload> = (p) => {
  const o = fields(p);
  return o
    && isBoundedStr(o.attachmentId, MAX_TERMINAL_ATTACHMENT_ID_LENGTH)
    && isBoundedStr(o.generation, MAX_TERMINAL_GENERATION_LENGTH)
    && isBoundedStr(o.viewerId, MAX_TERMINAL_VIEWER_ID_LENGTH)
    ? (o as unknown as TerminalTakeControlPayload)
    : null;
};
const validateTerminalResync: Validator<TerminalResyncPayload> = (p) => {
  const o = fields(p);
  return o
    && isBoundedStr(o.attachmentId, MAX_TERMINAL_ATTACHMENT_ID_LENGTH)
    && isBoundedStr(o.generation, MAX_TERMINAL_GENERATION_LENGTH)
    && isBoundedStr(o.viewerId, MAX_TERMINAL_VIEWER_ID_LENGTH)
    ? (o as unknown as TerminalResyncPayload)
    : null;
};
const validateTerminalTerminate: Validator<TerminalTerminatePayload> = (p) => {
  const o = fields(p);
  return o
    && isBoundedStr(o.terminalId, MAX_TERMINAL_ID_LENGTH)
    && isBoundedStr(o.generation, MAX_TERMINAL_GENERATION_LENGTH)
    ? (o as unknown as TerminalTerminatePayload)
    : null;
};
const validateUpload: Validator<UploadPayload> = (p) => {
  const o = fields(p);
  return o && isStr(o.filename) && isStr(o.content) && isStr(o.mimeType) ? (o as unknown as UploadPayload) : null;
};

const validateBotsGet: Validator<BotsGetPayload> = (p) => {
  const o = fields(p);
  return o && isStr(o.id) ? (o as unknown as BotsGetPayload) : null;
};
const validateBotsCreate: Validator<BotsCreatePayload> = (p) => {
  const o = fields(p);
  return o && isStr(o.name) && isStr(o.agent) && isStr(o.workspace)
    && optStr(o.avatar) && optStr(o.role) && optStr(o.instructions)
    && optStr(o.model) && optStr(o.effort) && optBool(o.enabled)
    ? (o as unknown as BotsCreatePayload) : null;
};
const validateBotsUpdate: Validator<BotsUpdatePayload> = (p) => {
  const o = fields(p);
  return o && isStr(o.id)
    && optStr(o.name) && optStrOrNull(o.avatar) && optStrOrNull(o.role)
    && optStrOrNull(o.instructions) && optStr(o.agent) && optStr(o.workspace)
    && optStrOrNull(o.model) && optStrOrNull(o.effort) && optBoolOrNull(o.enabled)
    ? (o as unknown as BotsUpdatePayload) : null;
};
const validateBotsDelete: Validator<BotsDeletePayload> = (p) => {
  const o = fields(p);
  return o && isStr(o.id) ? (o as unknown as BotsDeletePayload) : null;
};
const validateConversationsList: Validator<ConversationsListPayload> = (p) => {
  const o = fields(p);
  return o && optStr(o.botId) ? (o as unknown as ConversationsListPayload) : null;
};
const validateConversationsGet: Validator<ConversationsGetPayload> = (p) => {
  const o = fields(p);
  return o && isStr(o.conversationId) ? (o as unknown as ConversationsGetPayload) : null;
};
const validateTopicsList: Validator<TopicsListPayload> = (p) => {
  const o = fields(p);
  return o && isStr(o.conversationId) ? (o as unknown as TopicsListPayload) : null;
};
const validateTopicsCreate: Validator<TopicsCreatePayload> = (p) => {
  const o = fields(p);
  return o && isStr(o.conversationId) && isStr(o.title) ? (o as unknown as TopicsCreatePayload) : null;
};
const isIsolation = (v: unknown): boolean =>
  v === "shared" || v === "shared-single-writer" || v === "worktree-per-member";
const validateGroupsCreate: Validator<GroupsCreatePayload> = (p) => {
  const o = fields(p);
  return o && isStr(o.title) && isStrArr(o.botIds) && (o.description === undefined || isStr(o.description))
    && (o.leadBotId === undefined || isStr(o.leadBotId))
    ? (o as unknown as GroupsCreatePayload) : null;
};
const validateGroupsUpdate: Validator<GroupsUpdatePayload> = (p) => {
  const o = fields(p);
  if (!o || !isStr(o.id)) return null;
  if (o.title !== undefined && !isStr(o.title)) return null;
  if (o.description !== undefined && o.description !== null && !isStr(o.description)) return null;
  if (o.botIds !== undefined && !isStrArr(o.botIds)) return null;
  if (o.leadBotId !== undefined && o.leadBotId !== null && !isStr(o.leadBotId)) return null;
  return o as unknown as GroupsUpdatePayload;
};
const validateGroupsDelete: Validator<GroupsDeletePayload> = (p) => {
  const o = fields(p);
  return o && isStr(o.id) ? (o as unknown as GroupsDeletePayload) : null;
};
const validateGroupsGet: Validator<GroupsGetPayload> = (p) => {
  const o = fields(p);
  return o && isStr(o.id) ? (o as unknown as GroupsGetPayload) : null;
};
const validateGroupsList: Validator<Record<string, never>> = (p) => {
  if (p !== undefined && !isObj(p)) return null;
  return {} as Record<string, never>;
};
const validateGroupTopicsCreate: Validator<GroupTopicsCreatePayload> = (p) => {
  const o = fields(p);
  if (!o || !isStr(o.conversationId) || !isStr(o.title)) return null;
  const t = o.target;
  if (!isObj(t) || !isStr(t.workspace) || (t.cwd !== undefined && !isStr(t.cwd)) || !isIsolation(t.isolation)) {
    return null;
  }
  return o as unknown as GroupTopicsCreatePayload;
};
const validateGroupTopicsArchive: Validator<GroupTopicsArchivePayload> = (p) => {
  const o = fields(p);
  return o && isStr(o.conversationId) && isStr(o.topicId) ? (o as unknown as GroupTopicsArchivePayload) : null;
};
const validateGroupTopicsTeardown: Validator<GroupTopicsTeardownPayload> = (p) => {
  const o = fields(p);
  return o && isStr(o.conversationId) && isStr(o.topicId) ? (o as unknown as GroupTopicsTeardownPayload) : null;
};
const isConversationTarget = (v: unknown): boolean => {
  if (!isObj(v)) return false;
  if (isStr(v.botId)) return true;
  if (v.mode === "members") {
    return Array.isArray(v.botIds) && v.botIds.length > 0 && v.botIds.every(isStr);
  }
  return v.mode === "everyone" || v.mode === "automatic";
};
const validateConversationPrompt: Validator<ConversationPromptPayload> = (p) => {
  const o = fields(p);
  if (!o || !isStr(o.conversationId) || !isStr(o.topicId) || !isStr(o.requestId) || !isStr(o.text)) {
    return null;
  }
  if (o.target !== undefined && !isConversationTarget(o.target)) {
    return null;
  }
  return o as unknown as ConversationPromptPayload;
};
const validateConversationHistory: Validator<ConversationHistoryPayload> = (p) => {
  const o = fields(p);
  if (!o) return null;
  // direction is initial-page-only: it selects which end of the topic the
  // page starts from and has no defined interaction with seq cursors.
  const directionOk = o.direction === undefined || o.direction === "oldest-first" || o.direction === "newest-first";
  const cursorAndDirection = directionOk && o.direction !== undefined
    && (o.afterSeq !== undefined || o.beforeSeq !== undefined);
  if (cursorAndDirection) return null;
  return isStr(o.conversationId) && isStr(o.topicId)
    && optNum(o.afterSeq) && optNum(o.beforeSeq) && optNum(o.limit)
    && directionOk
    ? (o as unknown as ConversationHistoryPayload) : null;
};
const validateRunsGet: Validator<RunsGetPayload> = (p) => {
  const o = fields(p);
  return o && isStr(o.runId) ? (o as unknown as RunsGetPayload) : null;
};
const validateRunsList: Validator<RunsListPayload> = (p) => {
  const o = fields(p);
  return o && isStr(o.conversationId) && isStr(o.topicId) && optNum(o.limit)
    ? (o as unknown as RunsListPayload) : null;
};
const validateRunsCancel: Validator<RunsCancelPayload> = (p) => {
  const o = fields(p);
  return o && isStr(o.runId) ? (o as unknown as RunsCancelPayload) : null;
};
/** The control-RPC message types that carry a client-supplied payload to validate.
 *  Excludes: handshake (instanceRegister/instanceAuth — validated in instance-gateway),
 *  event-direction (instanceEvent/instanceNotice — boundary B via validControlEvent),
 *  terminal I/O events (legacy terminalInput/Resize/Close and recoverable terminal
 *  stream/input/resize/heartbeat/detach/viewer-event/resource-exit — see
 *  parseTerminalEventPayload), and the no-payload list RPCs
 *  (agentsList/workspacesList/agentsCatalog/orchestrationList/botsList). */
export type ControlRpcType =
  | typeof MSG.sessionsList | typeof MSG.sessionsCreate | typeof MSG.sessionsNativeList
  | typeof MSG.sessionsRemove | typeof MSG.sessionsArchive | typeof MSG.sessionsUnarchive
  | typeof MSG.sessionsRename | typeof MSG.workspacesCreate | typeof MSG.agentsCreate
  | typeof MSG.agentsRemove | typeof MSG.workspacesRemove | typeof MSG.prompt
  | typeof MSG.promptCancel | typeof MSG.queueCancel | typeof MSG.commandExecute
  | typeof MSG.scheduledList | typeof MSG.scheduledCreate | typeof MSG.scheduledCancel
  | typeof MSG.orchestrationGet | typeof MSG.orchestrationCancel | typeof MSG.fsList
  | typeof MSG.fsBrowse
  | typeof MSG.fsRead | typeof MSG.fsDiff | typeof MSG.fsSearch | typeof MSG.fsCreate
  | typeof MSG.fsRename | typeof MSG.fsDelete | typeof MSG.fsCopy | typeof MSG.fsDownload
  | typeof MSG.fsWrite | typeof MSG.sessionModelGet | typeof MSG.sessionModelSet
  | typeof MSG.sessionEffortGet | typeof MSG.sessionEffortSet
  | typeof MSG.gitStatus | typeof MSG.gitStage | typeof MSG.gitUnstage
  | typeof MSG.gitUntrack | typeof MSG.gitDiscard | typeof MSG.gitCommit
  | typeof MSG.gitFetch | typeof MSG.gitPull | typeof MSG.gitPush | typeof MSG.gitCheckout
  | typeof MSG.gitWorktreeCreate
  | typeof MSG.terminalCreate | typeof MSG.terminalAttach
  | typeof MSG.terminalOpen | typeof MSG.terminalTakeControl
  | typeof MSG.terminalResync | typeof MSG.terminalTerminate
  | typeof MSG.upload
  | typeof MSG.botsGet | typeof MSG.botsCreate | typeof MSG.botsUpdate | typeof MSG.botsDelete
  | typeof MSG.conversationsList | typeof MSG.conversationsGet
  | typeof MSG.topicsList | typeof MSG.topicsCreate
  | typeof MSG.groupsCreate | typeof MSG.groupsUpdate | typeof MSG.groupsDelete | typeof MSG.groupsGet
  | typeof MSG.groupsList
  | typeof MSG.groupTopicsCreate | typeof MSG.groupTopicsArchive | typeof MSG.groupTopicsTeardown
  | typeof MSG.conversationPrompt | typeof MSG.conversationHistory
  | typeof MSG.runsGet | typeof MSG.runsList | typeof MSG.runsCancel;

/** Registry: control-RPC type → shape validator. `satisfies` locks both directions —
 *  a ControlRpcType with no validator, or a validator whose key isn't a ControlRpcType,
 *  is a compile error. */
export const CONTROL_PAYLOAD_VALIDATORS = {
  [MSG.sessionsList]: validateSessionsList,
  [MSG.sessionsCreate]: validateSessionsCreate,
  [MSG.sessionsNativeList]: validateSessionsNativeList,
  [MSG.sessionsRemove]: validateSessionsRemove,
  [MSG.sessionsArchive]: validateSessionsArchive,
  [MSG.sessionsUnarchive]: validateSessionsUnarchive,
  [MSG.sessionsRename]: validateSessionsRename,
  [MSG.workspacesCreate]: validateWorkspacesCreate,
  [MSG.agentsCreate]: validateAgentsCreate,
  [MSG.agentsRemove]: validateAgentsRemove,
  [MSG.workspacesRemove]: validateWorkspacesRemove,
  [MSG.prompt]: validatePrompt,
  [MSG.promptCancel]: validatePromptCancel,
  [MSG.queueCancel]: validateQueueCancel,
  [MSG.commandExecute]: validateCommandExecute,
  [MSG.scheduledList]: validateScheduledList,
  [MSG.scheduledCreate]: validateScheduledCreate,
  [MSG.scheduledCancel]: validateScheduledCancel,
  [MSG.orchestrationGet]: validateOrchestrationGet,
  [MSG.orchestrationCancel]: validateOrchestrationCancel,
  [MSG.fsList]: validateFsList,
  [MSG.fsBrowse]: validateFsBrowse,
  [MSG.fsRead]: validateFsRead,
  [MSG.fsDiff]: validateFsDiff,
  [MSG.fsSearch]: validateFsSearch,
  [MSG.fsCreate]: validateFsCreate,
  [MSG.fsRename]: validateFsRename,
  [MSG.fsDelete]: validateFsDelete,
  [MSG.fsCopy]: validateFsCopy,
  [MSG.fsDownload]: validateFsDownload,
  [MSG.fsWrite]: validateFsWrite,
  [MSG.gitStatus]: validateGitStatus,
  [MSG.gitStage]: validateGitPaths,
  [MSG.gitUnstage]: validateGitPaths,
  [MSG.gitUntrack]: validateGitPaths,
  [MSG.gitDiscard]: validateGitPaths,
  [MSG.gitCommit]: validateGitCommit,
  [MSG.gitFetch]: validateGitFetch,
  [MSG.gitPull]: validateGitPull,
  [MSG.gitPush]: validateGitPush,
  [MSG.gitCheckout]: validateGitCheckout,
  [MSG.gitWorktreeCreate]: validateGitWorktreeCreate,
  [MSG.sessionModelGet]: validateSessionModelGet,
  [MSG.sessionModelSet]: validateSessionModelSet,
  [MSG.sessionEffortGet]: validateSessionEffortGet,
  [MSG.sessionEffortSet]: validateSessionEffortSet,
  [MSG.terminalCreate]: validateTerminalCreate,
  [MSG.terminalAttach]: validateTerminalAttach,
  [MSG.terminalOpen]: validateTerminalOpen,
  [MSG.terminalTakeControl]: validateTerminalTakeControl,
  [MSG.terminalResync]: validateTerminalResync,
  [MSG.terminalTerminate]: validateTerminalTerminate,
  [MSG.upload]: validateUpload,
  [MSG.botsGet]: validateBotsGet,
  [MSG.botsCreate]: validateBotsCreate,
  [MSG.botsUpdate]: validateBotsUpdate,
  [MSG.botsDelete]: validateBotsDelete,
  [MSG.conversationsList]: validateConversationsList,
  [MSG.conversationsGet]: validateConversationsGet,
  [MSG.topicsList]: validateTopicsList,
  [MSG.topicsCreate]: validateTopicsCreate,
  [MSG.groupsCreate]: validateGroupsCreate,
  [MSG.groupsUpdate]: validateGroupsUpdate,
  [MSG.groupsDelete]: validateGroupsDelete,
  [MSG.groupsGet]: validateGroupsGet,
  [MSG.groupsList]: validateGroupsList,
  [MSG.groupTopicsCreate]: validateGroupTopicsCreate,
  [MSG.groupTopicsArchive]: validateGroupTopicsArchive,
  [MSG.groupTopicsTeardown]: validateGroupTopicsTeardown,
  [MSG.conversationPrompt]: validateConversationPrompt,
  [MSG.conversationHistory]: validateConversationHistory,
  [MSG.runsGet]: validateRunsGet,
  [MSG.runsList]: validateRunsList,
  [MSG.runsCancel]: validateRunsCancel,
} satisfies Record<ControlRpcType, Validator<unknown>>;

/** The payload type bound to a control-RPC message, derived from its validator's return. */
export type PayloadFor<T extends ControlRpcType> =
  NonNullable<ReturnType<(typeof CONTROL_PAYLOAD_VALIDATORS)[T]>>;

/** Type-safe replacement for `payload as XxxPayload`: validates shape, returns the bound
 *  payload type or null. */
export function parseControlPayload<T extends ControlRpcType>(type: T, payload: unknown): PayloadFor<T> | null {
  const validate = CONTROL_PAYLOAD_VALIDATORS[type] as unknown as Validator<PayloadFor<T>>;
  return validate(payload);
}

function expectedRebaseChunkCount(totalBytes: number): number {
  return totalBytes === 0 ? 0 : Math.ceil(totalBytes / TERMINAL_REBASE_CHUNK_BYTES);
}

function validTerminalViewerEventInner(event: unknown): event is TerminalViewerEventInner {
  if (!isObj(event) || typeof event.kind !== "string") return false;
  switch (event.kind) {
    case "terminal-rebase-start":
      return isBoundedStr(event.generation, MAX_TERMINAL_GENERATION_LENGTH)
        && isNonNegInt(event.epoch)
        && isNonNegInt(event.nextSequence)
        && isIntInRange(event.cols, MIN_TERMINAL_COLS, MAX_TERMINAL_COLS)
        && isIntInRange(event.rows, MIN_TERMINAL_ROWS, MAX_TERMINAL_ROWS)
        && typeof event.alternate === "boolean"
        && isIntInRange(event.totalBytes, 0, MAX_TERMINAL_REBASE_TOTAL_BYTES)
        && isNonNegInt(event.chunkCount)
        && event.chunkCount === expectedRebaseChunkCount(event.totalBytes);
    case "terminal-rebase-chunk":
      return isBoundedStr(event.generation, MAX_TERMINAL_GENERATION_LENGTH)
        && isNonNegInt(event.epoch)
        && isNonNegInt(event.index)
        && parseCanonicalBase64(event.dataBase64, TERMINAL_REBASE_CHUNK_BYTES) !== null;
    case "terminal-rebase-end":
      return isBoundedStr(event.generation, MAX_TERMINAL_GENERATION_LENGTH)
        && isNonNegInt(event.epoch);
    case "terminal-bytes":
      return isBoundedStr(event.generation, MAX_TERMINAL_GENERATION_LENGTH)
        && isNonNegInt(event.epoch)
        && isNonNegInt(event.sequence)
        && parseCanonicalBase64(event.dataBase64, MAX_TERMINAL_INPUT_BYTES) !== null;
    case "terminal-role-changed":
      return isBoundedStr(event.terminalId, MAX_TERMINAL_ID_LENGTH)
        && (event.role === "controller" || event.role === "spectator")
        && isNonNegInt(event.viewerCount);
    case "terminal-request-failed":
      return optStr(event.requestId)
        && (event.requestId === undefined || isBoundedStr(event.requestId, 128))
        && isBoundedStr(event.code, 128)
        && typeof event.message === "string"
        && event.message.length <= MAX_TERMINAL_ERROR_MESSAGE_LENGTH;
    case "terminal-recovery-failed":
      return isBoundedStr(event.generation, MAX_TERMINAL_GENERATION_LENGTH)
        && isBoundedStr(event.code, 128)
        && typeof event.message === "string"
        && event.message.length <= MAX_TERMINAL_ERROR_MESSAGE_LENGTH;
    default:
      return false;
  }
}

const validateTerminalStreamStart: Validator<TerminalStreamStartPayload> = (p) => {
  const o = fields(p);
  return o
    && isBoundedStr(o.attachmentId, MAX_TERMINAL_ATTACHMENT_ID_LENGTH)
    && isBoundedStr(o.viewerId, MAX_TERMINAL_VIEWER_ID_LENGTH)
    ? (o as unknown as TerminalStreamStartPayload)
    : null;
};
const validateTerminalInputEvent: Validator<TerminalInputPayload> = (p) => {
  const o = fields(p);
  return o
    && isBoundedStr(o.attachmentId, MAX_TERMINAL_ATTACHMENT_ID_LENGTH)
    && isBoundedStr(o.generation, MAX_TERMINAL_GENERATION_LENGTH)
    && isBoundedStr(o.viewerId, MAX_TERMINAL_VIEWER_ID_LENGTH)
    && parseCanonicalBase64(o.dataBase64, MAX_TERMINAL_INPUT_BYTES) !== null
    && o.terminalId === undefined
    && o.data === undefined
    ? (o as unknown as TerminalInputPayload)
    : null;
};
const validateTerminalResizeEvent: Validator<TerminalResizePayload> = (p) => {
  const o = fields(p);
  return o
    && isBoundedStr(o.attachmentId, MAX_TERMINAL_ATTACHMENT_ID_LENGTH)
    && isBoundedStr(o.generation, MAX_TERMINAL_GENERATION_LENGTH)
    && isBoundedStr(o.viewerId, MAX_TERMINAL_VIEWER_ID_LENGTH)
    && isIntInRange(o.cols, MIN_TERMINAL_COLS, MAX_TERMINAL_COLS)
    && isIntInRange(o.rows, MIN_TERMINAL_ROWS, MAX_TERMINAL_ROWS)
    && o.terminalId === undefined
    ? (o as unknown as TerminalResizePayload)
    : null;
};
const validateTerminalHeartbeat: Validator<TerminalHeartbeatPayload> = (p) => {
  const o = fields(p);
  return o
    && isBoundedStr(o.attachmentId, MAX_TERMINAL_ATTACHMENT_ID_LENGTH)
    && isBoundedStr(o.viewerId, MAX_TERMINAL_VIEWER_ID_LENGTH)
    ? (o as unknown as TerminalHeartbeatPayload)
    : null;
};
const validateTerminalDetach: Validator<TerminalDetachPayload> = (p) => {
  const o = fields(p);
  return o
    && isBoundedStr(o.attachmentId, MAX_TERMINAL_ATTACHMENT_ID_LENGTH)
    && isBoundedStr(o.viewerId, MAX_TERMINAL_VIEWER_ID_LENGTH)
    ? (o as unknown as TerminalDetachPayload)
    : null;
};
const validateTerminalViewerEvent: Validator<TerminalViewerEventPayload> = (p) => {
  const o = fields(p);
  return o
    && isBoundedStr(o.viewerId, MAX_TERMINAL_VIEWER_ID_LENGTH)
    && isBoundedStr(o.attachmentId, MAX_TERMINAL_ATTACHMENT_ID_LENGTH)
    && validTerminalViewerEventInner(o.event)
    ? (o as unknown as TerminalViewerEventPayload)
    : null;
};
const validateTerminalResourceExit: Validator<TerminalResourceExitPayload> = (p) => {
  const o = fields(p);
  return o
    && isBoundedStr(o.terminalId, MAX_TERMINAL_ID_LENGTH)
    && isBoundedStr(o.generation, MAX_TERMINAL_GENERATION_LENGTH)
    && isBoundedStr(o.reason, 128)
    && optNum(o.code)
    && (o.code === undefined || Number.isInteger(o.code))
    ? (o as unknown as TerminalResourceExitPayload)
    : null;
};

/** Recoverable terminal event message types (hub↔connector fire-and-forget / targeted push). */
export type TerminalEventType =
  | typeof MSG.terminalStreamStart
  | typeof MSG.terminalInput
  | typeof MSG.terminalResize
  | typeof MSG.terminalHeartbeat
  | typeof MSG.terminalDetach
  | typeof MSG.terminalViewerEvent
  | typeof MSG.terminalResourceExit;

export const TERMINAL_EVENT_PAYLOAD_VALIDATORS = {
  [MSG.terminalStreamStart]: validateTerminalStreamStart,
  [MSG.terminalInput]: validateTerminalInputEvent,
  [MSG.terminalResize]: validateTerminalResizeEvent,
  [MSG.terminalHeartbeat]: validateTerminalHeartbeat,
  [MSG.terminalDetach]: validateTerminalDetach,
  [MSG.terminalViewerEvent]: validateTerminalViewerEvent,
  [MSG.terminalResourceExit]: validateTerminalResourceExit,
} satisfies Record<TerminalEventType, Validator<unknown>>;

export type TerminalEventPayloadFor<T extends TerminalEventType> =
  NonNullable<ReturnType<(typeof TERMINAL_EVENT_PAYLOAD_VALIDATORS)[T]>>;

/** Validate a recoverable terminal event payload (not the legacy live-PTY shapes). */
export function parseTerminalEventPayload<T extends TerminalEventType>(
  type: T,
  payload: unknown,
): TerminalEventPayloadFor<T> | null {
  const validate = TERMINAL_EVENT_PAYLOAD_VALIDATORS[type] as unknown as Validator<TerminalEventPayloadFor<T>>;
  return validate(payload);
}

// --- Type-level binding assertions -------------------------------------------------
// These live here, not in the test file: `tests/` is outside every tsconfig's `include`,
// so a type-level assertion written there is never checked by tsc. Compiled by
// `tsc -p packages/relay-protocol/tsconfig.json` (run by `bun run build:relay-protocol`).
//
// What they catch: a registry entry wired to the wrong validator, e.g.
// `[MSG.fsWrite]: validateFsRead` — `satisfies Record<ControlRpcType, Validator<unknown>>`
// accepts that, these do not. They cannot catch a validator that skips a field check
// (each is annotated `Validator<XxxPayload>` and returns through `as unknown`, so its
// return type is fixed by the annotation); the runtime suite covers that.
type Expect<T extends true> = T;
type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;

type _fsWriteBound = Expect<Equal<PayloadFor<typeof MSG.fsWrite>, FsWritePayload>>;
type _promptBound = Expect<Equal<PayloadFor<typeof MSG.prompt>, PromptPayload>>;
type _fsReadBound = Expect<Equal<PayloadFor<typeof MSG.fsRead>, FsReadPayload>>;
type _uploadBound = Expect<Equal<PayloadFor<typeof MSG.upload>, UploadPayload>>;
type _gitCheckoutBound = Expect<Equal<PayloadFor<typeof MSG.gitCheckout>, GitCheckoutPayload>>;
type _gitWorktreeCreateBound = Expect<Equal<PayloadFor<typeof MSG.gitWorktreeCreate>, GitWorktreeCreatePayload>>;
type _gitUntrackBound = Expect<Equal<PayloadFor<typeof MSG.gitUntrack>, GitPathsPayload>>;
type _gitDiscardBound = Expect<Equal<PayloadFor<typeof MSG.gitDiscard>, GitPathsPayload>>;
type _terminalOpenBound = Expect<Equal<PayloadFor<typeof MSG.terminalOpen>, TerminalOpenPayload>>;
type _terminalTerminateBound = Expect<Equal<PayloadFor<typeof MSG.terminalTerminate>, TerminalTerminatePayload>>;
type _terminalInputEventBound = Expect<Equal<TerminalEventPayloadFor<typeof MSG.terminalInput>, TerminalInputPayload>>;
