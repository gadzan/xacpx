// Wide-screen placement for the plan panel (issue #231): when the chat pane is wide
// enough, the panel moves from the composer area to a fixed-width column right of the
// message list. These constants mirror Tailwind classes in the templates — change one,
// change the other:
//   CHAT_CONTENT_MAX  = max-w-3xl on MessageList's content wrapper
//   PLAN_SIDE_WIDTH   = w-72 on ChatPane's side column
export const CHAT_CONTENT_MAX = 768;
export const PLAN_SIDE_WIDTH = 288;
export const PLAN_SIDE_GAP = 32;
// Entering "side" requires more width than staying in it, so scrollbar appearance
// (~15px) or window dragging near the boundary can't flip the layout back and forth.
export const PLAN_SIDE_HYSTERESIS = 32;

export type PlanPlacement = "inline" | "side";

const BASE = CHAT_CONTENT_MAX + PLAN_SIDE_WIDTH + PLAN_SIDE_GAP;

// width <= 0 means "unmeasured" (no ResizeObserver, e.g. jsdom) → always inline.
export function computePlanPlacement(width: number, prev: PlanPlacement): PlanPlacement {
  if (width <= 0) return "inline";
  if (width >= BASE + PLAN_SIDE_HYSTERESIS) return "side";
  if (width < BASE) return "inline";
  return prev;
}
