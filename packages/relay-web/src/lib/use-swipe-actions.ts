import { ref } from "vue";

export interface SwipeActionsOptions {
  onSwipeLeft: () => void;
  onSwipeRight: () => void;
  threshold?: number; // px of horizontal travel required to fire
}

/** Minimal horizontal-swipe detector for a list row. Tracks pointer travel and fires
 *  left/right past the threshold, ignoring vertical-dominant gestures so it doesn't
 *  fight the scroll container. `offset` is exposed for an optional reveal animation. */
export function useSwipeActions(opts: SwipeActionsOptions) {
  const threshold = opts.threshold ?? 64;
  const offset = ref(0);
  let startX = 0, startY = 0, active = false;

  // Keys MUST be bare DOM event names (`pointerdown`, not `onPointerdown`): the row
  // binds these via `v-on="handlers"`, and Vue's object-`v-on` re-applies the `on`
  // prefix itself. An `onPointerdown` key would be re-prefixed to a dead event and
  // the swipe would silently never fire.
  function pointerdown(e: { clientX: number; clientY: number }) {
    active = true; startX = e.clientX; startY = e.clientY; offset.value = 0;
  }
  function pointermove(e: { clientX: number; clientY: number }) {
    if (!active) return;
    const dx = e.clientX - startX, dy = e.clientY - startY;
    if (Math.abs(dy) > Math.abs(dx)) { active = false; offset.value = 0; return; }
    offset.value = dx;
  }
  function pointerup(e: { clientX: number; clientY: number }) {
    if (!active) return;
    active = false;
    const dx = e.clientX - startX, dy = e.clientY - startY;
    offset.value = 0;
    if (Math.abs(dy) > Math.abs(dx)) return;
    if (dx <= -threshold) opts.onSwipeLeft();
    else if (dx >= threshold) opts.onSwipeRight();
  }
  // The browser fires `pointercancel` (and no `pointerup`) when it reclassifies the
  // drag as a scroll/gesture. Reset so a cancelled gesture never fires an action and
  // never leaves a stale `offset` hanging.
  function pointercancel() {
    active = false; offset.value = 0;
  }

  return { offset, handlers: { pointerdown, pointermove, pointerup, pointercancel } };
}
