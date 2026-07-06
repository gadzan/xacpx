import type { AgentCatalogEntryDto, AgentDto, ControlEventDto, FsDiffFileDto, FsEntryDto, FsSearchHitDto, OrchestrationTaskDto, ScheduledTaskDto, SessionDto, WorkspaceDto } from "./dtos.js";
export declare const MSG: {
    readonly instanceRegister: "instance.register";
    readonly instanceAuth: "instance.auth";
    readonly instanceEvent: "instance.event";
    readonly instanceNotice: "instance.notice";
    readonly sessionsList: "control.sessions.list";
    readonly sessionsCreate: "control.sessions.create";
    readonly sessionsNativeList: "control.sessions.native.list";
    readonly sessionsRemove: "control.sessions.remove";
    readonly sessionsArchive: "control.sessions.archive";
    readonly sessionsUnarchive: "control.sessions.unarchive";
    readonly sessionsRename: "control.sessions.rename";
    readonly agentsList: "control.agents.list";
    readonly workspacesList: "control.workspaces.list";
    readonly workspacesCreate: "control.workspaces.create";
    readonly agentsCatalog: "control.agents.catalog";
    readonly agentsCreate: "control.agents.create";
    readonly agentsRemove: "control.agents.remove";
    readonly workspacesRemove: "control.workspaces.remove";
    readonly prompt: "control.prompt";
    readonly promptCancel: "control.prompt.cancel";
    readonly queueCancel: "control.queue.cancel";
    readonly commandExecute: "control.command.execute";
    readonly scheduledList: "control.scheduled.list";
    readonly scheduledCreate: "control.scheduled.create";
    readonly scheduledCancel: "control.scheduled.cancel";
    readonly orchestrationList: "control.orchestration.list";
    readonly orchestrationGet: "control.orchestration.get";
    readonly orchestrationCancel: "control.orchestration.cancel";
    readonly fsList: "control.fs.list";
    readonly fsRead: "control.fs.read";
    readonly fsDiff: "control.fs.diff";
    readonly fsSearch: "control.fs.search";
    readonly fsCreate: "control.fs.create";
    readonly fsRename: "control.fs.rename";
    readonly fsDelete: "control.fs.delete";
    readonly fsCopy: "control.fs.copy";
    readonly fsDownload: "control.fs.download";
    readonly fsWrite: "control.fs.write";
    readonly upload: "control.upload";
    readonly sessionModelGet: "control.session.model.get";
    readonly sessionModelSet: "control.session.model.set";
    readonly terminalCreate: "control.terminal.create";
    readonly terminalAttach: "control.terminal.attach";
    readonly terminalInput: "instance.terminal.input";
    readonly terminalResize: "instance.terminal.resize";
    readonly terminalClose: "instance.terminal.close";
};
export type MessageType = (typeof MSG)[keyof typeof MSG];
export interface ErrorPayload {
    error: {
        code: string;
        message: string;
    };
}
export declare function errorPayload(code: string, message: string): ErrorPayload;
export declare function isErrorPayload(payload: unknown): payload is ErrorPayload;
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
export interface InstanceEventPayload {
    event: ControlEventDto;
}
export interface InstanceNoticePayload {
    kind: "task-completion" | "task-progress" | "coordinator-message";
    text: string;
    taskId?: string;
    chatKey?: string;
}
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
    /** Filesystem mtime in ms; paired with `size` as a stale-write token for editing. */
    mtimeMs: number;
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
    worktree?: {
        root: string;
        linked: boolean;
    };
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
export interface FsCreatePayload {
    workspace: string;
    path: string;
    kind: "file" | "dir";
}
export interface FsRenamePayload {
    workspace: string;
    path: string;
    newName: string;
}
export interface FsDeletePayload {
    workspace: string;
    path: string;
}
export interface FsCopyPayload {
    workspace: string;
    path: string;
}
export interface FsDownloadPayload {
    workspace: string;
    path: string;
}
export interface FsMutateResult {
    path: string;
}
export interface FsDownloadResult {
    path: string;
    base64: string;
    size: number;
    mimeType: string;
}
export interface FsWritePayload {
    workspace: string;
    path: string;
    /** Full new UTF-8 file content. */
    content: string;
    /** Stale-write token captured at read time; the write is rejected if disk no longer matches. */
    expected: {
        mtimeMs: number;
        size: number;
    };
}
export interface FsWriteResult {
    path: string;
    mtimeMs: number;
    size: number;
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
