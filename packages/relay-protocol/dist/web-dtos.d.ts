import { type RelayEnvelope } from "./envelope.js";
import type { AgentCommandDto, ControlEventDto, ScheduledOriginDto, ToolStepDto, TurnPartDto, UsageBreakdownDto, UsageCostDto } from "./dtos.js";
import type { InstanceNoticePayload, TerminalRole } from "./messages.js";
/** Envelope `type` for every relay→web push. */
export declare const WEB_EVENT_TYPE = "web.event";
export type MessageDirection = "in" | "out";
export interface AttachmentMetadata {
    id: string;
    filename: string;
    mimeType: string;
    size: number;
    kind: "image" | "file";
    /** Downscaled data URL for images; omitted for files. */
    previewUrl?: string;
}
/** A cached chat line echoed to the web client. */
export interface MessageRecordDto {
    /** Monotonic row id from the hub store. Present on persisted rows (used as the
     *  pagination cursor for "load older"); absent on optimistic/live client rows. */
    id?: number;
    instanceId: string;
    sessionAlias: string;
    direction: MessageDirection;
    text: string;
    createdAt: string;
    /** Present while an inbound Web prompt is queued, so a history reload can still
     *  associate it with the later drain event. Cleared when execution starts. */
    queueItemId?: string;
    /** Present on completed `out` turns (`toolSteps`/`reasoning`/`parts`), and on an
     *  `in` row produced by a fired scheduled task (`scheduled`, so the badge + "View"
     *  jump survive a history reload). `parts` is the ordered transcript; `toolSteps`/
     *  `reasoning` are a flat fallback for older rows that predate `parts`.
     *  `truncated` marks a recovered offline reply the connector capped at
     *  STATE_SYNC_TEXT_CAP — the persisted text is a prefix, not the full reply. */
    structured?: {
        toolSteps?: ToolStepDto[];
        reasoning?: string;
        parts?: TurnPartDto[];
        scheduled?: ScheduledOriginDto;
        truncated?: boolean;
    };
    attachments?: AttachmentMetadata[];
}
/** A snapshot of a turn still in flight on an instance, handed to a (re)connecting
 *  web client so a refresh mid-turn restores the live HUD / streaming bubble (and the
 *  session's "working" dot) instead of losing them until `turn-finished` persists.
 *  Mirrors the live `parts` transcript the streaming view builds. */
export interface LiveTurnSnapshotDto {
    instanceId: string;
    sessionAlias: string;
    parts: TurnPartDto[];
    status: "working" | "streaming";
    /** Epoch ms the turn began on the hub, so the elapsed-time HUD stays accurate. */
    startedAt: number;
}
/** The latest context-usage meter retained per session, handed to a (re)connecting web
 *  client so the context-usage bar survives a page refresh. Mirrors the `turn-usage`
 *  control event (replace-latest); absent for agents/sessions that never reported usage. */
export interface SessionUsageSnapshotDto {
    instanceId: string;
    sessionAlias: string;
    used: number;
    size: number;
    cost?: UsageCostDto;
    breakdown?: UsageBreakdownDto;
}
/** The latest agent-advertised slash commands retained per session, handed to a
 *  (re)connecting web client so the composer's "/" command hints survive a page
 *  refresh. Mirrors the `agent-commands` control event (replace-latest); absent for
 *  agents/sessions that never advertised any. */
export interface SessionCommandsSnapshotDto {
    instanceId: string;
    sessionAlias: string;
    commands: AgentCommandDto[];
}
/** Authoritative per-instance state sent on the same WebSocket immediately after
 *  a browser subscription is installed. Because the snapshot and later deltas
 *  share one ordered channel, the browser can safely replace stale pre-disconnect
 *  turns without racing an HTTP snapshot against live control events. */
export interface InstanceStateSnapshotDto {
    turns: LiveTurnSnapshotDto[];
    usage: SessionUsageSnapshotDto[];
    commands: SessionCommandsSnapshotDto[];
}
/** Dashboard instance row (HTTP `/api/instances` and web store seed). */
export interface InstanceSummaryDto {
    id: string;
    name: string;
    online: boolean;
    lastSeenAt: string | null;
    coreVersion?: string | null;
    /** Last known connector capabilities; missing/undefined → treat as []. */
    capabilities?: string[];
}
/** Server→web push payloads (tagged with the originating instance). */
export type WebServerEvent = {
    kind: "instance-status";
    instanceId: string;
    online: boolean;
} | {
    kind: "control-event";
    instanceId: string;
    event: ControlEventDto;
} | ({
    kind: "state-snapshot";
    instanceId: string;
} & InstanceStateSnapshotDto) | {
    kind: "notice";
    instanceId: string;
    notice: InstanceNoticePayload;
} | {
    kind: "terminal-opened";
    requestId: string;
    instanceId: string;
    terminalId: string;
    generation: string;
    attachmentId: string;
    role: TerminalRole;
    viewerCount: number;
} | {
    kind: "terminal-request-failed";
    requestId: string;
    instanceId: string;
    code: string;
    message: string;
} | {
    kind: "terminal-rebase-start";
    instanceId: string;
    attachmentId: string;
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
    instanceId: string;
    attachmentId: string;
    generation: string;
    epoch: number;
    index: number;
    dataBase64: string;
} | {
    kind: "terminal-rebase-end";
    instanceId: string;
    attachmentId: string;
    generation: string;
    epoch: number;
} | {
    kind: "terminal-bytes";
    instanceId: string;
    attachmentId: string;
    generation: string;
    epoch: number;
    sequence: number;
    dataBase64: string;
} | {
    kind: "terminal-role-changed";
    instanceId: string;
    attachmentId: string;
    terminalId: string;
    role: TerminalRole;
    viewerCount: number;
} | {
    kind: "terminal-exit";
    instanceId: string;
    terminalId: string;
    generation: string;
    reason: string;
    code?: number;
};
/** Wrap a server→web push event in a relay envelope. */
export declare function webEventEnvelope(event: WebServerEvent): RelayEnvelope;
/** Deep-validate an inner ControlEventDto: discriminant + per-variant required fields.
 *  The switch is compile-time exhaustive over ControlEventDto["type"] (see the `never`
 *  check in `default`), mirroring CONTROL_EVENT_TYPE_MAP above. */
export declare function validControlEvent(e: unknown): boolean;
/** Deep-validate an `instance.state.sync` payload with the same posture as
 *  `validControlEvent`: discriminant-free, but every field the hub will read must
 *  have the right shape — a malformed sync must be dropped, never reconciled into
 *  the hub's in-memory state or history. */
export declare function validInstanceStateSync(p: unknown): boolean;
/** Parse + validate a relay→web push payload; returns null for any malformed envelope. */
export declare function parseWebServerEvent(envelope: RelayEnvelope): WebServerEvent | null;
export declare const WEB_CLIENT_TYPE = "web.client";
export declare const MAX_WEB_INSTANCE_ID_LENGTH = 128;
export type WebClientMessage = {
    kind: "terminal-input";
    instanceId: string;
    terminalId: string;
    data: string;
} | {
    kind: "terminal-resize";
    instanceId: string;
    terminalId: string;
    cols: number;
    rows: number;
} | {
    kind: "terminal-close";
    instanceId: string;
    terminalId: string;
} | {
    kind: "terminal-open";
    requestId: string;
    instanceId: string;
    sessionAlias: string;
    cols: number;
    rows: number;
} | {
    kind: "terminal-stream-start";
    requestId: string;
    instanceId: string;
    attachmentId: string;
} | {
    kind: "terminal-input";
    instanceId: string;
    attachmentId: string;
    generation: string;
    dataBase64: string;
} | {
    kind: "terminal-resize";
    instanceId: string;
    attachmentId: string;
    generation: string;
    cols: number;
    rows: number;
} | {
    kind: "terminal-heartbeat";
    instanceId: string;
    attachmentId: string;
} | {
    kind: "terminal-take-control";
    requestId: string;
    instanceId: string;
    attachmentId: string;
    generation: string;
} | {
    kind: "terminal-resync";
    requestId: string;
    instanceId: string;
    attachmentId: string;
    generation: string;
} | {
    kind: "terminal-terminate";
    requestId: string;
    instanceId: string;
    terminalId: string;
    generation: string;
} | {
    kind: "terminal-detach";
    instanceId: string;
    attachmentId: string;
} | {
    kind: "subscribe";
    instanceIds: string[];
};
export declare function webClientEnvelope(msg: WebClientMessage): RelayEnvelope;
export declare function parseWebClientMessage(envelope: RelayEnvelope): WebClientMessage | null;
