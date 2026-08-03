import { RELAY_PROTOCOL_VERSION, type RelayEnvelope } from "./envelope.js";
import type { AgentCommandDto, ControlEventDto, ScheduledOriginDto, ToolStepDto, TurnPartDto, UsageBreakdownDto, UsageCostDto } from "./dtos.js";
import type { InstanceNoticePayload } from "./messages.js";
import { isStr, optStr, optNum } from "./validate-primitives.js";

/** Envelope `type` for every relay→web push. */
export const WEB_EVENT_TYPE = "web.event";

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
   *  `reasoning` are a flat fallback for older rows that predate `parts`. */
  structured?: { toolSteps?: ToolStepDto[]; reasoning?: string; parts?: TurnPartDto[]; scheduled?: ScheduledOriginDto };
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

/** Server→web push payloads (tagged with the originating instance). */
export type WebServerEvent =
  | { kind: "instance-status"; instanceId: string; online: boolean }
  | { kind: "control-event"; instanceId: string; event: ControlEventDto }
  | ({ kind: "state-snapshot"; instanceId: string } & InstanceStateSnapshotDto)
  | { kind: "notice"; instanceId: string; notice: InstanceNoticePayload };

/** Wrap a server→web push event in a relay envelope. */
export function webEventEnvelope(event: WebServerEvent): RelayEnvelope {
  return { protocolVersion: RELAY_PROTOCOL_VERSION, kind: "event", type: WEB_EVENT_TYPE, payload: event };
}

const WEB_EVENT_KINDS = new Set(["instance-status", "control-event", "state-snapshot", "notice"]);

/** Compile-time-exhaustive whitelist of inner control-event discriminants. The
 *  `satisfies Record<ControlEventDto["type"], true>` clause makes tsc fail if a new
 *  member is added to the ControlEventDto union without being listed here — the drift
 *  that once silently dropped `session-history` pushes. When you add a key here, also
 *  add its per-variant field check to the switch in `validControlEvent` below. */
const CONTROL_EVENT_TYPE_MAP = {
  "turn-output": true,
  "turn-started": true,
  "tool-event": true,
  "turn-thought": true,
  "plan": true,
  "turn-usage": true,
  "agent-commands": true,
  "turn-finished": true,
  "queue-updated": true,
  "sessions-changed": true,
  "workspaces-changed": true,
  "scheduled-changed": true,
  "session-history": true,
  "orchestration-changed": true,
  "terminal-output": true,
  "terminal-exit": true,
} satisfies Record<ControlEventDto["type"], true>;

const CONTROL_EVENT_TYPES: ReadonlySet<string> = new Set(Object.keys(CONTROL_EVENT_TYPE_MAP));

const TOOL_STEP_KINDS = new Set(["read", "search", "execute", "edit", "think", "other"]);
const TOOL_STEP_STATUSES = new Set(["running", "success", "error"]);
const finiteNonNegative = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value) && value >= 0;

function validUsageCost(value: unknown): boolean {
  if (value === undefined) return true;
  if (typeof value !== "object" || value === null) return false;
  const c = value as Record<string, unknown>;
  return (c.amount === undefined || finiteNonNegative(c.amount))
    && (c.currency === undefined || (typeof c.currency === "string" && c.currency.length <= 32));
}

function validUsageBreakdown(value: unknown): boolean {
  if (value === undefined) return true;
  if (typeof value !== "object" || value === null) return false;
  const c = value as Record<string, unknown>;
  return ["inputTokens", "outputTokens", "cachedReadTokens", "cachedWriteTokens", "thoughtTokens", "totalTokens"]
    .every((key) => c[key] === undefined || finiteNonNegative(c[key]));
}

function validAgentCommand(value: unknown): boolean {
  if (typeof value !== "object" || value === null) return false;
  const c = value as Record<string, unknown>;
  return typeof c.name === "string" && c.name.length > 0 && c.name.length <= 128
    && (c.description === undefined || (typeof c.description === "string" && c.description.length <= 4096))
    && (c.hasInput === undefined || typeof c.hasInput === "boolean");
}

/** Validate the inner fields of a ToolDetailDto per its discriminant — a known
 *  tag is not enough; junk/missing fields must be rejected so a buggy connector
 *  cannot push e.g. a `diff` with no `path` or a `command` that is a number. */
function validToolDetail(d: Record<string, unknown>): boolean {
  switch (d.type) {
    case "diff":
      return isStr(d.path) && isStr(d.oldText) && isStr(d.newText) && optStr(d.instruction);
    case "read":
      return isStr(d.path) && optStr(d.lines) && optStr(d.preview);
    case "command":
      return isStr(d.command) && optStr(d.output) && optNum(d.exitCode);
    case "search":
      return isStr(d.query) && optStr(d.output);
    case "text":
      return isStr(d.text) && optStr(d.output);
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
  if (!optStr(c.parentToolCallId) || (c.isSubagent !== undefined && typeof c.isSubagent !== "boolean")) return false;
  if (c.durationMs !== undefined && !finiteNonNegative(c.durationMs)) return false;
  if (!optStr(c.error)) return false;
  if (c.detail !== undefined) {
    if (typeof c.detail !== "object" || c.detail === null) return false;
    if (!validToolDetail(c.detail as Record<string, unknown>)) return false;
  }
  return true;
}

function validTurnPart(p: unknown): boolean {
  if (typeof p !== "object" || p === null) return false;
  const c = p as Record<string, unknown>;
  if (c.type === "text" || c.type === "reasoning") return typeof c.text === "string";
  if (c.type === "tool") return validToolStep(c.step);
  return false;
}

function validStateSnapshot(candidate: Record<string, unknown>): boolean {
  const instanceId = candidate.instanceId;
  if (typeof instanceId !== "string") return false;
  if (!Array.isArray(candidate.turns) || !candidate.turns.every((turn) => {
    if (typeof turn !== "object" || turn === null) return false;
    const c = turn as Record<string, unknown>;
    return c.instanceId === instanceId
      && typeof c.sessionAlias === "string"
      && Array.isArray(c.parts)
      && c.parts.every(validTurnPart)
      && (c.status === "working" || c.status === "streaming")
      && finiteNonNegative(c.startedAt);
  })) return false;
  if (!Array.isArray(candidate.usage) || !candidate.usage.every((usage) => {
    if (typeof usage !== "object" || usage === null) return false;
    const c = usage as Record<string, unknown>;
    return c.instanceId === instanceId
      && typeof c.sessionAlias === "string"
      && finiteNonNegative(c.used)
      && finiteNonNegative(c.size)
      && validUsageCost(c.cost)
      && validUsageBreakdown(c.breakdown);
  })) return false;
  return Array.isArray(candidate.commands) && candidate.commands.every((entry) => {
    if (typeof entry !== "object" || entry === null) return false;
    const c = entry as Record<string, unknown>;
    return c.instanceId === instanceId
      && typeof c.sessionAlias === "string"
      && Array.isArray(c.commands)
      && c.commands.every(validAgentCommand);
  });
}

/** Deep-validate an inner ControlEventDto: discriminant + per-variant required fields.
 *  The switch is compile-time exhaustive over ControlEventDto["type"] (see the `never`
 *  check in `default`), mirroring CONTROL_EVENT_TYPE_MAP above. */
export function validControlEvent(e: unknown): boolean {
  if (typeof e !== "object" || e === null) return false;
  const c = e as Record<string, unknown>;
  if (typeof c.type !== "string" || !CONTROL_EVENT_TYPES.has(c.type)) return false;
  const type = c.type as ControlEventDto["type"];
  switch (type) {
    case "turn-output":
      return typeof c.chatKey === "string" && typeof c.sessionAlias === "string" && typeof c.chunk === "string";
    case "turn-finished":
      return typeof c.chatKey === "string" && typeof c.sessionAlias === "string" && typeof c.ok === "boolean"
        && optStr(c.text);
    case "scheduled-changed":
      return typeof c.chatKey === "string";
    case "turn-started":
      return typeof c.chatKey === "string" && typeof c.sessionAlias === "string"
        && optStr(c.prompt) && optStr(c.queueItemId);
    case "turn-thought":
      return typeof c.chatKey === "string" && typeof c.sessionAlias === "string" && typeof c.chunk === "string";
    case "plan":
      return typeof c.chatKey === "string" && typeof c.sessionAlias === "string" && Array.isArray(c.entries);
    case "turn-usage":
      return typeof c.chatKey === "string" && typeof c.sessionAlias === "string"
        && finiteNonNegative(c.used) && finiteNonNegative(c.size)
        && validUsageCost(c.cost) && validUsageBreakdown(c.breakdown);
    case "agent-commands":
      return typeof c.chatKey === "string" && typeof c.sessionAlias === "string"
        && Array.isArray(c.commands)
        && c.commands.every(validAgentCommand);
    case "queue-updated":
      return typeof c.chatKey === "string" && typeof c.sessionAlias === "string" && Array.isArray(c.items);
    case "session-history":
      // Recovered rows are rendered directly; each must carry a direction + text so
      // the web's history seed can't crash on a junk row from a buggy connector.
      return typeof c.chatKey === "string" && typeof c.sessionAlias === "string"
        && Array.isArray(c.messages)
        && c.messages.every((m) => m !== null && typeof m === "object"
          && ((m as { direction?: unknown }).direction === "in" || (m as { direction?: unknown }).direction === "out")
          && typeof (m as { text?: unknown }).text === "string");
    case "tool-event":
      return typeof c.chatKey === "string" && typeof c.sessionAlias === "string" && validToolStep(c.step);
    case "terminal-output":
      return typeof c.terminalId === "string" && typeof c.seq === "number" && typeof c.data === "string";
    case "terminal-exit":
      return typeof c.terminalId === "string" && typeof c.code === "number";
    case "sessions-changed":
    case "workspaces-changed":
    case "orchestration-changed":
      return true; // no extra fields
    default: {
      // Exhaustiveness guard: adding a ControlEventDto member without a case above is a tsc error.
      const _exhaustive: never = type;
      return _exhaustive;
    }
  }
}

const NOTICE_KINDS = new Set(["task-completion", "task-progress", "coordinator-message"]);

/** Deep-validate an `instance.state.sync` payload with the same posture as
 *  `validControlEvent`: discriminant-free, but every field the hub will read must
 *  have the right shape — a malformed sync must be dropped, never reconciled into
 *  the hub's in-memory state or history. */
export function validInstanceStateSync(p: unknown): boolean {
  if (typeof p !== "object" || p === null) return false;
  const c = p as Record<string, unknown>;
  if (!Array.isArray(c.turns) || !c.turns.every((t) => {
    if (typeof t !== "object" || t === null) return false;
    const turn = t as Record<string, unknown>;
    return typeof turn.sessionAlias === "string"
      && optStr(turn.prompt) && optStr(turn.queueItemId)
      && (turn.scheduled === undefined || (typeof turn.scheduled === "object" && turn.scheduled !== null
        && isStr((turn.scheduled as Record<string, unknown>).taskId) && isStr((turn.scheduled as Record<string, unknown>).executeAt)))
      && finiteNonNegative(turn.startedAt)
      && typeof turn.text === "string"
      && typeof turn.reasoning === "string"
      && Array.isArray(turn.steps) && turn.steps.every(validToolStep)
      && (turn.truncated === undefined || typeof turn.truncated === "boolean");
  })) return false;
  if (!Array.isArray(c.usage) || !c.usage.every((u) => {
    if (typeof u !== "object" || u === null) return false;
    const usage = u as Record<string, unknown>;
    return typeof usage.sessionAlias === "string"
      && finiteNonNegative(usage.used) && finiteNonNegative(usage.size)
      && validUsageCost(usage.cost) && validUsageBreakdown(usage.breakdown);
  })) return false;
  if (!Array.isArray(c.commands) || !c.commands.every((entry) => {
    if (typeof entry !== "object" || entry === null) return false;
    const commands = entry as Record<string, unknown>;
    return typeof commands.sessionAlias === "string"
      && Array.isArray(commands.commands) && commands.commands.every(validAgentCommand);
  })) return false;
  return Array.isArray(c.finishedOffline) && c.finishedOffline.every((f) => {
    if (typeof f !== "object" || f === null) return false;
    const finished = f as Record<string, unknown>;
    return typeof finished.sessionAlias === "string"
      && typeof finished.ok === "boolean"
      && optStr(finished.errorMessage) && optStr(finished.text) && optStr(finished.prompt)
      && (finished.cancelled === undefined || typeof finished.cancelled === "boolean");
  });
}

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
  if (candidate.kind === "state-snapshot" && !validStateSnapshot(candidate)) return null;
  if (candidate.kind === "notice" && !validNotice(candidate.notice)) return null;
  return payload as WebServerEvent;
}

// --- web→hub upstream messages (new direction; no prior precedent) ---

export const WEB_CLIENT_TYPE = "web.client";
export const MAX_WEB_INSTANCE_ID_LENGTH = 128;

export type WebClientMessage =
  | { kind: "terminal-input"; instanceId: string; terminalId: string; data: string }
  | { kind: "terminal-resize"; instanceId: string; terminalId: string; cols: number; rows: number }
  | { kind: "terminal-close"; instanceId: string; terminalId: string }
  | { kind: "subscribe"; instanceIds: string[] };

export function webClientEnvelope(msg: WebClientMessage): RelayEnvelope {
  return { protocolVersion: RELAY_PROTOCOL_VERSION, kind: "event", type: WEB_CLIENT_TYPE, payload: msg };
}

export function parseWebClientMessage(envelope: RelayEnvelope): WebClientMessage | null {
  if (envelope.kind !== "event" || envelope.type !== WEB_CLIENT_TYPE) return null;
  const p = envelope.payload;
  if (typeof p !== "object" || p === null) return null;
  const c = p as Record<string, unknown>;
  if (c.kind === "subscribe") {
    return Array.isArray(c.instanceIds)
      && c.instanceIds.every((x) => typeof x === "string" && x.length > 0 && x.length <= MAX_WEB_INSTANCE_ID_LENGTH)
      ? (p as WebClientMessage)
      : null;
  }
  // terminal-* frames all require instanceId + terminalId strings.
  if (typeof c.instanceId !== "string" || typeof c.terminalId !== "string") return null;
  if (c.kind === "terminal-input") return typeof c.data === "string" ? (p as WebClientMessage) : null;
  if (c.kind === "terminal-resize") return typeof c.cols === "number" && typeof c.rows === "number" ? (p as WebClientMessage) : null;
  if (c.kind === "terminal-close") return p as WebClientMessage;
  return null;
}
