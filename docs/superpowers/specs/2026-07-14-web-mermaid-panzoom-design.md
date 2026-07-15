# Web Mermaid Pan/Zoom — Design

**Date:** 2026-07-14 (revised 2026-07-15: inline + fullscreen, per user)
**Status:** Approved (standing autonomy directive; UX shape confirmed by user = inline **and** fullscreen)
**Scope:** `packages/relay-web` — make rendered Mermaid diagrams pan/zoomable both **inline** and in a **fullscreen** viewer. Extends the Mermaid rendering feature (branch `feat/relay-web-mermaid`, PR #161).

## Goal

A rendered Mermaid diagram is pan/zoomable **in place** (inline), and can be opened **fullscreen** for deeper inspection:

- **Inline:** drag to pan (mouse), **Ctrl/⌘+wheel** to zoom (plain wheel still scrolls the page; trackpad pinch, which the browser reports as `ctrlKey` wheel, zooms naturally), two-finger pinch to zoom on touch (one-finger touch still scrolls the page). A small controls bar (− / reset / + / ⤢ expand) appears on the diagram.
- **Fullscreen:** clicking ⤢ opens an overlay where the diagram fills the screen — drag-pan (mouse or one finger), plain wheel-zoom, pinch-zoom, the same − / reset / + controls, and close via Esc / ✕ / background click.

Both modes share one transform controller and one gesture-wiring module, differing only in a few flags.

## Conflict avoidance (why the two modes differ)

Inline lives inside a scrolling chat, so it must never hijack the page: wheel zooms **only** with a modifier, and one-finger touch is left to the browser (`touch-action: pan-y`) so vertical scrolling still works; only two-finger pinch and mouse-drag are captured. Fullscreen has no page behind it (`touch-action: none`), so plain wheel, one-finger drag, and pinch are all free.

## Architecture

Four seams; `render-mermaid.ts` is **unchanged** — inline enhancement and the viewer both read the SVG it already injected.

### 1. `lib/pan-zoom.ts` — pure transform controller (DONE, Task 1, committed)

`createPanZoom(opts?) → { state, zoomAt(factor,cx,cy), panBy(dx,dy), reset(), toTransform() }`. Pure, DOM-free, unit-tested.

### 2. `lib/pan-zoom-gestures.ts` — shared DOM gesture wiring

```ts
export interface GestureOptions {
  /** Zoom on wheel only when Ctrl/⌘ is held (inline). Default false (fullscreen: always zoom). */
  wheelRequiresModifier?: boolean;
  /** Pan on a single touch (fullscreen). Default false (inline: one finger scrolls the page). */
  oneFingerTouchPan?: boolean;
}
/** Attach wheel/pointer/touch gestures on `el`, driving `pz` and calling `onChange` after every
 *  change. Returns a detach function that removes every listener. Mouse-drag always pans. */
export function attachPanZoomGestures(
  el: HTMLElement,
  pz: PanZoom,
  onChange: () => void,
  opts?: GestureOptions,
): () => void;
```

- **Wheel:** if `wheelRequiresModifier` and neither Ctrl nor ⌘ is held → do nothing (page scrolls). Otherwise `preventDefault` and `zoomAt(deltaY<0 ? 1.1 : 1/1.1, x, y)` where `(x,y)` is the pointer relative to `el`'s bounding rect.
- **Mouse drag** (`pointerdown`/`move`/`up`, `pointerType === "mouse"`): pan by pointer delta; capture the pointer.
- **Touch:** two touches → pinch (`zoomAt(dist/prevDist, midX, midY)`, `preventDefault`); one touch → pan **only if** `oneFingerTouchPan` (else ignored so the page scrolls).
- Returns `detach()` removing all listeners. Guards `setPointerCapture` (may be absent in jsdom).

### 3. `components/MermaidViewer.vue` — fullscreen overlay

- Prop `svg: string`, emit `close`; rendered only while open (parent `v-if`) so mount/unmount = open/close.
- `Teleport` to `body`; a full-screen stage holds a `transform`-bound wrapper with `v-html="svg"` (already sanitized upstream). Uses `createPanZoom` + `attachPanZoomGestures(stage, pz, apply, { oneFingerTouchPan: true })` (plain wheel, one-finger drag, pinch).
- Controls (− / reset / + / ✕). `useModalA11y` (Esc + focus trap + focus restore). Body-scroll lock while open. Background (non-diagram) click closes. `role="dialog" aria-modal="true"`.
- Theme-aware backdrop.

### 4. `lib/inline-mermaid.ts` — inline enhancement of a rendered block

```ts
/** Wrap a rendered `pre.mermaid-block`'s SVG in a pan/zoom viewport with an inline controls bar
 *  (− / reset / + / ⤢). Returns a detach function. `onExpand` is called by the ⤢ button. */
export function enhanceMermaidBlock(block: HTMLElement, opts: { onExpand: () => void }): () => void;
```

- Moves the injected `<svg>` into `<div class="mmd-viewport"><div class="mmd-transform">…svg…</div></div>` (viewport: bounded height, `overflow: hidden`, `touch-action: pan-y`; transform wrapper: `transform-origin: 0 0`).
- `createPanZoom` + `attachPanZoomGestures(viewport, pz, apply, { wheelRequiresModifier: true })` (Ctrl+wheel, mouse-drag, pinch; one-finger scrolls).
- Appends a controls bar (− / reset / + / ⤢). ⤢ calls `opts.onExpand()`.
- `detach()` removes listeners; the wrapper DOM is discarded when StreamMarkdown next re-renders the markdown.

### 5. `components/StreamMarkdown.vue` — wire both modes

- After each hydration pass, for every `pre.mermaid-block.mermaid-rendered:not([data-mmd-enhanced])`: `enhanceMermaidBlock(block, { onExpand: () => openViewer(block) })`, mark `data-mmd-enhanced`, and keep its detach fn. `openViewer` reads the block's `svg` outerHTML into `viewerSvg` (opens `<MermaidViewer v-if="viewerSvg">`).
- Detach all enhancers on unmount and before re-hydrating (a fresh v-html render replaces the nodes).
- The existing hydration / streaming / theme logic is otherwise untouched; the mermaid `render-mermaid.ts` module is untouched.

## Security

No new surface: inline enhancement and the viewer both operate on the SAME SVG `render-mermaid` already produced and DOMPurified before injection. It is moved/re-displayed, never re-parsed or re-fetched. mermaid still runs `securityLevel: "strict"`.

## Testing

- **`pan-zoom`** (pure): done.
- **`pan-zoom-gestures`** (jsdom): on a test element — Ctrl+wheel zooms while plain wheel is a no-op when `wheelRequiresModifier`; plain wheel zooms when not; mouse pointer drag pans; a two-touch move pinch-zooms; `detach()` stops all of them.
- **`MermaidViewer`** (jsdom + @vue/test-utils, querying `document.body` for teleported nodes): renders the svg; wheel and the +/reset controls change the transform; a pointer drag pans; Esc / ✕ / background click emit `close`; body scroll locked while open and restored after.
- **`inline-mermaid`** (jsdom): enhancing a rendered block wraps the svg and adds a controls bar; Ctrl+wheel zooms (transform changes) but plain wheel does not; the +/reset controls work; ⤢ calls `onExpand`; `detach()` removes listeners.
- **`StreamMarkdown`**: a rendered block gets enhanced (viewport + controls appear) once; clicking ⤢ opens the viewer with the block's svg; ordinary text clicks do not; enhancement is not duplicated across re-hydrations.

## Out of Scope (YAGNI)

Fit-to-screen auto-scale on open (start at scale 1; reset returns there); export/download; minimap; rotation; zoom persistence across renders. Non-relay-web channels (WeChat/terminal) remain text-only.
