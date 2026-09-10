import { bench, describe } from "vitest";
import { planTurnLayout, type LayoutActivityGeometry } from "../lib/turn-layout";

function trace(paragraphs: number): {
  narrative: string;
  activities: LayoutActivityGeometry[];
} {
  const chunks: string[] = [];
  const activities: LayoutActivityGeometry[] = [];
  let sourceOffset = 0;
  for (let index = 0; index < paragraphs; index += 1) {
    const prefix = `progress ${index} **before `;
    const suffix = "after**\n\n";
    chunks.push(prefix, suffix);
    sourceOffset += prefix.length;
    activities.push({ id: `tool:${index}`, wireIndex: index, sourceOffset });
    sourceOffset += suffix.length;
  }
  return { narrative: chunks.join(""), activities };
}

describe("turn layout", () => {
  const medium = trace(100);
  const long = trace(500);

  bench("100 marker-bearing paragraphs", () => {
    planTurnLayout(medium.narrative, medium.activities);
  });

  bench("500 marker-bearing paragraphs", () => {
    planTurnLayout(long.narrative, long.activities);
  });

  bench("one dense paragraph with 256 markers", () => {
    const words = Array.from({ length: 257 }, (_, index) => `word${index}`);
    const narrative = `${words.join(" ")} end`;
    let sourceOffset = 0;
    const activities: LayoutActivityGeometry[] = [];
    for (let index = 0; index < 256; index += 1) {
      sourceOffset += words[index]!.length + 1;
      activities.push({ id: `tool:${index}`, wireIndex: index, sourceOffset });
    }
    planTurnLayout(narrative, activities);
  });
});
