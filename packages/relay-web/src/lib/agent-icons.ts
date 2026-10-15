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

// Optical centering, in viewBox units. A few marks sit visibly off the centre of their
// own 24-unit box, which shows in the round avatar frames. The whole mark is translated
// (these marks have no background tile, so nothing else moves). Only applied where the
// glyph's bounding box is off by more than 0.5px at 32px AND its ink centroid leans the
// same way, so it is a real offset, not the mark's intended asymmetry; see PR #423.
const GLYPH_OFFSET: Readonly<Record<string, readonly [number, number]>> = {
  kimi: [0, 2], // the mark spans y 0–20 of 24 (centre 10): move it down 2
  openclaw: [0, -0.675], // the mark spans y 1.68–23.67 of 24 (centre 12.675): move it up 0.675
};
function offsetGlyph(svg: string, [dx, dy]: readonly [number, number]): string {
  const open = svg.indexOf(">", svg.indexOf("<svg")) + 1, close = svg.lastIndexOf("</svg>");
  return `${svg.slice(0, open)}<g transform="translate(${dx} ${dy})">${svg.slice(open, close)}</g>${svg.slice(close)}`;
}

// Keyed by acpx driver (src/config/agent-templates.ts). A custom agent ("my-codex")
// resolves to driver "codex" upstream, so keying on driver — not the agent name — keeps
// the mapping small and stable.
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
for (const [driver, offset] of Object.entries(GLYPH_OFFSET)) ICONS[driver] = offsetGlyph(ICONS[driver]!, offset);

/** Raw brand SVG for an agent driver, or null when the library ships none (the caller
 *  then renders a generic fallback). Tolerant of casing/whitespace drift in the driver. */
export function agentIconSvg(driver: string | null | undefined): string | null {
  if (!driver) return null;
  return ICONS[driver.trim().toLowerCase()] ?? null;
}
