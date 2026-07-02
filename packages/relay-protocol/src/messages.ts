import type { AgentCatalogEntryDto, AgentDto, ControlEventDto, FsDiffFileDto, FsEntryDto, FsSearchHitDto, OrchestrationTaskDto, ScheduledTaskDto, SessionDto, WorkspaceDto } from "./dtos.js";

// Instance <-> relay message types. Convention: chatKey for relay-driven chats
// is `relay:<accountId>`; the relay server stamps chatKey/senderId/isOwner on
// chat-scoped requests server-side (clients cannot forge them).
export const MSG = {
  instanceRegister: "instance.register",
  instanceAuth: "instance.auth",
  instanceEvent: "instance.event",
  instanceNotice: "instance.notice",
  sessionsList: "control.sessions.list",
  sessionsCreate: "control.sessions.create",
  sessionsNativeList: "control.sessions.native.list",
  sessionsRemove: "control.sessions.remove",
  sessionsArchive: "control.sessions.archive",
  sessionsUnarchive: "control.sessions.unarchive",
  sessionsRename: "control.sessions.rename",
  agentsList: "control.agents.list",
  workspacesList: "control.workspaces.list",
  workspacesCreate: "control.workspaces.create",
  agentsCatalog: "control.agents.catalog",
  agentsCreate: "control.agents.create",
  agentsRemove: "control.agents.remove",
  workspacesRemove: "control.workspaces.remove",
  prompt: "control.prompt",
  promptCancel: "control.prompt.cancel",
  queueCancel: "control.queue.cancel",
  commandExecute: "control.command.execute",
  scheduledList: "control.scheduled.list",
  scheduledCreate: "control.scheduled.create",
  scheduledCancel: "control.scheduled.cancel",
  orchestrationList: "control.orchestration.list",
  orchestrationGet: "control.orchestration.get",
  orchestrationCancel: "control.orchestration.cancel",
  fsList: "control.fs.list",
  fsRead: "control.fs.read",
  fsDiff: "control.fs.diff",
  fsSearch: "control.fs.search",
  upload: "control.upload",
  sessionModelGet: "control.session.model.get",
  sessionModelSet: "control.session.model.set",
  terminalCreate: "control.terminal.create",
  terminalInput: "instance.terminal.input",
  terminalResize: "instance.terminal.resize",
  terminalClose: "instance.terminal.close",
} as const;

export type MessageType = (typeof MSG)[keyof typeof MSG];

export interface ErrorPayload {
  error: { code: string; message: string };
}

export function errorPayload(code: string, message: string): ErrorPayload {
  return { error: { code, message } };
}

export function isErrorPayload(payload: unknown): payload is ErrorPayload {
  if (typeof payload !== "object" || payload === null) return false;
  const candidate = (payload as Record<string, unknown>).error;
  if (typeof candidate !== "object" || candidate === null) return false;
  const error = candidate as Record<string, unknown>;
  return typeof error.code === "string" && typeof error.message === "string";
}

// --- handshake ---
export interface InstanceRegisterPayload {
  pairingToken: string;
  name?: string;
  coreVersion?: string;
}
export interface InstanceRegisterResult {
  instanceId: string;
  credential: string;
}
export interface InstanceAuthPayload {
  instanceId: string;
  credential: string;
  coreVersion?: string;
}
export interface InstanceAuthResult {
  ok: true;
}

// --- instance push ---
export interface InstanceEventPayload {
  event: ControlEventDto;
}
export interface InstanceNoticePayload {
  kind: "task-completion" | "task-progress" | "coordinator-message";
  text: string;
  taskId?: string;
  chatKey?: string;
}

// --- control RPCs (relay -> instance req; instance res) ---
export interface SessionsListPayload {
  /** Server-stamped `relay:<accountId>`; scopes the listing to that channel. */
  chatKey: string;
}
export interface SessionsListResult {
  sessions: SessionDto[];
}
export interface SessionsCreatePayload {
  /** Server-stamped `relay:<accountId>`; scopes the new session to that channel. */
  chatKey: string;
  alias: string;
  agent: string;
  workspace: string;
  /** When set, resume this existing agent-native session instead of creating a fresh one. */
  agentSessionId?: string;
  /** Optional per-session model override (e.g. `gpt-5.2[high]`). Omitted/empty means
   *  "use the agent's default model" — the web form's `default` choice. */
  model?: string;
}
export type SessionsCreateResult = SessionDto;

/** An agent-native (acpx-owned) session offered in the web add-session "native" picker. */
export interface NativeSessionDto {
  sessionId: string;
  title?: string | null;
  updatedAt?: string;
  cwd?: string;
}
export interface SessionsNativeListPayload {
  /** Server-stamped `relay:<accountId>`. */
  chatKey: string;
  agent: string;
  workspace: string;
}
export interface SessionsNativeListResult {
  sessions: NativeSessionDto[];
}
export interface SessionsRemovePayload {
  /** Server-stamped `relay:<accountId>`; scopes the alias to that channel. */
  chatKey: string;
  alias: string;
}
export interface SessionsRemoveResult {
  wasActive: boolean;
}
export interface SessionsArchivePayload {
  chatKey: string;
  alias: string;
}
export interface SessionsUnarchivePayload {
  chatKey: string;
  alias: string;
}
export interface SessionsRenamePayload {
  /** Server-stamped `relay:<accountId>`; scopes the alias to that channel. */
  chatKey: string;
  alias: string;
  /** New display label; empty string clears the override (UI falls back to alias). */
  displayName: string;
}
export interface SessionsRenameResult {
  ok: true;
}
export interface AgentsListResult {
  agents: AgentDto[];
}
export interface WorkspacesListResult {
  workspaces: WorkspaceDto[];
}
export interface WorkspacesCreatePayload {
  name: string;
  cwd: string;
  description?: string;
}
export interface WorkspacesCreateResult {
  workspace: WorkspaceDto;
}
export interface AgentsCatalogResult {
  agents: AgentCatalogEntryDto[];
}
export interface AgentsCreatePayload {
  name: string;
  driver: string;
}
export interface AgentsCreateResult {
  agent: AgentDto;
}
export interface AgentsRemovePayload {
  name: string;
}
export interface WorkspacesRemovePayload {
  name: string;
}
export interface OkResult {
  ok: true;
}
export interface PromptAttachmentRef {
  /** Stable id from the upload step; used as a message id for the channel media source. */
  id: string;
  /** Absolute path on the daemon host (returned by control.upload). */
  filePath: string;
  fileName: string;
  mimeType: string;
  kind: "image" | "file";
  size: number;
  /** Downscaled data URL for images; carried so the hub can persist a preview. Omitted for files. */
  previewUrl?: string;
}

export interface UploadPayload {
  filename: string;
  /** base64-encoded file bytes (no data-URL prefix). */
  content: string;
  mimeType: string;
}

export interface UploadResult {
  id: string;
  /** Absolute path on the daemon host where the bytes were written. */
  path: string;
  filename: string;
  mimeType: string;
  size: number;
}

export interface PromptPayload {
  chatKey: string;
  sessionAlias: string;
  text: string;
  senderId: string;
  isOwner?: boolean;
  media?: PromptAttachmentRef[];
}
export interface PromptResult {
  ok: boolean;
  text?: string;
  errorMessage?: string;
  /** True when the prompt was enqueued behind a running turn instead of dispatched
   *  immediately; `queueItemId` identifies the queued entry for later cancellation. */
  queued?: boolean;
  queueItemId?: string;
}
export interface PromptCancelPayload {
  chatKey: string;
  sessionAlias: string;
}
export interface PromptCancelResult {
  cancelled: boolean;
}
export interface QueueCancelPayload {
  chatKey: string;
  sessionAlias: string;
  itemId: string;
}
export interface QueueCancelResult {
  cancelled: boolean;
}
export interface CommandExecutePayload {
  chatKey: string;
  text: string;
  senderId: string;
  isOwner?: boolean;
}
export interface CommandExecuteResult {
  output: string;
}
export interface ScheduledListPayload {
  chatKey: string;
}
export interface ScheduledListResult {
  tasks: ScheduledTaskDto[];
}
export interface ScheduledCreatePayload {
  chatKey: string;
  sessionAlias: string;
  /** ISO timestamp. */
  executeAt: string;
  message: string;
}
export type ScheduledCreateResult = ScheduledTaskDto;
export interface ScheduledCancelPayload {
  id: string;
  chatKey: string;
}
export interface ScheduledCancelResult {
  cancelled: boolean;
}
export interface OrchestrationListResult {
  tasks: OrchestrationTaskDto[];
}
export interface OrchestrationGetPayload {
  taskId: string;
}
export interface OrchestrationGetResult {
  task: OrchestrationTaskDto | null;
}
export interface OrchestrationCancelPayload {
  taskId: string;
}
export type OrchestrationCancelResult = OrchestrationTaskDto;

// --- workspace file browser (read-only, scoped to a configured workspace root) ---
export interface FsListPayload {
  /** Configured workspace name. */
  workspace: string;
  /** Directory path relative to the workspace root; defaults to the root. */
  path?: string;
}
export interface FsListResult {
  workspace: string;
  /** Normalized path relative to the workspace root ("" = root). */
  path: string;
  entries: FsEntryDto[];
  /** Absolute realpath'd workspace root on the connector host. */
  root: string;
  /** Host path separator. */
  sep: "/" | "\\";
}
export interface FsReadPayload {
  workspace: string;
  /** File path relative to the workspace root. */
  path: string;
}
export interface FsReadResult {
  workspace: string;
  path: string;
  /** UTF-8 content (possibly truncated). Empty when `binary` is true. */
  content: string;
  /** Total file size in bytes. */
  size: number;
  /** True when the file exceeded the read cap and `content` is a prefix. */
  truncated: boolean;
  /** True when the file looks binary; `content` is then empty. */
  binary: boolean;
}
export interface FsDiffPayload {
  workspace: string;
  /** Optional file path (relative) to scope the diff; defaults to the whole tree. */
  path?: string;
}
export interface FsDiffResult {
  workspace: string;
  /** Changed files from `git status` (includes untracked). */
  files: FsDiffFileDto[];
  /** Unified diff text vs HEAD (possibly truncated). */
  diff: string;
  truncated: boolean;
  /** Symbolic branch name (abbrev-ref HEAD); omitted when HEAD is detached. */
  branch?: string;
  /** True when HEAD is detached (no branch). */
  detached?: boolean;
  /** Working-tree context: top-level root, and whether it's a linked (non-primary) worktree. */
  worktree?: { root: string; linked: boolean };
}
export interface FsSearchPayload {
  workspace: string;
  /** Case-insensitive substring matched against each file's relative path (name mode)
   *  or file content (content mode). */
  query: string;
  /** Search target; defaults to "name" when omitted. */
  mode?: "name" | "content";
  matchCase?: boolean;
  wholeWord?: boolean;
  regex?: boolean;
  /** Glob to restrict matches (relative to workspace root). */
  include?: string;
  /** Glob to drop matches. */
  exclude?: string;
  /** Base directory (relative) to scope the search. */
  path?: string;
}
export interface FsSearchResult {
  workspace: string;
  query: string;
  /** Matching file paths relative to the workspace root (name mode). */
  matches: string[];
  /** Content matches (content mode). */
  hits: FsSearchHitDto[];
  /** True when the result cap was hit. */
  truncated: boolean;
}

export interface SessionModelGetPayload {
  chatKey: string;
  sessionAlias: string;
}

export interface SessionModelSetPayload {
  chatKey: string;
  sessionAlias: string;
  modelId: string;
}

export interface SessionModelResult {
  /** The session's current model id, if known. */
  current?: string;
  /** Agent-advertised model ids the session can switch to (may be empty). */
  available: string[];
}
