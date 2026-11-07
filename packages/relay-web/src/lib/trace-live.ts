import type { ToolDetailDto, ToolStepKind } from "@ganglion/xacpx-relay-protocol";
import type { TurnPresentationItem } from "./turn-presentation";
import { resolveSubagentStatus } from "./subagent-status";
import { subagentDetailOutput } from "./subagent-trace";
import { formatStepDuration } from "./use-live-elapsed";

/**
 * Projection for the drawer's fixed Live Stack. The stack reuses
 * `presentation.nodes` and `node.key`, so a row here is always the same event as
 * the row in the full process below — no second event vocabulary.
 *
 * Markdown keys embed the streamed text length (`markdown:<start>:<length>`), so
 * they change on every chunk. Identity strips that length; the live stack then
 * updates the prose row in place instead of replaying an entrance animation for
 * every token. `targetKey` keeps the current key so a click can still reveal the
 * exact full-list row.
 */

export type TraceLiveKind = "reasoning" | "tool" | "subagent" | "markdown" | "agent-message";

export interface TraceLiveItem {
  /** Stable while the same event streams. */
  key: string;
  /** Current full-list node key, used to reveal + highlight the row. */
  targetKey: string;
  kind: TraceLiveKind;
  /** Coarse tool kind, so a row can name the step type in text (not only icon). */
  toolKind?: ToolStepKind;
  title: string;
  status?: "running" | "success" | "error";
  /** Last one or two lines of the event's output, never the full text. */
  preview?: string;
  duration?: string;
}

/** Coalescing window for Live Stack repaints. Kept under the 150ms freshness
 *  contract: hub parts are merged synchronously, so this is the only delay. */
export const TRACE_LIVE_THROTTLE_MS = 120;

/** Live Stack rows render a visible type label, not just the aria-hidden icon. */
export function traceLiveTypeLabelKey(item: Pick<TraceLiveItem, "kind" | "toolKind">): string {
  switch (item.kind) {
    case "reasoning": return "group.detail.live.reasoning";
    case "markdown": return "group.detail.live.text";
    case "agent-message": return "group.detail.live.message";
    case "subagent": return "tools.subagent";
    default:
      if (item.toolKind === "delete" || item.toolKind === "move" || item.toolKind === "fetch") {
        return "tools.kinds.other";
      }
      return `tools.kinds.${item.toolKind ?? "other"}`;
  }
}

/**
 * Explicit output-rate gate for animation suppression (design §4.5).
 * `arrivals` holds epoch-ms stamps of NEW events (same-key streaming updates are
 * not events). More than 10 in the trailing second means the reader is watching
 * a burst: the stack updates content but stops animating.
 */
export const TRACE_LIVE_RATE_WINDOW_MS = 1_000;
export const TRACE_LIVE_RATE_LIMIT = 10;

export function traceLiveBurstActive(
  arrivals: readonly number[],
  now: number,
  windowMs = TRACE_LIVE_RATE_WINDOW_MS,
  limit = TRACE_LIVE_RATE_LIMIT,
): boolean {
  let count = 0;
  for (let index = arrivals.length - 1; index >= 0; index--) {
    if (now - arrivals[index]! > windowMs) break;
    count += 1;
  }
  return count > limit;
}

/** Rows the fixed stack can show; the full list keeps the same tail rendered. */
export const TRACE_LIVE_LIMIT_MOBILE = 2;
export const TRACE_LIVE_LIMIT_DESKTOP = 3;

export function traceLiveLimit(mobile: boolean): number {
  return mobile ? TRACE_LIVE_LIMIT_MOBILE : TRACE_LIVE_LIMIT_DESKTOP;
}

export interface TraceLiveLabels {
  text: string;
  reasoning: string;
  message: string;
}

/** Stable identity for one presentation node across streaming updates. */
export function traceNodeIdentity(node: TurnPresentationItem): string {
  return node.type === "markdown" ? `markdown:${node.sourceRange[0]}` : node.key;
}

function lastLines(text: string, count = 2): string | undefined {
  const lines = text.split("\n").map((line) => line.trim()).filter(Boolean);
  if (lines.length === 0) return undefined;
  return lines.slice(-count).join(" ");
}

function toolDetailText(detail: ToolDetailDto | undefined): string {
  if (!detail) return "";
  switch (detail.type) {
    case "command": return detail.output ?? detail.command;
    case "search": return detail.output ?? detail.query;
    case "read": return detail.preview ?? detail.lines ?? detail.path;
    case "text": return detail.output ?? detail.text;
    case "fields": return detail.output ?? detail.fields.map((field) => `${field.label}: ${field.value}`).join(" · ");
    case "diff": return detail.instruction ?? detail.path;
    default: return "";
  }
}

function itemOf(
  node: TurnPresentationItem,
  labels: TraceLiveLabels,
  streaming: boolean,
): TraceLiveItem {
  const base = { key: traceNodeIdentity(node), targetKey: node.key };
  switch (node.type) {
    case "tool": {
      const preview = lastLines(node.step.error ?? toolDetailText(node.step.detail));
      return {
        ...base,
        kind: "tool",
        toolKind: node.step.kind,
        title: node.step.title,
        status: node.step.status,
        ...(preview ? { preview } : {}),
        ...(node.step.durationMs !== undefined ? { duration: formatStepDuration(node.step.durationMs) } : {}),
      };
    }
    case "subagent": {
      const preview = lastLines(node.step.error ?? subagentDetailOutput(node.step.detail));
      return {
        ...base,
        kind: "subagent",
        title: node.step.title,
        status: resolveSubagentStatus(node.step, node.children),
        ...(preview ? { preview } : {}),
        ...(node.step.durationMs !== undefined ? { duration: formatStepDuration(node.step.durationMs) } : {}),
      };
    }
    case "reasoning": {
      const preview = lastLines(node.text);
      return {
        ...base,
        kind: "reasoning",
        title: labels.reasoning,
        ...(streaming && node.isLatest ? { status: "running" as const } : {}),
        ...(preview ? { preview } : {}),
      };
    }
    case "markdown": {
      const preview = lastLines(node.copyText || node.source);
      return {
        ...base,
        kind: "markdown",
        title: labels.text,
        ...(streaming && node.isLatest ? { status: "running" as const } : {}),
        ...(preview ? { preview } : {}),
      };
    }
    case "agent-message": {
      const preview = lastLines(node.message.content);
      return {
        ...base,
        kind: "agent-message",
        title: node.message.peer.displayName || node.message.peer.handle || labels.message,
        ...(preview ? { preview } : {}),
      };
    }
    default:
      return { ...base, kind: "tool", title: "" };
  }
}

export function traceLiveItems(
  nodes: readonly TurnPresentationItem[],
  limit: number,
  labels: TraceLiveLabels,
  streaming: boolean,
): TraceLiveItem[] {
  if (limit <= 0) return [];
  return nodes.slice(-limit).reverse().map((node) => itemOf(node, labels, streaming));
}
