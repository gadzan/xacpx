// Keep mermaid node labels readable when the diagram's own source pins a node fill.
//
// `style A fill:#f9f,stroke:#333` and `classDef cool fill:#e0ffff` (agents emit these constantly)
// make mermaid paint the SHAPE with the author's colour while leaving the label <text> on the
// THEME's `nodeTextColor`. In dark mode that is #ccc, so a light author fill yields #ccc on
// rgb(224,255,255) — unreadable. Mermaid has no contrast adaptation for author-specified fills, so
// we do it here, after render, from the computed styles.
//
// The pass is deliberately a NO-OP whenever the existing pairing already clears
// MIN_LABEL_CONTRAST: mermaid's own light/dark palettes are designed and pass comfortably, and we
// must not repaint them. Only a label that is actually failing gets an inline override.

export interface Rgba {
  r: number;
  g: number;
  b: number;
  a: number;
}

/**
 * Below this WCAG contrast ratio a label counts as unreadable and gets recoloured. 3.0 is the
 * WCAG AA bar for large text, which is what diagram labels effectively are. It is set low on
 * purpose: it must be permissive enough that every mermaid-designed pairing stays untouched.
 */
export const MIN_LABEL_CONTRAST = 3.0;

/** Near-black label, used on light fills. */
export const DARK_TEXT = "#111111";
/** Near-white label, used on dark fills. */
export const LIGHT_TEXT = "#f5f5f5";

const HEX_RE = /^#([0-9a-f]+)$/i;
const RGB_FN_RE = /^rgba?\(([^)]*)\)$/;

function clampChannel(n: number): number {
  return Math.min(255, Math.max(0, n));
}

function parseHex(digits: string): Rgba | null {
  const expand = (h: string): number => parseInt(h.length === 1 ? h + h : h, 16);
  if (digits.length === 3 || digits.length === 4) {
    const parts = digits.split("");
    return {
      r: expand(parts[0]),
      g: expand(parts[1]),
      b: expand(parts[2]),
      a: parts.length === 4 ? expand(parts[3]) / 255 : 1,
    };
  }
  if (digits.length === 6 || digits.length === 8) {
    const pair = (i: number): number => parseInt(digits.slice(i, i + 2), 16);
    return {
      r: pair(0),
      g: pair(2),
      b: pair(4),
      a: digits.length === 8 ? pair(6) / 255 : 1,
    };
  }
  return null;
}

// Accepts a channel token from an rgb()/rgba() body: a plain number, or a percentage.
function channelValue(token: string, scale: number): number | null {
  const pct = token.endsWith("%");
  const n = Number(pct ? token.slice(0, -1) : token);
  if (!Number.isFinite(n)) return null;
  return pct ? (n / 100) * scale : n;
}

function parseRgbFn(body: string): Rgba | null {
  // Both the legacy `rgb(r, g, b, a)` and the modern `rgb(r g b / a)` forms.
  const [main, alphaPart] = body.split("/");
  const tokens = main.trim().split(/[\s,]+/).filter((t) => t !== "");
  if (tokens.length !== 3 && tokens.length !== 4) return null;
  const rgb = tokens.slice(0, 3).map((t) => channelValue(t, 255));
  if (rgb.some((n) => n === null)) return null;
  const alphaToken = alphaPart?.trim() ?? tokens[3];
  let a = 1;
  if (alphaToken !== undefined) {
    const parsed = channelValue(alphaToken, 1);
    if (parsed === null) return null;
    a = Math.min(1, Math.max(0, parsed));
  }
  return {
    r: clampChannel(rgb[0] as number),
    g: clampChannel(rgb[1] as number),
    b: clampChannel(rgb[2] as number),
    a,
  };
}

/**
 * Parse a CSS colour into RGBA. Handles what `getComputedStyle` actually emits in Chromium
 * (`rgb(r, g, b)` / `rgba(r, g, b, a)`) plus hex literals and the modern slash-alpha syntax, since
 * this also reads raw `fill` attributes as a fallback. `none`/`transparent`/unparseable → null,
 * which callers treat as "no measurable colour here, leave it alone".
 */
export function parseCssColor(input: string): Rgba | null {
  const s = (input ?? "").trim().toLowerCase();
  if (s === "" || s === "none" || s === "transparent") return null;
  const hex = HEX_RE.exec(s);
  if (hex) return parseHex(hex[1]);
  const fn = RGB_FN_RE.exec(s);
  if (fn) return parseRgbFn(fn[1]);
  return null;
}

/** WCAG 2.1 relative luminance: sRGB channels linearised, then weighted 0.2126/0.7152/0.0722. */
export function relativeLuminance(color: { r: number; g: number; b: number }): number {
  const linear = (channel: number): number => {
    const c = clampChannel(channel) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * linear(color.r) + 0.7152 * linear(color.g) + 0.0722 * linear(color.b);
}

/** WCAG 2.1 contrast ratio `(Llighter + 0.05) / (Ldarker + 0.05)`, so always >= 1. */
export function contrastRatio(
  a: { r: number; g: number; b: number },
  b: { r: number; g: number; b: number },
): number {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  const lighter = Math.max(la, lb);
  const darker = Math.min(la, lb);
  return (lighter + 0.05) / (darker + 0.05);
}

/** The better of our two label colours against `bg` — whichever wins the contrast ratio. */
export function pickReadableTextColor(bg: { r: number; g: number; b: number }): typeof DARK_TEXT | typeof LIGHT_TEXT {
  const dark = parseCssColor(DARK_TEXT) as Rgba;
  const light = parseCssColor(LIGHT_TEXT) as Rgba;
  return contrastRatio(dark, bg) >= contrastRatio(light, bg) ? DARK_TEXT : LIGHT_TEXT;
}

function computedFill(el: Element): string {
  try {
    return getComputedStyle(el).getPropertyValue("fill")?.trim() ?? "";
  } catch {
    return ""; // detached / engine without SVG computed styles
  }
}

/**
 * The element's effective fill. Computed style is authoritative — mermaid's colours arrive through
 * the `<style>` block it injects inside the svg, so the attribute alone is not enough. The
 * attribute is only a fallback for engines that do not resolve SVG presentation properties through
 * getComputedStyle (jsdom, where our fixtures set the attribute directly).
 */
function readFill(el: Element): Rgba | null {
  const computed = computedFill(el);
  if (computed !== "") return parseCssColor(computed);
  const attr = el.getAttribute("fill");
  return attr === null ? null : parseCssColor(attr);
}

const SHAPE_SELECTOR = "rect, polygon, circle, ellipse, path";

// The node's background: the first shape (document order — mermaid emits the shape before the
// label) that resolves to an actually-painted colour. A `fill:none` outline or a `url(#grad)`
// gradient is unmeasurable, so it is skipped rather than guessed at.
function findShapeFill(node: Element): Rgba | null {
  for (const shape of Array.from(node.querySelectorAll(SHAPE_SELECTOR))) {
    const fill = readFill(shape);
    if (fill && fill.a > 0) return fill;
  }
  return null;
}

function recolor(text: Element, color: string): void {
  const paint = (el: Element): void => {
    el.setAttribute("fill", color);
    const style = (el as SVGElement).style;
    if (style) {
      style.fill = color;
      style.color = color;
    }
  };
  paint(text);
  // Mermaid sometimes puts `fill` on the tspan, where it would win over the parent <text>.
  for (const tspan of Array.from(text.querySelectorAll("tspan"))) paint(tspan);
}

function fixNode(node: Element): void {
  const shapeFill = findShapeFill(node);
  if (!shapeFill) return; // nothing measurable to sit on — leave the node exactly as mermaid drew it
  for (const text of Array.from(node.querySelectorAll("text"))) {
    const labelFill = readFill(text);
    if (!labelFill) continue; // unmeasurable label — do not guess
    if (contrastRatio(labelFill, shapeFill) >= MIN_LABEL_CONTRAST) continue; // already readable: no-op
    recolor(text, pickReadableTextColor(shapeFill));
  }
}

/**
 * Repaint only the unreadable labels under `svg`, in place.
 *
 * MUST be called on an ATTACHED svg: it reads getComputedStyle, which needs the element in the
 * document for mermaid's injected `<style>` rules to resolve. Per-node work is isolated so one
 * malformed node cannot abort the pass.
 */
export function fixLabelContrast(svg: SVGElement): void {
  for (const node of Array.from(svg.querySelectorAll("g.node, g.cluster"))) {
    try {
      fixNode(node);
    } catch {
      // A single weird node must never kill the whole pass.
    }
  }
}
