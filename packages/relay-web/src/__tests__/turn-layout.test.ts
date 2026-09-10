import { describe, expect, it } from "vitest";
import {
  planTurnLayout,
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

describe("planTurnLayout", () => {
  it("materializes marker-aware paragraph fragments in source order", () => {
    const narrative = "Working **carefully now** done";
    const offset = "Working **carefully ".length;
    const plan = planTurnLayout(narrative, [
      { id: "tool:read-1", wireIndex: 1, sourceOffset: offset },
    ]);

    expect(plan.nodes.map((node) => node.type)).toEqual([
      "markdown",
      "activity",
      "markdown",
    ]);
    const markdown = plan.nodes.filter((node) => node.type === "markdown");
    expect(markdown.map((node) => node.source).join("")).toBe(narrative);
    expect(markdown[0]!.html).toContain("<strong>carefully </strong>");
    expect(markdown[1]!.html).toContain("<strong>now</strong> done");
    expect(plan.activityPlacements.get("tool:read-1")).toEqual({
      sourceOffset: offset,
      effectiveSlot: offset,
      slotKind: "exact-inline",
      reason: "exact",
    });
  });

  it("lifts activities out of structural Markdown blocks", () => {
    const narrative = "- one\n\n- two\n\nafter";
    const offset = "- one\n".length;
    const plan = planTurnLayout(narrative, [
      { id: "tool:read-1", wireIndex: 1, sourceOffset: offset },
    ]);
    const activityIndex = plan.nodes.findIndex((node) => node.type === "activity");
    const afterIndex = plan.nodes.findIndex((node) =>
      node.type === "markdown" && node.source.includes("after"),
    );

    expect(activityIndex).toBeGreaterThan(0);
    expect(activityIndex).toBeLessThan(afterIndex);
    expect(plan.activityPlacements.get("tool:read-1")?.reason)
      .toBe("structural-block");
  });

  it("fails a whole paragraph closed when marker injection changes semantics", () => {
    const narrative = "[docs](https://example.com)";
    const offset = "[docs](https://exa".length;
    const plan = planTurnLayout(narrative, [
      { id: "tool:read-1", wireIndex: 1, sourceOffset: offset },
    ]);

    expect(plan.nodes.map((node) => node.type)).toEqual(["markdown", "activity"]);
    expect(plan.activityPlacements.get("tool:read-1")?.reason).toBe("marker-unsafe");
  });

  it("covers narrative exactly once and emits every activity in wire order", () => {
    const narrative = "alpha **beta gamma** omega\n\n- one\n- two\n\nend";
    const layoutActivities = [
      { id: "a", wireIndex: 1, sourceOffset: "alpha **beta ".length },
      { id: "b", wireIndex: 3, sourceOffset: narrative.indexOf("- two") },
      { id: "c", wireIndex: 5, sourceOffset: narrative.length },
    ];
    const plan = planTurnLayout(narrative, layoutActivities);
    const markdown = plan.nodes.filter((node) => node.type === "markdown");
    const renderedActivities = plan.nodes.filter((node) => node.type === "activity");

    expect(markdown.map((node) => node.source).join("")).toBe(narrative);
    expect(renderedActivities.map((node) => node.activityId))
      .toEqual(layoutActivities.map((activity) => activity.id));
    for (let index = 1; index < markdown.length; index += 1) {
      expect(markdown[index - 1]!.sourceRange[1]).toBe(markdown[index]!.sourceRange[0]);
    }
    for (const activity of layoutActivities) {
      expect(plan.activityPlacements.get(activity.id)!.effectiveSlot)
        .toBeGreaterThanOrEqual(activity.sourceOffset);
    }
  });
});
