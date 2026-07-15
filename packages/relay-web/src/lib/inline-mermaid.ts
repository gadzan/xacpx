import { createPanZoom } from "./pan-zoom";
import { attachPanZoomGestures } from "./pan-zoom-gestures";

interface ZoomControl {
  label: string;
  glyph: string;
  factor: number; // 0 === reset
}
const ZOOM_CONTROLS: ZoomControl[] = [
  { label: "Zoom out", glyph: "−", factor: 0.8 }, // −
  { label: "Reset", glyph: "↺", factor: 0 }, // ↺
  { label: "Zoom in", glyph: "+", factor: 1.25 },
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

  const pz = createPanZoom();
  const apply = (): void => {
    wrapper.style.transform = pz.toTransform();
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
        pz.reset();
      } else {
        const r = viewport.getBoundingClientRect();
        pz.zoomAt(control.factor, r.width / 2, r.height / 2);
      }
      apply();
    });
  }
  addButton("Fullscreen", "⤢", (e) => {
    e.stopPropagation();
    opts.onExpand();
  });

  block.replaceChildren(viewport, bar);

  const detachGestures = attachPanZoomGestures(viewport, pz, apply, { wheelRequiresModifier: true });

  return () => {
    detachGestures();
    for (const d of buttonDetachers) d();
  };
}
