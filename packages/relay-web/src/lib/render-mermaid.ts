import DOMPurify from "dompurify";
import { decodeMermaidSource } from "./mermaid-source";

export type MermaidTheme = "dark" | "light";

/** The minimal slice of the mermaid module this code uses (kept narrow for the test seam). */
export interface MermaidLike {
  initialize(config: Record<string, unknown>): void;
  render(id: string, text: string): Promise<{ svg: string }>;
}

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
 */
export async function hydrateMermaidBlocks(root: HTMLElement, theme: MermaidTheme): Promise<void> {
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
    if (block.getAttribute("data-mermaid-done")) continue; // re-check: a concurrent pass may have claimed it
    const source = decodeMermaidSource(block.getAttribute("data-mermaid") ?? "");
    const key = `${theme}:${source}`;
    try {
      let svg = svgCache.get(key);
      if (svg === undefined) {
        seq += 1;
        const rendered = await mermaid.render(`mmd-${seq}`, source);
        svg = DOMPurify.sanitize(rendered.svg, { USE_PROFILES: { svg: true, svgFilters: true } });
        svgCache.set(key, svg);
      }
      block.innerHTML = svg;
      block.setAttribute("data-mermaid-done", "1");
      block.classList.add("mermaid-rendered");
    } catch {
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
