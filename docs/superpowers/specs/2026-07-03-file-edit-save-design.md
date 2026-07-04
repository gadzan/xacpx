# File edit & save in the relay-web file viewer

**Status:** approved (design)
**Date:** 2026-07-03
**Scope:** one feature, but it crosses four publishable packages (see §8).

## 1. Goal & constraints

Turn the read-only file viewer in the relay-web dashboard into an editor: let the
user edit a text file's content and write it back to disk on the instance host.

Hard safety constraints (non-negotiable defaults):

- **Binary files are not editable.** The edit entry point is disabled for `binary: true`.
- **Truncated reads are not saveable.** A file read back with `truncated: true` (the
  server capped it) must never be saved — saving the loaded prefix would clobber the
  untruncated tail. Edit entry point is disabled.
- **Oversized files do not enter the editor.** Same line limit the viewer already uses
  for the gutter/find features; above it, no edit.
- **Writes stay gated.** The new write RPC is protected by the same
  `filesWriteEnabled()` gate as create/rename/delete (`files-write-disabled` error).
- **Stale-write protection.** A file may be edited by an agent (acpx session) between
  load and save; a save that would overwrite newer on-disk content is rejected, not
  silently applied.

## 2. New wire RPC: `control.fs.write`

There is currently no write-content RPC — the fs surface is
list/read/diff/search/create/rename/delete/copy/download. We add one.

### 2.1 Protocol (`packages/relay-protocol`)

- Add `fsWrite: "control.fs.write"` to the `MSG` map in `src/messages.ts`.
- Add request/response types:
  - request: `{ workspace: string; path: string; content: string; expected: { mtimeMs: number; size: number } }`
  - response: `{ path: string; mtimeMs: number; size: number }`
- Extend the file-read result DTO (`FileContent`) with `mtimeMs: number` so the client
  captures a concurrency token at read time.
- **Rebuild the protocol `dist/` with tsc** (the package builds with tsc, not bun — a
  bun barrel build tree-shakes the re-exports to empty). Consumers read `dist`.

### 2.2 Backend (`src/control`, ships in core `@ganglion/xacpx`)

- `workspace-fs.ts`:
  - `readFile(...)` additionally returns `mtimeMs` (from the same `stat` it already does,
    or an added `stat`).
  - New `writeFile(workspace, relPath, content, expected: { mtimeMs; size })`:
    1. Resolve + realpath the target through the existing traversal guard (reuse the
       resolver used by create/rename/remove). Reject on escape.
    2. `stat` the target. Reject if missing, a directory, or detected binary.
    3. Enforce a max content-size cap (bytes). Reject oversized writes.
    4. Compare `stat.mtimeMs` and `stat.size` to `expected`. On mismatch, throw
       `stale-write`.
    5. Write atomically via `write-file-atomic` (already a root dependency).
    6. Return `{ path, mtimeMs, size }` from a fresh `stat`.
- `control-service.ts`:
  - `async fsWrite(workspace, path, content, expected)` — guard with
    `if (!this.deps.filesWriteEnabled()) throw new Error("files-write-disabled")`, then
    delegate to `workspaceFs.writeFile(...)`.

### 2.3 Connector (`packages/channel-relay`)

- `control-bridge.ts` dispatches RPCs via an explicit `switch (envelope.type)`. Add
  `case MSG.fsWrite: return await control.fsWrite(i.workspace, i.path, i.content, i.expected)`.
- Ops note: connector changes require rebuild + reinstall into the plugin home +
  console restart to take effect (the sandbox connector is installed from a packed
  tarball, not the project `dist/`).

### 2.4 Concurrency token

The token is `{ mtimeMs, size }`, captured on read and echoed on write. This is a
heuristic (not a content hash): cheap, no re-hash, and catches the common
"opened, then an agent rewrote the file" case. Content hashing is explicitly out of
scope — mtime+size is sufficient for this feature.

## 3. Frontend editor (CodeMirror 6)

- **New isolated component `CodeEditor.vue`** wrapping CM6:
  - `EditorView` / `EditorState` with a trimmed `basicSetup`.
  - Language selected by file extension from a **curated set** of `@codemirror/lang-*`
    packages, with a **plain-text fallback**. The curated set (not all languages) bounds
    bundle weight.
  - A minimal theme derived from the dashboard's existing CSS variables so it matches
    light/dark.
  - Props: `modelValue` (content), `filename`/`language`. Emits `update:modelValue` and
    `save` (bound to Cmd/Ctrl-S).
  - Contract: pure editor; it does not fetch or save — the parent owns I/O.
- **`FileViewer.vue`**:
  - Header gets an **Edit (pencil)** button. Disabled (with a reason tooltip) when the
    file is binary, truncated, or over the line limit.
  - Entering edit mode mounts `CodeEditor` in place of the Shiki read view. The header
    shows **Save** / **Cancel** and a dirty indicator.
  - On successful save: re-read the file (fresh `mtimeMs`), return to the Shiki view
    (preserving the existing find / scroll-to-line features).
  - Errors surface as an inline banner (see §5).
- **Dependency:** add CodeMirror 6 to `packages/relay-web` (`codemirror` + the curated
  language packages). Pure ESM, self-contained, CSP-safe (no external hosts). **Sync the
  root `package-lock.json`** with `npm install --package-lock-only` (workspace dep
  additions must update the root lock or CI `npm ci` fails).

## 4. Unsaved-changes protection (center-tabs dirty state)

- The file tab in `stores/center-tabs.ts` gains edit state: `editing`, `draft`
  (in-progress content), and `baseRev` (`{ mtimeMs, size }` captured at edit start).
  `dirty` is derived (`draft !== loaded content`).
- Intercept-and-confirm: when the user switches tabs, closes the tab, or reuses the tab
  via `openFile` to open a different file, and the tab is dirty, show a confirm
  ("Discard unsaved changes?"). Proceed only on confirm. The draft lives with the tab.

## 5. Error handling

- `stale-write` → inline banner "File changed on disk — reload" with a **Reload** action;
  the draft is preserved so the user can copy their changes before reloading.
- `files-write-disabled` → toast/banner "Editing is disabled on this instance."
- binary / truncated / oversized → the edit entry point is disabled with an explanatory
  tooltip; these never reach a save call.
- All messaging reuses the existing toast system and a FileViewer inline banner.

## 6. Testing

- **Backend (bun):** `workspace-fs.writeFile` — stale-write rejection, traversal escape
  rejection, binary rejection, missing/dir rejection, size-cap rejection, atomic write
  success returning a fresh token. `control-service.fsWrite` — gate on/off.
- **Web (vitest, jsdom):** `CodeEditor` mounts and emits `save`; center-tabs dirty-guard
  intercepts switch/close/reuse; `FileViewer` edit→save happy path (mocked `api.rpc`);
  stale-conflict branch renders the reload banner and keeps the draft.

## 7. i18n

Add to `en.ts` and `zh-CN.ts` under `files`: `edit`, `save`, `cancel`, `saved`,
`unsavedConfirm`, `staleConflict`, `writeDisabled`, `binaryNotEditable`, `tooLarge`.

## 8. Release / versioning impact

Unlike the recent UI-only hub betas, this feature changes the wire protocol and the core
backend, so it spans four publishable packages:

- `@ganglion/xacpx-relay-protocol` — new message + DTO field.
- `@ganglion/xacpx` (core) — `control.fs.write` backend.
- `@ganglion/xacpx-channel-relay` — connector dispatch case.
- `@ganglion/xacpx-relay` (hub) — bundled relay-web editor.

Release order follows the existing runbook: protocol → core → (relay, channel-relay).
The protocol dependency (`^0.1.x`) must be published before the consumers that need the
new message are cut. This is coordinated with — and can ride along — the deferred
stable-release effort.

## 9. Out of scope (YAGNI)

- Multi-file / batch save, autosave, and save-on-blur.
- Content-hash concurrency tokens (mtime+size is enough).
- Syntax highlighting *while editing beyond the curated language set* (plain-text
  fallback is acceptable).
- Editing binary or truncated files.
- A diff-before-save preview (the git diff panel already exists separately).
