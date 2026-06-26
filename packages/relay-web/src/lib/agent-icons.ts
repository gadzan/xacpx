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
import qwen from "@lobehub/icons-static-svg/icons/qwen-color.svg?raw";
import kimi from "@lobehub/icons-static-svg/icons/kimi-color.svg?raw";
import opencode from "@lobehub/icons-static-svg/icons/opencode.svg?raw";
import openclaw from "@lobehub/icons-static-svg/icons/openclaw-color.svg?raw";
import kilocode from "@lobehub/icons-static-svg/icons/kilocode.svg?raw";
import kiro from "@lobehub/icons-static-svg/icons/kiro-color.svg?raw";
import qoder from "@lobehub/icons-static-svg/icons/qoder-color.svg?raw";
import trae from "@lobehub/icons-static-svg/icons/trae-color.svg?raw";

// Keyed by acpx driver (src/config/agent-templates.ts). A custom agent ("my-codex")
// resolves to driver "codex" upstream, so keying on driver — not the agent name — keeps
// the mapping small and stable.
const ICONS: Record<string, string> = {
  codex,
  claude,
  gemini,
  copilot,
  cursor,
  qwen,
  kimi,
  opencode,
  openclaw,
  kilocode,
  kiro,
  qoder,
  trae,
};

/** Raw brand SVG for an agent driver, or null when the library ships none (the caller
 *  then renders a generic fallback). Tolerant of casing/whitespace drift in the driver. */
export function agentIconSvg(driver: string | null | undefined): string | null {
  if (!driver) return null;
  return ICONS[driver.trim().toLowerCase()] ?? null;
}
