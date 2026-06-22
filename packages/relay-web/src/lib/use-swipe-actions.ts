export interface SwipeActionsOptions {
  /** Live horizontal delta (px) during a horizontal drag. Negative = leftward.
   *  Fires on every pointermove once the gesture is decided horizontal, so the
   *  consumer can translate the row 1:1 with the finger ("跟手"). */
  onMove?: (dx: number) => void;
  /** Fires exactly once when the gesture ends (pointerup / cancel / yielded to
   *  vertical scroll), with the final horizontal delta (0 if it never went
   *  horizontal). The consumer decides whether to snap open or closed. */
  onEnd?: (dx: number) => void;
  /** Px of movement before the gesture commits to an axis (default 4). Below this
   *  a tap stays a tap and never starts a drag. */
  intent?: number;
}

/** Interactive horizontal-swipe detector for a list row. Reports a live delta so
 *  the row can follow the finger, and yields to the scroll container the moment a
 *  gesture is vertical-dominant. Emits exactly one `onEnd` per gesture, always. */
export function useSwipeActions(opts: SwipeActionsOptions) {
  const intent = opts.intent ?? 4;
  let startX = 0, startY = 0;
  let dragging = false, decided = false, horizontal = false;

  // Keys MUST be bare DOM event names (`pointerdown`, not `onPointerdown`): the row
  // binds these via `v-on="handlers"`, and Vue's object-`v-on` re-applies the `on`
  // prefix itself. An `onPointerdown` key would be re-prefixed to a dead event and
  // the swipe would silently never fire.
  function pointerdown(e: { clientX: number; clientY: number }) {
    startX = e.clientX; startY = e.clientY;
    dragging = true; decided = false; horizontal = false;
  }
  function pointermove(e: { clientX: number; clientY: number }) {
    if (!dragging) return;
    const dx = e.clientX - startX, dy = e.clientY - startY;
    if (!decided) {
      if (Math.abs(dx) < intent && Math.abs(dy) < intent) return; // still a tap
      decided = true;
      horizontal = Math.abs(dx) > Math.abs(dy);
    }
    if (!horizontal) {
      // Vertical-dominant → yield to the scroll container and end the gesture.
      dragging = false;
      opts.onEnd?.(0);
      return;
    }
    opts.onMove?.(dx);
  }
  function pointerup(e: { clientX: number; clientY: number }) {
    if (!dragging) return;
    dragging = false;
    opts.onEnd?.(horizontal ? e.clientX - startX : 0);
  }
  // The browser fires `pointercancel` (and no `pointerup`) when it reclassifies the
  // drag as a scroll/gesture. End cleanly so a row is never left mid-drag.
  function pointercancel() {
    if (!dragging) return;
    dragging = false;
    opts.onEnd?.(0);
  }

  return { handlers: { pointerdown, pointermove, pointerup, pointercancel } };
}
