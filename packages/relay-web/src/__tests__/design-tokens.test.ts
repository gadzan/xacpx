import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { contrastRatio, parseCssColor } from "../lib/wcag-contrast";

const here = dirname(fileURLToPath(import.meta.url));
const css = readFileSync(join(here, "..", "style.css"), "utf8");
const tailwindConfig = readFileSync(join(here, "..", "..", "tailwind.config.js"), "utf8");
const composer = readFileSync(join(here, "..", "components", "ConversationComposer.vue"), "utf8");

/**
 * Collect the declarations of every top-level block whose selector list
 * mentions `:root` (light theme) or `.dark` (dark theme). The glass tokens
 * live in their own block, so the blocks are merged.
 */
function readThemeTokens(source: string, selector: string): Record<string, string> {
  const tokens: Record<string, string> = {};
  for (const m of source.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    if (!new RegExp(`(^|[\\s,>+~])${selector}([\\s,>+~:]|$)`).test(m[1])) continue;
    for (const d of m[2].matchAll(/(--[a-z0-9-]+):\s*([^;]+);/g)) tokens[d[1]] = d[2].trim();
  }
  return tokens;
}

// Conditional fallbacks redeclare the glass tokens with a solid colour. They
// are not the theme values.
const themeCss = css.replace(/@(supports|media)[^{]*\{(?:[^{}]*\{[^{}]*\})*[^{}]*\}/g, "");
const light = readThemeTokens(themeCss, ":root");
const dark = readThemeTokens(themeCss, "\\.dark");

/** The surfaces a foreground can sit on. */
type Surface =
  | "canvas"
  | "sidebar"
  | "raised"
  | "overlay"
  | "header"
  | "accent"
  | "danger"
  | "accentSoft";

type Rgb = [number, number, number];

/** Resolve a token to an opaque RGB triple, compositing over `base`. */
function resolve(tokens: Record<string, string>, name: string, base: Rgb): Rgb {
  const value = tokens[name];
  if (!value) throw new Error(`missing token ${name}`);
  const rgba = value.match(/rgba?\(([^)]+)\)/i);
  if (rgba) {
    const p = rgba[1].split(/[\s,/]+/).filter(Boolean).map(Number);
    const alpha = p.length >= 4 ? p[3] : 1;
    return [0, 1, 2].map((i) => Math.round(p[i] * alpha + base[i] * (1 - alpha))) as Rgb;
  }
  const n = value.split(/[\s,]+/).filter(Boolean).map(Number);
  if (n.length < 3) throw new Error(`unresolvable token ${name} = ${value}`);
  return [n[0], n[1], n[2]];
}

function surfaces(tokens: Record<string, string>): Record<Surface, Rgb> {
  const canvas = resolve(tokens, "--c-bg", [255, 255, 255]);
  const scrim = resolve(tokens, "--scrim", canvas);
  return {
    canvas,
    sidebar: resolve(tokens, "--c-surface", canvas),
    raised: resolve(tokens, "--c-raised", canvas),
    // glass-strong over the scrim over the canvas: a dialog, menu, tooltip or toast.
    overlay: resolve(tokens, "--glass-bg-strong", scrim),
    // glass over the scrim over the canvas: the conversation header.
    header: resolve(tokens, "--glass-bg", scrim),
    accent: resolve(tokens, "--c-accent", canvas),
    danger: resolve(tokens, "--c-danger", canvas),
    accentSoft: resolve(tokens, "--accent-soft", canvas),
  };
}

/** Foreground token, surface, and the WCAG threshold it must clear. */
const CONTRAST_CASES: Array<[string, string, Surface, number]> = [
  ["body text on canvas", "--c-fg", "canvas", 4.5],
  ["body text on sidebar", "--c-fg", "sidebar", 4.5],
  ["body text on raised card", "--c-fg", "raised", 4.5],
  ["muted text on canvas", "--c-fg-muted", "canvas", 4.5],
  ["muted text on sidebar", "--c-fg-muted", "sidebar", 4.5],
  ["muted text on raised card", "--c-fg-muted", "raised", 4.5],
  ["blue text on canvas", "--c-accent-text", "canvas", 4.5],
  ["blue text on sidebar", "--c-accent-text", "sidebar", 4.5],
  ["blue text on raised card", "--c-accent-text", "raised", 4.5],
  ["text on accent button", "--c-on-accent", "accent", 4.5],
  ["text on danger button", "--c-on-danger", "danger", 4.5],
  ["run text on canvas", "--c-run", "canvas", 4.5],
  ["run text on raised card", "--c-run", "raised", 4.5],
  ["warn text on canvas", "--c-warn", "canvas", 4.5],
  ["warn text on raised card", "--c-warn", "raised", 4.5],
  ["danger text on raised card", "--c-danger", "raised", 4.5],
  ["body text in overlay", "--c-fg", "overlay", 4.5],
  ["muted text in overlay", "--c-fg-muted-overlay", "overlay", 4.5],
  ["danger text in overlay", "--c-danger-overlay", "overlay", 4.5],
  ["warn text in overlay", "--c-warn-overlay", "overlay", 4.5],
  ["run text in overlay", "--c-run-overlay", "overlay", 4.5],
  ["blue text in overlay", "--c-accent-text-overlay", "overlay", 4.5],
  ["body text in header", "--c-fg", "header", 4.5],
  ["muted text in header", "--c-fg-muted", "header", 4.5],
  ["blue text on accent tint", "--c-accent-text", "accentSoft", 4.5],
  ["body text on accent tint", "--c-fg", "accentSoft", 4.5],
  ["muted text on accent tint", "--c-fg-muted", "accentSoft", 4.5],
];

describe("design tokens", () => {
  it("declares every token the Tailwind config maps in both themes", () => {
    const mapped = [...tailwindConfig.matchAll(/var\((--[a-z0-9-]+)\)/g)].map((m) => m[1]);
    expect(mapped.length).toBeGreaterThan(0);
    const missingLight = mapped.filter((t) => light[t] === undefined);
    const missingDark = mapped.filter((t) => dark[t] === undefined);
    expect({ missingLight, missingDark }).toEqual({ missingLight: [], missingDark: [] });
  });
  it("keeps the light blue text colour distinct from the button blue", () => {
    // The two blues are one hue at two lightness steps. The button fill and the
    // text colour must not collapse into one value in the light theme:
    // #0071E3 as text on the canvas is 4.27:1, below AA. The dark theme uses a
    // single blue for both roles because #409CFF clears AA as text everywhere.
    expect(light["--c-accent"]).not.toBe(light["--c-accent-text"]);
    expect(contrastRatio(resolve(light, "--c-accent", [255, 255, 255]), resolve(light, "--c-bg", [255, 255, 255]))).toBeLessThan(4.5);
    expect(contrastRatio(resolve(light, "--c-accent-text", [255, 255, 255]), resolve(light, "--c-bg", [255, 255, 255]))).toBeGreaterThanOrEqual(4.5);
  });
  it("gives the dark theme a dark on-accent colour, not white", () => {
    // #409CFF with white text is 2.61:1.
    expect(dark["--c-on-accent"]).not.toBe("255 255 255");
  });

  it("keeps the glass surfaces translucent rather than solid", () => {
    // A solid glass surface would lose the layering the design depends on.
    expect(light["--glass-bg"]).toMatch(/rgba\(/);
    expect(light["--glass-bg-strong"]).toMatch(/rgba\(/);
    expect(dark["--glass-bg"]).toMatch(/rgba\(/);
    expect(dark["--glass-bg-strong"]).toMatch(/rgba\(/);
  });

  describe.each([
    ["light", light],
    ["dark", dark],
  ])("%s theme contrast", (_theme, tokens) => {
    const s = surfaces(tokens);
    it.each(CONTRAST_CASES)("%s stays at or above %s:1", (what, fgToken, surface, min) => {
      const fg = resolve(tokens, fgToken, s[surface]);
      expect(contrastRatio(fg, s[surface])).toBeGreaterThanOrEqual(min);
    });
  });
});

describe("composer motion", () => {
  it("keeps the composer radius animation values in the codebase", () => {
    // The composer card animates between 16px (expanded) and 24px (collapsed).
    // The design language keeps this animation untouched, so the two radii must
    // stay out of the token system that the rest of the UI follows.
    expect(composer).toContain("rounded-2xl");
    expect(composer).toContain("rounded-3xl");
    expect(composer).toContain("duration-200 ease-out");
  });

  it("does not animate backdrop-filter or box-shadow", () => {
    // Blur and shadow radii are expensive and read as a smear when animated.
    for (const transition of composer.matchAll(/transition-\[([^\]]+)\]/g)) {
      expect(transition[1]).not.toContain("backdrop");
      expect(transition[1]).not.toContain("shadow");
    }
  });
});

describe("token resolution", () => {
  it("parses the token values it resolves", () => {
    expect(parseCssColor("rgb(243, 244, 246)")).toEqual([243, 244, 246]);
  });
});
