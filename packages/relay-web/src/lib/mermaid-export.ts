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

// FNV-1a (32-bit) over the UTF-16 code units. Not cryptographic and does not need to be — this only
// has to separate the handful of diagrams in one conversation, with no new dependency.
function hash32(input: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i += 1) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

/**
 * A filename for the exported diagram: `diagram-<8 hex>.png`, where the hash covers the FULL
 * diagram source. Two different diagrams get different names, and the same diagram always exports
 * under the same name (browsers still uniquify a repeat download as `… (1).png` — they do not
 * overwrite — but the name stays recognisable and tied to the content).
 *
 * Seeding from the source's first line instead would be near-useless: it is almost always
 * `flowchart TD` / `graph TD`, so every flowchart in a conversation would collide, and a CJK-only
 * first line has nothing ASCII-sluggable in it at all.
 */
export function pngFileName(seedText: string): string {
  return `diagram-${hash32(seedText ?? "")}.png`;
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
 * Rasterize `svg` and hand the user a PNG. Resolves `true` once the download is triggered, `false`
 * if it could not be produced — never throws, so the caller decides how a failure surfaces rather
 * than it vanishing into a swallowed catch.
 *
 * `background` is filled before the diagram is drawn: a transparent PNG looks broken the moment it
 * is pasted onto anything that isn't the app's own background. Pass the viewport's resolved colour.
 * That means a dark-mode diagram exports dark and looks dark pasted into a light document — a
 * deliberate "export what you see" choice, not an oversight.
 *
 * Thin glue over the tested pure helpers. The browser-only Image/canvas/download boundaries are
 * replaced with narrow test doubles so the 2x dimensions, opaque background, and operation order
 * stay regression-guarded without a canvas polyfill.
 */
export async function downloadSvgAsPng(
  svg: SVGSVGElement,
  opts: { background: string; scale?: number; fileName?: string },
): Promise<boolean> {
  try {
    const size = readSvgIntrinsicSize(svg);
    if (!size) return false;
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
    if (!ctx) return false;
    ctx.fillStyle = opts.background;
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(image, 0, 0, canvas.width, canvas.height);

    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob((b) => resolve(b), "image/png"));
    if (!blob) return false;
    triggerDownload(blob, opts.fileName ?? "diagram.png");
    return true;
  } catch {
    return false; // reported to the caller, never rethrown as an unhandled rejection
  }
}
