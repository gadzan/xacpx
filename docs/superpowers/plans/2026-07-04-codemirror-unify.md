# CodeMirror-unify the file viewer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Serve both read and edit in the relay-web file viewer from a single CodeMirror 6 instance and remove Shiki entirely, keeping all file-content interactions behaviourally the same except two accepted changes (search UI → CM's native panel; long-tail languages → plain text).

**Architecture:** `CodeEditor.vue` becomes the one file renderer — a single always-mounted `EditorView` toggled read-only↔editable via a `Compartment`, with a github-tuned `HighlightStyle`, CM's native search panel, line-number gutter, and a scroll-to-line+flash effect. `FileViewer.vue` drops the Shiki `v-html` path and the bespoke find bar, binds the editor to a `content` buffer, and keeps the entire edit/save/stale/close-guard write path from the file-edit-save feature intact. Shiki, `dom-line-highlight`, and `find-in-lines` are deleted.

**Tech Stack:** Vue 3 `<script setup>`, Pinia, Tailwind v3, CodeMirror 6 (`codemirror` basicSetup, `@codemirror/state|view|search|language|commands`, `@codemirror/lang-*`, `@lezer/highlight`), vitest/jsdom.

## Global Constraints

- **Web tests + typecheck run FROM the package dir, never `bun test`.** The persistent shell cwd drifts back to repo root after any `cd repo && git …` — ALWAYS re-`cd /Users/maijiazhen/Projects/workspace-a/packages/relay-web` immediately before each `npx vitest` / `npx vue-tsc` command, or it runs in a node env and false-fails with "document is not defined".
- Web typecheck must stay at **0 errors**: `cd packages/relay-web && npx vue-tsc --noEmit`.
- **Dependency changes sync the root lock:** after editing `packages/relay-web/package.json`, run `cd packages/relay-web && bun install` then `cd ../.. && npm install --package-lock-only` (CI `npm ci` fails otherwise). Commit `packages/relay-web/package.json`, the root `bun.lock`, and root `package-lock.json` together.
- **CSP:** everything must bundle — no CDN/remote assets. CodeMirror is pure ESM (safe).
- **Common languages only** (first-party `@codemirror/lang-*`): javascript (js/mjs/cjs/jsx/ts/tsx), json, html/htm, css/scss/less, markdown (md), python (py), yaml/yml, vue, xml, sql. Every other extension → plain text. NO `@codemirror/legacy-modes`.
- **jsdom noise:** `src/__tests__/setup.ts` already stubs `Range.prototype.getClientRects`/`getBoundingClientRect` so CodeMirror mounts quietly. Keep test output pristine.
- **`git add` explicit paths only** — never `git add -A`.
- **i18n parity** (enforced by `i18n-parity.test.ts`): keys must match between `messages/en.ts` and `messages/zh-CN.ts`.
- **The write path is sacrosanct:** the pencil/Save/Cancel/dirty-dot controls, `files.saveFile`, the `baseRev` `{mtimeMs,size}` token, the stale-write reload banner (draft preserved), the error mapping, and the center-tabs `closeTabGuarded` unsaved-changes guard must keep working unchanged.

---

### Task 1: `lib/cm-theme.ts` — github HighlightStyle + syntax CSS tokens + deps

**Files:**
- Modify: `packages/relay-web/package.json` (add deps)
- Modify: root `package-lock.json`, root `bun.lock` (lock sync)
- Create: `packages/relay-web/src/lib/cm-theme.ts`
- Modify: `packages/relay-web/src/style.css` (add `--c-syn-*` tokens)
- Test: `packages/relay-web/src/__tests__/cm-theme.test.ts`

**Interfaces:**
- Produces: `export const githubHighlight: Extension` — a `Prec.high`-wrapped `syntaxHighlighting(HighlightStyle)` that colours common Lezer tags via `--c-syn-*` CSS variables. Consumed by Task 2's CodeEditor.

- [ ] **Step 1: Add the dependencies.** In `packages/relay-web/package.json` `dependencies`, add:

```json
    "@codemirror/language": "^6.0.0",
    "@codemirror/lang-sql": "^6.0.0",
    "@codemirror/lang-xml": "^6.0.0",
    "@codemirror/search": "^6.0.0",
    "@lezer/highlight": "^1.0.0",
```

- [ ] **Step 2: Install and sync locks.**

Run: `cd /Users/maijiazhen/Projects/workspace-a/packages/relay-web && bun install && cd /Users/maijiazhen/Projects/workspace-a && npm install --package-lock-only`
Expected: `bun.lock` + root `package-lock.json` updated, no errors.

- [ ] **Step 3: Write the failing test.** Create `packages/relay-web/src/__tests__/cm-theme.test.ts`:

```ts
import { describe, test, expect } from "vitest";
import { EditorState } from "@codemirror/state";
import { githubHighlight } from "../lib/cm-theme";

describe("cm-theme", () => {
  test("githubHighlight is a usable CodeMirror extension", () => {
    // If it weren't a valid Extension, EditorState.create would throw.
    const state = EditorState.create({ doc: "x", extensions: [githubHighlight] });
    expect(state).toBeTruthy();
  });
});
```

- [ ] **Step 4: Run it to verify it fails.**

Run: `cd /Users/maijiazhen/Projects/workspace-a/packages/relay-web && npx vitest run src/__tests__/cm-theme.test.ts`
Expected: FAIL — cannot resolve `../lib/cm-theme`.

- [ ] **Step 5: Create the theme module.** Write `packages/relay-web/src/lib/cm-theme.ts`:

```ts
import { Prec, type Extension } from "@codemirror/state";
import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { tags as t } from "@lezer/highlight";

// A github-light/dark-ish syntax palette. Colours are CSS variables (--c-syn-*) defined for
// light and .dark in style.css, so light/dark switches purely via CSS with no JS reconfigure
// — the same trick Shiki's dual-theme used. Prec.high so it overrides basicSetup's bundled
// defaultHighlightStyle (which is added at normal precedence inside `basicSetup`).
const githubHighlightStyle = HighlightStyle.define([
  { tag: [t.keyword, t.modifier, t.controlKeyword, t.operatorKeyword, t.moduleKeyword], color: "var(--c-syn-keyword)" },
  { tag: [t.string, t.special(t.string), t.regexp], color: "var(--c-syn-string)" },
  { tag: [t.number, t.bool, t.null, t.atom], color: "var(--c-syn-number)" },
  { tag: [t.comment, t.lineComment, t.blockComment, t.docComment], color: "var(--c-syn-comment)", fontStyle: "italic" },
  { tag: [t.function(t.variableName), t.function(t.propertyName), t.labelName], color: "var(--c-syn-function)" },
  { tag: [t.typeName, t.className, t.namespace, t.definition(t.typeName)], color: "var(--c-syn-type)" },
  { tag: [t.tagName, t.angleBracket], color: "var(--c-syn-tag)" },
  { tag: [t.attributeName], color: "var(--c-syn-attribute)" },
  { tag: [t.propertyName, t.definition(t.propertyName)], color: "var(--c-syn-property)" },
  { tag: [t.constant(t.variableName), t.standard(t.name), t.macroName], color: "var(--c-syn-constant)" },
  { tag: [t.heading, t.strong], color: "var(--c-syn-heading)", fontWeight: "bold" },
  { tag: [t.link, t.url], color: "var(--c-syn-link)", textDecoration: "underline" },
  { tag: [t.meta, t.processingInstruction], color: "var(--c-syn-comment)" },
  { tag: [t.invalid], color: "rgb(var(--c-danger))" },
]);

export const githubHighlight: Extension = Prec.high(syntaxHighlighting(githubHighlightStyle));
```

- [ ] **Step 6: Add the CSS syntax tokens.** In `packages/relay-web/src/style.css`, add (place near the other `--c-*` token definitions; if the light tokens live in `:root` and dark under `.dark`, mirror that structure). Add to the light/`:root` scope:

```css
  --c-syn-keyword: #cf222e;
  --c-syn-string: #0a3069;
  --c-syn-number: #0550ae;
  --c-syn-comment: #6e7781;
  --c-syn-function: #8250df;
  --c-syn-type: #953800;
  --c-syn-tag: #116329;
  --c-syn-attribute: #0550ae;
  --c-syn-property: #0550ae;
  --c-syn-constant: #0550ae;
  --c-syn-heading: #0550ae;
  --c-syn-link: #0a3069;
```

and to the `.dark` scope:

```css
  --c-syn-keyword: #ff7b72;
  --c-syn-string: #a5d6ff;
  --c-syn-number: #79c0ff;
  --c-syn-comment: #8b949e;
  --c-syn-function: #d2a8ff;
  --c-syn-type: #ffa657;
  --c-syn-tag: #7ee787;
  --c-syn-attribute: #79c0ff;
  --c-syn-property: #79c0ff;
  --c-syn-constant: #79c0ff;
  --c-syn-heading: #79c0ff;
  --c-syn-link: #a5d6ff;
```

> Find the existing token blocks first: `grep -n "\-\-c-fg\b" src/style.css` shows where light (`:root`/`html`) and `.dark` tokens are defined; add the `--c-syn-*` lines inside those same two blocks.

- [ ] **Step 7: Run the test to verify it passes.**

Run: `cd /Users/maijiazhen/Projects/workspace-a/packages/relay-web && npx vitest run src/__tests__/cm-theme.test.ts`
Expected: PASS.

- [ ] **Step 8: Typecheck.**

Run: `cd /Users/maijiazhen/Projects/workspace-a/packages/relay-web && npx vue-tsc --noEmit`
Expected: 0 errors.

- [ ] **Step 9: Commit.**

```bash
git add packages/relay-web/package.json packages/relay-web/bun.lock package-lock.json packages/relay-web/src/lib/cm-theme.ts packages/relay-web/src/style.css packages/relay-web/src/__tests__/cm-theme.test.ts
git commit -m "feat(relay-web): github CodeMirror HighlightStyle + syntax CSS tokens"
```

---

### Task 2: `CodeEditor.vue` — unified read/edit renderer

**Files:**
- Modify (rewrite): `packages/relay-web/src/components/CodeEditor.vue`
- Modify (rewrite): `packages/relay-web/src/__tests__/codeeditor.test.ts`

**Interfaces:**
- Consumes: `githubHighlight` from `../lib/cm-theme` (Task 1).
- Produces: `CodeEditor` with props `{ modelValue: string; filename?: string; editable?: boolean; line?: number; lineRev?: number }`, emits `update:modelValue` (string) and `save` (void), and `defineExpose({ view, openSearch })` where `openSearch(): void` opens CM's search panel. `editable` defaults to `false` (read-only). `line`/`lineRev` scroll to (1-based) `line` and flash it whenever `lineRev` changes.

- [ ] **Step 1: Rewrite the test.** Replace `packages/relay-web/src/__tests__/codeeditor.test.ts` with:

```ts
import { describe, test, expect } from "vitest";
import { mount } from "@vue/test-utils";
import CodeEditor from "../components/CodeEditor.vue";

type Exposed = { view: { state: { doc: { toString(): string; length: number }; readOnly: boolean }; dispatch: (t: unknown) => void }; openSearch: () => void };

describe("CodeEditor", () => {
  test("renders content read-only by default", async () => {
    const w = mount(CodeEditor, { props: { modelValue: "hello world", filename: "a.ts" } });
    await new Promise((r) => setTimeout(r, 0));
    expect(w.element.textContent).toContain("hello world");
    const vm = w.vm as unknown as Exposed;
    expect(vm.view.state.readOnly).toBe(true);
    w.unmount();
  });

  test("editable=true makes the document editable and emits update:modelValue", async () => {
    const w = mount(CodeEditor, { props: { modelValue: "a", filename: "a.txt", editable: true } });
    await new Promise((r) => setTimeout(r, 0));
    const vm = w.vm as unknown as Exposed;
    expect(vm.view.state.readOnly).toBe(false);
    vm.view.dispatch({ changes: { from: vm.view.state.doc.length, insert: "b" } });
    await new Promise((r) => setTimeout(r, 0));
    expect(w.emitted("update:modelValue")?.at(-1)?.[0]).toBe("ab");
    w.unmount();
  });

  test("toggling editable reconfigures read-only without remounting", async () => {
    const w = mount(CodeEditor, { props: { modelValue: "a", filename: "a.txt", editable: false } });
    await new Promise((r) => setTimeout(r, 0));
    const vm = w.vm as unknown as Exposed;
    expect(vm.view.state.readOnly).toBe(true);
    await w.setProps({ editable: true });
    await new Promise((r) => setTimeout(r, 0));
    expect(vm.view.state.readOnly).toBe(false);
    w.unmount();
  });

  test("openSearch is exposed and callable", async () => {
    const w = mount(CodeEditor, { props: { modelValue: "abc", filename: "a.txt" } });
    await new Promise((r) => setTimeout(r, 0));
    const vm = w.vm as unknown as Exposed;
    expect(typeof vm.openSearch).toBe("function");
    expect(() => vm.openSearch()).not.toThrow();
    w.unmount();
  });
});
```

- [ ] **Step 2: Run it to verify it fails.**

Run: `cd /Users/maijiazhen/Projects/workspace-a/packages/relay-web && npx vitest run src/__tests__/codeeditor.test.ts`
Expected: FAIL — `view.state.readOnly` undefined / `openSearch` not a function (current component lacks these).

- [ ] **Step 3: Rewrite the component.** Replace `packages/relay-web/src/components/CodeEditor.vue` with:

```vue
<script setup lang="ts">
import { ref, onMounted, onBeforeUnmount, watch } from "vue";
import { EditorState, Compartment, StateEffect, StateField, type Extension } from "@codemirror/state";
import { EditorView, keymap, Decoration, type DecorationSet } from "@codemirror/view";
import { basicSetup } from "codemirror";
import { openSearchPanel } from "@codemirror/search";
import { javascript } from "@codemirror/lang-javascript";
import { json } from "@codemirror/lang-json";
import { html } from "@codemirror/lang-html";
import { css } from "@codemirror/lang-css";
import { markdown } from "@codemirror/lang-markdown";
import { python } from "@codemirror/lang-python";
import { yaml } from "@codemirror/lang-yaml";
import { vue } from "@codemirror/lang-vue";
import { xml } from "@codemirror/lang-xml";
import { sql } from "@codemirror/lang-sql";
import { githubHighlight } from "../lib/cm-theme";

// The one file renderer: a single CodeMirror view that serves BOTH read (editable:false) and
// edit (editable:true), toggled via a Compartment — no remount, no re-highlight, no scroll
// jump. Owns NO file I/O; the parent (FileViewer) loads/saves and drives search/scroll.
const props = defineProps<{ modelValue: string; filename?: string; editable?: boolean; line?: number; lineRev?: number }>();
const emit = defineEmits<{ "update:modelValue": [string]; save: [] }>();

const host = ref<HTMLElement | null>(null);
let view: EditorView | null = null;
const editableComp = new Compartment();

function langFor(name?: string): Extension[] {
  const ext = (name ?? "").split(".").pop()?.toLowerCase() ?? "";
  switch (ext) {
    case "js": case "jsx": case "mjs": case "cjs": return [javascript({ jsx: ext === "jsx" })];
    case "ts": return [javascript({ typescript: true })];
    case "tsx": return [javascript({ typescript: true, jsx: true })];
    case "json": return [json()];
    case "html": case "htm": return [html()];
    case "css": case "scss": case "less": return [css()];
    case "md": case "markdown": return [markdown()];
    case "py": return [python()];
    case "yaml": case "yml": return [yaml()];
    case "vue": return [vue()];
    case "xml": return [xml()];
    case "sql": return [sql()];
    default: return [];
  }
}

function editableExt(on: boolean): Extension {
  return [EditorView.editable.of(on), EditorState.readOnly.of(!on)];
}

// Transient flash-a-line decoration used by scroll-to-line (search-hit clicks).
const flashEffect = StateEffect.define<number | null>();
const flashField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(deco, tr) {
    deco = deco.map(tr.changes);
    for (const e of tr.effects) {
      if (e.is(flashEffect)) {
        deco = e.value == null ? Decoration.none : Decoration.set([Decoration.line({ class: "cm-flash-line" }).range(e.value)]);
      }
    }
    return deco;
  },
  provide: (f) => EditorView.decorations.from(f),
});

const theme = EditorView.theme({
  "&": { height: "100%", backgroundColor: "transparent", color: "rgb(var(--c-fg))", fontSize: "12.5px" },
  "&.cm-focused": { outline: "none" },
  ".cm-scroller": { fontFamily: '"JetBrains Mono", ui-monospace, monospace', lineHeight: "1.6" },
  ".cm-gutters": { backgroundColor: "transparent", color: "rgb(var(--c-fg-muted))", border: "none" },
  ".cm-activeLine": { backgroundColor: "rgb(var(--c-raised) / 0.5)" },
  ".cm-activeLineGutter": { backgroundColor: "rgb(var(--c-raised) / 0.5)" },
  ".cm-selectionBackground, &.cm-focused .cm-selectionBackground": { backgroundColor: "rgb(var(--c-accent) / 0.25)" },
  ".cm-cursor": { borderLeftColor: "rgb(var(--c-accent))" },
});

let flashTimer: ReturnType<typeof setTimeout> | null = null;
function scrollToLine(n: number) {
  if (!view) return;
  const lineNo = Math.min(Math.max(n, 1), view.state.doc.lines);
  const pos = view.state.doc.line(lineNo).from;
  view.dispatch({ effects: [EditorView.scrollIntoView(pos, { y: "center" }), flashEffect.of(pos)] });
  if (flashTimer) clearTimeout(flashTimer);
  flashTimer = setTimeout(() => view?.dispatch({ effects: flashEffect.of(null) }), 1500);
}

onMounted(() => {
  if (!host.value) return;
  view = new EditorView({
    parent: host.value,
    state: EditorState.create({
      doc: props.modelValue,
      extensions: [
        basicSetup,
        theme,
        githubHighlight,
        flashField,
        ...langFor(props.filename),
        editableComp.of(editableExt(props.editable ?? false)),
        keymap.of([{ key: "Mod-s", preventDefault: true, run: () => { emit("save"); return true; } }]),
        EditorView.updateListener.of((u) => {
          if (u.docChanged) emit("update:modelValue", u.state.doc.toString());
        }),
      ],
    }),
  });
  if (props.line != null && props.lineRev != null) scrollToLine(props.line);
});

// External value change (save re-read, cancel-revert) — replace only when it differs.
watch(() => props.modelValue, (v) => {
  if (view && v !== view.state.doc.toString()) {
    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: v } });
  }
});
watch(() => props.editable, (on) => {
  view?.dispatch({ effects: editableComp.reconfigure(editableExt(on ?? false)) });
});
// Re-scroll whenever a new scroll request arrives (lineRev bumps each time).
watch(() => props.lineRev, () => {
  if (props.line != null && props.lineRev != null) scrollToLine(props.line);
});

onBeforeUnmount(() => {
  if (flashTimer) clearTimeout(flashTimer);
  view?.destroy();
  view = null;
});

function openSearch() { if (view) openSearchPanel(view); }
defineExpose({ get view() { return view; }, openSearch });
</script>

<template>
  <div ref="host" data-test="code-editor" class="h-full w-full overflow-auto"></div>
</template>
```

- [ ] **Step 4: Add the flash-line CSS.** In `packages/relay-web/src/style.css`, add:

```css
/* Transient flash when jumping to a line (content-search hit). The decoration is removed
   after ~1.5s by the CodeEditor timer; the animation fades the background over that window. */
.cm-flash-line { animation: cm-flash-fade 1.5s ease-out; }
@keyframes cm-flash-fade {
  0% { background-color: rgb(var(--c-accent) / 0.22); }
  100% { background-color: transparent; }
}
```

- [ ] **Step 5: Run the test to verify it passes.**

Run: `cd /Users/maijiazhen/Projects/workspace-a/packages/relay-web && npx vitest run src/__tests__/codeeditor.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 6: Typecheck.**

Run: `cd /Users/maijiazhen/Projects/workspace-a/packages/relay-web && npx vue-tsc --noEmit`
Expected: 0 errors.

- [ ] **Step 7: Commit.**

```bash
git add packages/relay-web/src/components/CodeEditor.vue packages/relay-web/src/__tests__/codeeditor.test.ts packages/relay-web/src/style.css
git commit -m "feat(relay-web): CodeEditor serves read+edit in one instance (search, line flash, github highlight)"
```

---

### Task 3: `FileViewer.vue` — render the single CodeEditor, drop Shiki + find bar

**Files:**
- Modify (rewrite script + body): `packages/relay-web/src/components/FileViewer.vue`
- Modify (rewrite): `packages/relay-web/src/__tests__/fileviewer.test.ts`

**Interfaces:**
- Consumes: `CodeEditor` (Task 2) with `openSearch`; `files.saveFile`/`readFile`/`readDiff`; center-tabs wiring via emitted `dirty-change`.
- Produces: unchanged public props/emits (`instanceId, workspace, path?, diffPath?, line?, lineRev?`; emits `back, close, dirty-change`).

- [ ] **Step 1: Rewrite the test.** Replace `packages/relay-web/src/__tests__/fileviewer.test.ts` with a version that removes the `vi.mock("../lib/shiki")` block and asserts against the CodeEditor. Use this content:

```ts
import { mount, flushPromises } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import { beforeEach, describe, expect, it, vi } from "vitest";

import FileViewer from "../components/FileViewer.vue";
import { useFilesStore } from "../stores/files";

const TEXT = { workspace: "ws", path: "src/a.ts", content: "one\ntwo\nthree", size: 13, mtimeMs: 1000, truncated: false, binary: false };

let pinia: ReturnType<typeof createPinia>;
beforeEach(() => {
  pinia = createPinia();
  setActivePinia(pinia);
  Object.assign(navigator, { clipboard: { writeText: vi.fn().mockResolvedValue(undefined) } });
});

function mountViewer(props: Record<string, unknown>) {
  return mount(FileViewer, { props: { instanceId: "i1", workspace: "ws", ...props }, global: { plugins: [pinia] } });
}
const settle = async () => { await flushPromises(); await new Promise((r) => setTimeout(r, 0)); };

describe("FileViewer", () => {
  it("loads the file and renders it in the CodeMirror editor (read-only)", async () => {
    const files = useFilesStore();
    vi.spyOn(files, "readFile").mockResolvedValue({ ...TEXT });
    const w = mountViewer({ path: "src/a.ts" });
    await settle();
    expect(files.readFile).toHaveBeenCalledWith("i1", "ws", "src/a.ts");
    expect(w.find('[data-test="code-editor"]').exists()).toBe(true);
    expect(w.get('[data-test="code-editor"]').element.textContent).toContain("one");
    expect(w.get('[data-test="code-editor"]').element.textContent).toContain("three");
  });

  it("Edit → type → Save calls saveFile with the read-time token and new content", async () => {
    const files = useFilesStore();
    vi.spyOn(files, "readFile").mockResolvedValue({ ...TEXT });
    const saveFile = vi.spyOn(files, "saveFile").mockResolvedValue({ path: "src/a.ts", mtimeMs: 2000, size: 4 });
    const w = mountViewer({ path: "src/a.ts" });
    await settle();
    await w.get('[data-test="fv-edit"]').trigger("click");
    // simulate an edit by driving the exposed CM view of the child CodeEditor
    const editor = w.findComponent({ name: "CodeEditor" });
    const view = (editor.vm as unknown as { view: { state: { doc: { length: number } }; dispatch: (t: unknown) => void } }).view;
    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: "new" } });
    await settle();
    await w.get('[data-test="fv-save"]').trigger("click");
    await settle();
    expect(saveFile).toHaveBeenCalledWith("i1", "ws", "src/a.ts", "new", { mtimeMs: 1000, size: 13 });
  });

  it("hides the Edit button for binary and truncated files", async () => {
    const files = useFilesStore();
    vi.spyOn(files, "readFile").mockResolvedValue({ workspace: "ws", path: "b.bin", content: "", size: 9e9, mtimeMs: 1, truncated: true, binary: true });
    const w = mountViewer({ path: "b.bin" });
    await settle();
    expect(w.find('[data-test="fv-edit"]').exists()).toBe(false);
  });

  it("a stale-write error shows the reload banner and stays in edit mode", async () => {
    const files = useFilesStore();
    vi.spyOn(files, "readFile").mockResolvedValue({ ...TEXT });
    vi.spyOn(files, "saveFile").mockRejectedValue(new Error("stale-write"));
    const w = mountViewer({ path: "src/a.ts" });
    await settle();
    await w.get('[data-test="fv-edit"]').trigger("click");
    const editor = w.findComponent({ name: "CodeEditor" });
    const view = (editor.vm as unknown as { view: { state: { doc: { length: number } }; dispatch: (t: unknown) => void } }).view;
    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: "mine" } });
    await settle();
    await w.get('[data-test="fv-save"]').trigger("click");
    await settle();
    expect(w.find('[data-test="fv-save-error"]').exists()).toBe(true);
    expect(w.find('[data-test="code-editor"]').exists()).toBe(true);
  });

  it("the magnifier opens the editor search panel", async () => {
    const files = useFilesStore();
    vi.spyOn(files, "readFile").mockResolvedValue({ ...TEXT });
    const w = mountViewer({ path: "src/a.ts" });
    await settle();
    const editor = w.findComponent({ name: "CodeEditor" });
    const openSearch = vi.fn();
    (editor.vm as unknown as { openSearch: () => void }).openSearch = openSearch;
    await w.get('[data-test="fv-find-toggle"]').trigger("click");
    expect(openSearch).toHaveBeenCalled();
  });
});
```

> The child lookup uses `w.findComponent({ name: "CodeEditor" })`; ensure `CodeEditor.vue` resolves to that name (SFCs infer the name from the filename, so `CodeEditor` is correct). If `findComponent` by name is flaky in this setup, use `w.findComponent(CodeEditor)` with `import CodeEditor from "../components/CodeEditor.vue"`.

- [ ] **Step 2: Run it to verify it fails.**

Run: `cd /Users/maijiazhen/Projects/workspace-a/packages/relay-web && npx vitest run src/__tests__/fileviewer.test.ts`
Expected: FAIL — old FileViewer renders `fv-file-body`/Shiki, not a single `code-editor`; `fv-find-toggle` toggles the old bar, not `openSearch`.

- [ ] **Step 3: Rewrite the FileViewer `<script setup>`.** Replace the entire `<script setup lang="ts"> … </script>` block of `packages/relay-web/src/components/FileViewer.vue` with:

```ts
import { computed, ref, watch, onMounted, onBeforeUnmount } from "vue";
import { ArrowLeft, FileText, FileDiff, X, Search, Pencil, Save as SaveIcon } from "lucide-vue-next";
import { useI18n } from "vue-i18n";
import { useFilesStore } from "../stores/files";
import type { FsDiffResult, FsReadResult } from "@ganglion/xacpx-relay-protocol";
import CodeEditor from "./CodeEditor.vue";
import { parseUnifiedDiff } from "../lib/unified-diff";
import CopyButton from "./CopyButton.vue";

// Roomy file/diff viewer that takes over the center column. A single CodeMirror instance
// (CodeEditor) renders file content for BOTH read and edit — read is editable:false, the
// pencil flips it to editable:true. The write path (save/stale/dirty/close-guard) is
// unchanged from the file-edit-save feature; only the render substrate is CodeMirror now.
const props = defineProps<{
  instanceId: string;
  workspace: string;
  path?: string;
  diffPath?: string;
  line?: number;
  lineRev?: number;
}>();
const emit = defineEmits<{ back: []; close: []; "dirty-change": [boolean] }>();
const { t } = useI18n();
const files = useFilesStore();

const rootEl = ref<HTMLElement | null>(null);
const codeEditor = ref<InstanceType<typeof CodeEditor> | null>(null);

const file = ref<FsReadResult | null>(null);
const diff = ref<FsDiffResult | null>(null);
const loading = ref(false);
const error = ref<string | null>(null);

// The editor buffer. Equals file.content in read mode; diverges while editing.
const content = ref("");

let loadToken = 0;
async function load(): Promise<void> {
  const token = ++loadToken;
  const { instanceId, workspace, path, diffPath } = props;
  loading.value = true;
  error.value = null;
  try {
    if (path) {
      const result = await files.readFile(instanceId, workspace, path);
      if (token !== loadToken) return;
      file.value = result;
      diff.value = null;
      content.value = result.binary ? "" : result.content;
      editing.value = false;
      emit("dirty-change", false);
    } else if (diffPath) {
      const result = await files.readDiff(instanceId, workspace, diffPath);
      if (token !== loadToken) return;
      diff.value = result;
      file.value = null;
    } else {
      file.value = null;
      diff.value = null;
    }
  } catch (e) {
    if (token !== loadToken) return;
    file.value = null;
    diff.value = null;
    error.value = e instanceof Error ? e.message : "read-failed";
  } finally {
    if (token === loadToken) loading.value = false;
  }
}
watch(() => [props.instanceId, props.workspace, props.path, props.diffPath] as const, load, { immediate: true });

const parsedDiff = computed(() => (diff.value?.diff ? parseUnifiedDiff(diff.value.diff) : null));

function fmtSize(n?: number): string {
  if (n === undefined) return "";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

// ── Edit mode ────────────────────────────────────────────────────────────────────────
const editing = ref(false);
const baseRev = ref<{ mtimeMs: number; size: number } | null>(null);
const saving = ref(false);
const saveError = ref<string | null>(null);

const showEditor = computed(() => !!file.value && !file.value.binary);
const canEdit = computed(
  () => !!file.value && !file.value.binary && !file.value.truncated && typeof file.value.mtimeMs === "number",
);
const editDirty = computed(() => editing.value && !!file.value && content.value !== file.value.content);
watch(editDirty, (v) => emit("dirty-change", v));

const saveErrorLabel = computed(() => {
  const code = saveError.value;
  if (!code) return "";
  const known: Record<string, string> = {
    "stale-write": t("files.staleConflict"),
    "files-write-disabled": t("files.writeDisabled"),
    "is-binary": t("files.binaryNotEditable"),
    "file-too-large": t("files.tooLarge"),
  };
  return known[code] ?? code;
});
const isStale = computed(() => saveError.value === "stale-write");

function startEdit() {
  if (!canEdit.value || !file.value) return;
  baseRev.value = { mtimeMs: file.value.mtimeMs, size: file.value.size };
  saveError.value = null;
  editing.value = true;
}
function cancelEdit() {
  if (file.value) content.value = file.value.content; // revert the buffer
  editing.value = false;
  saveError.value = null;
  emit("dirty-change", false);
}
async function save() {
  if (saving.value) return;
  if (!file.value || !baseRev.value) return;
  saving.value = true;
  saveError.value = null;
  try {
    const res = await files.saveFile(props.instanceId, props.workspace, file.value.path, content.value, baseRev.value);
    file.value = { ...file.value, content: content.value, size: res.size, mtimeMs: res.mtimeMs };
    editing.value = false;
    emit("dirty-change", false);
  } catch (e) {
    saveError.value = e instanceof Error ? e.message : "write-failed";
  } finally {
    saving.value = false;
  }
}
// Stale reload: re-read for a fresh token but KEEP the user's edited buffer so they can
// reconcile (do NOT call load(), which would reset `content`).
async function reloadFromDisk() {
  if (!file.value) return;
  try {
    const fresh = await files.readFile(props.instanceId, props.workspace, file.value.path);
    file.value = fresh;
    baseRev.value = { mtimeMs: fresh.mtimeMs, size: fresh.size };
    saveError.value = null;
  } catch (e) {
    saveError.value = e instanceof Error ? e.message : "read-failed";
  }
}

function openSearch() { codeEditor.value?.openSearch(); }

// Cmd/Ctrl-F opens the editor's search panel; Cmd/Ctrl-S saves — both only in the VISIBLE
// pane (every open tab has a mounted, v-show-hidden FileViewer; offsetParent is null while
// hidden, so hidden panes ignore the shortcut).
function onKeydown(e: KeyboardEvent) {
  const visible = !!rootEl.value && rootEl.value.offsetParent !== null;
  if (!visible) return;
  if ((e.metaKey || e.ctrlKey) && (e.key === "s" || e.key === "S") && editing.value) {
    e.preventDefault();
    void save();
    return;
  }
  if ((e.metaKey || e.ctrlKey) && (e.key === "f" || e.key === "F") && showEditor.value) {
    const tgt = e.target as HTMLElement | null;
    // let CodeMirror's own Mod-f handle it when focus is already inside the editor
    if (tgt && (tgt.tagName === "INPUT" || tgt.tagName === "TEXTAREA" || tgt.tagName === "SELECT")) return;
    e.preventDefault();
    openSearch();
  }
}
onMounted(() => document.addEventListener("keydown", onKeydown));
onBeforeUnmount(() => document.removeEventListener("keydown", onKeydown));
```

- [ ] **Step 4: Rewrite the FileViewer `<template>`.** Replace the entire `<template> … </template>` block with:

```html
<template>
  <div ref="rootEl" class="flex h-full flex-1 flex-col bg-bg" data-test="file-viewer-center">
    <!-- header: back + path + meta -->
    <div class="flex h-11 shrink-0 items-center gap-2 border-b border-border bg-surface/60 px-3 backdrop-blur-md">
      <button data-test="fv-back-list" :aria-label="$t('files.backToList')"
              class="flex lg:hidden shrink-0 items-center gap-1.5 whitespace-nowrap rounded-md px-2 py-1 text-[12px] font-medium text-fg-muted transition-colors hover:bg-raised hover:text-fg"
              @click="emit('back')"><ArrowLeft :size="14" class="shrink-0" />{{ $t("files.title") }}</button>
      <button data-test="fv-back" :aria-label="$t('files.back')"
              class="hidden lg:flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-md px-2 py-1 text-[12px] font-medium text-fg-muted transition-colors hover:bg-raised hover:text-fg"
              @click="emit('close')"><ArrowLeft :size="14" class="shrink-0" />{{ $t("files.back") }}</button>
      <span class="h-4 w-px bg-border" aria-hidden="true" />
      <template v-if="file">
        <FileText :size="14" class="shrink-0 text-accent" />
        <span class="truncate font-mono text-[12.5px] text-fg">{{ file.path }}</span>
        <span class="shrink-0 text-[11px] text-fg-muted">{{ fmtSize(file.size) }}</span>
        <span v-if="file.truncated" class="shrink-0 rounded bg-warn/10 px-1 text-[10.5px] text-warn">{{ $t("files.truncated") }}</span>
        <span v-if="file.binary" class="shrink-0 rounded bg-fg/5 px-1 text-[10.5px] text-fg-muted">{{ $t("files.binary") }}</span>
      </template>
      <template v-else-if="props.diffPath">
        <FileDiff :size="14" class="shrink-0 text-accent" />
        <span class="truncate font-mono text-[12.5px] text-fg">{{ props.diffPath }}</span>
      </template>
      <div class="ml-auto flex shrink-0 items-center gap-1">
        <button v-if="showEditor" data-test="fv-find-toggle" :aria-label="$t('files.find')" :title="$t('files.find')"
                class="grid h-7 w-7 place-items-center rounded text-fg-muted transition-colors hover:bg-raised hover:text-fg"
                @click="openSearch()"><Search :size="15" /></button>
        <button v-if="canEdit && !editing" data-test="fv-edit" :aria-label="$t('files.editFile')" :title="$t('files.editFile')"
                class="grid h-7 w-7 place-items-center rounded text-fg-muted transition-colors hover:bg-raised hover:text-fg"
                @click="startEdit()"><Pencil :size="15" /></button>
        <template v-if="editing">
          <span v-if="editDirty" data-test="fv-dirty-dot" class="mr-0.5 h-1.5 w-1.5 rounded-full bg-accent" aria-hidden="true" />
          <button data-test="fv-save" :disabled="saving || !editDirty" :aria-label="$t('files.save')"
                  class="flex h-7 items-center gap-1 rounded px-2 text-[12px] font-medium text-accent transition-colors hover:bg-accent/10 disabled:opacity-40"
                  @click="save()"><SaveIcon :size="14" />{{ saving ? $t("files.saving") : $t("files.save") }}</button>
          <button data-test="fv-cancel" :aria-label="$t('files.cancel')"
                  class="h-7 rounded px-2 text-[12px] font-medium text-fg-muted transition-colors hover:bg-raised hover:text-fg"
                  @click="cancelEdit()">{{ $t("files.cancel") }}</button>
        </template>
        <CopyButton v-if="file && !file.binary && !editing" :text="file.content" />
        <button data-test="fv-close" :aria-label="$t('files.closeFile')"
                class="grid h-7 w-7 place-items-center rounded text-fg-muted transition-colors hover:bg-raised hover:text-fg lg:hidden"
                @click="emit('close')"><X :size="16" /></button>
      </div>
    </div>

    <!-- body -->
    <div class="min-h-0 flex-1 overflow-hidden">
      <div v-if="error" data-test="fv-error" class="m-3 rounded-lg border border-danger/25 bg-danger/10 px-3 py-2 text-sm text-danger">{{ error }}</div>
      <div v-else-if="loading && !file && !diff" data-test="fv-loading" class="p-6 text-sm text-fg-muted">{{ $t("files.loading") }}</div>
      <!-- save error / stale-conflict banner -->
      <div v-if="saveError" data-test="fv-save-error" class="m-3 flex items-center gap-3 rounded-lg border border-danger/25 bg-danger/10 px-3 py-2 text-sm text-danger">
        <span class="min-w-0 flex-1">{{ saveErrorLabel }}</span>
        <button v-if="isStale" data-test="fv-reload" class="shrink-0 rounded bg-danger/15 px-2 py-0.5 text-[12px] font-medium hover:bg-danger/25" @click="reloadFromDisk()">{{ $t("files.reload") }}</button>
      </div>
      <!-- file content: one CodeMirror instance for read (editable:false) + edit (editable:true) -->
      <CodeEditor v-if="showEditor" ref="codeEditor" v-model="content" :filename="file!.path"
                  :editable="editing" :line="props.line" :line-rev="props.lineRev" class="h-full" @save="save()" />
      <div v-else-if="file && file.binary" class="p-6 text-sm text-fg-muted">{{ $t("files.binaryNotShown") }}</div>
      <!-- single-file diff: structured tinted rows -->
      <div v-else-if="props.diffPath && diff" class="h-full overflow-auto thin-scroll">
        <div v-if="parsedDiff && parsedDiff.rows.length" data-test="fv-diff-body" class="font-mono text-[12.5px] leading-relaxed">
          <div v-for="(r, i) in parsedDiff.rows" :key="i" data-test="fv-diff-row" class="flex"
               :class="r.type === 'add' ? 'bg-run/10' : r.type === 'del' ? 'bg-danger/10' : r.type === 'hunk' ? 'bg-info/5' : ''">
            <span class="sticky left-0 w-12 shrink-0 select-none border-r border-border bg-surface px-2 text-right tabular-nums text-fg-muted/70">{{ r.oldNo ?? "" }}</span>
            <span class="w-12 shrink-0 select-none border-r border-border bg-surface px-2 text-right tabular-nums text-fg-muted/70">{{ r.newNo ?? "" }}</span>
            <span class="w-4 shrink-0 select-none text-center" :class="r.type === 'add' ? 'text-run' : r.type === 'del' ? 'text-danger' : 'text-fg-muted/40'">{{ r.type === 'add' ? '+' : r.type === 'del' ? '-' : '' }}</span>
            <span class="whitespace-pre px-2" :class="r.type === 'hunk' ? 'text-info' : 'text-fg'">{{ r.text }}</span>
          </div>
        </div>
        <div v-else class="p-6 text-sm text-fg-muted">{{ $t("files.noDiffContent") }}</div>
        <div v-if="diff.truncated" class="px-4 py-1 text-xs text-warn">{{ $t("files.diffTruncated") }}</div>
      </div>
    </div>
  </div>
</template>
```

- [ ] **Step 5: Run the test to verify it passes.**

Run: `cd /Users/maijiazhen/Projects/workspace-a/packages/relay-web && npx vitest run src/__tests__/fileviewer.test.ts`
Expected: PASS (all cases).

- [ ] **Step 6: Typecheck.**

Run: `cd /Users/maijiazhen/Projects/workspace-a/packages/relay-web && npx vue-tsc --noEmit`
Expected: 0 errors. (If it flags `codeEditor.value?.openSearch`, ensure `CodeEditor` exposes `openSearch` via `defineExpose` — it does, from Task 2.)

- [ ] **Step 7: Commit.**

```bash
git add packages/relay-web/src/components/FileViewer.vue packages/relay-web/src/__tests__/fileviewer.test.ts
git commit -m "feat(relay-web): file viewer renders content via the unified CodeEditor (Shiki read path removed)"
```

---

### Task 4: Delete Shiki, the DOM-search helpers, their tests, CSS, deps, and orphan i18n

**Files:**
- Delete: `packages/relay-web/src/lib/shiki.ts`, `src/lib/dom-line-highlight.ts`, `src/lib/find-in-lines.ts`
- Delete: `packages/relay-web/src/__tests__/shiki.test.ts`, `src/__tests__/dom-line-highlight.test.ts`, `src/__tests__/find-in-lines.test.ts`
- Modify: `packages/relay-web/src/style.css` (remove `.shiki` blocks)
- Modify: `packages/relay-web/package.json` (remove Shiki deps) + lock sync
- Modify: `packages/relay-web/src/i18n/messages/en.ts`, `messages/zh-CN.ts` (remove orphaned find keys)

**Interfaces:** none (removal only).

- [ ] **Step 1: Confirm nothing still imports the doomed modules.**

Run: `cd /Users/maijiazhen/Projects/workspace-a/packages/relay-web && grep -rn "lib/shiki\|dom-line-highlight\|find-in-lines" src --include=*.ts --include=*.vue | grep -v __tests__`
Expected: no output (Task 3 removed FileViewer's imports). If anything prints, STOP and fix that consumer first.

- [ ] **Step 2: Delete the modules and their tests.**

```bash
cd /Users/maijiazhen/Projects/workspace-a
git rm packages/relay-web/src/lib/shiki.ts packages/relay-web/src/lib/dom-line-highlight.ts packages/relay-web/src/lib/find-in-lines.ts \
       packages/relay-web/src/__tests__/shiki.test.ts packages/relay-web/src/__tests__/dom-line-highlight.test.ts packages/relay-web/src/__tests__/find-in-lines.test.ts
```

- [ ] **Step 3: Remove the Shiki CSS.** In `packages/relay-web/src/style.css`, delete the entire block from the comment `/* Shiki syntax highlighting — dual theme via CSS vars, line numbers via counters. */` through the closing `}` of `@keyframes line-flash-fade` (the `.shiki`, `.shiki span`, `.dark .shiki`, `.shiki code`, `.shiki code .line`, `.shiki code .line::before`, `.shiki mark.search-hit`, `.shiki mark.search-hit.is-current`, `.shiki code .line.line-flash`, and `@keyframes line-flash-fade` rules). Leave the `--c-syn-*` tokens (Task 1) and `.cm-flash-line` (Task 2) intact.

- [ ] **Step 4: Remove the Shiki dependencies.** In `packages/relay-web/package.json`, delete the `dependencies` entries `"shiki"`, `"@shikijs/langs"`, and `"@shikijs/themes"`.

- [ ] **Step 5: Remove the orphaned find i18n keys.** The bespoke find bar is gone. In `packages/relay-web/src/i18n/messages/en.ts` and `messages/zh-CN.ts`, remove these keys from the `files` object in BOTH files (keep everything else, including `find` if the magnifier button still uses `$t('files.find')` — it does, so KEEP `find`; remove only the ones no longer referenced): remove `findPlaceholder`, `findNone`, `findPrev`, `findNext`, `findClose`.

> Verify what's still referenced first: `grep -rn "files.find" src --include=*.vue`. Keep every key that still appears; delete only the now-unreferenced ones. The `i18n-parity` test will fail if en and zh-CN diverge, so remove the same keys from both.

- [ ] **Step 6: Sync locks.**

Run: `cd /Users/maijiazhen/Projects/workspace-a/packages/relay-web && bun install && cd /Users/maijiazhen/Projects/workspace-a && npm install --package-lock-only`
Expected: Shiki packages removed from both locks.

- [ ] **Step 7: Verify the suite + typecheck are green.**

Run: `cd /Users/maijiazhen/Projects/workspace-a/packages/relay-web && npx vitest run && npx vue-tsc --noEmit`
Expected: all tests pass (Shiki/find-in-lines/dom-line-highlight test files are gone); 0 type errors; `i18n-parity` green.

- [ ] **Step 8: Commit.**

```bash
git add packages/relay-web/package.json packages/relay-web/bun.lock package-lock.json packages/relay-web/src/style.css packages/relay-web/src/i18n/messages/en.ts packages/relay-web/src/i18n/messages/zh-CN.ts
git commit -m "chore(relay-web): remove Shiki + DOM-search helpers, now unused after CodeMirror unify"
```

---

### Task 5: Integration — full build, typecheck, and test sweep

**Files:** none (verification only)

- [ ] **Step 1: Full relay-web suite.**

Run: `cd /Users/maijiazhen/Projects/workspace-a/packages/relay-web && npx vitest run`
Expected: all pass; stderr pristine (no `getClientRects` noise — setup.ts stub covers it).

- [ ] **Step 2: Web typecheck.**

Run: `cd /Users/maijiazhen/Projects/workspace-a/packages/relay-web && npx vue-tsc --noEmit`
Expected: 0 errors.

- [ ] **Step 3: Full package build (bundles relay-web into the hub).**

Run: `cd /Users/maijiazhen/Projects/workspace-a && bun run build:packages`
Expected: completes; prints `bundled relay-web dashboard -> …`; no `FATAL`.

- [ ] **Step 4: Publish verification.**

Run: `cd /Users/maijiazhen/Projects/workspace-a && bun run verify:publish`
Expected: `Publish verification passed.`

- [ ] **Step 5: Confirm Shiki is gone from the bundle inputs.**

Run: `cd /Users/maijiazhen/Projects/workspace-a && grep -rn "shiki" packages/relay-web/src packages/relay-web/package.json || echo "no shiki references remain"`
Expected: `no shiki references remain`.

---

## Self-Review Notes

- **Spec §1 (unify on one CM, remove Shiki)** → Task 2 (one CodeEditor read+edit), Task 4 (delete Shiki). ✓
- **Spec §2 (single instance, write path retained)** → Task 3 (content buffer, canEdit/save/stale/dirty/reload preserved). ✓
- **Spec §3 (CM search, line numbers, scroll+flash)** → Task 2 (`openSearch`, basicSetup gutter, flash effect) + Task 3 (magnifier→openSearch, line/lineRev wired). ✓
- **Spec §4 (common langs + github theme via CSS vars)** → Task 1 (cm-theme + `--c-syn-*`) + Task 2 (`langFor` incl xml/sql, plaintext default). ✓
- **Spec §5 (drop 5000-line fallback)** → Task 3 removes `LINE_GUTTER_LIMIT`. ✓
- **Spec §6 (deletions + deps)** → Task 1 (add) + Task 4 (delete + remove deps). ✓
- **Spec §7 (interaction parity)** → Task 3 tests (load/edit/save/binary/truncated/stale/search) + Task 5 sweep. ✓
- **Spec §8 (testing)** → each task ships tests; Task 5 sweeps. ✓
- **Spec §9 (out of scope)** → no legacy-modes; diff view carried over unchanged in Task 3. ✓
- **Spec §10 (release)** → UI-only hub bump; handled at release time, not in this plan.
- **Type consistency:** `githubHighlight` (Task 1) consumed in Task 2; `openSearch`/`view` exposed in Task 2 consumed in Task 3; `content` buffer + `baseRev` + `saveFile(...,content.value,baseRev.value)` consistent across Task 3.
