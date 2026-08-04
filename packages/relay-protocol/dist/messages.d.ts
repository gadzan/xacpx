import type { AgentCatalogEntryDto, AgentCommandDto, AgentDto, ControlEventDto, FsDiffFileDto, FsEntryDto, FsSearchHitDto, OrchestrationTaskDto, ScheduledOriginDto, ScheduledTaskDto, SessionDto, ToolStepDto, TurnPartDto, UsageBreakdownDto, UsageCostDto, WorkspaceDto } from "./dtos.js";
export declare const MSG: {
    readonly instanceRegister: "instance.register";
    readonly instanceAuth: "instance.auth";
    readonly instanceEvent: "instance.event";
    readonly instanceStateSync: "instance.state.sync";
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
    readonly gitStatus: "control.git.status";
    readonly gitStage: "control.git.stage";
    readonly gitUnstage: "control.git.unstage";
    readonly gitUntrack: "control.git.untrack";
    readonly gitDiscard: "control.git.discard";
    readonly gitCommit: "control.git.commit";
    readonly gitFetch: "control.git.fetch";
    readonly gitPull: "control.git.pull";
    readonly gitPush: "control.git.push";
    readonly gitCheckout: "control.git.checkout";
    readonly gitWorktreeCreate: "control.git.worktree.create";
    readonly upload: "control.upload";
    readonly sessionModelGet: "control.session.model.get";
    readonly sessionModelSet: "control.session.model.set";
    readonly sessionEffortGet: "control.session.effort.get";
    readonly sessionEffortSet: "control.session.effort.set";
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
/** Full mirror of the instance-scoped in-memory hub state (turn buffers / usage /
 *  commands), pushed by the connector right after every (re-)auth. The hub replaces
 *  its in-memory state for that instance with this snapshot — additive protocol, so
 *  old hubs (unknown message type) and old connectors (never sent) degrade to the
 *  pre-sync behavior. */
export interface InstanceStateSyncPayload {
    turns: Array<{
        sessionAlias: string;
        prompt?: string;
        scheduled?: ScheduledOriginDto;
        queueItemId?: string;
        /** ms epoch captured by the connector at the ORIGINAL turn start. */
        startedAt: number;
        text: string;
        reasoning: string;
        steps: ToolStepDto[];
        /** Ordered activity stream. Optional for connectors predating ordered recovery. */
        parts?: TurnPartDto[];
        /** true = connector capped the mirror; content after that point is lost. */
        truncated?: boolean;
    }>;
    usage: Array<{
        sessionAlias: string;
        used: number;
        size: number;
        cost?: UsageCostDto;
        breakdown?: UsageBreakdownDto;
    }>;
    commands: Array<{
        sessionAlias: string;
        commands: AgentCommandDto[];
    }>;
    /** Turns that finished while the hub was unreachable; hub must persist them.
     *  `prompt` backfills the turn's `in` row when the turn STARTED during the outage
     *  too, so the recovered answer never appears as an orphan in history. */
    finishedOffline: Array<{
        sessionAlias: string;
        ok: boolean;
        errorMessage?: string;
        cancelled?: boolean;
        text?: string;
        prompt?: string;
        recoveryId?: string;
    }>;
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
export interface GitStatusPayload {
    workspace: string;
}
export interface GitBranchDto {
    name: string;
    current: boolean;
    worktreePath?: string;
}
export interface GitWorktreeDto {
    path: string;
    branch?: string;
    detached?: boolean;
    current: boolean;
    linked: boolean;
}
export interface GitStatusResult {
    workspace: string;
    branch?: string;
    detached: boolean;
    upstream?: string;
    ahead: number;
    behind: number;
    worktree: {
        root: string;
        linked: boolean;
    };
    files: FsDiffFileDto[];
    branches: GitBranchDto[];
    worktrees: GitWorktreeDto[];
}
export interface GitPathsPayload {
    workspace: string;
    paths: string[];
}
export interface GitCommitPayload {
    workspace: string;
    message: string;
}
export interface GitCommitResult {
    hash: string;
    shortHash: string;
    summary: string;
}
export interface GitFetchPayload {
    workspace: string;
    remote?: string;
}
export interface GitPullPayload {
    workspace: string;
}
export interface GitPushPayload {
    workspace: string;
    setUpstream?: boolean;
    remote?: string;
}
export interface GitCheckoutPayload {
    workspace: string;
    branch: string;
    create?: boolean;
    startPoint?: string;
}
export interface GitWorktreeCreatePayload {
    workspace: string;
    workspaceName: string;
    branch: string;
    createBranch?: boolean;
    startPoint?: string;
}
export interface GitWorktreeCreateResult {
    worktree: {
        path: string;
        branch: string;
        linked: true;
    };
    workspace: WorkspaceDto;
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
export interface SessionModelSetResult {
    /** Whether the requested model was observed after the operation settled. */
    ok: boolean;
    /** Authoritative transport model after timeout reconciliation, if known. */
    current?: string | null;
}
export interface SessionModelResult {
    /** The session's current model id, if known. */
    current?: string;
    /** Agent-advertised model ids the session can switch to (may be empty). */
    available: string[];
}
export interface SessionEffortGetPayload {
    chatKey: string;
    sessionAlias: string;
}
export interface SessionEffortSetPayload {
    chatKey: string;
    sessionAlias: string;
    effort: string;
}
export interface SessionEffortSetResult {
    ok: boolean;
    current?: string | null;
}
export interface SessionEffortResult {
    current?: string;
    available: string[];
}
export interface TerminalCreatePayload {
    chatKey: string;
    sessionAlias: string;
    cols?: number;
    rows?: number;
}
export interface TerminalAttachPayload {
    terminalId: string;
}
