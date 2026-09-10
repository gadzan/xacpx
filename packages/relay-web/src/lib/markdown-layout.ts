import { planInlineActivityMarkers } from "./markdown-inline-markers";
import { normalizeMarkdownTables } from "./normalize-markdown";
import {
  analyzeMarkdownDocument,
  preprocessMarkdownSource,
  renderMarkdown,
  renderMarkdownTokens,
  type RenderMarkdownOptions,
  type TopLevelBlockInfo,
} from "./render-markdown";
import type {
  LayoutActivityGeometry,
  LayoutSlotCandidate,
  MarkdownLayoutNode,
} from "./turn-layout";

export interface MarkdownLayoutOptions extends RenderMarkdownOptions {
  latestVisibleIsText?: boolean;
}

export interface MarkdownLayoutGeometry {
  markdownNodes: MarkdownLayoutNode[];
  candidates: Map<string, LayoutSlotCandidate>;
}

function renderAtomicBlock(
  block: TopLevelBlockInfo,
  env: Record<string, unknown>,
  streaming: boolean,
): string {
  return preprocessMarkdownSource(block.source, { streaming }) === block.source
    ? renderMarkdownTokens(block.tokens, env)
    : renderMarkdown(block.source, { streaming });
}

function pushMarkdownNode(
  nodes: MarkdownLayoutNode[],
  narrative: string,
  start: number,
  end: number,
  html: string,
): void {
  if (end <= start) return;
  nodes.push({
    type: "markdown",
    key: `markdown:${start}:${end}`,
    sourceRange: [start, end],
    source: narrative.slice(start, end),
    html,
    isLatest: false,
  });
}

function activitiesInside(
  activities: readonly LayoutActivityGeometry[],
  start: number,
  end: number,
): LayoutActivityGeometry[] {
  return activities.filter((activity) =>
    activity.sourceOffset > start && activity.sourceOffset < end,
  );
}

/**
 * Analyze Markdown once, derive legal slots, and pre-render a complete source-range
 * partition. Only top-level paragraphs may contain exact inline activity markers;
 * every structural block remains atomic.
 */
export function deriveMarkdownLayout(
  narrative: string,
  activities: readonly LayoutActivityGeometry[],
  options: MarkdownLayoutOptions = {},
): MarkdownLayoutGeometry {
  const document = analyzeMarkdownDocument(narrative);
  const candidates = new Map<string, LayoutSlotCandidate>();
  const markdownNodes: MarkdownLayoutNode[] = [];
  let cursor = 0;

  document.blocks.forEach((block, blockIndex) => {
    pushMarkdownNode(markdownNodes, narrative, cursor, block.startOffset, "");
    const internalActivities = activitiesInside(
      activities,
      block.startOffset,
      block.endOffset,
    );
    const trailingSource = narrative.slice(block.endOffset);
    const streamingBlock = options.streaming === true
      && options.latestVisibleIsText === true
      && trailingSource.trim().length === 0;
    const normalized = normalizeMarkdownTables(block.source) !== block.source;
    const inlineSource = block.type === "paragraph_open" && !normalized
      ? block.inlineSource
      : null;
    const markers = inlineSource === null
      ? []
      : internalActivities
        .filter((activity) => activity.sourceOffset - block.startOffset <= inlineSource.length)
        .map((activity) => ({
          id: activity.id,
          offset: activity.sourceOffset - block.startOffset,
        }));
    const markerPlan = markers.length === internalActivities.length && markers.length > 0
      ? planInlineActivityMarkers(inlineSource!, markers, document.env, {
        streaming: streamingBlock,
      })
      : null;

    if (markerPlan) {
      for (const fragment of markerPlan.fragments) {
        pushMarkdownNode(
          markdownNodes,
          narrative,
          block.startOffset + fragment.sourceRange[0],
          block.startOffset + fragment.sourceRange[1],
          fragment.html,
        );
      }
      const inlineEnd = block.startOffset + inlineSource!.length;
      pushMarkdownNode(markdownNodes, narrative, inlineEnd, block.endOffset, "");
      for (const activity of internalActivities) {
        candidates.set(activity.id, {
          sourceOffset: activity.sourceOffset,
          kind: "exact-inline",
          reason: "exact",
        });
      }
    } else {
      pushMarkdownNode(
        markdownNodes,
        narrative,
        block.startOffset,
        block.endOffset,
        renderAtomicBlock(block, document.env, streamingBlock),
      );
      const boundary = document.boundaries[blockIndex] ?? block.endOffset;
      for (const activity of internalActivities) {
        candidates.set(activity.id, {
          sourceOffset: boundary,
          kind: "block-end",
          reason: inlineSource !== null && !normalized
            ? "marker-unsafe"
            : "structural-block",
        });
      }
    }
    cursor = block.endOffset;
  });
  pushMarkdownNode(markdownNodes, narrative, cursor, narrative.length, "");

  for (const activity of activities) {
    if (candidates.has(activity.id)) continue;
    if (activity.sourceOffset === 0) {
      candidates.set(activity.id, {
        sourceOffset: 0,
        kind: "document-start",
        reason: "exact",
      });
      continue;
    }
    if (activity.sourceOffset === narrative.length) {
      candidates.set(activity.id, {
        sourceOffset: narrative.length,
        kind: "document-end",
        reason: "exact",
      });
      continue;
    }
    const gap = markdownNodes.find((node) =>
      activity.sourceOffset >= node.sourceRange[0]
      && activity.sourceOffset <= node.sourceRange[1]
      && node.html === ""
      && node.source.trim().length === 0,
    );
    if (gap) {
      candidates.set(activity.id, {
        sourceOffset: activity.sourceOffset,
        kind: "block-end",
        reason: "exact",
      });
      continue;
    }
    candidates.set(activity.id, {
      sourceOffset: narrative.length,
      kind: "document-end",
      reason: "structural-block",
    });
  }

  const latestMarkdown = markdownNodes.findLast((node) => node.html.trim().length > 0);
  if (latestMarkdown && options.streaming && options.latestVisibleIsText) {
    latestMarkdown.isLatest = true;
  }
  return { markdownNodes, candidates };
}
