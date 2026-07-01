import { type RelayEnvelope } from "./envelope.js";
import type { AgentCommandDto, ControlEventDto, ScheduledOriginDto, ToolStepDto, TurnPartDto, UsageBreakdownDto, UsageCostDto } from "./dtos.js";
import type { InstanceNoticePayload } from "./messages.js";
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
    /** Present on completed `out` turns (`toolSteps`/`reasoning`/`parts`), and on an
     *  `in` row produced by a fired scheduled task (`scheduled`, so the badge + "View"
     *  jump survive a history reload). `parts` is the ordered transcript; `toolSteps`/
     *  `reasoning` are a flat fallback for older rows that predate `parts`. */
    structured?: {
        toolSteps?: ToolStepDto[];
        reasoning?: string;
        parts?: TurnPartDto[];
        scheduled?: ScheduledOriginDto;
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
/** Server→web push payloads (tagged with the originating instance). */
export type WebServerEvent = {
    kind: "instance-status";
    instanceId: string;
    online: boolean;
} | {
    kind: "control-event";
    instanceId: string;
    event: ControlEventDto;
} | {
    kind: "notice";
    instanceId: string;
    notice: InstanceNoticePayload;
};
/** Wrap a server→web push event in a relay envelope. */
export declare function webEventEnvelope(event: WebServerEvent): RelayEnvelope;
/** Parse + validate a relay→web push payload; returns null for any malformed envelope. */
export declare function parseWebServerEvent(envelope: RelayEnvelope): WebServerEvent | null;
export declare const WEB_CLIENT_TYPE = "web.client";
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
};
export declare function webClientEnvelope(msg: WebClientMessage): RelayEnvelope;
export declare function parseWebClientMessage(envelope: RelayEnvelope): WebClientMessage | null;
