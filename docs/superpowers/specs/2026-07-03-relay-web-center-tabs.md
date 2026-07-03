# relay-web: center multi-tab + session-list cap — design

Two dashboard UX features for `packages/relay-web`.

## Feature 1 — Session list per-instance cap (small)

**Today:** `InstanceTree.vue` renders every session under an expanded instance (`v-for="s in orderedSessions(inst.sessions)"`), no cap.

**Change:** cap the visible sessions per instance at **10** (of the already-ordered list — active first, archived last). When an instance has more:
- Show a **"再显示 N 个 / Show N more"** button at the bottom of that instance's list (`N` = remaining count).
- When expanded, show **"收起 / Collapse"** to return to 10.

**State:** a reactive `Set<string>` of instanceIds whose session list is expanded, local to `InstanceTree.vue` (ephemeral — resets on reload; no persistence). Default collapsed.

**i18n:** `instance.showMoreSessions` ("再显示 {n} 个" / "Show {n} more"), `instance.collapseSessions` ("收起" / "Collapse"). Both en + zh.

Selection, ordering, swipe-actions, and the existing per-instance expand/collapse (which hides the whole instance) are unchanged; this cap is a second, inner level that only limits how many rows render.

## Feature 2 — Center area as a tab strip (large)

**Today** (`DashboardView.vue:319-325`): the center column is `ChatPane` (always mounted, `inert` when covered) plus `FileViewer` and `TerminalTab` as **mutually-exclusive overlays** driven by `viewingFile` (`files.file || files.diffPath`) and `terminalOpen`. Watchers enforce the mutual exclusion. `FileViewer` reads the single global `files.file`/`files.diff` slot.

**Change:** the center gets a **tab strip** at the top. Tabs:
- **Chat** is the pinned first tab (💬), **non-closable, non-draggable**, always present.
- **File / diff / terminal** tabs follow, each **closable (✕)** and **draggable to reorder** (among themselves — chat stays first).

Confirmed decisions:
- **Per-session tab sets.** Each session (`instanceId::alias`) has its own tab list + active tab. Switching sessions shows that session's tabs and active tab.
- **One terminal per session** — clicking the terminal button opens the session's terminal tab, or focuses it if already open.
- **Terminals survive session switches** — a terminal tab's component stays mounted (hidden) when you switch away, so its PTY isn't torn down; switching back reveals it live.

### New store: `stores/center-tabs.ts`

```ts
type CenterTab =
  | { kind: "file";     id: string; path: string }   // id = path
  | { kind: "diff";     id: string; path: string }   // id = "diff:" + path
  | { kind: "terminal"; id: string };                // id = "terminal"

interface SessionTabs { tabs: CenterTab[]; activeId: string } // activeId = "chat" | tab.id
```

- `bySession: Record<string /* instanceId::alias */, SessionTabs>` (ref).
- `sessionKey(instanceId, alias)` helper.
- Actions (all take an explicit `key`): `openFile(key, path)`, `openDiff(key, path)`, `openTerminal(key)` — add if absent (dedup by id) then activate; `closeTab(key, id)` — remove and, if it was active, activate the left neighbor or `"chat"`; `setActive(key, id)`; `reorder(key, fromId, toId)` — move within the non-chat list; `clearSession(key)` (on session archive/delete).
- Getters: `tabsFor(key)`, `activeFor(key)`.
- **Chat is implicit** — never stored as a tab; `activeId === "chat"` means the chat pane is showing.

### Center rendering (`DashboardView.vue`)

Replace the overlay block with:
1. A **`CenterTabStrip`** component: renders the chat tab + `tabsFor(currentKey)`, marks the active one, handles click-to-activate, close (✕), and HTML5 drag-reorder (`draggable`, `@dragstart`/`@dragover.prevent`/`@drop`; chat tab not draggable and not a drop-after target before index 0). Mirrors the file-icon + a terminal icon.
2. The panes:
   - **`ChatPane`** — single instance, current session (as today); `v-show` when `activeFor(currentKey) === "chat"`, else `inert`/hidden.
   - **File/diff tabs** — render **one `FileViewer` per open file/diff tab across all sessions**, keyed by `key+tab.id`, `v-show` only when its session is current **and** it's the active tab. Kept mounted while open → preserves scroll and avoids reload on tab switch.
   - **Terminal tabs** — render **one `TerminalTab` per open terminal tab across all sessions**, keyed by `key`, `v-show` when current+active. Kept mounted across session switches → PTY survives.

Mounting every open tab's component (not just the current one) is what makes terminals survive session switches and file scroll persist; file content is lightweight text, and there's at most one terminal per session, so the cost is bounded by what the user opened.

### `FileViewer` decoupling

`FileViewer` currently reads the global `files.file`/`files.diff` slot, so only one can exist. Refactor it to take a **prop** (`{ instanceId, workspace, path?, diffPath? }`) and load + hold its **own** content in local refs, via new **return-based** store reads that do not mutate global state:
- `files.readFile(instanceId, workspace, path): Promise<FsReadResult>`
- `files.readDiff(instanceId, workspace, path?): Promise<FsDiffResult>`

Keep the existing global `openFile`/`loadDiff` for any remaining single-slot callers, but the tab panes use the return-based reads. Back/close affordances: **close (✕)** now closes the tab (via `closeTab`); the mobile "back to file list" affordance still reopens the right Files drawer.

### Wiring the openers

- Right-rail Files tree / search-result click (`openTreeFile`, `openSearchResult`) → `centerTabs.openFile(currentKey, path)` instead of `files.openFile`.
- Changes-tab file click (`openDiff`) → `centerTabs.openDiff(currentKey, path)`.
- Terminal toggle button → `centerTabs.openTerminal(currentKey)` (focus if open); the button can also close/return-to-chat.
- Remove the `viewingFile`/`terminalOpen` overlay state and the mutual-exclusion watchers (superseded by the tab model). Preserve the mobile right-drawer auto-close where it still makes sense (opening a tab on mobile closes the right drawer overlay).
- On session archive/delete, call `centerTabs.clearSession(key)`.

### Drag-reorder (mouse + touch)

Greenfield, but **pointer-based** (Pointer Events) so it works on both desktop and touch in one implementation — matching the codebase's existing pointer-based drag utilities (`lib/use-swipe-actions.ts`, `lib/edge-swipe.ts`) rather than the HTML5 drag API (which does not fire on touch).

New utility `lib/use-tab-drag.ts` (or inline in `CenterTabStrip`):
- `pointerdown` on a non-chat tab records the tab id + start X and sets `pointer-capture`; a small movement threshold (~4px) distinguishes a drag from a tap so click-to-activate and the ✕ close still work.
- `pointermove` past the threshold enters drag mode: track the pointer X, compute the target insertion slot from the tab elements' midpoints, and show a live drop indicator (or live-reorder).
- `pointerup` commits `reorder(key, draggedId, targetId)` and releases capture; `pointercancel` aborts.
- Chat tab is not a drag source and reorder never moves a tab before the chat slot (index 0).
- `touch-action: none` on draggable tabs so the browser doesn't scroll/select mid-drag; the strip itself still scrolls horizontally when not dragging.

## Testing

- **center-tabs store:** open/dedup/activate, close-activates-neighbor-or-chat, reorder within non-chat list, per-session isolation, clearSession.
- **CenterTabStrip:** renders chat + tabs, active marking, close emits, drag-reorder calls store.
- **FileViewer (decoupled):** loads its own content from props (file + diff), independent instances don't clash.
- **InstanceTree cap:** ≤10 shown; "show N more" reveals the rest; "collapse" returns to 10; count correct; isolated per instance.
- i18n parity for new keys.

## Out of scope

- Multiple terminals per session.
- Persisting tab sets across page reloads (tabs are in-memory; a reload returns to chat).
- Tab overflow scrolling beyond what flex-wrap/scroll gives (basic horizontal scroll of the strip is fine).
