import { RELAY_PROTOCOL_VERSION, type RelayEnvelope } from "./envelope.js";
import type { ControlEventDto, ScheduledOriginDto, ToolStepDto, TurnPartDto } from "./dtos.js";
import type { InstanceNoticePayload } from "./messages.js";

/** Envelope `type` for every relay→web push. */
export const WEB_EVENT_TYPE = "web.event";

export type MessageDirection = "in" | "out";

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
  structured?: { toolSteps?: ToolStepDto[]; reasoning?: string; parts?: TurnPartDto[]; scheduled?: ScheduledOriginDto };
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

/** Server→web push payloads (tagged with the originating instance). */
export type WebServerEvent =
  | { kind: "instance-status"; instanceId: string; online: boolean }
  | { kind: "control-event"; instanceId: string; event: ControlEventDto }
  | { kind: "notice"; instanceId: string; notice: InstanceNoticePayload };

/** Wrap a server→web push event in a relay envelope. */
export function webEventEnvelope(event: WebServerEvent): RelayEnvelope {
  return { protocolVersion: RELAY_PROTOCOL_VERSION, kind: "event", type: WEB_EVENT_TYPE, payload: event };
}

const WEB_EVENT_KINDS = new Set(["instance-status", "control-event", "notice"]);

const CONTROL_EVENT_TYPES = new Set([
  "turn-output",
  "turn-started",
  "tool-event",
  "turn-thought",
  "plan",
  "turn-usage",
  "turn-finished",
  "sessions-changed",
  "scheduled-changed",
  "orchestration-changed",
]);

const TOOL_STEP_KINDS = new Set(["read", "search", "execute", "edit", "think", "other"]);
const TOOL_STEP_STATUSES = new Set(["running", "success", "error"]);

const isStr = (v: unknown): boolean => typeof v === "string";
const optStr = (v: unknown): boolean => v === undefined || typeof v === "string";
const optNum = (v: unknown): boolean => v === undefined || typeof v === "number";

/** Validate the inner fields of a ToolDetailDto per its discriminant — a known
 *  tag is not enough; junk/missing fields must be rejected so a buggy connector
 *  cannot push e.g. a `diff` with no `path` or a `command` that is a number. */
function validToolDetail(d: Record<string, unknown>): boolean {
  switch (d.type) {
    case "diff":
      return isStr(d.path) && isStr(d.oldText) && isStr(d.newText);
    case "read":
      return isStr(d.path) && optStr(d.lines) && optStr(d.preview);
    case "command":
      return isStr(d.command) && optStr(d.output) && optNum(d.exitCode);
    case "search":
      return isStr(d.query) && optStr(d.output);
    case "text":
      return isStr(d.text);
    case "fields":
      return (
        Array.isArray(d.fields) &&
        d.fields.every((f) => f !== null && typeof f === "object" && isStr((f as Record<string, unknown>).label) && isStr((f as Record<string, unknown>).value)) &&
        optStr(d.output)
      );
    default:
      return false;
  }
}

function validToolStep(s: unknown): boolean {
  if (typeof s !== "object" || s === null) return false;
  const c = s as Record<string, unknown>;
  if (typeof c.toolCallId !== "string" || typeof c.toolName !== "string" || typeof c.title !== "string") return false;
  if (typeof c.kind !== "string" || !TOOL_STEP_KINDS.has(c.kind)) return false;
  if (typeof c.status !== "string" || !TOOL_STEP_STATUSES.has(c.status)) return false;
  if (!optStr(c.error)) return false;
  if (c.detail !== undefined) {
    if (typeof c.detail !== "object" || c.detail === null) return false;
    if (!validToolDetail(c.detail as Record<string, unknown>)) return false;
  }
  return true;
}

/** Deep-validate an inner ControlEventDto: discriminant + per-variant required fields. */
function validControlEvent(e: unknown): boolean {
  if (typeof e !== "object" || e === null) return false;
  const c = e as Record<string, unknown>;
  if (typeof c.type !== "string" || !CONTROL_EVENT_TYPES.has(c.type)) return false;
  if (c.type === "turn-output")
    return typeof c.chatKey === "string" && typeof c.sessionAlias === "string" && typeof c.chunk === "string";
  if (c.type === "turn-finished")
    return typeof c.chatKey === "string" && typeof c.sessionAlias === "string" && typeof c.ok === "boolean";
  if (c.type === "scheduled-changed") return typeof c.chatKey === "string";
  if (c.type === "turn-started")
    return typeof c.chatKey === "string" && typeof c.sessionAlias === "string";
  if (c.type === "turn-thought")
    return typeof c.chatKey === "string" && typeof c.sessionAlias === "string" && typeof c.chunk === "string";
  if (c.type === "plan")
    return typeof c.chatKey === "string" && typeof c.sessionAlias === "string" && Array.isArray(c.entries);
  if (c.type === "turn-usage")
    return typeof c.chatKey === "string" && typeof c.sessionAlias === "string" && typeof c.used === "number" && typeof c.size === "number";
  if (c.type === "tool-event")
    return typeof c.chatKey === "string" && typeof c.sessionAlias === "string" && validToolStep(c.step);
  return true; // sessions-changed / orchestration-changed carry no extra required fields
}

const NOTICE_KINDS = new Set(["task-completion", "task-progress", "coordinator-message"]);

/** Deep-validate an inner InstanceNoticePayload: known kind + required text. */
function validNotice(n: unknown): boolean {
  if (typeof n !== "object" || n === null) return false;
  const c = n as Record<string, unknown>;
  return typeof c.kind === "string" && NOTICE_KINDS.has(c.kind) && typeof c.text === "string";
}

/** Parse + validate a relay→web push payload; returns null for any malformed envelope. */
export function parseWebServerEvent(envelope: RelayEnvelope): WebServerEvent | null {
  if (envelope.kind !== "event" || envelope.type !== WEB_EVENT_TYPE) return null;
  const payload = envelope.payload;
  if (typeof payload !== "object" || payload === null) return null;
  const candidate = payload as Record<string, unknown>;
  if (typeof candidate.instanceId !== "string") return null;
  if (typeof candidate.kind !== "string" || !WEB_EVENT_KINDS.has(candidate.kind)) return null;
  if (candidate.kind === "instance-status" && typeof candidate.online !== "boolean") return null;
  if (candidate.kind === "control-event" && !validControlEvent(candidate.event)) return null;
  if (candidate.kind === "notice" && !validNotice(candidate.notice)) return null;
  return payload as WebServerEvent;
}
