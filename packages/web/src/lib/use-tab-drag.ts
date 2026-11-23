import { ref, type Ref } from "vue";

/** Px of pointer movement before a MOUSE pointerdown on a tab commits to a drag
 *  rather than staying a click. Mirrors the `intent` threshold in
 *  `use-swipe-actions.ts`. Touch uses a hold instead (see below). */
const THRESHOLD = 4;

/** Touch only: how long the finger must stay pressed on a tab before the gesture
 *  becomes a drag-reorder. A shorter press-and-swipe is left to the browser as a
 *  native horizontal scroll of the strip — otherwise dragging and scrolling (both
 *  horizontal finger travel) are indistinguishable and the strip can never scroll.
 *  This is the standard "long-press to pick up" pattern. */
const TOUCH_HOLD_MS = 320;

/** Touch only: if the finger travels more than this before the hold fires, the
 *  gesture is a scroll, not a drag — abandon arming and let the browser scroll. */
const TOUCH_SLOP = 10;

export interface TabDragOptions {
  onReorder: (draggedId: string, targetId: string) => void;
  /** Hit-test seam: given viewport coords, return the `data-tab-id` of the tab
   *  underneath, or null. Defaults to a real DOM lookup via
   *  `document.elementFromPoint`, which jsdom can't lay out — tests inject
   *  this to control `overId` deterministically. */
  resolveId?: (x: number, y: number) => string | null;
}

export interface TabDragHandlers {
  draggingId: Ref<string | null>;
  overId: Ref<string | null>;
  /** Call from a tab's `pointerdown` handler. */
  start: (e: PointerEvent, id: string) => void;
}

function defaultResolveId(x: number, y: number): string | null {
  const el = document.elementFromPoint(x, y);
  return el?.closest("[data-tab-id]")?.getAttribute("data-tab-id") ?? null;
}

/** Vanilla Pointer Events tab drag-reorder, mirroring the attach/detach-on-document
 *  style of `use-swipe-actions.ts` / `edge-swipe.ts`.
 *
 *  Mouse/pen: `start` arms the gesture and it becomes a drag once the pointer moves
 *  past `THRESHOLD`, so a plain click never flags a drag. A mouse can't scroll by
 *  dragging, so there's nothing to disambiguate.
 *
 *  Touch: `start` arms a `TOUCH_HOLD_MS` timer instead. If the finger stays put the
 *  timer fires and the drag begins (the tab lifts as feedback); if it travels past
 *  `TOUCH_SLOP` first, we bail and let the browser scroll the strip natively. While a
 *  touch drag is active a non-passive `touchmove` `preventDefault` suppresses the
 *  native pan so the reorder isn't fighting a scroll. */
export function useTabDrag(opts: TabDragOptions): TabDragHandlers {
  const draggingId = ref<string | null>(null);
  const overId = ref<string | null>(null);
  const resolveId = opts.resolveId ?? defaultResolveId;

  let armedId: string | null = null;
  let startX = 0;
  let startY = 0;
  let isTouch = false;
  let holdTimer: ReturnType<typeof setTimeout> | null = null;

  function clearHold() {
    if (holdTimer !== null) {
      clearTimeout(holdTimer);
      holdTimer = null;
    }
  }

  function removeListeners() {
    document.removeEventListener("pointermove", pointermove);
    document.removeEventListener("pointerup", pointerup);
    document.removeEventListener("pointercancel", pointercancel);
    document.removeEventListener("touchmove", touchmoveBlockScroll);
  }

  function reset() {
    clearHold();
    armedId = null;
    isTouch = false;
    draggingId.value = null;
    overId.value = null;
    removeListeners();
  }

  // The long-press fired while the finger was still pressed: pick up the tab. overId
  // is resolved on the next move; the lift style keyed off draggingId also serves as
  // "drag armed" feedback.
  function activateHold() {
    holdTimer = null;
    if (armedId !== null) draggingId.value = armedId;
  }

  // Suppress the native horizontal pan ONLY while a touch drag is active, so pre-hold
  // swipes still scroll the strip. Must be a non-passive listener to be cancelable.
  function touchmoveBlockScroll(e: TouchEvent) {
    if (draggingId.value !== null && e.cancelable) e.preventDefault();
  }

  function pointermove(e: PointerEvent) {
    if (armedId === null) return;
    if (draggingId.value === null) {
      const dx = e.clientX - startX;
      const dy = e.clientY - startY;
      if (isTouch) {
        // Hold hasn't fired yet (it would have set draggingId). Movement past the
        // slop means the user is scrolling, not picking up a tab — bail so the
        // browser's native scroll (still permitted by `touch-action: pan-x`) runs.
        if (Math.hypot(dx, dy) > TOUCH_SLOP) reset();
        return;
      }
      if (Math.abs(dx) < THRESHOLD) return;
      draggingId.value = armedId;
    }
    overId.value = resolveId(e.clientX, e.clientY);
  }

  function pointerup() {
    const dragged = draggingId.value;
    const over = overId.value;
    if (dragged && over && over !== dragged) {
      opts.onReorder(dragged, over);
    }
    reset();
  }

  function pointercancel() {
    reset();
  }

  function start(e: PointerEvent, id: string) {
    // Defensive: drop any listeners/timer from a prior gesture that never reached
    // pointerup/pointercancel (e.g. a second pointerdown mid-drag) before re-adding,
    // so nothing accumulates across gestures.
    clearHold();
    removeListeners();
    armedId = id;
    startX = e.clientX;
    startY = e.clientY;
    isTouch = e.pointerType === "touch";
    draggingId.value = null;
    overId.value = null;
    document.addEventListener("pointermove", pointermove);
    document.addEventListener("pointerup", pointerup);
    document.addEventListener("pointercancel", pointercancel);
    if (isTouch) {
      document.addEventListener("touchmove", touchmoveBlockScroll, { passive: false });
      holdTimer = setTimeout(activateHold, TOUCH_HOLD_MS);
    }
  }

  return { draggingId, overId, start };
}
