# Relay-web: file-viewer in-file search + scroll-to-line

Date: 2026-07-03
Status: design (approved: substring highlight + prev/next, syntax highlight preserved)

Two on-device asks, sharing one primitive:
1. The file content viewer should support **in-file search** (find within the shown file).
2. Clicking a **content-search result** (right rail) should open the file **and scroll to
   that line**.

## Shared primitive: scroll to line N + highlight
Shiki renders each source line as `<span class="line">` inside `<pre class="shiki"><code>`.
So `container.querySelectorAll(".line")[n-1]` is line N's element — `scrollIntoView` it and
add a transient highlight class. A CSS counter on `.shiki .line` renders a line-number
gutter (no JS, no per-line restructuring). Plain-`<pre>` fallback (huge files / the 150 ms
pre-highlight window) has no `.line`; scroll falls back to line-height × (n-1) and search is
a no-op there (documented degradation).

## Feature 2 — scroll-to-line from a search hit
- `center-tabs`: `openFile(key, path, line?)`. The file tab gains `targetLine?: number` and a
  monotonically-bumped `targetRev` so re-clicking the SAME file at a new (or same) line still
  re-triggers a scroll. `openFile` updates both and re-activates the tab.
- `FilesPanel.openSearchResult(path, line)` → `openFile(key, path, line)`.
- `DashboardView` passes `:line` and `:line-rev` from the tab to `FileViewer`.
- `FileViewer` watches `[lineRev]` and, once content is rendered (`fileHtml` present), scrolls
  to `line` and flashes the line highlight.

## Feature 1 — in-file find bar
- Header gains a search toggle (⌘/Ctrl-F when the pane is focused opens it; Esc closes).
- Find bar: input, `current/total` count, prev/next (Enter / Shift-Enter), close.
- `find-in-lines.ts` (pure): `(lines, query, caseSensitive) => {line,start,length}[]` in order.
- `dom-line-highlight.ts`: `applyMarks(container, matches)` wraps each match in
  `<mark class="search-hit">` over the highlighted DOM — per source line, wrapping ranges
  right-to-left and covered text-node slices last-to-first so earlier offsets stay valid
  (a match spanning token spans yields ≥1 mark; the leftmost is its anchor). `clearMarks`
  unwraps. `setCurrent(marks, i)` toggles `is-current` and scrolls that match's line into view.
- Recompute on query/content change; clear on close.

## Testing
- `find-in-lines.test.ts`: ordering, overlap step, case-insensitive default, empty query.
- `dom-line-highlight.test.ts` (jsdom): marks wrap the right text incl. across token spans;
  clear restores original text; count matches; current scroll target resolves.
- `center-tabs` / FilesPanel: line + rev threading; DashboardView passes props.
- Full: `npx vitest run` + `npx vue-tsc --noEmit`.
