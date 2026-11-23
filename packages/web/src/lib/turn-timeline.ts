import type { TurnPartDto } from "@ganglion/xacpx-relay-protocol";

export type TimelineActivityPart = Exclude<TurnPartDto, { type: "text" }>;

export interface TimelineActivity {
  id: string;
  wireIndex: number;
  sourceOffset: number;
  kind: TimelineActivityPart["type"];
  payload: TimelineActivityPart;
}

export interface TurnTimeline {
  narrative: string;
  activities: TimelineActivity[];
}

function activityId(part: TimelineActivityPart, wireIndex: number): string {
  return part.type === "tool"
    ? `tool:${part.step.toolCallId}:${wireIndex}`
    : `reasoning:${wireIndex}`;
}

/** Build the canonical turn timeline without interpreting Markdown or changing wire order. */
export function buildTurnTimeline(parts: TurnPartDto[]): TurnTimeline {
  const narrativeChunks: string[] = [];
  const activities: TimelineActivity[] = [];
  let sourceOffset = 0;

  parts.forEach((part, wireIndex) => {
    if (part.type === "text") {
      narrativeChunks.push(part.text);
      sourceOffset += part.text.length;
      return;
    }
    activities.push({
      id: activityId(part, wireIndex),
      wireIndex,
      sourceOffset,
      kind: part.type,
      payload: part,
    });
  });

  return {
    narrative: narrativeChunks.join(""),
    activities,
  };
}
