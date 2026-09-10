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
