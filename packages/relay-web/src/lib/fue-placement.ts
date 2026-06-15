/** Pure placement math for `FueCallout` (borrowed from HAPI's
 *  `computeFueCalloutPlacement`). Kept DOM-free so it is unit-testable without a
 *  layout engine. Places the callout below the anchor by default; flips above when
 *  below would overflow the viewport and there is more room above; clamps the
 *  horizontal position into the viewport with an 8px margin. */
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

export function computeCalloutPlacement(anchor: Rect, callout: Size, viewport: Viewport, gap = MARGIN): Placement {
  const belowTop = anchor.top + anchor.height + gap;
  const aboveTop = anchor.top - callout.height - gap;
  const roomBelow = viewport.height - (anchor.top + anchor.height);
  const roomAbove = anchor.top;

  // Flip above only when below overflows AND above has more room.
  const overflowsBelow = belowTop + callout.height > viewport.height - MARGIN;
  const flip = overflowsBelow && roomAbove > roomBelow;
  const placement: "above" | "below" = flip ? "above" : "below";
  const top = placement === "above" ? Math.max(MARGIN, aboveTop) : belowTop;

  // Center under the anchor, then clamp horizontally into the viewport.
  const centered = anchor.left + anchor.width / 2 - callout.width / 2;
  const maxLeft = Math.max(MARGIN, viewport.width - callout.width - MARGIN);
  const left = Math.min(Math.max(MARGIN, centered), maxLeft);

  return { top, left, placement };
}
