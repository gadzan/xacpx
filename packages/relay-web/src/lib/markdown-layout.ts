import { planInlineActivityMarkers } from "./markdown-inline-markers";
import { normalizeMarkdownTables } from "./normalize-markdown";
import {
  analyzeMarkdownDocument,
  markdownSourceToPlainText,
  markdownTokensToPlainText,
  preprocessMarkdownSource,
  renderMarkdownTokens,
  renderMarkdownWithEnv,
  type RenderMarkdownOptions,
  type TopLevelBlockInfo,
} from "./render-markdown";
import type {
  BlockActivityDisposition,
  LayoutActivityGeometry,
  LayoutSlotCandidate,
  MarkdownLayoutNode,
  TurnLayoutBlockCacheEntry,
  TurnLayoutBlockFingerprint,
} from "./turn-layout";
export interface MarkdownLayoutOptions extends RenderMarkdownOptions {
  latestVisibleIsText?: boolean;
}

export interface MarkdownLayoutGeometry {
  markdownNodes: MarkdownLayoutNode[];
  candidates: Map<string, LayoutSlotCandidate>;
}

/**
 * Fingerprint of the document-wide reference universe: reference definitions
 * live outside any single block but change what every link block renders, so
 * a block cache entry is only reusable while this fingerprint is unchanged.
 * JSON-encoded so hrefs/titles containing `#`, `|`, or `=` cannot collide.
 */
export function referenceEnvFingerprint(env: Record<string, unknown>): string {
  const references = env["references"];
  if (!references || typeof references !== "object") return "[]";
  const table = references as Record<string, { href?: unknown; title?: unknown }>;
  return JSON.stringify(Object.keys(table).sort().map((label) => {
    const entry = table[label];
    return [
      label,
      typeof entry?.href === "string" ? entry.href : "",
      typeof entry?.title === "string" ? entry.title : "",
    ];
  }));
}

/**
 * Fingerprint of a block's activity geometry. JSON-encoded so provider
 * toolCallIds containing `@` or `,` cannot collide across splits.
 */
export function activityGeometryFingerprint(
  activities: readonly LayoutActivityGeometry[],
): string {
  return JSON.stringify(activities.map((activity) => [activity.id, activity.sourceOffset]));
}

const MAX_INLINE_PARAGRAPH_CHARS = 50_000;
const MAX_INLINE_MARKERS_PER_PARAGRAPH = 256;

function renderAtomicBlock(
  block: TopLevelBlockInfo,
  env: Record<string, unknown>,
  streaming: boolean,
): { html: string; copyText: string } {
  if (preprocessMarkdownSource(block.source, { streaming }) === block.source) {
    return {
      html: renderMarkdownTokens(block.tokens, env),
      copyText: markdownTokensToPlainText(block.tokens),
    };
  }
  // A preprocessing rewrite heals display (remend/table fix) through a
  // standalone reparse, and Copy must describe the healed output — not the
  // raw pre-heal tokens. Reference definitions still resolve from the full
  // document env, never from the standalone block alone. No trimming here:
  // copyText is compositional, and the block's terminal newline separates it
  // from the next block; the single outer trim happens at the final join.
  return {
    html: renderMarkdownWithEnv(block.source, { streaming }, env),
    copyText: markdownSourceToPlainText(block.source, { streaming }, env),
  };
}

function pushMarkdownNode(
  nodes: MarkdownLayoutNode[],
  narrative: string,
  start: number,
  end: number,
  html: string,
  copyText: string,
): void {
  if (end <= start) return;
  const source = narrative.slice(start, end);
  nodes.push({
    type: "markdown",
    key: `markdown:${start}:${end}`,
    sourceRange: [start, end],
    source,
    html,
    copyText,
    isLatest: false,
  });
}
interface BlockRenderInput {
  block: TopLevelBlockInfo;
  internalActivities: readonly LayoutActivityGeometry[];
  streamingBlock: boolean;
}

/**
 * Rebuild a block's slot candidates from its cached-or-fresh disposition.
 * Runs on every frame for every block: `exact-inline` resolves to the
 * activity's current wire offset, `block-end` to the block's *current*
 * boundary. Absolute slots are never read back from the cache, so a
 * neighboring gap shrink/grow cannot resurrect a stale slot.
 */
function placeBlockActivities(
  candidates: Map<string, LayoutSlotCandidate>,
  internalActivities: readonly LayoutActivityGeometry[],
  boundary: number,
  dispositions: ReadonlyArray<{ id: string; disposition: BlockActivityDisposition }>,
): void {
  const byId = new Map(internalActivities.map((activity) => [activity.id, activity]));
  for (const { id, disposition } of dispositions) {
    if (disposition.kind === "exact-inline") {
      candidates.set(id, {
        sourceOffset: byId.get(id)!.sourceOffset,
        kind: "exact-inline",
        reason: "exact",
      });
      continue;
    }
    candidates.set(id, {
      sourceOffset: boundary,
      kind: "block-end",
      reason: disposition.reason,
    });
  }
}

/**
 * Render one top-level block in isolation: the unit of work the streaming
 * cache reuses. Pure in its inputs — same block source, same relative
 * activity geometry, same streaming flag, same reference fingerprint — so a
 * cache hit reproduces exactly what a fresh render would. The inter-block gap
 * prefix stays with the caller: it depends on cursor position, not the block.
 */
function renderLayoutBlock(
  narrative: string,
  documentEnv: Record<string, unknown>,
  input: BlockRenderInput,
): { nodes: MarkdownLayoutNode[]; activities: Array<{ id: string; disposition: BlockActivityDisposition }> } {
  const nodes: MarkdownLayoutNode[] = [];
  const activities: Array<{ id: string; disposition: BlockActivityDisposition }> = [];
  const { block, internalActivities, streamingBlock } = input;
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
    ? planInlineActivityMarkers(inlineSource, markers, documentEnv, {
      streaming: streamingBlock,
    })
    : null;

  if (markerPlan && inlineStart !== null) {
    pushMarkdownNode(nodes, narrative, block.startOffset, inlineStart, "", "");
    for (const fragment of markerPlan.fragments) {
      pushMarkdownNode(
        nodes,
        narrative,
        inlineStart + fragment.sourceRange[0],
        inlineStart + fragment.sourceRange[1],
        fragment.html,
        fragment.copyText,
      );
    }
    const inlineEnd = inlineStart + inlineSource!.length;
    pushMarkdownNode(nodes, narrative, inlineEnd, block.endOffset, "", "");
    for (const activity of internalActivities) {
      activities.push({ id: activity.id, disposition: { kind: "exact-inline" } });
    }
    return { nodes, activities };
  }
  const rendered = renderAtomicBlock(block, documentEnv, streamingBlock);
  pushMarkdownNode(
    nodes,
    narrative,
    block.startOffset,
    block.endOffset,
    rendered.html,
    rendered.copyText,
  );
  for (const activity of internalActivities) {
    activities.push({
      id: activity.id,
      disposition: {
        kind: "block-end",
        reason: inlineSource !== null && !normalized
          ? "marker-unsafe"
          : "structural-block",
      },
    });
  }
  return { nodes, activities };
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
  blockCache?: Map<string, TurnLayoutBlockCacheEntry>,
): MarkdownLayoutGeometry {
  const document = analyzeMarkdownDocument(narrative);
  const references = referenceEnvFingerprint(document.env);
  const candidates = new Map<string, LayoutSlotCandidate>();
  const markdownNodes: MarkdownLayoutNode[] = [];
  const liveBlockKeys = new Set<string>();
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
    pushMarkdownNode(markdownNodes, narrative, cursor, block.startOffset, "", "");
    const internalActivities = activitiesByBlock[blockIndex]!;
    const streamingBlock = options.streaming === true
      && options.latestVisibleIsText === true
      && block.endOffset >= lastNonWhitespaceOffset;
    // Positional key: identical text at different offsets must NOT share an
    // entry — node sourceRanges are absolute. Slot candidates are rebuilt
    // from dispositions every frame, so they never go stale. Sharing only
    // happens for the same block across frames (streaming appends).
    const cacheKey = blockCache ? `block:${block.startOffset}:${block.endOffset}` : null;
    if (cacheKey) liveBlockKeys.add(cacheKey);
    const fingerprint: TurnLayoutBlockFingerprint | null = blockCache
      ? {
        source: block.source,
        activityIds: activityGeometryFingerprint(internalActivities),
        streaming: streamingBlock,
        references,
      }
      : null;
    const cached = cacheKey && fingerprint && blockCache ? blockCache.get(cacheKey) : undefined;
    const hit = cached
      && fingerprint
      && cached.fingerprint.source === fingerprint.source
      && cached.fingerprint.activityIds === fingerprint.activityIds
      && cached.fingerprint.streaming === fingerprint.streaming
      && cached.fingerprint.references === fingerprint.references;
    if (hit) {
      // Fresh copies: callers mutate isLatest on the returned nodes.
      for (const node of cached.nodes) {
        markdownNodes.push({
          ...node,
          sourceRange: [node.sourceRange[0], node.sourceRange[1]],
        });
      }
      placeBlockActivities(candidates, internalActivities, document.boundaries[blockIndex] ?? block.endOffset, cached.activities);
      cursor = block.endOffset;
      return;
    }
    const rendered = renderLayoutBlock(narrative, document.env, {
      block,
      internalActivities,
      streamingBlock,
    });
    for (const node of rendered.nodes) markdownNodes.push(node);
    placeBlockActivities(candidates, internalActivities, document.boundaries[blockIndex] ?? block.endOffset, rendered.activities);
    if (cacheKey && fingerprint && blockCache) {
      blockCache.set(cacheKey, {
        fingerprint,
        nodes: rendered.nodes.map((node) => ({
          ...node,
          sourceRange: [node.sourceRange[0], node.sourceRange[1]] as [number, number],
        })),
        activities: rendered.activities,
      });
    }
    cursor = block.endOffset;
  });
  pushMarkdownNode(markdownNodes, narrative, cursor, narrative.length, "", "");
  if (blockCache) {
    // A growing streaming tail mints a new `block:start:end` key every frame;
    // without pruning, every historical tail length (with its full html/copy
    // strings) would accumulate for the component's lifetime. The cache may
    // only hold this frame's blocks.
    for (const key of [...blockCache.keys()]) {
      if (!liveBlockKeys.has(key)) blockCache.delete(key);
    }
  }

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
