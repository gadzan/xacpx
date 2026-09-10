import { planInlineActivityMarkers } from "./markdown-inline-markers";
import { normalizeMarkdownTables } from "./normalize-markdown";
import {
  analyzeMarkdownDocument,
  preprocessMarkdownSource,
  renderMarkdownTokens,
  renderMarkdownWithEnv,
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

const MAX_INLINE_PARAGRAPH_CHARS = 50_000;
const MAX_INLINE_MARKERS_PER_PARAGRAPH = 256;

function renderAtomicBlock(
  block: TopLevelBlockInfo,
  env: Record<string, unknown>,
  streaming: boolean,
): string {
  if (preprocessMarkdownSource(block.source, { streaming }) === block.source) {
    return renderMarkdownTokens(block.tokens, env);
  }
  return renderMarkdownWithEnv(block.source, { streaming }, env);
}

function pushMarkdownNode(
  nodes: MarkdownLayoutNode[],
  narrative: string,
  start: number,
  end: number,
  html: string,
  copyText?: string,
): void {
  if (end <= start) return;
  const source = narrative.slice(start, end);
  nodes.push({
    type: "markdown",
    key: `markdown:${start}:${end}`,
    sourceRange: [start, end],
    source,
    html,
    copyText: copyText ?? source,
    isLatest: false,
  });
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
  const activitiesByBlock = document.blocks.map((): LayoutActivityGeometry[] => []);
  let activityBlockIndex = 0;
  for (const activity of activities) {
    while (
      activityBlockIndex < document.blocks.length
      && activity.sourceOffset >= document.blocks[activityBlockIndex]!.endOffset
    ) {
      activityBlockIndex += 1;
    }
    const block = document.blocks[activityBlockIndex];
    if (
      block
      && activity.sourceOffset > block.startOffset
      && activity.sourceOffset < block.endOffset
    ) {
      activitiesByBlock[activityBlockIndex]!.push(activity);
    }
  }
  let cursor = 0;
  let lastNonWhitespaceOffset = narrative.length;
  while (
    lastNonWhitespaceOffset > 0
    && /\s/.test(narrative[lastNonWhitespaceOffset - 1]!)
  ) {
    lastNonWhitespaceOffset -= 1;
  }

  document.blocks.forEach((block, blockIndex) => {
    pushMarkdownNode(markdownNodes, narrative, cursor, block.startOffset, "");
    const internalActivities = activitiesByBlock[blockIndex]!;
    const streamingBlock = options.streaming === true
      && options.latestVisibleIsText === true
      && block.endOffset >= lastNonWhitespaceOffset;
    const normalized = normalizeMarkdownTables(block.source) !== block.source;
    // The marker planner only understands proven inline coordinates: an
    // unprovable projection (null) or any activity in the trimmed edge gap
    // stays atomic instead of guessing a coordinate.
    const inlineSource = block.type === "paragraph_open" && !normalized
      && block.inlineSource !== null
      && block.inlineStartOffset !== null
      ? block.inlineSource
      : null;
    const inlineStart = inlineSource === null ? null : block.inlineStartOffset;
    const markers = inlineSource === null || inlineStart === null
      ? []
      : internalActivities
        .filter((activity) => activity.sourceOffset >= inlineStart
          && activity.sourceOffset - inlineStart <= inlineSource.length)
        .map((activity) => ({
          id: activity.id,
          offset: activity.sourceOffset - inlineStart,
        }));
    const markerPlan = markers.length === internalActivities.length && markers.length > 0
      && inlineSource !== null && inlineStart !== null
      && inlineSource.length <= MAX_INLINE_PARAGRAPH_CHARS
      && markers.length <= MAX_INLINE_MARKERS_PER_PARAGRAPH
      ? planInlineActivityMarkers(inlineSource, markers, document.env, {
        streaming: streamingBlock,
      })
      : null;

    if (markerPlan && inlineStart !== null) {
      pushMarkdownNode(markdownNodes, narrative, block.startOffset, inlineStart, "");
      for (const fragment of markerPlan.fragments) {
        pushMarkdownNode(
          markdownNodes,
          narrative,
          inlineStart + fragment.sourceRange[0],
          inlineStart + fragment.sourceRange[1],
          fragment.html,
          fragment.copyText,
        );
      }
      const inlineEnd = inlineStart + inlineSource!.length;
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

  const markdownBoundaries = new Set<number>([0, narrative.length]);
  for (const node of markdownNodes) {
    markdownBoundaries.add(node.sourceRange[0]);
    markdownBoundaries.add(node.sourceRange[1]);
  }
  let markdownNodeIndex = 0;
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
    if (markdownBoundaries.has(activity.sourceOffset)) {
      candidates.set(activity.id, {
        sourceOffset: activity.sourceOffset,
        kind: "block-end",
        reason: "exact",
      });
      continue;
    }
    while (
      markdownNodeIndex < markdownNodes.length
      && activity.sourceOffset > markdownNodes[markdownNodeIndex]!.sourceRange[1]
    ) {
      markdownNodeIndex += 1;
    }
    const gap = markdownNodes[markdownNodeIndex];
    if (
      gap
      && activity.sourceOffset > gap.sourceRange[0]
      && activity.sourceOffset < gap.sourceRange[1]
      && gap.html === ""
      && gap.source.trim().length === 0
    ) {
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
