// Export a rendered mermaid diagram as a PNG the user can paste anywhere.
//
// The canvas is NOT tainted: render-mermaid forces `htmlLabels:false`, so there is no
// <foreignObject>, and a sanitized mermaid SVG carries no external references — every glyph is a
// native <text> and every colour is inline or in the svg's own <style>. That is what makes
// drawImage + toBlob legal here.

import { utf8ToBase64 } from "./mermaid-source";
import { readSvgIntrinsicSize } from "./svg-size";

const SVG_NS = "http://www.w3.org/2000/svg";

/** Retina by default: a 1x raster of a diagram is visibly soft on any modern display. */
const DEFAULT_SCALE = 2;

/**
 * Wrap serialized SVG markup as a `data:` URL an `<Image>` can load. Ensures the root carries an
 * `xmlns` (an Image refuses markup without it) and base64s the UTF-8 bytes — bare `btoa` throws on
 * any non-Latin-1 code point, and CJK diagram labels are common here.
 */
export function buildSvgDataUrl(svgMarkup: string): string {
  let markup = svgMarkup.trim();
  const open = /^<svg\b([^>]*)>/i.exec(markup);
  if (open && !/\bxmlns\s*=/i.test(open[1])) {
    markup = `<svg xmlns="${SVG_NS}"${open[1]}>${markup.slice(open[0].length)}`;
  }
  return `data:image/svg+xml;base64,${utf8ToBase64(markup)}`;
}

/**
 * A filename for the exported diagram, derived from the diagram source so several downloads in one
 * conversation stay distinguishable. Falls back to a plain `diagram.png` when the seed has nothing
 * ASCII-sluggable in it (e.g. a CJK-only first line).
 */
export function pngFileName(seedText: string): string {
  const firstLine = (seedText ?? "").split("\n").map((l) => l.trim()).find((l) => l !== "") ?? "";
  const slug = firstLine
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/g, "");
  return slug === "" ? "diagram.png" : `diagram-${slug}.png`;
}

function triggerDownload(blob: Blob, fileName: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = fileName;
  a.style.display = "none";
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

/**
 * Rasterize `svg` and hand the user a PNG.
 *
 * `background` is filled before the diagram is drawn: a transparent PNG looks broken the moment it
 * is pasted onto anything that isn't the app's own background. Pass the viewport's resolved colour.
 *
 * Thin glue over the tested pure helpers, and untestable in jsdom (no canvas) — kept free of any
 * logic worth asserting. Never throws; a failed export is a no-op.
 */
export async function downloadSvgAsPng(
  svg: SVGSVGElement,
  opts: { background: string; scale?: number; fileName?: string },
): Promise<void> {
  try {
    const size = readSvgIntrinsicSize(svg);
    if (!size) return;
    const scale = opts.scale ?? DEFAULT_SCALE;

    // Serialize a CLONE with width/height pinned: the live svg may be mid-transform in the pan/zoom
    // viewport, and an Image needs concrete intrinsic dimensions.
    const clone = svg.cloneNode(true) as SVGSVGElement;
    clone.setAttribute("width", String(size.width));
    clone.setAttribute("height", String(size.height));
    clone.style.maxWidth = "none";
    const markup = new XMLSerializer().serializeToString(clone);

    const image = new Image();
    await new Promise<void>((resolve, reject) => {
      image.onload = () => resolve();
      image.onerror = () => reject(new Error("svg image load failed"));
      image.src = buildSvgDataUrl(markup);
    });

    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(size.width * scale));
    canvas.height = Math.max(1, Math.round(size.height * scale));
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.fillStyle = opts.background;
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(image, 0, 0, canvas.width, canvas.height);

    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob((b) => resolve(b), "image/png"));
    if (!blob) return;
    triggerDownload(blob, opts.fileName ?? "diagram.png");
  } catch {
    // Export is a convenience; a failure must not surface as an unhandled rejection.
  }
}
