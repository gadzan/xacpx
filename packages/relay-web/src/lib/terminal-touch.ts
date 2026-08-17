// Terminal touch scroll - a small explicit state machine so terminal dragging
// and native long-press behavior (text selection, context menu) coexist.
//
//   idle -> pending (touchstart)   no preventDefault: a stationary touch is
//                                  left to the browser for long-press
//   pending -> scrolling (>=8px)   preventDefault + capture: the drag scrolls
//                                  the terminal viewport by whole lines
//   touchend/pointercancel         back to idle
//
// Sub-threshold moves never preventDefault, so long-press selection stays
// native. Scrolling converts pixel deltas to lines using the RENDERED cell
// height — never host.clientHeight / rows: the on-screen keyboard shrinks the
// host without shrinking the grid, so the host-derived ratio under-reports the
// real cell height the more the keyboard occludes.

/** Drag distance before a touch becomes a terminal scroll. */
const TOUCH_SCROLL_THRESHOLD_PX = 8;

export interface TerminalTouchScrollOptions {
  host: HTMLElement;
  /** Rendered canvas cell height in px; null until the canvas is measurable. */
  lineHeight(): number | null;
  scrollLines(amount: number): void;
}

type TouchState =
  | { kind: "idle" }
  | { kind: "pending"; startX: number; startY: number; lastY: number; residual: number }
  | { kind: "scrolling"; lastY: number; residual: number };

/** Binds touch scroll listeners on the host (capture phase). Returns dispose. */
export function bindTerminalTouchScroll(opts: TerminalTouchScrollOptions): () => void {
  const { host, lineHeight, scrollLines } = opts;
  let state: TouchState = { kind: "idle" };

  function onTouchStart(e: TouchEvent) {
    if (e.touches.length !== 1) {
      state = { kind: "idle" };
      return;
    }
    const t = e.touches[0];
    state = { kind: "pending", startX: t.clientX, startY: t.clientY, lastY: t.clientY, residual: 0 };
  }

  function onTouchMove(e: TouchEvent) {
    if (e.touches.length !== 1) return;
    const t = e.touches[0];
    if (state.kind === "pending") {
      // Below threshold the browser still owns the gesture (long-press
      // selection); never preventDefault in the pending phase.
      if (Math.hypot(t.clientX - state.startX, t.clientY - state.startY) < TOUCH_SCROLL_THRESHOLD_PX) return;
      state = { kind: "scrolling", lastY: state.lastY, residual: state.residual };
    }
    if (state.kind !== "scrolling") return;
    e.preventDefault();
    e.stopPropagation();
    const lineH = lineHeight();
    if (!lineH || !(lineH > 0)) return;
    state.residual += t.clientY - state.lastY;
    state.lastY = t.clientY;
    const lines = Math.trunc(state.residual / lineH);
    if (lines !== 0) {
      scrollLines(-lines);
      state.residual -= lines * lineH;
    }
  }

  function onTouchEnd(e: TouchEvent) {
    if (state.kind === "scrolling") {
      e.preventDefault();
      e.stopPropagation();
    }
    state = { kind: "idle" };
  }

  host.addEventListener("touchstart", onTouchStart, { capture: true, passive: true });
  host.addEventListener("touchmove", onTouchMove, { capture: true, passive: false });
  host.addEventListener("touchend", onTouchEnd, { capture: true });
  host.addEventListener("touchcancel", onTouchEnd, { capture: true });
  return () => {
    host.removeEventListener("touchstart", onTouchStart, { capture: true });
    host.removeEventListener("touchmove", onTouchMove, { capture: true });
    host.removeEventListener("touchend", onTouchEnd, { capture: true });
    host.removeEventListener("touchcancel", onTouchEnd, { capture: true });
    state = { kind: "idle" };
  };
}
