/**
 * Drag-to-resize for a static dashboard side column (desktop only).
 *
 * The right panel is resized by dragging its LEFT edge: moving the pointer left
 * widens the panel, moving it right narrows it (mirror logic for a left panel,
 * which is dragged by its right edge). Width is clamped to [min, max] and
 * optionally to a fraction of the viewport so the panel can never crowd out the
 * center column on a narrow desktop window.
 *
 * Gated to the static (desktop) layout via `isEnabled` — on the off-canvas
 * (mobile) layout the side columns are full-height drawers with a fixed width,
 * so dragging is a no-op and the handle is hidden. Pointer move/up listeners are
 * attached to `target` (default `window`) only for the duration of a drag, so a
 * drag that leaves the thin handle still tracks, and they are removed on release.
 */
export interface PointerLike {
  clientX: number;
}

interface EventTargetLike {
  addEventListener(type: string, listener: (e: any) => void): void;
  removeEventListener(type: string, listener: (e: any) => void): void;
}

export interface PanelResizeOptions {
  /** Which edge is dragged: a "right" panel is dragged by its left edge. */
  side: "left" | "right";
  getWidth: () => number;
  setWidth: (w: number) => void;
  /** Hard lower bound (px). */
  min: number;
  /** Hard upper bound (px). */
  max: number;
  /** Optional extra cap as a fraction of viewport width (e.g. 0.5). */
  maxViewportFraction?: number;
  /** Defaults to `window.innerWidth`. */
  viewportWidth?: () => number;
  /** Only act when the static (desktop) layout is active. */
  isEnabled: () => boolean;
  onDragStart?: () => void;
  onDragEnd?: () => void;
  /** Event target for move/up listeners; defaults to `window`. */
  target?: EventTargetLike;
}

export interface PanelResizeController {
  onPointerDown(e: PointerLike): void;
}

/**
 * Clamp a raw desired width to [min, hi], where hi is `max` further capped to
 * `floor(viewportWidth * fraction)` when a fraction is given. Rounds to whole
 * pixels. `min` always wins if the viewport cap would drop below it.
 */
export function clampPanelWidth(
  raw: number,
  min: number,
  max: number,
  viewportWidth?: number,
  fraction?: number,
): number {
  let hi = max;
  if (fraction != null && viewportWidth != null) {
    hi = Math.min(hi, Math.floor(viewportWidth * fraction));
  }
  if (hi < min) hi = min;
  if (raw < min) return min;
  if (raw > hi) return hi;
  return Math.round(raw);
}

export function createPanelResize(opts: PanelResizeOptions): PanelResizeController {
  const viewportWidth = opts.viewportWidth ?? (() => window.innerWidth);
  const target: EventTargetLike = opts.target ?? (window as unknown as EventTargetLike);

  let startX = 0;
  let startWidth = 0;
  let dragging = false;

  function applyWidth(clientX: number): void {
    // Right panel: dragging left (smaller clientX) widens it. Left panel: the
    // mirror — dragging right (larger clientX) widens it.
    const delta = opts.side === "right" ? startX - clientX : clientX - startX;
    const next = clampPanelWidth(
      startWidth + delta,
      opts.min,
      opts.max,
      viewportWidth(),
      opts.maxViewportFraction,
    );
    opts.setWidth(next);
  }

  function onMove(e: PointerLike): void {
    if (dragging) applyWidth(e.clientX);
  }

  // Idempotent end-of-drag: detaches every listener and restores global state.
  // Bound to pointerup AND pointercancel — if the OS/browser steals the pointer
  // (context menu, touch interruption) only pointercancel fires, and without this
  // the window listeners would leak and document cursor/user-select stay stuck.
  function onUp(): void {
    if (!dragging) return;
    dragging = false;
    target.removeEventListener("pointermove", onMove);
    target.removeEventListener("pointerup", onUp);
    target.removeEventListener("pointercancel", onUp);
    opts.onDragEnd?.();
  }

  function onPointerDown(e: PointerLike): void {
    if (!opts.isEnabled()) return;
    dragging = true;
    startX = e.clientX;
    startWidth = opts.getWidth();
    target.addEventListener("pointermove", onMove);
    target.addEventListener("pointerup", onUp);
    target.addEventListener("pointercancel", onUp);
    opts.onDragStart?.();
  }

  return { onPointerDown };
}
