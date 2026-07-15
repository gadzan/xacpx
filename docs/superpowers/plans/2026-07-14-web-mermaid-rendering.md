# Web Mermaid Rendering Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Render ```` ```mermaid ```` fenced blocks in relay-web chat markdown as sanitized SVG diagrams, leaving all other markdown rendering byte-for-byte unchanged.

**Architecture:** Three seams over the existing sync-render + `v-html` pipeline. (1) `render-markdown` emits a placeholder `<pre class="mermaid-block" data-mermaid="<base64>">` for mermaid fences. (2) A new `render-mermaid` module lazily loads `mermaid`, renders each placeholder to sanitized SVG (theme-keyed cache, error-tolerant). (3) `StreamMarkdown.vue` drives hydration after `v-html` patches — never mid-stream, re-hydrating on theme change.

**Tech Stack:** Vue 3, `markdown-it`, `dompurify`, `mermaid` (v11, dynamically imported), Vitest (jsdom), Bun/npm workspaces.

## Global Constraints

- Package: all code lives in `packages/relay-web`. Tests run with `npx vitest run` **from `packages/relay-web`** (never `bun test` — jsdom-dependent). Ref: memory `relay-web 单测要用 vitest 不能 bun test`.
- Adding a dependency to a workspace package REQUIRES syncing the root npm lock: `npm install --package-lock-only` at repo root (CI `test.yml` runs `npm ci`). Ref: memory `给 packages/* 加依赖要同步根 npm lock`.
- Security: agent output is untrusted. Diagram source must never be interpreted as markup by markdown-it (base64 in a data attribute), mermaid runs `securityLevel: "strict"`, and the rendered SVG passes through `DOMPurify.sanitize(..., { USE_PROFILES: { svg: true, svgFilters: true } })` before injection.
- No `Math.random`/`Date.now` for render ids — use a module-scoped counter.
- YAGNI: no pan/zoom, no export, no server-side render, no fallback syntax highlighting. Non-relay-web channels unchanged.
- Existing markdown behaviour (tables, links, code fences other than mermaid, streaming heal via `remend`, 80ms throttle) must stay unchanged — verified by the existing passing tests.

---

### Task 1: Add the `mermaid` dependency and sync locks

**Files:**
- Modify: `packages/relay-web/package.json` (add `mermaid` to `dependencies`)
- Modify: `bun.lock` (root, regenerated)
- Modify: `package-lock.json` (root, regenerated)

**Interfaces:**
- Produces: the `mermaid` module (with bundled TypeScript types) resolvable from `packages/relay-web`, so `import('mermaid')` typechecks in Task 3.

- [ ] **Step 1: Add the dependency**

Run from repo root:
```bash
cd packages/relay-web && bun add mermaid@^11 && cd ../..
```
Expected: `package.json` gains `"mermaid": "^11.x.x"` under `dependencies`; `bun.lock` updates.

- [ ] **Step 2: Sync the root npm lockfile**

Run from repo root:
```bash
npm install --package-lock-only
```
Expected: `package-lock.json` gains the `mermaid` entry and its transitive deps. This is mandatory — CI runs `npm ci`.

- [ ] **Step 3: Verify resolution and that nothing else broke**

Run:
```bash
cd packages/relay-web && npx vue-tsc --noEmit && npx vitest run && cd ../..
```
Expected: typecheck passes, existing tests pass. (No new code yet — this only confirms the dep add is clean.)

- [ ] **Step 4: Commit**

```bash
git add packages/relay-web/package.json bun.lock package-lock.json
git commit -m "build(relay-web): add mermaid dependency for diagram rendering"
```

---

### Task 2: Emit a placeholder for mermaid fences in `render-markdown`

**Files:**
- Create: `packages/relay-web/src/lib/mermaid-source.ts`
- Modify: `packages/relay-web/src/lib/render-markdown.ts`
- Test: `packages/relay-web/src/__tests__/render-markdown.test.ts` (add cases)

**Interfaces:**
- Produces: `encodeMermaidSource(src: string): string` and `decodeMermaidSource(encoded: string): string` (UTF-8-safe base64, exact inverses). `decodeMermaidSource` is consumed by Task 3.
- Produces: mermaid fences render to `<pre class="mermaid-block" data-mermaid="<base64>"><code>…escaped…</code></pre>`; `data-mermaid` and the class survive DOMPurify. All non-mermaid fences render unchanged.

- [ ] **Step 1: Write the failing test for the encode/decode round-trip**

Add to `packages/relay-web/src/__tests__/render-markdown.test.ts`:
```ts
import { encodeMermaidSource, decodeMermaidSource } from "../lib/mermaid-source";

test("mermaid source base64 round-trips including non-ASCII and special chars", () => {
  const src = "graph TD\n  A[开始] --> B{判断?}\n  B -->|是/yes| C[\"</code> & <script>\"]";
  const encoded = encodeMermaidSource(src);
  expect(encoded).toMatch(/^[A-Za-z0-9+/=]+$/); // base64 alphabet only — safe in an attribute
  expect(decodeMermaidSource(encoded)).toBe(src);
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd packages/relay-web && npx vitest run src/__tests__/render-markdown.test.ts`
Expected: FAIL — `../lib/mermaid-source` does not exist.

- [ ] **Step 3: Create the encode/decode module**

Create `packages/relay-web/src/lib/mermaid-source.ts`:
```ts
// UTF-8-safe base64 for carrying a mermaid diagram's source through an HTML data
// attribute. `btoa` only handles Latin-1, so encode to UTF-8 bytes first (the classic
// `encodeURIComponent`/`escape` bridge) — diagram labels are frequently non-ASCII.

/** Encode a diagram's source to attribute-safe base64 (alphabet `[A-Za-z0-9+/=]`). */
export function encodeMermaidSource(src: string): string {
  return btoa(unescape(encodeURIComponent(src)));
}

/** Inverse of {@link encodeMermaidSource}. */
export function decodeMermaidSource(encoded: string): string {
  return decodeURIComponent(escape(atob(encoded)));
}
```

- [ ] **Step 4: Run the round-trip test to verify it passes**

Run: `cd packages/relay-web && npx vitest run src/__tests__/render-markdown.test.ts`
Expected: the round-trip test PASSES (fence-override tests below still to come).

- [ ] **Step 5: Write the failing tests for the fence override**

Add to `packages/relay-web/src/__tests__/render-markdown.test.ts`:
```ts
import { renderMarkdown } from "../lib/render-markdown";

test("a mermaid fence becomes a placeholder carrying the base64 source", () => {
  const html = renderMarkdown("```mermaid\ngraph TD\n  A --> B\n```");
  expect(html).toContain('class="mermaid-block"');
  const match = html.match(/data-mermaid="([^"]+)"/);
  expect(match).not.toBeNull();
  expect(decodeMermaidSource(match![1]!)).toBe("graph TD\n  A --> B\n");
  // The visible fallback keeps the (escaped) source, never blank.
  expect(html).toContain("graph TD");
});

test("a mermaid fence source cannot inject markup", () => {
  const html = renderMarkdown("```mermaid\n<script>alert(1)</script>\n```");
  expect(html).not.toContain("<script>alert(1)</script>"); // escaped in fallback, raw source only in base64
});

test("a non-mermaid fence is rendered unchanged (no mermaid-block class)", () => {
  const html = renderMarkdown("```ts\nconst a = 1;\n```");
  expect(html).not.toContain("mermaid-block");
  expect(html).toContain("<pre"); // ordinary code block
  expect(html).toContain("const a = 1;");
});
```

- [ ] **Step 6: Run to verify they fail**

Run: `cd packages/relay-web && npx vitest run src/__tests__/render-markdown.test.ts`
Expected: FAIL — mermaid fences currently render as ordinary code blocks (no `mermaid-block`).

- [ ] **Step 7: Add the fence override to `render-markdown.ts`**

In `packages/relay-web/src/lib/render-markdown.ts`, add the import at the top:
```ts
import { encodeMermaidSource } from "./mermaid-source";
```
Then, immediately after the existing `md.renderer.rules.table_close = ...` line, add:
```ts
// Intercept ```mermaid fences: emit a placeholder carrying the diagram source as
// attribute-safe base64. render-mermaid hydrates it into SVG after the HTML is mounted.
// The escaped <code> is the fallback shown before hydration, while streaming, and on
// render error. All other fences fall through to markdown-it's default renderer.
const defaultFence =
  md.renderer.rules.fence ??
  ((tokens, idx, options, _env, self) => self.renderToken(tokens, idx, options));
md.renderer.rules.fence = (tokens, idx, options, env, self) => {
  const token = tokens[idx]!;
  const info = token.info.trim().split(/\s+/g)[0]?.toLowerCase() ?? "";
  if (info !== "mermaid") {
    return defaultFence(tokens, idx, options, env, self);
  }
  const encoded = encodeMermaidSource(token.content);
  const fallback = md.utils.escapeHtml(token.content);
  return `<pre class="mermaid-block" data-mermaid="${encoded}"><code>${fallback}</code></pre>`;
};
```

- [ ] **Step 8: Run all render-markdown tests to verify they pass**

Run: `cd packages/relay-web && npx vitest run src/__tests__/render-markdown.test.ts src/__tests__/normalize-markdown.test.ts`
Expected: PASS — new mermaid cases pass, all pre-existing markdown cases still pass.

- [ ] **Step 9: Commit**

```bash
git add packages/relay-web/src/lib/mermaid-source.ts packages/relay-web/src/lib/render-markdown.ts packages/relay-web/src/__tests__/render-markdown.test.ts
git commit -m "feat(relay-web): emit placeholder for mermaid fences in render-markdown"
```

---

### Task 3: `render-mermaid` — lazy, cached, error-tolerant SVG hydration

**Files:**
- Create: `packages/relay-web/src/lib/render-mermaid.ts`
- Test: `packages/relay-web/src/__tests__/render-mermaid.test.ts`

**Interfaces:**
- Consumes: `decodeMermaidSource` from `./mermaid-source`; the placeholder shape from Task 2 (`pre.mermaid-block[data-mermaid]`).
- Produces:
  - `type MermaidTheme = "dark" | "light"`
  - `hydrateMermaidBlocks(root: HTMLElement, theme: MermaidTheme): Promise<void>` — renders every un-rendered block under `root`; never throws.
  - `resetMermaidBlocks(root: HTMLElement): void` — reverts rendered blocks to their code fallback (for a theme re-render).
  - `__setMermaidLoaderForTest(loader: null | (() => Promise<MermaidLike>)): void` — injects a fake loader and resets module state (cache/counter/init) for tests.

- [ ] **Step 1: Write the failing tests**

Create `packages/relay-web/src/__tests__/render-mermaid.test.ts`:
```ts
import { afterEach, expect, test, vi } from "vitest";
import {
  hydrateMermaidBlocks,
  resetMermaidBlocks,
  __setMermaidLoaderForTest,
  type MermaidTheme,
} from "../lib/render-mermaid";
import { encodeMermaidSource } from "../lib/mermaid-source";

function block(src: string): HTMLElement {
  const root = document.createElement("div");
  root.innerHTML = `<pre class="mermaid-block" data-mermaid="${encodeMermaidSource(src)}"><code>${src}</code></pre>`;
  return root;
}

afterEach(() => __setMermaidLoaderForTest(null));

test("hydrate replaces the placeholder with sanitized SVG and marks it done", async () => {
  __setMermaidLoaderForTest(() =>
    Promise.resolve({
      initialize: () => {},
      render: async (_id: string, text: string) => ({
        svg: `<svg data-src="${text.length}"><text>ok</text><script>alert(1)</script></svg>`,
      }),
    }),
  );
  const root = block("graph TD\n A-->B");
  await hydrateMermaidBlocks(root, "dark");
  const pre = root.querySelector("pre.mermaid-block")!;
  expect(pre.querySelector("svg")).not.toBeNull();
  expect(pre.querySelector("script")).toBeNull(); // DOMPurify svg profile strips it
  expect(pre.getAttribute("data-mermaid-done")).toBe("1");
  expect(pre.classList.contains("mermaid-rendered")).toBe(true);
});

test("hydrate caches by theme+source: identical re-hydrate does not re-invoke render", async () => {
  const render = vi.fn(async (_id: string, _text: string) => ({ svg: "<svg><text>x</text></svg>" }));
  __setMermaidLoaderForTest(() => Promise.resolve({ initialize: () => {}, render }));
  const a = block("graph TD\n A-->B");
  const b = block("graph TD\n A-->B");
  await hydrateMermaidBlocks(a, "dark");
  await hydrateMermaidBlocks(b, "dark");
  expect(render).toHaveBeenCalledTimes(1); // second block served from cache
  await hydrateMermaidBlocks(block("graph TD\n A-->B"), "light");
  expect(render).toHaveBeenCalledTimes(2); // different theme → separate render
});

test("a failing render marks the block as error and keeps the code fallback", async () => {
  __setMermaidLoaderForTest(() =>
    Promise.resolve({ initialize: () => {}, render: async () => { throw new Error("bad diagram"); } }),
  );
  const root = block("not a diagram");
  await hydrateMermaidBlocks(root, "dark"); // must not throw
  const pre = root.querySelector("pre.mermaid-block")!;
  expect(pre.getAttribute("data-mermaid-done")).toBe("error");
  expect(pre.classList.contains("mermaid-error")).toBe(true);
  expect(pre.querySelector("code")?.textContent).toBe("not a diagram");
  expect(pre.querySelector("svg")).toBeNull();
});

test("resetMermaidBlocks reverts a rendered block to its code fallback", async () => {
  __setMermaidLoaderForTest(() =>
    Promise.resolve({ initialize: () => {}, render: async () => ({ svg: "<svg><text>x</text></svg>" }) }),
  );
  const root = block("graph TD\n A-->B");
  await hydrateMermaidBlocks(root, "dark");
  resetMermaidBlocks(root);
  const pre = root.querySelector("pre.mermaid-block")!;
  expect(pre.hasAttribute("data-mermaid-done")).toBe(false);
  expect(pre.querySelector("svg")).toBeNull();
  expect(pre.querySelector("code")?.textContent).toBe("graph TD\n A-->B");
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `cd packages/relay-web && npx vitest run src/__tests__/render-mermaid.test.ts`
Expected: FAIL — `../lib/render-mermaid` does not exist.

- [ ] **Step 3: Implement `render-mermaid.ts`**

Create `packages/relay-web/src/lib/render-mermaid.ts`:
```ts
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
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd packages/relay-web && npx vitest run src/__tests__/render-mermaid.test.ts`
Expected: PASS — all four cases.

- [ ] **Step 5: Typecheck**

Run: `cd packages/relay-web && npx vue-tsc --noEmit`
Expected: passes (confirms `import('mermaid')` resolves against the dep from Task 1).

- [ ] **Step 6: Commit**

```bash
git add packages/relay-web/src/lib/render-mermaid.ts packages/relay-web/src/__tests__/render-mermaid.test.ts
git commit -m "feat(relay-web): lazy, cached, error-tolerant mermaid SVG hydration"
```

---

### Task 4: Drive hydration from `StreamMarkdown.vue` (+ styling + docs)

**Files:**
- Modify: `packages/relay-web/src/components/StreamMarkdown.vue`
- Test: `packages/relay-web/src/__tests__/streammarkdown.test.ts` (add cases)
- Modify: `docs/relay-web-module.md` (note the mermaid seam)

**Interfaces:**
- Consumes: `hydrateMermaidBlocks`, `resetMermaidBlocks` from `../lib/render-mermaid`; `useThemeStore` from `../stores/theme`.
- Produces: hydration is driven only when `streaming` is false; theme change re-hydrates; unmount is safe.

- [ ] **Step 1: Write the failing tests**

Add to `packages/relay-web/src/__tests__/streammarkdown.test.ts` (mock the render-mermaid module so no real mermaid loads):
```ts
import { vi } from "vitest";

const hydrate = vi.fn(async () => {});
const reset = vi.fn(() => {});
vi.mock("../lib/render-mermaid", () => ({
  hydrateMermaidBlocks: (...a: unknown[]) => hydrate(...a),
  resetMermaidBlocks: (...a: unknown[]) => reset(...a),
}));

// ...inside the existing describe/suite, after mount helpers:

test("does not hydrate mermaid while streaming", async () => {
  hydrate.mockClear();
  const wrapper = mount(StreamMarkdown, { props: { text: "```mermaid\ngraph TD\nA-->B\n```", streaming: true } });
  await nextTick();
  await nextTick();
  expect(hydrate).not.toHaveBeenCalled();
  wrapper.unmount();
});

test("hydrates mermaid once streaming ends", async () => {
  hydrate.mockClear();
  const wrapper = mount(StreamMarkdown, { props: { text: "```mermaid\ngraph TD\nA-->B\n```", streaming: true } });
  await nextTick();
  await wrapper.setProps({ streaming: false });
  await nextTick();
  await nextTick();
  expect(hydrate).toHaveBeenCalled();
  wrapper.unmount();
});

test("hydrates a non-streaming (finalized) message on mount", async () => {
  hydrate.mockClear();
  const wrapper = mount(StreamMarkdown, { props: { text: "```mermaid\ngraph TD\nA-->B\n```", streaming: false } });
  await nextTick();
  await nextTick();
  expect(hydrate).toHaveBeenCalled();
  wrapper.unmount();
});
```
(If the test file does not already import `nextTick`, `mount`, and a Pinia setup, mirror the existing imports/`setActivePinia(createPinia())` pattern used by the other tests in this file.)

- [ ] **Step 2: Run to verify they fail**

Run: `cd packages/relay-web && npx vitest run src/__tests__/streammarkdown.test.ts`
Expected: FAIL — `hydrate` is never called (component does no hydration yet).

- [ ] **Step 3: Wire hydration into `StreamMarkdown.vue`**

Replace the `<script setup>` block of `packages/relay-web/src/components/StreamMarkdown.vue` with (changes: template ref, theme store, hydration scheduling; the existing throttle logic is preserved verbatim):
```ts
<script setup lang="ts">
import { nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { renderMarkdown } from "../lib/render-markdown";
import { hydrateMermaidBlocks, resetMermaidBlocks } from "../lib/render-mermaid";
import { useThemeStore } from "../stores/theme";

const props = defineProps<{ text: string; streaming?: boolean }>();

// While streaming, every appended chunk grows `text`, and re-parsing the WHOLE buffer
// (healing + markdown-it + DOMPurify) per chunk is O(n²) over the turn. Throttle the parse
// to one render per THROTTLE_MS with a trailing call, so the last chunk always lands. The
// non-streaming path renders synchronously on every change, exactly like the old computed.
const THROTTLE_MS = 80;

const theme = useThemeStore();
const rootEl = ref<HTMLElement | null>(null);
const html = ref("");
let timer: ReturnType<typeof setTimeout> | null = null;
let lastRenderAt = 0;
let disposed = false;

function cancelTimer(): void {
  if (timer !== null) {
    clearTimeout(timer);
    timer = null;
  }
}

// Mermaid blocks are hydrated only when NOT streaming: a mid-stream fence (auto-closed by
// remend) holds a partial diagram that mermaid would fail to parse. During streaming the
// block shows its source (the <code> fallback); the finalized render hydrates it to SVG.
function scheduleHydrate(reset: boolean): void {
  if (props.streaming) return;
  void nextTick(() => {
    if (disposed || rootEl.value === null) return;
    if (reset) resetMermaidBlocks(rootEl.value);
    void hydrateMermaidBlocks(rootEl.value, theme.mode);
  });
}

function render(): void {
  lastRenderAt = Date.now();
  html.value = renderMarkdown(props.text, { streaming: props.streaming });
  scheduleHydrate(false);
}

render(); // initial synchronous render (also seeds the throttle clock)
onMounted(() => scheduleHydrate(false)); // rootEl exists only after mount

watch(
  () => props.text,
  () => {
    if (!props.streaming) {
      cancelTimer();
      render();
      return;
    }
    const elapsed = Date.now() - lastRenderAt;
    if (elapsed >= THROTTLE_MS) {
      cancelTimer();
      render();
      return;
    }
    // Trailing edge: one pending render picks up whatever `text` holds when it fires.
    if (timer === null) {
      timer = setTimeout(() => {
        timer = null;
        render();
      }, THROTTLE_MS - elapsed);
    }
  },
);

// Streaming ended (or toggled): drop any pending throttled render and paint the
// final full text immediately — the closing frame must never lag or be skipped.
watch(
  () => props.streaming,
  () => {
    cancelTimer();
    render();
  },
);

// Theme switched: re-theme any already-rendered diagrams (the SVG cache is theme-keyed).
watch(
  () => theme.mode,
  () => scheduleHydrate(true),
);

onBeforeUnmount(() => {
  disposed = true;
  cancelTimer();
});
</script>
```
Then update the template's root element to bind the ref:
```html
<template>
  <!-- eslint-disable-next-line vue/no-v-html -- input is sanitized by renderMarkdown (DOMPurify) -->
  <div ref="rootEl" class="stream-md text-sm" v-html="html" />
</template>
```

- [ ] **Step 4: Add mermaid block styling to the same file's `<style>`**

Append to the `<style>` block in `StreamMarkdown.vue` (after the `.stream-md hr` rule):
```css
/* Mermaid: the pre.mermaid-block is a code-styled fallback until hydrated. Once rendered,
   center the SVG and let a wide diagram scroll like a wide table instead of overflowing. */
.stream-md .mermaid-block.mermaid-rendered {
  background: transparent;
  border: none;
  box-shadow: none;
  padding: 0;
  overflow-x: auto;
  text-align: center;
}
.stream-md .mermaid-block.mermaid-rendered svg {
  max-width: 100%;
  height: auto;
}
.stream-md .mermaid-block.mermaid-error {
  border-color: rgb(var(--c-danger, var(--c-border)));
}
```

- [ ] **Step 5: Run the component + full relay-web suite**

Run: `cd packages/relay-web && npx vitest run`
Expected: new StreamMarkdown cases pass; all pre-existing tests (streammarkdown, messagelist, chat, render-markdown, etc.) still pass.

- [ ] **Step 6: Typecheck the whole package**

Run: `cd packages/relay-web && npx vue-tsc --noEmit`
Expected: passes.

- [ ] **Step 7: Document the seam**

In `docs/relay-web-module.md`, add a short subsection under the markdown/rendering area (match the file's existing heading style):
```markdown
### Mermaid diagrams

` ```mermaid ` fences render to SVG. Pipeline: `render-markdown` emits a
`<pre class="mermaid-block" data-mermaid="<base64 source>">` placeholder (fence override);
`render-mermaid` lazily `import('mermaid')`s, renders each placeholder to SVG under
`securityLevel: "strict"`, DOMPurifies it (svg profile), and caches by `theme+source`;
`StreamMarkdown.vue` hydrates after `v-html` patches — never mid-stream (a partial fence
would fail to parse), re-hydrating on theme change. Malformed diagrams keep the source as a
code fallback. Non-relay-web channels (WeChat/terminal) remain text-only.
```

- [ ] **Step 8: Commit**

```bash
git add packages/relay-web/src/components/StreamMarkdown.vue packages/relay-web/src/__tests__/streammarkdown.test.ts docs/relay-web-module.md
git commit -m "feat(relay-web): render mermaid diagrams in chat markdown"
```

---

## Self-Review

**Spec coverage:** library decision (Task 1) ✓; placeholder emission + base64 + security (Task 2) ✓; lazy/cached/error-tolerant/theme-keyed hydration (Task 3) ✓; streaming-gated hydration + theme re-render + unmount safety + styling + docs (Task 4) ✓. All spec test bullets map to a task's tests.

**Placeholder scan:** every code step contains full code; no TBD/TODO.

**Type consistency:** `MermaidTheme = "dark"|"light"` matches `theme.mode` (`ThemeMode = "dark"|"light"`). `hydrateMermaidBlocks(root, theme)` / `resetMermaidBlocks(root)` signatures identical across Task 3 (definition), Task 3 tests, and Task 4 (call sites + mock). `encodeMermaidSource`/`decodeMermaidSource` inverse pair used in Tasks 2 and 3. Placeholder shape `pre.mermaid-block[data-mermaid]` identical across producer (Task 2), hydrator/selector (Task 3), and tests.
