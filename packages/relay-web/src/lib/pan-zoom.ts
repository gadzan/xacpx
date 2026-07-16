// Pure, framework-free pan/zoom transform state. The consumer applies `toTransform()` to an
// element with `transform-origin: 0 0`. Kept DOM-free so the geometry is unit-testable.

// Shared step factors for the − / + zoom buttons, so the inline enhancer and the fullscreen
// viewer step by the same amount (and can't drift). One click out then in returns to ~1×.
export const ZOOM_IN_FACTOR = 1.25;
export const ZOOM_OUT_FACTOR = 0.8;

export interface PanZoomState {
  scale: number;
  x: number;
  y: number;
}

export interface PanZoom {
  readonly state: PanZoomState;
  /** Multiply scale by `factor`, keeping viewport point (cx, cy) stationary. Clamps scale. */
  zoomAt(factor: number, cx: number, cy: number): void;
  panBy(dx: number, dy: number): void;
  /** Reset to the home transform (the fitted view — see setHome), not necessarily 1×. */
  reset(): void;
  /**
   * Set the "home" transform reset() returns to — used to seed a fit-to-container view. Also snaps
   * the current state to it, and lowers the min-scale floor so a fit smaller than the default floor
   * (a big diagram shrunk to fit) is actually reachable and is the zoom-out limit.
   */
  setHome(scale: number, x: number, y: number): void;
  /** True when the current transform still equals home (user hasn't zoomed/panned) — lets a
   *  container resize re-fit without yanking a view the user deliberately zoomed into. */
  atHome(): boolean;
  /** CSS transform for a `transform-origin: 0 0` element. */
  toTransform(): string;
}

export interface FitTransform {
  scale: number;
  x: number;
  y: number;
}

/**
 * Pure fit math: the scale + translation that fits a `content` box inside a `container`, never
 * upscaling past `maxScale` (default 1×). `align: "top"` pins the content to y=0 (inline, where the
 * viewport is sized to the fitted height); the default centers on both axes (fullscreen overlay).
 * Returns null for any non-positive dimension (e.g. an unmeasured element in jsdom).
 */
export function computeFit(
  containerW: number,
  containerH: number,
  contentW: number,
  contentH: number,
  opts: { maxScale?: number; align?: "center" | "top" } = {},
): FitTransform | null {
  if (containerW <= 0 || containerH <= 0 || contentW <= 0 || contentH <= 0) return null;
  const maxScale = opts.maxScale ?? 1;
  const scale = Math.min(containerW / contentW, containerH / contentH, maxScale);
  const x = (containerW - contentW * scale) / 2;
  const y = opts.align === "top" ? 0 : (containerH - contentH * scale) / 2;
  return { scale, x, y };
}

/**
 * Zoom `panZoom` by `factor` around the center of `rect` (a getBoundingClientRect-shaped size).
 * Shared by the inline − / + buttons and the fullscreen viewer so the "take midpoint → zoomAt"
 * step lives in one place.
 */
export function zoomToRectCenter(
  panZoom: PanZoom,
  rect: { width: number; height: number },
  factor: number,
): void {
  panZoom.zoomAt(factor, rect.width / 2, rect.height / 2);
}

export function createPanZoom(opts: { minScale?: number; maxScale?: number } = {}): PanZoom {
  let minScale = opts.minScale ?? 0.2;
  const maxScale = opts.maxScale ?? 8;
  const state: PanZoomState = { scale: 1, x: 0, y: 0 };
  const home: PanZoomState = { scale: 1, x: 0, y: 0 };

  return {
    state,
    zoomAt(factor, cx, cy) {
      const next = Math.min(maxScale, Math.max(minScale, state.scale * factor));
      if (next === state.scale) return;
      // Solve for the translation that pins content point ((cx - x)/scale) under (cx, cy).
      state.x = cx - (cx - state.x) * (next / state.scale);
      state.y = cy - (cy - state.y) * (next / state.scale);
      state.scale = next;
    },
    panBy(dx, dy) {
      state.x += dx;
      state.y += dy;
    },
    reset() {
      state.scale = home.scale;
      state.x = home.x;
      state.y = home.y;
    },
    setHome(scale, x, y) {
      minScale = Math.min(minScale, scale); // a fit below the default floor becomes the zoom-out limit
      home.scale = scale;
      home.x = x;
      home.y = y;
      state.scale = scale;
      state.x = x;
      state.y = y;
    },
    atHome() {
      return (
        Math.abs(state.scale - home.scale) < 1e-3 &&
        Math.abs(state.x - home.x) < 0.5 &&
        Math.abs(state.y - home.y) < 0.5
      );
    },
    toTransform() {
      return `translate(${state.x}px, ${state.y}px) scale(${state.scale})`;
    },
  };
}
