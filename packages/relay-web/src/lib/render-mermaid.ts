import DOMPurify from "dompurify";
import { decodeMermaidSource } from "./mermaid-source";
import { parseCssColor, contrastRatio, pickReadableTextColor } from "./wcag-contrast";

export type MermaidTheme = "dark" | "light";

/** The minimal slice of the mermaid module this code uses (kept narrow for the test seam). */
export interface MermaidLike {
  initialize(config: Record<string, unknown>): void;
  render(id: string, text: string): Promise<{ svg: string }>;
}

// Conservative "rescue" threshold — recolor only labels well below legibility, so
// we don't second-guess mermaid's own borderline styling. This is deliberately NOT
// WCAG AA text conformance (SC 1.4.3 would be 4.5:1); the 3.0–4.5 band is left
// alone. The real failure mode this targets — #ccc text on an author-pinned light
// fill — measures ≈ 1.5, far below 3.0, so this catches every actual case.
const MIN_LABEL_CONTRAST = 3.0;

let loaderOverride: null | (() => Promise<MermaidLike>) = null;
let modPromise: Promise<MermaidLike> | null = null;
let initializedTheme: MermaidTheme | null = null;
let seq = 0;
const svgCache = new Map<string, string>();

/** Test seam: inject a fake loader and reset all module state. Pass null to restore. */
export function __setMermaidLoaderForTest(loader: null | (() => Promise<MermaidLike>)): void {
  loaderOverride = loader;
  modPromise = null;
  initializedTheme = null;
  seq = 0;
  svgCache.clear();
}

/**
 * Fix illegible flowchart node labels in place. For each `g.node` under `root`,
 * if its label <text> has < MIN_LABEL_CONTRAST against the node's shape fill,
 * override the text color to black/white (whichever is more readable). No-op for
 * labels that are already readable (zero regression) and for shapes with no
 * resolvable fill (none/transparent — unknown background, left to the theme).
 *
 * Reads live computed styles, so it must run AFTER the SVG is in the document.
 * Theme-agnostic: it also fixes light-theme author-pinned dark fills.
 */
export function applyNodeLabelContrast(root: HTMLElement): void {
  const nodes = root.querySelectorAll<SVGGElement>("g.node");
  nodes.forEach((node) => {
    const shape = node.querySelector<SVGElement>("rect, polygon, path, circle, ellipse");
    const text = node.querySelector<SVGElement>("text");
    if (!shape || !text) return;
    const fill = parseCssColor(getComputedStyle(shape).fill);
    if (!fill) return; // none / transparent — unknown background, leave to theme
    const color = parseCssColor(getComputedStyle(text).fill);
    if (!color) return;
    if (contrastRatio(color, fill) >= MIN_LABEL_CONTRAST) return;
    text.style.fill = pickReadableTextColor(fill);
  });
}

function loadMermaid(): Promise<MermaidLike> {
  if (loaderOverride) return loaderOverride();
  if (!modPromise) {
    // Dynamic import keeps mermaid (and its d3/dagre/cytoscape deps) out of the main chunk.
    modPromise = import("mermaid").then((m) => m.default as unknown as MermaidLike);
  }
  return modPromise;
}

async function getMermaid(theme: MermaidTheme): Promise<MermaidLike> {
  const mermaid = await loadMermaid();
  if (initializedTheme !== theme) {
    mermaid.initialize({
      startOnLoad: false,
      securityLevel: "strict",
      // Render node labels as native SVG <text>, NOT HTML in <foreignObject>. DOMPurify's svg
      // allowlist has no `foreignObject`, so it strips the whole label subtree — leaving empty
      // boxes. (Adding the html profile does NOT help: foreignObject itself is removed regardless.)
      // Native <text> is in the allowlist and survives sanitization.
      htmlLabels: false,
      flowchart: { htmlLabels: false },
      theme: theme === "dark" ? "dark" : "default",
    });
    initializedTheme = theme;
  }
  return mermaid;
}

/**
 * Render every un-hydrated `pre.mermaid-block` under `root` to sanitized SVG. Results are
 * cached by `theme + source`. Errors are contained per-block (marked `data-mermaid-done="error"`,
 * code fallback preserved); this function never rejects.
 *
 * `shouldAbort`, when supplied, is consulted before every DOM commit — both before starting a
 * block and again after the async `mermaid.render` resolves — so a component that unmounts (or
 * resumes streaming) mid-render never has SVG written into its torn-down or now-partial DOM.
 */
export async function hydrateMermaidBlocks(
  root: HTMLElement,
  theme: MermaidTheme,
  shouldAbort?: () => boolean,
): Promise<void> {
  const blocks = Array.from(
    root.querySelectorAll<HTMLElement>('pre.mermaid-block[data-mermaid]:not([data-mermaid-done])'),
  );
  if (blocks.length === 0) return;

  let mermaid: MermaidLike;
  try {
    mermaid = await getMermaid(theme);
  } catch {
    return; // mermaid failed to load — leave every block on its source fallback
  }

  for (const block of blocks) {
    if (shouldAbort?.()) return; // component torn down / streaming resumed — stop touching the DOM
    if (block.getAttribute("data-mermaid-done")) continue; // re-check: a concurrent pass may have claimed it
    const source = decodeMermaidSource(block.getAttribute("data-mermaid") ?? "");
    const key = `${theme}:${source}`;
    try {
      let svg = svgCache.get(key);
      if (svg === undefined) {
        seq += 1;
        const rendered = await mermaid.render(`mmd-${seq}`, source);
        // svg-only profile is sufficient because htmlLabels:false makes every label native SVG
        // <text> (see getMermaid). DOMPurify still strips scripts / handlers / js: URLs.
        svg = DOMPurify.sanitize(rendered.svg, { USE_PROFILES: { svg: true, svgFilters: true } });
        svgCache.set(key, svg);
      }
      if (shouldAbort?.()) return; // re-check after the await: DOM may have been torn down mid-render
      block.innerHTML = svg;
      // svgCache holds the pre-fix SVG string, so re-apply on every injection (incl. cache hits).
      // Cheap, idempotent DOM walk; no-op when contrast is already fine or fills don't resolve.
      applyNodeLabelContrast(block);
      block.setAttribute("data-mermaid-done", "1");
      block.classList.add("mermaid-rendered");
    } catch {
      if (shouldAbort?.()) return; // torn down / streaming resumed during a FAILED render — same as the success path, don't touch stale DOM
      block.setAttribute("data-mermaid-done", "error");
      block.classList.add("mermaid-error");
      // Leave the <code> fallback in place so the user still sees the diagram source.
    }
  }
}

/**
 * Revert already-hydrated blocks under `root` to their code fallback so they can be
 * re-rendered (e.g. after a theme switch). The `data-mermaid` base64 is the source of truth.
 */
export function resetMermaidBlocks(root: HTMLElement): void {
  const blocks = Array.from(
    root.querySelectorAll<HTMLElement>("pre.mermaid-block[data-mermaid-done]"),
  );
  for (const block of blocks) {
    const source = decodeMermaidSource(block.getAttribute("data-mermaid") ?? "");
    const code = document.createElement("code");
    code.textContent = source;
    block.replaceChildren(code);
    block.removeAttribute("data-mermaid-done");
    block.classList.remove("mermaid-rendered", "mermaid-error");
  }
}
