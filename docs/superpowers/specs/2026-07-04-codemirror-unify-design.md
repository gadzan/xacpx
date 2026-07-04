# Unify the relay-web file viewer on a single CodeMirror 6 stack

**Status:** approved (design)
**Date:** 2026-07-04
**Scope:** relay-web only (UI). No wire-protocol or backend change.

## 1. Goal

Today the file viewer uses **two** highlighting stacks: Shiki (read-only view, with a
bespoke DOM-overlay find bar and scroll-to-line) and CodeMirror 6 (edit mode, from the
file-edit-save feature). Unify everything onto **one CodeMirror 6 instance** that serves
both read and edit, and remove Shiki entirely.

Hard requirement: **all file-content interactions stay behaviourally the same** except
two consciously-accepted changes (see §7).

Verified context that makes this safe:

- Shiki is imported by **only** `FileViewer.vue` (via `lib/shiki.ts`); the chat/markdown
  renderer does not use it. `lib/dom-line-highlight.ts` and `lib/find-in-lines.ts` are
  used only by `FileViewer.vue`. So Shiki and both helpers can be deleted outright.
- The current Shiki setup uses the **JavaScript regex engine** (not the WASM/oniguruma
  one), so it is CSP-safe; CodeMirror (incl. `@codemirror/search`) is likewise pure ESM,
  self-contained, CSP-safe.

## 2. Architecture: one always-mounted editor, read↔edit by toggle

`FileViewer.vue` renders a **single** `CodeEditor` (CodeMirror) for a text file instead of
today's Shiki `v-html` read body swapped for a separate edit-mode editor.

- Read is `editable: false` (a read-only editor); the pencil sets `editable: true`; Save /
  Cancel return to read-only. The **same EditorView** persists — no view swap, no
  re-highlight, no scroll jump.
- The draft **is** the document. `dirty = editing && doc !== loadedContent`. `baseRev`
  (`{mtimeMs,size}`) is still snapshotted when entering edit.
- **The entire write path from the file-edit-save feature is retained unchanged** — the
  pencil/Save/Cancel controls, `files.saveFile`, the stale-write reload banner, the error
  mapping, the dirty dot, and the center-tabs `closeTabGuarded` unsaved-changes guard.
  Only the rendering substrate under it changes (CodeMirror in place of Shiki-for-read).

`CodeEditor.vue` grows into the file renderer: props `{ modelValue, filename, editable,
line?, lineRev? }`, emits `update:modelValue` and `save`, and exposes its `EditorView`
(already does, via `defineExpose`) so `FileViewer` can drive search and scroll-to-line.

## 3. Search, line numbers, scroll-to-line

- **Search → CodeMirror's native search panel** (`@codemirror/search`). The header
  magnifier button calls `openSearchPanel(view)` (the button is the only entry point on
  touch — no ⌘F on mobile — so it stays); `search` extension's default `Mod-f` also opens
  it. Works in **both** read and edit mode (edit-mode search was previously disabled).
  The bespoke find bar (`fv-find-*`), `lib/find-in-lines.ts`, and `lib/dom-line-highlight.ts`
  are deleted.
- **Line numbers → CodeMirror `lineNumbers()` gutter** (replaces the CSS-counter gutter).
- **Scroll-to-line + flash** — the right-rail content-search contract is unchanged
  (`openFile(key, path, line)` + `targetRev` bump). On a request, `FileViewer` dispatches
  `EditorView.scrollIntoView(view.state.doc.line(n).from, {y:"center"})` plus a one-shot
  line decoration that flashes a background for ~1.5s then clears (via a `StateField` +
  `StateEffect`, or a decoration set cleared on a timer).

## 4. Highlighting & theme

- **Common languages only**, via first-party `@codemirror/lang-*`: javascript
  (js/mjs/cjs/jsx/ts/tsx), json, html/htm, css/scss/less, markdown (md), python (py),
  yaml/yml, vue, plus **xml** and **sql** (added). Every other extension → **plain text**
  (no `@codemirror/legacy-modes`). A single `langFor(filename)` map, plaintext default.
- **Theme:** a custom `HighlightStyle` mapping the common Lezer highlight tags
  (keyword, string, number, comment, function/name, type/class, operator/punctuation,
  variable, tag, attribute-name, heading, link) to a github-light/dark palette. Colours
  are expressed as **CSS variables** (`--c-syn-keyword`, `--c-syn-string`, …) defined for
  light and `.dark` in `style.css`, so light/dark switches **purely via CSS** with no JS
  reconfigure — mirroring how Shiki's dual-theme worked. The base `EditorView.theme`
  (already present, mapped to `--c-*` tokens) is extended for gutter/active-line/search-
  match/selection styling.

## 5. Large files

Remove the current `LINE_GUTTER_LIMIT` (5000-line) fallback that rendered a plain,
un-highlighted `<pre>` for big files. CodeMirror renders only the viewport, so large files
are highlighted lazily and scroll smoothly — a **net improvement** (today they get no
highlighting at all). Binary and truncated handling at the data layer is unchanged
(binary → "not shown"/no editor; truncated → shown read-only, not saveable).

## 6. Deletions & dependencies

- **Delete:** `src/lib/shiki.ts`, `src/lib/dom-line-highlight.ts`, `src/lib/find-in-lines.ts`
  and their tests (`shiki.test.ts`, `dom-line-highlight.test.ts`, `find-in-lines.test.ts`);
  the `.shiki` / gutter-counter / `mark.search-hit` / `.line-flash` blocks in `style.css`.
- **Remove deps:** `shiki`, `@shikijs/langs`, `@shikijs/themes`.
- **Add deps:** `@codemirror/search`, `@codemirror/language`, `@codemirror/lang-xml`,
  `@codemirror/lang-sql`. (`@codemirror/state`/`view`/`commands` and the eight common lang
  packs are already present.) Sync the root `package-lock.json`
  (`npm install --package-lock-only`).
- Net bundle effect: removing Shiki core + JS regex engine + ~30 TextMate grammars + 2
  themes is substantial; the CM additions are small → expect a **net reduction**.

## 7. Interaction-parity acceptance criteria

All of the following behave as they do today, unless marked **[CHANGED]**:

1. Opening a file (tree click or search result) shows its content.
2. Syntax highlighting for the common languages; **[CHANGED]** long-tail languages
   (kotlin/swift/csharp/ruby/toml/dockerfile/shell/diff/…) render as plain text instead of
   highlighted.
3. Line-number gutter present.
4. **[CHANGED]** Search is CodeMirror's native panel (⌘/Ctrl-F or the header magnifier),
   with highlight-all, next/previous, and match count — and it now also works while
   editing. The old bespoke find bar is gone.
5. Clicking a right-rail content-search hit opens the file, scrolls to the line, and
   flashes it.
6. Edit mode: pencil → editor, Save / Cancel, dirty dot, ⌘/Ctrl-S to save, stale-write
   reload banner, error mapping — all unchanged.
7. Closing a tab with unsaved edits prompts before discarding.
8. Binary files: not shown/editable. Truncated files: shown read-only, not saveable.
   Copy button and size/badges present.
9. The single-file **diff view** (`parseUnifiedDiff`, tinted rows) is unchanged — it is not
   file *content* and is out of scope for this unification.
10. Light/dark theme follows the app.

## 8. Testing

- `CodeEditor` (vitest): renders content read-only; toggling `editable` enables editing and
  emits `update:modelValue`; `save` emitted on Mod-S; `langFor` maps common extensions and
  falls back to plaintext.
- `FileViewer` (vitest): the existing edit/save/stale/binary/truncated tests keep passing
  against the CM substrate (adapt selectors away from Shiki `.line`/`fv-find-*`); the
  magnifier opens the search panel; a scroll-to-line request scrolls/flashes.
- Delete the Shiki/find-in-lines/dom-line-highlight tests.
- Full `vitest run` green; `vue-tsc` 0 errors; `bun run build:packages` +
  `bun run verify:publish` pass (dashboard still bundles into the hub).

## 9. Out of scope (YAGNI)

- `@codemirror/legacy-modes` for long-tail language highlighting (plaintext fallback is
  accepted).
- Code folding, bracket-pair colourization, autocomplete, linting — none are current
  behaviours.
- Any change to the diff viewer, the write RPC, or the backend.
- Preserving the exact look of the old find bar (native CM panel is accepted).

## 10. Release impact

UI-only, bundled into the hub. Ships as a `@ganglion/xacpx-relay` (hub) bump on the `next`
dist-tag — a normal relay-web change, no protocol/core/connector coordination.
