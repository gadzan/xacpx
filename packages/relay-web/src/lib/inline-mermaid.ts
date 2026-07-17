import { downloadSvgAsPng, pngFileName } from "./mermaid-export";
import { decodeMermaidSource } from "./mermaid-source";
import { computeFit, createPanZoom, zoomToRectCenter, ZOOM_IN_FACTOR, ZOOM_OUT_FACTOR } from "./pan-zoom";
import { attachPanZoomGestures } from "./pan-zoom-gestures";
import { readSvgIntrinsicSize } from "./svg-size";

// Upper bound on the inline viewport height so a very tall diagram shrinks to fit instead of
// pushing the whole conversation down. Width-bound diagrams keep their natural aspect below this.
function maxViewportHeight(): number {
  return typeof window !== "undefined" ? Math.min(560, Math.round(window.innerHeight * 0.7)) : 560;
}

/**
 * Button text for the controls bar. This module is DOM-only and deliberately has no i18n of its
 * own; the component that owns `t` passes the strings in (same seam as the `chat.mermaidError`
 * data-attr on the error block).
 */
export interface MermaidControlLabels {
  zoomOut: string;
  reset: string;
  zoomIn: string;
  fullscreen: string;
  source: string;
  download: string;
}

interface ZoomControl {
  key: "zoomOut" | "reset" | "zoomIn";
  glyph: string;
  factor: number; // 0 === reset
}
const ZOOM_CONTROLS: ZoomControl[] = [
  { key: "zoomOut", glyph: "−", factor: ZOOM_OUT_FACTOR }, // −
  { key: "reset", glyph: "↺", factor: 0 }, // ↺
  { key: "zoomIn", glyph: "+", factor: ZOOM_IN_FACTOR },
];

// A PNG needs an opaque backdrop (transparent PNGs look broken pasted anywhere). Use whatever the
// viewport actually resolves to; fall back to white when the engine reports nothing paintable
// (jsdom, or a viewport that inherits a transparent background).
function exportBackground(viewport: HTMLElement): string {
  try {
    const bg = getComputedStyle(viewport).backgroundColor;
    if (bg && bg !== "transparent" && !/^rgba\(0,\s*0,\s*0,\s*0\)$/.test(bg)) return bg;
  } catch {
    // fall through
  }
  return "#ffffff";
}

/**
 * Enhance a rendered `pre.mermaid-block`: move its injected `<svg>` into a bounded pan/zoom
 * viewport (Ctrl/⌘+wheel zoom, mouse-drag pan, two-finger pinch; one finger still scrolls the
 * page), and add a controls bar (− / reset / + / ⤢ / </> / ⬇). The ⤢ button calls `onExpand`,
 * `</>` swaps the diagram for its source, and `⬇` saves a PNG. Returns a detach that removes every
 * listener. A block without an `<svg>` is a no-op.
 */
export function enhanceMermaidBlock(
  block: HTMLElement,
  opts: { onExpand: () => void; onExportError?: () => void; labels: MermaidControlLabels },
): () => void {
  const svg = block.querySelector("svg");
  if (!svg) return () => {};

  // This enhancer OWNS `mmd-source-mode`, so it must initialize it: `showingSource` starts false
  // below, and a re-enhance (theme switch → detach → reset → re-hydrate) hits a block that may still
  // carry the class from the previous enhancement. resetMermaidBlocks deliberately knows nothing
  // about it — clearing it here is what keeps the DOM and `showingSource` from disagreeing, which
  // otherwise hides the diagram behind a toggle that claims aria-pressed="false".
  block.classList.remove("mmd-source-mode");

  const viewport = document.createElement("div");
  viewport.className = "mmd-viewport";
  const wrapper = document.createElement("div");
  wrapper.className = "mmd-transform";
  wrapper.appendChild(svg); // moves the svg out of the <pre>
  viewport.appendChild(wrapper);

  // The `data-mermaid` base64 is the source of truth for the diagram text (the <code> fallback is
  // gone once the block is hydrated).
  const source = decodeMermaidSource(block.getAttribute("data-mermaid") ?? "");
  const sourceEl = document.createElement("pre");
  sourceEl.className = "mmd-source";
  const sourceCode = document.createElement("code");
  sourceCode.textContent = source;
  sourceEl.appendChild(sourceCode);

  const panZoom = createPanZoom();
  const apply = (): void => {
    wrapper.style.transform = panZoom.toTransform();
  };

  const bar = document.createElement("div");
  bar.className = "mmd-controls";
  const buttonDetachers: Array<() => void> = [];

  const addButton = (
    label: string,
    glyph: string,
    handler: (e: Event) => void,
    options?: { viewOnly?: boolean },
  ): HTMLButtonElement => {
    const b = document.createElement("button");
    b.type = "button";
    b.setAttribute("aria-label", label);
    // Zoom/reset/fullscreen are meaningless over a source listing, so they hide in source mode
    // (CSS keys off `.mmd-source-mode` on the block). `</>` and `⬇` stay usable in both modes.
    if (options?.viewOnly) b.classList.add("mmd-view-only");
    b.textContent = glyph;
    b.addEventListener("click", handler);
    buttonDetachers.push(() => b.removeEventListener("click", handler));
    bar.appendChild(b);
    return b;
  };

  for (const control of ZOOM_CONTROLS) {
    addButton(
      opts.labels[control.key],
      control.glyph,
      (e) => {
        e.stopPropagation();
        if (control.factor === 0) {
          panZoom.reset();
        } else {
          zoomToRectCenter(panZoom, viewport.getBoundingClientRect(), control.factor);
        }
        apply();
      },
      { viewOnly: true },
    );
  }
  addButton(
    opts.labels.fullscreen,
    "⤢",
    (e) => {
      e.stopPropagation();
      opts.onExpand();
    },
    { viewOnly: true },
  );

  let showingSource = false;
  const sourceButton = addButton(opts.labels.source, "</>", (e) => {
    e.stopPropagation();
    showingSource = !showingSource;
    block.classList.toggle("mmd-source-mode", showingSource);
    sourceButton.setAttribute("aria-pressed", String(showingSource));
  });
  sourceButton.setAttribute("aria-pressed", "false");

  // U+2B07 is Emoji_Presentation=Yes, so iOS/Android/macOS paint it as a blue emoji and ignore the
  // bar's `color`. U+FE0E (VARIATION SELECTOR-15) forces text presentation, keeping it monochrome
  // alongside the other five glyphs, which are all text-default.
  const downloadButton = addButton(opts.labels.download, "\u2B07\uFE0E", (e) => {
    e.stopPropagation();
    // Rasterizing is async and can fail (Image.onerror, toBlob → null). Disabling for the duration
    // is what stops a double-tap from queueing a second raster (a disabled button fires no click),
    // and a failure is reported rather than swallowed — the caller owns how it surfaces, since this
    // module has no i18n.
    downloadButton.disabled = true;
    downloadButton.setAttribute("aria-busy", "true");
    void downloadSvgAsPng(svg, { background: exportBackground(viewport), fileName: pngFileName(source) })
      .then((ok) => {
        if (!ok) opts.onExportError?.();
      })
      .finally(() => {
        downloadButton.disabled = false;
        downloadButton.removeAttribute("aria-busy");
      });
  });

  block.replaceChildren(viewport, sourceEl, bar);

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
