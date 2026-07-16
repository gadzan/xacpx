import { computeFit, createPanZoom, zoomToRectCenter, ZOOM_IN_FACTOR, ZOOM_OUT_FACTOR } from "./pan-zoom";
import { attachPanZoomGestures } from "./pan-zoom-gestures";
import { readSvgIntrinsicSize } from "./svg-size";

// Upper bound on the inline viewport height so a very tall diagram shrinks to fit instead of
// pushing the whole conversation down. Width-bound diagrams keep their natural aspect below this.
function maxViewportHeight(): number {
  return typeof window !== "undefined" ? Math.min(560, Math.round(window.innerHeight * 0.7)) : 560;
}

interface ZoomControl {
  label: string;
  glyph: string;
  factor: number; // 0 === reset
}
const ZOOM_CONTROLS: ZoomControl[] = [
  { label: "Zoom out", glyph: "−", factor: ZOOM_OUT_FACTOR }, // −
  { label: "Reset", glyph: "↺", factor: 0 }, // ↺
  { label: "Zoom in", glyph: "+", factor: ZOOM_IN_FACTOR },
];

/**
 * Enhance a rendered `pre.mermaid-block`: move its injected `<svg>` into a bounded pan/zoom
 * viewport (Ctrl/⌘+wheel zoom, mouse-drag pan, two-finger pinch; one finger still scrolls the
 * page), and add a controls bar (− / reset / + / ⤢). The ⤢ button calls `onExpand`. Returns a
 * detach that removes every listener. A block without an `<svg>` is a no-op.
 */
export function enhanceMermaidBlock(block: HTMLElement, opts: { onExpand: () => void }): () => void {
  const svg = block.querySelector("svg");
  if (!svg) return () => {};

  const viewport = document.createElement("div");
  viewport.className = "mmd-viewport";
  const wrapper = document.createElement("div");
  wrapper.className = "mmd-transform";
  wrapper.appendChild(svg); // moves the svg out of the <pre>
  viewport.appendChild(wrapper);

  const panZoom = createPanZoom();
  const apply = (): void => {
    wrapper.style.transform = panZoom.toTransform();
  };

  const bar = document.createElement("div");
  bar.className = "mmd-controls";
  const buttonDetachers: Array<() => void> = [];

  const addButton = (label: string, glyph: string, handler: (e: Event) => void): void => {
    const b = document.createElement("button");
    b.type = "button";
    b.setAttribute("aria-label", label);
    b.textContent = glyph;
    b.addEventListener("click", handler);
    buttonDetachers.push(() => b.removeEventListener("click", handler));
    bar.appendChild(b);
  };

  for (const control of ZOOM_CONTROLS) {
    addButton(control.label, control.glyph, (e) => {
      e.stopPropagation();
      if (control.factor === 0) {
        panZoom.reset();
      } else {
        zoomToRectCenter(panZoom, viewport.getBoundingClientRect(), control.factor);
      }
      apply();
    });
  }
  addButton("Fullscreen", "⤢", (e) => {
    e.stopPropagation();
    opts.onExpand();
  });

  block.replaceChildren(viewport, bar);

  // Fit-to-container: scale the diagram DOWN (never up) so it fully fits the viewport width and a
  // capped height, centered — instead of rendering at native size, left-aligned and clipped. The
  // fit becomes the pan/zoom "home", so Reset returns to it and the user can still zoom in to read.
  const size = readSvgIntrinsicSize(svg);
  if (size) {
    // Mermaid's default `max-width` style makes the SVG fluid, which fights the transform. Pin it
    // to its intrinsic px size so the transform scales it predictably.
    svg.style.maxWidth = "none";
    svg.setAttribute("width", String(size.width));
    svg.setAttribute("height", String(size.height));
  }
  let lastFitWidth = 0;
  function fit(): void {
    if (!size) return;
    const vw = viewport.clientWidth || viewport.getBoundingClientRect().width;
    const f = computeFit(vw, maxViewportHeight(), size.width, size.height, { align: "top" });
    if (!f) return;
    lastFitWidth = vw;
    viewport.style.height = `${Math.round(size.height * f.scale)}px`;
    panZoom.setHome(f.scale, f.x, f.y);
    apply();
  }
  fit();

  // Re-fit when the container width changes (responsive), but only while the user is still at the
  // fitted home — never yank a view they deliberately zoomed into. A height-only change (which fit
  // itself causes) is ignored via the width guard, so this can't loop.
  let ro: ResizeObserver | null = null;
  if (size && typeof ResizeObserver !== "undefined") {
    ro = new ResizeObserver(() => {
      const vw = viewport.clientWidth;
      if (vw > 0 && vw !== lastFitWidth && panZoom.atHome()) fit();
    });
    ro.observe(viewport);
  }

  const detachGestures = attachPanZoomGestures(viewport, panZoom, apply, { wheelRequiresModifier: true });

  return () => {
    ro?.disconnect();
    detachGestures();
    for (const d of buttonDetachers) d();
  };
}
