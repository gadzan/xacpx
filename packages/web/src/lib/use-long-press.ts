import { getCurrentScope, onScopeDispose } from "vue";

/** Touch long-press → callback, for surfaces whose primary "more actions" gesture on
 *  desktop is right-click (which touch devices lack). Mouse/pen are ignored here — they
 *  use the native contextmenu event. Mirrors the attach/detach-on-document style of
 *  `use-tab-drag.ts`: a hold timer arms on pointerdown and fires only if the finger
 *  stays roughly still; any movement past `slop` (i.e. a scroll) cancels it. */

const HOLD_MS = 450;
const SLOP = 10;

export interface LongPressOptions {
  holdMs?: number;
  slop?: number;
}

export interface LongPressHandlers {
  /** Call from a target's `pointerdown` handler. */
  start: (e: PointerEvent) => void;
}

export function useLongPress(
  onLongPress: (x: number, y: number) => void,
  opts: LongPressOptions = {},
): LongPressHandlers {
  const holdMs = opts.holdMs ?? HOLD_MS;
  const slop = opts.slop ?? SLOP;

  let timer: ReturnType<typeof setTimeout> | null = null;
  let swallowCleanup: ReturnType<typeof setTimeout> | null = null;
  let fired = false;
  let startX = 0;
  let startY = 0;

  function removeDocListeners() {
    document.removeEventListener("pointermove", onMove);
    document.removeEventListener("pointerup", onUp);
    document.removeEventListener("pointercancel", onCancel);
  }

  // The browser synthesizes a `click` when the finger lifts after the press. Swallow
  // exactly that one (capture phase) so the long-press doesn't ALSO activate the row or
  // immediately close the menu it just opened. Armed AT lift (not from `fire()`), so the
  // window is right before the click regardless of how long the finger stayed down.
  // Self-removes on the first click, with a short timeout backstop if none arrives.
  function armClickSwallow() {
    document.addEventListener("click", swallowClick, true);
    swallowCleanup = setTimeout(disarmClickSwallow, 500);
  }
  function disarmClickSwallow() {
    document.removeEventListener("click", swallowClick, true);
    if (swallowCleanup !== null) {
      clearTimeout(swallowCleanup);
      swallowCleanup = null;
    }
  }
  function swallowClick(e: MouseEvent) {
    e.stopPropagation();
    e.preventDefault();
    disarmClickSwallow();
  }

  function reset() {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
    fired = false;
    removeDocListeners();
  }

  function fire() {
    timer = null;
    fired = true;
    document.removeEventListener("pointermove", onMove); // movement no longer matters
    onLongPress(startX, startY);
  }

  function onMove(e: PointerEvent) {
    // Movement past the slop means the finger is scrolling, not pressing — bail so the
    // native scroll runs and no menu opens.
    if (Math.hypot(e.clientX - startX, e.clientY - startY) > slop) reset();
  }
  function onUp() {
    // Lift after a fired long-press: swallow the immediately-following synthesized click.
    if (fired) armClickSwallow();
    reset();
  }
  function onCancel() {
    // The system reclaimed the gesture (e.g. a pan took over) — no click follows, so
    // don't arm the swallow.
    reset();
  }

  function start(e: PointerEvent) {
    if (e.pointerType !== "touch") return; // mouse/pen use the contextmenu (right-click) event
    reset();
    startX = e.clientX;
    startY = e.clientY;
    document.addEventListener("pointermove", onMove);
    document.addEventListener("pointerup", onUp);
    document.addEventListener("pointercancel", onCancel);
    timer = setTimeout(fire, holdMs);
  }

  // Clean up if the host component unmounts mid-gesture (e.g. the tree row is removed
  // while its hold timer is pending), so a stray timer can't fire against a gone row.
  if (getCurrentScope()) onScopeDispose(reset);

  return { start };
}
