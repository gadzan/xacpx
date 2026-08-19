import { RELAY_PROTOCOL_VERSION, type RelayEnvelope } from "./envelope.js";
import type { AgentCommandDto, ControlEventDto, PeerMessageHistoryEntry, ScheduledOriginDto, ToolStepDto, TurnPartDto, UsageBreakdownDto, UsageCostDto } from "./dtos.js";
import {
  MAX_TERMINAL_ATTACHMENT_ID_LENGTH,
  MAX_TERMINAL_COLS,
  MAX_TERMINAL_ERROR_MESSAGE_LENGTH,
  MAX_TERMINAL_GENERATION_LENGTH,
  MAX_TERMINAL_ID_LENGTH,
  MAX_TERMINAL_INPUT_BYTES,
  MAX_TERMINAL_REBASE_TOTAL_BYTES,
  MAX_TERMINAL_REQUEST_ID_LENGTH,
  MAX_TERMINAL_ROWS,
  MAX_TERMINAL_SESSION_ALIAS_LENGTH,
  MAX_TOOL_STEPS,
  MIN_TERMINAL_COLS,
  MIN_TERMINAL_ROWS,
  REASONING_CAP,
  STATE_SYNC_PARTS_CAP,
  STATE_SYNC_TEXT_CAP,
  TERMINAL_REBASE_CHUNK_BYTES,
} from "./limits.js";
import type { InstanceNoticePayload, TerminalRole } from "./messages.js";
import { isBoundedStr, isIntInRange, isNonNegInt, isStr, optStr, optNum, optBool, parseCanonicalBase64 } from "./validate-primitives.js";


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
   *  `reasoning` are a flat fallback for older rows that predate `parts`.
   *  `truncated` marks a recovered offline reply the connector capped at
   *  STATE_SYNC_TEXT_CAP — the persisted text is a prefix, not the full reply.
   *  `compact` is set by `GET .../messages?view=compact`: bulky tool details were
   *  omitted (collapsed cards still render); `GET .../messages/:id` returns the full row. */
  structured?: { toolSteps?: ToolStepDto[]; reasoning?: string; parts?: TurnPartDto[]; scheduled?: ScheduledOriginDto; truncated?: boolean; compact?: boolean; agentMessage?: PeerMessageHistoryEntry };
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
export type WebServerEvent =
  | { kind: "instance-status"; instanceId: string; online: boolean }
  | { kind: "control-event"; instanceId: string; event: ControlEventDto }
  | ({ kind: "state-snapshot"; instanceId: string } & InstanceStateSnapshotDto)
  | { kind: "notice"; instanceId: string; notice: InstanceNoticePayload }
  | {
      kind: "terminal-opened";
      requestId: string;
      instanceId: string;
      terminalId: string;
      generation: string;
      attachmentId: string;
      role: TerminalRole;
      viewerCount: number;
    }
  | {
      kind: "terminal-request-failed";
      requestId: string;
      instanceId: string;
      code: string;
      message: string;
    }
  | {
      kind: "terminal-recovery-failed";
      instanceId: string;
      attachmentId: string;
      generation: string;
      code: string;
      message: string;
    }
  | {
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
    }
  | {
      kind: "terminal-rebase-chunk";
      instanceId: string;
      attachmentId: string;
      generation: string;
      epoch: number;
      index: number;
      dataBase64: string;
    }
  | {
      kind: "terminal-rebase-end";
      instanceId: string;
      attachmentId: string;
      generation: string;
      epoch: number;
    }
  | {
      kind: "terminal-bytes";
      instanceId: string;
      attachmentId: string;
      generation: string;
      epoch: number;
      sequence: number;
      dataBase64: string;
    }
  | {
      kind: "terminal-role-changed";
      instanceId: string;
      attachmentId: string;
      terminalId: string;
      role: TerminalRole;
      viewerCount: number;
    }
  | {
      kind: "terminal-exit";
      instanceId: string;
      terminalId: string;
      generation: string;
      reason: string;
      code?: number;
    };

/** Wrap a server→web push event in a relay envelope. */
export function webEventEnvelope(event: WebServerEvent): RelayEnvelope {
  return { protocolVersion: RELAY_PROTOCOL_VERSION, kind: "event", type: WEB_EVENT_TYPE, payload: event };
}

const WEB_EVENT_KINDS = new Set([
  "instance-status",
  "control-event",
  "state-snapshot",
  "notice",
  "terminal-opened",
  "terminal-request-failed",
  "terminal-recovery-failed",
  "terminal-rebase-start",
  "terminal-rebase-chunk",
  "terminal-rebase-end",
  "terminal-bytes",
  "terminal-role-changed",
  "terminal-exit",
]);

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
  "agent-message": true,
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

/** Shared shape check for `scheduled` origins (turn-started events, state-sync turns
 *  and finished-offline entries) — the hub persists these fields, so a junk shape must
 *  be rejected before it reaches the DB. */
function validScheduledOrigin(s: unknown): boolean {
  return s === undefined || (typeof s === "object" && s !== null
    && isStr((s as Record<string, unknown>).taskId)
    && isStr((s as Record<string, unknown>).executeAt));
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

function validStateSyncParts(parts: unknown[]): boolean {
  if (parts.length > STATE_SYNC_PARTS_CAP || !parts.every(validTurnPart)) return false;
  let textLength = 0;
  let reasoningLength = 0;
  const toolIds = new Set<string>();
  for (const raw of parts) {
    const part = raw as TurnPartDto;
    if (part.type === "text") textLength += part.text.length;
    else if (part.type === "reasoning") reasoningLength += part.text.length;
    else toolIds.add(part.step.toolCallId);
  }
  return textLength <= STATE_SYNC_TEXT_CAP
    && reasoningLength <= REASONING_CAP
    && toolIds.size <= MAX_TOOL_STEPS;
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

function validPeerMessageHistoryEntry(m: unknown): boolean {
  if (typeof m !== "object" || m === null) return false;
  const entry = m as Record<string, unknown>;
  if (entry.kind !== "agent_message") return false;
  if (entry.direction !== "sent" && entry.direction !== "received") return false;
  if (typeof entry.messageId !== "string" || typeof entry.conversationId !== "string") return false;
  if (typeof entry.content !== "string" || typeof entry.createdAt !== "number") return false;
  if (!optStr(entry.replyTo)) return false;
  if (typeof entry.peer !== "object" || entry.peer === null) return false;
  const peer = entry.peer as Record<string, unknown>;
  if (typeof peer.handle !== "string" || typeof peer.displayName !== "string" || typeof peer.agent !== "string") return false;
  if (!optStr(peer.workspace)) return false;
  if (entry.status !== undefined && !["sending", "sent", "delivered", "failed"].includes(entry.status as string)) return false;
  return true;
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
      // All fields the hub persists (text fallback, errorMessage row, cancelled flag,
      // recovery receipt) are validated so a buggy connector cannot slip a non-string
      // into SQLite and trigger a disconnect loop.
      return typeof c.chatKey === "string" && typeof c.sessionAlias === "string" && typeof c.ok === "boolean"
        && optStr(c.text) && optStr(c.recoveryId) && optStr(c.errorMessage) && optBool(c.cancelled);
    case "scheduled-changed":
      return typeof c.chatKey === "string";
    case "turn-started":
      return typeof c.chatKey === "string" && typeof c.sessionAlias === "string"
        && optStr(c.prompt) && optStr(c.queueItemId) && optStr(c.promptRequestId) && validScheduledOrigin(c.scheduled);
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
    case "agent-message":
      return typeof c.sessionAlias === "string" && optStr(c.chatKey) && validPeerMessageHistoryEntry(c.message);
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
      && optStr(turn.prompt) && optStr(turn.queueItemId) && optStr(turn.recoveryId) && optStr(turn.promptRequestId)
      && validScheduledOrigin(turn.scheduled)
      && finiteNonNegative(turn.startedAt)
      && typeof turn.text === "string"
      && typeof turn.reasoning === "string"
      && Array.isArray(turn.steps) && turn.steps.every(validToolStep)
      && (turn.parts === undefined || (Array.isArray(turn.parts) && validStateSyncParts(turn.parts)))
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
      && optStr(finished.queueItemId) && optStr(finished.recoveryId) && optStr(finished.promptRequestId)
      && validScheduledOrigin(finished.scheduled)
      && (finished.cancelled === undefined || typeof finished.cancelled === "boolean")
      && (finished.truncated === undefined || typeof finished.truncated === "boolean");
  });
}

/** Deep-validate an inner InstanceNoticePayload: known kind + required text. */
function validNotice(n: unknown): boolean {
  if (typeof n !== "object" || n === null) return false;
  const c = n as Record<string, unknown>;
  return typeof c.kind === "string" && NOTICE_KINDS.has(c.kind) && typeof c.text === "string";
}

function expectedRebaseChunkCount(totalBytes: number): number {
  return totalBytes === 0 ? 0 : Math.ceil(totalBytes / TERMINAL_REBASE_CHUNK_BYTES);
}

function validTerminalRole(value: unknown): value is TerminalRole {
  return value === "controller" || value === "spectator";
}

function validTargetedTerminalEvent(candidate: Record<string, unknown>): boolean {
  switch (candidate.kind) {
    case "terminal-opened":
      return isBoundedStr(candidate.requestId, MAX_TERMINAL_REQUEST_ID_LENGTH)
        && isBoundedStr(candidate.terminalId, MAX_TERMINAL_ID_LENGTH)
        && isBoundedStr(candidate.generation, MAX_TERMINAL_GENERATION_LENGTH)
        && isBoundedStr(candidate.attachmentId, MAX_TERMINAL_ATTACHMENT_ID_LENGTH)
        && validTerminalRole(candidate.role)
        && isNonNegInt(candidate.viewerCount);
    case "terminal-request-failed":
      return isBoundedStr(candidate.requestId, MAX_TERMINAL_REQUEST_ID_LENGTH)
        && isBoundedStr(candidate.code, 128)
        && typeof candidate.message === "string"
        && candidate.message.length <= MAX_TERMINAL_ERROR_MESSAGE_LENGTH;
    case "terminal-recovery-failed":
      return isBoundedStr(candidate.attachmentId, MAX_TERMINAL_ATTACHMENT_ID_LENGTH)
        && isBoundedStr(candidate.generation, MAX_TERMINAL_GENERATION_LENGTH)
        && isBoundedStr(candidate.code, 128)
        && typeof candidate.message === "string"
        && candidate.message.length <= MAX_TERMINAL_ERROR_MESSAGE_LENGTH;
    case "terminal-rebase-start":
      return isBoundedStr(candidate.attachmentId, MAX_TERMINAL_ATTACHMENT_ID_LENGTH)
        && isBoundedStr(candidate.generation, MAX_TERMINAL_GENERATION_LENGTH)
        && isNonNegInt(candidate.epoch)
        && isNonNegInt(candidate.nextSequence)
        && isIntInRange(candidate.cols, MIN_TERMINAL_COLS, MAX_TERMINAL_COLS)
        && isIntInRange(candidate.rows, MIN_TERMINAL_ROWS, MAX_TERMINAL_ROWS)
        && typeof candidate.alternate === "boolean"
        && isIntInRange(candidate.totalBytes, 0, MAX_TERMINAL_REBASE_TOTAL_BYTES)
        && isNonNegInt(candidate.chunkCount)
        && candidate.chunkCount === expectedRebaseChunkCount(candidate.totalBytes as number);
    case "terminal-rebase-chunk":
      return isBoundedStr(candidate.attachmentId, MAX_TERMINAL_ATTACHMENT_ID_LENGTH)
        && isBoundedStr(candidate.generation, MAX_TERMINAL_GENERATION_LENGTH)
        && isNonNegInt(candidate.epoch)
        && isNonNegInt(candidate.index)
        && parseCanonicalBase64(candidate.dataBase64, TERMINAL_REBASE_CHUNK_BYTES) !== null;
    case "terminal-rebase-end":
      return isBoundedStr(candidate.attachmentId, MAX_TERMINAL_ATTACHMENT_ID_LENGTH)
        && isBoundedStr(candidate.generation, MAX_TERMINAL_GENERATION_LENGTH)
        && isNonNegInt(candidate.epoch);
    case "terminal-bytes":
      return isBoundedStr(candidate.attachmentId, MAX_TERMINAL_ATTACHMENT_ID_LENGTH)
        && isBoundedStr(candidate.generation, MAX_TERMINAL_GENERATION_LENGTH)
        && isNonNegInt(candidate.epoch)
        && isNonNegInt(candidate.sequence)
        && parseCanonicalBase64(candidate.dataBase64, MAX_TERMINAL_INPUT_BYTES) !== null;
    case "terminal-role-changed":
      return isBoundedStr(candidate.attachmentId, MAX_TERMINAL_ATTACHMENT_ID_LENGTH)
        && isBoundedStr(candidate.terminalId, MAX_TERMINAL_ID_LENGTH)
        && validTerminalRole(candidate.role)
        && isNonNegInt(candidate.viewerCount);
    case "terminal-exit":
      return isBoundedStr(candidate.terminalId, MAX_TERMINAL_ID_LENGTH)
        && isBoundedStr(candidate.generation, MAX_TERMINAL_GENERATION_LENGTH)
        && isBoundedStr(candidate.reason, 128)
        && optNum(candidate.code)
        && (candidate.code === undefined || Number.isInteger(candidate.code));
    default:
      return false;
  }
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
  if (candidate.kind.startsWith("terminal-") && !validTargetedTerminalEvent(candidate)) return null;
  return payload as WebServerEvent;
}

// --- web→hub upstream messages (new direction; no prior precedent) ---

export const WEB_CLIENT_TYPE = "web.client";
export const MAX_WEB_INSTANCE_ID_LENGTH = 128;

export type WebClientMessage =
  // Legacy live-PTY path (kept until RMUX cutover).
  | { kind: "terminal-input"; instanceId: string; terminalId: string; data: string }
  | { kind: "terminal-resize"; instanceId: string; terminalId: string; cols: number; rows: number }
  | { kind: "terminal-close"; instanceId: string; terminalId: string }
  // Recoverable RMUX path.
  | { kind: "terminal-open"; requestId: string; instanceId: string; sessionAlias: string; cols: number; rows: number }
  | { kind: "terminal-stream-start"; requestId: string; instanceId: string; attachmentId: string }
  | { kind: "terminal-input"; instanceId: string; attachmentId: string; generation: string; dataBase64: string }
  | { kind: "terminal-resize"; instanceId: string; attachmentId: string; generation: string; cols: number; rows: number }
  | { kind: "terminal-heartbeat"; instanceId: string; attachmentId: string }
  | { kind: "terminal-take-control"; requestId: string; instanceId: string; attachmentId: string; generation: string }
  | { kind: "terminal-resync"; requestId: string; instanceId: string; attachmentId: string; generation: string }
  | { kind: "terminal-terminate"; requestId: string; instanceId: string; terminalId: string; generation: string }
  | { kind: "terminal-detach"; instanceId: string; attachmentId: string }
  | { kind: "subscribe"; instanceIds: string[] };

export function webClientEnvelope(msg: WebClientMessage): RelayEnvelope {
  return { protocolVersion: RELAY_PROTOCOL_VERSION, kind: "event", type: WEB_CLIENT_TYPE, payload: msg };
}

function rejectsBrowserStampedIdentity(c: Record<string, unknown>): boolean {
  return c.viewerId !== undefined || c.cwd !== undefined;
}

function validLegacyTerminalInput(c: Record<string, unknown>): boolean {
  return isBoundedStr(c.instanceId, MAX_WEB_INSTANCE_ID_LENGTH)
    && isBoundedStr(c.terminalId, MAX_TERMINAL_ID_LENGTH)
    && typeof c.data === "string"
    && c.attachmentId === undefined
    && c.generation === undefined
    && c.dataBase64 === undefined
    && !rejectsBrowserStampedIdentity(c);
}

function validRecoverableTerminalInput(c: Record<string, unknown>): boolean {
  return isBoundedStr(c.instanceId, MAX_WEB_INSTANCE_ID_LENGTH)
    && isBoundedStr(c.attachmentId, MAX_TERMINAL_ATTACHMENT_ID_LENGTH)
    && isBoundedStr(c.generation, MAX_TERMINAL_GENERATION_LENGTH)
    && parseCanonicalBase64(c.dataBase64, MAX_TERMINAL_INPUT_BYTES) !== null
    && c.terminalId === undefined
    && c.data === undefined
    && !rejectsBrowserStampedIdentity(c);
}

function validLegacyTerminalResize(c: Record<string, unknown>): boolean {
  return isBoundedStr(c.instanceId, MAX_WEB_INSTANCE_ID_LENGTH)
    && isBoundedStr(c.terminalId, MAX_TERMINAL_ID_LENGTH)
    && isIntInRange(c.cols, MIN_TERMINAL_COLS, MAX_TERMINAL_COLS)
    && isIntInRange(c.rows, MIN_TERMINAL_ROWS, MAX_TERMINAL_ROWS)
    && c.attachmentId === undefined
    && c.generation === undefined
    && !rejectsBrowserStampedIdentity(c);
}

function validRecoverableTerminalResize(c: Record<string, unknown>): boolean {
  return isBoundedStr(c.instanceId, MAX_WEB_INSTANCE_ID_LENGTH)
    && isBoundedStr(c.attachmentId, MAX_TERMINAL_ATTACHMENT_ID_LENGTH)
    && isBoundedStr(c.generation, MAX_TERMINAL_GENERATION_LENGTH)
    && isIntInRange(c.cols, MIN_TERMINAL_COLS, MAX_TERMINAL_COLS)
    && isIntInRange(c.rows, MIN_TERMINAL_ROWS, MAX_TERMINAL_ROWS)
    && c.terminalId === undefined
    && !rejectsBrowserStampedIdentity(c);
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
  if (typeof c.kind !== "string" || !c.kind.startsWith("terminal-")) return null;
  if (rejectsBrowserStampedIdentity(c)) return null;

  switch (c.kind) {
    case "terminal-open":
      return isBoundedStr(c.requestId, MAX_TERMINAL_REQUEST_ID_LENGTH)
        && isBoundedStr(c.instanceId, MAX_WEB_INSTANCE_ID_LENGTH)
        && isBoundedStr(c.sessionAlias, MAX_TERMINAL_SESSION_ALIAS_LENGTH)
        && isIntInRange(c.cols, MIN_TERMINAL_COLS, MAX_TERMINAL_COLS)
        && isIntInRange(c.rows, MIN_TERMINAL_ROWS, MAX_TERMINAL_ROWS)
        ? (p as WebClientMessage)
        : null;
    case "terminal-stream-start":
      return isBoundedStr(c.requestId, MAX_TERMINAL_REQUEST_ID_LENGTH)
        && isBoundedStr(c.instanceId, MAX_WEB_INSTANCE_ID_LENGTH)
        && isBoundedStr(c.attachmentId, MAX_TERMINAL_ATTACHMENT_ID_LENGTH)
        ? (p as WebClientMessage)
        : null;
    case "terminal-input":
      if (c.attachmentId !== undefined) return validRecoverableTerminalInput(c) ? (p as WebClientMessage) : null;
      return validLegacyTerminalInput(c) ? (p as WebClientMessage) : null;
    case "terminal-resize":
      if (c.attachmentId !== undefined) return validRecoverableTerminalResize(c) ? (p as WebClientMessage) : null;
      return validLegacyTerminalResize(c) ? (p as WebClientMessage) : null;
    case "terminal-heartbeat":
      return isBoundedStr(c.instanceId, MAX_WEB_INSTANCE_ID_LENGTH)
        && isBoundedStr(c.attachmentId, MAX_TERMINAL_ATTACHMENT_ID_LENGTH)
        ? (p as WebClientMessage)
        : null;
    case "terminal-take-control":
    case "terminal-resync":
      return isBoundedStr(c.requestId, MAX_TERMINAL_REQUEST_ID_LENGTH)
        && isBoundedStr(c.instanceId, MAX_WEB_INSTANCE_ID_LENGTH)
        && isBoundedStr(c.attachmentId, MAX_TERMINAL_ATTACHMENT_ID_LENGTH)
        && isBoundedStr(c.generation, MAX_TERMINAL_GENERATION_LENGTH)
        ? (p as WebClientMessage)
        : null;
    case "terminal-terminate":
      return isBoundedStr(c.requestId, MAX_TERMINAL_REQUEST_ID_LENGTH)
        && isBoundedStr(c.instanceId, MAX_WEB_INSTANCE_ID_LENGTH)
        && isBoundedStr(c.terminalId, MAX_TERMINAL_ID_LENGTH)
        && isBoundedStr(c.generation, MAX_TERMINAL_GENERATION_LENGTH)
        ? (p as WebClientMessage)
        : null;
    case "terminal-detach":
      return isBoundedStr(c.instanceId, MAX_WEB_INSTANCE_ID_LENGTH)
        && isBoundedStr(c.attachmentId, MAX_TERMINAL_ATTACHMENT_ID_LENGTH)
        ? (p as WebClientMessage)
        : null;
    case "terminal-close":
      return isBoundedStr(c.instanceId, MAX_WEB_INSTANCE_ID_LENGTH)
        && isBoundedStr(c.terminalId, MAX_TERMINAL_ID_LENGTH)
        ? (p as WebClientMessage)
        : null;
    default:
      return null;
  }
}
