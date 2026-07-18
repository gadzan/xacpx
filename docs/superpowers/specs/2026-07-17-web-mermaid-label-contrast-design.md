# Mermaid node-label dark-mode contrast fix — design

Date: 2026-07-17
Scope: `packages/relay-web`

## Problem

In the relay-web chat, mermaid diagrams rendered in **dark mode** show node-label
text that is washed out / illegible whenever the diagram author pins a **light**
fill on a node (via `style X fill:#...` or `classDef ... fill:#...`).

### Root cause (confirmed by real-Chromium probe)

A headless-Chromium probe (cached `chromium_headless_shell-1228`, real
mermaid 11.16.0, the **verbatim** `render-mermaid.ts` init/sanitize config —
`theme:'dark'`, `htmlLabels:false`, `securityLevel:'strict'`, same DOMPurify
`svg` profile) measured computed styles:

| Case | text `fill` | shape fill | contrast |
|---|---|---|---|
| control (no pinned fill) | `rgb(204,204,204)` | `rgb(31,32,32)` | **10.17** ✅ |
| `style fill:#e0ffff` / `#ffffff` | `rgb(204,204,204)` | near-white | **1.52 / 1.61** ❌ |
| `classDef fill:#e1f5fe` | `rgb(204,204,204)` | `rgb(225,245,254)` | **1.43** ❌ |

The label text color is **identical** (`#ccc`, mermaid dark theme's
`nodeTextColor`) in every case — mermaid has **no** text↔fill contrast
adaptation (upstream-inherent). When the author pins a light fill, `#ccc` lands
on near-white ≈ 1.4–1.6:1.

**Ruled out (not the cause):** theme detection is correct (`stores/theme.ts`
maps dark→mermaid `"dark"` theme); DOMPurify keeps the `<style>` block, so theme
variables are injected fine. The contrast conflict is the sole cause.

There is currently **no** contrast post-processing in `render-mermaid.ts` — the
previously-investigated fix was never merged.

## Approach

Post-render, on the **live DOM**, walk each flowchart node, compute the WCAG
contrast between its label text and its shape fill, and override the text color
**only when contrast < 3.0**. This is the only approach that handles per-node
author-pinned fills (a global `themeVariables` text color cannot be right for
both theme-default nodes and light-pinned nodes; CSS cannot compute per-node
contrast).

Must run on the **live DOM** because `getComputedStyle` must resolve mermaid's
`<style>` classes + SVG presentation attributes — a detached SVG string does not
resolve fills (this is also why jsdom cannot exercise a real render).

### Integration point

In `render-mermaid.ts` `hydrateMermaidBlocks`, immediately **after**
`block.innerHTML = svg` and **before** setting `data-mermaid-done`, call
`applyNodeLabelContrast(block)`. The `svgCache` stores the pre-fix sanitized SVG
string, so the fixup runs on **every** injection (including cache hits) — it is a
cheap, idempotent DOM walk.

## Modules

### `src/lib/wcag-contrast.ts` (new, pure — no DOM)

The math, fully unit-testable:

- `parseCssColor(str: string): [number, number, number] | null` — parse
  `rgb()/rgba()` computed-style strings (returns null for unparseable / `none`).
- `relativeLuminance(rgb: [number, number, number]): number` — WCAG sRGB luminance.
- `contrastRatio(fg: [number,number,number], bg: [number,number,number]): number`.
- `pickReadableTextColor(bg: [number,number,number]): string` — returns
  `"rgb(0,0,0)"` or `"rgb(255,255,255)"`, whichever has the higher ratio against
  `bg` (guarantees maximal contrast).

### `applyNodeLabelContrast(root: HTMLElement): void`

DOM walk. Lives in and is **exported from `render-mermaid.ts`** (next to the
`hydrateMermaidBlocks` caller; imports the pure helpers from `wcag-contrast.ts`;
the jsdom test imports it directly). For each `g.node` under `root`:

1. Find the label `<text>` and the node shape (`rect, polygon, path, circle, ellipse`).
2. `getComputedStyle` both; parse the shape fill and the text fill.
3. If the shape fill is unparseable / `none` / fully transparent → **skip**
   (cannot know the effective background; leave to theme — preserves zero regression).
4. If `contrastRatio(textFill, shapeFill) >= 3.0` → **skip** (already readable).
5. Else set `text.style.fill = pickReadableTextColor(shapeFill)` (inline style
   overrides `<style>`/presentation attrs; `<tspan>` children inherit `fill`).

## Key behaviors

- **Threshold < 3.0** (WCAG graphical-object minimum): the control case (10.17)
  is far above → **zero regression**; only clearly-broken labels are touched.
- **Theme-agnostic**: because it picks black/white from the *measured* fill, the
  same function also fixes light-theme author-pinned **dark** fills (dark-on-dark).
  It runs regardless of theme; no theme branching.
- **Override color**: black/white auto-pick (whichever contrasts more), for
  guaranteed maximal contrast and simplicity.
- **Scope**: flowchart **node labels only** (`g.node text`) — where `style` /
  `classDef` pins land, which is 95%+ of real reports; text↔background pairing is
  clean and reliable there.

## Testing

- **`wcag-contrast.test.ts` (vitest, pure math)**: known color-pair ratios
  anchored to the probe's measured values (`#ccc` vs `#e0ffff` ≈ 1.52, `#ccc` vs
  `#1f2020` ≈ 10.17), black/white pick correctness, boundary (== 3.0) and invalid
  / `none` inputs.
- **`applyNodeLabelContrast` jsdom logic test**: hand-build a `g.node` and feed
  colors via **inline `style.fill`** (jsdom's `getComputedStyle` reads inline
  style). Assert: light-fill node → text fill overridden to black; dark-fill
  control → **untouched**; `fill:none` → skipped. This covers the decision + DOM
  mutation logic without a browser.
- **Real render**: the headless-Chromium probe already provided end-to-end
  evidence (one-off). It is **not** wired into CI (needs a cached browser + local
  http server, which CI lacks). Reproduction steps are recorded below.

### Probe reproduction (manual, for the record)

1. Bundle a probe entry that imports mermaid + DOMPurify, initializes with the
   verbatim `render-mermaid.ts` config, renders a control diagram + a
   `style fill:#e0ffff` diagram + a `classDef fill:#e1f5fe` diagram, injects the
   sanitized SVG, then reads `getComputedStyle().fill` of each node's text and
   shape and computes contrast.
2. Serve the bundle over http (module scripts are CORS-blocked on `file://`).
3. Drive the cached `chrome-headless-shell` via `playwright-core`
   (`executablePath`), read `window.__PROBE__`, screenshot full page.

## Out of scope (YAGNI)

- Edge labels, subgraph titles, sequence-diagram actors, gantt, pie.
- Configurable threshold.
- Any change to the theme pipeline (it is correct).
