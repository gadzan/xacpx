import type { PlanEntry, ToolUseEvent, ToolUseKind, ToolUseStatus } from "../channels/types.js";
import type { AgentCommand, PromptUsage, UsageBreakdown, UsageCost } from "./types.js";
import { isAsyncAgentLaunchOutput } from "./claude-background-followup.js";
import { resolveToolEventMode } from "./tool-event-mode.js";
import type { ToolEventMode } from "./tool-event-mode.js";
import { TOOL_KIND_EMOJI, DEFAULT_TOOL_EMOJI } from "./tool-kind-emoji.js";

export interface StreamingPromptState {
  buffer: string;
  segments: string[];
  hasAgentMessage: boolean;
  pendingLine: string;
  formatToolCalls: boolean;
  emittedToolCallIds: Set<string>;
  // ACP `tool_call_update` frames are PARTIAL: each carries only the fields that
  // changed, keyed by toolCallId. In particular the terminal (completed/failed)
  // frame typically omits kind/title/content and only sets status + rawOutput. We
  // accumulate the merged state per toolCallId so the structured event always
  // reflects the full call (rich title + diff), not just the last sparse frame.
  toolCalls: Map<string, MergedToolUpdate>;
  toolEventMode: ToolEventMode;
  /** Resolved ACP driver used for provider-gated event normalization. */
  driver?: string;
  // Raw streaming (replyMode "stream"): the consumer renders one live bubble that
  // concatenates chunks verbatim, so we DON'T split on paragraph boundaries or trim.
  // Agent text accumulates raw in `buffer`; a short flush timer drains it as-is. This
  // trades the batched paragraph model (good for discrete chat messages) for low
  // first-token latency and smooth token streaming.
  rawStream: boolean;
  onToolEvent?: (event: ToolUseEvent) => void | Promise<void>;
  onThought?: (chunk: string) => void | Promise<void>;
  onPlan?: (entries: PlanEntry[]) => void | Promise<void>;
  onUsage?: (usage: PromptUsage) => void | Promise<void>;
  onCommands?: (commands: AgentCommand[]) => void | Promise<void>;
  finalize: () => string;
}

interface StreamEvent {
  method?: string;
  params?: {
    update?: {
      sessionUpdate?: string;
      content?: {
        type?: string;
        text?: string;
      };
      locations?: unknown;
      kind?: string;
      title?: string;
      toolCallId?: string;
      rawInput?: unknown;
      rawOutput?: unknown;
      entries?: unknown;
      // ACP `usage_update`: tokens currently in context + total context window.
      used?: number;
      size?: number;
      // ACP `usage_update` extras (acpx ≥0.11.0): cumulative cost + per-turn token breakdown.
      cost?: unknown;
      _meta?: {
        usage?: unknown;
        qoder?: {
          toolName?: string;
        };
        codex?: {
          subagent?: {
            threadId?: string;
            path?: string;
            activity?: string;
          };
        };
        claudeCode?: {
          toolName?: string;
          parentToolUseId?: string;
          toolResponse?: unknown;
        };
      };
      // ACP `available_commands_update`: agent-advertised slash commands.
      availableCommands?: unknown;
    };
  };
}

export type CreateStreamingPromptStateOptions =
  | ((event: ToolUseEvent) => void | Promise<void>)
  | {
      mode?: ToolEventMode;
      driver?: string;
      rawStream?: boolean;
      onToolEvent?: (event: ToolUseEvent) => void | Promise<void>;
      onThought?: (chunk: string) => void | Promise<void>;
      onPlan?: (entries: PlanEntry[]) => void | Promise<void>;
      onUsage?: (usage: PromptUsage) => void | Promise<void>;
      onCommands?: (commands: AgentCommand[]) => void | Promise<void>;
    };

export function createStreamingPromptState(
  formatToolCalls = false,
  options?: CreateStreamingPromptStateOptions,
): StreamingPromptState {
  let toolEventMode: ToolEventMode;
  let onToolEvent: ((event: ToolUseEvent) => void | Promise<void>) | undefined;
  let onThought: ((chunk: string) => void | Promise<void>) | undefined;
  let onPlan: ((entries: PlanEntry[]) => void | Promise<void>) | undefined;
  let onUsage: ((usage: PromptUsage) => void | Promise<void>) | undefined;
  let onCommands: ((commands: AgentCommand[]) => void | Promise<void>) | undefined;
  let rawStream = false;
  let driver: string | undefined;

  if (options === undefined) {
    toolEventMode = "text";
    onToolEvent = undefined;
  } else if (typeof options === "function") {
    // Legacy: bare callback → structured (preserves Phase 0 behavior)
    onToolEvent = options;
    toolEventMode = "structured";
  } else {
    onToolEvent = options.onToolEvent;
    onThought = options.onThought;
    onPlan = options.onPlan;
    onUsage = options.onUsage;
    onCommands = options.onCommands;
    rawStream = options.rawStream ?? false;
    driver = options.driver?.trim().toLowerCase() || undefined;
    toolEventMode = resolveToolEventMode({
      toolEventMode: options.mode,
      onToolEvent,
    });
  }

  return {
    buffer: "",
    segments: [],
    hasAgentMessage: false,
    pendingLine: "",
    formatToolCalls,
    emittedToolCallIds: new Set(),
    toolCalls: new Map(),
    toolEventMode,
    driver,
    rawStream,
    onToolEvent,
    onThought,
    onPlan,
    onUsage,
    onCommands,
    finalize(): string {
      if (this.pendingLine.trim().length > 0) {
        parseStreamingChunks(this, this.pendingLine);
      }
      // Raw streaming preserves the agent's exact text (the consumer concatenates
      // verbatim); only the batched paragraph path trims segment edges.
      const remaining = this.rawStream ? this.buffer : this.buffer.trim();
      this.buffer = "";
      this.pendingLine = "";
      return remaining;
    },
  };
}

export function parseStreamingDataChunk(state: StreamingPromptState, chunk: string): void {
  state.pendingLine += chunk;

  let boundary: number;
  while ((boundary = state.pendingLine.indexOf("\n")) !== -1) {
    const line = state.pendingLine.slice(0, boundary);
    state.pendingLine = state.pendingLine.slice(boundary + 1);
    parseStreamingChunks(state, line);
  }
}

export function parseStreamingChunks(state: StreamingPromptState, line: string): void {
  const trimmed = line.trim();
  if (trimmed.length === 0) return;

  let event: StreamEvent;
  try {
    event = JSON.parse(trimmed) as StreamEvent;
  } catch {
    return;
  }

  if (event.method !== "session/update") return;

  const update = event.params?.update;
  if (!update) return;

  if (update.sessionUpdate === "tool_call" || update.sessionUpdate === "tool_call_update") {
    // Structured consumers (e.g. the relay web dashboard) render tool calls in
    // their own UI, so they receive events through `onToolEvent` regardless of the
    // channel's text replyMode. Only the legacy inline-text rendering — which
    // spills tool calls into the reply stream — stays gated behind verbose mode
    // (`formatToolCalls`). Previously the whole branch was gated, so a channel with
    // replyMode "stream"/"final" silently dropped structured events too.
    const wantsStructured = state.toolEventMode === "structured" || state.toolEventMode === "both";
    const wantsText = (state.toolEventMode === "text" || state.toolEventMode === "both") && state.formatToolCalls;

    // Defense-in-depth: if a transport set mode='structured' without wiring
    // onToolEvent, drop the event silently rather than throwing or leaking
    // it into text. The transport-level resolveToolEventMode normally prevents
    // this state.
    if (wantsStructured && state.onToolEvent) {
      // Merge partial ACP updates per toolCallId so the terminal frame (which omits
      // kind/title/content) doesn't erase the rich in-progress frame's title + diff.
      const merged = update.toolCallId
        ? mergeToolCallUpdate(state, update.toolCallId, update)
        : update;
      const toolEvent = buildToolUseEvent(merged, state.driver);
      if (toolEvent) void state.onToolEvent(toolEvent);
    }

    if (wantsText) {
      const formatted = formatToolCallEvent(update, update.sessionUpdate);
      if (formatted) {
        const toolCallId = update.toolCallId;
        if (toolCallId) {
          if (state.emittedToolCallIds.has(toolCallId)) return;
          state.emittedToolCallIds.add(toolCallId);
        }
        state.segments.push(formatted);
      }
    }
    return;
  }

  if (update.sessionUpdate === "plan") {
    // ACP sends the full plan each time; forward verbatim (replace semantics). Validate
    // shape defensively — a malformed entry must not crash the stream parser.
    const entries = Array.isArray(update.entries)
      ? update.entries.filter((x): x is PlanEntry =>
          !!x && typeof x === "object" && typeof (x as PlanEntry).content === "string" && typeof (x as PlanEntry).status === "string")
      : [];
    if (entries.length > 0) void state.onPlan?.(entries);
    return;
  }

  if (update.sessionUpdate === "usage_update") {
    // Context-usage meter: `used` = tokens currently in context, `size` = the model's
    // total context window. Replace-latest scalar (agents may re-report mid-turn, e.g.
    // a default window then the model's real one). Drop a malformed/zero-window frame.
    const used = typeof update.used === "number" && Number.isFinite(update.used) ? update.used : undefined;
    const size = typeof update.size === "number" && Number.isFinite(update.size) ? update.size : undefined;
    if (used !== undefined && size !== undefined && size > 0) {
      const cost = normalizeUsageCost(update.cost);
      const breakdown = normalizeUsageBreakdown(update._meta?.usage);
      void state.onUsage?.({ used, size, ...(cost ? { cost } : {}), ...(breakdown ? { breakdown } : {}) });
    }
    return;
  }

  if (update.sessionUpdate === "available_commands_update") {
    // Agent-advertised slash commands (e.g. /compact). Full list each time (REPLACE).
    // Emit on any explicit list — including an empty one, which is a legitimate "clear"
    // (the agent dropped its commands); skip only malformed frames with no array.
    if (Array.isArray(update.availableCommands)) {
      void state.onCommands?.(normalizeAgentCommands(update.availableCommands));
    }
    return;
  }

  const isThoughtChunk =
    update.sessionUpdate === "agent_thought_chunk" &&
    update.content?.type === "text" &&
    typeof update.content.text === "string";
  if (isThoughtChunk) {
    const chunk = update.content!.text as string;
    if (chunk.length > 0) {
      // Fire-and-forget at the state level — transports that need serialized
      // awaiting wrap the user callback before passing it in (mirrors onToolEvent).
      void state.onThought?.(chunk);
    }
    return;
  }

  const isMessageChunk =
    update.sessionUpdate === "agent_message_chunk" &&
    update.content?.type === "text" &&
    typeof update.content.text === "string";

  if (!isMessageChunk) return;

  state.hasAgentMessage = true;
  const chunk = update.content!.text ?? "";
  if (chunk.length === 0) return;

  state.buffer += chunk;

  // Raw streaming: leave the text in `buffer` untouched — the transport's short flush
  // timer drains it verbatim, so paragraph structure is preserved without splitting.
  if (state.rawStream) return;

  // Split on paragraph boundaries (\n\n) — there may be multiple in a single chunk
  let boundary: number;
  while ((boundary = state.buffer.indexOf("\n\n")) !== -1) {
    const segment = state.buffer.slice(0, boundary).trim();
    state.buffer = state.buffer.slice(boundary + 2);
    if (segment.length > 0) {
      state.segments.push(segment);
    }
  }
}

function formatToolCallEvent(update: NonNullable<StreamEvent["params"]>["update"], sessionUpdate: string): string | null {
  if (!update) return null;
  const kind = update.kind ?? "";
  const title = update.title ?? "";
  if (title.length === 0) return null;

  const emoji = TOOL_KIND_EMOJI[kind as ToolUseKind] ?? DEFAULT_TOOL_EMOJI;
  // For tool_call_update, the useful payload is often in rawOutput rather
  // than rawInput (e.g. terminal command stdout). Fall back to rawOutput
  // when rawInput yields nothing actionable.
  const inputSummary = summarizeToolInput(update.rawInput, title) || summarizeToolInput(update.rawOutput, title);
  const status = readString(update, "status");

  // Some agents first emit a placeholder pending tool_call (for example
  // "Read File" with empty rawInput), then follow up with tool_call_update
  // carrying the useful file path/command. Do not mark the toolCallId as
  // emitted until we have something actionable to show.
  if (!inputSummary && status === "pending") return null;
  if (!inputSummary && isGenericToolTitle(kind, title)) return null;

  const summaryText = inputSummary && inputSummary !== title ? `: ${truncateToolDisplay(inputSummary)}` : "";
  const statusText = status ? ` (${status})` : "";
  return `${emoji} ${title}${statusText}${summaryText}`;
}

/** Accumulated raw tool-call fields across partial ACP `tool_call_update` frames. */
export type MergedToolUpdate = NonNullable<NonNullable<StreamEvent["params"]>["update"]>;

/** True for values that carry no information and so must NOT clobber a prior value:
 *  undefined/null, blank strings, and empty objects/arrays. acpx's initial `tool_call`
 *  frame ships empty `content: []` / `rawInput: {}`, and a terminal frame omits fields
 *  entirely — neither should erase data a richer in-progress frame already supplied. */
function isEmptyToolField(v: unknown): boolean {
  if (v === undefined || v === null) return true;
  if (typeof v === "string") return v.trim().length === 0;
  if (Array.isArray(v)) return v.length === 0;
  if (typeof v === "object") return Object.keys(v as object).length === 0;
  return false;
}

/** Merge a partial update into the per-toolCallId accumulator (present, non-empty
 *  fields override; absent/empty fields keep the prior value) and return the merged
 *  view. ACP `tool_call_update` semantics: a frame carries only what changed. */
function mergeToolCallUpdate(
  state: StreamingPromptState,
  toolCallId: string,
  update: MergedToolUpdate,
): MergedToolUpdate {
  const prev = state.toolCalls.get(toolCallId) ?? ({ toolCallId } as MergedToolUpdate);
  const merged: MergedToolUpdate = { ...prev };
  for (const key of ["kind", "title", "rawInput", "content", "rawOutput", "locations", "status"] as const) {
    const next = (update as Record<string, unknown>)[key];
    if (!isEmptyToolField(next)) (merged as Record<string, unknown>)[key] = next;
  }
  const nextMeta = update._meta;
  if (nextMeta) {
    const previousMeta = merged._meta;
    merged._meta = {
      ...previousMeta,
      ...nextMeta,
      ...(previousMeta?.qoder || nextMeta.qoder
        ? { qoder: { ...previousMeta?.qoder, ...nextMeta.qoder } }
        : {}),
      ...(previousMeta?.codex || nextMeta.codex
        ? {
            codex: {
              ...previousMeta?.codex,
              ...nextMeta.codex,
              ...(previousMeta?.codex?.subagent || nextMeta.codex?.subagent
                ? { subagent: { ...previousMeta?.codex?.subagent, ...nextMeta.codex?.subagent } }
                : {}),
            },
          }
        : {}),
      ...(previousMeta?.claudeCode || nextMeta.claudeCode
        ? { claudeCode: { ...previousMeta?.claudeCode, ...nextMeta.claudeCode } }
        : {}),
    };
  }
  merged.toolCallId = toolCallId;
  state.toolCalls.set(toolCallId, merged);
  return merged;
}

function buildToolUseEvent(
  update: NonNullable<StreamEvent["params"]>["update"],
  driver?: string,
): ToolUseEvent | null {
  if (!update) return null;
  const toolCallId = update.toolCallId;
  if (!toolCallId) return null;
  const kindRaw = update.kind ?? "";
  const kind: ToolUseKind = ((): ToolUseKind => {
    switch (kindRaw) {
      case "read": case "search": case "execute": case "edit": case "think": return kindRaw;
      default: return "other";
    }
  })();
  const title = (update.title ?? "").trim();
  const toolName = title || "Tool";
  // Reuse the existing summarizer (it has the title-vs-summary dedup logic baked in).
  // For tool_call_update, the useful payload is often in rawOutput rather
  // than rawInput (e.g. terminal command stdout). Fall back to rawOutput
  // when rawInput yields nothing actionable.
  const summaryRaw = summarizeToolInput(update.rawInput, title) || summarizeToolInput(update.rawOutput, title);
  const summary = summaryRaw && summaryRaw !== title ? summaryRaw : undefined;
  const statusRaw = readString(update, "status");
  // claude-agent-acp sometimes emits a sparse terminal update after the prompt
  // result: `_meta.claudeCode.toolResponse` carries the completed tool result but
  // `status` is omitted. Treating that frame as another running update leaves the
  // dashboard spinner alive forever (notably for tools running inside an async
  // Agent). A concrete toolResponse is terminal even when the adapter omitted the
  // redundant status field.
  const isClaudeDriver = driver === undefined || driver === "claude";
  const claudeMeta = isClaudeDriver ? update._meta?.claudeCode : undefined;
  const claudeToolResponse = claudeMeta?.toolResponse;
  const hasClaudeToolResponse = !isEmptyToolField(claudeToolResponse);
  const isAsyncAgentLaunch =
    (update._meta?.claudeCode?.toolName === "Agent" &&
      isRecord(claudeToolResponse) &&
      claudeToolResponse.status === "async_launched") ||
    (driver === "qoder" &&
      update._meta?.qoder?.toolName === "Agent" &&
      isAsyncAgentLaunchOutput(update.rawOutput));
  const status: ToolUseStatus =
    isAsyncAgentLaunch ? "running"
    : statusRaw === "completed" || statusRaw === "success" ? "success"
    : statusRaw === "failed" || statusRaw === "error" ? "error"
    : hasClaudeToolResponse ? "success"
    : "running";
  const rawInput = update.rawInput;
  const content = update.content;
  const rawOutput = update.rawOutput ?? claudeToolResponse;
  const locations = update.locations;
  const parentToolCallId = claudeMeta?.parentToolUseId?.trim();
  const isSubagent = (claudeMeta?.toolName === "Agent")
    || (driver === "qoder" && update._meta?.qoder?.toolName === "Agent")
    || (driver === "kimi" && isKimiSubagentInput(rawInput))
    || (driver === "codex" && isCodexSubagentMeta(update._meta?.codex?.subagent));
  return {
    toolCallId,
    ...(parentToolCallId ? { parentToolCallId } : {}),
    ...(isSubagent ? { isSubagent: true } : {}),
    toolName,
    kind,
    ...(summary ? { summary } : {}),
    ...(rawInput !== undefined ? { rawInput } : {}),
    ...(content !== undefined ? { content } : {}),
    ...(rawOutput !== undefined ? { rawOutput } : {}),
    ...(locations !== undefined ? { locations } : {}),
    status,
  };
}

function isKimiSubagentInput(rawInput: unknown): boolean {
  return isRecord(rawInput)
    && readFirstString(rawInput, ["prompt"]) !== undefined
    && readFirstString(rawInput, ["subagent_type", "subagentType"]) !== undefined;
}

function isCodexSubagentMeta(meta: { threadId?: string; activity?: string } | undefined): boolean {
  return typeof meta?.threadId === "string"
    && meta.threadId.trim().length > 0
    && typeof meta.activity === "string"
    && meta.activity.trim().length > 0;
}

function summarizeToolInput(rawInput: unknown, title = ""): string | undefined {
  if (rawInput == null) return undefined;
  if (typeof rawInput === "string" || typeof rawInput === "number" || typeof rawInput === "boolean") {
    return String(rawInput);
  }
  if (!isRecord(rawInput)) return undefined;

  const taskSummary = summarizeTaskInput(rawInput, title);
  if (taskSummary) return taskSummary;

  const command = readFirstString(rawInput, ["command", "cmd", "program"]);
  const args = readFirstStringArray(rawInput, ["args", "arguments"]);
  if (command) {
    return [command, ...(args ?? [])].join(" ");
  }

  const parsedCmd = rawInput.parsed_cmd;
  if (Array.isArray(parsedCmd) && parsedCmd.length > 0) {
    const parts: string[] = [];
    for (const entry of parsedCmd) {
      if (isRecord(entry) && typeof entry.cmd === "string" && entry.cmd.length > 0) {
        parts.push(entry.cmd);
      }
    }
    if (parts.length > 0) {
      return parts.join(" ");
    }
  }

  return readFirstString(rawInput, [
    "path",
    "file",
    "filePath",
    "filepath",
    "file_path",
    "target",
    "uri",
    "url",
    "query",
    "pattern",
    "text",
    "search",
    "name",
    "description",
  ]);
}

function summarizeTaskInput(rawInput: Record<string, unknown>, title: string): string | undefined {
  const subagentType = readFirstString(rawInput, ["subagent_type", "subagentType", "agent", "agentType"]);
  const description = readFirstString(rawInput, ["description", "task", "summary"]);
  if (subagentType && description) {
    return description === title ? subagentType : `${subagentType}: ${description}`;
  }
  if (subagentType) return subagentType;
  return undefined;
}

function readFirstString(record: Record<string, unknown>, keys: readonly string[]): string | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim().length > 0) {
      return value.trim();
    }
  }
  return undefined;
}

function readFirstStringArray(record: Record<string, unknown>, keys: readonly string[]): string[] | undefined {
  for (const key of keys) {
    const value = record[key];
    if (!Array.isArray(value)) continue;
    const entries = value
      .map((entry) => (typeof entry === "string" && entry.trim().length > 0 ? entry.trim() : undefined))
      .filter((entry): entry is string => entry !== undefined);
    if (entries.length > 0) {
      return entries;
    }
  }
  return undefined;
}

const USAGE_BREAKDOWN_FIELDS: ReadonlyArray<readonly [keyof UsageBreakdown, readonly string[]]> = [
  ["inputTokens", ["inputTokens", "input_tokens"]],
  ["outputTokens", ["outputTokens", "output_tokens"]],
  ["cachedReadTokens", ["cachedReadTokens", "cacheReadInputTokens", "cache_read_input_tokens"]],
  ["cachedWriteTokens", ["cachedWriteTokens", "cacheCreationInputTokens", "cache_creation_input_tokens"]],
  ["thoughtTokens", ["thoughtTokens", "thought_tokens"]],
  ["totalTokens", ["totalTokens", "total_tokens"]],
];

function asFiniteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function firstFiniteNumber(record: Record<string, unknown>, keys: readonly string[]): number | undefined {
  for (const key of keys) {
    const n = asFiniteNumber(record[key]);
    if (n !== undefined) return n;
  }
  return undefined;
}

function normalizeUsageBreakdown(value: unknown): UsageBreakdown | undefined {
  if (!isRecord(value)) return undefined;
  const out: UsageBreakdown = {};
  for (const [key, aliases] of USAGE_BREAKDOWN_FIELDS) {
    const n = firstFiniteNumber(value, aliases);
    if (n !== undefined) out[key] = n;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function normalizeUsageCost(value: unknown): UsageCost | undefined {
  if (!isRecord(value)) return undefined;
  const amount = asFiniteNumber(value.amount);
  const currency = readString(value, "currency");
  if (amount === undefined && !currency) return undefined;
  return { ...(amount !== undefined ? { amount } : {}), ...(currency ? { currency } : {}) };
}

function normalizeAgentCommands(value: unknown): AgentCommand[] {
  if (!Array.isArray(value)) return [];
  const out: AgentCommand[] = [];
  for (const entry of value) {
    if (!isRecord(entry)) continue;
    const name = readString(entry, "name");
    if (!name) continue;
    const description = readString(entry, "description");
    out.push({ name, ...(description ? { description } : {}), hasInput: entry.input != null });
  }
  return out;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readString(rawInput: unknown, key: string): string | undefined {
  if (!isRecord(rawInput)) return undefined;
  const value = rawInput[key];
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function truncateToolDisplay(text: string): string {
  return text.length > 60 ? `${text.slice(0, 57)}...` : text;
}

function isGenericToolTitle(kind: string, title: string): boolean {
  const normalizedTitle = title.trim().toLowerCase();
  if (kind === "execute" && ["bash", "shell", "sh", "powershell", "cmd"].includes(normalizedTitle)) {
    return true;
  }
  if (kind === "search" && ["grep", "rg", "search"].includes(normalizedTitle)) {
    return true;
  }
  if (kind === "read" && ["read", "cat"].includes(normalizedTitle)) {
    return true;
  }
  return false;
}
