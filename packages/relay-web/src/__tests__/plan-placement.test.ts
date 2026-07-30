import { describe, it, expect } from "vitest";
import {
  computePlanPlacement,
  CHAT_CONTENT_MAX,
  PLAN_SIDE_WIDTH,
  PLAN_SIDE_GAP,
  PLAN_SIDE_HYSTERESIS,
} from "../lib/plan-placement";

const BASE = CHAT_CONTENT_MAX + PLAN_SIDE_WIDTH + PLAN_SIDE_GAP; // 1088
const ENTER = BASE + PLAN_SIDE_HYSTERESIS; // 1120

describe("computePlanPlacement", () => {
  it("switches to side on wide panes", () => {
    expect(computePlanPlacement(1400, "inline")).toBe("side");
    expect(computePlanPlacement(ENTER, "inline")).toBe("side");
  });

  it("falls back to inline on narrow panes", () => {
    expect(computePlanPlacement(800, "side")).toBe("inline");
    expect(computePlanPlacement(BASE - 1, "side")).toBe("inline");
  });

  it("keeps the previous placement inside the hysteresis band", () => {
    const inBand = BASE + PLAN_SIDE_HYSTERESIS / 2; // 1104
    expect(computePlanPlacement(inBand, "side")).toBe("side");
    expect(computePlanPlacement(inBand, "inline")).toBe("inline");
    expect(computePlanPlacement(BASE, "side")).toBe("side");
    expect(computePlanPlacement(BASE, "inline")).toBe("inline");
    expect(computePlanPlacement(ENTER - 1, "inline")).toBe("inline");
  });

  it("treats unmeasured widths as inline (no ResizeObserver fallback)", () => {
    expect(computePlanPlacement(0, "side")).toBe("inline");
    expect(computePlanPlacement(-5, "side")).toBe("inline");
  });
});
