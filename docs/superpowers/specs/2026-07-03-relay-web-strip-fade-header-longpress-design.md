# Relay-web: tab-strip fade, header session name, file-tree long-press

Date: 2026-07-03
Status: design (on-device feedback batch, proceeding on stated assumptions)

Four independent UX refinements from on-device feedback:

## 1 & 2. Tab strip: hide the scrollbar, fade the overflow edges
The center tab strip (`CenterTabStrip.vue`) is `overflow-x-auto`, so an OS scrollbar
appears. Suppress it with the existing `no-scrollbar` utility (`style.css`). To keep the
"there are more tabs" affordance, fade the content with a `mask-image` linear-gradient —
but **only on the side(s) that actually overflow** (a static both-ends mask would dim the
first/last tab even when nothing is clipped). `canLeft`/`canRight` refs track scroll
position (scroll + resize listeners, re-checked when the tab count changes); `maskStyle`
builds the gradient from them. jsdom has no layout, so both stay false → no mask → no test
breakage.

## 3. Session name at the front of the ChatPane chips row
On mobile the top bar now shows tabs instead of the session name (prior change). Restore
the name as the **leading chip** in the ChatPane header chips row (workspace / instance /
agent / branch). Mobile-only (`lg:hidden`): on lg+ the header `<h1>` already shows the name
at the front of that same row, so an always-on chip would duplicate it. `data-test="ctx-chip-session"`.

## 4. File tree: drop the per-row ⋯; long-press for the menu on touch
Remove the always-visible per-row ⋯ button (`data-test="row-menu"`) from `FileTreeNode`.
Desktop keeps right-click (`@contextmenu`). Touch uses a **long-press** on the row via a new
`useLongPress` composable (touch-only; 450ms hold; a >10px move before the hold is a scroll
and cancels; the composable swallows the one synthesized click on lift so the press doesn't
also toggle the row / close the just-opened menu). The row gets `select-none` +
`[-webkit-touch-callout:none]` so the press doesn't highlight the name or pop the iOS callout.
The workspace-root header ⋯ (in `FilesPanel`) is kept — it isn't a file/folder row and is the
only root-create affordance.

## Testing
- New `use-long-press.ts` unit tests (hold-fires, mouse-ignored, slop-cancel, lift-cancel,
  single-click-swallow).
- `file-tree-writes.test.ts`: the ⋯-button test becomes a long-press test + a quick-tap
  (no-menu) test; asserts `row-menu` is gone.
- `centertabstrip.test.ts`: root carries `no-scrollbar`.
- Full: `npx vitest run` + `npx vue-tsc --noEmit` in `packages/relay-web`.
