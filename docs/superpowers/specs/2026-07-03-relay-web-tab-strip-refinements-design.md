# Relay-web center tab-strip refinements

Date: 2026-07-03
Status: design (proceeding on best judgment — user stepped away mid-clarification)

## Context

The center multi-tab strip (`CenterTabStrip.vue`, shipped in beta.10) is a standalone
full-width row above the content pane: `💬Chat  file.ts✕  ⌗term✕`. On-device beta
feedback surfaced three issues:

1. **Mobile long-press selects the tab label text.** Tabs carry `touch-action: none`
   but nothing suppresses text selection / the iOS long-press callout, so a press-hold
   (the natural start of a drag on touch) highlights the label instead.
2. **No drag feedback on the tab being moved.** `useTabDrag` already computes
   `draggingId`, but the strip only styles the drop *target* (`overId` → ring). The
   dragged tab itself gives no visual signal, so a touch drag feels unresponsive.
3. **The tab strip is a separate row from the session name.** The user wants the tabs
   to live in the same bar as the session name, horizontally scrollable when they
   overflow, rather than consuming an extra full-width row.

## Decision (revised after user feedback)

An earlier draft merged the tabs and a pinned session label into one standalone row.
The user chose instead to **fold the tabs into the mobile top bar** (`☰ … 📄📋`): on
mobile the tab strip replaces the centered session-name text in that bar, so mobile
spends one bar total instead of top-bar + a second tab-strip row. On desktop (which has
no such top bar — it's `lg:hidden`) the tab strip keeps its standalone row above the
content. Trade-off the user accepted: the session name no longer shows in the mobile top
bar when a session is open (the sidebar still shows the active session).

Chosen over the one-unified-row-with-pinned-label draft.

## Changes

### `CenterTabStrip.vue`
- Single scroll-container root (`flex … overflow-x-auto`) holding the Chat button, tabs,
  and the trailing `TAB_DROP_END` drop zone — same as before the refinement.
- Add `select-none` + `[-webkit-touch-callout:none]` to the root so no descendant text
  is selectable and iOS shows no callout on long-press.
- Destructure `draggingId` from `useTabDrag` and, when `tab.id === draggingId`, apply a
  "lifted" style (`scale-95 opacity-50`) to the dragged tab. Tab transition switched from
  `transition-colors` to bare `transition` so the scale/opacity actually animate.
- New optional prop `bare?: boolean`. When true the root drops its own chrome
  (`shrink-0 border-b border-border bg-surface`) so it slots into a host row that already
  owns those (the mobile top bar). Default (false) keeps the standalone chrome.

### `DashboardView.vue`
- Mobile top bar: replace the centered session-name `<span>` with
  `<CenterTabStrip v-if="currentKey" bare :session-key="currentKey" class="min-w-0 flex-1" />`;
  the `<span>` (app title / alias) remains as the `v-else` for when no session is open.
- Center column: the standalone `<CenterTabStrip>` is wrapped in
  `<div class="hidden lg:block">` so it renders on desktop only (mobile uses the top bar
  copy). The wrapper — not a class on the strip — owns the responsive show/hide so the
  strip's own `display:flex` never fights a `hidden`/`lg:flex` on the same node.

### Out of scope (unchanged)
- `use-tab-drag.ts` logic (threshold, reorder, hit-testing) — `draggingId` already
  exists; we only start *consuming* it.
- `ChatPane.vue` header (its `lg:`-only session-name h1 + workspace/agent chips are
  untouched).

## Testing

Extend `centertabstrip.test.ts`:
- Root carries `select-none`.
- Default (standalone) root carries its `border-b` + `bg-surface` chrome.
- `bare` root drops `border-b` + `bg-surface` yet still renders Chat + tabs.
- Existing tabs still render (`data-test="tab"` / `tab-chat` / `tab-drop-end`).

Full suite: `npx vitest run` + `npx vue-tsc --noEmit` in `packages/relay-web`.
