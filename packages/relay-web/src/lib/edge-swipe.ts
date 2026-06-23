/**
 * Edge-swipe drawer gestures for the mobile dashboard.
 *
 * Open: a touch that STARTS within `edgeZone` px of a screen edge and then
 * travels horizontally past `threshold` opens that side's drawer —
 *   left edge → swipe right  ⇒ open the left (instances) drawer
 *   right edge → swipe left  ⇒ open the right (tasks/files) drawer
 * Close: when a drawer is already open, a horizontal swipe back toward its own
 * edge closes it — but only when the swipe STARTS on the backdrop, not inside
 * the drawer panel itself (so a horizontal scroll within the drawer can't close
 * it out from under the user). The backdrop covers all the non-drawer area, so a
 * close swipe can start anywhere on it.
 *
 * Gated to the off-canvas (mobile) layout via `isEnabled`; on lg+ the side
 * columns are static and the gesture is a no-op. A horizontal-dominant check
 * (|dx| > |dy|) plus the minimum distance keep it from firing during vertical
 * scrolling, and multi-touch (pinch / two-finger scroll) is ignored outright.
 *
 * Note: the left-edge open gesture overlaps the iOS Safari back-swipe. In an
 * installed (standalone) PWA there is no browser back gesture, so it is clean
 * there; in a Safari browser tab the two coexist, with the system gesture
 * usually winning — acceptable, since the dashboard's primary mobile surface is
 * the installed PWA.
 */
export interface TouchPoint {
  clientX: number;
  clientY: number;
}

export interface TouchLike {
  touches?: ArrayLike<TouchPoint>;
  changedTouches?: ArrayLike<TouchPoint>;
  target?: EventTarget | null;
}

export interface EdgeSwipeOptions {
  /** Only act when the off-canvas (mobile) layout is active. */
  isEnabled: () => boolean;
  isLeftOpen: () => boolean;
  isRightOpen: () => boolean;
  openLeft: () => void;
  openRight: () => void;
  closeLeft: () => void;
  closeRight: () => void;
  /** Defaults to `window.innerWidth`. */
  viewportWidth?: () => number;
  /** Distance from a screen edge (px) within which an open gesture may start. */
  edgeZone?: number;
  /** Minimum horizontal travel (px) required to trigger. */
  threshold?: number;
}

export interface EdgeSwipeHandlers {
  onTouchStart(e: TouchLike): void;
  onTouchEnd(e: TouchLike): void;
  onTouchCancel(): void;
}

type Mode = "open-left" | "open-right" | "close-left" | "close-right" | null;

export function createEdgeSwipe(opts: EdgeSwipeOptions): EdgeSwipeHandlers {
  const edgeZone = opts.edgeZone ?? 30;
  const threshold = opts.threshold ?? 45;
  const viewportWidth = opts.viewportWidth ?? (() => window.innerWidth);

  let startX = 0;
  let startY = 0;
  let mode: Mode = null;

  // At touchstart the active touch is in `touches`; at touchend it has moved to
  // `changedTouches`. Each lookup prefers the list that holds the active point.
  function firstPoint(e: TouchLike): TouchPoint | null {
    return e.touches?.[0] ?? e.changedTouches?.[0] ?? null;
  }
  function lastPoint(e: TouchLike): TouchPoint | null {
    return e.changedTouches?.[0] ?? e.touches?.[0] ?? null;
  }

  // A close swipe is only valid from the backdrop, never from within the drawer
  // panel (where horizontal content could otherwise close the drawer).
  function startedInsideDrawer(e: TouchLike): boolean {
    const el = e.target as Element | null | undefined;
    return !!(el && typeof el.closest === "function" && el.closest("[data-drawer]"));
  }

  function onTouchStart(e: TouchLike): void {
    mode = null;
    if (!opts.isEnabled()) return;
    if ((e.touches?.length ?? 0) > 1) return; // ignore pinch / two-finger gestures
    const p = firstPoint(e);
    if (!p) return;
    startX = p.clientX;
    startY = p.clientY;
    // An already-open drawer takes priority: this gesture may close it (backdrop only).
    if (opts.isLeftOpen() || opts.isRightOpen()) {
      if (startedInsideDrawer(e)) return;
      mode = opts.isLeftOpen() ? "close-left" : "close-right";
      return;
    }
    if (startX <= edgeZone) mode = "open-left";
    else if (startX >= viewportWidth() - edgeZone) mode = "open-right";
  }

  function onTouchEnd(e: TouchLike): void {
    const m = mode;
    mode = null;
    if (!m) return;
    const p = lastPoint(e);
    if (!p) return;
    const dx = p.clientX - startX;
    const dy = p.clientY - startY;
    if (Math.abs(dx) < threshold) return; // not far enough
    if (Math.abs(dx) <= Math.abs(dy)) return; // not horizontal-dominant
    if (m === "open-left" && dx > 0) opts.openLeft();
    else if (m === "open-right" && dx < 0) opts.openRight();
    else if (m === "close-left" && dx < 0) opts.closeLeft();
    else if (m === "close-right" && dx > 0) opts.closeRight();
  }

  // The system reclassified the gesture (e.g. scroll / back-swipe took over);
  // drop the armed mode so a later unrelated touchend can't fire it.
  function onTouchCancel(): void {
    mode = null;
  }

  return { onTouchStart, onTouchEnd, onTouchCancel };
}
