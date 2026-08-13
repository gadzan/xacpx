import type { AgentCatalogEntryDto, AgentCommandDto, AgentDto, ControlEventDto, FsDiffFileDto, FsEntryDto, FsSearchHitDto, OrchestrationTaskDto, ScheduledOriginDto, ScheduledTaskDto, SessionDto, ToolStepDto, TurnPartDto, UsageBreakdownDto, UsageCostDto, WorkspaceDto } from "./dtos.js";
export declare const MSG: {
    readonly instanceRegister: "instance.register";
    readonly instanceAuth: "instance.auth";
    readonly instanceEvent: "instance.event";
    readonly instanceStateSync: "instance.state.sync";
    /** Hub → connector: the persisted `recoveryId`s from a just-committed
     *  `instance.state.sync` (or a live `turn-finished`). The connector retires its
     *  finished-offline FIFO entries ONLY on this ack — a ws flush callback only
     *  proves the frame left the process, not that the hub committed the rows, so
     *  confirming on flush would drop entries when the hub dies before the SQLite
     *  commit (a permanent history hole on the next reconnect). */
    readonly instanceRecoveryAck: "instance.recovery.ack";
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
    /** Legacy live-PTY input AND recoverable RMUX input share this wire name; payload shape differs by capability path. */
    readonly terminalInput: "instance.terminal.input";
    /** Legacy live-PTY resize AND recoverable RMUX resize share this wire name; payload shape differs by capability path. */
    readonly terminalResize: "instance.terminal.resize";
    readonly terminalClose: "instance.terminal.close";
    readonly terminalOpen: "instance.terminal.open";
    readonly terminalTakeControl: "instance.terminal.take-control";
    readonly terminalResync: "instance.terminal.resync";
    readonly terminalTerminate: "instance.terminal.terminate";
    readonly terminalStreamStart: "instance.terminal.stream-start";
    readonly terminalHeartbeat: "instance.terminal.heartbeat";
    readonly terminalDetach: "instance.terminal.detach";
    readonly terminalViewerEvent: "instance.terminal.viewer-event";
    readonly terminalResourceExit: "instance.terminal.resource-exit";
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
    /** Confirmed connector capability snapshot; omit/undefined → hub normalizes to []. */
    capabilities?: string[];
}
export interface InstanceRegisterResult {
    instanceId: string;
    credential: string;
}
export interface InstanceAuthPayload {
    instanceId: string;
    credential: string;
    coreVersion?: string;
    /** Confirmed connector capability snapshot; omit/undefined → hub normalizes to []. */
    capabilities?: string[];
}
export interface InstanceAuthResult {
    ok: true;
}
export { MAX_CAPABILITIES, MAX_CAPABILITY_LENGTH } from "./limits.js";
/**
 * Normalize a connector-advertised capability list for persistence and dashboard DTO.
 * Missing/invalid → []; drops empty/overlong; dedupes (order-preserving); caps count.
 * Unknown strings are retained for forward-compat but are not interpreted by this version.
 */
export declare function normalizeCapabilities(raw: unknown): string[];
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
        /** Hub-issued pre-write correlation (see PromptPayload.promptRequestId); lets the
         *  hub tie this turn's prompt back to its pre-written inbound row. */
        promptRequestId?: string;
        /** The connector's stable id for this running turn (mirrors the recoveryId it
         *  stamps on the eventual `turn-finished`), so the hub can tell a running turn
         *  apart from a finished-offline entry of the same session. */
        recoveryId?: string;
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
    /** Turns that finished and are still awaiting the hub's persistence ack — this
     *  includes turns that finished while the hub was unreachable AND live turns that
     *  finished moments ago (the connector forwards the live `turn-finished` and keeps
     *  the entry until the hub acks it). Hub must persist them.
     *  `prompt` backfills the turn's `in` row when the turn STARTED during the outage
     *  too, so the recovered answer never appears as an orphan in history; `queueItemId`
     *  (and `scheduled`) let the hub reconcile the queued `in` row the same way the live
     *  path does, instead of appending a duplicate.
     *  `recoveryId` is the connector's stable id for this turn: the hub writes a
     *  receipt once the rows are committed and acks the id back so the connector can
     *  drop the entry; a redelivery is deduped by the receipt (never re-appended).
     *  `truncated` marks a reply the connector capped at STATE_SYNC_TEXT_CAP — the
     *  persisted row must say so instead of masquerading as a complete reply. */
    finishedOffline: Array<{
        sessionAlias: string;
        ok: boolean;
        errorMessage?: string;
        cancelled?: boolean;
        text?: string;
        prompt?: string;
        queueItemId?: string;
        scheduled?: ScheduledOriginDto;
        promptRequestId?: string;
        recoveryId?: string;
        truncated?: boolean;
    }>;
}
export interface InstanceNoticePayload {
    kind: "task-completion" | "task-progress" | "coordinator-message";
    text: string;
    taskId?: string;
    chatKey?: string;
}
/** Recovery ids acked by the hub AFTER their rows (messages + receipt) committed to
 *  SQLite. The connector confirms (drops) the corresponding finished-offline entries
 *  only on receipt of this event — see MSG.instanceRecoveryAck. */
export interface InstanceRecoveryAckPayload {
    recoveryIds: string[];
}
export interface SessionsListPayload {
    /** Server-stamped `relay:<accountId>`; scopes the listing to that channel. */
    chatKey: string;
    /** Zero-based page offset for the relay-web sidebar. */
    offset?: number;
    /** Maximum number of active sessions to return. */
    limit?: number;
    /** Include sleeping sessions for explicit recovery/cache reconciliation queries. */
    includeArchived?: boolean;
    /** Restrict the listing to sleeping (archived) sessions; wins over includeArchived. */
    archivedOnly?: boolean;
    /** Exact-match workspace filter (empty string matches sessions without a workspace). */
    workspace?: string;
    /** Exact-match agent filter (empty string matches sessions without an agent). */
    agent?: string;
}
export interface SessionsListResult {
    sessions: SessionDto[];
    hasMore?: boolean;
    nextOffset?: number;
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
    /** Hub-issued stable id generated when the inbound row is PRE-WRITTEN (before the
     *  RPC), so a queued-response loss (hub restart / dropped response) can still
     *  correlate the connector's queue item back to that exact prompt row on recovery —
     *  text matching cannot distinguish a redelivery from a user sending the identical
     *  prompt twice. New connectors carry it through the queue item into turn-started
     *  and the state sync. */
    promptRequestId?: string;
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
/** Capability strings a connector may advertise during register/auth. */
export declare const RELAY_CAPABILITIES: {
    readonly terminalRmuxRecoveryV1: "terminal.rmux.recovery.v1";
    readonly terminalMultiViewV1: "terminal.multi-view.v1";
};
export type RelayCapability = (typeof RELAY_CAPABILITIES)[keyof typeof RELAY_CAPABILITIES];
/** Stable browser-facing terminal error codes (i18n by code, not message text). */
export declare const TERMINAL_ERROR_CODES: readonly ["terminal-disabled", "terminal-rmux-unavailable", "terminal-session-not-found", "terminal-session-archived", "terminal-capacity-exceeded", "terminal-viewer-capacity-exceeded", "terminal-terminating", "terminal-attachment-not-found", "terminal-generation-mismatch", "terminal-not-controller", "terminal-recovery-too-large", "terminal-protocol-error", "terminal-timeout", "instance-offline"];
export type TerminalErrorCode = (typeof TERMINAL_ERROR_CODES)[number];
export type TerminalRole = "controller" | "spectator";
export interface TerminalOpenPayload {
    chatKey: string;
    sessionAlias: string;
    /** Hub-stamped viewer identity; browser must not supply this. */
    viewerId: string;
    cols: number;
    rows: number;
}
export interface TerminalOpenResult {
    terminalId: string;
    generation: string;
    attachmentId: string;
    role: TerminalRole;
    viewerCount: number;
}
export interface TerminalTakeControlPayload {
    attachmentId: string;
    generation: string;
    viewerId: string;
}
export interface TerminalRoleResult {
    terminalId: string;
    generation: string;
    attachmentId: string;
    role: "controller";
    viewerCount: number;
}
export interface TerminalResyncPayload {
    attachmentId: string;
    generation: string;
    viewerId: string;
}
export interface TerminalResyncResult {
    ok: true;
}
export interface TerminalTerminatePayload {
    terminalId: string;
    generation: string;
}
export type TerminalTerminateResult = {
    status: "terminated";
} | {
    status: "cleanup-pending";
};
export interface TerminalStreamStartPayload {
    attachmentId: string;
    viewerId: string;
}
export interface TerminalInputPayload {
    attachmentId: string;
    generation: string;
    viewerId: string;
    dataBase64: string;
}
export interface TerminalResizePayload {
    attachmentId: string;
    generation: string;
    viewerId: string;
    cols: number;
    rows: number;
}
export interface TerminalHeartbeatPayload {
    attachmentId: string;
    viewerId: string;
}
export interface TerminalDetachPayload {
    attachmentId: string;
    viewerId: string;
}
/** Connector → hub targeted recovery/role/failure event for one viewer attachment. */
export type TerminalViewerEventInner = {
    kind: "terminal-rebase-start";
    generation: string;
    epoch: number;
    nextSequence: number;
    cols: number;
    rows: number;
    alternate: boolean;
    totalBytes: number;
    chunkCount: number;
} | {
    kind: "terminal-rebase-chunk";
    generation: string;
    epoch: number;
    index: number;
    dataBase64: string;
} | {
    kind: "terminal-rebase-end";
    generation: string;
    epoch: number;
} | {
    kind: "terminal-bytes";
    generation: string;
    epoch: number;
    sequence: number;
    dataBase64: string;
} | {
    kind: "terminal-role-changed";
    terminalId: string;
    role: TerminalRole;
    viewerCount: number;
} | {
    kind: "terminal-request-failed";
    requestId?: string;
    code: string;
    message: string;
} | {
    kind: "terminal-recovery-failed";
    generation: string;
    code: string;
    message: string;
};
export interface TerminalViewerEventPayload {
    viewerId: string;
    attachmentId: string;
    event: TerminalViewerEventInner;
}
export interface TerminalResourceExitPayload {
    terminalId: string;
    generation: string;
    reason: string;
    code?: number;
}
