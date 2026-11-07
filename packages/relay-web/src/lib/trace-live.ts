import type { ToolDetailDto } from "@ganglion/xacpx-relay-protocol";
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
  title: string;
  status?: "running" | "success" | "error";
  /** Last one or two lines of the event's output, never the full text. */
  preview?: string;
  duration?: string;
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
