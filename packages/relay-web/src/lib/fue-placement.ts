/** Pure placement math for `FueCallout` (borrowed from HAPI's
 *  `computeFueCalloutPlacement`). Kept DOM-free so it is unit-testable without a
 *  layout engine. Places the callout on the preferred side of the anchor (below by
 *  default); flips to the opposite side when the preferred one would overflow the
 *  viewport and the opposite side has more room; clamps the horizontal position
 *  into the viewport with an 8px margin. Also used by `Tooltip`. */
export interface Rect {
  top: number;
  left: number;
  width: number;
  height: number;
}

export interface Size {
  width: number;
  height: number;
}

export interface Viewport {
  width: number;
  height: number;
}

export interface Placement {
  top: number;
  left: number;
  placement: "above" | "below";
}

const MARGIN = 8;

export function computeCalloutPlacement(
  anchor: Rect,
  callout: Size,
  viewport: Viewport,
  gap = MARGIN,
  prefer: "above" | "below" = "below",
): Placement {
  const belowTop = anchor.top + anchor.height + gap;
  const aboveTop = anchor.top - callout.height - gap;
  const roomBelow = viewport.height - (anchor.top + anchor.height);
  const roomAbove = anchor.top;

  // Flip to the opposite side only when the preferred side overflows AND the
  // opposite side has more room.
  const flip = prefer === "below"
    ? belowTop + callout.height > viewport.height - MARGIN && roomAbove > roomBelow
    : aboveTop < MARGIN && roomBelow > roomAbove;
  const placement: "above" | "below" = flip ? (prefer === "below" ? "above" : "below") : prefer;
  const top = placement === "above" ? Math.max(MARGIN, aboveTop) : belowTop;

  // Center under the anchor, then clamp horizontally into the viewport.
  const centered = anchor.left + anchor.width / 2 - callout.width / 2;
  const maxLeft = Math.max(MARGIN, viewport.width - callout.width - MARGIN);
  const left = Math.min(Math.max(MARGIN, centered), maxLeft);

  return { top, left, placement };
}
