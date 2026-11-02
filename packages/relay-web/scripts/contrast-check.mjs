#!/usr/bin/env node
/**
 * Contrast checker for the relay-web design tokens.
 *
 * Every foreground/background pair the dashboard actually renders is listed
 * here against the surface it really sits on. The script fails when a pair
 * drops below its WCAG threshold, so a token change that breaks legality is
 * caught before it reaches a screenshot.
 *
 * Surfaces are modelled as composites, not flat colours:
 *   - `overlay` is glass-strong over the scrim over the canvas. This is what
 *     a dialog, menu, tooltip or toast actually renders on, and it is darker
 *     than the bare canvas, so text there needs the overlay token variants.
 *   - `header` is glass over the scrim over the canvas.
 *
 * Run: node scripts/contrast-check.mjs
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const css = readFileSync(join(here, "..", "src", "style.css"), "utf8");

// Conditional fallbacks (@supports / @media) redeclare the glass tokens with a
// solid colour. They are not the theme values, so they are stripped before the
// theme blocks are read.
const themeCss = css.replace(/@(supports|media)[^{]*\{(?:[^{}]*\{[^{}]*\})*[^{}]*\}/g, "");

/**
 * Collect the declarations of every top-level block whose selector list
 * mentions `:root` (light theme) or `.dark` (dark theme). A token may be
 * declared in more than one block — the glass tokens have their own — so the
 * blocks are merged.
 */
function readThemeTokens(source, selector) {
  const tokens = {};
  for (const m of source.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    if (!new RegExp(`(^|[\\s,>+~])${selector}([\\s,>+~:]|$)`).test(m[1])) continue;
    for (const d of m[2].matchAll(/(--[a-z0-9-]+):\s*([^;]+);/g)) tokens[d[1]] = d[2].trim();
  }
  return tokens;
}

const themes = {
  light: readThemeTokens(themeCss, ":root"),
  dark: readThemeTokens(themeCss, "\\.dark"),
};

/** `243 244 246` → [243,244,246]. */
function rgb(triple) {
  const n = triple.split(/[\s,]+/).filter(Boolean).map(Number);
  return n.length >= 3 && n.every((v) => !Number.isNaN(v)) ? [n[0], n[1], n[2]] : null;
}

/** `rgba(0,0,0,.26)` → [r,g,b,a]. */
function rgba(value) {
  const m = value.match(/rgba?\(([^)]+)\)/i);
  if (!m) return null;
  const p = m[1].split(/[\s,/]+/).filter(Boolean).map(Number);
  if (p.length < 3 || p.slice(0, 3).some((v) => Number.isNaN(v))) return null;
  return [p[0], p[1], p[2], p.length >= 4 ? p[3] : 1];
}

/** Composite a translucent colour over an opaque one. */
function over(fg, bg) {
  const a = fg[3] ?? 1;
  if (a >= 1) return [fg[0], fg[1], fg[2]];
  return [0, 1, 2].map((i) => Math.round(fg[i] * a + bg[i] * (1 - a)));
}

function channel(c) {
  const s = c / 255;
  return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
}

function luminance([r, g, b]) {
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

function ratio(fg, bg) {
  const lf = luminance(fg);
  const lb = luminance(bg);
  const hi = Math.max(lf, lb);
  const lo = Math.min(lf, lb);
  return (hi + 0.05) / (lo + 0.05);
}

/** Resolve a token to an opaque colour, compositing translucents over `base`. */
function resolve(tokens, name, base) {
  const value = tokens[name];
  if (!value) throw new Error(`missing token ${name}`);
  if (value.startsWith("#")) {
    const h = value.slice(1);
    const n = h.length === 3
      ? [...h].map((c) => parseInt(c + c, 16))
      : [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16));
    return [n[0], n[1], n[2]];
  }
  const parsed = rgba(value);
  if (parsed) return over(parsed, base);
  const triple = rgb(value);
  if (triple) return triple;
  throw new Error(`unresolvable token ${name} = ${value}`);
}

/** The surfaces a foreground can sit on, as composites over the canvas. */
function surfaces(tokens) {
  const canvas = resolve(tokens, "--c-bg", [255, 255, 255]);
  const scrimmed = over(rgba(tokens["--scrim"]), canvas);
  return {
    canvas,
    sidebar: resolve(tokens, "--c-surface", canvas),
    raised: resolve(tokens, "--c-raised", canvas),
    // glass-strong over the scrim over the canvas: a dialog, menu, tooltip or toast.
    overlay: resolve(tokens, "--glass-bg-strong", scrimmed),
    // glass over the scrim over the canvas: the conversation header.
    header: resolve(tokens, "--glass-bg", scrimmed),
  };
}

/**
 * Each case names a foreground token, a surface, and the WCAG threshold.
 * `min` is 4.5 for body text and 3 for large text (18.66px bold / 24px) and
 * for non-text indicators.
 */
const cases = [
  // Body text on the three main surfaces.
  { fg: "--c-fg", surface: "canvas", min: 4.5, what: "body text on canvas" },
  { fg: "--c-fg", surface: "sidebar", min: 4.5, what: "body text on sidebar" },
  { fg: "--c-fg", surface: "raised", min: 4.5, what: "body text on raised card" },
  { fg: "--c-fg-muted", surface: "canvas", min: 4.5, what: "muted text on canvas" },
  { fg: "--c-fg-muted", surface: "sidebar", min: 4.5, what: "muted text on sidebar" },
  { fg: "--c-fg-muted", surface: "raised", min: 4.5, what: "muted text on raised card" },

  // Blue text. The button blue and the text blue are deliberately different:
  // #0071E3 is a button fill, #005FC2 is the text colour.
  { fg: "--c-accent-text", surface: "canvas", min: 4.5, what: "blue text on canvas" },
  { fg: "--c-accent-text", surface: "sidebar", min: 4.5, what: "blue text on sidebar" },
  { fg: "--c-accent-text", surface: "raised", min: 4.5, what: "blue text on raised card" },

  // Text on a filled accent button.
  { fg: "--c-on-accent", surface: "accent", min: 4.5, what: "text on accent button" },
  { fg: "--c-on-accent", surface: "accent-hover", min: 4.5, what: "text on accent button (hover)" },

  // Status text on the surfaces it legitimately appears on. Danger text is
  // never placed on the bare canvas: #D92D20 is only 4.39:1 there, so it
  // always lives in a card, a glass panel, or a dialog.
  { fg: "--c-run", surface: "canvas", min: 4.5, what: "run text on canvas" },
  { fg: "--c-run", surface: "raised", min: 4.5, what: "run text on raised card" },
  { fg: "--c-warn", surface: "canvas", min: 4.5, what: "warn text on canvas" },
  { fg: "--c-warn", surface: "raised", min: 4.5, what: "warn text on raised card" },
  { fg: "--c-danger", surface: "raised", min: 4.5, what: "danger text on raised card" },
  { fg: "--c-on-danger", surface: "danger", min: 4.5, what: "text on danger button" },

  // Text inside an overlay (dialog, menu, tooltip, toast). The scrim darkens
  // the surface, so these use the overlay token variants.
  { fg: "--c-fg", surface: "overlay", min: 4.5, what: "body text in overlay" },
  { fg: "--c-fg-muted-overlay", surface: "overlay", min: 4.5, what: "muted text in overlay" },
  { fg: "--c-danger-overlay", surface: "overlay", min: 4.5, what: "danger text in overlay" },
  { fg: "--c-warn-overlay", surface: "overlay", min: 4.5, what: "warn text in overlay" },
  { fg: "--c-run-overlay", surface: "overlay", min: 4.5, what: "run text in overlay" },
  { fg: "--c-accent-text-overlay", surface: "overlay", min: 4.5, what: "blue text in overlay" },

  // The conversation header is glass over the scrim over the canvas.
  { fg: "--c-fg", surface: "header", min: 4.5, what: "body text in header" },
  { fg: "--c-fg-muted", surface: "header", min: 4.5, what: "muted text in header" },

  // Blue text on a pale blue tint. The tint is translucent, so this is the
  // case that used to drop below AA.
  { fg: "--c-accent-text", surface: "accent-soft-canvas", min: 4.5, what: "blue text on accent tint" },
  { fg: "--c-fg", surface: "accent-soft-canvas", min: 4.5, what: "body text on accent tint" },
  { fg: "--c-fg-muted", surface: "accent-soft-canvas", min: 4.5, what: "muted text on accent tint" },
];

let failures = 0;
const rows = [];

for (const [theme, tokens] of Object.entries(themes)) {
  const s = surfaces(tokens);
  s.accent = resolve(tokens, "--c-accent", s.canvas);
  s["accent-hover"] = resolve(tokens, "--c-accent-hover", s.canvas);
  s.danger = resolve(tokens, "--c-danger", s.canvas);
  s["accent-soft-canvas"] = resolve(tokens, "--accent-soft", s.canvas);

  for (const c of cases) {
    const fg = resolve(tokens, c.fg, s[c.surface]);
    const r = ratio(fg, s[c.surface]);
    const ok = r >= c.min;
    if (!ok) failures += 1;
    rows.push({ theme, what: c.what, ratio: r, min: c.min, ok });
  }
}

for (const theme of ["light", "dark"]) {
  console.log(`\n  ${theme}`);
  console.log(`  ${"case".padEnd(38)}${"ratio".padStart(7)}  ${"min".padStart(5)}  result`);
  console.log(`  ${"-".repeat(62)}`);
  for (const row of rows.filter((r) => r.theme === theme)) {
    console.log(
      `  ${row.what.padEnd(38)}${row.ratio.toFixed(2).padStart(7)}  ${String(row.min).padStart(5)}  ${row.ok ? "PASS" : "FAIL"}`,
    );
  }
}

console.log("");
if (failures > 0) {
  console.error(`FAIL: ${failures} pair(s) below their threshold.`);
  process.exit(1);
}
console.log("PASS: every pair meets its threshold.");
