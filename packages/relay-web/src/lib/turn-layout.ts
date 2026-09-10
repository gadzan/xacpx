import { deriveMarkdownLayout, type MarkdownLayoutOptions } from "./markdown-layout";

export type LayoutSlotKind =
  | "exact-inline"
  | "block-end"
  | "document-start"
  | "document-end";

export type ActivityPlacementReason =
  | "exact"
  | "structural-block"
  | "marker-unsafe"
  | "order-barrier";

export interface LayoutActivityGeometry {
  id: string;
  wireIndex: number;
  sourceOffset: number;
}

export interface LayoutSlotCandidate {
  sourceOffset: number;
  kind: LayoutSlotKind;
  reason: Exclude<ActivityPlacementReason, "order-barrier">;
}

export interface ActivityPlacement {
  sourceOffset: number;
  effectiveSlot: number;
  slotKind: LayoutSlotKind;
  reason: ActivityPlacementReason;
}

export interface MarkdownLayoutNode {
  type: "markdown";
  key: string;
  sourceRange: [number, number];
  source: string;
  html: string;
  /**
   * Standalone copy representation. `source` stays the canonical raw slice for
   * geometry/debug/reconstruction; this field is what the clipboard should get
   * so a fragment cut out of the middle of an inline construct never ships a
   * dangling `**`, backtick, or link destination.
   */
  copyText: string;
  isLatest: boolean;
}

export interface ActivityLayoutNode {
  type: "activity";
  key: string;
  activityId: string;
  wireIndex: number;
}

export type TurnLayoutNode = MarkdownLayoutNode | ActivityLayoutNode;

export interface TurnLayoutPlan {
  nodes: TurnLayoutNode[];
  activityPlacements: Map<string, ActivityPlacement>;
}

export interface TurnLayoutBlockFingerprint {
  source: string;
  activityIds: string;
  streaming: boolean;
  references: string;
}

export interface TurnLayoutBlockCacheEntry {
  fingerprint: TurnLayoutBlockFingerprint;
  baseStart: number;
  nodes: MarkdownLayoutNode[];
  candidates: Array<[string, LayoutSlotCandidate]>;
}

export interface TurnLayoutGeometryCache {
  key: string | null;
  plan: TurnLayoutPlan | null;
  blocks: Map<string, TurnLayoutBlockCacheEntry>;
}

export function createTurnLayoutGeometryCache(): TurnLayoutGeometryCache {
  return { key: null, plan: null, blocks: new Map() };
}

function layoutGeometryKey(
  narrative: string,
  activities: readonly LayoutActivityGeometry[],
  options: MarkdownLayoutOptions,
): string {
  return JSON.stringify([
    narrative,
    options.streaming === true,
    options.latestVisibleIsText === true,
    activities.map(({ id, wireIndex, sourceOffset }) => [id, wireIndex, sourceOffset]),
  ]);
}

/**
 * Place activities in canonical wire order. A delayed activity becomes an order
 * barrier for everything after it, so presentation order is a construction
 * invariant rather than a consequence of a later sort.
 */
export function placeActivitiesMonotonically(
  activities: readonly LayoutActivityGeometry[],
  candidateFor: (activity: LayoutActivityGeometry) => LayoutSlotCandidate,
): Map<string, ActivityPlacement> {
  const placements = new Map<string, ActivityPlacement>();
  let previousWireIndex = -1;
  let previousEffectiveSlot = 0;

  for (const activity of activities) {
    if (activity.wireIndex <= previousWireIndex) {
      throw new Error("Layout activities must be provided in strict wire order");
    }
    if (placements.has(activity.id)) {
      throw new Error(`Duplicate layout activity id: ${activity.id}`);
    }

    const candidate = candidateFor(activity);
    if (candidate.sourceOffset < activity.sourceOffset) {
      throw new Error(`Layout candidate for ${activity.id} precedes its wire offset`);
    }
    const blockedByOrder = candidate.sourceOffset < previousEffectiveSlot;
    const effectiveSlot = blockedByOrder
      ? previousEffectiveSlot
      : candidate.sourceOffset;
    placements.set(activity.id, {
      sourceOffset: activity.sourceOffset,
      effectiveSlot,
      slotKind: candidate.kind,
      reason: blockedByOrder ? "order-barrier" : candidate.reason,
    });
    previousWireIndex = activity.wireIndex;
    previousEffectiveSlot = effectiveSlot;
  }

  return placements;
}

function sliceEmptyMarkdownNode(
  node: MarkdownLayoutNode,
  start: number,
  end: number,
): MarkdownLayoutNode {
  const relativeStart = start - node.sourceRange[0];
  const relativeEnd = end - node.sourceRange[0];
  // Empty-HTML whitespace splits carry no rendered content, so slicing the raw
  // source slice is exact here; copyText only diverges on marker-aware fragments
  // which already sit on node boundaries and never enter this path with content.
  return {
    ...node,
    key: `markdown:${start}:${end}`,
    sourceRange: [start, end],
    source: node.source.slice(relativeStart, relativeEnd),
    copyText: node.copyText.slice(relativeStart, relativeEnd),
  };
}

function ensureSlotBoundaries(
  markdownNodes: readonly MarkdownLayoutNode[],
  placements: ReadonlyMap<string, ActivityPlacement>,
): MarkdownLayoutNode[] {
  const result: MarkdownLayoutNode[] = [];
  const effectiveSlots = [...placements.values()].map((placement) => placement.effectiveSlot);
  let slotIndex = 0;
  for (const node of markdownNodes) {
    const [nodeStart, nodeEnd] = node.sourceRange;
    while (effectiveSlots[slotIndex] !== undefined && effectiveSlots[slotIndex]! <= nodeStart) {
      slotIndex += 1;
    }
    let segmentStart = nodeStart;
    while (effectiveSlots[slotIndex] !== undefined && effectiveSlots[slotIndex]! < nodeEnd) {
      const slot = effectiveSlots[slotIndex]!;
      if (node.html !== "" || node.source.trim().length > 0) {
        throw new Error("A legal activity slot must coincide with a Markdown node boundary");
      }
      if (slot > segmentStart) {
        result.push(sliceEmptyMarkdownNode(node, segmentStart, slot));
        segmentStart = slot;
      }
      while (effectiveSlots[slotIndex] === slot) slotIndex += 1;
    }
    if (nodeEnd > segmentStart) {
      result.push(sliceEmptyMarkdownNode(node, segmentStart, nodeEnd));
    }
  }
  return result;
}

/** Build the render-safe turn layout from ordered activity geometry. */
export function planTurnLayout(
  narrative: string,
  activities: readonly LayoutActivityGeometry[],
  options: MarkdownLayoutOptions = {},
  cache?: TurnLayoutGeometryCache,
): TurnLayoutPlan {
  const cacheKey = cache ? layoutGeometryKey(narrative, activities, options) : null;
  if (cache && cache.key === cacheKey && cache.plan) return cache.plan;
  const markdown = deriveMarkdownLayout(narrative, activities, options, cache?.blocks);
  const activityPlacements = placeActivitiesMonotonically(
    activities,
    (activity) => markdown.candidates.get(activity.id)!,
  );
  const markdownNodes = ensureSlotBoundaries(markdown.markdownNodes, activityPlacements);
  const nodes: TurnLayoutNode[] = [];
  let activityIndex = 0;

  const pushMarkdown = (node: MarkdownLayoutNode): void => {
    const previous = nodes[nodes.length - 1];
    if (previous?.type === "markdown" && previous.sourceRange[1] === node.sourceRange[0]) {
      previous.key = `markdown:${previous.sourceRange[0]}:${node.sourceRange[1]}`;
      previous.sourceRange = [previous.sourceRange[0], node.sourceRange[1]];
      previous.source += node.source;
      previous.copyText += node.copyText;
      previous.html += node.html;
      previous.isLatest ||= node.isLatest;
      return;
    }
    nodes.push({ ...node, sourceRange: [...node.sourceRange] });
  };

  const pushActivitiesAt = (slot: number): void => {
    while (activityIndex < activities.length) {
      const activity = activities[activityIndex]!;
      const placement = activityPlacements.get(activity.id)!;
      if (placement.effectiveSlot !== slot) break;
      nodes.push({
        type: "activity",
        key: `activity:${activity.id}`,
        activityId: activity.id,
        wireIndex: activity.wireIndex,
      });
      activityIndex += 1;
    }
  };

  pushActivitiesAt(0);
  for (const markdownNode of markdownNodes) {
    const [start, end] = markdownNode.sourceRange;
    const nextActivity = activities[activityIndex];
    if (nextActivity) {
      const slot = activityPlacements.get(nextActivity.id)!.effectiveSlot;
      if (slot > start && slot < end) {
        throw new Error("Activity slot was not materialized as a Markdown boundary");
      }
    }
    pushMarkdown(markdownNode);
    pushActivitiesAt(end);
  }
  pushActivitiesAt(narrative.length);
  if (activityIndex !== activities.length) {
    throw new Error("Every layout activity must be materialized exactly once");
  }

  const plan = { nodes, activityPlacements };
  if (cache) {
    cache.key = cacheKey;
    cache.plan = plan;
  }
  return plan;
}
