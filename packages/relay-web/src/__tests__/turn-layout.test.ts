import { describe, expect, it } from "vitest";
import {
  placeActivitiesMonotonically,
  type LayoutActivityGeometry,
  type LayoutSlotCandidate,
} from "../lib/turn-layout";

const activities: LayoutActivityGeometry[] = [
  { id: "a", wireIndex: 1, sourceOffset: 10 },
  { id: "b", wireIndex: 3, sourceOffset: 20 },
  { id: "c", wireIndex: 5, sourceOffset: 30 },
];

describe("placeActivitiesMonotonically", () => {
  it("preserves wire order without sorting when an earlier activity is delayed", () => {
    const candidates = new Map<string, LayoutSlotCandidate>([
      ["a", { sourceOffset: 50, kind: "block-end", reason: "structural-block" }],
      ["b", { sourceOffset: 20, kind: "exact-inline", reason: "exact" }],
      ["c", { sourceOffset: 30, kind: "exact-inline", reason: "exact" }],
    ]);

    const placements = placeActivitiesMonotonically(
      activities,
      (activity) => candidates.get(activity.id)!,
    );

    expect([...placements]).toEqual([
      ["a", {
        sourceOffset: 10,
        effectiveSlot: 50,
        slotKind: "block-end",
        reason: "structural-block",
      }],
      ["b", {
        sourceOffset: 20,
        effectiveSlot: 50,
        slotKind: "exact-inline",
        reason: "order-barrier",
      }],
      ["c", {
        sourceOffset: 30,
        effectiveSlot: 50,
        slotKind: "exact-inline",
        reason: "order-barrier",
      }],
    ]);
  });

  it("places every activity exactly once under generated candidate sequences", () => {
    for (let sample = 0; sample < 200; sample += 1) {
      const generated = Array.from({ length: 40 }, (_, index) => ({
        id: `${sample}:${index}`,
        wireIndex: index,
        sourceOffset: index * 3,
      }));
      const placements = placeActivitiesMonotonically(generated, (activity) => ({
        sourceOffset: activity.sourceOffset + ((sample + activity.wireIndex) % 7) * 5,
        kind: "block-end",
        reason: "structural-block",
      }));

      expect([...placements.keys()]).toEqual(generated.map((activity) => activity.id));
      let previousSlot = 0;
      for (const placement of placements.values()) {
        expect(placement.effectiveSlot).toBeGreaterThanOrEqual(placement.sourceOffset);
        expect(placement.effectiveSlot).toBeGreaterThanOrEqual(previousSlot);
        previousSlot = placement.effectiveSlot;
      }
    }
  });

  it("rejects invalid callers instead of repairing their ordering", () => {
    expect(() => placeActivitiesMonotonically(
      [activities[1]!, activities[0]!],
      (activity) => ({ sourceOffset: activity.sourceOffset, kind: "exact-inline", reason: "exact" }),
    )).toThrow("strict wire order");

    expect(() => placeActivitiesMonotonically(
      activities,
      (activity) => ({ sourceOffset: activity.sourceOffset - 1, kind: "exact-inline", reason: "exact" }),
    )).toThrow("precedes its wire offset");
  });
});
