# Web Mermaid Rendering — Design

**Date:** 2026-07-14
**Status:** Approved (standing autonomy directive)
**Scope:** `packages/relay-web` — render ```` ```mermaid ```` fenced code blocks in chat/turn markdown as SVG diagrams.

## Goal

When an agent's message contains a ```` ```mermaid ```` fenced block, the relay-web dashboard renders it as an interactive-quality SVG diagram (flowchart, sequence, gantt, class, state, ER, pie, gitgraph, …) instead of showing raw diagram source. Everything else about markdown rendering stays byte-for-byte unchanged.

## Library Decision

**Use the official `mermaid` package (v11), dynamically imported.**

Rationale (researched 2026-07-14):
- Mermaid's grammar is *defined by* this library; no lightweight alternative parses the full grammar. Rejected: `mermaid-cli`/mmdc (Node/puppeteer, not browser), hand-rolled d3 (= rewriting mermaid), server-side pre-render (relay is incremental/streaming; client render is simpler and message volume is low).
- Cost is bundle size (~hundreds of KB gzip, pulls d3/dagre/cytoscape). Mitigation: `import('mermaid')` on first encounter keeps it out of the main chunk; the module promise is cached.
- Fits the existing stack: current pipeline is `markdown-it(html:false)` → `DOMPurify.sanitize` with **no syntax highlighter** (fences are plain `<pre><code>`), so nothing conflicts. relay gateway sets **no CSP**, so SVG injection is unobstructed; mermaid v11 needs no web worker. `dompurify` is already a dependency.

## Architecture

Three seams, matching the existing sync-render + `v-html` architecture:

### 1. `render-markdown.ts` — emit a placeholder for mermaid fences (sync)

Override markdown-it's `fence` rule: when the fence info string is `mermaid`, emit a placeholder instead of `<pre><code>`:

```html
<pre class="mermaid-block" data-mermaid="<base64(source)>"><code>…escaped source…</code></pre>
```

- `data-mermaid` carries the **base64-encoded** diagram source — the render seam's source of truth (avoids HTML-unescaping ambiguity). Base64 is inert to DOMPurify and survives sanitization (`ALLOW_DATA_ATTR` defaults true).
- The visible `<code>` holds the escaped source as a **fallback / loading state**: before hydration, during streaming, and on render error, the user sees the diagram source, never a blank.
- All other fences (```` ```ts ````, plain ```` ``` ````, etc.) route to the default renderer — **unchanged**.
- Encoding uses a UTF-8-safe base64 (`btoa(unescape(encodeURIComponent(src)))`) so non-ASCII diagram labels round-trip.

### 2. `render-mermaid.ts` — hydrate placeholders into SVG (async, lazy, cached)

New module. Public surface:

```ts
export type MermaidTheme = "dark" | "light";
/** Hydrate every un-rendered `.mermaid-block` under `root` into sanitized SVG. */
export function hydrateMermaidBlocks(root: HTMLElement, theme: MermaidTheme): Promise<void>;
/** Test seam: override the mermaid module loader. */
export function __setMermaidLoaderForTest(loader: null | (() => Promise<MermaidLike>)): void;
```

Behaviour:
- Selects `pre.mermaid-block[data-mermaid]:not([data-mermaid-done])` under `root`.
- Lazy-loads mermaid once via `import('mermaid')`; caches the module promise. Initializes with `{ startOnLoad: false, securityLevel: "strict", theme: theme === "dark" ? "dark" : "default" }`. Strict mode strips click handlers and inline HTML labels.
- For each block: decode source, compute a cache key `` `${theme}:${source}` ``. Consult a module-level `Map<string,string>` SVG cache; on miss call `mermaid.render(uniqueId, source)`, then `DOMPurify.sanitize(svg, { USE_PROFILES: { svg: true, svgFilters: true } })`, and store in cache.
- Replace the block's `innerHTML` with the sanitized SVG, set `data-mermaid-done="1"`, add class `mermaid-rendered`.
- **Error handling:** if `mermaid.render` throws (malformed/partial diagram), mark the block `data-mermaid-done="error"`, add class `mermaid-error`, and leave the `<code>` fallback visible with a small error affordance. Never throw out of `hydrateMermaidBlocks` — one bad diagram must not break the message or sibling diagrams.
- Unique render id: a module-scoped incrementing counter (`mmd-0`, `mmd-1`, …) — deterministic, no `Math.random`.

### 3. `StreamMarkdown.vue` — drive hydration after `v-html` patches

- Keep the existing throttled sync render of `html.value` unchanged.
- **Do NOT hydrate while `streaming` is true.** A mid-stream fence is auto-closed by `remend` but the diagram body is partial → mermaid would error and flicker. During streaming the mermaid block shows its source (the `<code>` fallback), which is informative and cheap (the O(n²)-per-tick concern is avoided — no expensive render on the hot path).
- Hydrate when `streaming` is false: on mount (historical/finalized messages) and on the streaming→false transition (the existing `watch(() => props.streaming)` already forces a final `render()` — hydrate in its `nextTick`).
- Read the current theme from `useThemeStore().mode`. **Watch it:** on theme change, reset rendered blocks (clear `data-mermaid-done`, restore the code fallback) and re-hydrate with the new theme. The SVG cache is theme-keyed, so a re-toggle is cheap.
- All DOM work is guarded by `nextTick` + an unmount flag so a late async hydration never touches a torn-down component.

## Security

Defense in depth, consistent with the existing `html:false` + DOMPurify pattern:
1. Diagram source reaches the renderer only via base64 in a data attribute — never interpreted as markup by markdown-it.
2. mermaid `securityLevel: "strict"` — no click bindings, no raw HTML labels.
3. The rendered SVG is run through DOMPurify (SVG profile) before injection — strips any `<script>`, event handlers, or `javascript:` URLs.

## Styling

Mermaid emits its own theme-driven colours. Add minimal `.stream-md .mermaid-block`/`.mermaid-rendered`/`.mermaid-error` rules: centered SVG, `max-width:100%` with horizontal scroll for wide diagrams (reuse the table-wrap scrollbar treatment), and a muted error border/label for the error state. No pan/zoom in this scope (YAGNI — diagrams scroll like wide tables).

## Testing

- **`render-markdown`:** mermaid fence → emits `pre.mermaid-block[data-mermaid]` with round-trippable base64 source + escaped `<code>` fallback; non-mermaid fences unchanged; a mermaid source containing `<script>`/`</code>` stays inert (base64 + escaped fallback, no executable markup after DOMPurify); non-ASCII labels round-trip.
- **`render-mermaid`:** with an injected fake mermaid loader — hydrate replaces placeholder with sanitized SVG + marks done; second hydrate of same source does **not** re-invoke `render` (cache hit); different theme → separate render (theme-keyed cache); a loader whose `render` rejects → block marked `mermaid-error`, code fallback preserved, no throw; `<script>` inside the fake SVG is stripped by the DOMPurify pass.
- **`StreamMarkdown`:** `streaming=true` leaves the block as source (hydrate not called); streaming→false triggers hydrate; theme change re-hydrates; component unmount mid-hydration does not throw.

## Out of Scope (YAGNI)

Pan/zoom/fullscreen, diagram export, non-relay-web channels (WeChat/terminal stay text), server-side pre-render, syntax highlighting of the fallback code.
