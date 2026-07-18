# Mermaid node-label dark-mode contrast fix — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** In relay-web, make mermaid flowchart node labels legible in dark mode when the diagram author pins a light node fill, by overriding the label color only when its measured contrast is too low.

**Architecture:** Add a pure WCAG-contrast math module, plus a live-DOM pass that walks each `g.node`, measures label-vs-fill contrast via `getComputedStyle`, and overrides the label color (black/white auto-pick) when contrast < 3.0. The pass runs inside `hydrateMermaidBlocks` right after the sanitized SVG is injected.

**Tech Stack:** TypeScript, Vue/relay-web, Vitest (jsdom), mermaid 11.16.0, DOMPurify.

## Global Constraints

- Package: `packages/relay-web`. Tests run with **Vitest, not bun** (`npx vitest run` / `bun run --cwd packages/relay-web test`).
- Threshold: override label color **only when contrast < 3.0** (WCAG graphical-object minimum). `>= 3.0` → leave untouched (zero regression).
- Scope: **flowchart node labels only** — `g.node` `<text>` vs its shape fill. Do NOT touch edge labels, subgraph titles, sequence actors, gantt, pie.
- Override color: black/white auto-pick (whichever contrasts more). Theme-agnostic — the same pass also fixes light-theme author-pinned dark fills; do not branch on theme.
- The contrast pass reads **live computed styles**, so it must run after the SVG is in the document. jsdom's `getComputedStyle` resolves only **inline `style`** (not `<style>` classes / presentation attrs), so tests feed fills via inline `style.fill`; the real class/attribute path is covered by the one-off Chromium probe (see spec), not CI.
- Spec: `docs/superpowers/specs/2026-07-17-web-mermaid-label-contrast-design.md`.

---

## File Structure

- **Create** `packages/relay-web/src/lib/wcag-contrast.ts` — pure WCAG math + readable-color picker (no DOM).
- **Create** `packages/relay-web/src/__tests__/wcag-contrast.test.ts` — unit tests for the math.
- **Modify** `packages/relay-web/src/lib/render-mermaid.ts` — add + export `applyNodeLabelContrast(root)`; call it inside `hydrateMermaidBlocks` after `block.innerHTML = svg`.
- **Create** `packages/relay-web/src/__tests__/node-label-contrast.test.ts` — jsdom logic test for `applyNodeLabelContrast` + integration test through `hydrateMermaidBlocks`.

---

## Task 1: Pure WCAG-contrast module

**Files:**
- Create: `packages/relay-web/src/lib/wcag-contrast.ts`
- Test: `packages/relay-web/src/__tests__/wcag-contrast.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `type RGB = [number, number, number]`
  - `parseCssColor(value: string): RGB | null`
  - `relativeLuminance(rgb: RGB): number`
  - `contrastRatio(fg: RGB, bg: RGB): number`
  - `pickReadableTextColor(bg: RGB): string` (returns `"rgb(0, 0, 0)"` or `"rgb(255, 255, 255)"`)

- [ ] **Step 1: Write the failing test**

Create `packages/relay-web/src/__tests__/wcag-contrast.test.ts`:

```ts
import { expect, test } from "vitest";
import {
  parseCssColor,
  relativeLuminance,
  contrastRatio,
  pickReadableTextColor,
} from "../lib/wcag-contrast";

test("parseCssColor parses rgb and rgba (drops alpha channel)", () => {
  expect(parseCssColor("rgb(204, 204, 204)")).toEqual([204, 204, 204]);
  expect(parseCssColor("rgba(1, 2, 3, 0.5)")).toEqual([1, 2, 3]);
});

test("parseCssColor returns null for none / fully transparent / garbage", () => {
  expect(parseCssColor("none")).toBeNull();
  expect(parseCssColor("rgba(0, 0, 0, 0)")).toBeNull();
  expect(parseCssColor("")).toBeNull();
});

test("relativeLuminance: black is 0, white is 1", () => {
  expect(relativeLuminance([0, 0, 0])).toBeCloseTo(0, 5);
  expect(relativeLuminance([255, 255, 255])).toBeCloseTo(1, 5);
});

test("contrastRatio matches the probe-measured anchors", () => {
  const text = parseCssColor("rgb(204, 204, 204)")!; // #ccc mermaid dark label
  const lightFill = parseCssColor("rgb(224, 255, 255)")!; // #e0ffff pinned
  const darkFill = parseCssColor("rgb(31, 32, 32)")!; // #1f2020 theme default
  expect(contrastRatio(text, lightFill)).toBeCloseTo(1.52, 1);
  expect(contrastRatio(text, darkFill)).toBeCloseTo(10.17, 1);
});

test("contrastRatio is symmetric and bounded at 21 for black/white", () => {
  expect(contrastRatio([255, 255, 255], [0, 0, 0])).toBeCloseTo(21, 0);
  expect(contrastRatio([0, 0, 0], [255, 255, 255])).toBeCloseTo(21, 0);
});

test("pickReadableTextColor: black on light fills, white on dark fills", () => {
  expect(pickReadableTextColor([224, 255, 255])).toBe("rgb(0, 0, 0)");
  expect(pickReadableTextColor([255, 255, 255])).toBe("rgb(0, 0, 0)");
  expect(pickReadableTextColor([31, 32, 32])).toBe("rgb(255, 255, 255)");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/relay-web && npx vitest run src/__tests__/wcag-contrast.test.ts`
Expected: FAIL — cannot resolve `../lib/wcag-contrast`.

- [ ] **Step 3: Write minimal implementation**

Create `packages/relay-web/src/lib/wcag-contrast.ts`:

```ts
// WCAG relative-luminance / contrast math + a readable text-color picker.
// Pure (no DOM) so it is unit-testable in isolation. Consumed by the mermaid
// node-label contrast fix (render-mermaid.ts applyNodeLabelContrast).

export type RGB = [number, number, number];

/**
 * Parse a CSS `rgb()/rgba()` computed-style string into an RGB triple.
 * Returns null for `none`, fully transparent (alpha 0), or anything unparseable
 * — i.e. "no usable background color".
 */
export function parseCssColor(value: string): RGB | null {
  const m = value.match(/rgba?\(([^)]+)\)/i);
  if (!m) return null;
  const parts = m[1].split(",").map((p) => parseFloat(p.trim()));
  if (parts.length < 3 || parts.slice(0, 3).some((n) => Number.isNaN(n))) return null;
  const alpha = parts.length >= 4 ? parts[3] : 1;
  if (alpha === 0) return null;
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/relay-web && npx vitest run src/__tests__/wcag-contrast.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/relay-web/src/lib/wcag-contrast.ts packages/relay-web/src/__tests__/wcag-contrast.test.ts
git commit -m "feat(relay-web): add pure WCAG contrast math module"
```

---

## Task 2: `applyNodeLabelContrast` DOM pass

**Files:**
- Modify: `packages/relay-web/src/lib/render-mermaid.ts` (add + export `applyNodeLabelContrast`)
- Test: `packages/relay-web/src/__tests__/node-label-contrast.test.ts`

**Interfaces:**
- Consumes: `parseCssColor`, `contrastRatio`, `pickReadableTextColor` from `./wcag-contrast`.
- Produces: `applyNodeLabelContrast(root: HTMLElement): void` (exported from `render-mermaid.ts`).

- [ ] **Step 1: Write the failing test**

Create `packages/relay-web/src/__tests__/node-label-contrast.test.ts`:

```ts
import { afterEach, expect, test } from "vitest";
import { applyNodeLabelContrast } from "../lib/render-mermaid";

// Build a mermaid-like g.node. jsdom's getComputedStyle resolves only INLINE
// style (not <style> classes / presentation attrs), so we feed fills via inline
// style.fill — enough to exercise the decision + mutation logic. The real
// class/attribute path is covered by the Chromium probe (see spec). The node
// must be in-document for getComputedStyle to resolve.
function nodeSvg(shapeFill: string, textFill: string): HTMLElement {
  const root = document.createElement("div");
  root.innerHTML =
    `<svg><g class="node">` +
    `<rect style="fill: ${shapeFill}"></rect>` +
    `<text style="fill: ${textFill}">Label</text>` +
    `</g></svg>`;
  document.body.appendChild(root);
  return root;
}
function textFill(root: HTMLElement): string {
  return (root.querySelector("text") as unknown as SVGElement).style.fill;
}
afterEach(() => {
  document.body.innerHTML = "";
});

test("overrides the label color on a light fill (contrast 1.52 < 3.0)", () => {
  const root = nodeSvg("rgb(224, 255, 255)", "rgb(204, 204, 204)");
  applyNodeLabelContrast(root);
  expect(textFill(root)).toBe("rgb(0, 0, 0)");
});

test("leaves a readable label untouched (dark fill control, contrast 10.17)", () => {
  const root = nodeSvg("rgb(31, 32, 32)", "rgb(204, 204, 204)");
  applyNodeLabelContrast(root);
  expect(textFill(root)).toBe("rgb(204, 204, 204)");
});

test("skips nodes whose shape has no resolvable fill (fill:none)", () => {
  const root = nodeSvg("none", "rgb(204, 204, 204)");
  applyNodeLabelContrast(root);
  expect(textFill(root)).toBe("rgb(204, 204, 204)");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/relay-web && npx vitest run src/__tests__/node-label-contrast.test.ts`
Expected: FAIL — `applyNodeLabelContrast` is not exported from `render-mermaid`.

- [ ] **Step 3: Write minimal implementation**

In `packages/relay-web/src/lib/render-mermaid.ts`, add this import at the top (next to the existing `DOMPurify` / `decodeMermaidSource` imports):

```ts
import { parseCssColor, contrastRatio, pickReadableTextColor } from "./wcag-contrast";
```

Then add, near the top of the module (after the imports, before `hydrateMermaidBlocks`):

```ts
// WCAG graphical-object minimum. Node labels below this against their fill are
// illegible (e.g. mermaid dark's #ccc text on an author-pinned light fill ≈ 1.5).
const MIN_LABEL_CONTRAST = 3.0;

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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/relay-web && npx vitest run src/__tests__/node-label-contrast.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/relay-web/src/lib/render-mermaid.ts packages/relay-web/src/__tests__/node-label-contrast.test.ts
git commit -m "feat(relay-web): add node-label contrast pass for mermaid"
```

---

## Task 3: Wire the pass into `hydrateMermaidBlocks`

**Files:**
- Modify: `packages/relay-web/src/lib/render-mermaid.ts` (call `applyNodeLabelContrast` inside the hydrate loop)
- Test: `packages/relay-web/src/__tests__/node-label-contrast.test.ts` (add integration test)

**Interfaces:**
- Consumes: `applyNodeLabelContrast` (Task 2), `hydrateMermaidBlocks` + `__setMermaidLoaderForTest` (existing).
- Produces: nothing new — behavior change only.

- [ ] **Step 1: Write the failing test**

Append to `packages/relay-web/src/__tests__/node-label-contrast.test.ts`:

```ts
import {
  hydrateMermaidBlocks,
  __setMermaidLoaderForTest,
} from "../lib/render-mermaid";
import { encodeMermaidSource } from "../lib/mermaid-source";

function mermaidBlock(src: string): HTMLElement {
  const root = document.createElement("div");
  root.innerHTML = `<pre class="mermaid-block" data-mermaid="${encodeMermaidSource(src)}"><code>${src}</code></pre>`;
  document.body.appendChild(root); // getComputedStyle needs it in-document
  return root;
}

afterEach(() => __setMermaidLoaderForTest(null));

test("hydrateMermaidBlocks fixes a low-contrast node label end to end", async () => {
  __setMermaidLoaderForTest(() =>
    Promise.resolve({
      initialize: () => {},
      render: async () => ({
        svg:
          `<svg><g class="node">` +
          `<rect style="fill: rgb(224, 255, 255)"></rect>` +
          `<text style="fill: rgb(204, 204, 204)">Hi</text>` +
          `</g></svg>`,
      }),
    }),
  );
  const root = mermaidBlock("graph TD\n A-->B");
  await hydrateMermaidBlocks(root, "dark");
  const text = root.querySelector("pre.mermaid-block text") as unknown as SVGElement;
  expect(text.style.fill).toBe("rgb(0, 0, 0)");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/relay-web && npx vitest run src/__tests__/node-label-contrast.test.ts`
Expected: FAIL — the label stays `rgb(204, 204, 204)` because hydrate does not yet call the pass.

- [ ] **Step 3: Write minimal implementation**

In `packages/relay-web/src/lib/render-mermaid.ts`, inside `hydrateMermaidBlocks`, find:

```ts
      if (shouldAbort?.()) return; // re-check after the await: DOM may have been torn down mid-render
      block.innerHTML = svg;
      block.setAttribute("data-mermaid-done", "1");
      block.classList.add("mermaid-rendered");
```

Insert the contrast pass right after the innerHTML assignment:

```ts
      if (shouldAbort?.()) return; // re-check after the await: DOM may have been torn down mid-render
      block.innerHTML = svg;
      // svgCache holds the pre-fix SVG string, so re-apply on every injection (incl. cache hits).
      // Cheap, idempotent DOM walk; no-op when contrast is already fine or fills don't resolve.
      applyNodeLabelContrast(block);
      block.setAttribute("data-mermaid-done", "1");
      block.classList.add("mermaid-rendered");
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/relay-web && npx vitest run src/__tests__/node-label-contrast.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Run the existing mermaid render tests (no regression)**

Run: `cd packages/relay-web && npx vitest run src/__tests__/render-mermaid.test.ts`
Expected: PASS — existing hydrate tests unaffected (their SVGs have no `g.node`, or run detached where `getComputedStyle` yields no resolvable fill → the pass is a no-op).

- [ ] **Step 6: Commit**

```bash
git add packages/relay-web/src/lib/render-mermaid.ts packages/relay-web/src/__tests__/node-label-contrast.test.ts
git commit -m "feat(relay-web): apply node-label contrast fix during mermaid hydrate"
```

---

## Task 4: Full-suite verification + real-render confirmation

**Files:** none (verification only).

- [ ] **Step 1: Run the whole relay-web test suite + typecheck**

Run: `cd packages/relay-web && npx vitest run && npx vue-tsc --noEmit`
(`vue-tsc --noEmit` is exactly the typecheck half of this package's `build` script: `vue-tsc --noEmit && vite build`.)
Expected: all tests PASS, no type errors.

- [ ] **Step 2: Real-render confirmation via the Chromium probe (optional, not CI)**

Rebuild the probe used during investigation (see spec "Probe reproduction") but read contrast **after** `applyNodeLabelContrast` runs, i.e. drive the real `hydrateMermaidBlocks` path. Expected result: the `style fill:#e0ffff` and `classDef fill:#e1f5fe` nodes now report the label `fill` as `rgb(0, 0, 0)` with contrast ≥ 10 (was ≈ 1.4–1.6); the control node is unchanged at 10.17. Capture a screenshot showing all node labels legible.

If the probe harness is not readily available, this step may be skipped — the jsdom integration test (Task 3) plus the math unit tests (Task 1) are the automated gate; the probe is confirmatory only.

- [ ] **Step 3: Final commit (if any verification tweaks were made)**

```bash
git add -A
git commit -m "test(relay-web): verify mermaid node-label contrast fix"
```

(If nothing changed in this task, skip the commit.)

---

## Self-Review notes

- **Spec coverage:** approach (post-render live-DOM pass) → Task 2/3; pure math module → Task 1; threshold < 3.0 → `MIN_LABEL_CONTRAST` (Task 2); scope `g.node` only → Task 2 selector; theme-agnostic → no theme branch in Task 2; override black/white auto-pick → `pickReadableTextColor` (Task 1); skip unresolvable fill → Task 2 early return; testing (math + jsdom logic + integration) → Task 1/2/3; probe not in CI → Task 4 Step 2. All covered.
- **Type consistency:** `RGB`, `parseCssColor`, `contrastRatio`, `pickReadableTextColor`, `applyNodeLabelContrast` names/signatures identical across tasks.
