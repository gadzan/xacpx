# Web Mermaid Pan/Zoom — Design

**Date:** 2026-07-14
**Status:** Approved (standing autonomy directive)
**Scope:** `packages/relay-web` — make rendered Mermaid diagrams pan/zoomable. Extends the Mermaid rendering feature (branch `feat/relay-web-mermaid`, PR #161); this was the explicit "out of scope / YAGNI" item there, now requested.

## Goal

Let a user inspect a complex Mermaid diagram by panning and zooming it. Clicking a rendered diagram opens a fullscreen **viewer overlay** with drag-to-pan, wheel-zoom, pinch-zoom, on-screen zoom controls, and reset; Esc / ✕ / backdrop closes it. Inline diagrams render exactly as today (static, horizontally scrollable) but gain a `zoom-in` cursor and a subtle hint that they are clickable.

## Why a fullscreen viewer (not inline gestures)

Inline pan/zoom in a scrolling chat fights the page: wheel-zoom hijacks page scroll, and one-finger drag-to-pan blocks touch scrolling (a known, painful conflict). A fullscreen overlay has no competing page scroll, so wheel-zoom, one-finger drag-pan, and pinch-zoom are all natural and unambiguous. It is also the conventional pattern for diagrams/images in a feed. Inline diagrams stay simple and readable.

## Architecture

Three additive seams. `render-mermaid.ts` is **unchanged** — the viewer reads the SVG already injected into the DOM.

### 1. `lib/pan-zoom.ts` — a pure, framework-free transform controller

```ts
export interface PanZoomState { scale: number; x: number; y: number; }
export interface PanZoom {
  readonly state: PanZoomState;
  /** Multiply scale by `factor`, keeping viewport point (cx, cy) stationary. Clamps scale. */
  zoomAt(factor: number, cx: number, cy: number): void;
  panBy(dx: number, dy: number): void;
  reset(): void;
  /** CSS transform for a `transform-origin: 0 0` element: `translate(Xpx, Ypx) scale(S)`. */
  toTransform(): string;
}
export function createPanZoom(opts?: { minScale?: number; maxScale?: number }): PanZoom;
```

- `state` starts at `{ scale: 1, x: 0, y: 0 }`.
- `zoomAt`: `next = clamp(scale * factor, min, max)`; `x = cx - (cx - x) * (next / scale)` (same for y); then `scale = next`. Keeps the point under the cursor fixed. Defaults `minScale = 0.2`, `maxScale = 8`.
- Pure and synchronous → fully unit-testable without a DOM.

### 2. `components/MermaidViewer.vue` — the fullscreen overlay

- **Props:** `svg: string | null` (non-null ⇒ open). **Emits:** `close`.
- `Teleport` to `body`. A backdrop covers the screen; a full-size **stage** hosts a wrapper `<div>` whose `transform` is bound to `panzoom.toTransform()` (with `transform-origin: 0 0`), containing the diagram via `v-html="svg"` (already DOMPurify-sanitized upstream — no re-sanitize needed, but the value is only ever an app-produced SVG string).
- **Interactions on the stage:**
  - `wheel` → `preventDefault`; `zoomAt(factor, e.clientX - rectLeft, e.clientY - rectTop)` where `factor = e.deltaY < 0 ? 1.1 : 1/1.1`.
  - Pointer drag (mouse or single touch via Pointer Events) → `panBy(dx, dy)`.
  - Two-finger touch → pinch-zoom: track the two touches, `zoomAt(newDist / prevDist, midX, midY)`; the midpoint also pans naturally.
- **Controls** (fixed corner, always visible): zoom − / reset / zoom + / close ✕. Zoom buttons call `zoomAt(1.25|0.8, viewportCenterX, viewportCenterY)`.
- **Keyboard:** `Esc` closes; `+` / `-` / `0` (reset) optional.
- **Lifecycle:** while open, lock body scroll (`overflow: hidden`) and restore on close; `reset()` the controller on open; move focus to the close button; `role="dialog"` `aria-modal="true"`. All listeners are removed on unmount / close.
- Theme-aware backdrop (light/dark), consistent with the app.

### 3. `StreamMarkdown.vue` — open the viewer on click

- Add one delegated `@click` on the root: if `event.target.closest("pre.mermaid-block.mermaid-rendered")` exists, read its `querySelector("svg")?.outerHTML`, set `viewerSvg.value` to it (opens the viewer). Non-mermaid clicks are ignored. Only fully-rendered blocks match (not `mermaid-error`, not the un-hydrated fallback).
- Render `<MermaidViewer :svg="viewerSvg" @close="viewerSvg = null" />` once per instance (it teleports; only one is open at a time in practice).
- CSS: `.mermaid-block.mermaid-rendered { cursor: zoom-in; }` plus a subtle hover affordance (a small ⤢ badge or outline) signalling "click to zoom". The existing hydration/streaming/theme logic is untouched.

## Security

No new surface: the viewer displays the SAME SVG string `render-mermaid` already produced and DOMPurified before injecting inline. The click handler reads it back from the live DOM and re-displays it; it is not re-parsed or re-fetched. mermaid still runs `securityLevel: "strict"`.

## Testing

- **`pan-zoom` (pure):** `zoomAt` keeps the target point fixed (assert resulting x/y math); scale clamps at min/max; `panBy` adds to x/y; `reset` returns to `{1,0,0}`; `toTransform()` formats correctly.
- **`MermaidViewer` (jsdom + @vue/test-utils):** with a non-null `svg` it teleports and renders the SVG; a `wheel` event changes the wrapper's `transform`; a pointer drag pans (transform x/y change); the zoom-in / zoom-out / reset controls update the transform; `Esc`, backdrop click, and ✕ each emit `close`; body scroll is locked while open and restored after; `svg = null` renders nothing.
- **`StreamMarkdown`:** clicking a rendered `.mermaid-block.mermaid-rendered` opens the viewer with that block's SVG; clicking ordinary text does not; clicking a `mermaid-error` block does not.

## Out of Scope (YAGNI)

Inline (non-overlay) gestures; fit-to-screen auto-scaling on open (start at scale 1, centered; reset returns there); export/download; minimap; rotation; per-diagram zoom persistence. Non-relay-web channels (WeChat/terminal) remain text-only.
