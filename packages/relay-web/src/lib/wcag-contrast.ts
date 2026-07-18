// WCAG relative-luminance / contrast math + a readable text-color picker.
// Pure (no DOM) so it is unit-testable in isolation. Consumed by the mermaid
// node-label contrast fix (render-mermaid.ts applyNodeLabelContrast).

export type RGB = [number, number, number];

/**
 * Parse a CSS `rgb()/rgba()` computed-style string into an RGB triple.
 * Returns null for `none`, anything unparseable, and any non-opaque color — i.e.
 * "no usable opaque background color". A partial or zero alpha (`rgba(r,g,b,a)`,
 * a < 1, or a non-numeric alpha) can't be composited without the effective
 * background, which we don't reliably have, so it is skipped rather than measured
 * as its unblended color and decided on wrongly.
 */
export function parseCssColor(value: string): RGB | null {
  const m = value.match(/rgba?\(([^)]+)\)/i);
  if (!m) return null;
  const parts = m[1].split(",").map((p) => parseFloat(p.trim()));
  if (parts.length < 3 || parts.slice(0, 3).some((n) => Number.isNaN(n))) return null;
  const alpha = parts.length >= 4 ? parts[3] : 1;
  if (!(alpha >= 1)) return null; // alpha < 1 (non-opaque) or NaN (non-numeric) → skip
  return [parts[0], parts[1], parts[2]];
}

function channelLuminance(c: number): number {
  const s = c / 255;
  return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
}

/** WCAG 2.x relative luminance of an sRGB color (0..1). */
export function relativeLuminance([r, g, b]: RGB): number {
  return 0.2126 * channelLuminance(r) + 0.7152 * channelLuminance(g) + 0.0722 * channelLuminance(b);
}

/** WCAG contrast ratio between two colors (1..21). */
export function contrastRatio(fg: RGB, bg: RGB): number {
  const lf = relativeLuminance(fg);
  const lb = relativeLuminance(bg);
  const hi = Math.max(lf, lb);
  const lo = Math.min(lf, lb);
  return (hi + 0.05) / (lo + 0.05);
}

/** Pick black or white — whichever has the higher contrast against `bg`. */
export function pickReadableTextColor(bg: RGB): string {
  const black: RGB = [0, 0, 0];
  const white: RGB = [255, 255, 255];
  return contrastRatio(black, bg) >= contrastRatio(white, bg) ? "rgb(0, 0, 0)" : "rgb(255, 255, 255)";
}
