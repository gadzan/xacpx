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
  reset(): void;
  /** CSS transform for a `transform-origin: 0 0` element. */
  toTransform(): string;
}

export function createPanZoom(opts: { minScale?: number; maxScale?: number } = {}): PanZoom {
  const minScale = opts.minScale ?? 0.2;
  const maxScale = opts.maxScale ?? 8;
  const state: PanZoomState = { scale: 1, x: 0, y: 0 };

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
      state.scale = 1;
      state.x = 0;
      state.y = 0;
    },
    toTransform() {
      return `translate(${state.x}px, ${state.y}px) scale(${state.scale})`;
    },
  };
}
