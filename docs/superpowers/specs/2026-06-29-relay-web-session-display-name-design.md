# Edit session display name in relay-web

**Date:** 2026-06-29
**Status:** Approved (brainstorm) — ready for implementation plan

## Goal

Let a user rename a session from the relay-web sidebar. The rename is a
**cosmetic display name** layered on top of the immutable `alias`; it does not
change session identity, the `/use` handle, or the acpx transport binding.

## Decisions

- **Semantics: display label, not identity rename.** `alias` stays the stable
  identity (the `state.sessions` key, the `/use <alias>` handle, the
  `transportSession` binding). We add a separate optional `display_name`.
- **No uniqueness / collision handling.** Two sessions may share a display name;
  it's a pure render-time label.
- **Empty clears.** An empty (after trim) value deletes the override; the UI
  falls back to showing `alias`.
- **Scope: relay-web display only.** WeChat `/sessions` listing and `/use`
  resolution are untouched and continue to use `alias`. The field still lives in
  shared state (`state.json`) — it is simply not surfaced by the WeChat channel.
- **Entry point: the existing `⋯` overflow menu** in the sidebar → a new
  "Rename" item that swaps the name span for an inline `<input>`. No
  double-click trigger.

## Precedent

This mirrors the existing **per-session `model` override** end-to-end, which is
already wired through every layer (`setSessionModel` → `control.sessions.model`
RPC). We add a parallel `display_name` field and a `control.sessions.rename` RPC.

## Data flow (core → protocol → connector → web)

1. **`src/state/types.ts`** — add `display_name?: string` to `LogicalSession`.

2. **`src/transport/types.ts`** — add `displayName?: string` to
   `ResolvedSession`; populate it wherever a `LogicalSession` is mapped to a
   `ResolvedSession` (`toResolvedSession` in session-service).

3. **`src/sessions/session-service.ts`** — add
   `async setDisplayName(internalAlias: string, name?: string)`, modeled on
   `setSessionModel`: trim → set or `delete session.display_name`, bump
   `last_used_at`, `persist()`. Include `displayName` in the objects returned by
   `listAllResolvedSessions`.

4. **`src/control/control-service.ts`** — add
   `setSessionDisplayName(chatKey, alias, name?)` (resolve internal alias via the
   existing channel-scope helper, then call the deps mutator), and include
   `displayName` in the `listSessions` mapping. Add the corresponding entry to
   the deps interface and its wiring.

5. **`packages/relay-protocol/src/messages.ts`** — add `MSG.sessionsRename`
   constant and `SessionsRenamePayload { chatKey; alias; displayName: string }`
   (+ void/ack result type). **`dtos.ts`** — add `displayName?: string` to
   `SessionDto`.

6. **`packages/channel-relay/src/control-bridge.ts`** — add
   `case MSG.sessionsRename` → `control.setSessionDisplayName(input.chatKey,
   input.alias, input.displayName)`.

## Web (relay-web)

7. **`packages/relay-web/src/stores/instances.ts`** — add
   `renameSession(instanceId, alias, displayName)` → `api.rpc(instanceId,
   "control.sessions.rename", { alias, displayName })`; optimistically update the
   local session's `displayName`. Export it from the store.

8. **`packages/relay-web/src/components/InstanceTree.vue`**
   - Add a **"Rename"** item to the existing `⋯` overflow menu.
   - Selecting it puts the row into edit mode: replace the `{{ s.alias }}` span
     with an inline `<input>` seeded with the current label. **Enter** commits,
     **Esc** cancels, **blur** commits.
   - Render the displayed name as **`s.displayName || s.alias`** (both the
     normal span and the selected/active styling).

9. **`packages/relay-web/src/components/ChatPane.vue`** — show
   `displayName || alias` in the header for consistency.

10. **i18n** — add `instance.renameSession` (menu label), an input placeholder
    /aria-label string, in both `zh` and `en` locale files.

## Validation

- Trim leading/trailing whitespace.
- Cap length at ~60 chars (truncate or reject — pick reject with no-op on
  overflow; keep simple).
- Strip newline / control characters.
- Empty after trim → clears the override (sends empty string; core deletes the
  field).

## Build / release caveats (from project memory)

- **relay-protocol must be built with `tsc`**, not the bun barrel build (bun
  tree-shakes `export *` barrels to empty → runtime "no export named MSG"). The
  new `MSG.sessionsRename` won't exist at runtime otherwise.
- After changing protocol/connector, the **connector must be repackaged,
  reinstalled into the plugin home, and the console restarted** for the new RPC
  to take effect (stale tarball pitfall).
- Adding the field to `SessionDto` (a protocol DTO) means **rebuilding the
  protocol dist** before downstream packages pick it up.

## Testing

- **core unit:** `setDisplayName` set + clear; `listAllResolvedSessions`
  includes `displayName`. `control-service.setSessionDisplayName` resolves the
  scoped alias and the `listSessions` mapping carries `displayName`.
- **connector unit:** `MSG.sessionsRename` dispatches to
  `setSessionDisplayName`.
- **web (vitest, not bun):** store `renameSession` issues the correct RPC and
  optimistically updates; `InstanceTree` rename interaction (open menu → edit →
  Enter commits / Esc cancels) and renders `displayName || alias`.

## Out of scope (YAGNI)

- Renaming the underlying `alias` / transport session.
- Surfacing the display name in WeChat `/sessions` or accepting it in `/use`.
- Uniqueness enforcement.
- Double-click-to-rename and swipe-to-rename gestures.
