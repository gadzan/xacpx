import type { PeerMessageHistoryEntry, ToolStepDto, TurnPartDto } from "@ganglion/xacpx-relay-protocol";
import {
  analyzeMarkdownDocument,
  isSafeInlineParagraphOffset,
  isSafeStandaloneParagraphOffset,
  topLevelBlockAt,
  type TopLevelBlockInfo,
} from "./render-markdown";
import { normalizeMarkdownTables } from "./normalize-markdown";
import { hasToolStepAncestor, indexToolSteps } from "./subagent-trace";

export type TurnPresentationItem =
  | { key: string; type: "text"; text: string; isLatest: boolean }
  | { key: string; type: "reasoning"; text: string; isLatest: boolean }
  | { key: string; type: "tool"; step: ToolStepDto; isLatest: boolean }
  | {
      key: string;
      type: "subagent";
      step: ToolStepDto;
      children: ToolStepDto[];
      isLatest: boolean;
    }
  | {
      key: string;
      type: "agent-message";
      message: PeerMessageHistoryEntry;
      anchorToolCallId: string;
      isLatest: boolean;
    };

/** Optional composition inputs. `sentAgentMessageById` keys SENT peer-message
 *  history entries by messageId so the sent card can be joined — presentation-only —
 *  to the exact agent_send tool step whose structured receipt carries that id.
 *  The persisted rows stay the canonical record; nothing here mutates them. */
export interface TurnPresentationOptions {
  sentAgentMessageById?: Map<string, PeerMessageHistoryEntry>;
  /** Mirror StreamMarkdown's live preprocessing so unsafe temporary splits fail closed. */
  streaming?: boolean;
}

type ActivityPart =
  | Exclude<TurnPartDto, { type: "text" }>
  | { type: "subagent"; step: ToolStepDto; children: ToolStepDto[] };

/** MessageIds these parts can anchor a sent card to: every tool step's
 *  `agentMessageId`, including steps folded into subagent activities. Mirrors the
 *  anchoring deriveTurnPresentation performs, so a caller can suppress a standalone
 *  card row exactly when the card renders inside a turn. */
export function anchoredAgentMessageIds(parts: TurnPartDto[]): Set<string> {
  const ids = new Set<string>();
  for (const part of parts) {
    if (part.type === "tool" && part.step.agentMessageId) ids.add(part.step.agentMessageId);
  }
  return ids;
}

export function deriveTurnPresentation(
  parts: TurnPartDto[],
  opts?: TurnPresentationOptions,
): TurnPresentationItem[] {
  const latestVisibleIndex = parts.findLastIndex((part) =>
    part.type === "tool" || part.text.trim().length > 0,
  );
  const toolSteps = parts
    .filter((part): part is Extract<TurnPartDto, { type: "tool" }> => part.type === "tool")
    .map((part) => part.step);
  const stepsById = indexToolSteps(toolSteps);
  const subagentIds = new Set(
    toolSteps.filter((step) => step.isSubagent === true).map((step) => step.toolCallId),
  );
  const descendantsOf = (parentToolCallId: string) =>
    toolSteps.filter((step) =>
      hasToolStepAncestor(step, stepsById, (ancestorId) => ancestorId === parentToolCallId),
    );
  let narrative = "";
  const activities: Array<{
    offset: number;
    index: number;
    part: ActivityPart;
  }> = [];

  parts.forEach((part, index) => {
    if (part.type === "text") {
      narrative += part.text;
      return;
    }
    if (part.type === "reasoning" && !part.text.trim()) return;
    if (
      part.type === "tool"
      && hasToolStepAncestor(part.step, stepsById, (ancestorId) => subagentIds.has(ancestorId))
    ) return;
    if (part.type === "tool" && part.step.isSubagent) {
      activities.push({
        offset: narrative.length,
        index,
        part: {
          type: "subagent",
          step: part.step,
          children: descendantsOf(part.step.toolCallId),
        },
      });
      return;
    }
    activities.push({ offset: narrative.length, index, part });
  });

  const markdown = analyzeMarkdownDocument(narrative);

  const blockAtOffset = (offset: number): TopLevelBlockInfo | null => {
    let low = 0;
    let high = markdown.blocks.length;
    while (low < high) {
      const middle = Math.floor((low + high) / 2);
      if (markdown.blocks[middle]!.endOffset < offset) low = middle + 1;
      else high = middle;
    }
    const block = markdown.blocks[low];
    return block && offset >= block.startOffset ? block : null;
  };

  const boundaryAtOrAfter = (offset: number): number | null => {
    let low = 0;
    let high = markdown.boundaries.length;
    while (low < high) {
      const middle = Math.floor((low + high) / 2);
      if (markdown.boundaries[middle]! < offset) low = middle + 1;
      else high = middle;
    }
    return markdown.boundaries[low] ?? null;
  };

  const safeNarrativeAnchor = (offset: number): number | null => {
    const block = blockAtOffset(offset);
    if (!block || block.type !== "paragraph_open") return null;
    const offsetInBlock = offset - block.startOffset;
    return isSafeStandaloneParagraphOffset(
      block.source,
      offsetInBlock,
      markdown.env,
      { streaming: opts?.streaming === true },
    )
      ? offset
      : null;
  };

  const anchored = new Map<number, typeof activities>();
  for (const activity of activities) {
    const anchor = narrative.slice(0, activity.offset).trim().length === 0
      ? 0
      : (safeNarrativeAnchor(activity.offset)
        ?? boundaryAtOrAfter(activity.offset)
        ?? narrative.length);
    const group = anchored.get(anchor) ?? [];
    group.push(activity);
    anchored.set(anchor, group);
  }

  const result: TurnPresentationItem[] = [];
  let cursor = 0;

  // Sent cards join right after the exact tool step that produced them (a send made
  // inside a subagent anchors after the whole subagent activity). Each messageId
  // anchors at most once; receiver-direction entries never join — those stay
  // standalone timeline rows.
  const anchoredMessageIds = new Set<string>();
  const pushAgentMessages = (steps: ToolStepDto[]): void => {
    const byId = opts?.sentAgentMessageById;
    if (!byId || byId.size === 0) return;
    for (const step of steps) {
      const id = step.agentMessageId;
      if (!id || anchoredMessageIds.has(id)) continue;
      const message = byId.get(id);
      if (!message || message.direction !== "sent") continue;
      anchoredMessageIds.add(id);
      result.push({
        key: `agent-message:${id}`,
        type: "agent-message",
        message,
        anchorToolCallId: step.toolCallId,
        isLatest: false,
      });
    }
  };

  const pushText = (end: number) => {
    const text = narrative.slice(cursor, end);
    if (text.trim()) {
      result.push({
        key: `text:${cursor}`,
        type: "text",
        text,
        isLatest: false,
      });
    }
    cursor = end;
  };

  for (const [anchor, group] of [...anchored.entries()].sort(([a], [b]) => a - b)) {
    pushText(anchor);
    for (const activity of group) {
      if (activity.part.type === "reasoning") {
        result.push({
          key: `reasoning:${activity.index}`,
          type: "reasoning",
          text: activity.part.text,
          isLatest: activity.index === latestVisibleIndex,
        });
      } else if (activity.part.type === "tool") {
        result.push({
          key: `tool:${activity.part.step.toolCallId}`,
          type: "tool",
          step: activity.part.step,
          isLatest: activity.index === latestVisibleIndex,
        });
        pushAgentMessages([activity.part.step]);
      } else {
        result.push({
          key: `subagent:${activity.part.step.toolCallId}`,
          type: "subagent",
          step: activity.part.step,
          children: activity.part.children,
          isLatest: activity.index === latestVisibleIndex,
        });
        pushAgentMessages([activity.part.step, ...activity.part.children]);
      }
    }
  }
  pushText(narrative.length);

  if (latestVisibleIndex >= 0 && parts[latestVisibleIndex]?.type === "text") {
    const latestText = result.findLast((item) => item.type === "text");
    if (latestText) latestText.isLatest = true;
  }

  return result;
}

/** Top-level block types that are strictly safe to slice mid-block across an activity.
 *  Containers (blockquotes, lists, tables, headings) can be nested arbitrarily or change
 *  block semantics if split. We fail-closed: only top-level paragraphs permit extracting
 *  trailing text after a mid-block activity.
 */
const SAFE_SLICE_BLOCK_TYPES: Record<string, true> = {
  paragraph_open: true,
};

/** Extract the conversational final reply from a turn's wire parts.
 *
 *  When a turn finishes with tool/reasoning activity:
 *  1. If deriveTurnPresentation() produced text items after the last process item,
 *     those items are already cleanly anchored at top-level Markdown block boundaries
 *     (e.g. after a code fence or table closed). We join and return them.
 *  2. If presentation placed the process item at the end, it was anchored at narrative end
 *     because it arrived inside the final Markdown block. If that block is safe prose
 *     (a paragraph), trailing text arriving after the process item is returned.
 *  3. If the process item arrived inside an unsafe or nested container (fence, table, list,
 *     blockquote) that never closed with a subsequent reply block, mid-block slicing would
 *     corrupt Markdown (turning closing fences into unclosed opening fences, breaking table
 *     rows, or severing nested blocks). The fail-safe is fail-closed: only explicitly safe
 *     top-level prose blocks (paragraph) permit slicing trailing text; all other
 *     block types (or missing blocks) return empty string (trace header only, no broken markdown).
 */
export function extractFinalReplyText(
  parts: TurnPartDto[],
  opts?: { presentation?: TurnPresentationItem[] },
): string {
  const pres = opts?.presentation ?? deriveTurnPresentation(parts);
  const lastProcessIndex = pres.findLastIndex((item) => item.type !== "text");

  // Pure-text turn: no process items to fold
  if (lastProcessIndex < 0) {
    return parts
      .filter((p): p is Extract<TurnPartDto, { type: "text" }> => p.type === "text")
      .map((p) => p.text)
      .join("");
  }

  // deriveTurnPresentation already placed subsequent Markdown blocks after the activity
  if (lastProcessIndex < pres.length - 1) {
    return pres
      .slice(lastProcessIndex + 1)
      .filter((item): item is Extract<TurnPresentationItem, { type: "text" }> => item.type === "text")
      .map((item) => item.text)
      .join("");
  }

  // presentation ended on the process item (anchored at narrative.length).
  const lastPartIdx = parts.findLastIndex(
    (p) => p.type === "tool" || (p.type === "reasoning" && p.text.trim().length > 0),
  );
  if (lastPartIdx < 0) return "";
  const trailing = parts
    .slice(lastPartIdx + 1)
    .filter((p): p is Extract<TurnPartDto, { type: "text" }> => p.type === "text")
    .map((p) => p.text)
    .join("");
  if (!trailing.trim()) return "";

  // Check if the last activity was inside an unsafe Markdown block.
  let narrative = "";
  let toolOffset = 0;
  for (let i = 0; i < parts.length; i += 1) {
    if (i === lastPartIdx) toolOffset = narrative.length;
    const part = parts[i]!;
    if (part.type === "text") narrative += part.text;
  }

  const docEnv: Record<string, unknown> = {};
  const block = topLevelBlockAt(narrative, toolOffset, docEnv);
  if (!block || !SAFE_SLICE_BLOCK_TYPES[block.type]) {
    return "";
  }
  // Normalization guard: the renderer runs normalizeMarkdownTables() before parsing.
  // If the candidate block would be reshaped by table normalization (e.g. malformed
  // delimiterless tables recognized as a table during render but appearing as a paragraph
  // to raw markdown-it), fail-closed so we do not slice mid-table or synthesize corrupted tables.
  if (normalizeMarkdownTables(block.source) !== block.source) {
    return "";
  }
  // Scope constraint: the fallback only applies when the trailing prose is strictly contained
  // within the validated top-level block. Any unrendered Markdown metadata outside the block
  // (such as trailing reference link definitions) must not leak as final reply.
  const outsideBlock = narrative.slice(block.endOffset);
  if (outsideBlock.trim().length > 0) {
    return "";
  }
  // Inline boundary guard: verify that the tool arrived at an unstyled top-level text
  // boundary within the paragraph, rather than severing an active inline construct
  // (code span, emphasis, bold, link label/delimiter, reference link, HTML entity, etc.).
  const offsetInBlock = toolOffset - block.startOffset;
  if (!isSafeInlineParagraphOffset(block.source, offsetInBlock, docEnv)) {
    return "";
  }
  const reply = narrative.slice(toolOffset, block.endOffset);
  return reply.trim() ? reply : "";
}

export interface CollapsedTraceSummary {
  finalReplyText: string;
  toolCount: number;
  thoughtCount: number;
}

/** Extract all collapsed-trace header metrics in a single pass, sharing the
 *  presentation derivation between the final conversational reply and the
 *  activity counters so MessageList and TurnParts never perform duplicate Markdown parses.
 */
export interface CollapsedTraceSummaryOptions extends TurnPresentationOptions {
  presentation?: TurnPresentationItem[];
}

export function extractCollapsedTraceSummary(
  parts: TurnPartDto[],
  opts?: CollapsedTraceSummaryOptions,
): CollapsedTraceSummary {
  const pres: TurnPresentationItem[] = opts?.presentation ?? deriveTurnPresentation(parts, opts);
  const finalReplyText = extractFinalReplyText(parts, { presentation: pres });
  const toolCount = pres.filter((item: TurnPresentationItem) => item.type === "tool" || item.type === "subagent").length;
  const thoughtCount = pres.filter((item: TurnPresentationItem) => item.type === "reasoning").length;
  return { finalReplyText, toolCount, thoughtCount };
}
