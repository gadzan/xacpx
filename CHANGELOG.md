# Changelog

## [relay 0.9.12-beta.18] - 2026-07-05

A `@ganglion/xacpx-relay` (hub) beta that restores your dashboard workspace across a browser refresh (#132). UI-only (bundled `relay-web`), published to the npm `next` dist-tag. Update with `xacpx-relay update`, then restart the hub and hard-reload the dashboard.

### Added

- **Refresh restores your open tabs and drafts.** A browser reload now brings back the center tabs you had open (files, diffs, terminals), the active tab, and any unsaved file edit as a live draft — so an accidental refresh no longer loses your place. State lives in `sessionStorage`, matching the existing composer-draft lifetime: it survives F5 and crashes, and clears when you close the tab.
- **File content is re-fetched, not cached.** Restored file tabs re-read the file from disk, so you always see the current content; an unsaved edit is restored on top as a draft (entering edit mode only when it differs from disk), and the existing stale-write guard still protects a save if the file changed while you were away.

### Changed

- **Restored terminals start on demand.** A terminal can't reconnect to its old shell across a reload, so a restored terminal tab now shows a "start new terminal" placeholder instead of silently spawning a fresh shell — click to start when you want it.

### Note

- This restores the *layout and edit drafts* only. Restoring a terminal's scrollback/output and reconnecting to the live shell is a separate, larger change (it needs backend output buffering) and is not part of this release.

## [relay 0.9.12-beta.17] - 2026-07-04

A `@ganglion/xacpx-relay` (hub) beta that unifies the file viewer on a single CodeMirror 6 stack and removes Shiki (#130). UI-only (bundled `relay-web`), published to the npm `next` dist-tag. Update with `xacpx-relay update`, then restart the hub and hard-reload the dashboard.

### Changed

- **One editor for read and edit.** The file viewer now uses a single CodeMirror 6 instance for both viewing and editing — toggling in place with no re-render or scroll jump. Search is CodeMirror's native panel (⌘/Ctrl-F or the header magnifier) and now works while editing too.
- **Highlighting.** Common languages (js/ts/jsx/tsx, json, html, css/scss, markdown, python, yaml, vue, xml, sql) are syntax-highlighted with a GitHub light/dark palette; other file types render as plain text. Large files are now highlighted (previously they fell back to plain text past 5000 lines).

### Preserved

- The full edit/save path is unchanged: pencil to edit, Save/Cancel, dirty indicator, ⌘/Ctrl-S, the stale-write reload banner (your draft is kept), and the unsaved-changes close guard. Binary files stay non-editable; truncated files stay read-only; the diff view, copy button, and light/dark are unchanged.

## [file edit & save] - 2026-07-04

Edit and save file content from the relay-web dashboard's file viewer (#128). This is a **four-package** release, not a UI-only hub bump — it adds a new gated wire RPC `control.fs.write`:

- `@ganglion/xacpx-relay-protocol` **0.1.10** (stable) — new `control.fs.write` message + `FsWritePayload`/`FsWriteResult`, and an `mtimeMs` field on `FsReadResult` (the stale-write token).
- `@ganglion/xacpx` **0.17.0-beta.3** (`next`) — `WorkspaceFs.writeFile` (realpath containment, atomic write, binary/size/truncated-target guards, `{mtimeMs,size}` stale-write check) and gated `ControlService.fsWrite`.
- `@ganglion/xacpx-channel-relay` **0.3.3-beta.3** (`next`) — connector dispatch for `control.fs.write`.
- `@ganglion/xacpx-relay` **0.9.12-beta.16** (`next`, bundled `relay-web`) — the editor UI.

### Added

- **Edit & save files.** The file viewer's header has a pencil that opens a CodeMirror 6 editor in place, with **Save** / **Cancel**, a dirty indicator, and **⌘/Ctrl-S** to save. Syntax highlighting for common languages, plain-text fallback otherwise.
- **Stale-write protection.** A save is rejected (`stale-write`) if the file changed on disk since you opened it — an inline banner offers **Reload** while preserving your draft, so an agent's concurrent edit is never silently overwritten.
- **Unsaved-changes guard.** Closing a tab with unsaved edits prompts before discarding.

### Safety

- Editing is gated by the same `filesWriteEnabled()` policy as create/rename/delete, strictly before any filesystem I/O; writes stay contained to the workspace root (realpath) and are atomic. Binary, truncated-on-read, and oversized files can't be edited or saved.

> Release order: protocol → core → (relay, channel-relay). The connector must be repacked, reinstalled into the plugin home, and the console restarted to serve `control.fs.write` live.

## [relay 0.9.12-beta.15] - 2026-07-03

A `@ganglion/xacpx-relay` (hub) beta adding file-viewer search (#126). UI-only (bundled `relay-web`). Published to the npm `next` dist-tag. Update with `xacpx-relay update`, then restart the hub and hard-reload the dashboard.

### Added

- **Find in file.** The file viewer has a search bar (the header magnifier, or ⌘/Ctrl-F): type to highlight every match in place — syntax colors preserved — with a match count and previous/next (Enter / Shift-Enter, Esc to close). Available for highlighted text files.
- **Jump to line from a search hit.** Clicking a content-search result in the right rail now opens the file and scrolls to the matched line, briefly flashing it.

## [relay 0.9.12-beta.14] - 2026-07-03

A `@ganglion/xacpx-relay` (hub) beta stopping iOS focus auto-zoom. UI-only (bundled `relay-web`). Published to the npm `next` dist-tag. Update with `xacpx-relay update`, then restart the hub and hard-reload the dashboard.

### Fixed

- **No more zoom-on-focus on iOS.** Tapping into an input on mobile Safari no longer zooms the page toward the field (iOS auto-zooms any control with font-size < 16px, and the dashboard's inputs are intentionally compact). The viewport now sets `maximum-scale=1` / `user-scalable=no`. Trade-off: pinch-to-zoom is disabled.

## [relay 0.9.12-beta.13] - 2026-07-03

A `@ganglion/xacpx-relay` (hub) beta with a batch of center-panel and file-tree UX refinements (#123). UI-only (bundled `relay-web`). Published to the npm `next` dist-tag. Update with `xacpx-relay update`, then restart the hub and hard-reload the dashboard.

### Changed

- **Tab strip: no scrollbar, edge fade instead.** The center tab strip no longer shows an OS scrollbar; overflowing tabs fade out at whichever edge(s) actually have more tabs off-screen.
- **Session name back in view.** The session name now leads the workspace / instance / agent / branch chip row on mobile (desktop already shows it in the header title) — restoring the name that moved out of the mobile top bar when tabs took its place.
- **File tree: long-press for the menu.** The always-visible per-row ⋯ button is gone. On desktop the actions menu opens with right-click; on touch it opens with a **long-press** on the row (a swipe still scrolls the tree). The workspace-root ⋯ (new file / folder in root) is unchanged.

## [relay 0.9.12-beta.12] - 2026-07-03

A `@ganglion/xacpx-relay` (hub) beta fixing a touch-gesture conflict in the center tab strip (#121). UI-only (bundled `relay-web`). Published to the npm `next` dist-tag. Update with `xacpx-relay update`, then restart the hub and hard-reload the dashboard.

### Fixed

- **The mobile tab strip can be scrolled again.** With several tabs open, a horizontal swipe was always captured as a drag-reorder, so the overflowing strip could never scroll. Tabs now scroll natively on a swipe; **reordering is a long-press-then-drag** on touch (the standard mobile pattern), while mouse drag is unchanged. An active drag suppresses the native scroll so the two no longer fight.

## [relay 0.9.12-beta.11] - 2026-07-03

A `@ganglion/xacpx-relay` (hub) beta folding in on-device feedback on the center tab strip (#119). UI-only (bundled `relay-web`). Published to the npm `next` dist-tag. Update with `xacpx-relay update`, then restart the hub and hard-reload the dashboard.

### Changed

- **Center tabs fold into the mobile top bar.** On mobile the tab strip now lives in the existing `☰ … 📄📋` bar in place of the centered session name (horizontally scrollable when tabs overflow), so mobile spends one bar instead of the top bar plus a second full-width tab-strip row. Desktop keeps the standalone strip row. Trade-off: on mobile the session alias no longer shows in the top bar while a session is open (the sidebar still highlights it).

### Fixed

- **Mobile long-press starts a drag instead of selecting text.** The tab strip suppresses text selection and the iOS long-press callout, so a press-hold begins a tab drag rather than highlighting the label.
- **The dragged tab now has visual feedback** — it lifts (slight shrink + fade) while being dragged.

## [relay 0.9.12-beta.10] - 2026-07-03

A `@ganglion/xacpx-relay` (hub) beta adding a multi-tab center area and a session-list cap (#117). UI-only (bundled `relay-web`). Published to the npm `next` dist-tag. Update with `xacpx-relay update`, then restart the hub and hard-reload the dashboard.

### Added

- **Center multi-tab interface.** The dashboard center column is now a per-session tab strip: a pinned **Chat** tab plus closable **file / diff / terminal** tabs. Clicking a file (tree or search) or a changed file opens a tab; the terminal button opens a terminal tab. Tabs are **drag-reorderable** (pointer-based — mouse and touch), including to the last position. Each session keeps its own tab set, so switching sessions restores its tabs; open tabs stay mounted, so **terminals survive session switches** (their PTY isn't torn down) and file scroll persists.
- **Session-list cap.** Each instance shows at most **10** sessions with a **"Show N more" / "Collapse"** toggle, so a busy instance no longer floods the left rail.

### Fixed

- Files opened as tabs load their own content and surface load errors/loading state (no more silently showing a stale file). A session removed out-of-band (from the CLI or another client) now prunes its tabs and terminal. Backgrounded (hidden) terminals no longer spin a render loop.

## [relay 0.9.12-beta.9] - 2026-07-03

A `@ganglion/xacpx-relay` (hub) beta folding in on-device feedback on the file-tree browser UX. UI-only (bundled `relay-web`). Published to the npm `next` dist-tag. Update with `xacpx-relay update`, then restart the hub and hard-reload the dashboard.

### Fixed

- **Context menu no longer spills off-screen.** A menu opened near the right or bottom edge now clamps into the viewport (and re-clamps if the same row is right-clicked again at a new point).
- **The ⋯ row button is pinned to the far right** (the git-status dot moved to its left), so the action target is a stable column.

### Changed

- **Content search results redesigned.** The matched source line now renders on its own line beneath `file:line`, wrapped for context, with the query highlighted (the highlight mirrors the match-case / whole-word / regex options). Results are windowed to 10 with a "show more" button (both name and content modes) instead of dumping up to 200 at once; the window collapses back to the first page whenever a new result set arrives.
- **Clearer root-create affordance.** The workspace-header ⋯ button (which opens New file / New folder at the workspace root) now carries a "New file / folder in root" tooltip.

## [relay 0.9.12-beta.8] - 2026-07-03

A `@ganglion/xacpx-relay` (hub) beta bundling file-tree browser UX refinements (#114). UI-only (bundled `relay-web`); no core/protocol/connector change. Published to the npm `next` dist-tag. Update with `xacpx-relay update` (then restart the hub and hard-reload the dashboard).

### Added

- **Per-row ⋯ menu button.** Every file-tree row and the workspace-root header now expose an always-visible ⋯ button that opens the same context menu, so touch devices (no right-click) can reach every action. Root-level new file / new folder moved into the header menu (the two standalone root buttons are gone).
- **Global toast system.** File operations (create / rename / delete / download) now report success and failure through a unified, top-center toast host that stacks, auto-dismisses, and can be closed by hand — replacing the sticky, non-dismissible error banner for write ops.

### Changed

- **"Search in this folder" is now visible and editable.** It writes a `<folder>/**` glob into the "files to include" field (VSCode-style) instead of a hidden scope; the field is cleared on a workspace switch so a folder scope never leaks across workspaces.
- **Search placeholder tracks the active mode** (by name vs by content).
- Only one file-tree context menu is open at a time (repeated right-clicks no longer stack menus).

### Removed

- The **Duplicate** action from the file/folder context menu.

## [file-tree browser] - 2026-07-03

A coordinated pre-release across the full relay stack adding the relay-web **file-tree browser** (read + write) and hardening its search. All four packages go out together — the write/search backend spans core + connector + protocol, so the hub UI alone would not work. Pre-releases publish to the npm `next` dist-tag. Update the daemon with `xacpx update` (core + connector) and the hub with `xacpx-relay update`, then restart both and hard-reload the dashboard.

Versions: `@ganglion/xacpx` 0.17.0-beta.2 · `@ganglion/xacpx-relay-protocol` 0.1.9 · `@ganglion/xacpx-channel-relay` 0.3.3-beta.2 · `@ganglion/xacpx-relay` 0.9.12-beta.7.

### Added

- **File-tree browser (read-only, sub-project A / #108).** Lazy per-directory tree replacing the flat listing; folder open/closed and per-extension file icons; gitignored + dotfiles dimmed/italic and hidden behind toggles; advanced search over file names or content (`git grep`, with a non-git fallback) with match-case / whole-word / regex toggles, include/exclude globs, and search-in-folder scoping; git-status dots; full-width mobile drawer.
- **File writes (sub-project B / #111), off by default.** New file / new folder / rename / duplicate / delete (permanent, with confirmation) / download (≤5 MiB), gated by a new `files.writeEnabled` config flag (default `false`). Download is a read and is not gated. All writes reuse the `WorkspaceFs` containment choke point (new `resolveParent()` for not-yet-existing targets); the workspace root cannot be renamed/duplicated/deleted.

### Security

- **Search ReDoS / runaway-subprocess hardening (#112).** Every `git` subprocess now runs under a 10s timeout + SIGKILL; the non-git content fallback routes through `git grep --no-index` (a killable, timeout-bounded engine) so no user-supplied regex runs in-process for content search when git is present; the remaining in-process JS walks carry a wall-clock deadline. Closes the event-loop-hang risk from a catastrophic content-search regex.

## [relay 0.9.12-beta.6] - 2026-07-02

A `@ganglion/xacpx-relay` (hub) beta closing the mobile keyboard gap on both the terminal shortcut bar and the chat composer. UI-only (bundled `relay-web`). Published to the npm `next` dist-tag. Update with `xacpx-relay update` (then restart the hub and hard-reload the dashboard).

### Fixed

- **Gap between the terminal shortcut bar and the on-screen keyboard (#109).** The bar's `env(safe-area-inset-bottom)` (iOS home-indicator inset) was dead space while the keyboard was open — the keyboard already covers the home indicator. The inset is now dropped when the keyboard is open, so the buttons sit flush on it; it still applies when the keyboard is closed.
- **Same gap under the chat composer (#110).** Applied the same treatment to the composer via a shared `useVirtualKeyboardInset()` helper (visualViewport delta, gated on an editable element being focused and a keyboard-sized threshold, so mobile browser chrome never triggers it).

## [relay 0.9.12-beta.5] - 2026-07-02

A `@ganglion/xacpx-relay` (hub) beta hotfix for a mobile terminal layout regression from beta.4. UI-only (bundled `relay-web`). Published to the npm `next` dist-tag. Update with `xacpx-relay update` (then restart the hub and hard-reload the dashboard).

### Fixed

- **Phantom bottom gap under the terminal shortcut bar on mobile (#107).** The beta.4 keyboard-inset (which lifts the shortcut bar above the on-screen keyboard) fired even with the keyboard closed — mobile Safari's persistent bottom toolbar exceeded the old threshold, leaving a permanent padding gap. It now only applies while the terminal is focused and above a keyboard-sized threshold (120px), so browser chrome no longer leaves a phantom inset.

## [relay 0.9.12-beta.4] - 2026-07-02

A `@ganglion/xacpx-relay` (hub) beta with mobile web-terminal fixes. UI-only (bundled `relay-web`); no other package changed. Published to the npm `next` dist-tag. Update with `xacpx-relay update` (then restart the hub and hard-reload the dashboard — the PWA service worker caches it). Note: Chinese/CJK IME input remains broken on mobile — that's an upstream `ghostty-web` limitation and is not addressed here.

### Fixed

- **Shortcut bar hidden behind the on-screen keyboard (#106).** The terminal pane now tracks `visualViewport` and reserves the keyboard's height as padding, so the grid shrinks and both the shortcut bar and the active prompt row stay above the keyboard.
- **Home/End did nothing; PgUp/PgDn behaved oddly (#106).** Home/End now send Ctrl-A/Ctrl-E (emacs beginning/end-of-line, bound by default in zsh/bash where the raw Home/End escape sequences are not). PgUp/PgDn now scroll the viewport one page locally instead of sending escape sequences the shell ignores.
- **No touch scrolling; every tap raised the keyboard (#106).** Dragging now scrolls the terminal viewport; only a deliberate tap focuses and raises the keyboard.

## [relay 0.9.12-beta.3] - 2026-07-02

A `@ganglion/xacpx-relay` (hub) beta hotfix for the web terminal focus ring. UI-only (bundled `relay-web`); no other package changed. Published to the npm `next` dist-tag. Update with `xacpx-relay update` (then restart the hub and hard-reload the dashboard — the PWA service worker caches it).

### Fixed

- **Terminal focus ring not actually suppressed (#105).** The 0.9.12-beta.2 fix only targeted `.term-host :deep(*:focus)` (descendants), but ghostty's `open()` makes the host element itself the focusable surface (`tabindex` + `contenteditable`), so the browser's default focus ring drew on the host — which a descendant-only selector never matches. Now suppressed on the host element directly (plus `box-shadow` for ring-style focus).

## [relay 0.9.12-beta.2] - 2026-07-02

A `@ganglion/xacpx-relay` (hub) beta shipping a web-terminal polish pass. UI-only — the dashboard (`@ganglion/xacpx-relay-web`, bundled into this package) is the only thing that changed; core, `relay-protocol`, and `channel-relay` are unchanged and need no republish. Published to the npm `next` dist-tag. Update with `xacpx-relay update` or `npm i -g @ganglion/xacpx-relay@next`.

### Changed

- **Web terminal polish (#104).** Suppressed the browser focus ring drawn around the terminal canvas. Matched the terminal background/foreground to the app design tokens (`--c-bg`/`--c-fg`) and centered the grid so the integer-cell fit remainder no longer shows a black seam on the right/bottom; recolors live on light/dark switch.

### Added

- **Richer terminal shortcut bar (#104).** Sticky Alt (ESC/Meta prefix) and Shift (upcase, `Shift+Tab` reverse-tab, xterm-modified arrows) modifiers alongside the existing sticky Ctrl; plus Home/End/PgUp/PgDn/Ins/Enter keys and a Copy button (selection → clipboard).

## [0.17.0-beta.1] - 2026-07-01

A `@ganglion/xacpx` (core) beta adding a non-blocking composer with a server-authoritative message queue, and reworking the web terminal into a center overlay. Published to the npm `next` dist-tag with `@ganglion/xacpx-relay` 0.9.12-beta.1 and `@ganglion/xacpx-channel-relay` 0.3.3-beta.1; `@ganglion/xacpx-relay-protocol` 0.1.8 ships stable (additive wire types). Install with `npm i -g @ganglion/xacpx@next`.

### Added

- **Non-blocking send + server-authoritative message queue (#103).** While the agent is working you can keep typing and sending — the send button no longer flips to "Stop". Messages sent mid-turn are enqueued on the server (FIFO) and drained automatically when the current turn finishes, with no parallel turns (a synchronous drain bracket hands turn N off to N+1). The relay-web dashboard renders a queue strip of the pending messages with per-item cancel, and a queued message is persisted into the transcript at enqueue time so it shows immediately. Stop (Esc, or the working HUD) now cancels only the in-flight turn and leaves the queue intact. New wire surface: a `queue-updated` control event (replace-latest snapshot of pending items) and a `control.queue.cancel` RPC, both plumbed through the hub's chat-scoped allowlist and the connector.

### Changed

- **Web terminal moved to a center overlay (#102).** The remote-instance terminal shipped in 0.17.0-beta.0 as a right-panel tab now opens as a center overlay toggled from the top bar. It gains a mobile shortcut bar (paste + arrow keys), sticky-Ctrl for control sequences, a lazily-loaded JetBrains Mono Nerd Font (via the jsdmirror CDN), and fit-to-container sizing derived from the rendered canvas cell metrics (fixing the fixed-80-column overflow). Still disabled by default (`terminal.enabled`).

## [0.17.0-beta.0] - 2026-07-01

A `@ganglion/xacpx` (core) beta introducing the web terminal. Published to the npm `next` dist-tag with `@ganglion/xacpx-relay` 0.9.12-beta.0 and `@ganglion/xacpx-channel-relay` 0.3.3-beta.0; `@ganglion/xacpx-relay-protocol` 0.1.7 ships stable (additive wire types). Install with `npm i -g @ganglion/xacpx@next`.

### Added

- **Remote instance terminal in the web dashboard (opt-in).** The relay-web dashboard gains a `Terminal` tab in the right panel: open a real interactive shell (rendered with `ghostty-web`) on the selected session's instance, with bytes streamed live over the existing relay link. Keystrokes/resize/close travel up a new ordered `/ws` fast path; PTY output streams down the existing control-event channel; `control.terminal.create` opens the PTY. **Disabled by default** — set `terminal.enabled: true` in the instance config to allow it. macOS/Linux only. The shell opens in the session's workspace cwd with secrets scrubbed from its environment, and is reaped after 15 min of no user input. Every upstream frame is authorized against instance ownership; there is no command/path allowlist (the trust boundary is the hub login, which already grants agent-driven code execution).

### Fixed

- **The `channel-relay` package now builds under the package-level typechecker.** The connector's inbound-event closure lost a guard narrowing that `tsc --noEmit` at the repo root did not catch but `build:packages` did.

## [0.16.0] - 2026-06-30

A `@ganglion/xacpx` (core) release. Ships alongside channel-feishu 0.6.0 (below).

### Added

- **Public plugin-api types for the usage and plan side-channels (#99).** `plugin-api` now re-exports `PromptUsage` / `UsageBreakdown` / `UsageCost` and `AgentCommand` (from the transport layer) plus `PlanEntry` / `PlanEntryStatus` (from the channel layer). These were already delivered to channel plugins via the `chat()` callbacks (`onUsage` / `onPlan` / `onCommands`); exporting the types lets out-of-tree channel packages type those callbacks against the public contract instead of reaching into internals. Purely additive — no runtime change.

## [channel-feishu 0.6.0] - 2026-06-30

A `@ganglion/xacpx-channel-feishu` release. Requires core's new plugin-api type exports (0.16.0 above).

### Added

- **Context-usage footer on the streaming card (#99).** The Feishu streaming card now consumes the `onUsage` side-channel and renders a compact footer segment with the per-turn token breakdown and context-window fill, e.g. `↑1.2k · ↓800 · ctx 12k/200k 6%`. Each piece degrades independently — agents that omit the token breakdown (codex) still get the context percentage. The percent is clamped to 100% and token counts roll over cleanly (`999_999 → 1m`).
- **Live plan/todo panel on the streaming card (#99).** The card now consumes the `onPlan` side-channel and renders the agent's live plan as an expanded collapsible panel above the tool panel, with per-item status icons (✅/⏳/⬜), struck-through completed items, a `done/total` header, and a 30-row cap. The list is replaced on each update (matching ACP `plan` semantics), not appended.

### Changed

- Usage and plan changes take the full `card.update` path rather than the `streaming_content` element-content fast-path, since the footer and panels are not part of that streamed element.

## [0.15.5] - 2026-06-30

A `@ganglion/xacpx` (core) release. Ships alongside relay-protocol 0.1.6, relay hub 0.9.11, and channel-relay 0.3.2 (below) — together these complete the per-session **display-name / rename** feature end-to-end.

### Added

- **Per-session display names (#93, core side).** Sessions can carry a cosmetic `display_name` distinct from their alias. `SessionService.setSessionDisplayName` persists it and `listSessions` surfaces it on `ControlSessionInfo.displayName`, so the relay dashboard can rename a session without touching its alias/transport identity. (The wire field, connector dispatch, and web UI ship in relay-protocol 0.1.6 / channel-relay 0.3.2 / relay hub 0.9.11.)
- **Archive frees the warm acpx queue-owner process (#96).** Since acpx v0.10, `sessions close` kills the queue-owner + agent processes **and** marks the record closed — so a closed session can't be reopened by name and its history is lost. Archiving now instead reaps only the warm queue-owner process via a new `freeWarmProcess` transport op (acpx-cli + bridge), leaving the session record open so a later restore resumes it losslessly and repeatably.
- **acpx-cli transport streams `onUsage` / `onCommands` (#98).** The acpx-cli transport now forwards the context-usage meter (`usage_update`) and agent-advertised slash commands (`available_commands_update`) to the prompt streaming callbacks, reaching parity with the acpx-bridge transport. Users configured with `transport.type: "acpx-cli"` now get the dashboard context bar and `/` command hints (previously bridge-only). Malformed frames, zero/negative context size, and empty command lists are handled defensively.

### Fixed

- **`/clear` no longer dumps chat-style progress into the web chat pane (#94).** On the control channel (relay-web), `/clear` ran session-reset through the chat reply path, streaming the mobile-oriented "🚀 Starting codex… (waited Ns)" progress pings into the web conversation as an assistant message. The control channel is GUI-first, so reset now suppresses those pings there; the clean "Session … has been reset" confirmation is still returned and the sidebar refreshes via `sessions-changed`. Other channels keep the live progress feedback.

## [relay 0.9.11] - 2026-06-30

A `@ganglion/xacpx-relay` release (the hub bundles the `@ganglion/xacpx-relay-web` dashboard). Core is released as 0.15.5, relay-protocol as 0.1.6, channel-relay as 0.3.2.

### Added

- **Rename a session from the dashboard (#93).** A session can be given a display name via an inline rename in the sidebar menu (and the command palette); the chat header shows the display name. Backed by the new `sessionsRename` RPC and `SessionDto.displayName` (relay-protocol 0.1.6) and the connector dispatch (channel-relay 0.3.2). The alias/transport identity is untouched.

### Changed

- **Decluttered the session row and conversation avatar (#95).** The agent brand glyph now sits **before** the session name (was trailing). The "archived" text badge is gone — archived state reads from the greyed-out name (with a visually-hidden label so it's still announced to screen readers). The "native" session marker is now a compact link glyph instead of a text badge. In the conversation list, the agent avatar dropped its rounded border + surface frame now that the brand tile fills the box.

## [relay-protocol 0.1.6] - 2026-06-30

A `@ganglion/xacpx-relay-protocol` release.

### Added

- **`SessionDto.displayName` + the `sessionsRename` RPC (#93)** — the wire surface for renaming a session to a cosmetic display name, consumed by the relay hub dashboard and dispatched by the connector.

## [channel-relay 0.3.2] - 2026-06-30

A `@ganglion/xacpx-channel-relay` (connector) release.

### Added

- **Dispatch `control.sessions.rename` to `setSessionDisplayName` (#93)** — the connector now routes the dashboard's rename RPC to the core session service, completing the display-name feature's control path.

## [relay 0.9.10] - 2026-06-29

A `@ganglion/xacpx-relay` release (the hub bundles the `@ganglion/xacpx-relay-web` dashboard). Core, `relay-protocol` (republished as 0.1.5 below), and `channel-relay` are otherwise unchanged.

### Added

- **Native sessions are badged in the sidebar (#89).** A logical session attached to an existing agent-side rollout (e.g. a resumed codex session) now shows a small "native" badge in the session list, distinguishing it from a session freshly created via New Session. The badge is driven by the `SessionDto.native` flag the core control service populates (shipped in core 0.15.4) and appears immediately on an optimistic native attach.

### Fixed

- **The agent avatar fills its box in the conversation list (#92).** The `@lobehub` brand marks are full-viewBox tile glyphs (e.g. codex is a white rounded square), so rendering one at a fixed inset size left it looking small and visually off-center inside the avatar box. The conversation list's assistant and live-streaming avatars now let the brand tile bleed to the box edges (clipped to the rounded border) so it reads as a proper app icon; the generic line-art fallback stays inset.
- **Tool-card chevron no longer shrinks on long titles (#87).** A long tool-call title could squeeze the disclosure chevron; it now keeps its size.

## [relay-protocol 0.1.5] - 2026-06-29

A `@ganglion/xacpx-relay-protocol` release catching the published wire types up to fields already shipping on the wire via core and the hub.

### Added

- **`SessionDto.native`** — marks a logical session attached to an existing agent-side (native) rollout; omitted for fresh sessions (#89).
- **`SessionDto.agentCommand`** — the agent adapter command a session actually runs, so the web can avoid seeding a new session's model picker from a session on a different adapter version (#84).
- **`SessionUsageSnapshotDto` / `SessionCommandsSnapshotDto`** — the per-session context-usage meter and advertised slash-command list retained for a reconnecting web client, so the context bar and `/` composer hints survive a page refresh.

## [0.15.4] - 2026-06-29

A `@ganglion/xacpx` (core) release.

### Fixed

- **`/clear` now resets the session from the relay-web chat box (#90, #91).** The control channel is GUI-first: relay-web forwards any slash command the user types verbatim to the agent, since the dashboard owns those actions. But `/clear` (and `/session reset`) had no GUI entry, and codex/ACP agents don't interpret `/clear` themselves — so it was sent to the agent as inert text and silently no-opped. `session.reset` is now exempt from the control-channel passthrough and handled by xacpx like in every other channel: it recreates the transport session and, for a native (agent-side) session, reads back the fresh rollout id and re-binds it so the session **stays native** across the reset. Other slash commands still pass through. The reset rebuilds the transport session mid-turn but emits no event of its own, so the control prompt path now compares the session's `transportSession` before/after the turn and emits `sessions-changed` when it moved — mirroring the existing archived-badge refresh — so the dashboard row reflects the new transport / native binding instead of going stale.
- **Agent-command resolution tolerates non-normalized session cwds (#88).** The acpx session index matched a session's recorded `cwd` against the resolved target with a raw string compare, so an equivalent-but-unnormalized path (e.g. a trailing slash or `..` segment) failed to match and dropped the resolved adapter command. The comparison now normalizes both sides with `resolve()` before comparing.

### Added

- **`SessionDto.native` marks agent-side sessions over the wire (#89).** The control service now sets `native: true` on a logical session whose `source` is `agent-side` (i.e. attached to an existing agent rollout, such as a resumed codex session), and the relay-protocol `SessionDto` carries the flag through to structured consumers. The relay-web dashboard uses it to badge native sessions in the sidebar (fresh xacpx-created sessions omit the flag).

## [relay 0.9.9] - 2026-06-26

A `@ganglion/xacpx-relay` release (the hub bundles the `@ganglion/xacpx-relay-web` dashboard). Core, `relay-protocol`, and `channel-relay` are unchanged since their previous releases.

### Added

- **Optimistic background session creation.** Creating a session blocks on a cold agent start (often 10–40s), and the New-Session dialog used to await that RPC behind a disabled "Creating…" button — a frozen modal with no progress and no way out. The dialog now inserts a "creating" row and closes immediately while creation runs in the background; the view switches straight to the new session and shows a booting pane (spinner, "Starting <agent>… Ns" live clock, "first start can take 10–40s" reassurance, and a Cancel), and the sidebar row carries a spinner glyph. On success the real session row swaps in; a gateway timeout (504) leaves the booting row until `sessions-changed` lands; a hard failure flips the pane to a dismissible error. Creating a session also now switches to it immediately (previously the dialog only closed).

### Fixed

- **Duplicate session aliases no longer fail silently.** Typing an alias that collides with an existing session now shows an "alias already exists" error in the dialog up front (before any agent/workspace side effects) and keeps the dialog open, instead of firing a doomed create RPC whose rejection was swallowed while the UI switched onto the wrong (existing) session.
- **Deleting the active session clears the view.** Deleting the session you're viewing now drops back to the empty "no session" state instead of leaving a stale selection pointed at a session that no longer exists. Deleting a non-active session leaves the current selection untouched.
- **A failed tool no longer prints its error twice.** A failed command echoes its stderr in the tool card's output body (with a nonzero exit and a red border); the separate red error banner repeated the same text. The banner is now suppressed when the error is already visible in the detail body, and still shown when it isn't (e.g. a diff/write failure).
- **The agent brand icon is centered in its box.** The `@lobehub` brand SVGs ship at a `1em` intrinsic size and the fill rule sat on the wrong wrapper, so the mark rendered off-center (most visible on the chat avatar). It now fills and centers its box deterministically.
- **Chat error banner and failed-send styling.** The chat error banner is now a contained rounded card with an icon and a scrollable body (so a long message — e.g. a not-advertised-model list with every available model — no longer floods the pane as an unbounded red wall) and an icon dismiss button. A failed user send drops the harsh full red ring for a soft danger-tinted bubble, an alert icon on "Failed to send", and a clear pill "Resend" button.

## [0.15.3] - 2026-06-26

A `@ganglion/xacpx` (core) release.

### Fixed

- **Session creation tolerates a `--model` the agent's adapter doesn't advertise (#84).** Different agent adapters format model ids differently — the two codex-acp adapters disagree on the reasoning-effort suffix (`gpt-5.5[high]` vs `gpt-5.5/high`) — so a model id valid under one adapter is rejected by another, and acpx hard-failed session creation when a `--model` (or a replayed saved model) wasn't advertised. The acpx-cli and bridge transports now recognize that specific not-advertised-model error and retry creation **without** the model, falling back to the adapter's default, so a stale / cross-adapter / mistyped model override can never make a session uncreatable. The control service also records each session's resolved adapter command on `SessionDto.agentCommand`, which the relay dashboard uses to avoid seeding a new session's model picker from a session running a different adapter (the dashboard side shipped in relay 0.9.8).

## [relay 0.9.8] - 2026-06-26

A `@ganglion/xacpx-relay` release (the hub bundles the `@ganglion/xacpx-relay-web` dashboard). Core, `relay-protocol`, and `channel-relay` are unchanged since their previous releases.

### Added

- **Agent brand icons in the dashboard.** The chat assistant avatar and the sidebar session-list badge now show each agent's brand mark by acpx driver (codex / claude / gemini / copilot / cursor / qwen / kimi / opencode / …) via `@lobehub/icons-static-svg`, replacing the generic robot avatar and the text agent badge — the latter saves horizontal space in the session list. Drivers with no brand mark fall back to the generic glyph; the agent name stays available on hover. The instance's configured agents are now fetched alongside its session list (previously only when a create/manage dialog opened), so the icons resolve in the normal login → browse → chat flow.

### Fixed

- **Composer `/` command hints survive a page refresh.** Agents advertise their slash commands (e.g. Codex's `/compact`) once at session start via the ACP `available_commands_update` frame. The hub broadcast this live but didn't retain it, so a refresh emptied the composer's `/` autocomplete until the next advertisement. The hub now retains the latest command list per session (replace-latest, cleared when the instance goes offline) and serves it in the `GET /api/active-turns` reconnect snapshot; the dashboard seeds the hints from that snapshot on load — mirroring the context-usage retention added in 0.9.7.
- **Slash-command menu floats above the composer instead of growing it.** The autocomplete list rendered in normal flow inside the composer card, so opening it pushed the textarea down. It is now anchored above the input.
- **The Changes tab auto-loads the diff when switching sessions.** With the right-rail Changes tab active, switching sessions cleared the loaded diff but left the "no diff loaded" placeholder until a manual refresh — the diff only reloaded when the tab value changed, which a same-tab session switch doesn't trigger. Switching sessions while the Changes tab is active now reloads the diff for the new workspace automatically.
- **New-Session model picker no longer seeds suggestions from a mismatched adapter (dashboard portion of #84).** The picker reuses a same-agent + workspace session's advertised model ids, but different adapter versions of one agent advertise ids in incompatible formats (e.g. codex `gpt-5.5[high]` vs `gpt-5.5/high`), so reusing across adapters could propose an id the new session's adapter rejects. The picker now reuses suggestions only when the live candidate sessions share one adapter (archived ones ignored), suppressing them to a free-text default when adapters visibly diverge. It reads a new `SessionDto.agentCommand` field that the **core** side of #84 populates — until a core release ships that field it is absent and the gate is inert (current behavior); the transport's drop-the-rejected-`--model` fallback remains the actual guarantee a bad pick can't break session creation.

## [0.15.2] - 2026-06-25

A `@ganglion/xacpx` (core) release.

### Fixed

- **Codex subagent threads no longer leak into the native session list.** Codex's native `spawn_agent` runs subagents as their own threads, which show up in `acpx codex sessions list` next to real user sessions — they fork the parent's cwd (so the cwd filter doesn't exclude them) and acpx's list JSON drops the `parentThreadId`/source that would tell them apart. The transport now resolves each listed session against Codex's rollout store (`$CODEX_HOME/sessions/**/rollout-*.jsonl`) and hides threads whose `session_meta.source` is a subagent, gated to the codex driver (covers custom-named agents). Fail-open: any missing/unreadable/unparseable rollout leaves the session visible, so a Codex format change degrades to "shows a phantom session", never "hides a real one". The native-session handler also follows `nextCursor` past fully-filtered pages so a page of only subagents doesn't surface as "no sessions found".

## [relay 0.9.7] - 2026-06-25

A `@ganglion/xacpx-relay` release (the hub bundles the `@ganglion/xacpx-relay-web` dashboard). Core, `relay-protocol`, and `channel-relay` are released separately.

### Added

- **New XACPX brand logo.** The dashboard mark is now the XACPX "X" — a green arc-bottom chevron over two splayed blue legs — replacing the gradient-stroke X. Applied across the header wordmark, the SVG favicon, the Safari pinned-tab mask, and the regenerated PWA / Apple-touch icon set.

### Fixed

- **Context-usage meter survives a page refresh.** The usage bar was driven only by live `turn-usage` events held in the web store's memory, so a refresh cleared it until the next turn. The hub now retains the latest usage per session (replace-latest, surviving turn-finished, cleared when the instance goes offline) and serves it in the `GET /api/active-turns` reconnect snapshot; the dashboard seeds the meter from that snapshot on load.

## [channel-relay 0.3.1] - 2026-06-25

A `@ganglion/xacpx-channel-relay` connector release.

### Fixed

- **Codex search/command/read tool steps now show their output in the dashboard.** Codex (codex-acp) routes execute/search/read through a terminal: the `tool_call` content is a bare `[{type:"terminal",…}]` block (no inline text) and the result lands in `rawOutput.formatted_output` (with exit status in `rawOutput.exit_code`), not `stdout`/`text` or a content block. The presentation mapper only checked `stdout`/`text`/content blocks, so every Codex terminal-backed step rendered its title with an empty body — only `edit` steps (which carry a `diff` block) showed detail. `formatted_output` is now a first-class output source across execute/search/read/generic/error, and `exit_code` is read alongside `exitCode`. Other agents (stdout/text/content-block shapes) and `edit` diffs are unchanged.

## [relay 0.9.6] - 2026-06-25

A `@ganglion/xacpx-relay` release (the hub bundles the `@ganglion/xacpx-relay-web` dashboard). Core, `relay-protocol`, and `channel-relay` are released separately.

### Fixed

- **Session-row swipe no longer sticks after a desktop mouse drag.** On a wide/desktop layout, dragging a session row left with the mouse and releasing left the row stuck mid-drag — the gesture could miss its `pointerup` (released outside the row), and a mouse could start the swipe at all even though it's a touch affordance. The InstanceTree session-row swipe is now restricted to touch/pen pointers, and `useSwipeActions` hardens the pointer lifecycle (sets/releases pointer capture and ends the gesture on a `buttons===0` fallback) so a missed `pointerup` still terminates cleanly.

## [relay 0.9.5] - 2026-06-25

A `@ganglion/xacpx-relay` release (the hub bundles the `@ganglion/xacpx-relay-web` dashboard). Mobile/PWA layout fixes. Core, `relay-protocol`, and `channel-relay` are unchanged since their previous releases.

### Fixed

- **The scheduled-task time field no longer overflows its container on iOS.** Mobile Safari gives `<input type="datetime-local">` an intrinsic minimum content width that ignores `width: 100%`, so the 时间 field spilled past the composer's rounded border. `-webkit-appearance` is now reset for date/time inputs — scoped to iOS Safari via `@supports (-webkit-touch-callout: none)` so the desktop native picker chrome is untouched — plus `min-width: 0` so the field honors its container.
- **File viewer wastes less horizontal space on narrow screens.** The Shiki line-number gutter, code indent, and block padding together pushed code ~4.25rem off the left edge — ~18% of a phone's width. The gutter (2.75→2.25rem), indent (3.25→2.75rem), and padding (1→0.75rem) are tightened; 4-digit line numbers (up to the 5000-line highlight limit) still fit.
- **File viewer back button no longer wraps to two lines.** With a long file path open, the Back button (文件 / 返回) had no width floor and got squeezed until its label wrapped vertically. It now keeps its width (`shrink-0` + `whitespace-nowrap`).

## [relay 0.9.4] - 2026-06-24

A `@ganglion/xacpx-relay` release (the hub bundles the `@ganglion/xacpx-relay-web` dashboard). Dashboard polish. Core, `relay-protocol`, and `channel-relay` are unchanged since their previous releases.

### Fixed

- **Header context chips stay readable under long branch names.** The chip row truncated every chip proportionally, so a long branch name could starve the agent chip down to a single letter (`codex` → `c…`). The strip now scrolls horizontally (chips at full width, hidden scrollbar) so long workspace/branch names are fully readable via swipe — `title` tooltips don't fire on touch.
- **Consistent model + reasoning-effort label.** The composer's model chip is normalized for display so a known reasoning-effort suffix always reads as `model/effort` (e.g. `gpt-5.5[high]` → `gpt-5.5/high`), regardless of which adapter version advertised it. Display only — the exact agent-advertised id is still sent on selection, and non-effort bracket variants (e.g. `claude-opus-4-8[1m]`) are left untouched.
- **Composer sits flush above the iOS home indicator in the installed PWA.** Following the `0.9.3` de-stacking fix, the composer still floated an extra ~12px above the home-indicator safe area; that padding is removed so the composer sits flush at the safe-area top like native input bars.

## [relay 0.9.3] - 2026-06-24

A `@ganglion/xacpx-relay` release (the hub bundles the `@ganglion/xacpx-relay-web` dashboard). Reworks the dashboard's "Changes" panel and file/diff viewer. Core, `relay-protocol`, and `channel-relay` are unchanged since their previous releases.

### Fixed

- **Non-ASCII filenames in the Changes panel are no longer garbled, and clicking them works.** The control layer listed git status with plain `git status --porcelain`, which octal-escapes and quotes non-ASCII paths (e.g. `"\351\246\226…"`); that escaped string was sent to the dashboard, so the file list showed garbage and the single-file diff lookup (`git diff -- <path>`) matched nothing → a "not found"/empty diff. Git status is now read with `-c core.quotePath=false … --porcelain -z` and parsed on NUL, so paths like `src/首页.ts` round-trip verbatim. This also repairs the Files-tab status badges, which keyed off the same path map.
- **Untracked files now show their contents as a diff.** `git diff [HEAD]` ignores untracked files, so clicking one in the Changes panel showed an empty diff. Untracked single-file diffs are now synthesized via `git diff --no-index` so they render as all-additions.
- **The composer no longer leaves an oversized gap above the iOS home indicator in the installed PWA.** The home-indicator safe-area inset was applied on both the composer wrapper and the form, stacking into ~62px of bottom space; it's now applied once via `max(1rem, env(safe-area-inset-bottom))` on the wrapper (~46px on a notch PWA; desktop spacing unchanged).

### Added

- **The Changes panel groups files into Staged / Changes / Untracked** (collapsible, state persisted), with a status glyph, a muted directory prefix + basename, and a full-path tooltip so long paths are no longer truncated without recourse.
- **Syntax-highlighted file viewer.** Viewing a file now renders with Shiki (lazy-loaded, JavaScript regex engine — no WASM, dual light/dark themes via CSS variables), with a plain fallback for very large files. The highlighter ships as a lazy chunk, so the initial dashboard bundle is unchanged.
- **Structured diff viewer.** Single-file diffs render as tinted rows with separate old/new line-number columns, a +/- gutter, and hunk separators (diffs are intentionally not syntax-highlighted), replacing the previous flat colored `<pre>`.

## [0.15.1] - 2026-06-23

A core (`@ganglion/xacpx`) patch release. No `relay` / `relay-protocol` / `channel-relay` changes.

### Fixed

- **The dashboard's "archived" badge clears when a message restores the session.** Sending a message to an archived session restores it server-side (the `archived` flag is cleared), but that happened via `useSession`, which emits no event — so the relay sidebar kept showing a stale "archived" badge on the row until an unrelated refresh. The control layer now detects the restore-on-message transition and emits a `sessions-changed` event (only when the session was actually archived), which the dashboard already handles by re-fetching the session list. The explicit unarchive (undo) action was unaffected; only the restore-on-message path missed the event.

## [relay 0.9.2] - 2026-06-23

A `@ganglion/xacpx-relay` release (the hub bundles the `@ganglion/xacpx-relay-web` dashboard). Ships the resizable dashboard right panel. Core, `relay-protocol`, and `channel-relay` are unchanged since their previous releases.

### Added

- **Resizable right panel (desktop).** Drag the left edge of the tasks/files panel to set its width; the choice persists across reloads. Width is clamped to a sensible range and capped to half the viewport so it can't crowd out the conversation. Desktop only — on mobile the panel stays the fixed-width off-canvas drawer, and the drag handle is inert.

## [0.15.0] - 2026-06-23

A core (`@ganglion/xacpx`) release fixing session archive/restore so re-prompting an archived session continues the same conversation. No `relay` / `relay-protocol` / `channel-relay` changes (the dashboard's resizable right panel from this cycle ships in an upcoming `relay` release).

### Changed

- **Archiving a session now keeps it resumable.** Archiving previously ran `acpx sessions close` on the unshared transport, which marks the acpx record `closed`; acpx excludes closed records from name lookup, so a restored session could only be recreated fresh — losing all agent context and history. Archive now only cancels any in-flight turn and leaves the acpx session alive, so re-prompting (from the dashboard or WeChat) resumes the same conversation with full context + history, repeatably (archive → restore → archive → restore). The warm queue-owner process is no longer freed instantly on archive; it idles out via acpx's TTL exactly like any other inactive session (acpx has no "free the process but keep the record resumable" primitive, so resumability is preferred over instant reclamation).

### Fixed

- **Re-prompting an archived session no longer errors with "session unavailable / re-run /session new".** Restore-on-message un-archived the logical session but never recreated the transport session that archive had torn down, so the next prompt threw "No acpx session found". The chat path now recreates a genuinely-missing transport session before prompting (only when actually gone, so a live shared transport is never disturbed); combined with the archive change above, the normal path resumes the existing session instead. A recreated session starts fresh; sessions archived under the previous close-on-archive build lose their prior history on first restore.

## [relay 0.9.1] - 2026-06-23

A `@ganglion/xacpx-relay` release (the hub bundles the `@ganglion/xacpx-relay-web` dashboard). Delivers the dashboard half of the workspace-propagation fix and drops blank reasoning blocks. Pairs with core `0.14.1` and `relay-protocol` `0.1.4`.

### Fixed

- **Workspaces added from the terminal appear in the dashboard without a manual refresh.** The dashboard now handles the new `workspaces-changed` control event (emitted by core ≥0.14.1 when `xacpx workspace add` / `/config` changes the workspace set) and re-fetches the workspace list. Backed by a new `workspaces-changed` variant in `relay-protocol` `0.1.4`, whitelisted in the web event validator.
- **Blank reasoning panels no longer render.** Some models (e.g. glm-5.2) stream empty / whitespace-only thought deltas; the dashboard no longer opens an empty reasoning ("推理") block for them — across the live, persisted, and native-history-import paths — while internal whitespace between real chunks is preserved.

## [0.14.1] - 2026-06-23

A core (`@ganglion/xacpx`) patch release: four fixes validated against a live relay instance. No `relay` / `relay-protocol` / `channel-relay` changes.

### Fixed

- **Tool blocks show the operation and its diff again.** ACP `tool_call_update` frames are *partial* — each carries only the fields that changed, and the terminal (completed) frame sets just `status` + `rawOutput`, omitting `kind`/`title`/`content`. The structured tool-event path built a standalone event per frame, so downstream (last-write-wins by `toolCallId`) the sparse terminal frame clobbered the rich one, leaving a generic `Tool` / `other` step with no title and no diff in the dashboard. The transport now accumulates merged tool-call state per `toolCallId` (present, non-empty fields override; absent/empty fields keep the prior value), so the edit title and diff survive. The legacy inline-text rendering (weixin/yuanbao verbose) is untouched, and Feishu cards are unchanged.
- **The coordinator no longer prefixes every message with a "latest user message" label.** `buildCoordinatorPrompt` runs on every turn and unconditionally labelled the user's text; in a plain session with no orchestration context this leaked as `用户最新消息：` on every message. The label is now added only when orchestration context (pending results, blockers, an active human-question package) precedes it; otherwise the message is sent verbatim.
- **Terminal `xacpx workspace add` reaches a running daemon.** `workspace add` is a separate CLI process that only writes `config.json`; the daemon held a stale in-memory copy, so the control API (and thus the relay dashboard) served the old workspace list until a restart. The daemon now watches the config file's directory (safe across the atomic temp+rename write) and reloads on change, emitting a `workspaces-changed` control event when the workspace set actually changes. (The dashboard's auto-refresh on that event also needs an upcoming `relay` release; until then a manual refresh reflects the change immediately once the daemon has reloaded.)
- **`xacpx channel add relay` is discoverable.** The relay connector (`@ganglion/xacpx-channel-relay`) is now listed by `xacpx plugin known`, and adding the `relay` channel without the plugin installed prints the exact `xacpx plugin add …` command instead of a bare "unknown channel type" error.

## [relay 0.9.0] - 2026-06-23

A `@ganglion/xacpx-relay` release (the hub bundles the `@ganglion/xacpx-relay-web` dashboard). Core, `relay-protocol`, and `channel-relay` are unchanged since their previous releases. Brings a redesigned login, mobile edge-swipe drawers, and timely PWA updates.

### Added

- **Redesigned login.** The token-entry screen is now a terminal-window card: a `xacpx-relay add token` command line with a copy button, a show/hide token field, and a bracketed-prompt sign-in action, with a brand glow and a green focus ring.
- **Mobile edge-swipe drawers.** On the dashboard, swipe right from the left screen edge to open the instances drawer and swipe left from the right edge to open the tasks/files drawer; when a drawer is open, swipe back across the backdrop to close it. Gated to the mobile layout and guarded against vertical-scroll and multi-touch misfires.

### Fixed

- **Timely PWA updates.** The dashboard now polls for a new service worker (every 60s and on tab focus) and `skipWaiting` activates it immediately, so a deploy reaches open clients without a manual hard refresh. The hub also serves hashed `/assets/*` as `immutable` and the app shell as `no-cache`, so the shell is always revalidated while fingerprinted assets stay cacheable.

## [0.14.0] - 2026-06-22

Brings **message attachments** (images & files) and **agent slash-command** awareness through the core, plus richer usage telemetry. Pairs with the `relay` / `relay-protocol` / `channel-relay` releases below.

### Added

- **Attachment uploads.** A new `UploadStore` writes attachment bytes into a sandboxed per-upload temp dir under `~/.xacpx/runtime/uploads/`, with a 10 MiB size cap and a 24h TTL that is now swept hourly (not only at startup). The `control.uploadFile` RPC saves bytes and returns a reference that `control.prompt` forwards as prompt media into `agent.chat`.
- **Usage cost & token breakdown.** The transport parses acpx `usage_update` frames for cost and token breakdown and threads them through the router and bridge, so consumers (e.g. the relay dashboard) can render a cost/usage meter.
- **Agent available-commands.** The transport parses acpx `available_commands_update` frames and threads the per-session slash-command catalog through the router and bridge.
- Bundled **acpx 0.11.0** (the source of the usage cost/breakdown frames).

### Fixed

- **Prompt media is constrained to the upload sandbox.** `control.prompt` media refs whose resolved `filePath` escapes the `UploadStore` root are dropped, so a caller cannot point the agent at an arbitrary absolute path (defense-in-depth around the two-phase upload). The store is only touched when a turn actually carries media.
- `UploadStore.save` rejects oversized payloads before decoding the base64 into memory.

## [relay 0.8.0] - 2026-06-22

A `@ganglion/xacpx-relay` release (the hub bundles the `@ganglion/xacpx-relay-web` dashboard; core is the `0.14.0` entry above). Brings message attachments and a richer dashboard. Supersedes the unreleased 0.7.0 (version surfaces — see entry below), which it includes.

### Added

- **Message attachments in the dashboard.** Attach images & files from the composer (attach button, paste, drag-and-drop), with client-side image downscaling for previews, pending chips, and inline rendering of sent attachments. Metadata + preview are persisted so attachments re-display in history.
- **Usage cost & token-breakdown popover** on the dashboard usage meter.
- **Agent slash-command autocomplete** in the composer, backed by per-session command catalogs.
- **Tabbed instance-manage dialog** with bounded lists, a filter, a collapsible add-form, and accessibility (tablist roles, roving tabindex, arrow-key navigation).
- **Swipe-to-reveal session-row actions** (archive / delete) that follow the finger, with taller rows.

### Changed

- Working-status word cycling slowed from ~4s to ~10s.

### Fixed

- **Pre-buffer upload guard.** `/api/instances/:id/rpc` rejects oversized bodies by `Content-Length` before reading/parsing them into memory (closes an authenticated memory-pressure DoS); the precise per-upload decoded-size check still bounds uploads.
- **Bounded attachment persistence.** Persisted attachments are capped at 5/message, `filename`/`mimeType` are truncated, and `previewUrl` is capped & validated (closes a storage-bloat DoS).
- **Chat-scoped `session archive` / `unarchive` RPCs** (previously crashed with an undefined chatKey).
- Dashboard fixes: attachment-rejection feedback, the ⋯ menu no longer clipped by the swipe overflow, notch safe-area on the Settings route, and EXIF-aware attachment thumbnails.

(Also includes the **0.7.0** version surfaces — relay version + update hint in Settings, instance version in the Manage dialog, `GET /api/version`, and `xacpx-relay update [--check]` — see the [relay 0.7.0] entry below.)

## [relay-protocol 0.1.3] - 2026-06-22

Additive wire-protocol types; backward compatible, so existing `^0.1.0` consumers are unaffected.

### Added

- `control.upload` message + attachment ref/metadata types.
- Usage cost & token-breakdown carried over the wire.
- Agent available-commands carried over the wire (with hardened web-side validation and empty-list clears).

## [channel-relay 0.3.0] - 2026-06-22

A `@ganglion/xacpx-channel-relay` connector release.

### Added

- Dispatch `control.upload` to `ControlService.uploadFile`, and carry usage cost/breakdown + agent available-commands across the connector bridge.

## [relay 0.7.0] - 2026-06-22

A `@ganglion/xacpx-relay` release (the hub bundles the dashboard; core is unchanged).

### Added

- **Relay version in Settings.** The Settings page now shows the running hub version and, when a newer `@ganglion/xacpx-relay` is published, an "update available" hint pointing at `xacpx-relay update`. Backed by a new auth-gated `GET /api/version` whose npm lookup is cached (~1h) and failure-tolerant, so the page never blocks on npm.
- **Instance version in the Manage dialog.** The manage-instance dialog shows the connector's reported xacpx core version (falling back to an "unknown" note for pre-version connectors).
- **`xacpx-relay update [--check]`.** Self-updates the hub package via npm (or bun when `PACKAGE_MANAGER=bun`); `--check` reports current vs latest without installing.

## [0.13.0] - 2026-06-21

Adds **session archive** and turns `/session rm` into a **real delete** across every channel. The relay dashboard, protocol, and connector are wired to match — see the `relay` / `relay-protocol` / `channel-relay` entries below.

### Added

- **`/session archive <alias>`** hides a session from the active list without deleting it. Archived sessions are skipped in listings and **auto-restore the moment you send them a prompt** ("restore-on-message"), so archiving is a soft, reversible declutter. Archiving is refused while the session has a running turn.
- **`/session rm <alias>` now performs a real delete.** Previously it only dropped the logical (xacpx-side) session and left the underlying acpx session and its on-disk record/stream files behind. It now closes the acpx session, deletes the acpx record + event-stream files (best-effort), and purges the session's orchestration references. This flows through both transports (acpx-cli and the bridge subprocess).
- Session info / control surfaces now expose an `archived` flag.

### Fixed

- **`transport.preferLocalAgents` was a silent no-op.** The loader validated the flag but never copied it into the runtime config, so `preferLocalAgents: false` had no effect and a host with a native agent CLI (e.g. `opencode`) installed always resolved to the local command. The loader now threads it through.

## [relay 0.6.0] - 2026-06-21

A `@ganglion/xacpx-relay` release (the hub bundles the dashboard `@ganglion/xacpx-relay-web`; core is the `0.13.0` entry above). Brings session archive & delete to the dashboard.

### Added

- **Archive & delete sessions from the dashboard.** A per-session overflow menu plus mobile swipe actions (swipe left to archive, right to delete). Archived sessions are greyed out and sunk to the bottom of the list; archiving shows an undo toast; both actions are disabled while offline. Delete maps to the new core real-delete, and archive/unarchive round-trip through the hub.

## [relay-protocol 0.1.2] - 2026-06-21

### Added

- `sessions.archive` / `sessions.unarchive` request messages and an `archived` field on `SessionDto`, so connectors and the dashboard can drive and reflect session archive state. Additive and backward-compatible — consumers on `^0.1.0` pick this up automatically.

## [channel-relay 0.2.1] - 2026-06-21

### Added

- The relay connector now dispatches `sessions.archive` / `sessions.unarchive` (and the real-delete path) to the core `ControlService`, so the dashboard's archive/delete actions reach the session.

## [relay 0.5.2] - 2026-06-21

A `@ganglion/xacpx-relay` release polishing the installable dashboard for iOS / mobile (the hub bundles the dashboard; core `@ganglion/xacpx` is unchanged).

### Fixed

- **iOS safe-area (notch / home indicator):** installed as a standalone PWA the dashboard ran edge-to-edge, so the top bar sat behind the notch and the composer behind the home indicator. The top bar, the mobile drawers, and the composer now respect `env(safe-area-inset-*)`, and the top bar keeps a full-height control row below the inset. The mobile viewport also gains `interactive-widget=resizes-content` so the keyboard resizes the layout instead of overlaying the composer.
- **Home Screen icon white border:** the generated icons carried a thin transparent edge margin that iOS composited onto white. Icons are now flattened to opaque, full-bleed brand tiles (declared `any`, not maskable — a maskable icon makes iOS shrink the tile into the safe zone), with a full-bleed `apple-touch-icon`.

### Added

- SVG favicon (`icon.svg`) and a Safari pinned-tab `mask-icon.svg`.
- A cross-platform icon-regeneration tool (`scripts/finalize-icons.mjs`, `node:zlib` only — no Python or macOS `sips`).

## [0.12.1] - 2026-06-21

### Fixed

- **`xacpx channel rm <type>` now clears the channel's stored credentials.** Previously it only removed the config entry and left credentials behind — for the relay connector this orphaned `~/.xacpx/relay/credential.json`, so after the hub's database was reset the connector kept presenting the dead credential (`unknown instance or bad credential`) and the dashboard showed no instances, with no CLI path to clear it. `channel rm` now invokes the runtime's destructive `logout()` hook (relay clears its credential; WeChat clears its login) so a later re-add re-pairs cleanly. Pass `--keep-credentials` to remove only the config entry.

## [relay 0.5.1] - 2026-06-20

### Fixed

- **Login screen pointed at a non-existent command:** the dashboard login hint told users to paste the access token from `xacpx-relay user new`, but the relay CLI has no such command. Corrected to `xacpx-relay add token` (the actual token command). A regression test now asserts the hint references the real command.

## [relay 0.5.0] - 2026-06-20

A `@ganglion/xacpx-relay` hub release (core `@ganglion/xacpx` unchanged). The hub bundles the dashboard, so this ships the relay-web change below.

### Added

- **The dashboard is now an installable PWA (`@ganglion/xacpx-relay-web`):** a web app manifest, brand icon set (blue/green "X", including a purpose-built maskable variant), and a Workbox service worker registered from `main.ts`. You can install the dashboard to the home screen / as a standalone window, and the app shell (JS/CSS/fonts/icons) is precached for instant repeat loads. It's a WS-backed live console, so the scope is installability + fast loads, **not offline data** — live data still needs the WS reconnect. The service worker uses `autoUpdate` (new versions activate on the next navigation) and a `navigateFallback` denylist so it never shadows the hub's `/api` / `/ws` routes.

  > **Operator note:** service workers and installability require a **secure context** — terminate TLS at your reverse proxy and serve the hub over `https://`. Plain `http://` (LAN IP) will not register the service worker or offer installation. See [docs/relay-deployment.md](docs/relay-deployment.md).

## [0.12.0] - 2026-06-20

A relay-web dashboard wave, plus the core seam that powers a live **context-usage meter**. Released together: core `@ganglion/xacpx` 0.12.0, `@ganglion/xacpx-relay-protocol` 0.1.1, `@ganglion/xacpx-relay` 0.4.0 (the hub bundles the dashboard). The `@ganglion/xacpx-channel-relay` connector is unchanged — it forwards the new event through its existing generic passthrough.

### Added

- **Context-usage meter (core seam → dashboard):** the agent's ACP `usage_update` (tokens currently in context + the model's total context window) is now plumbed end to end. A new `onUsage({used,size})` transport callback is parsed from the stream and threaded through the acpx-bridge protocol, the command router/handlers, and `ControlService`, which emits a new `turn-usage` `ControlEvent` (mirrored in the relay protocol's `ControlEventDto` + web gate). The dashboard composer shows a compact per-session meter (a `%` bar next to the model chip, tiered at 75%/90%), hidden when the agent doesn't report usage (e.g. codex). Verified by a live acpx probe: claude reports it, codex does not.
- **Dashboard internationalization (`@ganglion/xacpx-relay-web`):** full i18n with English + Simplified Chinese catalogs (vue-i18n), auto-detected from the browser with English fallback and a language switcher in Settings → Appearance. Catalog parity is enforced by a test.
- **Rename instances from the dashboard:** a `PATCH /api/instances/:id` (ownership-gated) and a name field in the Manage-instance dialog.
- **Git branch + worktree context in the dashboard:** `WorkspaceFs.gitDiff` now also returns the current branch (or detached state) and worktree context (root path + a linked-worktree flag); the chat header shows the branch and the Files → Changes tab shows a git-context header.

### Changed

- **Right-rail panels scroll internally** instead of stretching the sidebar; pinned headers (search/breadcrumb, change summary, orchestration heading) with a single scroll region each (no more double scrollbars).
- **Sidebar/task polish:** instance rows collapse/expand correctly; the orchestration list is newest-first and capped at 10 with a "+N more" affordance; the scheduled-tasks panel was restyled (icon + count header, create form behind a toggle, dashed empty state).

### Fixed

- The composer no longer white-screens when a `control.session.model.get` reply is malformed — `available` is coerced to an array.
- Header context chips stay on one line and truncate (long branch names no longer overflow the fixed-height header); the dashboard root uses `h-dvh` for a mobile-safe viewport.

## [0.11.0] - 2026-06-13

The **relay hub** release: a self-hosted, multi-tenant remote-control panel for xacpx. Instances dial out over WSS to register; account-holders log in to a three-column web dashboard to cross-manage their instances' sessions — chat, scheduled tasks, and orchestration. The source of truth stays in each xacpx instance; the relay only handles accounts, routing, fan-out, and a display cache. Built and reviewed in five phases; ships the core Control API seam that the `@ganglion/xacpx-channel-relay` connector requires (`minXacpxVersion: 0.11.0`).

### Added

- **Core Control API (`src/control/`):** a typed control surface (`ControlService`) collecting sessions, prompt, scheduler, and orchestration operations plus an `executeCommand` fallback, alongside a structured `ControlEventBus` (turn output/finished, sessions/scheduled/orchestration changed). Injected into channels via the optional `ChannelStartInput.control` field, parallel to the existing command router and sharing the same underlying services. This is the seam structured consumers (the relay connector) build on.
- **`@ganglion/xacpx-relay-protocol`:** a zero-runtime-dependency shared package — a versioned JSON envelope (`{ protocolVersion, kind, id?, type, payload }`), instance↔relay and web↔relay DTOs, and validating type guards. A `protocolVersion` mismatch produces an explicit error rather than a silent downgrade.
- **`@ganglion/xacpx-relay`:** the hub server — SQLite via a `bun:sqlite`/`node:sqlite` adapter (accounts, invites, instances, pairing tokens, web sessions, message cache), scrypt password hashing, a WS instance gateway (credential auth, heartbeat, request/response routing, per-account event fan-out), a Hono HTTP API (login with rate limiting, admin invites, instance pairing, an RPC proxy that stamps `chatKey`/`senderId`/`isOwner` server-side and only forwards `control.*`), cookie-authenticated `/ws`, a retention/GC maintenance loop, and an `xacpx-relay` CLI (`start`/`init-admin`/`token new`) on dual ports (8787 HTTP / 8788 instance WS).
- **`@ganglion/xacpx-channel-relay`:** the xacpx-side connector plugin (channel type `relay`). Pairs with a one-time token, exchanges it for a long-lived instance credential stored at `<xacpx-home>/relay/credential.json` (mode `0600`, never `config.json`), reconnects with exponential backoff, bridges relay RPCs to `ControlService`, and forwards control events. Added via `xacpx channel add relay --url <wss-url> --token <pairing-token>`.
- **`@ganglion/xacpx-relay-web`:** the Vue 3 + Pinia + Tailwind dashboard — login + route guard, a three-column IM layout (instance/session tree, streaming chat with `/command` fallback and cancel, per-session scheduler + orchestration panels), instance-notice toasts, a settings page (account invites, instance pairing, history-retention display), and a snapshot-plus-event-delta model that re-pulls on reconnect to avoid ghost state.

### Security

- **Multi-tenant isolation** is enforced at every layer: all instance/session/message/task access is `account_id`-scoped (stores, HTTP routes, and the `/ws` fan-out).
- **Unforgeable identity:** the relay stamps `chatKey=relay:<accountId>`/`senderId`/`isOwner` server-side after spreading the client payload, and only `control.*` RPC types are proxied — clients cannot forge identity or reach non-control surfaces.
- **Secrets at rest:** passwords (scrypt), invite/pairing tokens, instance credentials, and web-session tokens are all hashed; pairing/invite tokens are single-use; nothing secret is logged or returned in a response/DTO.
- **CSRF:** body-parsing mutating routes require `application/json` (returning `415` otherwise), forcing a CORS preflight on cross-site forgery; web sessions are `HttpOnly`, `SameSite=Lax` cookies. A timing-safe credential comparison and a bounded login-failure map round out the hardening.

### Docs

- New module guides — `docs/control-module.md`, `docs/relay-module.md`, `docs/relay-web-module.md` — and a relay-hub design spec under `docs/superpowers/specs/`.

## [0.10.1] - 2026-06-11

A daemon-startup fix plus a substantial `xacpx doctor` upgrade (#24, #25, #26).

### Added

- **`xacpx doctor --fix` repair mode (#25, #26):** doctor can now apply a small set of safe, local repairs and then re-run the affected checks. Repairs are conservative and lazily executed: only safe/local fixes run, a failing repair is recorded as `failed` rather than crashing doctor, and the exit code reflects the post-repair state. Auto-applied fixes are `runtime.ensure-private-dir` (create/chmod the runtime dir to `0700`), `state.quarantine` (quarantine invalid/corrupt `state.json` records), and `daemon.clear-stale-lock` (remove `*-consumer.lock.json` files whose recorded pid is dead). State-mutating repairs are **gated on the daemon being stopped** and are withheld (reported `skipped`) while it runs; without `--fix`, a fixable check is flagged inline. Missing/broken plugins, disabled plugins, invalid config, and WeChat logout stay suggestion-only (network/intent/interactive).
- **`xacpx doctor` plugin/channel health check (#25):** the plugin-load diagnostics previously reachable only via `xacpx plugin doctor` are now folded into `xacpx doctor` as the `plugins` check — this is the check that catches a channel plugin failing to load after a core update (e.g. `Cannot find module '@ganglion/xacpx-channel-feishu'`). Carries structured `xacpx plugin …` remediation suggestions.
- **`xacpx doctor` orchestration IPC liveness check (#25):** when the daemon is live, doctor probes whether the orchestration IPC endpoint actually accepts connections, catching a daemon whose heartbeat is fresh but whose orchestration server has died. Conservative: only a definitive no-listener fails.
- **`xacpx doctor` log/disk growth check (#25):** sums the daemon log files (and rotation siblings) and warns when a single file exceeds 50 MB or the total exceeds 200 MB.
- **PR test CI (#26):** added a GitHub Actions workflow that runs `npm test` and `bun run build` on every pull request and push to `main` — the repo previously ran no tests on PRs.

### Fixed

- **Daemon `start`/`restart` no longer falsely reports "did not report ready" (#24):** the warm queue-owner orphan sweep is decoupled from the daemon readiness signal. The sweep used to run before the status write, so whenever it used its full ~5s budget the controller's startup timeout could fire on a perfectly healthy daemon. The daemon now writes its ready status promptly and joins the (best-effort) sweep before channels begin serving; the controller startup backstop was widened to 10s.
- **`doctor --fix` repair gating hardened (#26):** `isProcessAlive` now treats `EPERM` (process exists but is owned by another user) as alive — for repair gating the unsafe direction is reading a live process as dead, so only a definitive `ESRCH` reads as dead. State-mutating repairs also re-verify daemon liveness at apply time, closing the window where a daemon starts between detection and `--fix`: `state.quarantine` refuses, and `daemon.clear-stale-lock` re-checks each lock and skips any whose owner is alive again.
- **`doctor` logs-check messaging (#26):** an unreadable runtime dir is no longer reported as "no runtime logs yet"; it skips with a could-not-read summary and the underlying error.

### Docs

- New `docs/doctor-command.md` (and Chinese `docs/zh/doctor-command_zh.md`) documenting the full check matrix, severities, and the `--fix` safety/gating model; `--fix` added to the doctor sections of `README.md`, `docs/zh/README_zh.md`, and the VitePress CLI reference (en + zh). (#25, #26)

## [0.10.0] - 2026-06-11

A large hardening release covering three review batches: a codebase-review fix batch (#20), a deferred security/group-auth/persistence batch (#22), and a follow-up batch (#23).

### Added

- **`ownerIds` config for group command authorization (#22):** group-owner-only commands no longer depend on the channel protocol exposing group roles (WeChat has none). Configure `channel.ownerIds` (or `channels[].ownerIds`) with the trusted sender ids — visible in `command.blocked` log entries — to grant a user owner-level commands in groups. `withEffectiveOwner` computes the effective owner per turn at a single seam and writes an explicit boolean when configured; `[]` is an explicit revocation. Yuanbao still self-asserts via `bot_owner_id` when `ownerIds` is unconfigured.

### Security

- **Runtime dir and orchestration socket are now user-private (#22):** the runtime directory is created `0o700` (with chmod repair on startup), lazily-created runtime subdirectories also use `0o700`, and the Unix orchestration socket is chmod'd `0o600` after listen — so other local users can no longer read state or drive the orchestration endpoint. See the trust-boundary section in `docs/external-mcp.md`.
- **Privileged commands fail closed without `chatType` (#22):** an interactive turn that carries `metadata.channel` but no `chatType` is now rejected for privileged commands (was fail-open). Internal scheduled-dispatch turns are exempt.
- **`/config set` blocks prototype pollution (#22):** config keys that would touch `__proto__` / `constructor` / `prototype` are rejected before any write.
- **`/later` and MCP scheduled list/cancel are scoped to the originating chat (#22):** cross-chat list/cancel now behaves as not-found — no save, no existence leak across chats. Operator/scheduler internals use explicit all-chat variants.

### Changed

- **Free-text command bodies are stored verbatim, quotes intact (#23):** `/later`, `/delegate`, and `/group new` now slice the original input for their free-text body instead of re-tokenizing it, so quotes and inner spacing are preserved. Behavior change: `/group new "x y"` stores the quotes literally. Structured arguments keep tokenized behavior.
- **Case-insensitive command names + smart-quote tokenization (#22):** command words match case-insensitively and curly/smart quotes are tokenized like straight quotes.

### Fixed

- **Config writes preserve hand-edited `config.json` (#22, #23):** `ConfigStore` now raw-patches the on-disk document (read → parse → patch subtree → validate → atomic write) instead of rewriting the whole parsed model, so unknown/hand-added fields survive a `/config set`. A single non-reentrant file lock is held across the whole read → patch → write span. New config files round-trip correctly.
- **Bad `state.json` records are quarantined instead of bricking startup (#22):** corrupt records are collected and skipped (original bytes backed up to `state.json.quarantine-<ts>`); a wholly corrupt file is renamed `state.json.corrupt-<ts>` rather than crashing. `doctor` now inspects state without mutating it and surfaces load repairs.
- **Session-init deadline is bounded and shared (#22, #23):** bridge-side session initialization is bounded by `sessionInitTimeoutMs`, and a single deadline is shared across all `ensureSession` steps (ensure / show-probe / new / verbose-fallback / EPERM-repair) so the total wait can't compound.
- **Scheduled tasks: correct failure domains (#20, #22, #23):** a dispatched task is no longer recorded as failed when only `markExecuted`'s save throws; the in-memory claim rolls back when `claimDueTasks` save fails; `tick()` is hardened against store errors and `Invalid Date` is guarded in `/later`.
- **WeChat credentials are no longer wiped on shutdown (#20):** channel stop is non-destructive; the chat `/logout` command was dropped.
- **Background results survive session switches (#20):** switching the active session preserves background task results and stops cross-agent command inheritance.
- **Session/clear correctness (#20, #22):** `/session new` refuses an alias that already exists; `/clear` closes the previous transport session for non-native sessions too; `/session rm` reply names the promoted previous session; `listAllResolvedSessions` dedupes by composite identity rather than session name.
- **Zero-quota final answers are no longer silently dropped (#22):** when a final answer is fully parked due to exhausted quota, the user is notified, for both interactive and scheduled turns.
- **Plugin name normalization and Windows spawning (#20, #22, #23):** plugin uninstall/dependency-guard/`doctor` key off the normalized installed name; the plugin rm success message names the normalized package; Windows spawns `npm` and plugin package-manager commands via the shell with quoted args; install specs that can't survive the win32 shell path are rejected.
- **Daemon and logging resilience (#20):** `status.json` is written atomically (tmp + rename); logger write and cleanup failures can no longer crash message handling or daemon startup; queue-owner reap targets dedupe by composite identity.
- **Bridge stability (#20):** `permissionPolicy` is plumbed through the bridge transport, stdin backpressure is no longer treated as a write failure, and stdin `error` events are swallowed so a failed write can't kill the daemon.

### Docs

- Plan documents for the three batches under `docs/superpowers/plans/` (review fix batch, deferred batch, follow-up batch).

## [0.9.3] - 2026-06-08

### Fixed

- **Orphaned warm queue-owner process trees are now cleaned up (#19):** warm `acpx __queue-owner` process trees (owner → agent → `xacpx mcp-stdio` bridges) used to leak as orphans when a daemon exited without a clean shutdown — Windows `xacpx stop` force-kills via `taskkill /T /F` before `dispose()` can run, and crashes/reboots skip it entirely. The daemon now reaps stale warm queue owners at startup (after the consumer lock is held, so no peer owns them, and before channels start, so it never kills an owner from the current run). Additionally, the `mcp-stdio` bridge self-terminates when the orchestration endpoint is gone, via an endpoint-liveness watchdog that shuts down only after 3 consecutive definitive no-listener results (`ECONNREFUSED` / `ENOENT`) — needed because on Windows the `cmd`/`.cmd` shim keeps the parent-pid watchdog from ever firing. Tunable via `XACPX_MCP_ENDPOINT_CHECK_INTERVAL_MS` (default 10s); emits a `daemon_endpoint_dead` shutdown reason.
- **`update` all/interactive now upgrades unpinned plugins (#18):** `xacpx update` previously skipped plugins with no recorded version in config — silently in interactive `a`/all mode, and with a loud error in `--all` mode — even though `xacpx plugin update <name>` handled them fine. Unpinned plugins are now upgraded to latest and pinned to the installed version, matching `xacpx plugin update`. Removed the now-unused `targetNotPinned` message.
- **Stable coordinator identity across `/clear` (#17):** orchestration ownership guards, coordinator wake, purge/block on session removal, the `scheduled_create` attach guard, and MCP queue-owner classification now key off a stable coordinator identity that survives `/clear`, instead of the volatile session id that `/clear` rotates. This prevents a coordinator from losing ownership of its in-flight orchestration tasks after a `/clear`.

### Changed

- **Coordinator identity normalized at boundaries (#17):** coordinator identity is normalized at RPC source, route/result-injection, and WeChat slash-handler sites via a shared `stableCoordinatorSession` helper, and the dormant reset-coordinator GC machinery was removed.

## [0.9.2] - 2026-06-06

### Added

- **Per-channel `replyMode`:** channels can now declare their own default reply mode (`stream` / `final` / `verbose`). The effective mode resolves through the per-channel default and is shown in `/replymode`; settable via `/config set channels.<id>.replyMode` or the channel CLI `set-reply-mode <id> <mode>`. (#14)
- **`/clear` keeps agent-side native sessions native:** when the current session is an agent-side (native) session, `/clear` re-marks the fresh session as native by reading back the new rollout's `agentSessionId`, then best-effort closes the previous native session (guarded so a transport shared by another alias is never closed). Falls back to a plain xacpx session if the fresh agent id is unavailable, so `/clear` always succeeds. Backed by a new optional `getAgentSessionId` on `SessionTransport`, wired through both the acpx-cli and bridge transports. (#15)

### Changed

- **Internal `weacpx` → `xacpx` symbol scrub (no behavior change):** renamed the orchestration MCP server wire name (`weacpx` → `xacpx`, tool prefix `mcp__weacpx__*` → `mcp__xacpx__*`), the Windows pipe (`weacpx-orchestration` → `xacpx-orchestration`), the logical session source enum (`weacpx` → `xacpx`; loading still accepts the legacy value), internal command/version symbols, and the `weacpx-mcp-*.ts` files (→ `xacpx-mcp-*.ts`). The default Weixin bot agent name is now `xacpx`. All public back-compat (env vars, plugin-api aliases, persisted state) is preserved. (#16)

### Fixed

- **Stale `weacpx:` warning prefix:** the plugin-api resolution-shim copy-failure warning still prefixed itself `weacpx:`; corrected to `xacpx:` to match the rename.

### Docs

- Scrubbed the remaining `weacpx` product name from comments, env hints, and developer docs; synced runtime home-dir paths (`~/.weacpx` → `~/.xacpx`) and CLI examples; renamed `weacpx-group-usage-guide` → `xacpx-group-usage-guide`; and fixed dangling `release.md` doc links. (#16)

## [0.9.1] - 2026-06-04

### Fixed

- **Windows 系统语言自动检测：** 未显式设置 `config.language` 时，Windows 上默认没有 POSIX 环境变量（`$LANG` / `$LC_ALL` / `$LC_MESSAGES`），导致语言检测拿不到系统 locale 而总是落到英文。新增用 `Intl.DateTimeFormat().resolvedOptions().locale` 做跨平台兜底，让中文 Windows 用户也能被正确识别为 `zh`（Unix/macOS 行为不变，仍以 POSIX 环境变量为准）。(#9)
- **新建配置 `channel.replyMode` 默认值不一致：** 新配置模板此前写入 `replyMode: "stream"`，而「字段缺省时」的回退默认与文档都是 `verbose`——即新用户实得 stream，文档却说默认 verbose。改为模板也写 `verbose`，三处对齐。(#10)

### Docs

- **文档站点首页重设计：** VitePress 自定义主题（强制暗色 + WebGL/动效），新增 agent↔频道「桥」展示、自演示对话、架构流水线与能力面板。
- **修正文档站点国际化：** 定时任务、飞书、元宝页的「产品输出」示例此前在中/英文页混用了错误语言，现按各自 locale 对齐真实输出（周几、卡片状态、完成提醒、`Execute at:` / `Temp session` 等）。
- 文档与代码一致性审计（`docs/superpowers/plans/2026-06-04-doc-logic-consistency-audit.md`）。

## [0.9.0] - 2026-06-03

### Added

- **全量运行时国际化（i18n）——本版头条：** 新增全局 `config.language`（`en` | `zh`），xacpx 的所有用户可见输出——聊天命令回复、CLI 终端输出、Agent 编排提示词、错误与日志信息——都按所选语言产出。缺省时按系统 locale 推断（`$LC_ALL` / `$LC_MESSAGES` / `$LANG`，`zh*` → 中文，否则英文）并写入配置；之后可用 `/config set language en`（或 `zh`）切换（改后需 `xacpx restart` 生效）。语言会经 `XACPX_LANG` 透传到 acpx / bridge / mcp-stdio 等子进程，保持一致。
- **频道插件国际化能力：** `xacpx/plugin-api` 新增导出 `getLocale()` 与 `Locale` 类型，`ChannelStartInput` 新增 `locale` 字段（核心在 `start()` 时按值传入当前语言）。插件据此用自带的小型双语目录让自己的用户可见文本跟随 `config.language`。飞书、元宝两个官方插件已各自落地双语目录（均升至 `0.5.0`，peer 依赖提升为 `xacpx >=0.9.0`）。

### Changed

- **底层实现：** 引入 typed `Messages` 契约 + 按域拆分的 `en`/`zh` 目录（约 640 条消息），由编译期类型检查保证中英文键与参数完全对齐；新增 `no-hardcoded-CJK` 守卫测试，强制 `src/` 内不再出现硬编码中文字符串（用于匹配的固定词如中断词、acpx 输出标记除外，刻意保持与界面语言无关）。

### Docs

- 插件开发文档（仓库 + 文档站点，中英双份）新增「国际化（i18n）」章节，说明从 `ChannelStartInput.locale` 取语言、per-package 双语目录 + `setChannelLocale` 模式，以及「用来匹配的字符串不要本地化」的约束。

## [0.8.0] - 2026-06-02

### Changed

- **项目改名 `weacpx` → `xacpx`（寓意 `x → acp → x`）——本版头条：** 项目最初是「微信 + acpx」的桥，如今已通过插件支持飞书、元宝等多个频道，旧名已名不副实。本版完成改名：CLI 命令改为 `xacpx`（**只提供 `xacpx` 一个 bin，无 `weacpx` 别名**），npm 包名为 `@ganglion/xacpx`（与频道插件同 scope；裸名 `xacpx` 被 npm 判为与既有包 `cpx` 过近而拒绝，故用 scoped 名，安装 `npm i -g @ganglion/xacpx`）。所有子命令用法不变，把 `weacpx xxx` 换成 `xacpx xxx` 即可。
- **0.7.x 用户一条命令平滑升级：** 在 0.7.x 上运行 `weacpx update` 会自动识别已发布的 `xacpx`，先停掉守护进程、安装 `xacpx` 再移除旧 `weacpx`（先装后删，安装失败也不会让你无 CLI 可用），并提示今后改用 `xacpx` 命令。
- **状态目录 `~/.weacpx` → `~/.xacpx`（一次性自动迁移）：** 首次以 `xacpx` 运行时，若只存在旧的 `~/.weacpx`，会**复制**（非移动）到 `~/.xacpx`，旧目录保留作备份。若检测到旧守护进程仍在运行则跳过迁移并提示先停止，期间继续使用旧目录，避免迁移竞态。
- **环境变量同时支持 `XACPX_*` 与 `WEACPX_*`：** 所有核心环境变量经统一入口读取，优先 `XACPX_<名>`、回退旧的 `WEACPX_<名>`，老脚本/配置无需改动即可继续工作。
- **频道插件改名并升级：** `@ganglion/weacpx-channel-feishu` / `-yuanbao` → `@ganglion/xacpx-channel-feishu` / `-yuanbao`（均升至 `0.4.0`），peer 依赖改为 `xacpx >=0.8.0`，源码改用 `import "xacpx/plugin-api"`。
- **plugin-api 新增改名后的别名（旧名继续可用）：** 新增 `XacpxPlugin` 类型与 `minXacpxVersion` / `compatibleXacpxVersions` 字段；旧的 `WeacpxPlugin`、`minWeacpxVersion`、`compatibleWeacpxVersions` 仍被读取（两者同时声明时新名优先），已发布插件的元数据不受影响。

### Added

- **deprecated `weacpx` npm 包（转发 shim）：** 旧包名保留为一个**无 CLI** 的兼容包，`weacpx/plugin-api` 转发到 `xacpx/plugin-api`，并在 npm 上标记 deprecated，指向 `xacpx`。

### Compatibility

- **已安装的频道插件无需重装即可跨改名继续工作：** 插件运行时不直接依赖 npm 上的 `weacpx` 包，而是由核心在插件目录写入的本地解析 shim 提供 `*/plugin-api`；该 shim 自 0.7.0 起即同时覆盖 `weacpx` 与 `xacpx` 两个名字。
- **保持不变（兼容契约，刻意不改）：** 编排 MCP server 的线上名仍为 `weacpx`、工具前缀仍为 `mcp__weacpx__*`（避免破坏外部协调器/Agent 对工具名的引用）；持久化会话状态里的 `source: "weacpx"` 取值保持不变（避免破坏既有 `state.json` 读取）。

## [0.7.0] - 2026-06-01

### Added

- **实时会话切换 + 后台执行（核心/微信、Feishu、Yuanbao 全支持）——本版头条：** `/use` / `/ss` 现在可以在任务进行中**即时切换**会话，不必等当前回合跑完。被切走的会话继续在**后台运行**（其中途输出从聊天里静默），完成后只回传**最终结果** + 一条简短完成提醒，并在 `/ss` 列表里以 `●` 标记未读；切回该会话时回放其最终结果（若仍在执行则提示「⏳ 仍在执行中…」）。不同会话**并行运行**（按 session 划分并发车道；`/use` / `/ss` / `/cancel` / `/stop` 走抢占式 control lane，可打断正在执行的回合而非排队等待）。语义按频道形态区分：微信/元宝为线性文本（中途输出抑制、最终结果存储并在切回时回放），Feishu 为流式卡片（卡片在时间线内跑完、切回不回放）。完整说明见 `docs/commands.md`。
- **`/use -`、模糊别名匹配、按会话取消：** `/use -` 切回上一个会话；`/use` / `/ss` 支持模糊别名匹配 + 身份回显；`/cancel <alias>` / `/stop <alias>` 可取消指定会话（含后台会话），裸 `/cancel` 仍作用于前台。
- **plugin-api 新增实时切换原语导出：** `createConversationExecutor`（按 session 并发车道 + control lane 抢占）、`resolveTurnLane`、`createActiveTurnRegistry`、`toDisplaySessionAlias`。频道插件据此即可实现上述实时切换/后台执行能力；Feishu、Yuanbao 频道插件即基于此实现。

### Changed

- **频道插件现要求核心 `>=0.7.0`：** Feishu / Yuanbao 插件（均升至 `0.3.0`）用到上述新增的 plugin-api 实时切换原语，故其 peer 依赖下限从 `>=0.5.0` 提升到 `>=0.7.0`。对过旧核心安装新版插件会在**安装期**即报错，而非运行时才崩。
- **内部重构（无行为变化）：** 将 conversation-executor 移到中性的 `src/runtime` 并补充 channel-agnostic 的 `resolveTurnLane`，作为上述 plugin-api 导出的基础。

### Fixed

- **daemon 状态文件损坏不再崩溃：** `DaemonStatusStore.load()` 遇到损坏/半写的 `status.json` 现返回 null（而非抛 `SyntaxError`），`weacpx status` / `doctor` 会优雅报「indeterminate」而不是中断。
- **Feishu：** 不再为从未真正执行的回合记录完成或误发完成提醒；补全后台完成信号与 `markInactive` 接线。
- **后台结果在存储未接线时不会泄漏到前台聊天**；后台完成提醒经 final quota 闸门，配额耗尽时丢弃并记日志（结果仍可经 `/use` 找回）。
- **微信内存治理：** 上下文 token 保留与 quota 状态加 TTL + 上限、config 缓存 LRU 淘汰、过期 native 会话列表清理、transport 启动锁结算后清理。
- 插件目录解析与锁文件健壮性修复（承接 0.6.1 的目录去重方向）。

### Tests

- 新增：实时切换/后台执行在核心、Feishu、Yuanbao 三侧的覆盖（dispatch-time 会话绑定、按 session 并发、前台输出闸门、后台完成存储/提醒/切回回放、`/cancel <alias>` 解析、shutdown abort 不误记为后台失败）、`resolveTurnLane` 精确匹配契约、`weacpx/plugin-api` 运行时解析 shim 回归、冒烟场景（切换 + 后台回放）。

## [0.6.1] - 2026-05-29

### Added

- **元宝输入框命令提示：** weacpx 内置命令（`/session`、`/ssn`、`/workspace`、`/agent`、`/permission`、`/config`、`/delegate`、`/mode`、`/replymode`、`/status`、`/cancel`、`/later`、`/help`）现在会在元宝输入框输入 `/` 时作为提示出现。命令目录由核心从 `HELP_TOPICS` 派生（`listWeacpxCommandHints()`），经 `ChannelStartInput` 注入频道（核心拥有目录、插件只读注入数据）；元宝频道在 WS 连接就绪（含每次重连）后通过 `SyncInformation` 协议推送给后端，best-effort、失败仅记日志。

### Changed

- **MCP `task_watch` / `task_get`：** `task_watch` 到达终态时直接带回结果；`task_get` 默认不再回显 prompt。
- 内部重构（无行为变化）：新增并复用 sanitize / path / text / async 等共享工具模块，消除重复实现。

### Fixed

- **元宝自定义命令此前无法在输入框显示：** 命令原先全部塞进 `SyncInformation.botCommands`，而该桶会被元宝/OpenClaw 后端按其内置框架命令词表过滤，导致只有 `/help`、`/status` 能出现。改为走 `pluginCommands` 自由桶后，全部内置命令均可显示。
- **`/delegate` 等命令的错误提示误导：** 被识别但参数不全的命令（如裸 `/delegate`）此前一律误报“会话创建格式”；现按命令显示其自身帮助主题。
- **`weacpx plugin add` 不识别 Windows 路径：** `looksLikePath` 仅认 POSIX 前缀（`./`、`../`、`/`），导致 Windows 反斜杠相对路径（`.\pkg`）被当作 npm 包名传给 `bun add` 而失败（`Could not find package.json`）；现识别 `.\`、`..\`、`\` 及盘符绝对路径（`C:\`、`C:/`）。
- **插件目录重复依赖损坏锁文件：** 同一包先后以 npm 版本与本地路径安装，会在 `~/.weacpx/plugins/package.json` 留下重复依赖键，进而使 `bun.lock` 解析失败（`InvalidPackageKey: failed to parse lockfile`）。`installPluginPackage` 现在安装前归一化该文件、塌缩重复键（后者值生效），既修复既有损坏也防止复发。

### Tests

- 新增：命令提示导出器、核心版本常量防漂移、元宝命令同步映射与 `syncCommandsOnReady`（重连/后端拒绝/异常路径）、`looksLikePath` 跨平台识别、插件目录去重（含安装路径接线）、`invalid` 命令帮助渲染。

## [0.6.0] - 2026-05-27

### Added

- **接入 Agent 本地原生会话（`/ssn`）：** 新增一组命令，把本机上 Codex 等 Agent 已有的**原生会话**接到 weacpx 里——接入后在微信/飞书/元宝继续发普通消息，会继续同一个 Agent 原生 session，而不是复制一份新上下文。查询：`/ssn`（按当前会话上下文）、`/ssn <agent> --ws <workspace>` / `-d <path>`（按工作区或路径，唯一候选时自动接入）、`... --all`（跨 cwd），底层返回分页时列表末尾给出「更多」命令。接入：`/ssn <编号>`、`/ssn <编号> -a <别名>`（按编号接入并指定别名，**微信里看不到完整 id 时用这个**）、`/ssn attach <sessionId> -a <别名>`（已知完整 id）。`acpx-cli` 与 `acpx-bridge` 两种 transport 均支持（依赖 acpx 的 agent-side `sessions list` 与 `--resume-session`）；当前 acpx/Agent 不支持时提示降级到 `/ss`。接入后会生成普通 weacpx 逻辑会话别名（默认 `<agent>-<sessionId尾号>`，冲突自动追加后缀），可在 `/ss` 列表里看到、用 `/use` 切回；群聊中 `/ssn` 仅群主可用。完整说明见 `docs/native-sessions.md`。

### Changed

- **native 会话列表渲染格式改为 channel 声明的能力位：** 列表渲染（微信用卡片、其它频道用 markdown 表格）不再按 channel id 硬编码，改由 channel 通过 `MessageChannelRuntime.nativeSessionListFormat`（`"cards" | "table"`，缺省 `table`）声明；内置微信声明 `cards`。新增频道想用卡片渲染，声明该能力位即可，无需改命令层。
- **内部重构（无行为变化）：** 抽取两个 transport 共享的 `sessions list` 编排与结果校验到 `agent-session-list.ts`（消除重复、防止两侧实现漂移）；把「默认频道 weixin 的逻辑会话别名不加前缀」这条 scoping 规则收敛到单一 `scopeDisplayAliasToInternal`，顺带修正 shortcut/native 路径上的双前缀边界。

### Fixed

- **损坏的 native 会话列表缓存不再阻塞 daemon 启动：** `state.json` 的 `native_session_lists` 是可再生的带 TTL 缓存；现非对象字段重置为空、单条损坏条目跳过，不再因一条脏缓存抛错中断整个状态加载（`sessions` / `chat_contexts` 等真实状态仍严格校验）。
- 一批 native 会话的边界与渲染修复：跨 cwd 分页保留查询上下文、列表绑定与陈旧缓存清理、`--filter-cwd` 不被支持时去掉重试并本地过滤、拒绝非法标志、微信卡片渲染与飞书表头重复、按 sessionId 尾号生成别名等。

### Docs

- 新增 `docs/native-sessions.md`（`/ssn` 完整语义、使用流程与排障）；`README` / `docs/commands.md` / `docs/code-wiki.md` 补充 native 会话能力与命令速查。
- 文档脱敏：把 MCP 配置示例里写死的本机路径（nvmd 下的 `node.exe`、`E:\projects\weacpx\dist\cli.js` 等）替换为占位符，日志查看示例统一用 `~`。

### Tests

- 新增大量单测，覆盖 native 会话的命令解析、路由、两种 transport 的 list/resume、状态缓存宽松解析、channel 渲染能力位解析与 alias scoping。

## [0.5.2] - 2026-05-26

### Fixed

- **交互回合补全聊天路由元数据（修复飞书/内置微信下 `scheduled_*` 工具与群主鉴权失效）：** 当前会话内部的 `scheduled_create` / `scheduled_list` / `scheduled_cancel` 工具以及群主命令鉴权依赖 daemon 记录的「协调会话聊天路由」中的 `chatType`，而该字段只来自频道在**交互回合**传给 `agent.chat` 的 `ChatRequestMetadata`。此前仅元宝插件在交互回合转发该元数据，飞书与内置微信只在定时回合设置、在交互回合丢弃，导致路由缺少 `chatType`，`scheduled_create` 报错 `requires current chat route metadata`，自然语言创建定时任务在这两个频道完全不可用。现飞书（新增 `buildFeishuRouteMetadata`，并把飞书 `chat_type` 的 `p2p` 归一为 `direct`）与内置微信（按 `group_id` 推导 `chatType`）均在交互回合补全 `chatType`/`senderId`/`groupId`，与元宝一致。飞书侧修复随 `@ganglion/weacpx-channel-feishu` `0.2.2` 一同发布。
- **`scheduled_create` 默认使用临时会话（与 `/later` 一致）：** 工具描述原先写作「为当前会话创建定时任务」，诱导 agent 显式传 `mode: "bound"` 把任务绑定到正在使用的会话；实际创建路径早已默认 `temp`。重写工具与 `mode` 参数描述，使 agent 默认省略 `mode`（→ 临时会话：快照当前 agent 与工作区、对话历史全新、跑完即销毁，回复仍推回原聊天），仅当用户明确要求「在当前会话里执行」时才使用 `bound`。

### Changed

- **queue owner MCP server 改名 `weacpx-orchestration` → `weacpx`：** 注入给 acpx 当前会话 queue owner 的 stdio MCP server 名称改为 `weacpx`，工具前缀因此由 `mcp__weacpx-orchestration__*` 变为 `mcp__weacpx__*`（例如 `mcp__weacpx__scheduled_create`、`mcp__weacpx__delegate_request`），与外部协调器 MCP 命名统一，也不再把定时任务工具误归入 orchestration。该 server 每次发 prompt 前临时启动、无持久化配置引用，无需迁移。

### Docs

- 新增 agent 侧原生会话 UX 设计文档（`docs/2026-05-26-agent-side-native-session-ux-design.md`）；`config-reference.md` 的「orchestration MCP 自动注入」小节更新为新命名与工具前缀示例。

## [0.5.1] - 2026-05-25

### Added

- **`/later` 临时会话执行模式（默认）：** `/lt` 定时任务到点时默认在一个为该任务新建的**临时会话**里执行——沿用创建时当前会话的 agent 与工作区，但对话历史全新；单轮执行后通过 `transport.removeSession` 销毁该 acpx 会话，且全程不写入 `state.json`。新增互斥标志 `--bind`（发送到创建时绑定的当前会话，即旧行为）/ `--temp`（强制临时）在单条任务上覆盖模式，以及配置项 `later.defaultMode`（`"temp"` | `"bind"`，默认 `"temp"`）修改全局默认。任务记录新增 `session_mode`/`agent`/`workspace` 字段；缺省 `session_mode` 的旧任务按 `bound`（绑定当前会话）处理，无需迁移。创建回显、`/lt list` 与触发通知按模式分别显示「临时会话（工作区 · agent）」或「会话：<别名>」。
- **自然语言创建与管理定时任务（当前会话内部 MCP 工具）：** 普通对话里的 agent 在理解到“稍后/明天某时提醒我做某事”时，可通过当前会话内部 MCP 工具创建、查看与取消定时任务：`scheduled_create`（只需 `timeText`/`message` 与可选模式 `temp`/`bound`，`chatKey`、会话 alias、账号、回复上下文等路由信息由 daemon 从当前会话记录解析）、`scheduled_list`（返回**全局**待执行列表，与 `/lt list` 一致）、`scheduled_cancel <id>`（按任务 id 取消，`#` 可选）。时间语法、10 秒～7 天限制、默认临时会话、`later.defaultMode`、频道投递能力检查、群聊仅群主等约束都与 `/lt` 一致。这些工具只暴露给 weacpx 为**当前对话会话**启动的 queue owner，不会出现在外部 `weacpx mcp-stdio` 配置中。
- **`weacpx later list` / `weacpx later cancel <id>` CLI 命令（含 `lt` 别名）：** 在电脑终端直接查看与取消本机待执行定时任务，适合频道不可用或只想本地管理的场景。CLI 仅提供 `list` / `cancel` 管理能力，不支持创建定时任务，也不会触发频道投递。

### Changed

- **依赖：** acpx 从 `0.8.0` 升级到 `0.9.0`。

### Fixed

- **定时任务临时会话的传输错误提示：** 临时会话（`later-<id>`，非持久化）在后端 acpx 会话缺失时，不再错误地建议 `/session new`/`attach` 该别名；缺失会话恢复也不再尝试按不存在的别名改写持久化状态。
- **首次启动种入默认 `home` 工作区：** 旧版 `config.example.json` 附带两个 placeholder 工作区（其中一个泄漏了本地 worktree 路径），按用户反馈会被原样写进真实用户的首次配置；而运行时 seed 又把工作区清空成 `{}`，导致全新安装反而一个工作区都没有。现统一只种入单个可移植的 `home` 工作区（cwd `~`，加载时展开为真实 home 目录），并在内置默认模板、`normalizeDefaultConfigTemplate` 与 `config.example.json` 间保持一致；`isFirstUse` 现将「仅带种入的 home」的配置仍视为首次使用，使交互式 onboarding 继续触发，其创建的项目工作区与 home 并存。

## [0.5.0] - 2026-05-23

### Added

- **Scheduled plugin API:** `ScheduledChannelMessageInput` is now exported from `weacpx/plugin-api`, and scheduled dispatch payloads include optional `taskId` for channels that need to correlate scheduler-originated messages.

### Changed

- **First-party plugin scheduled delivery:** Feishu 与 Yuanbao 插件实现 `sendScheduledMessage`，`/lt` 到点后向原飞书/元宝聊天发送触发通知、执行绑定会话 prompt，并把文本结果投递回原聊天。
- **First-party plugin compatibility:** Core `weacpx` is now `0.5.0`; the Feishu and Yuanbao channel plugins are released at `0.2.0`, with plugin metadata requiring weacpx `0.5.0` and package peer dependency `>=0.5.0-0`.

### Fixed

- **Feishu 定时任务卡片渲染（channel-feishu 0.2.1）：** 飞书插件定时任务的 agent 输出改为与普通消息一致的流式卡片（streaming/auto 模式）；触发通知仍为纯文本，static 模式或卡片创建失败时回退纯文本。

## [0.4.10] - 2026-05-23

### Added

- **acpx agent warm 窗口（`transport.queueOwnerTtlSeconds`）：** 新增配置项（秒，默认 `1800`/30 分钟，`0` = 永久），在 prompt 路径透传 `acpx --ttl <value>`，延长 acpx queue owner（持有 ACP agent 与模型上下文的后台进程）的空闲存活窗口，使对话停顿后的后续消息跳过 agent 冷启动（适配器 boot + `session/new`/`load`，通常数秒到数十秒）。acpx 自身默认仅 300s，过短不足以覆盖 WeChat 对话的自然停顿。`acpx-cli` 与 `acpx-bridge` 两种 transport 均支持（bridge 经 `WEACPX_BRIDGE_QUEUE_OWNER_TTL_SECONDS` 透传）；orchestration coordinator 会话因在 prompt 前预启 queue owner，同样按此 TTL 启动（内部转毫秒注入 launcher），不会因 `--ttl` 对已存在 owner 失效而落空。未配置时按 config 层默认注入，直接构造 transport 的既有行为不变。

### Changed

- **daemon stop 主动回收 warm queue owner：** weacpx 停止时枚举自身会话（logical 用户会话 + orchestration worker 会话）并终止对应的 queue owner 进程——只杀进程、**不** `close` acpx session（不改 `~/.acpx/sessions/` 元数据，下次启动正常冷恢复）。因此即便 `queueOwnerTtlSeconds=0`，daemon 停止后也不会残留 owner。该清理为 best-effort：逐会话解析 acpxRecordId（`acpx sessions show`）后按 acpx 一致的 lock key（`~/.acpx/queues/<sha256(recordId)[:24]>.lock`）终止，整体有超时兜底、全程吞错，失败或超时仅退回「owner 按各自 TTL 自然过期」，绝不阻塞或中断停止流程。

### Fixed

- **daemon 日志文件 0600 权限：** app log 的 `appendFile` 与 daemon stdout/stderr 打开均传入 mode `0600`；由于 mode 仅在创建时生效，已存在的旧日志会在首次写入/打开时 `chmod` 一次，使本次改动前创建的日志也得到加固。
- **微信凭证 / sync-buf / context token 原子 0600 写入：** 新增 `writePrivateFileSync`（`write-file-atomic` temp+rename、mode `0600`、`fsync`，并带 Windows AV 直写回落，与异步 `writePrivateFileAtomic` 对齐），用于 `saveWeixinAccount`、`saveGetUpdatesBuf`、`persistContextTokens`，消除原 `writeFileSync` 后再 `chmod` 的 world-readable 时间窗，以及崩溃时可能留下半截损坏文件的非原子写入。
- **daemon 启动健壮性加固：**
  - 插件：`loadConfiguredPlugins` 新增可选 `onPluginError`，单个坏插件被上报并跳过，而非在首个失败处中断整个 daemon 启动（连带 orchestration IPC 与健康的 channel）；未传时保持原有 throw 语义。
  - heartbeat：progress heartbeat 加单飞守卫，慢 tick 不会与下一次 interval 重叠堆积。
  - daemon-controller：spawn 前以独占方式 claim pid 文件（`open "wx"`、`0600`），并发的 `weacpx start` 会以 `EEXIST` 失败而非启动重复 daemon；spawn/写入失败时释放锁。

## [0.4.9] - 2026-05-21

### Added

- **并行 agent 委派（`parallel` opt-in）：** `delegate_request` 和 `delegate_batch` 的每个任务条目新增可选字段 `parallel: boolean`（默认 `false`）。设为 `true` 时，任务在独立的临时 acpx session 中与该 agent 的其他并行任务并发执行；任务到达终态且无待审核项后，该临时 session 自动关闭（`transport.removeSession` → `acpx <agent> sessions close <name>`）。`parallel: false`（默认）行为与以往完全一致，串行复用 agent 现有 session，无任何变化。
- **`orchestration.maxParallelTasksPerAgent` 配置项：** 新增整数配置字段（≥ 1，默认 `3`），全局限制每个 agent 同时运行的并行 slot 数量，跨所有 coordinator 和工作区计数。
- **`queued` 任务状态：** 当目标 agent 的并行 slot 已满时，新的 `parallel: true` 任务以 `status: "queued"` 创建，不占用 acpx session；有 slot 释放时自动按创建时间顺序升为 `running` 并开始执行。`queued` 任务计入 `maxPendingAgentRequestsPerCoordinator` 配额，可通过 `task_watch` / `task_get` 正常跟踪直至终态。
- **微信 channel 客户端标识头：** 出站请求新增 `iLink-App-ClientVersion`（uint32 编码的 semver）头；同时 `base_info` 新增 `bot_agent` 字段，从配置 `channels.openclaw-weixin.botAgent`（支持账号级覆盖）读取，经 UA 风格语法清洗与 256 字节上限。可选 `WEACPX_ILINK_APP_ID` 环境变量启用 `iLink-App-Id` 头，未设置时不发送（向后兼容）。
- **微信扫码登录配对码支持：** `pollQRStatus` 识别 `need_verifycode` / `verify_code_blocked` 两种状态。前者从交互式终端读取 6 位配对码并附在下次轮询的 `&verify_code=` 上；后者刷新二维码并清除暂存的配对码，连续 `MAX_QR_REFRESH_COUNT` 次锁定后放弃。新增 daemon 模式 TTY 守卫——缺少交互终端时立即放弃登录而不挂死。
- **文档：** `docs/config-reference.md` 新增"微信频道扩展配置（`openclaw.json`）"段，记录 `routeTag`（既有，长期未文档化）/ `botAgent`（新增）/ 账号级覆盖结构 / `OPENCLAW_CONFIG` 环境变量；环境变量表追加 `WEACPX_ILINK_APP_ID`。

### Changed

- **微信回复 Markdown 过滤改为流式状态机：** `markdownToPlainText` 由贪婪 regex 替换为字符级状态机（`StreamingMarkdownFilter`，从 openclaw 借鉴）——保留代码围栏内容、表格分隔行、行内反引号、`**` 加粗与非 CJK 斜体；仅在 CJK 语境剥离 `*` / `***` / `_` / `___` 斜体标记，剥离图片与 H5/H6。修复长期存在的代码块与表格被吞问题。`markdownToPlainText` API 签名不变，所有调用点零改动。

### Fixed

- **微信 contextToken 落盘持久化：** `contextToken` 现在每次 `setContextToken` 写入磁盘（`<stateDir>/openclaw-weixin/accounts/<id>.context-tokens.json`），`bot.start()` 时 `restoreContextTokens` 读回内存，`bot.logout()` 时清理对应账号。修复 daemon 重启后首条 outbound 回复因 `contextToken is required` 直接失败。新增 `findAccountIdsByContextToken` 供编排投递路径反查发送账号。
- **resolvePluginHome 防御字符串化的 undefined/null：** 当 `input.home` / `input.pluginHome` / `WEACPX_PLUGIN_HOME` / `process.env.HOME` 被传成字面字符串 `"undefined"` 或 `"null"` 时，旧 `??` 守卫视其 truthy 保留，导致 `join("undefined", ".weacpx", "plugins")` 在 CWD 下材化出 `undefined/.weacpx/plugins/`。现统一归一化为缺省值让 `??` 正确 fall-through 到 `homedir()`。同时清理 `73b08c1`（0.4.7）误提交的 `undefined/.weacpx/plugins/package.json` 并加入 `.gitignore`。
- **微信 session 过期凭证热切换：** 替换 errcode -14（session expired）时的 60 分钟死循环等待为 30 秒凭证恢复轮询——monitor 检测到 `weacpx login` 写入的新 token 后自动热切换所有依赖状态（baseUrl、token、accountId、configManager、syncBuf、dedup 窗口、session pause、context tokens）并恢复 getUpdates 循环，无需重启 daemon。新增 `resetSessionPause` 清除指定账号的暂停状态；`pollForFreshCredentials` 支持同账号刷新 token 与新账号 QR 登录两种恢复路径。

## [channel-feishu 0.1.2] - 2026-05-19

> `@ganglion/weacpx-channel-feishu` 单独发布；weacpx 本体保持 `0.4.8` 不变。

### Added

- **飞书卡片思考过程展示：** 飞书 channel 现在把 acpx 的 `agent_thought_chunk`（经 0.4.8 引入的 `onThought` 侧通道）渲染进流式卡片里一个**始终折叠**的 `🧠` 面板，header 显示「已思考 N 秒」（首个到最近一个思考片之间的活动跨度）。`onThought` 为优先数据源，回答文本内嵌的 `<think>` / `<thinking>` / `<thought>` 标签解析作为回落，兼顾走侧通道的 acpx 与内嵌标签的 agent。static（非卡片）模式不展示思考，与 `onToolEvent` 行为一致。

### Changed

- **思考面板形态：** 思考面板从常驻展开的普通 markdown 元素改为始终折叠的 `collapsible_panel`，与工具调用面板形态一致；思考内容变化时强制走全量 `card.update`，确保折叠面板内容刷新。

## [0.4.8] - 2026-05-19

### Added

- **`onThought` 思考侧通道：** 新增结构化的 `onThought` 侧通道，把 acpx 的 `agent_thought_chunk`（代理推理）作为原始 chunk 透传给注册了 `ChatRequest.onThought` 的 channel / 插件；`acpx-cli` 与 `acpx-bridge` 两种 transport 均支持。思考与回答文本分流，内置微信 channel 不展示思考，channel 可按需消费。
- **bridge 协议 `prompt.thought` 事件：** bridge 协议新增 `prompt.thought` 流式事件，bridge-runtime / bridge-server / bridge-client 一路转发，使 bridge 模式会话也能把推理 chunk 透传给 channel runtime。

### Changed

- **tool_call_update 渲染回落 `rawOutput`：** 工具调用更新摘要在 `rawInput` 没有可展示文本时回落到 `rawOutput`，避免 verbose 模式下工具调用细节为空。
- **daemon/runtime 路径尊重 `WEACPX_CONFIG`：** daemon 与 runtime 路径解析现在跟随 `WEACPX_CONFIG`，使用替代 config 路径时，daemon 状态、日志与 doctor 检查都落到对应的 `runtime/` 目录。
- **微信账号发现回落已有凭证：** 二维码登录的账号索引缺失或过期时，微信账号发现回落到已有的凭证文件。
- **版本升级：** `weacpx` 升至 `0.4.8`，`@ganglion/weacpx-channel-feishu` 与 `@ganglion/weacpx-channel-yuanbao` 升至 `0.1.1`。

### Fixed

- **飞书出站 mention 归一化：** 发送前统一 `<at id=...>` / `<at open_id=...>` 等 mention tag 变体，修复飞书出站 @ 处理。
- **飞书瞬时错误有限重试：** 飞书消息发送、媒体上传、媒体下载遇到 502 / 503 / 504 瞬时错误时增加有限重试。
- **元宝流式 Markdown 修复：** 修复元宝流式 Markdown 拼接——修复断裂的管道表格、保留代码/数学块、拆掉只含表格的 markdown fence，并避免 flush 不完整的表格/fence 内容。
- **发布 CI 修复：** 依赖升级后同步 `package-lock.json`，并在根 publish workflow 中统一使用 `npm ci`。

## [0.4.7] - 2026-05-18

### Added

- **`/session tail [N]` 命令：** 补拉当前会话的历史输出，用于 in-flight checkpoint 可视化。acpx-cli 与 acpx-bridge 两种 transport 均支持，默认 50 行，上限 500 行。
- **acpx 0.8.0 升级：** `acpx` 依赖从 `^0.6.1` 升级到 `^0.8.0`。
- **transport.permissionPolicy 支持：** 配置中新增 `transport.permissionPolicy` 字段，用于透传 `--permission-policy` 到 acpx 命令行。acpx-cli 与 acpx-bridge 两种 transport 均支持。`/config set transport.permissionPolicy` 可热更新。
- **tool_call_update 结构化事件增强：** `ToolUseEvent` 新增 `locations`、`rawOutput`、`content` 可选字段，streaming prompt 解析层从 acpx `tool_call_update` 事件中透传。
- **queue-owner payload 增强：** `QueueOwnerPayload` 新增 `promptRetries` 与 `sessionOptions`（含 `model`、`allowedTools`、`maxTurns`、`systemPrompt`）字段，支持更细粒度的 queue owner 会话配置。

### Changed

- **acpx 升级后 transport 命令参数适配：** `acpx-cli` 与 `acpx-bridge` 两个 transport 在生成 acpx 命令行参数时，条件注入 `--permission-policy` flag；当值为非空字符串时才注入。
- **bridge runtime permissionPolicy 透传：** `BridgeRuntimeOptions` 扩展 `permissionPolicy` 字段；`updatePermissionPolicy` 接口同步扩展；`buildPermissionArgs` 在 bridge 侧注入 `--permission-policy`。

## [0.4.6] - 2026-05-18

### Changed

- **MCP 工具面收敛 16 → 11。** `task_wait` 并入 `task_watch`(见下);`task_reject` 并入 `task_cancel` —— `task_cancel` 现在能取消任何非终态任务,取消一个尚未批准的任务等同于拒绝;`group_new` / `group_get` / `group_list` / `group_cancel` 四个工具替换为单个 `delegate_batch`:传一个任务数组即可,底层自动建组,整批结果一次性回注,无需协调者手工维护 groupId 状态机。
- **MCP 提示词三层去重。** 流程指引此前在 server instructions、工具 `description`、结果 `Next:` 文本里各讲一遍;现在以结果 `Next:` 文本为唯一权威来源,instructions 与 description 收敛为"做什么 + 何时用"。

### Removed

- **`task_wait` 工具。** 它是 `task_watch(mode=until_attention_or_terminal)` 的真子集 —— 后者同样阻塞到 attention/terminal,并额外内联返回事件流与任务快照。迁移:用 `task_watch` 替代;阻塞等待用 `until_attention_or_terminal` 模式,超时后以 `afterSeq=nextAfterSeq` 续轮询。注意默认超时由 5 分钟变为 1 分钟(可用 `timeoutMs` 调整,上限 20 分钟)。
- **`coordinator_follow_up_human_package` 工具。** 多轮人工问询改为:解决当前问询包后,用 `coordinator_request_human_input` 重新发起。

### Added

- **`delegate_batch` 工具。** 一次派发多个子任务;2 个及以上自动归入一个组,整批终态后结果一并回注。单个失败的任务带 `error` 字段返回,不影响其余任务。

## [0.4.5] - 2026-05-17

### Added

- **MCP 任务编排与 agent CLI：** 新增 agent CLI 与 MCP task 支持，coordinator 可通过 `delegate_request` 派遣子任务，并用原生 MCP task handle（`tasks/get` / `tasks/result` / `tasks/list` / `tasks/cancel`）跟踪。
- **acpx 内置 agent 模板：** 新增 acpx built-in agent templates，开箱即用地配置 codex / claude / gemini / opencode 等 agent。
- **`task_watch` 事件流编排：** 新增 `task_watch` 长轮询工具，基于 `afterSeq` / `nextAfterSeq` 事件游标推进；任务事件持久化为 `events[]`（200 条环形缓冲），支持 `next_event` 与 `until_attention_or_terminal` 两种模式。
- **委派进度可见：** MCP task 现在透传 worker 的实时进度（`[PROGRESS]` 行解析），coordinator 无需阻塞即可观察子任务进展。

### Changed

- **避免 MCP task 自动阻塞：** 派遣后默认返回 `running` 句柄，不再自动进入 `input_required` 等待；提示词引导优先用 `task_get` / `task_watch` 做非阻塞快照，仅在显式需要时调用 `task_wait`。
- **MCP task / agent CLI 加固：** 收紧进度解析边界、watcher 缓存上限（256）与超时钳制，修复独立进度段及正常输出后的进度行解析。

### Fixed

- **委派结果文本截断：** `extractPromptOutput` 此前只保留最后一段连续的 `agent_message_chunk`，worker 在回答中途调用工具会导致回复被切碎、只剩尾部片段。现在按顺序拼接所有消息块，跳过中间的工具调用/思考/非 JSON 噪声行。
- **MCP contested task 状态：** 修正争议复核任务的状态流转。

### Tests

- 新增 agent CLI、MCP server / tools / transport、orchestration server/service、progress-line-parser、`task_watch` 等套件的单元测试；更新 prompt-output / bridge-server / acpx-cli-transport 用例断言完整回复。

## [0.4.4] - 2026-05-15

### Added

- **Perf debug mode for Weixin turns:** 新增 `logging.perf.enabled` 开关，开启后把一次 Weixin 入站消息的关键耗时写入独立的 `~/.weacpx/runtime/perf.log`，包括 `turn.received`、`agent.dispatched`、router/session/transport checkpoint、reply 文本发送与 `turn.done` 汇总。默认关闭。
- **出站媒体性能标记：** Weixin outbound media 发送现在记录 `reply.media_sent` / `reply.media_done`，提供安全路径校验 + Weixin CDN 上传 + 媒体消息发送的粗粒度真实耗时与 sent/failed/rejected/dropped 汇总。

### Changed

- **日志滚动复用：** app log 与 perf log 共用抽出的 rotating-file writer helper，但各自保持独立 write chain，避免互相阻塞。
- **Runtime paths 暴露 perf log 路径：** `resolveRuntimePaths()` 现在包含 `perfLogPath`，`buildApp()` 使用该路径初始化 perf tracer。

### Fixed

- **Perf outcome 语义修正：** prompt abort / 已 abort / turn AbortError 不再误记为 error；transport 层用 `localOutcome` 区分 `ok` / `error` / `aborted`，Weixin turn AbortError 记录为 `outcome="aborted"` 并跳过错误通知。
- **`/session attach` perf 完整性：** attach 已存在 transport session 成功后也会发出 `session.ready` mark，与新建 session 路径保持一致。
- **Perf 故障降级：** perf log 连续 IO 失败后 tracer 进入 noop，且 app log breadcrumb 写入失败也不会产生 unhandled rejection 或影响业务。

### Docs

- 更新 `config.example.json`、`docs/config-reference.md`、`docs/commands.md`、`docs/config-command.md`，说明 `logging.perf.*` 配置、重启生效限制，以及 `/config set` 不支持动态修改 perf logging。

### Tests

- 新增 perf tracer / writer / buildApp / ConsoleAgent / CommandRouter / Weixin turn 覆盖，包括正常 prompt lifecycle、error/abort 负路径、outbound media rejected、`/session attach` `session.ready`、permanent failure noop 与 appLogger rejection 防护。

## [0.4.3] - 2026-05-15

### Changed

- **MCP 工具引导更完整：** 给 weacpx MCP server 加上"完整生命周期"引导，让外部 coordinator agent（Claude Code / Codex / OpenCode 等）不再因为不知道下一步该调用哪个工具而卡住。三层叠加：
  - **Server-level `instructions`**：新增 `WEACPX_MCP_SERVER_INSTRUCTIONS` 常量，通过 MCP `Server` 第二参数下发完整生命周期说明（delegate → wait → 按 `attention_required` 子状态分支 → 续 wait → task_get 汇报；含 `task_approve` 后回到 wait 的循环；含 batching / cancellation / discovery 等辅助路径）。
  - **每个工具的 `description` 加 "Use after X / before Y"**：`delegate_request`、`task_wait`、`task_get`、`task_approve` / `task_reject`、`task_cancel`、`coordinator_answer_question`、`coordinator_review_contested_result`、`worker_raise_question`（标注 "Worker-side only"）、group_* 全部加上指向下一步的工作流提示。
  - **结果文本里加 `Next:` 提示**：`renderDelegateSuccess`（按 `running` / `needs_confirmation` 分支）、`renderTaskWaitResult`（按 `terminal` / `attention_required` / `timeout` 分支；`attention_required` 进一步按 `needs_confirmation` / `blocked or waiting_for_human` / `reviewPending` 路由到对应工具）、`renderTaskApprovalSuccess`（指向 `task_wait`）都会在返回里追加 `Next:` 行。
- **External coordinator MCP registry 过滤：** `coordinator_request_human_input` 与 `coordinator_follow_up_human_package` 对 external coordinator 会硬抛 `"human input routing is not configured for external coordinator"`。MCP server 现在在 identity 解析时识别 external 会话（通过 `prepareMcpCoordinatorStartup` 的 `kind === "external-coordinator"`），并在 `buildWeacpxMcpToolRegistry` 阶段把这两个工具过滤掉，registry 规模从 16 → 14。Internal coordinator（WeChat 逻辑 session 走 MCP 的少见路径）保持 16 个工具不变。

### Removed

- **`OrchestrationTaskStatus` union 删除 `"pending"`：** 调查确认无任何代码路径会把 `task.status` 写成 `"pending"`（13 处 `task.status =` 赋值全部走其它分支；两个 task 构造点只用 `running` / `needs_confirmation`；`RecordWorkerReplyInput.status` 类型收窄到 `completed | failed | cancelled`；`previousStatus` 恢复路径前已 `assertNeedsConfirmation`）。同步清理 `state-store.ts isTaskStatus` 校验器、`isAttentionRequiredTask` 预判、`pendingApprovalTasks` 计数器、MCP `taskStatusSchema` / cast、`orchestration-server` 的 task list filter enum、以及一个 test fixture / test helper。**保留**所有 `"pending" | "running" | "terminal"` 的 group 过滤器（这是另一个语义层："组里有待审批任务"）。

### Tests

- 新增 MCP 工具引导覆盖：`delegate_request` running-path 的 `Next:` 提示、`task_wait` 三种 status 各自的 `Next:` 文本、`task_wait` 描述里 attention_required 子状态分支、`task_approve` 结果文本的 `task_wait` 链接、server `instructions` 的关键关键字（含 approval loop "After task_approve, return to step 2"）。
- 新增 external / internal coordinator registry 区分覆盖：external 走 `buildWeacpxMcpToolRegistry` 返回 14 工具且不含两个 human-input 工具；internal 返回 16 工具且都含；`createMcpStdioIdentityResolver` 在 existing-session 路径不带 `isExternalCoordinator` 字段。
- 负向断言保证回归：attention_required 文本里禁止再出现 `pending or needs_confirmation` 或 `coordinator_request_human_input`；`task_wait` 描述里禁止出现 `coordinator_request_human_input`；server `instructions` 同步约束。

## [0.4.2] - 2026-05-14

### Changed

- **首次启动等待 UI：** `weacpx start` 在 onboarding 后进入“正在创建初始会话”阶段时，TTY 下显示带 spinner 的等待行（`elapsed / timeout`），超过 20s 追加“首次启动可能需要准备依赖和运行环境”提示，并支持按 `Ctrl+B` 跳过等待、`Ctrl+C` 正常中断；非交互环境保持静默回退。
- **启动失败诊断更完整：** `weacpx start` / `weacpx restart` 失败时除 `Stderr` 路径外，新增打印 `App Log` 路径（`~/.weacpx/runtime/app.log`），方便第一时间定位首次启动失败原因。

### Tests

- 新增 `tests/unit/cli-startup-wait-ui.test.ts` 覆盖等待行渲染、Ctrl+B 跳过、Ctrl+C 中断与非交互回退；扩充 `tests/unit/cli.test.ts` 与 `tests/unit/daemon/daemon-controller.test.ts` 覆盖 `startupWait` 透传以及失败路径下的 App Log 提示。

## [0.4.0] - 2026-05-14

> 🎉 **正式发布。** `npm install weacpx` 现在默认获取 0.4.0；channel 插件 `@ganglion/weacpx-channel-feishu` 与 `@ganglion/weacpx-channel-yuanbao` 同步升至 `0.1.0` 正式版。0.4.0-beta.0 引入的 channel/plugin 架构、CLI 与发包工具链请见下方 beta.0 条目，本条目记录 beta 系列以来的增量改动。

### Added

- **Feishu channel 流式卡片体验：** `@ganglion/weacpx-channel-feishu` 新增 streaming card + abort + typing + permission UX，引入 ToolUseStore 与可折叠的 tool-use 面板、实时刷新的 elapsed 页脚、进程级 shutdown 钩子注册表；卡片在关停时优雅终止并保留终态，避免遗留半成品卡片。
- **Yuanbao channel 群组与媒体能力：** `@ganglion/weacpx-channel-yuanbao` 新增群历史抓取、引用解析、@-bot 自动回复识别，inbound 图片/文件下载到 `mediaStore`；outbound 改为 markdown-aware 队列并支持 merge-text 策略；日志脱敏、引用回执去重与 abortSignal 线程化。
- **Transport tool-event 结构化侧通道：** 新增 `ToolUseEvent`/`ToolUseKind` 公开类型，acpx-cli 与 acpx-bridge 串行化 `onToolEvent` 回调，prompt 接口新增 `toolEventMode`（`text` / `structured` / `both`）；bridge 协议、router、agent 一路转发结构化事件，channel 实现可按需消费。
- **`formatToolUseEventForText` 与 `TOOL_KIND_EMOJI`：** 共享文本渲染 helper，避免 channel 间漂移；channel 也可继续仅消费 `onText` 走 best-effort 文本路径。

### Changed

- **MCP stdio 加固：** `runWeacpxMcpServer` 在 Windows 上正确响应 SIGINT/SIGTERM/SIGBREAK、stdin EOF 与父进程消失；shutdown 诊断改为单火（一次事件一次日志），3s force-exit 兜底保留。
- **MCP 工具响应清理：** `coordinator_request_human_input` / `coordinator_follow_up_human_package` 触发 `QuotaDeferredError` 时不再把内部 `chatKey` 透传到 `structuredContent`；`formatToolError` 优先按 `error.code` 识别连接失败（`ECONNREFUSED`/`ENOENT`/`ECONNRESET`/`EPIPE`），不再依赖错误文本正则。
- **MCP transport 一致性：** `delegateRequest`、`listTasks` 的 optional 字段统一用 `!== undefined`，避免未来增加 boolean 字段时被 truthy 检查吞掉 `false`。
- **MCP CLI flag 解析合并：** `--coordinator-session` / `--source-handle` / `--workspace` 三个 100% 重复的解析模板抽成共享 `parseStringFlag`；现有 env/CLI 行为不变。
- **Reply mode 默认值：** Feishu channel 默认 `replyMode: "auto"`，与微信路径保持一致；reply quota 仅在微信路径生效，其他 channel 不再被 quota 限制。
- **Verbose tool 输出修复：** transport 在 `session.replyMode` 未定义时也会应用 `formatToolCalls`，避免 verbose 模式下工具调用细节被吞掉。

### Fixed

- **微信 state dir 在 Windows 上的创建：** 修复跨平台路径解析问题，避免初次启动时因目录缺失导致状态文件写入失败。
- **Feishu streaming card 抢占：** seed-during-abort 竞态、element 快路径正文截断到 `maxChars`、多卡片并发 abort 期间的 authorization 取消；卡片 footer 在终态下保留 elapsed 文本不被覆写。
- **`inferWorkspaceFromRoots` 弃用标记：** MCP identity resolution 主流程已不再走 MCP roots 推断，函数加 `@deprecated` JSDoc 提示未来移除。

### Tests

- 新增 transport `toolEventMode` / `formatToolUseEventForText` / acpx-bridge tool-event wire-format / acpx-cli onToolEvent-only 等覆盖；扩充 channel-feishu streaming card 的 shutdown reset、ToolUseStore、tool panel、live elapsed 测试；新增 channel-yuanbao 群组历史、媒体、markdown 队列、abort 测试。
- 更新 `tests/unit/mcp/weacpx-mcp-server.test.ts` 中 shutdown-hooks 测试断言为单火语义；更新 `tests/unit/mcp/weacpx-mcp-tools.test.ts` 的 `deferred_quota` 结构化内容不再包含 `chatKey`。

### Docs

- 更新 `docs/config-reference.md` 与 `packages/channel-feishu/README.md` 反映 Feishu streaming card / tool-use panel / shutdown 钩子配置。
- `src/transport/types.ts` 与 `src/transport/tool-use-text-format.ts` 的代码注释补充 `toolEventMode` / `onToolEvent` 的异步语义，以及 `formatToolUseEventForText` 作为 best-effort 文本适配器的边界说明。

## [0.4.0-beta.0] - 2026-05-11

> ⚠️ **预发布版本（prerelease）。** 通过 `npm install weacpx@next` 或 `npm install weacpx@0.4.0-beta.0` 获取；`npm install weacpx`（默认 `latest` 标签）仍指向 0.3.x 稳定版。本次为新插件架构的首个公开预览，欢迎试用反馈，正式版预计随 0.4.0 一同发布。

### Added

- **Channel 插件运行时：** 新增 `weacpx/plugin-api` 公开入口，配套 `src/channels/` 与 `src/plugins/` 提供 channel 注册表、scope、媒体存储、出站媒体安全校验、插件加载/校验/诊断/CLI、known-plugins 列表，外部 npm 包可在不依赖内部模块的情况下实现自定义 channel。
- **channel-feishu / channel-yuanbao 拆分：** 飞书与腾讯元宝 channel 独立为 `@ganglion/weacpx-channel-feishu`、`@ganglion/weacpx-channel-yuanbao`，仅依赖公开的 `weacpx/plugin-api`，按需 `npm install` 即可启用。
- **Channel/Plugin CLI：** 新增 `weacpx channel|ch list|show|add|rm|enable|disable [--account <id>]` 与 `weacpx plugin list|add|update|remove|enable|disable|doctor|known`，支持多账号 bot 与第三方插件管理；新增 `weacpx restart` 守护进程重启子命令，并提供更友好的启动失败提示。
- **Command Policy：** 新增 `command-list` / `command-policy`，slash 命令现在按 channel / 权限策略声明式启用，便于不同 channel 暴露不同命令面。
- **DebouncedStateStore：** 新增防抖 state store，将突发的状态变更聚合为单次磁盘写入，保留 last-write-wins 语义。
- **发包验证工具链：** 新增 `scripts/verify-publish.mjs`（基于 `bun pm pack --dry-run` 的多包内容/peer-dep/exclusion 校验）、`scripts/smoke-local-install.mjs`（把三个 tarball 装进临时项目并跑 `weacpx --version`），以及 `bun run verify:publish` / `publish:plugins` 脚本。
- **Bun workspace + plugin-api 构建：** 仓库切换为 bun workspace，根包与 `packages/channel-*` 同源；新增 `tsconfig.plugin-api.json` 与 `build:plugin-api` 让 `weacpx/plugin-api` 同时输出 `.js` 与 `.d.ts`。
- **新增文档：** `docs/channel-management.md`、`docs/plugin-development.md`、`docs/code-wiki.md`，更新 README/AGENTS/commands/config-* 反映新的 channel/plugin 架构。

### Changed

- **配置结构升级：** `wechat.replyMode` 被更通用的 `channel` 配置块取代（`type`、`replyMode`、channel 专属 `options`），并新增 `plugins`、按 channel 的运行时配置；旧的 `wechat.replyMode` 字段仍可通过兼容路径加载。
- **运行时全面接入 ChannelRuntime：** `buildApp`、`runConsole`、`console-agent` 注入 `MessageChannelRuntime`，编排进度/协调器消息/任务完成通知统一通过已注册的 channel 路由，不再硬编码到微信路径。
- **微信路径迁移到共享 channel API：** 微信 messaging、monitor、agent、quota-manager 改用 `src/channels/` 的媒体存储、出站媒体安全校验、入站媒体描述符、账号路由等共享能力；bridge runtime/server、transport prompt-media、sessions service、mcp server/tools、orchestration service、doctor smoke-check、logging 同步对齐。
- **私有文件原子写入加固：** `private-file.ts` 用 `proper-lockfile` + `write-file-atomic` 替换手写实现，并发写入串行化、Windows AV/EPERM 抖动可重试，写入完成后强制 `fsync`。
- **Plugin compat：** 兼容性比较时把当前 weacpx 版本中的预发布后缀视为其基础发行版（如 `0.4.0-beta.0` 视为 `0.4.0`），插件作者无须为每个 prerelease tag 额外声明。
- **版本升级：** weacpx 升至 `0.4.0-beta.0`，`@ganglion/weacpx-channel-feishu` / `@ganglion/weacpx-channel-yuanbao` 均为 `0.1.0-beta.0`，channel 包的 `peerDependencies.weacpx` 收紧到 `>=0.4.0-0`，要求 weacpx 0.4.x 起的核心 API。

### Fixed

- **`readVersion` 安装/开发布局兼容：** `src/version.ts` 同时支持 `dist/cli.js → ../package.json` 与 `src/version.ts → ../package.json` 两种布局，避免在 `npm install` 后无法读取版本。
- **跨平台 `run-tests` 脚本：** Windows 下使用 `npx.cmd` 与 `shell: true` 启动子进程，避免 ENOENT。

### Tests

- 新增 `tests/unit/channels/`（registry/scope/media-store/cli/plugin-boundary/weixin-channel/moved-channel-hints）、`tests/unit/plugins/`（loader/validator/doctor/cli/compatibility/known-plugins/package-manager/config/api-types）、`tests/unit/packages/`（channel-feishu / channel-yuanbao 的 channel/config/inbound/media/plugin/send/provider）等覆盖。
- 新增 `tests/unit/util/private-file.test.ts`、`tests/unit/cli-help.test.ts`、`tests/unit/commands/command-policy.test.ts`、`tests/unit/scripts/verify-publish.test.ts`、`tests/unit/version.test.ts`，并扩充 cli/main/run-console/orchestration/sessions/transport/weixin 现有测试以覆盖 channel runtime 注入。

### Docs

- 新增 `docs/channel-management.md`、`docs/plugin-development.md`、`docs/code-wiki.md`；更新 README、AGENTS、`docs/commands.md`、`docs/config-command.md`、`docs/config-reference.md`、`docs/developments.md` 反映新的 channel/plugin 命令面与 workspace 发包流程。

## [0.3.2] - 2026-05-01

### Added

- **外部 MCP 协调器自动发现：** `weacpx mcp-stdio` 现在支持自动从 MCP roots 推断工作区并生成协调器会话标识，`--coordinator-session` 参数变为可选；新增 `inferExternalCoordinatorSession` 与 `inferWorkspaceFromRoots` 智能推断逻辑。
- **任务等待工具：** 新增 `task_wait` MCP 工具，支持 worker 轮询等待任务完成或需要人工介入，带可配置的超时与轮询间隔上限。
- **Prompt 媒体支持：** Transport prompt 接口新增 `PromptMedia` 类型，支持图片文件作为结构化 prompt 输入，自动进行 MIME 类型检测与大小校验。
- **外部协调器注册：** 编排服务新增 `registerExternalCoordinator` 方法，支持外部 MCP 客户端注册为协调器，与现有 worker/session 机制隔离。

### Changed

- **版本升级至 0.3.2**，`acpx` 依赖升级至 `^0.6.1`。
- **编排服务并发安全增强：** `OrchestrationService` 与 `SessionService` 新增 `AsyncMutex` 状态锁，避免并发操作导致状态不一致。
- **`mcp-stdio` 命令增强：** 新增 `--workspace` 参数支持，协调器会话与工作区绑定逻辑更完善，启动前会校验 workspace 配置有效性与会话冲突。
- **README 文档更新：** 精简项目定位说明，补充外部 MCP 接入说明与更多 Agent 支持。

### Tests

- 新增 `infer-coordinator-identity`、`parse-coordinator-workspace`、`prompt-media`、`task-wait-timeouts`、`weacpx-mcp-transport` 等单元测试。
- 大幅扩充 `orchestration-service`、`orchestration-client`、`orchestration-server`、`session-service`、`state-store`、`bridge-server`、`cli`、`main`、`acpx-cli-transport`、`acpx-bridge-transport`、`handle-weixin-message-turn` 等测试覆盖。

### Docs

- 新增 `docs/external-mcp.md`：外部 MCP 协调器接入指南。

## [0.3.1] - 2026-04-28

### Added

- **本机 Workspace CLI：** 新增 `weacpx workspace list|add|rm`，并支持 `weacpx ws ...` 简写，可直接把当前终端目录注册到 `~/.weacpx/config.json`，方便在微信里通过 `--ws <name>` 引用常用项目。

### Changed

- **版本升级至 0.3.1。**
- **配置与状态文件写入更安全：** `config.json` 与 `state.json` 改为私有权限的原子写入，减少写入中断导致文件损坏或权限过宽的风险。
- **State 解析更严格：** 加强 session 与 chat context 结构校验，状态文件异常时会给出更明确的诊断信息。
- **进程终止语义更准确：** 区分 detached 进程组与普通子进程，避免误用负 PID 终止非 detached 子进程；acpx CLI 超时时会主动 abort 底层命令。
- **README 使用说明更新：** 精简项目定位说明，并补充 workspace CLI 用法。

### Fixed

- **日志脱敏增强：** JSON 日志体会自动遮蔽 token、signature、context token 以及用户消息正文，避免敏感内容落盘。
- **出站媒体路径收紧：** Agent 返回的远程媒体 URL 不再被自动下载发送，本地媒体也必须位于媒体临时目录或当前工作区内，避免越权读取/发送本机文件。
- **默认配置生成更稳健：** 当打包后的默认配置模板缺失时，会回退到内置默认配置。

### Tests

- 新增 workspace CLI、私有文件权限、state 校验、日志脱敏、媒体路径拦截、进程终止与 CLI 超时 abort 等单元测试覆盖。

## [0.3.0] - 2026-04-28

### Added

- **任务编排与多 Agent 委派：** 新增 `/delegate` / `/dg`、`/tasks`、`/task`、`/groups`、`/group` 系列命令，支持从当前主线会话委派子任务、查看任务状态、审批/拒绝待确认任务、取消任务以及按任务组批量管理。
- **MCP 编排服务：** 新增 `weacpx mcp-stdio --coordinator-session <session>`，为 acpx queue owner 注入 weacpx MCP tools，支持 worker 向 coordinator 回传结果、发起阻塞问题、请求人工输入与继续编排。
- **编排运行时与 IPC：** 新增 orchestration service/client/server、Unix/Windows IPC endpoint、任务/任务组持久化状态、worker 绑定、结果注入、coordinator 自动唤醒与进度心跳。
- **微信编排通知：** 新增任务完成/失败通知、worker 进度通知、coordinator 消息投递、跨账号通知选择，以及人工问题包/结果包渲染。
- **微信消息配额管理：** 新增按 chatKey 维护的 mid/final 消息预算、最终回复分页暂存、`/jx` 继续发送剩余内容、超额 heads-up 提示与配额事件日志。
- **缺失可选依赖恢复：** 新增 optional dependency 识别、父级 package 路径发现、自动安装与重试流程，降低 agent 运行时因缺依赖中断的概率。
- **诊断与文档：** `weacpx doctor` 新增编排健康检查；新增 `docs/commands.md`、`docs/weacpx-group-usage-guide.md`，并扩充配置、测试与 README 文档。

### Changed

- **版本升级至 0.3.0**，`acpx` 依赖升级至 `^0.5.3`，并新增 `@modelcontextprotocol/sdk`、`zod`、`zod-to-json-schema` 依赖。
- **默认微信回复模式改为 `verbose`：** `wechat.replyMode` 现在支持 `stream` / `final` / `verbose`，verbose 模式会展示更丰富的工具调用与进度信息。
- **Transport 提示链路增强：** prompt 支持传递 MCP 身份、桥接 `session.note`/`session.progress` 事件、工具调用格式化、分段聚合与配额门控。
- **配置与状态模型扩展：** 新增 `orchestration` 配置项、编排状态迁移与 state 结构校验，workspace 路径会进行更一致的规范化处理。
- **会话管理增强：** 新增 `/session rm <alias>`，移除会话时会检查活跃编排任务、清理 chat context，并在安全时释放底层 transport session。
- **守护进程与运行时路径增强：** runtime 目录现在同时用于 daemon 状态、日志与 orchestration socket；停止守护进程时改进进程树终止能力。
- **命令帮助与渲染更新：** `/help` 纳入编排主题，任务、任务组、进度、取消与错误信息以更结构化的中文文案展示。

### Fixed

- **Bridge/CLI 创建会话兼容性：** 当 acpx 不支持 `--verbose` 或 stderr 提示缺失可选依赖时，会自动降级/解析并给出可恢复提示。
- **长回复消息可靠性：** 修复超长最终回复一次性发送过多导致丢失的问题，改为预算内发送、剩余内容暂存并可通过 `/jx` 继续拉取。
- **Worker 结果注入可靠性：** coordinator 唤醒失败或消息配额耗尽时不再误标记任务结果为已注入，后续唤醒可重试。
- **微信发送错误诊断：** 对非 2xx 响应和 `errcode` 非 0 的响应统一封装，日志与提示中保留 endpoint、状态码和微信错误信息。

### Tests

- 新增 orchestration、MCP、quota、segment aggregator、optional dependency recovery、bridge protocol、微信通知与 `/jx` 等专项单元测试。
- 扩充 main/runtime、command router、state store、transport、doctor 和微信消息处理测试覆盖。

## [0.2.2] - 2026-04-13

### Added

- **Bridge 请求调度器：** 新增 `BridgeRequestScheduler` 模块，支持在 Bridge 侧对请求进行调度，使 `/cancel` 可以绕过卡住的 prompt 而不会与其他 cwd/agent 的请求冲突。

### Fixed

- **`/cancel` 会话恢复：** 当底层 transport session 丢失时（如进程异常退出），`/cancel` 会自动尝试恢复会话后再执行取消操作。
- **微信消息流阻塞：** 修复 normal 类型的微信消息在特定场景下被阻塞的问题，现在 `/cancel` 可以绕过阻塞继续执行。

## [0.2.1] - 2026-04-09

### Added

- **`weacpx doctor` 命令：** 新增本机环境诊断工具，默认检查 config / runtime / daemon / wechat / acpx / bridge 六个维度；支持 `--verbose` 展开技术细节、`--smoke` 执行真实 transport 级 prompt 检查、`--agent` / `--workspace` 指定 smoke 参数。
- **`weacpx version` 命令：** 新增版本查看，支持 `weacpx version`、`weacpx --version`、`weacpx -v` 三种写法。
- **CLI 新增 `--help` / `-h` 快捷参数。**

### Fixed

- **微信消息重复处理：** 新增滑动窗口去重机制，避免同一条消息被重复执行。
- **下划线内容被错误清理：** 修复包含下划线的 workspace 名称（如 `ec_fenqile_m`）和 Windows 路径在微信消息中被错误转换的问题。
- **会话快捷创建名称重复：** `/ss <agent> -d <path>` 生成的会话名不再重复包含 workspace 名（如 `weacpx:weacpx:codex` → `weacpx:codex`）。
- **Windows 下第三方文件锁导致会话创建失败：** 新增自动修复机制，当 `acpx sessions new` 因 EPERM 失败时自动恢复并重试。
- **Bridge transport 现已完整支持 Windows：** 会话创建不再依赖 Unix shell 脚本，直接调用 acpx。

## [0.2.0] - 2026-04-06

### Added

- **命令模块重构：** 将 `CommandRouter` 拆分为独立 handler 模块（`handlers/session-handler`、`handlers/agent-handler`、`handlers/workspace-handler`、`handlers/permission-handler`、`handlers/config-handler`、`handlers/help-handler` 等），提升可维护性和可测试性。
- **`/mode` 命令：** 新增 `/mode <modeId>` 和 `/mode show` 命令，支持在会话中切换 acpx 模式（如 code、plan 等）。
- **`/reply-mode` 命令：** 新增 `/reply-mode stream|final` 和 `/reply-mode show` 命令，支持按会话设置微信回复模式（流式分段回复或最终一次性回复）。
- **`/config` 命令：** 新增 `/config show` 和 `/config set <path> <value>` 命令，支持运行时查看和修改配置。
- **Bridge 流式 prompt：** Bridge 子进程新增流式 prompt 支持，通过 `prompt.segment` 事件实时回传中间输出；bridge server 新增 `setMode`、`updatePermissionPolicy` 方法。
- **消费者锁（Consumer Lock）：** 新增微信消费者锁机制（`consumer-lock`），防止多个 weacpx 进程同时消费微信消息，守护进程启动时自动获取锁，退出时释放。
- **会话索引解析：** 新增 `acpx-session-index` 模块，从 acpx sessions index 中解析 `agentCommand`，会话创建时自动记录并复用。
- **会话增强字段：** 逻辑会话新增 `transport_agent_command`、`mode_id`、`reply_mode` 字段，支持更完整的会话状态持久化。
- **`parseConfig` 导出：** `load-config` 的 `parseConfig` 函数现在公开导出，供 `ensure-config` 等模块复用。
- **`wechat.replyMode` 配置：** 新增 `wechat.replyMode`（`stream` | `final`）配置项，全局控制微信回复模式，默认 `stream`。
- **新增文档：** `docs/commands-module.md`、`docs/config-command.md`、`docs/daemon-module.md`。
- **新增测试：** bridge-env、bridge-runtime、command-router-config、command-router-interaction、command-router-recovery、command-router-session、ensure-config、run-console-consumer-lock、consumer-lock、execute-chat-turn、handle-weixin-message-turn 等。

### Changed

- **版本升级至 0.2.0**，acpx 依赖升级至 `^0.4.1`。
- **`nonInteractivePermissions` 默认值** 从 `"fail"` 改为 `"deny"`，同时移除了 `"allow"` 选项。
- **`SessionTransport` 接口变更：** 新增 `setMode`、`updatePermissionPolicy` 方法，移除 `listSessions` 方法。
- **Bridge server 请求校验增强：** 新增 `BridgeInvalidRequestError`，对 JSON 格式、字段类型、方法白名单进行严格校验，错误码区分 `BRIDGE_INVALID_REQUEST` 与 `BRIDGE_INTERNAL_ERROR`。
- **Bridge client 增强：** 新增 `terminalError` 状态，子进程退出后自动拒绝后续请求；writeLine 失败时直接 reject 而非静默忽略；支持流式事件分发。
- **`SessionService` 增强：** 新增 `getSession`、`setCurrentSessionMode`、`setCurrentSessionReplyMode`、`setSessionTransportAgentCommand` 方法；`toResolvedSession` 中对缺失的 agent/workspace 配置给出明确错误信息。
- **`StateStore` 增强解析：** 新增 `parseState` 函数，对 state JSON 进行结构校验，解析失败时给出更具诊断价值的错误信息。
- **守护进程状态区分：** `DaemonController` 新增 `indeterminate` 状态，当 PID 存在但状态文件缺失时阻止重复启动并给出明确错误提示。
- **进程树终止改进：** `terminateProcessTree` 现在使用进程组 ID（负 PID）发送信号，确保完整终止子进程树。
- **`runConsole` 消费者锁集成：** 启动时自动获取微信消费者锁，关闭时自动释放；冲突时记录详细日志。
- **微信消息处理重构：** 移除 `process-message.ts`，替换为 `execute-chat-turn.ts` 和 `handle-weixin-message-turn.ts` 模块。
- **命令路由测试重组：** 移除单一大文件 `command-router.test.ts`，拆分为 `command-router-session`、`command-router-config`、`command-router-interaction`、`command-router-recovery` 等专项测试文件。
- **package.json 描述更新：** `"使用微信 ClawBot 随时随地通过 acpx 控制 Claude Code、Codex 等 Agents。"`

### Removed

- 移除 `src/weixin/messaging/process-message.ts`（被新模块替代）。
- 移除 `nonInteractivePermissions: "allow"` 选项。
- 移除 `SessionTransport.listSessions` 方法。
- 移除 `render-text.ts` 中不再使用的辅助函数。
- 移除 `src/formatting/render-text.ts` 中的 `renderHelpText`、`renderAgents`、`renderWorkspaces`（迁移至各自 handler）。

## [0.1.7] - 2026-04-01

### Added

- 新增 `docs/commands-module.md`（命令路由模块架构说明）与 `docs/daemon-module.md`（守护进程子系统概述），补充 `docs/testing.md` 参考路径说明。
- 新增 `src/commands/router-types.ts`（统一上下文与 Ops 接口类型）与 `src/commands/transport-diagnostics.ts`（transport 错误摘要复用工具）。

### Refactored

- `command-router.ts` 拆分为 8 个独立 handler 文件：`agent-handler`（`/agent add`、`/agent rm`）、`help-handler`（`/help`）、`permission-handler`（`/permission mode`、`/permission auto`）、`session-handler`（会话创建/绑定/切换/prompt/cancel/status）、`session-recovery-handler`（会话创建失败渲染与恢复）、`session-reset-handler`（`/session reset`）、`session-shortcut-handler`（`/session shortcut`）、`workspace-handler`（`/workspaces`、`/workspace new`、`/workspace rm`）。`command-router.ts` 本身转为轻量调度层。
- `tests/unit/commands/command-router.test.ts`（约 900 行）拆分为 `command-router-config.test.ts`、`command-router-interaction.test.ts`、`command-router-recovery.test.ts`、`command-router-session.test.ts` 四个专项测试文件，并抽取 `command-router-test-support.ts` 共享测试辅助函数。
- `SessionTransport` 接口移除已废弃的 `listSessions()` 方法，同时从 `acpx-cli` 与 `acpx-bridge` 两个 transport 实现中移除对应逻辑。

### Fixed

- 修复 Windows 环境下媒体临时文件路径硬编码为 `/tmp/` 导致写入失败的问题。`process-message.ts` 改为使用 `os.tmpdir()`，并导出 `resolveMediaTempDir()` 供测试注入。
- `bridge-server.ts` 增强错误处理：抽取 `BridgeInvalidRequestError` 专门处理无效请求 ID 解析，将错误码区分为 `BRIDGE_INVALID_REQUEST` 与 `BRIDGE_INTERNAL_ERROR` 两类。

### Docs

- `AGENTS.md` 与 `CLAUDE.md` 更新构建命令说明，补充 `npx tsc --noEmit` 类型检查步骤与 `transport.permissionMode` 默认为 `approve-all` 的说明；同步更新 transport API 列表（新增 `setMode`，移除 `listSessions`）。

## [0.1.6] - 2026-03-31

### Added

- 新增会话 mode 管理命令：支持 `/mode` 查看当前逻辑会话已保存的 mode，并支持 `/mode <id>` 将 mode 透传到底层 `acpx set-mode`。
- 新增会话级 `transport_agent_command` 记录与恢复机制；当后端 session 丢失或 agent 命令变化时，可基于 transport session 索引恢复会话使用的实际 agent 命令。
- 新增 `/session reset` 指令及快捷别名 `/clear`，用于保留当前 alias、agent、workspace 的同时重建一个新的后端 session。

### Changed

- 命令路由现在会在创建、附加、重置逻辑会话后刷新并保存 transport 侧的 agent 命令；prompt 遇到 “No acpx session found” 时也会尝试恢复后重试一次。
- `SessionService` 与 transport 抽象已扩展为支持保存会话 mode、会话级 transport agent command，以及 bridge/cli 两种 transport 的 `setMode` 能力。
- `runConsole` 增强了 `SIGINT` / `SIGTERM` 的优雅退出处理；守护进程停止流程也增加了轮询等待与超时控制，减少残留进程与运行时文件未清理的问题。
- 默认配置模板补充了 `transport.permissionMode` 与 `transport.nonInteractivePermissions`，首次生成配置文件时会写入完整默认值。
- 测试脚本恢复了统一 test plan，先执行 `tsc --noEmit` 再逐个运行测试文件；同时补充了 `typescript`、`@types/bun` 与相关锁文件更新，保证本地 `npm test` 可直接通过。

### Docs

- 更新 `README.md`，补充 `/mode` / `/mode <id>` 的用法说明，并新增 adapter mode 参考说明。

## [0.1.5] - 2026-03-30

### Added

- ✨ **新增会话重置功能：** 引入了 `/session reset` 指令（及快捷别名 `/clear`），用于重置当前会话上下文，但保留当前的逻辑会话名称（alias）、智能体（agent）和工作区（workspace）。
- 🛑 **完善优雅退出机制：** 在控制台运行入口 (`runConsole`) 中添加了对 `SIGINT` 和 `SIGTERM` 信号的监听，通过 `AbortController` 通知 SDK 优雅关闭。
- ⏳ **守护进程关闭等待：** `DaemonController` 新增了停止守护进程时的轮询等待与超时机制，避免遗留僵尸进程或运行时文件清理不彻底。

## [0.1.4] - 2026-03-30

### Added

- 内置微信接入实现，不再依赖外部 `weixin-agent-sdk` 包完成运行时加载；仓库内新增登录、鉴权、消息收发、媒体处理、监控与存储相关模块。
- 新增微信二维码登录流程与本地账号凭证管理，包括账号索引、按账号保存凭证、登录状态检测，以及清理本机微信凭证的能力。
- 新增 `weacpx logout` CLI 命令；微信侧也增加 `/logout` 与 `/clear` 内置指令。
- 新增微信消息媒体链路，支持处理图片、视频、文件与语音消息，并支持将 Agent 返回的媒体文件回传到微信。
- 新增微信输入中间态与流式回复支持，长任务执行时可分段回传 Agent 的中间输出，而不是只在结束后返回最终结果。
- 新增权限策略命令：`/pm`、`/permission`、`/pm set allow|read|deny`、`/pm auto allow|deny|fail`。

### Changed

- `acpx-cli` 与 `acpx-bridge` 两种 transport 现在都会传递权限模式参数，支持 `approve-all`、`approve-reads`、`deny-all` 以及非交互权限策略。
- 命令路由与 transport 提示链路已调整为支持流式回调，微信端可以接收 prompt 的阶段性输出。
- 配置模型扩展了 `transport.permissionMode` 与 `transport.nonInteractivePermissions`，并补充默认值与校验逻辑。
- `runConsole` 在启动微信通道前会自动检查登录状态；未登录时会触发扫码登录。
- prompt 异常处理增强，bridge/client/router 现在会保留并记录更完整的退出码、stdout/stderr 与 NDJSON 诊断信息。
- 发布元数据调整：`package.json` 增加 `publishConfig.registry`、`engines.node >= 22`，并收敛发布文件列表。

### Docs

- 更新 `README.md`，补充了 `login`/`logout` 用法、权限策略命令、微信内置指令、Transport 权限配置，以及流式回复行为说明。
