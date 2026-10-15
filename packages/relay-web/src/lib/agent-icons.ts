// Brand glyphs for agent drivers, sourced from @lobehub/icons-static-svg (same library
// the docs site uses). Each entry is the raw SVG markup, imported at build time via Vite's
// `?raw` loader — bundled as a trusted string constant, never user input, so AgentIcon can
// render it with v-html. Colour variants are used where the library ships one; the rest
// fall back to the monochrome mark. Drivers with no brand icon resolve to null and the
// caller shows a generic fallback.
import codex from "@lobehub/icons-static-svg/icons/codex-color.svg?raw";
import claude from "@lobehub/icons-static-svg/icons/claudecode-color.svg?raw";
import gemini from "@lobehub/icons-static-svg/icons/gemini-color.svg?raw";
import copilot from "@lobehub/icons-static-svg/icons/copilot-color.svg?raw";
import cursor from "@lobehub/icons-static-svg/icons/cursor.svg?raw";
import hermes from "@lobehub/icons-static-svg/icons/hermesagent.svg?raw";
import qwen from "@lobehub/icons-static-svg/icons/qwen-color.svg?raw";
import kimi from "@lobehub/icons-static-svg/icons/kimi-color.svg?raw";
import opencode from "@lobehub/icons-static-svg/icons/opencode.svg?raw";
import openclaw from "@lobehub/icons-static-svg/icons/openclaw-color.svg?raw";
import kilocode from "@lobehub/icons-static-svg/icons/kilocode.svg?raw";
import kiro from "@lobehub/icons-static-svg/icons/kiro-color.svg?raw";
import qoder from "@lobehub/icons-static-svg/icons/qoder-color.svg?raw";

import trae from "@lobehub/icons-static-svg/icons/trae-color.svg?raw";
// omp (Oh My Pi) has no @lobehub glyph — its gradient "pi mark" ships as a local asset.
import omp from "../../assets/omp-mark.svg?raw";

/** ViewBox `[minX, minY, width, height]` parsed from the root <svg>, or 24×24 default. */
function viewBoxOf(svg: string): readonly [number, number, number, number] {
  const m = svg.match(/\bviewBox="([^"]+)"/i);
  if (!m) return [0, 0, 24, 24];
  const p = m[1]!.trim().split(/[\s,]+/).map(Number);
  if (p.length !== 4 || p.some((n) => !Number.isFinite(n))) return [0, 0, 24, 24];
  return [p[0]!, p[1]!, p[2]!, p[3]!];
}

/**
 * Drop a full-bleed solid-hex background tile that sits under the brand mark
 * (Codex white rounded square, Kiro purple tile). Only removes a candidate when at
 * least one other drawn <path> remains, so single-path framed marks (kilocode) stay intact.
 */
function stripBackgroundTile(svg: string): string {
  const vb = viewBoxOf(svg);
  const max = Math.max(vb[2], vb[3]);
  // Match a whole <path>…</path> (or self-closing) so we do not leave a stray closer.
  const pathRe = /<path\b[^>]*\/>|<path\b[^>]*>[\s\S]*?<\/path>/g;
  const paths = [...svg.matchAll(pathRe)];
  if (paths.length < 2) return svg;
  let stripped = svg;
  let removed = 0;
  for (const m of paths) {
    const el = m[0]!;
    const fill = el.match(/\bfill="(#[0-9A-Fa-f]{3,8})"/);
    if (!fill) continue;
    const d = el.match(/\bd="([^"]*)"/)?.[1] ?? "";
    // Rounded-rect tiles start on the top edge (`… 0H…`) and mention the viewBox max
    // (`24h…` has no word boundary after 24, so use a digit-bounded search, not `\b`).
    const onTopEdge = /M[\d.]+ 0H|M0[\s,]|M0H|\b0H/.test(d);
    const reachesMax = new RegExp(String.raw`(^|[^0-9.])${max}([^0-9.]|$)`).test(d);
    if (!onTopEdge || !reachesMax) continue;
    stripped = stripped.replace(el, "");
    removed++;
    break;
  }
  if (removed && !/<path\b/i.test(stripped)) return svg;
  return stripped;
}

// Fill swaps for white ink that vanishes on light themes once it sits on the round frame
// instead of a dark tile. Kiro's ghost body takes its stripped tile's purple (eyes stay #000).
// Kimi's K is white in the brand file; it takes `currentColor`, which AgentIcon pins to the
// body text colour (`text-fg`), so it is dark on light and light on dark. Its dot stays
// #1783FF. Each fill is one constant; a value may be a hex or `currentColor`.
const KIRO_GHOST_FILL = "#9046FF";
const KIMI_K_FILL = "currentColor";
const GLYPH_RECOLOR: Readonly<Record<string, readonly (readonly [string, string])[]>> = {
  kiro: [['fill="#fff"', `fill="${KIRO_GHOST_FILL}"`]],
  kimi: [['fill="#fff"', `fill="${KIMI_K_FILL}"`]],
};

function recolor(svg: string, swaps: readonly (readonly [string, string])[]): string {
  return swaps.reduce((out, [from, to]) => out.split(from).join(to), svg);
}

/**
 * Scale about the ink centroid and place that centroid on the viewBox centre.
 * `cx`/`cy` are absolute viewBox coordinates of the ink centroid *before* the transform;
 * `scale` brings the longest ink-bbox side to ~60% of the container (PR #423 round 3).
 */
function fitGlyph(svg: string, scale: number, cx: number, cy: number): string {
  const [vx, vy, vw, vh] = viewBoxOf(svg);
  const ox = vx + vw / 2, oy = vy + vh / 2;
  if (Math.abs(scale - 1) < 1e-6 && Math.abs(cx - ox) < 1e-6 && Math.abs(cy - oy) < 1e-6) return svg;
  const open = svg.indexOf(">", svg.indexOf("<svg")) + 1, close = svg.lastIndexOf("</svg>");
  const t = `translate(${ox} ${oy}) scale(${scale}) translate(${-cx} ${-cy})`;
  return `${svg.slice(0, open)}<g transform="${t}">${svg.slice(open, close)}</g>${svg.slice(close)}`;
}

// Optical fit after background-tile strip (PR #423 round 3). Acceptance at 32px:
// ink-centroid |dx|,|dy| ≤ 0.5px; longest ink-bbox side ≈60% (55–65%). Values measured
// from the strip-only Playwright raster on @lobehub/icons-static-svg 1.91.0 (pinned; the
// raw-SVG hash test fails on upgrade): scale + absolute ink centroid in viewBox units.
const GLYPH_FIT: Readonly<Record<string, { readonly scale: number; readonly cx: number; readonly cy: number }>> = {
  claude: { scale: 0.6, cx: 11.9995, cy: 11.745 },
  codex: { scale: 0.8, cx: 12.0659, cy: 11.9324 },
  gemini: { scale: 0.653617, cx: 11.9917, cy: 12.0002 },
  copilot: { scale: 0.6, cx: 12.0223, cy: 11.9595 },
  cursor: { scale: 0.6, cx: 11.3379, cy: 12.3878 },
  hermes: { scale: 0.6, cx: 12.7155, cy: 12.5548 },
  qwen: { scale: 0.653617, cx: 12.0428, cy: 11.9938 },
  kimi: { scale: 0.693454, cx: 10.5652, cy: 11.0414 },
  opencode: { scale: 0.717757, cx: 11.9999, cy: 12.0 },
  openclaw: { scale: 0.6, cx: 11.9955, cy: 12.3299 },
  kilocode: { scale: 0.6, cx: 11.9015, cy: 12.0546 },
  kiro: { scale: 0.906344, cx: 12.352, cy: 12.1757 },
  qoder: { scale: 0.6, cx: 12.0418, cy: 12.3113 },
  trae: { scale: 0.6, cx: 12.5858, cy: 11.639 },
  omp: { scale: 0.872727, cx: 31.6111, cy: 28.9444 },
};

const ICONS: Record<string, string> = {
  codex,
  claude,
  gemini,
  copilot,
  cursor,
  hermes,
  qwen,
  kimi,
  opencode,
  openclaw,
  kilocode,
  kiro,
  qoder,
  trae,
  omp,
};
for (const driver of Object.keys(ICONS)) {
  let svg = stripBackgroundTile(ICONS[driver]!);
  const swaps = GLYPH_RECOLOR[driver];
  if (swaps) svg = recolor(svg, swaps);
  const fit = GLYPH_FIT[driver];
  if (fit) svg = fitGlyph(svg, fit.scale, fit.cx, fit.cy);
  ICONS[driver] = svg;
}

/** Raw brand SVG for an agent driver, or null when the library ships none (the caller
 *  then renders a generic fallback). Tolerant of casing/whitespace drift in the driver. */
export function agentIconSvg(driver: string | null | undefined): string | null {
  if (!driver) return null;
  return ICONS[driver.trim().toLowerCase()] ?? null;
}
