import type { PanZoom } from "./pan-zoom";

export interface GestureOptions {
  /** Zoom on wheel only when Ctrl/⌘ is held (inline). Default false. */
  wheelRequiresModifier?: boolean;
  /** Pan on a single touch (fullscreen). Default false — one finger scrolls the page. */
  oneFingerTouchPan?: boolean;
}

interface Pointish {
  clientX: number;
  clientY: number;
}

/**
 * Attach wheel/pointer/touch pan-zoom gestures on `el`, driving `panZoom` and calling `onChange` after
 * every state change. Mouse drag always pans; touch panning is one-finger only when opted in;
 * wheel zoom can require a modifier. Returns a detach function that removes every listener.
 */
export function attachPanZoomGestures(
  el: HTMLElement,
  panZoom: PanZoom,
  onChange: () => void,
  opts: GestureOptions = {},
): () => void {
  const wheelRequiresModifier = opts.wheelRequiresModifier ?? false;
  const oneFingerTouchPan = opts.oneFingerTouchPan ?? false;

  function origin(): { left: number; top: number } {
    const r = el.getBoundingClientRect();
    return { left: r.left, top: r.top };
  }
  function pinchDistance(a: Pointish, b: Pointish): number {
    return Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
  }

  function onWheel(e: WheelEvent): void {
    if (wheelRequiresModifier && !e.ctrlKey && !e.metaKey) return; // let the page scroll
    e.preventDefault();
    const { left, top } = origin();
    panZoom.zoomAt(e.deltaY < 0 ? 1.1 : 1 / 1.1, e.clientX - left, e.clientY - top);
    onChange();
  }

  let dragging = false;
  let dragId: number | null = null;
  let lastX = 0;
  let lastY = 0;
  function onPointerDown(e: PointerEvent): void {
    if (e.pointerType !== "mouse") return; // touch handled below
    dragging = true;
    dragId = e.pointerId;
    lastX = e.clientX;
    lastY = e.clientY;
    try {
      el.setPointerCapture?.(e.pointerId);
    } catch {
      /* jsdom / unsupported */
    }
  }
  function onPointerMove(e: PointerEvent): void {
    if (!dragging || e.pointerId !== dragId) return;
    panZoom.panBy(e.clientX - lastX, e.clientY - lastY);
    lastX = e.clientX;
    lastY = e.clientY;
    onChange();
  }
  function onPointerUp(e: PointerEvent): void {
    if (e.pointerId === dragId) {
      dragging = false;
      dragId = null;
    }
  }

  let pinching = false;
  let prevDist = 0;
  let touchPanning = false;
  let touchX = 0;
  let touchY = 0;
  function onTouchStart(e: TouchEvent): void {
    if (e.touches.length === 2) {
      pinching = true;
      touchPanning = false;
      prevDist = pinchDistance(e.touches[0]!, e.touches[1]!);
    } else if (e.touches.length === 1 && oneFingerTouchPan) {
      touchPanning = true;
      touchX = e.touches[0]!.clientX;
      touchY = e.touches[0]!.clientY;
    }
  }
  function onTouchMove(e: TouchEvent): void {
    if (pinching && e.touches.length === 2) {
      e.preventDefault();
      const { left, top } = origin();
      const dist = pinchDistance(e.touches[0]!, e.touches[1]!);
      if (prevDist > 0) {
        const midX = (e.touches[0]!.clientX + e.touches[1]!.clientX) / 2 - left;
        const midY = (e.touches[0]!.clientY + e.touches[1]!.clientY) / 2 - top;
        panZoom.zoomAt(dist / prevDist, midX, midY);
        onChange();
      }
      prevDist = dist;
    } else if (touchPanning && e.touches.length === 1) {
      e.preventDefault();
      panZoom.panBy(e.touches[0]!.clientX - touchX, e.touches[0]!.clientY - touchY);
      touchX = e.touches[0]!.clientX;
      touchY = e.touches[0]!.clientY;
      onChange();
    }
  }
  function onTouchEnd(e: TouchEvent): void {
    if (e.touches.length < 2) {
      pinching = false;
      prevDist = 0;
    }
    if (e.touches.length === 0) {
      touchPanning = false;
    }
  }

  el.addEventListener("wheel", onWheel, { passive: false });
  el.addEventListener("pointerdown", onPointerDown);
  el.addEventListener("pointermove", onPointerMove);
  el.addEventListener("pointerup", onPointerUp);
  el.addEventListener("pointercancel", onPointerUp);
  el.addEventListener("touchstart", onTouchStart, { passive: false });
  el.addEventListener("touchmove", onTouchMove, { passive: false });
  el.addEventListener("touchend", onTouchEnd);

  return () => {
    el.removeEventListener("wheel", onWheel);
    el.removeEventListener("pointerdown", onPointerDown);
    el.removeEventListener("pointermove", onPointerMove);
    el.removeEventListener("pointerup", onPointerUp);
    el.removeEventListener("pointercancel", onPointerUp);
    el.removeEventListener("touchstart", onTouchStart);
    el.removeEventListener("touchmove", onTouchMove);
    el.removeEventListener("touchend", onTouchEnd);
  };
}
