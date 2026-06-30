# Archive Reaps the Queue-Owner Process — Design

**Date:** 2026-06-29
**Status:** Approved (design), pending implementation plan

## Goal

Make web/control **archive** immediately free the corresponding acpx process (the
warm queue owner) instead of only flipping a state flag — while keeping restore
**lossless and repeatable**. Archiving should kill the warm process now; the next
message to the session resumes the full conversation with no history loss, and the
archive→restore cycle works any number of times.

## Background — the lineage that led here

Three steps brought us to this point:

1. **2026-06-21 spec** (`session-archive-and-real-delete-design.md`): archive was
   defined as `acpx sessions close` — kills the process + queue owner, marks the
   acpx record `closed`, keeps history, resumable. Exposed as
   `transport.removeSession`.
2. **#72** (`project_archived_session_restore_history_followup`): `sessions close`
   marks the record `closed`, which acpx **excludes from name lookup**, so the
   session becomes unresumable-by-name and the next prompt starts fresh (history
   loss); resume-by-native-id is lossy / non-repeatable. To preserve repeatable
   lossless restore, archive was changed to **only `cancel`** and deliberately
   **keep the acpx session open** (`command-router.ts archiveSessionWithTransport`,
   comment at the `if (!shared)` branch). The cost: the warm process is no longer
   freed on archive — it only idles out via acpx's `--ttl`.
3. **Now**: the user wants the immediate process kill back **without** giving up
   repeatable lossless restore. This design is the synthesis of steps 1 and 2.

## Why not the alternatives (decided during brainstorming)

- **File an upstream acpx issue** ("add a close-process capability"): rejected.
  Verified that acpx already kills the queue owner + agent process on
  `sessions close` since **v0.10.0** (`closeSession` →
  `terminateQueueOwnerForSession` → `terminateProcess` SIGTERM→SIGKILL;
  introduced in commit `be510ba` #220, present in bundled `acpx@0.11.0`). The
  capability already exists; an issue would be closed as "already exists".
- **archive = `sessions close` + resume native rollout on restore**: rejected. The
  `closed` marking breaks name-resume; restore must fall back to
  `--resume-session`, whose repeatability and history-preservation are
  **agent-adapter-dependent** (acpx forwards `session/resume`/`session/load` to the
  agent; see `session-management.ts resumeSessionRecordWithClient`). Carries the
  resume-wipe / non-repeatable risk from `reference_acpx_resume_wipes_source_record`.
- **Chosen: reap the queue-owner process, keep the record open.** Dissolves the
  close-vs-resume dilemma entirely — no `closed` marking, no `--resume-session`, no
  adapter-dependent risk.

## Core mechanism (reuse existing, tested machinery)

xacpx already has the exact primitive, used today only on daemon stop:

`terminateAcpxQueueOwner(acpxRecordId)` (`acpx-queue-owner-launcher.ts:257`):
1. reads `~/.acpx/queues/<shortHash(recordId)>.lock` to get the owner `pid`,
2. `terminateProcessTree(pid, { detachedProcessGroup: true })` — kills the owner
   process tree,
3. unlinks the lock file.

It **does not** touch the acpx session record — no `closed` flag, no metadata
change (see the contract comment on `reapQueueOwners`,
`queue-owner-reaper.ts:29-39`). The acpx session stays open and name-resumable.

The queue-owner lock store (`~/.acpx/queues/`) is global and keyed by
`acpxRecordId`, so this works identically for both transports
(`acpx-cli` and `acpx-bridge` both spawn acpx queue owners that register there).

## Restore path — unchanged

Because archive leaves the acpx record **open**, restore needs **no new code**:

- **Web/control path**: `ControlService.executeTurn` → `useSession` clears
  `archived` → `transport.prompt` resumes the existing (open) acpx session with
  full history. The first post-archive prompt cold-starts a fresh queue owner —
  exactly what already happens after a TTL idle-out.
- **Chat path**: `promptWithSession` restore-on-message branch
  (`session-handler.ts:752`) stays as-is, including the `ensureTransportSession`
  safety net for genuinely-missing sessions.

Repeatability is free: each archive just kills a cold-startable warm process; the
record is never marked `closed`, so archive→restore→archive→restore all work.

## Components & changes

1. **`src/transport/types.ts`** — add an optional method to `SessionTransport`:
   ```ts
   /**
    * Terminate the warm queue-owner process for this session, freeing its
    * resources, WITHOUT closing the acpx session (no `closed` flag, no metadata
    * change) — the session stays open and resumes with full history on the next
    * prompt. Idempotent: a missing warm process or missing session is a no-op.
    * Optional: transports that can't reap omit it.
    */
   freeWarmProcess?(session: ResolvedSession): Promise<void>;
   ```

2. **`src/transport/acpx-cli/acpx-cli-transport.ts`** — implement `freeWarmProcess`:
   resolve `acpxRecordId` via the existing private `readSessionRecord(session)`
   (returns `{ acpxRecordId }`), then `await terminateAcpxQueueOwner(acpxRecordId)`.
   A missing session (readSessionRecord throws) → no-op return, mirroring
   `deleteSession`'s "already gone" handling.

3. **`src/transport/acpx-bridge/acpx-bridge-client.ts`** — implement the same
   (resolve record id, call `terminateAcpxQueueOwner`). Lock store is global, so the
   logic is identical; confirm during implementation that the bridge's record-id
   resolution path is reachable here.

4. **`src/commands/command-router.ts` `archiveSessionWithTransport`** — within the
   existing `if (!shared)` branch, after the best-effort `cancel`, add a best-effort
   `await this.transport.freeWarmProcess?.(session)` (swallow + log on failure), then
   `setArchived(true)` as today. Rewrite the now-obsolete comment that says we
   "intentionally do NOT close the acpx session here" to describe the reap behavior.

5. **Stale-comment fix** — `acpx-cli-transport.ts:447-450` (`deleteSession`) claims
   "close returning does NOT mean the backing process exited — acpx keeps a warm
   queue-owner alive via --ttl". This is false for acpx ≥0.10 (`sessions close`
   terminates the owner + agent). Correct it to avoid future confusion. (Doc-only.)

## Edge cases & error handling

- **Shared transport** (multiple aliases share one `transportSession`): skip the
  reap — reuse the existing `!shared` guard. Another live alias still needs the warm
  process; archiving one alias must not kill it.
- **In-flight turn**: already refused earlier in `archiveSessionWithTransport`
  (`activeTurns.isActiveAnywhere`), before the reap.
- **No warm process** (idled out, or never started): `terminateAcpxQueueOwner` is a
  no-op when the lock file is missing.
- **Reap failure**: best-effort — swallow + log. The `archived` flag is still set.
  Worst case degrades to the current behavior (process idles out via TTL); never a
  regression, never a hang.
- **Restore after reap**: no special handling needed (record is open). The chat
  path keeps its `ensureTransportSession` fallback for genuinely-missing sessions.

## Testing

- **Unit — `command-router.archiveSessionWithTransport`** (mock transport):
  - calls `freeWarmProcess` when the transport session is **not** shared;
  - **skips** `freeWarmProcess` when shared;
  - swallows a `freeWarmProcess` rejection and still sets `archived`;
  - still refuses when a turn is in flight (unchanged).
- **Unit — `acpx-cli-transport.freeWarmProcess`**: resolves the record id and calls
  `terminateAcpxQueueOwner`; no-op when the session is missing.
- Existing `terminateAcpxQueueOwner` / reaper unit tests already cover the
  process-tree-kill + lock-unlink mechanics.
- **Manual smoke (optional, real acpx)**: archive a live session → the queue-owner
  pid is gone, `acpx sessions show <name>` still reports it present (not `closed`),
  and a follow-up prompt resumes full history. Repeat the archive→restore cycle
  twice to confirm repeatability.

## Out of scope (YAGNI)

- No upstream acpx issue or acpx source change.
- No `--resume-session` / native-rollout restore path.
- No change to delete/remove flows (`removeSession`/`deleteSession` =
  `acpx sessions close` (+ file delete) stay as-is).
- No change to TTL configuration.
- No web-UI change — archive already exists in the UI; only its backend effect
  changes.
