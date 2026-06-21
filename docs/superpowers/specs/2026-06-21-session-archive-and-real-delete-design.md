# Session Archive & Real Delete — Design

**Date:** 2026-06-21
**Status:** Approved (design), pending implementation plan

## Goal

Make web session deletion a *real* delete (history gone, re-creating a same-named
session starts fresh) and add a *session archive* feature (process closed
immediately, title greyed and sunk to the bottom of its group, restored by sending
a new message). The change is system-wide: it redefines deletion across all
channels (WeChat / Feishu / relay / web) and adds an archive command + web UI.

## Background — why today's delete is "fake"

The web delete button → `control-service.removeSession` →
`SessionService.removeSession` (`src/sessions/session-service.ts:497`). That method
only deletes the **logical** session (`state.sessions[alias]`) and prunes
chat-context references. It never touches the **transport** session: the acpx
record and history at `~/.acpx/sessions/<id>.json` survive untouched. Re-creating a
same-named session resumes that record, so the old history reappears. There are two
session concepts (logical = xacpx-managed, transport = acpx-managed); deletion only
removed one.

A single transport session can be shared by multiple logical aliases
(`countAliasesSharingTransport`, `session-service.ts:483`). Any history-destroying
delete must guard against nuking a transport session another alias still uses.

## Approach decision (revised)

During brainstorming, "real delete of history" was scoped as **Route A** — add a
focused `sessions rm` to acpx — on the mistaken premise that acpx was ours to change.
**acpx is a third-party dependency**, so Route A is off the table. We use **Route B**:
xacpx performs the history delete itself, with no acpx source change, using acpx's
existing CLI to close the session, then deleting acpx's on-disk record files directly.

This is an **incremental** use of coupling xacpx already has: it already reads acpx's
session store at `~/.acpx/sessions/index.json` (`acpx-session-index.ts`,
`native-session-history.ts`) and resolves `acpxRecordId` via `acpx sessions show`
(`acpx-cli-transport.ts readSessionRecord`). No new dependency surface; no acpx release.

## acpx primitives (already present — used as-is)

- `acpx sessions close <name>` — kills the agent process + queue owner, marks the
  record `closed`, **keeps history**, resumable. Exposed today as
  `transport.removeSession` (`acpx-cli-transport.ts:400`, bridge mirror). This is
  the archive primitive AND the first step of delete (clean process shutdown).
- `acpx sessions show <name>` — resolves a session's `acpxRecordId` (already used by
  `readSessionRecord`). Used by delete to find the on-disk files.
- `acpx sessions prune` — bulk delete of closed records by date; not usable for a
  single session. **Not used** by this feature.
- acpx has **no** single-session hard-delete command, so xacpx deletes the files.

## acpx on-disk layout (the only acpx internals delete touches)

- Sessions dir: `~/.acpx/sessions/`. Record file: `<encodeURIComponent(acpxRecordId)>.json`.
- Event-stream artifacts: `<safeId>.stream.ndjson`, `<safeId>.stream.lock`, `<safeId>.stream.*`.
- `index.json` lists records; acpx tolerates a stale entry whose file is gone (it
  skips unreadable records and self-heals the index on the next `sessions` operation),
  so xacpx does not need to rewrite the index after deleting a record file.

## Semantics

| Action      | acpx interaction              | xacpx logical layer                         | process     | history          |
|-------------|-------------------------------|---------------------------------------------|-------------|------------------|
| **Archive** | `sessions close`              | set `archived=true`, keep logical session   | close now   | keep             |
| **Restore** | `sessions ensure` (resume)    | clear `archived` (implicit on next prompt)  | restart     | reuse            |
| **Delete**  | `sessions close` + file unlink | delete logical session + prune chat-context refs | close  | delete\*         |

\* History is deleted only when no other logical alias shares the transport session
(`countAliasesSharingTransport(transportSession, excludeAlias) === 0`). Otherwise the
delete removes only the logical alias and leaves the shared transport session intact.

## Module 1 — xacpx acpx-session-files helper

New module `src/transport/acpx-session-files.ts`: `deleteAcpxSessionFiles({ acpxRecordId,
sessionsDir? })` — computes `safeId = encodeURIComponent(acpxRecordId)` and best-effort
unlinks `<safeId>.json` plus the `<safeId>.stream.*` artifacts under the sessions dir
(default `~/.acpx/sessions`, overridable for tests, mirroring `native-session-history.ts`).
Idempotent: missing files are a no-op. This is the only place that encodes acpx's
on-disk record naming, kept in one small, testable unit.

## Module 2 — transport layer

- `transport.removeSession` (exists, = `sessions close`) — **reused by archive**,
  semantics unchanged. Existing callers (`session-reset-handler.ts:95`,
  `session-handler.ts:671`, `main.ts:657`, `scheduled-dispatch.ts:92`) keep their
  current close semantics.
- **New** `transport.deleteSession?(session): Promise<void>` — real delete. Steps:
  resolve `acpxRecordId` via the existing `readSessionRecord` (idempotent: a missing
  acpx session is a no-op success) → `acpx sessions close` (clean process + queue-owner
  shutdown so nothing holds the files) → `deleteAcpxSessionFiles({ acpxRecordId })`.
  Optional on the interface; both transports (`acpx-cli`, `acpx-bridge` + bridge
  protocol/runtime) implement it. The bridge runtime delegates to the underlying
  acpx-cli transport's `deleteSession`.

## Module 3 — core `SessionService`

Logical session record gains `archived?: boolean` and `archived_at?: string`
(persisted in `state.sessions[alias]`).

- **New `archiveSession(alias)`**: cancel any in-flight turn → `transport.removeSession`
  (close process, keep history) → set `archived=true` + `archived_at` → `persist()`
  → emit `sessions-changed`. Does **not** delete the logical session.
- **New `unarchiveSession(alias)`**: clear `archived` / `archived_at` → `persist()` →
  emit `sessions-changed`. No process action (the process stays closed and resumes on
  the next message). This is the explicit "un-archive" used by the web undo toast and
  by selecting a manual restore; it is distinct from the implicit restore-on-prompt.
- **Redefined `removeSession(alias)`** (now a real delete): compute
  `sharesTransport = countAliasesSharingTransport(transportSession, alias) > 0` →
  if not shared, `transport.deleteSession(session)` (delete history); if shared, skip
  history delete → delete logical session + existing chat-context pruning → emit. This
  changes `/session rm` from a fake delete to a real delete everywhere.
- **Restore**: `ensureSession` (prompt path) clears `archived` when the target session
  is archived; acpx resume already reuses the history. Restore is implicit on the next
  message — no separate unarchive call needed. Selecting/viewing an archived session
  does not resume it; only sending a message does.

## Module 4 — control / protocol / connector / commands

- `control-service`: add `archiveSession(chatKey, alias)` and
  `unarchiveSession(chatKey, alias)` mirroring the existing `removeSession(chatKey,
  alias)` (direct `SessionService` call + `sessions-changed` emit). `removeSession`
  automatically becomes a real delete via Module 3.
- relay-protocol: add `archive-session` and `unarchive-session` request DTOs; add
  `archived: boolean` to the session DTO so the web can grey/sink archived rows; update
  `web-dtos` allow-lists.
- connector `control-bridge`: add `archiveSession` and `unarchiveSession` cases
  mirroring `removeSession`.
- commands: add `/session archive <alias>` (`parse-command.ts` + `session-handler.ts`),
  mirroring `/session rm`. Available on WeChat / Feishu / relay.

## Module 5 — relay-web UI

- **Triggers** (`InstanceTree.vue`): desktop = a trailing `⋯` overflow menu with
  *Archive* and *Delete*; mobile = swipe gestures (swipe-left → archive, swipe-right →
  delete) via a new `useSwipeActions` composable with a reveal animation. The existing
  hover/touch visibility fix for the trailing control is superseded by the menu/swipe.
- **Delete**: keeps the confirm dialog with danger-toned, real-delete wording.
- **Archive**: no confirm; optimistic, with an undo toast ("已归档 · 撤销"). Undo clears
  the `archived` flag and restores the row's active position. The acpx process stays
  closed after undo (it resumes on the next message, same as any idle session) — the
  undo is a cheap flag clear, not a deferred-close.
- **Archived rows**: title greyed (`text-fg-muted`), **sunk to the bottom of their
  instance group**, attention/running dots suppressed, small "已归档" badge. Still
  selectable — clicking opens the session and shows its history. Sending a message
  restores it (optimistic flag clear) and moves it back up.
- store (`instances.ts`): add `archiveSession` / `unarchiveSession` actions and
  optimistic `archived` toggling; `removeSession` now drives the real delete. The undo
  toast calls `unarchiveSession`.

## Edge cases

- **In-flight turn**: archive and delete cancel the running turn first, then close /
  rm.
- **Instance offline**: archive and delete both require reaching acpx, so both actions
  are disabled (greyed) in the UI when the instance is offline. No queueing in v1.
- **Shared transport session**: delete removes only the logical alias and skips the
  history delete (see Semantics note).

## Testing

- `SessionService`: `archiveSession` (cancel → close → flag → persist),
  `unarchiveSession` (clears flag, no process op), redefined `removeSession` with the
  shared-transport guard (deletes history only when unshared), restore-clears-archived
  on prompt.
- `acpx-session-files.ts`: `deleteAcpxSessionFiles` unlinks record + stream artifacts
  by `acpxRecordId` (using a temp `sessionsDir`), idempotent on missing files.
- transport `deleteSession`: resolves acpxRecordId → close → deletes files; missing
  acpx session is a no-op (mocked `readSessionRecord`/`runCommand`).
- `control-service`: `archiveSession` wiring; `removeSession` real-delete path.
- relay-protocol: `archive-session` DTO + `archived` field validation / allow-list.
- relay-web: swipe + overflow-menu triggers, greyed-and-sunk archived rows, offline
  disables actions, undo toast, send-message-restores.

## Out of scope (YAGNI)

- Auto-archive on idle/TTL (the acpx warm window already closes idle processes; archive
  is an explicit user action that additionally greys/sinks the row).
- Bulk archive/delete.
- Deferred-close on archive undo.
- Offline queueing of archive/delete.
