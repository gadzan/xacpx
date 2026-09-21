/** Wire mirror of the core control session listing. */
export interface SessionDto {
    alias: string;
    agent: string;
    /** The acpx driver backing `agent` (codex/claude/…), resolved from the instance's
     *  agent config. Lets the web render the brand icon without a second agents lookup
     *  — critical for sleeping (archived) sessions, whose rows can live outside the
     *  active session list. Omitted by old instances; web falls back to its agents map. */
    driver?: string;
    workspace: string;
    transportSession: string;
    running: boolean;
    archived: boolean;
    /** ISO timestamp when the session was archived. */
    archivedAt?: string;
    /** Whether the session's agent process is currently alive (next prompt responds without
     *  a cold start). Drives the web cold-session indicator, shown only when `warm === false`.
     *  Omitted when unknown — old instances that don't report warmth, or a session not yet
     *  sampled — so old connectors and old web builds stay wire-compatible. */
    warm?: boolean;
    /** True when this logical session was attached to an existing agent-side (native) rollout
     *  — e.g. a resumed codex session — rather than freshly created via `/session new`. Lets
     *  the web badge native sessions distinctly. Omitted (not `false`) for fresh sessions. */
    native?: boolean;
    /** The agent adapter command this session actually runs (acpx-recorded, or the agent's
     *  resolved default). Lets the web avoid seeding a new session's model picker from a
     *  session running a different adapter version — those advertise model ids in
     *  incompatible formats (e.g. codex `gpt-5.5[high]` vs `gpt-5.5/high`). Omitted when
     *  unknown. */
    agentCommand?: string;
    /** Cosmetic display label set from relay-web. When present, the web shows this instead of
     *  `alias`. Identity stays `alias`. Omitted when unset. */
    displayName?: string;
}
/** Wire DTO for a configured agent on an instance. */
export interface AgentDto {
    name: string;
    driver: string;
}
/** Wire DTO for a machine-available agent driver and its readiness. */
export interface AgentCatalogEntryDto {
    driver: string;
    configured: boolean;
    installed: "builtin" | "yes" | "unknown";
}
/** Wire DTO for a configured workspace on an instance. */
export interface WorkspaceDto {
    name: string;
    cwd: string;
    description?: string;
}
/** A single entry in a workspace directory listing (read-only file browser). */
export interface FsEntryDto {
    name: string;
    type: "dir" | "file";
    /** File size in bytes; omitted for directories. */
    size?: number;
    /** True when git considers the entry ignored (omitted in non-git workspaces). */
    ignored?: boolean;
}
/** One content-search match line (mode:"content"). */
export interface FsSearchHitDto {
    path: string;
    line: number;
    text: string;
}
/** A changed file in a workspace's git working tree. `status` is the porcelain XY
 *  code (e.g. " M", "A ", "??", "D "). */
export interface FsDiffFileDto {
    path: string;
    status: string;
}
export type ScheduledTaskStatusDto = "pending" | "triggering" | "executed" | "cancelled" | "missed" | "failed";
/** Wire DTO for a scheduled task; maps from core ScheduledTaskRecord. */
export interface ScheduledTaskDto {
    id: string;
    sessionAlias: string;
    executeAt: string;
    message: string;
    status: ScheduledTaskStatusDto;
    createdAt: string;
    /** Set once the task has fired successfully (status "executed"). */
    executedAt?: string;
    /** Set when a fire attempt failed (status "failed"). */
    failedAt?: string;
    /** Failure reason, present alongside `failedAt`. */
    lastError?: string;
}
/** Marks a turn (and its inbound prompt message) as originating from a fired
 *  scheduled task, so the web can badge it and link back to the schedule entry. */
export interface ScheduledOriginDto {
    taskId: string;
    executeAt: string;
}
export type OrchestrationTaskStatusDto = "needs_confirmation" | "queued" | "running" | "blocked" | "waiting_for_human" | "completed" | "failed" | "cancelled";
/** Wire DTO for an orchestration task; projected from core OrchestrationTaskRecord. */
export interface OrchestrationTaskDto {
    taskId: string;
    status: OrchestrationTaskStatusDto;
    targetAgent: string;
    workspace: string;
    task: string;
    summary: string;
    createdAt: string;
    updatedAt: string;
}
export type ToolStepStatus = "running" | "success" | "error";
export type ToolStepKind = "read" | "search" | "execute" | "edit" | "delete" | "move" | "fetch" | "think" | "other";
/** Friendly, presentation-ready detail for one tool call (no raw JSON crosses the wire). */
export type ToolDetailDto = {
    type: "diff";
    path: string;
    oldText: string;
    newText: string;
    instruction?: string;
} | {
    type: "read";
    path: string;
    lines?: string;
    preview?: string;
} | {
    type: "command";
    command: string;
    output?: string;
    exitCode?: number;
    truncated?: boolean;
} | {
    type: "search";
    query: string;
    output?: string;
    count?: number;
    truncated?: boolean;
} | {
    type: "text";
    text: string;
    output?: string;
} | {
    type: "fields";
    fields: Array<{
        label: string;
        value: string;
    }>;
    output?: string;
};
/** One collapsed tool-call step, normalized at the connector from a core ToolUseEvent. */
export interface ToolStepDto {
    toolCallId: string;
    /** Parent tool call for steps executed inside a delegated subagent. */
    parentToolCallId?: string;
    /** Marks the Agent/Task tool call that owns a delegated subagent trace. */
    isSubagent?: boolean;
    toolName: string;
    kind: ToolStepKind;
    status: ToolStepStatus;
    title: string;
    durationMs?: number;
    /** First-frame epoch ms for this step (connector clock), so a still-running step
     *  can render a live elapsed timer. STEP-level — unrelated to
     *  `MessageRecordDto.startedAt`, which is the TURN's start. Present only while
     *  running; absent on finished/history rows (they carry `durationMs` instead). */
    startedAt?: number;
    detail?: ToolDetailDto;
    /** Failure message, present only when status === "error". */
    error?: string;
    /** Agent Messaging receipt correlation — populated only for the `agent_send`
     * tool when the connector extracted a valid structured receipt (messageId).
     * Enables anchoring the sent peer-message card to this exact step. */
    agentMessageId?: string;
    /** Terminal id when the driver routed the call through an agent-side terminal
     * and reports only `{type:"terminal",terminalId}` (Kimi). The output is not on
     * the wire, so the UI can say so instead of showing an empty result. */
    terminalId?: string;
}
/** One entry in a turn's canonical ordered wire transcript, retained for transport,
 *  persistence, and presentation timeline construction. Consecutive text may be
 *  coalesced, but consumers must preserve canonical wire provenance: activities
 *  never reorder against each other, and presentation may only delay an activity
 *  to a legal Markdown slot — never move it earlier than its wire offset. */
export type TurnPartDto = {
    type: "text";
    text: string;
} | {
    type: "reasoning";
    text: string;
} | {
    type: "tool";
    step: ToolStepDto;
};
/** One entry in the agent's ACP plan (todo list). STRUCTURALLY IDENTICAL to core
 *  PlanEntry — the connector forwards plan events as pass-through, so any drift here
 *  silently breaks the wire. */
export interface PlanEntryDto {
    content: string;
    status: "pending" | "in_progress" | "completed";
    priority?: "high" | "medium" | "low";
}
/** Cumulative session cost the agent reported (mirror of src UsageCost). Both optional. */
export interface UsageCostDto {
    amount?: number;
    currency?: string;
}
/** An agent-advertised slash command (mirror of src AgentCommand). */
export interface AgentCommandDto {
    name: string;
    description?: string;
    hasInput?: boolean;
}
/** Per-turn token breakdown (mirror of src UsageBreakdown). All fields optional. */
export interface UsageBreakdownDto {
    inputTokens?: number;
    outputTokens?: number;
    cachedReadTokens?: number;
    cachedWriteTokens?: number;
    thoughtTokens?: number;
    totalTokens?: number;
}
/** One pending item in a session's server-side prompt queue. */
export interface QueueItemDto {
    id: string;
    textPreview: string;
    enqueuedAt: string;
    /** v0.4: present ONLY for a reserved-but-not-started peer interrupt
     *  (snapshot-first item). Additive and backward compatible. */
    kind?: "interrupt";
}
/** Exact join from a live turn event onto ConversationRun / MemberTurn. */
export interface ConversationTurnCorrelationDto {
    conversationId: string;
    topicId: string;
    botId: string;
    runId: string;
    memberTurnId: string;
}
export interface BotSummaryDto {
    id: string;
    name: string;
    avatar?: string;
    role?: string;
    agent: string;
    workspace: string;
    model?: string;
    effort?: string;
    enabled: boolean;
    updatedAt: string;
}
export interface BotDetailDto extends BotSummaryDto {
    instructions?: string;
    profileRevision: number;
    createdAt: string;
}
export interface TopicSummaryDto {
    id: string;
    conversationId: string;
    title: string;
    status: "active" | "archived" | "deleting";
    createdAt: string;
    updatedAt: string;
}
export interface ConversationSummaryDto {
    id: string;
    kind: "bot";
    title: string;
    botId: string;
    defaultTopicId?: string;
    lifecycle?: "active" | "deleting";
    createdAt: string;
    updatedAt: string;
}
export interface ConversationDetailDto extends ConversationSummaryDto {
    description?: string;
    topics: TopicSummaryDto[];
}
export interface ConversationMessageDto {
    id: string;
    conversationId: string;
    topicId: string;
    seq: number;
    role: "human" | "bot" | "system";
    senderBotId?: string;
    content: string;
    replyTo?: string;
    runId?: string;
    createdAt: string;
    promptRequestId?: string;
}
export type ConversationRunStateDto = "queued" | "running" | "waiting-human" | "completed" | "failed" | "cancelled" | "indeterminate";
export interface ConversationRunDto {
    id: string;
    conversationId: string;
    topicId: string;
    requestMessageId: string;
    requestId: string;
    mode: "explicit";
    state: ConversationRunStateDto;
    completionReason?: string;
    profileRevision: number;
    createdAt: string;
    startedAt?: string;
    finishedAt?: string;
}
export interface BotProfileSnapshotDto {
    revision: number;
    capturedAt: string;
    presentation: {
        name: string;
        avatar?: string;
        role?: string;
    };
    behavior: {
        instructions?: string;
    };
    execution: {
        agent: string;
        workspace: string;
        model?: string;
        effort?: string;
    };
}
export interface MemberTurnSummaryDto {
    id: string;
    runId: string;
    conversationId: string;
    topicId: string;
    botId: string;
    batch: number;
    attempt: number;
    origin: "human" | "followup" | "retry" | "recovery";
    state: "queued" | "dispatched" | "running" | "completed" | "failed" | "cancelled" | "indeterminate";
    promptRequestId?: string;
    createdAt: string;
    startedAt?: string;
    finishedAt?: string;
}
export interface ConversationRunDetailDto extends ConversationRunDto {
    profileSnapshot?: BotProfileSnapshotDto;
    memberTurns: MemberTurnSummaryDto[];
}
export interface ConversationPromptResponseDto {
    reused: boolean;
    conversationId: string;
    topicId: string;
    requestId: string;
    run: ConversationRunDto;
    message: ConversationMessageDto;
    memberTurn: MemberTurnSummaryDto;
}
export interface ConversationHistoryResponseDto {
    conversationId: string;
    topicId: string;
    messages: ConversationMessageDto[];
    oldestSeq?: number;
    newestSeq?: number;
    hasMoreBefore: boolean;
    hasMoreAfter: boolean;
}
/** Wire mirror of src/control ControlEvent (tool-event carries the NORMALIZED step). */
export type ControlEventDto = {
    type: "turn-output";
    chatKey: string;
    sessionAlias: string;
    chunk: string;
    conversation?: ConversationTurnCorrelationDto;
} | {
    type: "turn-started";
    chatKey: string;
    sessionAlias: string;
    prompt?: string;
    scheduled?: ScheduledOriginDto;
    queueItemId?: string;
    promptRequestId?: string;
    peerOrigin?: PeerTurnOriginDto;
    /** Connector-local per-session seq at this turn-start (receive order, not a clock). */
    startedAfterSeq?: number;
    /** Connector recovery id for this turn; Hub keys the durable slot anchor with it. */
    recoveryId?: string;
    /** Hub-stamped last message id at turn-start (0 = empty transcript). Web live slot. */
    slotAfterId?: number;
    /** Hub-stamped epoch ms for this turn's start — the SAME value the eventual
     *  persisted row's `startedAt` carries, so web optimistic rows and their
     *  persisted replacements share one identity (trace-key stability). Optional:
     *  older hubs omit it and the web falls back to its own clock. */
    startedAt?: number;
    conversation?: ConversationTurnCorrelationDto;
} | {
    type: "tool-event";
    chatKey: string;
    sessionAlias: string;
    step: ToolStepDto;
    conversation?: ConversationTurnCorrelationDto;
} | {
    type: "turn-thought";
    chatKey: string;
    sessionAlias: string;
    chunk: string;
    conversation?: ConversationTurnCorrelationDto;
} | {
    type: "plan";
    chatKey: string;
    sessionAlias: string;
    entries: PlanEntryDto[];
    conversation?: ConversationTurnCorrelationDto;
} | {
    type: "turn-usage";
    chatKey: string;
    sessionAlias: string;
    used: number;
    size: number;
    cost?: UsageCostDto;
    breakdown?: UsageBreakdownDto;
    conversation?: ConversationTurnCorrelationDto;
} | {
    type: "agent-commands";
    chatKey: string;
    sessionAlias: string;
    commands: AgentCommandDto[];
    conversation?: ConversationTurnCorrelationDto;
} | {
    type: "turn-finished";
    chatKey: string;
    sessionAlias: string;
    ok: boolean;
    errorMessage?: string;
    cancelled?: boolean;
    text?: string;
    /** Skip persisting an empty out row (queue-overflow tips are toast-only). */
    silent?: boolean;
    recoveryId?: string;
    peerOrigin?: PeerTurnOriginDto;
    /** Connector-local seq captured at the original turn-start (Hub maps to insert order). */
    startedAfterSeq?: number;
    /** Connector-local epoch ms at turn-start — HUD telemetry only; never a reorder key. */
    startedAt?: number;
    conversation?: ConversationTurnCorrelationDto;
} | {
    type: "sessions-changed";
} | {
    type: "workspaces-changed";
} | {
    type: "scheduled-changed";
    chatKey: string;
} | {
    type: "session-history";
    chatKey: string;
    sessionAlias: string;
    messages: SessionHistoryRowDto[];
} | {
    type: "terminal-output";
    terminalId: string;
    seq: number;
    data: string;
} | {
    type: "terminal-exit";
    terminalId: string;
    code: number;
} | {
    type: "orchestration-changed";
} | {
    type: "queue-updated";
    chatKey: string;
    sessionAlias: string;
    items: QueueItemDto[];
} | {
    type: "agent-message";
    chatKey?: string;
    sessionAlias: string;
    message: PeerMessageHistoryEntry;
} | {
    /** v0.3 completion-status PATCH for an already-persisted sender card.
     *  Carries only the correlation id and new terminal status — the durable
     *  row's content/peer/mode must never be rebuilt from this event. */
    type: "agent-message-completion";
    sessionAlias: string;
    messageId: string;
    completionStatus: "completed" | "failed" | "cancelled";
} | {
    type: "bots-changed";
} | {
    type: "conversations-changed";
} | {
    type: "conversation-topic-changed";
    topic: TopicSummaryDto;
} | {
    type: "conversation-message";
    message: ConversationMessageDto;
} | {
    type: "conversation-run-changed";
    run: ConversationRunDto;
} | {
    type: "member-turn-started";
    run: ConversationRunDto;
    memberTurn: MemberTurnSummaryDto;
} | {
    type: "member-turn-finished";
    run: ConversationRunDto;
    memberTurn: MemberTurnSummaryDto;
};
export interface TerminalAttachRequest {
    terminalId: string;
}
export type TerminalAttachResult = {
    ok: false;
} | {
    ok: true;
    buffer: string;
    lastSeq: number;
};
/** One recovered history row (a persisted-shaped message) for a native-session seed. */
export interface SessionHistoryRowDto {
    direction: "in" | "out";
    text: string;
    structured?: {
        toolSteps?: ToolStepDto[];
        reasoning?: string;
        parts?: TurnPartDto[];
    };
}
/** Wire DTO for an agent endpoint published to Relay Hub for remote discovery. */
export interface PublishedAgentEndpointDto {
    nodeId: string;
    endpointId: string;
    displayName?: string;
    sessionAlias?: string;
    agent: string;
    workspace?: string;
    state: "idle" | "running";
    activity?: {
        status: "idle" | "working" | "waiting";
        summary?: string;
    };
    capabilities: {
        receive: boolean;
        steer: boolean;
        queue: boolean;
        interrupt: boolean;
        conversation?: boolean;
        completion?: boolean;
    };
    labels?: string[];
    /** Endpoint context for presentation ranking. logical = normal logical session endpoint; worker = orchestration worker endpoint. Optional: old peers omit it. */
    endpointKind?: "logical" | "worker";
    /** Source channel namespace owning the endpoint when known (e.g. "relay", "weixin", "feishu"). Optional. */
    channelId?: string;
    updatedAt: number;
}
export type AgentMessageCompletionMode = "none" | "notify" | "result";
export type AgentMessageCompletionStatus = "completed" | "failed" | "cancelled";
export interface AgentAddressDto {
    nodeId: string;
    endpointId: string;
}
export interface PeerTurnOriginDto {
    requestMessageId: string;
    completion: AgentMessageCompletionMode;
    source: AgentAddressDto;
    target: AgentAddressDto;
}
export interface PeerMessagePeer {
    handle: string;
    displayName: string;
    agent: string;
    workspace?: string;
}
export interface PeerMessageHistoryEntry {
    kind: "agent_message";
    direction: "sent" | "received";
    messageId: string;
    conversationId: string;
    replyTo?: string;
    peer: PeerMessagePeer;
    content: string;
    createdAt: number;
    status?: "sending" | "sent" | "queued" | "delivered" | "failed";
    completion?: AgentMessageCompletionMode;
    completionStatus?: "pending" | "completed" | "failed" | "cancelled";
}
