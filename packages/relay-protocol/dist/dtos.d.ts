/** Wire mirror of the core control session listing. */
export interface SessionDto {
    alias: string;
    agent: string;
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
export type ToolStepKind = "read" | "search" | "execute" | "edit" | "think" | "other";
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
} | {
    type: "search";
    query: string;
    output?: string;
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
    detail?: ToolDetailDto;
    /** Failure message, present only when status === "error". */
    error?: string;
}
/** One entry in a turn's ordered wire transcript, retained for transport and
 *  persistence. A presentation layer may move an activity to the end of the
 *  Markdown block that was in progress when it arrived, but must not globally
 *  bucket narrative and activity into separate lanes. */
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
}
/** Wire mirror of src/control ControlEvent (tool-event carries the NORMALIZED step). */
export type ControlEventDto = {
    type: "turn-output";
    chatKey: string;
    sessionAlias: string;
    chunk: string;
} | {
    type: "turn-started";
    chatKey: string;
    sessionAlias: string;
    prompt?: string;
    scheduled?: ScheduledOriginDto;
    queueItemId?: string;
    promptRequestId?: string;
} | {
    type: "tool-event";
    chatKey: string;
    sessionAlias: string;
    step: ToolStepDto;
} | {
    type: "turn-thought";
    chatKey: string;
    sessionAlias: string;
    chunk: string;
} | {
    type: "plan";
    chatKey: string;
    sessionAlias: string;
    entries: PlanEntryDto[];
} | {
    type: "turn-usage";
    chatKey: string;
    sessionAlias: string;
    used: number;
    size: number;
    cost?: UsageCostDto;
    breakdown?: UsageBreakdownDto;
} | {
    type: "agent-commands";
    chatKey: string;
    sessionAlias: string;
    commands: AgentCommandDto[];
} | {
    type: "turn-finished";
    chatKey: string;
    sessionAlias: string;
    ok: boolean;
    errorMessage?: string;
    cancelled?: boolean;
    text?: string;
    recoveryId?: string;
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
    agent: string;
    state: "idle" | "running";
    capabilities: {
        receive: boolean;
        steer: boolean;
        queue: boolean;
        interrupt: boolean;
    };
    labels?: string[];
    updatedAt: number;
}
