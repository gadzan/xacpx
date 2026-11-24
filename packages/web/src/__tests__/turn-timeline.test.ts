import { describe, expect, it } from "vitest";
import type { ToolStepDto, TurnPartDto } from "@ganglion/xacpx-relay-protocol";
import { buildTurnTimeline } from "../lib/turn-timeline";

const tool = (id: string, status: ToolStepDto["status"] = "running"): ToolStepDto => ({
  toolCallId: id,
  toolName: "Read",
  kind: "read",
  status,
  title: `${id}.ts`,
});

describe("buildTurnTimeline", () => {
  it("preserves narrative text and activity wire positions without Markdown knowledge", () => {
    const timeline = buildTurnTimeline([
      { type: "text", text: "Checking " },
      { type: "tool", step: tool("read-1") },
      { type: "text", text: "**config" },
      { type: "reasoning", text: "compare defaults" },
      { type: "tool", step: tool("read-2") },
      { type: "text", text: "** now" },
    ]);

    expect(timeline.narrative).toBe("Checking **config** now");
    expect(timeline.activities.map(({ kind, wireIndex, sourceOffset }) => ({
      kind,
      wireIndex,
      sourceOffset,
    }))).toEqual([
      { kind: "tool", wireIndex: 1, sourceOffset: 9 },
      { kind: "reasoning", wireIndex: 3, sourceOffset: 17 },
      { kind: "tool", wireIndex: 4, sourceOffset: 17 },
    ]);
  });

  it("keeps geometry identity stable when only a tool payload changes", () => {
    const before = buildTurnTimeline([
      { type: "text", text: "Checking" },
      { type: "tool", step: tool("read-1", "running") },
    ]);
    const after = buildTurnTimeline([
      { type: "text", text: "Checking" },
      { type: "tool", step: tool("read-1", "success") },
    ]);

    const geometry = (timeline: ReturnType<typeof buildTurnTimeline>) => ({
      narrative: timeline.narrative,
      activities: timeline.activities.map(({ id, wireIndex, sourceOffset }) => ({
        id,
        wireIndex,
        sourceOffset,
      })),
    });
    expect(geometry(after)).toEqual(geometry(before));
    expect(after.activities[0]!.payload).not.toEqual(before.activities[0]!.payload);
  });

  it("maintains offset and identity invariants for arbitrary wire sequences", () => {
    let seed = 0x337;
    const random = (): number => {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      return seed;
    };

    for (let sample = 0; sample < 200; sample += 1) {
      const parts: TurnPartDto[] = [];
      const length = 1 + (random() % 30);
      for (let index = 0; index < length; index += 1) {
        const choice = random() % 3;
        if (choice === 0) parts.push({ type: "text", text: `t${random() % 100}` });
        else if (choice === 1) parts.push({ type: "reasoning", text: `r${index}` });
        else parts.push({ type: "tool", step: tool(`tool-${sample}-${index}`) });
      }

      const timeline = buildTurnTimeline(parts);
      const expectedNarrative = parts
        .filter((part): part is Extract<TurnPartDto, { type: "text" }> => part.type === "text")
        .map((part) => part.text)
        .join("");
      expect(timeline.narrative).toBe(expectedNarrative);
      expect(new Set(timeline.activities.map((activity) => activity.id)).size)
        .toBe(timeline.activities.length);

      let previousWireIndex = -1;
      let previousOffset = 0;
      for (const activity of timeline.activities) {
        expect(activity.wireIndex).toBeGreaterThan(previousWireIndex);
        expect(activity.sourceOffset).toBeGreaterThanOrEqual(previousOffset);
        expect(activity.sourceOffset).toBeLessThanOrEqual(timeline.narrative.length);
        previousWireIndex = activity.wireIndex;
        previousOffset = activity.sourceOffset;
      }
    }
  });
});
