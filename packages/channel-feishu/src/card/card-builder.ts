import type { PlanEntry, PromptUsage } from "xacpx/plugin-api";
import { t } from "../i18n/index.js";
import { en } from "../i18n/en.js";
import { zh } from "../i18n/zh.js";
import type { ToolUseStatus, ToolUseStep } from "./tool-use-types.js";

export const STREAMING_ELEMENT_ID = "streaming_content";
export const REASONING_ELEMENT_ID = "reasoning_content";

export type CardState = "thinking" | "streaming" | "complete" | "aborted" | "error";

// Feishu interactive card body limit is ~30k chars; leave headroom for JSON
// envelope, schema fields, and the truncation marker.
export const CARD_BODY_MAX_CHARS = 28000;
const TRUNCATION_MARKER = "\n\n…(truncated)";
const TOOL_PANEL_MAX_STEPS = 50;
const PLAN_PANEL_MAX_STEPS = 30;

export function truncateForCardBody(text: string, maxChars: number = CARD_BODY_MAX_CHARS): string {
  if (text.length <= maxChars) return text;
  // When maxChars is too small to fit the marker, drop the marker entirely
  // — the contract is "result <= maxChars". Callers that want the marker
  // are expected to pass a value > TRUNCATION_MARKER.length.
  if (maxChars <= TRUNCATION_MARKER.length) return text.slice(0, Math.max(0, maxChars));
  const room = maxChars - TRUNCATION_MARKER.length;
  return `${text.slice(0, room)}${TRUNCATION_MARKER}`;
}

export interface BuildCardInput {
  state: CardState;
  text: string;
  elapsedMs?: number;
  reasoningText?: string;
  reasoningElapsedMs?: number;
  toolSteps?: ToolUseStep[];
  /** Agent live plan/todo list (ACP `plan`); rendered as a collapsible panel. */
  planEntries?: PlanEntry[];
  /** Context-usage side-channel; rendered into the footer (tokens + window %). */
  usage?: PromptUsage;
  /** Per-call override of {@link CARD_BODY_MAX_CHARS}. */
  maxBodyChars?: number;
}

export function buildCard(input: BuildCardInput): Record<string, unknown> {
  const maxChars = input.maxBodyChars ?? CARD_BODY_MAX_CHARS;
  const safeText = truncateForCardBody(input.text, maxChars);
  const isLive = input.state === "thinking" || input.state === "streaming";
  const summary = summaryForState(input.state);
  const config: Record<string, unknown> = {
    streaming_mode: isLive,
    summary,
  };

  const elements: Array<Record<string, unknown>> = [];

  const planPanel = buildPlanPanel(input.planEntries);
  if (planPanel) {
    elements.push(planPanel);
    elements.push({ tag: "hr" });
  }

  const toolPanel = buildToolUsePanel(input.toolSteps);
  if (toolPanel) {
    elements.push(toolPanel);
    elements.push({ tag: "hr" });
  }

  const reasoning = input.reasoningText?.trim();
  if (reasoning) {
    const elapsedLabel =
      input.reasoningElapsedMs !== undefined && input.reasoningElapsedMs > 0
        ? formatElapsedMs(input.reasoningElapsedMs)
        : "";
    const reasoningHeaderTitle = elapsedLabel ? t().reasoningHeaderElapsed(elapsedLabel) : t().reasoningHeader;
    elements.push({
      tag: "collapsible_panel",
      expanded: false,
      header: {
        title: {
          tag: "markdown",
          content: reasoningHeaderTitle,
        },
      },
      elements: [
        {
          tag: "markdown",
          element_id: REASONING_ELEMENT_ID,
          content: truncateForCardBody(reasoning, maxChars),
          text_align: "left",
          text_size: "notation",
        },
      ],
    });
    elements.push({ tag: "hr" });
  }

  elements.push({
    tag: "markdown",
    element_id: STREAMING_ELEMENT_ID,
    content: input.state === "thinking" ? "" : safeText,
    text_align: "left",
    text_size: "normal_v2",
  });

  const usageText = input.usage ? formatUsageSegment(input.usage) : "";
  const footer = footerForState(input.state, input.elapsedMs, usageText || undefined);
  if (footer) elements.push(footer);

  return {
    schema: "2.0",
    config,
    body: { elements },
  };
}

export function formatElapsedMs(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "";
  if (ms < 1000) return `${ms}ms`;
  const seconds = ms / 1000;
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  const minutes = Math.floor(seconds / 60);
  const rest = Math.round(seconds - minutes * 60);
  return rest === 0 ? `${minutes}m` : `${minutes}m ${rest}s`;
}

function summaryForState(state: CardState): Record<string, unknown> {
  switch (state) {
    case "thinking":
    case "streaming":
      return { content: t().summaryProcessing, i18n_content: { zh_cn: zh.summaryProcessing, en_us: en.summaryProcessing } };
    case "complete":
      return { content: t().summaryComplete, i18n_content: { zh_cn: zh.summaryComplete, en_us: en.summaryComplete } };
    case "aborted":
      return { content: t().summaryStopped, i18n_content: { zh_cn: zh.summaryStopped, en_us: en.summaryStopped } };
    case "error":
      return { content: t().summaryError, i18n_content: { zh_cn: zh.summaryError, en_us: en.summaryError } };
  }
}

function footerElement(content: string): Record<string, unknown> {
  return { tag: "markdown", content, text_size: "notation", text_align: "left" };
}

function footerForState(
  state: CardState,
  elapsedMs?: number,
  usageText?: string,
): Record<string, unknown> | null {
  const elapsedLabel = typeof elapsedMs === "number" ? formatElapsedMs(elapsedMs) : "";
  const elapsedSuffix = elapsedLabel ? ` · ${elapsedLabel}` : "";
  // Usage rides as a trailing ` · <tokens · ctx %>` segment on whatever the
  // state's footer already shows. It can be present without elapsed (e.g. a
  // usage_update lands before the first footer tick), so complete/streaming
  // render their footer when EITHER elapsed or usage is available.
  const usageSuffix = usageText ? ` · ${usageText}` : "";
  switch (state) {
    // Live states (thinking/streaming) embed the elapsed inline as
    // `处理中... <elapsed>` rather than appending it via ` · <elapsed>`
    // because the ellipsis already signals "still working" — the elapsed
    // reads as the current measurement of that work-in-progress. Terminal
    // states (complete/aborted/error) use the ` · ` separator because the
    // label is a final outcome and the elapsed is supplementary.
    case "thinking":
      return footerElement((elapsedLabel ? t().footerThinkingElapsed(elapsedLabel) : t().footerThinking) + usageSuffix);
    case "aborted":
      return footerElement(t().footerAborted(elapsedSuffix) + usageSuffix);
    case "error":
      return footerElement(t().footerError(elapsedSuffix) + usageSuffix);
    case "complete":
      if (!elapsedLabel && !usageText) return null;
      return footerElement(elapsedLabel ? t().footerComplete(elapsedLabel) + usageSuffix : (usageText ?? ""));
    case "streaming":
      if (!elapsedLabel && !usageText) return null;
      return footerElement(elapsedLabel ? t().footerStreaming(elapsedLabel) + usageSuffix : (usageText ?? ""));
  }
}

/**
 * Render the usage side-channel as a compact footer segment, e.g.
 * `↑1.2k · ↓800 · ctx 12k/200k 6%`. Each piece is independent: token counts
 * come from the per-turn breakdown (codex may omit them) and the context part
 * from the window fill. Returns "" when nothing usable is present.
 */
export function formatUsageSegment(usage: PromptUsage): string {
  const parts: string[] = [];
  const breakdown = usage.breakdown;
  if (breakdown && typeof breakdown.inputTokens === "number" && breakdown.inputTokens > 0) {
    parts.push(`↑${formatTokenCount(breakdown.inputTokens)}`);
  }
  if (breakdown && typeof breakdown.outputTokens === "number" && breakdown.outputTokens > 0) {
    parts.push(`↓${formatTokenCount(breakdown.outputTokens)}`);
  }
  if (typeof usage.size === "number" && usage.size > 0 && typeof usage.used === "number" && usage.used >= 0) {
    // Clamp: agents can transiently report used > size; never show >100%.
    const percent = Math.min(100, Math.round((usage.used / usage.size) * 100));
    parts.push(`ctx ${formatTokenCount(usage.used)}/${formatTokenCount(usage.size)} ${percent}%`);
  }
  return parts.join(" · ");
}

function formatTokenCount(value: number): string {
  if (!Number.isFinite(value) || value < 0) return "0";
  const rounded = Math.round(value);
  if (rounded >= 1_000_000) return formatScaled(rounded, 1_000_000, "m");
  if (rounded >= 1_000) {
    // Promote to the next unit when the k-rounding would read "1000k"
    // (e.g. 999_999 → "1m", not "1000k").
    if (Math.round(rounded / 1_000) >= 1_000) return formatScaled(rounded, 1_000_000, "m");
    return formatScaled(rounded, 1_000, "k");
  }
  return String(rounded);
}

function formatScaled(value: number, factor: number, suffix: string): string {
  const scaled = value / factor;
  if (scaled >= 100 || Number.isInteger(scaled)) return `${Math.round(scaled)}${suffix}`;
  return `${scaled.toFixed(1).replace(/\.0$/, "")}${suffix}`;
}

const PLAN_STATUS_ICON: Record<string, string> = {
  completed: "✅",
  in_progress: "⏳",
  pending: "⬜",
};

function buildPlanPanel(entries: PlanEntry[] | undefined): Record<string, unknown> | null {
  if (!entries || entries.length === 0) return null;
  const done = entries.filter((entry) => entry.status === "completed").length;
  const visible = entries.slice(0, PLAN_PANEL_MAX_STEPS);
  const lines = visible.map((entry) => {
    const icon = PLAN_STATUS_ICON[entry.status] ?? PLAN_STATUS_ICON.pending;
    const text = truncateInline(entry.content, 120);
    // Strike completed items so the remaining work reads at a glance.
    return entry.status === "completed" ? `${icon} ~~${text}~~` : `${icon} ${text}`;
  });
  const omitted = entries.length - visible.length;
  if (omitted > 0) {
    lines.push(t().planPanelOmitted(omitted));
  }
  return {
    tag: "collapsible_panel",
    // Expanded by default: the live plan is the headline "what's happening".
    expanded: true,
    header: {
      title: {
        tag: "markdown",
        content: t().planPanelHeader(done, entries.length),
      },
    },
    elements: [
      {
        tag: "markdown",
        content: lines.join("\n"),
        text_align: "left",
        text_size: "notation",
      },
    ],
  };
}

const TOOL_KIND_ICON: Record<string, string> = {
  read: "\u{1F4D6}",
  search: "\u{1F50D}",
  execute: "\u{1F4BB}",
  edit: "\u{270F}\u{FE0F}",
  think: "\u{1F9E0}",
  other: "\u{1F527}",
};

// Full-width space: ASCII leading spaces collapse in Feishu markdown, so
// nesting depth is conveyed with an ideographic space that survives rendering.
const INDENT_UNIT = "\u3000";

function statusBadge(status: ToolUseStatus): string {
  return status === "running" ? "⏳" : status === "error" ? "❌" : "✅";
}

function stepSummarySuffix(step: ToolUseStep): string {
  return step.summary ? `: ${truncateInline(step.summary, 80)}` : "";
}

function stepDurationSuffix(step: ToolUseStep): string {
  return step.durationMs !== undefined ? ` _(${formatElapsedMs(step.durationMs)})_` : "";
}

/** Walk the parentToolCallId chain, cycle-safe, yielding ancestor ids present in the batch. */
function* ancestorIds(step: ToolUseStep, byId: Map<string, ToolUseStep>): Generator<string> {
  let parentId = step.parentToolCallId;
  const seen = new Set<string>();
  while (parentId && byId.has(parentId) && !seen.has(parentId)) {
    yield parentId;
    seen.add(parentId);
    parentId = byId.get(parentId)?.parentToolCallId;
  }
}

/** How many subagent ancestors a step has — its indentation level (0 = top level). */
function subagentAncestorDepth(step: ToolUseStep, byId: Map<string, ToolUseStep>): number {
  let depth = 0;
  for (const id of ancestorIds(step, byId)) {
    if (byId.get(id)?.isSubagent) depth += 1;
  }
  return depth;
}

function isDescendantOf(step: ToolUseStep, ancestorId: string, byId: Map<string, ToolUseStep>): boolean {
  for (const id of ancestorIds(step, byId)) {
    if (id === ancestorId) return true;
  }
  return false;
}

/**
 * Fold the flat tool-step list into a subagent-aware, insertion-ordered
 * display list: top-level steps (ordinary tools + top-level subagents) render
 * at the root, and every subagent is immediately followed by its descendants.
 * Mirrors the relay-web SubagentStepCard fold, adapted to a single markdown
 * block. Provider-agnostic — reads only `isSubagent`/`parentToolCallId`.
 */
function buildToolUsePanel(steps: ToolUseStep[] | undefined): Record<string, unknown> | null {
  if (!steps || steps.length === 0) return null;
  const byId = new Map(steps.map((step) => [step.toolCallId, step]));

  const descendantCount = (parentId: string): number =>
    steps.reduce((n, step) => (isDescendantOf(step, parentId, byId) ? n + 1 : n), 0);

  // Display order: iterate top-level roots (no subagent ancestor); a subagent
  // root is immediately trailed by all its descendants in insertion order, so
  // nested steps never surface twice.
  const displayOrder: ToolUseStep[] = [];
  for (const step of steps) {
    if (subagentAncestorDepth(step, byId) > 0) continue;
    displayOrder.push(step);
    if (step.isSubagent) {
      for (const candidate of steps) {
        if (candidate !== step && isDescendantOf(candidate, step.toolCallId, byId)) {
          displayOrder.push(candidate);
        }
      }
    }
  }

  const visible = displayOrder.slice(0, TOOL_PANEL_MAX_STEPS);
  const lines: string[] = [];
  for (const step of visible) {
    const depth = subagentAncestorDepth(step, byId);
    const indent = depth > 0 ? `${INDENT_UNIT.repeat(depth)}└ ` : "";
    if (step.isSubagent) {
      const children = descendantCount(step.toolCallId);
      lines.push(`${indent}${statusBadge(step.status)} ${t().subagentHeader(step.toolName, children)}${stepSummarySuffix(step)}`);
      // Truthful fallback: providers that report only the delegating call
      // (Qoder/Kimi/Codex) leave the trace empty — never fabricate children.
      if (children === 0) {
        lines.push(`${INDENT_UNIT.repeat(depth + 1)}└ _${t().subagentNoActivity}_`);
      }
    } else {
      const icon = TOOL_KIND_ICON[step.kind] ?? TOOL_KIND_ICON.other;
      lines.push(`${indent}${statusBadge(step.status)} ${icon} **${step.toolName}**${stepSummarySuffix(step)}${stepDurationSuffix(step)}`);
    }
  }

  const omitted = displayOrder.length - visible.length;
  if (omitted > 0) {
    lines.push(t().toolPanelOmitted(omitted));
  }
  return {
    tag: "collapsible_panel",
    expanded: false,
    header: {
      title: {
        tag: "markdown",
        content: t().toolPanelHeader(steps.length),
      },
    },
    elements: [
      {
        tag: "markdown",
        content: lines.join("\n\n"),
        text_align: "left",
        text_size: "notation",
      },
    ],
  };
}


function truncateInline(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max - 3)}...` : s;
}

/**
 * Builds the `content` string for `im.message.create({ msg_type: "interactive" })`
 * that references a CardKit card instance by id.
 */
export function buildCardMessageContent(cardId: string): string {
  return JSON.stringify({ type: "card", data: { card_id: cardId } });
}
