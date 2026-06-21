# Session Archive & Real Delete Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make session deletion a real delete (acpx history gone, same-name re-create starts fresh) and add session archive (process closed now, row greyed + sunk to bottom, restored by sending a message) across all channels + the relay-web dashboard.

**Architecture:** acpx is a third-party dependency and is NOT modified. The xacpx transport gains `deleteSession`, which closes the session via acpx's existing `sessions close` then deletes acpx's on-disk record files directly (Route B); archive reuses the existing `removeSession` (= `acpx sessions close`). Orchestration (shared-transport guard, cancel, transport teardown) lives in `CommandRouter` and is shared by the chat `/session` handlers and the web `ControlService`. The logical session gains an `archived` flag, cleared on the next `useSession` (which every prompt calls). relay-web adds a desktop ⋯ menu + mobile swipe, greys + sinks archived rows, and an undo toast.

**Tech Stack:** TypeScript, Node, Bun (build/test), Vue 3 + Pinia + Tailwind (relay-web), Vitest, acpx (sibling repo at `../acpx`).

**Companion spec:** `docs/superpowers/specs/2026-06-21-session-archive-and-real-delete-design.md`

**Single repo:** all tasks run in `/Users/maijiazhen/Projects/weacpx-github`. acpx is a third-party dependency and is **not** modified (see Phase 1 rationale).

**Git hygiene (every task):** never `git add -A`/`git add .`; stage only the exact files named in the task. Never stage `bun.lock`, `dist/`, `node_modules` unless the task says so. Each task is its own commit.

---

## Phase 1 — xacpx real-delete mechanism (Route B; no acpx changes)

> **Why Route B:** acpx is a third-party dependency, not ours to modify. acpx has no
> single-session hard-delete command, so xacpx closes the session via acpx's existing
> CLI and then deletes acpx's on-disk record files directly. This reuses coupling xacpx
> already has (`acpx-session-index.ts` / `native-session-history.ts` read
> `~/.acpx/sessions`; transports resolve `acpxRecordId` via `acpx sessions show`).
> (An earlier draft's Tasks 4–5 added an acpx `sessions rm` command — removed.)

### Task 1: `acpx-session-files.ts` — delete a session's on-disk files

**Files:**
- Create: `src/transport/acpx-session-files.ts`
- Test: `tests/unit/transport/acpx-session-files.test.ts` (new)

The only unit that encodes acpx's on-disk record naming. Mirrors acpx's own
`pruneSessionFiles` (`safeId = encodeURIComponent(acpxRecordId)`; record `<safeId>.json`
+ stream artifacts `<safeId>.stream.ndjson` / `.stream.lock` / `.stream.*`). Sessions
dir defaults to `~/.acpx/sessions`, overridable for tests (same pattern as
`native-session-history.ts`).

- [ ] **Step 1: Write the failing test**

```ts
// tests/unit/transport/acpx-session-files.test.ts
import { describe, it, expect } from "vitest";
import { promises as fs } from "node:fs";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deleteAcpxSessionFiles } from "../../../src/transport/acpx-session-files";

async function tempSessionsDir(): Promise<string> {
  return await mkdtemp(join(tmpdir(), "acpx-sessions-"));
}

describe("deleteAcpxSessionFiles", () => {
  it("removes the record json and its stream artifacts", async () => {
    const dir = await tempSessionsDir();
    const id = "ws:demo";
    const safe = encodeURIComponent(id);
    await writeFile(join(dir, `${safe}.json`), "{}");
    await writeFile(join(dir, `${safe}.stream.ndjson`), "");
    await writeFile(join(dir, `${safe}.stream.lock`), "");
    await deleteAcpxSessionFiles({ acpxRecordId: id, sessionsDir: dir });
    const left = await fs.readdir(dir);
    expect(left).toHaveLength(0);
  });

  it("is idempotent when nothing exists", async () => {
    const dir = await tempSessionsDir();
    await expect(deleteAcpxSessionFiles({ acpxRecordId: "ws:none", sessionsDir: dir })).resolves.toBeUndefined();
  });

  it("only deletes the target session's files, not siblings", async () => {
    const dir = await tempSessionsDir();
    await writeFile(join(dir, `${encodeURIComponent("ws:keep")}.json`), "{}");
    await writeFile(join(dir, `${encodeURIComponent("ws:gone")}.json`), "{}");
    await deleteAcpxSessionFiles({ acpxRecordId: "ws:gone", sessionsDir: dir });
    const left = await fs.readdir(dir);
    expect(left).toEqual([`${encodeURIComponent("ws:keep")}.json`]);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run tests/unit/transport/acpx-session-files.test.ts`
Expected: FAIL — module missing.

- [ ] **Step 3: Implement the helper**

```ts
// src/transport/acpx-session-files.ts
import { readdir, stat, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

export interface DeleteAcpxSessionFilesOptions {
  acpxRecordId: string;
  /** Override for the acpx sessions dir (tests). Defaults to `<home>/.acpx/sessions`. */
  sessionsDir?: string;
}

/** Best-effort delete of a single acpx session's on-disk files: the record json and
 *  its event-stream artifacts. Mirrors acpx's own per-record file layout
 *  (`<encodeURIComponent(acpxRecordId)>.json` + `<safeId>.stream.*`). Idempotent —
 *  missing files are ignored. acpx tolerates the now-stale index entry and self-heals
 *  it on its next `sessions` operation, so we do not rewrite index.json. */
export async function deleteAcpxSessionFiles(options: DeleteAcpxSessionFilesOptions): Promise<void> {
  const dir = options.sessionsDir ?? join(homedir(), ".acpx", "sessions");
  const safeId = encodeURIComponent(options.acpxRecordId);

  await unlink(join(dir, `${safeId}.json`)).catch(() => undefined);

  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return; // dir gone → nothing more to remove
  }
  const streamFiles = entries.filter(
    (name) => name === `${safeId}.stream.ndjson` || name === `${safeId}.stream.lock` || name.startsWith(`${safeId}.stream.`),
  );
  for (const name of streamFiles) {
    await unlink(join(dir, name)).catch(() => undefined);
  }
}
```

(`stat` import is unused — drop it; left here only as a reminder that no byte-counting is needed, unlike acpx's prune. Keep the import list to exactly what's used: `readdir`, `unlink`.)

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/unit/transport/acpx-session-files.test.ts && npx tsc --noEmit`
Expected: PASS (3 tests) + clean typecheck (no unused imports).

- [ ] **Step 5: Commit**

```bash
git add src/transport/acpx-session-files.ts tests/unit/transport/acpx-session-files.test.ts
git commit -m "feat(transport): add deleteAcpxSessionFiles (single-session on-disk cleanup)"
```

---

### Task 2: `SessionTransport.deleteSession` + acpx-cli implementation

**Files:**
- Modify: `src/transport/types.ts` (interface)
- Modify: `src/transport/acpx-cli/acpx-cli-transport.ts` (impl)
- Test: `tests/unit/transport/acpx-cli-delete-session.test.ts` (new)

`deleteSession` = resolve `acpxRecordId` via the existing private `readSessionRecord`
→ `acpx sessions close` (clean process + queue-owner shutdown) → `deleteAcpxSessionFiles`.
A missing acpx session is a no-op success.

- [ ] **Step 1: Write the failing test**

```ts
// tests/unit/transport/acpx-cli-delete-session.test.ts
import { describe, it, expect, vi } from "vitest";
import { AcpxCliTransport } from "../../../src/transport/acpx-cli/acpx-cli-transport";
import * as files from "../../../src/transport/acpx-session-files";

function makeSession() {
  return { alias: "a", agent: "codex", workspace: "w", transportSession: "w:a", cwd: "/tmp/w" } as never;
}

describe("AcpxCliTransport.deleteSession", () => {
  it("closes the session then deletes its files by acpxRecordId", async () => {
    const transport = new AcpxCliTransport({ command: "acpx" } as never);
    vi.spyOn(transport as never, "readSessionRecord").mockResolvedValue({ acpxRecordId: "rec-123" } as never);
    const remove = vi.spyOn(transport, "removeSession").mockResolvedValue();
    const del = vi.spyOn(files, "deleteAcpxSessionFiles").mockResolvedValue();
    await transport.deleteSession(makeSession());
    expect(remove).toHaveBeenCalled();              // closed first
    expect(del).toHaveBeenCalledWith(expect.objectContaining({ acpxRecordId: "rec-123" }));
  });

  it("is a no-op when the acpx session cannot be resolved (already gone)", async () => {
    const transport = new AcpxCliTransport({ command: "acpx" } as never);
    vi.spyOn(transport as never, "readSessionRecord").mockRejectedValue(new Error("no session"));
    const del = vi.spyOn(files, "deleteAcpxSessionFiles").mockResolvedValue();
    await expect(transport.deleteSession(makeSession())).resolves.toBeUndefined();
    expect(del).not.toHaveBeenCalled();
  });
});
```

> Match the real `AcpxCliTransport` constructor + `readSessionRecord` shape from
> `src/transport/acpx-cli/acpx-cli-transport.ts` (read an existing test in
> `tests/unit/transport/` for exact construction; `readSessionRecord` returns
> `{ acpxRecordId: string; agentSessionId?: string }`). Adjust the spy target if
> `readSessionRecord` is private (spy via `as never`).

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run tests/unit/transport/acpx-cli-delete-session.test.ts`
Expected: FAIL — `deleteSession` does not exist.

- [ ] **Step 3: Add to the interface**

In `src/transport/types.ts`, add below `removeSession?` (line 169):

```ts
  /**
   * Hard-delete the transport session AND its on-disk history: close the acpx
   * process, then delete acpx's record files. Distinct from removeSession (=
   * `acpx sessions close`, which keeps history for resume). Optional: transports
   * that can't delete omit it. A missing acpx session is a no-op (idempotent).
   */
  deleteSession?(session: ResolvedSession): Promise<void>;
```

- [ ] **Step 4: Implement in acpx-cli**

In `src/transport/acpx-cli/acpx-cli-transport.ts`, import the helper at the top:

```ts
import { deleteAcpxSessionFiles } from "../acpx-session-files.js";
```

Add the method next to `removeSession` (~line 400):

```ts
  async deleteSession(session: ResolvedSession): Promise<void> {
    let acpxRecordId: string;
    try {
      ({ acpxRecordId } = await this.readSessionRecord(session));
    } catch {
      return; // acpx session already gone → nothing to delete
    }
    // Close first so no live process / queue owner holds the files, then unlink.
    await this.removeSession(session);
    await deleteAcpxSessionFiles({ acpxRecordId });
  }
```

> Confirm `readSessionRecord` returns `{ acpxRecordId }` (it does, ~line 441) and that
> `removeSession` is the `acpx sessions close` method (it is, ~line 400).

- [ ] **Step 5: Run the test + typecheck**

Run: `npx vitest run tests/unit/transport/acpx-cli-delete-session.test.ts && npx tsc --noEmit`
Expected: PASS + clean.

- [ ] **Step 6: Commit**

```bash
git add src/transport/types.ts src/transport/acpx-cli/acpx-cli-transport.ts tests/unit/transport/acpx-cli-delete-session.test.ts
git commit -m "feat(transport): deleteSession (close + delete acpx record files)"
```

---

### Task 3: Bridge transport `deleteSession`

**Files:**
- Modify: `src/transport/acpx-bridge/acpx-bridge-protocol.ts` (add `"deleteSession"` to `BridgeMethod`)
- Modify: `src/transport/acpx-bridge/acpx-bridge-transport.ts` (client method)
- Modify: `src/bridge/bridge-server.ts` (dispatch case)
- Modify: `src/bridge/bridge-runtime.ts` (runtime method → underlying acpx-cli `deleteSession`)
- Test: `tests/unit/bridge/bridge-delete-session.test.ts` (new)

- [ ] **Step 1: Write the failing test**

Find the existing bridge `removeSession` test (grep `removeSession` under `tests/unit/bridge/`) and mirror it for `deleteSession` — assert the bridge-server routes a `deleteSession` request to `runtime.deleteSession`.

```ts
// tests/unit/bridge/bridge-delete-session.test.ts
import { describe, it, expect, vi } from "vitest";
import { BridgeServer } from "../../../src/bridge/bridge-server";

describe("bridge deleteSession", () => {
  it("routes deleteSession to the runtime", async () => {
    const runtime = { deleteSession: vi.fn().mockResolvedValue(undefined) };
    const server = new BridgeServer(runtime as never);
    const result = await (server as never).handleRequest({
      id: "1", method: "deleteSession", params: { transportSession: "w:a" },
    });
    expect(runtime.deleteSession).toHaveBeenCalled();
    expect((result as { ok: boolean }).ok).toBe(true);
  });
});
```

> Adjust constructor/handler names to match the real `BridgeServer` (read
> `src/bridge/bridge-server.ts` where `removeSession` is dispatched, ~line 274).

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run tests/unit/bridge/bridge-delete-session.test.ts`
Expected: FAIL.

- [ ] **Step 3: Add `"deleteSession"` to `BridgeMethod`**

In `src/transport/acpx-bridge/acpx-bridge-protocol.ts`, add `| "deleteSession"` to the `BridgeMethod` union (after `"removeSession"`, line 17).

- [ ] **Step 4: Client method**

In `src/transport/acpx-bridge/acpx-bridge-transport.ts`, add next to `removeSession` (line 254):

```ts
  async deleteSession(session: ResolvedSession): Promise<void> {
    await this.client.request("deleteSession", this.toParams(session));
  }
```

- [ ] **Step 5: Bridge server dispatch**

In `src/bridge/bridge-server.ts`, next to the `removeSession` case (~line 274), add a `deleteSession` case that calls `this.runtime.deleteSession({...})` with the same param shape as `removeSession`.

- [ ] **Step 6: Bridge runtime method**

In `src/bridge/bridge-runtime.ts`, add a `deleteSession` method mirroring its `removeSession` (which delegates to the underlying acpx-cli transport). It must call the underlying transport's `deleteSession`.

- [ ] **Step 7: Run the test + typecheck**

Run: `npx vitest run tests/unit/bridge/bridge-delete-session.test.ts && npx tsc --noEmit`
Expected: PASS + clean.

- [ ] **Step 8: Commit**

```bash
git add src/transport/acpx-bridge/acpx-bridge-protocol.ts src/transport/acpx-bridge/acpx-bridge-transport.ts src/bridge/bridge-server.ts src/bridge/bridge-runtime.ts tests/unit/bridge/bridge-delete-session.test.ts
git commit -m "feat(bridge): wire deleteSession through bridge protocol/server/runtime"
```


## Phase 3 — core: archived flag + orchestration + control wiring

### Task 6: `LogicalSession.archived` + `SessionService.setArchived` + restore-on-use

**Files:**
- Modify: `src/state/types.ts` (`LogicalSession` fields)
- Modify: `src/sessions/session-service.ts` (`setArchived` + clear in `useSession`)
- Test: `tests/unit/sessions/session-archived.test.ts` (new)

- [ ] **Step 1: Write the failing test**

```ts
// tests/unit/sessions/session-archived.test.ts
import { describe, it, expect, beforeEach } from "vitest";
import { SessionService } from "../../../src/sessions/session-service";
// Reuse the existing session-service test harness for building config/state.
// Find an existing test in tests/unit/sessions/ and copy its setup helpers.

function setup() {
  // Build config with one agent "codex" + one workspace, an empty AppState,
  // and a stub stateStore { save: async () => {} }. Mirror an existing test.
  // Return { service, state }.
}

describe("SessionService archived flag", () => {
  it("setArchived(true) marks the session archived and persists; setArchived(false) clears it", async () => {
    const { service, state } = setup() as never;
    // seed a logical session "demo" via service.attachSession(...) as existing tests do
    await service.setArchived("demo", true);
    expect(state.sessions["demo"].archived).toBe(true);
    expect(typeof state.sessions["demo"].archived_at).toBe("string");
    await service.setArchived("demo", false);
    expect(state.sessions["demo"].archived).toBeUndefined();
    expect(state.sessions["demo"].archived_at).toBeUndefined();
  });

  it("useSession clears an archived flag (restore-on-message)", async () => {
    const { service, state } = setup() as never;
    await service.setArchived("demo", true);
    await service.useSession("relay:acct", "demo"); // chatKey form used by the channel
    expect(state.sessions["demo"].archived).toBeUndefined();
  });
});
```

> Copy the exact `setup()` (config/state/attach) from an existing file in `tests/unit/sessions/` — do not invent the harness.

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run tests/unit/sessions/session-archived.test.ts`
Expected: FAIL — `setArchived` not a function.

- [ ] **Step 3: Add fields to `LogicalSession`**

In `src/state/types.ts`, inside `interface LogicalSession`, add after `reply_mode`:

```ts
  /** True when the user archived this session: process closed, row greyed + sunk.
   *  Cleared on the next useSession (restore-on-message). */
  archived?: boolean;
  archived_at?: string;
```

- [ ] **Step 4: Add `setArchived` + clear in `useSession`**

In `src/sessions/session-service.ts`, add the method (near `removeSession`):

```ts
  async setArchived(alias: string, archived: boolean): Promise<void> {
    await this.mutate(async () => {
      const session = this.state.sessions[alias];
      if (!session) {
        throw new Error(`session "${alias}" does not exist`);
      }
      if (archived) {
        session.archived = true;
        session.archived_at = new Date(this.now()).toISOString();
      } else {
        delete session.archived;
        delete session.archived_at;
      }
      await this.persist();
    });
  }
```

Then, in `useSession`, after the line `session.last_used_at = new Date().toISOString();`, add the restore clear:

```ts
      // Sending a message to (or selecting) an archived session restores it.
      if (session.archived) {
        delete session.archived;
        delete session.archived_at;
      }
```

- [ ] **Step 5: Run the test + typecheck**

Run: `npx vitest run tests/unit/sessions/session-archived.test.ts && npx tsc --noEmit`
Expected: PASS + clean.

- [ ] **Step 6: Commit**

```bash
git add src/state/types.ts src/sessions/session-service.ts tests/unit/sessions/session-archived.test.ts
git commit -m "feat(sessions): archived flag + setArchived + restore-on-useSession"
```

---

### Task 7: CommandRouter orchestration (`removeSessionWithTransport`, `archiveSessionWithTransport`, `unarchiveSession`) + make `/session rm` a real delete

**Files:**
- Modify: `src/commands/command-router.ts` (3 new public methods)
- Modify: `src/commands/handlers/session-handler.ts` (`handleSessionRemove` uses `deleteSession`; new `handleSessionArchive`)
- Test: `tests/unit/commands/session-archive-delete.test.ts` (new)

**Why here:** `SessionService` has no transport reference; the handler/router layer is where transport + sessions co-exist (`createHandlerContext`). These router methods become the single orchestration shared by chat handlers (Task 11) and `ControlService` (Task 8).

- [ ] **Step 1: Write the failing test**

```ts
// tests/unit/commands/session-archive-delete.test.ts
import { describe, it, expect, vi } from "vitest";
// Build a CommandRouter with stub sessions + transport. Mirror an existing
// command-router test in tests/unit/commands/ for construction.

describe("CommandRouter session archive/delete orchestration", () => {
  it("removeSessionWithTransport deletes history when no alias shares the transport", async () => {
    // sessions.countAliasesSharingTransport -> 0
    // expect transport.deleteSession called, transport.removeSession NOT called
  });

  it("removeSessionWithTransport skips transport teardown when shared", async () => {
    // sessions.countAliasesSharingTransport -> 1
    // expect transport.deleteSession NOT called; logical removeSession still called
  });

  it("archiveSessionWithTransport cancels + closes (unshared) then sets archived", async () => {
    // expect transport.cancel + transport.removeSession called, sessions.setArchived(alias,true)
  });

  it("unarchiveSession only clears the flag", async () => {
    // expect sessions.setArchived(alias,false); no transport calls
  });
});
```

> Fill the stubs from an existing command-router test harness. Keep assertions on which transport/sessions methods are called.

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run tests/unit/commands/session-archive-delete.test.ts`
Expected: FAIL — methods not defined.

- [ ] **Step 3: Add the router methods**

In `src/commands/command-router.ts`, add (the class already holds `private readonly sessions` and `private readonly transport`):

```ts
  /** Real delete: logical removal + acpx history delete, guarded so a transport
   *  session shared by another alias is left intact. Returns the shared count and
   *  whether the transport was torn down (for chat-text formatting). */
  async removeSessionWithTransport(internalAlias: string): Promise<{
    wasActive: boolean;
    sharedAliasCount: number;
    transportTornDown: boolean;
    transportTeardownWarning?: string;
  }> {
    const session = await this.sessions.getSession(internalAlias);
    if (!session) {
      throw new Error(`session "${internalAlias}" does not exist`);
    }
    const sharedAliasCount = this.sessions.countAliasesSharingTransport(session.transportSession, internalAlias);
    const { wasActive } = await this.sessions.removeSession(internalAlias);

    let transportTornDown = false;
    let transportTeardownWarning: string | undefined;
    if (sharedAliasCount === 0 && this.transport.deleteSession) {
      try {
        await this.transport.deleteSession(session);
        transportTornDown = true;
      } catch (error) {
        transportTeardownWarning = error instanceof Error ? error.message : String(error);
        await this.logger.error("session.transport_delete_failed", "failed to delete acpx session after logical remove", {
          alias: internalAlias, transportSession: session.transportSession, message: transportTeardownWarning,
        });
      }
    }
    return { wasActive, sharedAliasCount, transportTornDown, ...(transportTeardownWarning ? { transportTeardownWarning } : {}) };
  }

  /** Archive: close the acpx process (keep history) when no other alias shares the
   *  transport, then flag the logical session archived. */
  async archiveSessionWithTransport(internalAlias: string): Promise<void> {
    const session = await this.sessions.getSession(internalAlias);
    if (!session) {
      throw new Error(`session "${internalAlias}" does not exist`);
    }
    const shared = this.sessions.countAliasesSharingTransport(session.transportSession, internalAlias) > 0;
    if (!shared) {
      try { await this.transport.cancel(session); } catch { /* best-effort */ }
      if (this.transport.removeSession) {
        try {
          await this.transport.removeSession(session);
        } catch (error) {
          await this.logger.error("session.archive_close_failed", "failed to close acpx session on archive", {
            alias: internalAlias, transportSession: session.transportSession,
            message: error instanceof Error ? error.message : String(error),
          });
        }
      }
    }
    await this.sessions.setArchived(internalAlias, true);
  }

  /** Explicit un-archive (web undo / manual). No process action — it resumes on the
   *  next message via useSession. */
  async unarchiveSession(internalAlias: string): Promise<void> {
    await this.sessions.setArchived(internalAlias, false);
  }
```

> If `this.sessions.getSession` / `getResolvedSessionByInternalAlias` differ in your tree, use whichever returns a transport-capable session (the rm handler at `session-handler.ts` uses `context.sessions.getSession(internalAlias)`).

- [ ] **Step 4: Make chat `/session rm` a real delete**

In `src/commands/handlers/session-handler.ts`, in `handleSessionRemove`, replace the transport teardown block (currently calls `context.transport.removeSession(session)` when `shouldTeardownTransport`) so it calls `context.transport.deleteSession(session)` instead. Keep all surrounding logic (shared guard, orchestration purge, warnings, promotion text). The minimal change is swapping `context.transport.removeSession` → `context.transport.deleteSession` and the guard `context.transport.removeSession` → `context.transport.deleteSession` in the same `if`.

- [ ] **Step 5: Run the test + the existing session-handler tests + typecheck**

Run: `npx vitest run tests/unit/commands/session-archive-delete.test.ts tests/unit/commands/ && npx tsc --noEmit`
Expected: PASS (new) + existing command tests still green.

- [ ] **Step 6: Commit**

```bash
git add src/commands/command-router.ts src/commands/handlers/session-handler.ts tests/unit/commands/session-archive-delete.test.ts
git commit -m "feat(router): archive/real-delete orchestration; /session rm now real-deletes"
```

---

### Task 8: ControlService archive/unarchive + real-delete wiring + `archived` in `ControlSessionInfo`

**Files:**
- Modify: `src/control/control-service.ts` (deps, `removeSession` → real delete, new `archiveSession`/`unarchiveSession`, `ControlSessionInfo.archived` + builders)
- Modify: `src/main.ts` (wire new deps to router methods)
- Test: `tests/unit/control/control-archive.test.ts` (new)

- [ ] **Step 1: Write the failing test**

```ts
// tests/unit/control/control-archive.test.ts
import { describe, it, expect, vi } from "vitest";
// Build ControlService with stub deps mirroring an existing control-service test.

describe("ControlService archive/unarchive + real delete", () => {
  it("archiveSession resolves the alias, calls archiveSessionWithTransport, emits sessions-changed", async () => {
    // deps.archiveSessionWithTransport spy, deps.events.emit spy
  });
  it("unarchiveSession calls unarchiveSession + emits sessions-changed", async () => {});
  it("removeSession routes through removeSessionWithTransport (real delete) + emits", async () => {});
  it("listSessions includes archived flag from the resolved session", async () => {});
});
```

> Copy the control-service test harness from `tests/unit/control/`.

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run tests/unit/control/control-archive.test.ts`
Expected: FAIL.

- [ ] **Step 3: Extend `ControlServiceDeps`**

In `src/control/control-service.ts`, add to `ControlServiceDeps`:

```ts
  // Full-lifecycle session teardown/archival, wired to CommandRouter in main.ts so
  // the web path shares the chat path's shared-transport guard + acpx teardown.
  removeSessionWithTransport: (internalAlias: string) => Promise<{ wasActive: boolean }>;
  archiveSessionWithTransport: (internalAlias: string) => Promise<void>;
  unarchiveSession: (internalAlias: string) => Promise<void>;
```

Add `archived: boolean` to `ControlSessionInfo`:

```ts
export interface ControlSessionInfo {
  alias: string;
  agent: string;
  workspace: string;
  transportSession: string;
  running: boolean;
  archived: boolean;
}
```

In `listSessions`, add `archived: session.archived === true` to the `.map(...)` object. In `createSession`'s returned object (lines ~255-261), add `archived: false`.

Replace `removeSession` body to use the router orchestration, and add the two new methods:

```ts
  async removeSession(chatKey: string, alias: string): Promise<{ wasActive: boolean }> {
    const internalAlias = await this.deps.sessions.resolveAliasForChat(chatKey, alias);
    const result = await this.deps.removeSessionWithTransport(internalAlias);
    this.deps.events.emit({ type: "sessions-changed" });
    return result;
  }

  async archiveSession(chatKey: string, alias: string): Promise<void> {
    const internalAlias = await this.deps.sessions.resolveAliasForChat(chatKey, alias);
    await this.deps.archiveSessionWithTransport(internalAlias);
    this.deps.events.emit({ type: "sessions-changed" });
  }

  async unarchiveSession(chatKey: string, alias: string): Promise<void> {
    const internalAlias = await this.deps.sessions.resolveAliasForChat(chatKey, alias);
    await this.deps.unarchiveSession(internalAlias);
    this.deps.events.emit({ type: "sessions-changed" });
  }
```

> `listAllResolvedSessions()` must surface `archived`. Check `src/sessions/session-service.ts` `listAllResolvedSessions` / `ResolvedSession` — if `archived` isn't carried on the resolved shape, add it there (pass through `session.archived`). Add a one-line test in `session-archived.test.ts` asserting `listAllResolvedSessions()` includes `archived` if you extend it.

- [ ] **Step 4: Wire deps in `main.ts`**

In `src/main.ts`, in the `new ControlService({ ... })` deps object (~line 750), add:

```ts
    removeSessionWithTransport: (internalAlias) => router.removeSessionWithTransport(internalAlias),
    archiveSessionWithTransport: (internalAlias) => router.archiveSessionWithTransport(internalAlias),
    unarchiveSession: (internalAlias) => router.unarchiveSession(internalAlias),
```

- [ ] **Step 5: Run test + typecheck**

Run: `npx vitest run tests/unit/control/control-archive.test.ts && npx tsc --noEmit`
Expected: PASS + clean (fix any other ControlService constructor call sites in tests that now need the new deps).

- [ ] **Step 6: Commit**

```bash
git add src/control/control-service.ts src/main.ts tests/unit/control/control-archive.test.ts
git commit -m "feat(control): archive/unarchive + real-delete wiring + archived in session info"
```

---

## Phase 4 — protocol, connector, chat command

### Task 9: relay-protocol — message types, payloads, `SessionDto.archived`

**Files:**
- Modify: `packages/relay-protocol/src/messages.ts` (MSG keys + payloads)
- Modify: `packages/relay-protocol/src/dtos.ts` (`SessionDto.archived`)
- Test: `packages/relay-protocol/src/__tests__/archive-dtos.test.ts` (new, if the package has tests; else skip the test file and rely on tsc)

- [ ] **Step 1: Add MSG keys**

In `packages/relay-protocol/src/messages.ts`, add to the `MSG` object (after `sessionsRemove`):

```ts
  sessionsArchive: "control.sessions.archive",
  sessionsUnarchive: "control.sessions.unarchive",
```

Add payload interfaces (after `SessionsRemovePayload`/`SessionsRemoveResult`):

```ts
export interface SessionsArchivePayload {
  chatKey: string;
  alias: string;
}
export interface SessionsUnarchivePayload {
  chatKey: string;
  alias: string;
}
```

- [ ] **Step 2: Add `archived` to `SessionDto`**

In `packages/relay-protocol/src/dtos.ts`:

```ts
export interface SessionDto {
  alias: string;
  agent: string;
  workspace: string;
  transportSession: string;
  running: boolean;
  archived: boolean;
}
```

- [ ] **Step 3: Build the protocol package**

Per [[reference_bun_barrel_empty_export]], this package must be built with `tsc`, not bun. Run the package's build (check `packages/relay-protocol/package.json` scripts — typically `npm run -w @ganglion/xacpx-relay-protocol build` or `tsc -p packages/relay-protocol`). Confirm `dist/messages.d.ts` contains the new keys.

- [ ] **Step 4: Typecheck**

Run: `npx tsc --noEmit`
Expected: clean (consumers that build `SessionDto` now require `archived` — those are fixed in Task 8 core builder + Task 12 web; if core/web aren't both updated yet, expect TS errors there until those tasks land — sequence Phase 3 before this).

- [ ] **Step 5: Commit**

```bash
git add packages/relay-protocol/src/messages.ts packages/relay-protocol/src/dtos.ts
# include built dist only if the repo commits protocol dist (check git status of packages/relay-protocol/dist)
git commit -m "feat(protocol): archive/unarchive messages + SessionDto.archived"
```

---

### Task 10: Connector control-bridge dispatch

**Files:**
- Modify: `packages/channel-relay/src/control-bridge.ts` (imports + 2 cases)
- Test: `packages/channel-relay/src/__tests__/control-bridge-archive.test.ts` (new, if the package has tests; else rely on tsc + manual)

- [ ] **Step 1: Add the dispatch cases**

In `packages/channel-relay/src/control-bridge.ts`, add to the import of payload types (line 27) `SessionsArchivePayload, SessionsUnarchivePayload`, and add cases next to `MSG.sessionsRemove` (~line 92):

```ts
    case MSG.sessionsArchive: {
      const input = payload as SessionsArchivePayload;
      await control.archiveSession(input.chatKey, input.alias);
      return {};
    }
    case MSG.sessionsUnarchive: {
      const input = payload as SessionsUnarchivePayload;
      await control.unarchiveSession(input.chatKey, input.alias);
      return {};
    }
```

- [ ] **Step 2: Build connector + verify**

Per [[reference_sandbox_connector_from_plugin_home]] and [[reference_bun_barrel_empty_export]], rebuild the connector package (`tsc`-based) so the new cases ship. Run the package typecheck/build.

Run: `npx tsc --noEmit`
Expected: clean.

- [ ] **Step 3: Commit**

```bash
git add packages/channel-relay/src/control-bridge.ts
git commit -m "feat(connector): dispatch sessions.archive/unarchive to ControlService"
```

---

### Task 11: Chat `/session archive <alias>` command

**Files:**
- Modify: `src/commands/parse-command.ts` (parse case + `ParsedCommand` union)
- Modify: `src/commands/command-router.ts` (dispatch case)
- Modify: `src/commands/handlers/session-handler.ts` (`handleSessionArchive`)
- Modify: `src/i18n/messages/en/*.ts` + `src/i18n/messages/zh/*.ts` (session strings)
- Test: `tests/unit/commands/parse-command.test.ts` (extend) + handler test

- [ ] **Step 1: Write the failing parse test**

In `tests/unit/commands/parse-command.test.ts` (or a new sibling), add:

```ts
it("parses /session archive <alias>", () => {
  expect(parseCommand("/session archive backend")).toEqual({ kind: "session.archive", alias: "backend" });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run tests/unit/commands/parse-command.test.ts`
Expected: FAIL.

- [ ] **Step 3: Add the parse case + union member**

In `src/commands/parse-command.ts`, add to `ParsedCommand`: `| { kind: "session.archive"; alias: string }`. Add the parse case next to `session.rm`:

```ts
  if (command === "/session" && parts[1] === "archive" && parts[2] && parts.length === 3) {
    return { kind: "session.archive", alias: parts[2] };
  }
```

- [ ] **Step 4: Add the handler**

In `src/commands/handlers/session-handler.ts`, add `handleSessionArchive` mirroring `handleSessionRemove`'s resolution but calling the archive orchestration. It receives `context` (which carries `sessions`+`transport`). Since the router method `archiveSessionWithTransport` lives on `CommandRouter`, expose it to the handler by adding a thin context op OR dispatch directly in the router (simpler). Use the router-dispatch approach in Step 5.

```ts
export async function handleSessionArchive(
  context: SessionHandlerContext,
  chatKey: string,
  alias: string,
  archive: (internalAlias: string) => Promise<void>,
): Promise<RouterResponse> {
  const internalAlias = await context.sessions.resolveAliasForChat(chatKey, alias);
  const session = await context.sessions.getSession(internalAlias);
  if (!session) {
    return { text: t().session.sessionNotFound(alias) };
  }
  await archive(internalAlias);
  return { text: t().session.sessionArchived(alias) };
}
```

- [ ] **Step 5: Dispatch in the router**

In `src/commands/command-router.ts`, add next to the `session.rm` case:

```ts
        case "session.archive":
          return await handleSessionArchive(
            this.createSessionHandlerContext(undefined, perfSpan),
            chatKey,
            command.alias,
            (internalAlias) => this.archiveSessionWithTransport(internalAlias),
          );
```

Import `handleSessionArchive` next to `handleSessionRemove` (line 33).

- [ ] **Step 6: Add i18n string `sessionArchived`**

Find where `sessionRemoved` is defined in the i18n session messages (grep `sessionRemoved(` under `src/i18n/`). Add a sibling in both en and zh:

```ts
// en
sessionArchived: (alias: string) => `Archived session "${alias}". Send a message to restore it.`,
// zh
sessionArchived: (alias: string) => `已归档会话「${alias}」。发送消息即可恢复。`,
```

Add `sessionArchived` to the i18n type in `src/i18n/types.ts` (find the `session` block).

- [ ] **Step 7: Run tests + typecheck**

Run: `npx vitest run tests/unit/commands/ && npx tsc --noEmit`
Expected: PASS + clean.

- [ ] **Step 8: Commit**

```bash
git add src/commands/parse-command.ts src/commands/command-router.ts src/commands/handlers/session-handler.ts src/i18n tests/unit/commands/parse-command.test.ts
git commit -m "feat(commands): add /session archive <alias>"
```

---

## Phase 5 — relay-web UI (`packages/relay-web`)

Run relay-web tests with: `bun run --cwd packages/relay-web test -- <filter>` (vitest; not whole-dir bun test — see [[reference_whole_dir_bun_test_state_leak]]).

### Task 12: Store actions + archived sort

**Files:**
- Modify: `packages/relay-web/src/stores/instances.ts` (`archiveSession`, `unarchiveSession`, export)
- Test: `packages/relay-web/src/__tests__/instances-archive.test.ts` (new)

- [ ] **Step 1: Write the failing test**

```ts
// packages/relay-web/src/__tests__/instances-archive.test.ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import { setActivePinia, createPinia } from "pinia";
import { useInstancesStore } from "../stores/instances";
import { api } from "../api/client";

describe("instances archive actions", () => {
  beforeEach(() => setActivePinia(createPinia()));
  it("archiveSession calls control.sessions.archive then reloads", async () => {
    const store = useInstancesStore();
    const rpc = vi.spyOn(api, "rpc").mockResolvedValue({ sessions: [] } as never);
    await store.archiveSession("i1", "backend");
    expect(rpc).toHaveBeenCalledWith("i1", "control.sessions.archive", { alias: "backend" });
  });
  it("unarchiveSession calls control.sessions.unarchive", async () => {
    const store = useInstancesStore();
    const rpc = vi.spyOn(api, "rpc").mockResolvedValue({ sessions: [] } as never);
    await store.unarchiveSession("i1", "backend");
    expect(rpc).toHaveBeenCalledWith("i1", "control.sessions.unarchive", { alias: "backend" });
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `bun run --cwd packages/relay-web test -- instances-archive`
Expected: FAIL.

- [ ] **Step 3: Add the actions**

In `packages/relay-web/src/stores/instances.ts`, after `removeSession` (line 175):

```ts
  async function archiveSession(instanceId: string, alias: string): Promise<void> {
    await api.rpc(instanceId, "control.sessions.archive", { alias });
    await loadSessions(instanceId);
  }
  async function unarchiveSession(instanceId: string, alias: string): Promise<void> {
    await api.rpc(instanceId, "control.sessions.unarchive", { alias });
    await loadSessions(instanceId);
  }
```

Add `archiveSession, unarchiveSession` to the returned object (line 204).

- [ ] **Step 4: Run the test + vue-tsc**

Run: `bun run --cwd packages/relay-web test -- instances-archive && bun run --cwd packages/relay-web build`
Expected: PASS + build clean.

- [ ] **Step 5: Commit**

```bash
git add packages/relay-web/src/stores/instances.ts packages/relay-web/src/__tests__/instances-archive.test.ts
git commit -m "feat(relay-web): archiveSession/unarchiveSession store actions"
```

---

### Task 13: InstanceTree — overflow menu, archived rendering (greyed + sunk), offline-disable

**Files:**
- Modify: `packages/relay-web/src/components/InstanceTree.vue`
- Modify: `packages/relay-web/src/__tests__/instancetree.test.ts`
- Modify: `packages/relay-web/src/i18n/messages/zh-CN.ts` + `en.ts` (archive strings)

- [ ] **Step 1: Add i18n strings**

In both locales, inside the `instance:` block, add:

```ts
// en.ts
archiveSession: "Archive session",
sessionArchivedBadge: "archived",
sessionArchivedToast: "Archived \"{alias}\"",
undo: "Undo",
// zh-CN.ts
archiveSession: "归档会话",
sessionArchivedBadge: "已归档",
sessionArchivedToast: "已归档「{alias}」",
undo: "撤销",
```

- [ ] **Step 2: Write failing component tests**

Add to `instancetree.test.ts`:

```ts
it("greys archived sessions and sinks them to the bottom of the group", () => {
  const store = useInstancesStore();
  store.instances = [instance([
    { alias: "active", agent: "claude", workspace: "home", transportSession: "t1", running: false, archived: false },
    { alias: "arch", agent: "codex", workspace: "home", transportSession: "t2", running: false, archived: true },
  ])] as never;
  const w = mount(InstanceTree, { global: { stubs: { NewSessionDialog: true } } });
  const rows = w.findAll('[data-test="session-row"]');
  expect(rows[rows.length - 1].text()).toContain("arch"); // archived sunk to bottom
  expect(w.find('[data-test="archived-badge"]').exists()).toBe(true);
});

it("disables row actions when the instance is offline", () => {
  const store = useInstancesStore();
  store.instances = [{ ...instance([{ alias: "a", agent: "claude", workspace: "home", transportSession: "t", running: false, archived: false }]), online: false }] as never;
  const w = mount(InstanceTree, { global: { stubs: { NewSessionDialog: true } } });
  expect(w.find('[data-test="session-actions"]').exists()).toBe(false);
});
```

Update existing rows in the file's `instance(...)` session fixtures to include `archived: false` (the new required DTO field).

- [ ] **Step 3: Run to verify failure**

Run: `bun run --cwd packages/relay-web test -- instancetree`
Expected: FAIL.

- [ ] **Step 4: Implement the component changes**

In `InstanceTree.vue`:

1. Replace the iteration source with a computed that sinks archived rows. Add to `<script setup>`:

```ts
import { computed } from "vue";
import { MoreHorizontal, Archive, Trash2 } from "lucide-vue-next";

function orderedSessions(sessions: { archived?: boolean }[]) {
  // stable: actives keep server order, archived go last
  return [...sessions].sort((a, b) => Number(a.archived ?? false) - Number(b.archived ?? false));
}

const openMenuFor = ref<string | null>(null); // `${instanceId}:${alias}` or null

async function onArchive(id: string, alias: string) {
  openMenuFor.value = null;
  await store.archiveSession(id, alias).catch(() => {});
  showUndoToast(id, alias); // defined in Task 15
}
```

2. In the template, change `v-for="s in inst.sessions"` → `v-for="s in orderedSessions(inst.sessions)"`, add `data-test="session-row"` to the row `<div>`, and on `s.archived` grey the title (`text-fg-muted`) + suppress the attention/running dots (`v-if="!s.archived && ..."`) + render a badge:

```vue
<span v-if="s.archived" data-test="archived-badge" class="shrink-0 rounded bg-bg px-1 py-px text-[9px] text-fg-muted">{{ $t("instance.sessionArchivedBadge") }}</span>
```

3. Replace the single delete button with a `data-test="session-actions"` cluster gated on `inst.online` — a `⋯` button toggling `openMenuFor`, and a popover with Archive + Delete:

```vue
<div v-if="inst.online" data-test="session-actions" class="relative mr-1 shrink-0">
  <button data-test="session-menu" :aria-label="$t('common.more')"
          class="grid h-5 w-5 place-items-center rounded text-fg-muted hover:bg-raised hover:text-fg [@media(hover:hover)]:opacity-0 [@media(hover:hover)]:group-hover:opacity-100 opacity-100"
          @click.stop="openMenuFor = openMenuFor === `${inst.id}:${s.alias}` ? null : `${inst.id}:${s.alias}`"><MoreHorizontal :size="13" /></button>
  <div v-if="openMenuFor === `${inst.id}:${s.alias}`" class="absolute right-0 z-20 mt-1 w-32 rounded-md border border-border bg-surface py-1 shadow-lg">
    <button v-if="!s.archived" data-test="action-archive" class="flex w-full items-center gap-2 px-2.5 py-1 text-left text-[12px] text-fg hover:bg-raised" @click.stop="onArchive(inst.id, s.alias)"><Archive :size="12" />{{ $t("instance.archiveSession") }}</button>
    <button data-test="action-delete" class="flex w-full items-center gap-2 px-2.5 py-1 text-left text-[12px] text-danger hover:bg-danger/10" @click.stop="askDelete(inst.id, s.alias)"><Trash2 :size="12" />{{ $t("common.delete") }}</button>
  </div>
</div>
```

Add a document-level click handler to close the menu on outside-click (mirror `SelectMenu.vue`'s `mousedown` outside-click pattern). Keep `askDelete` unchanged (already a destructive confirm).

- [ ] **Step 5: Run the tests + build**

Run: `bun run --cwd packages/relay-web test -- instancetree && bun run --cwd packages/relay-web build`
Expected: PASS + clean. (The `showUndoToast` reference will be stubbed/no-op until Task 15 — define a local no-op now and replace in Task 15, or sequence Task 15's toast store before wiring; to keep this task green, add a temporary `function showUndoToast() {}` and remove it in Task 15.)

- [ ] **Step 6: Commit**

```bash
git add packages/relay-web/src/components/InstanceTree.vue packages/relay-web/src/__tests__/instancetree.test.ts packages/relay-web/src/i18n/messages/zh-CN.ts packages/relay-web/src/i18n/messages/en.ts
git commit -m "feat(relay-web): session overflow menu + archived greyed/sunk + offline-disable"
```

---

### Task 14: Mobile swipe gestures (`useSwipeActions` composable)

**Files:**
- Create: `packages/relay-web/src/lib/use-swipe-actions.ts`
- Modify: `packages/relay-web/src/components/InstanceTree.vue` (bind to rows)
- Test: `packages/relay-web/src/__tests__/use-swipe-actions.test.ts` (new)

- [ ] **Step 1: Write the failing test**

```ts
// packages/relay-web/src/__tests__/use-swipe-actions.test.ts
import { describe, it, expect, vi } from "vitest";
import { useSwipeActions } from "../lib/use-swipe-actions";

function pointer(type: string, x: number) {
  return new PointerEvent(type, { clientX: x, clientY: 0, pointerId: 1, bubbles: true });
}

describe("useSwipeActions", () => {
  it("fires onSwipeLeft past the threshold", () => {
    const onSwipeLeft = vi.fn(), onSwipeRight = vi.fn();
    const { handlers } = useSwipeActions({ onSwipeLeft, onSwipeRight, threshold: 60 });
    handlers.onPointerdown(pointer("pointerdown", 200));
    handlers.onPointermove(pointer("pointermove", 120));
    handlers.onPointerup(pointer("pointerup", 120));
    expect(onSwipeLeft).toHaveBeenCalled();
    expect(onSwipeRight).not.toHaveBeenCalled();
  });
  it("fires onSwipeRight past the threshold", () => {
    const onSwipeLeft = vi.fn(), onSwipeRight = vi.fn();
    const { handlers } = useSwipeActions({ onSwipeLeft, onSwipeRight, threshold: 60 });
    handlers.onPointerdown(pointer("pointerdown", 100));
    handlers.onPointermove(pointer("pointermove", 200));
    handlers.onPointerup(pointer("pointerup", 200));
    expect(onSwipeRight).toHaveBeenCalled();
  });
  it("ignores sub-threshold and vertical-dominant moves", () => {
    const onSwipeLeft = vi.fn(), onSwipeRight = vi.fn();
    const { handlers } = useSwipeActions({ onSwipeLeft, onSwipeRight, threshold: 60 });
    handlers.onPointerdown(pointer("pointerdown", 200));
    handlers.onPointermove(pointer("pointermove", 180));
    handlers.onPointerup(pointer("pointerup", 180));
    expect(onSwipeLeft).not.toHaveBeenCalled();
    expect(onSwipeRight).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `bun run --cwd packages/relay-web test -- use-swipe-actions`
Expected: FAIL — module missing.

- [ ] **Step 3: Implement the composable**

```ts
// packages/relay-web/src/lib/use-swipe-actions.ts
import { ref } from "vue";

export interface SwipeActionsOptions {
  onSwipeLeft: () => void;
  onSwipeRight: () => void;
  threshold?: number; // px of horizontal travel required to fire
}

/** Minimal horizontal-swipe detector for a list row. Tracks pointer travel and
 *  fires left/right past the threshold, ignoring vertical-dominant gestures (so
 *  it doesn't fight the scroll container). `offset` is exposed for a reveal anim. */
export function useSwipeActions(opts: SwipeActionsOptions) {
  const threshold = opts.threshold ?? 64;
  const offset = ref(0);
  let startX = 0, startY = 0, active = false;

  function onPointerdown(e: PointerEvent) {
    active = true; startX = e.clientX; startY = e.clientY; offset.value = 0;
  }
  function onPointermove(e: PointerEvent) {
    if (!active) return;
    const dx = e.clientX - startX, dy = e.clientY - startY;
    if (Math.abs(dy) > Math.abs(dx)) { active = false; offset.value = 0; return; } // vertical → let it scroll
    offset.value = dx;
  }
  function onPointerup(e: PointerEvent) {
    if (!active) return;
    active = false;
    const dx = e.clientX - startX, dy = e.clientY - startY;
    offset.value = 0;
    if (Math.abs(dy) > Math.abs(dx)) return;
    if (dx <= -threshold) opts.onSwipeLeft();
    else if (dx >= threshold) opts.onSwipeRight();
  }

  return { offset, handlers: { onPointerdown, onPointermove, onPointerup } };
}
```

- [ ] **Step 4: Bind in InstanceTree (mobile only)**

In `InstanceTree.vue`, for each session row attach the pointer handlers (they no-op on desktop where the user uses the ⋯ menu; the swipe just provides a second path). Create a per-row binding helper that calls `onArchive` on swipe-left and `askDelete` on swipe-right, gated on `inst.online`. Bind `@pointerdown/@pointermove/@pointerup` on the row `<div>`. Keep `touch-action: pan-y` on the row so vertical scroll still works (`class="... touch-pan-y"`).

- [ ] **Step 5: Run tests + build**

Run: `bun run --cwd packages/relay-web test -- use-swipe-actions instancetree && bun run --cwd packages/relay-web build`
Expected: PASS + clean.

- [ ] **Step 6: Commit**

```bash
git add packages/relay-web/src/lib/use-swipe-actions.ts packages/relay-web/src/components/InstanceTree.vue packages/relay-web/src/__tests__/use-swipe-actions.test.ts
git commit -m "feat(relay-web): mobile swipe — left archive / right delete"
```

---

### Task 15: Undo toast

**Files:**
- Create: `packages/relay-web/src/lib/use-action-toast.ts` (local toast singleton with an action button)
- Create: `packages/relay-web/src/components/ActionToast.vue`
- Modify: `packages/relay-web/src/views/DashboardView.vue` (mount `<ActionToast />`)
- Modify: `packages/relay-web/src/components/InstanceTree.vue` (wire `showUndoToast` → `unarchiveSession`)
- Test: `packages/relay-web/src/__tests__/action-toast.test.ts` (new)

The existing `notices` store is a passive server feed with no action button; the undo toast is a separate local singleton modeled on `use-confirm.ts`.

- [ ] **Step 1: Write the failing test**

```ts
// packages/relay-web/src/__tests__/action-toast.test.ts
import { describe, it, expect, vi } from "vitest";
import { showActionToast, useActionToastState, runToastAction, dismissToast } from "../lib/use-action-toast";

describe("action toast", () => {
  it("exposes the message + action and runs the action once", () => {
    const action = vi.fn();
    showActionToast({ message: "Archived \"x\"", actionLabel: "Undo", action });
    expect(useActionToastState().value?.message).toContain("Archived");
    runToastAction();
    expect(action).toHaveBeenCalledTimes(1);
    expect(useActionToastState().value).toBeNull();
  });
  it("dismiss clears without running the action", () => {
    const action = vi.fn();
    showActionToast({ message: "m", actionLabel: "Undo", action });
    dismissToast();
    expect(action).not.toHaveBeenCalled();
    expect(useActionToastState().value).toBeNull();
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `bun run --cwd packages/relay-web test -- action-toast`
Expected: FAIL.

- [ ] **Step 3: Implement the toast singleton**

```ts
// packages/relay-web/src/lib/use-action-toast.ts
import { ref } from "vue";

export interface ActionToast {
  message: string;
  actionLabel: string;
  action: () => void;
}

const current = ref<ActionToast | null>(null);
let timer: ReturnType<typeof setTimeout> | null = null;

export function useActionToastState() { return current; }

/** Show a toast with one action button; auto-dismisses after `ms` (default 6s). */
export function showActionToast(toast: ActionToast, ms = 6000): void {
  if (timer) clearTimeout(timer);
  current.value = toast;
  timer = setTimeout(() => { current.value = null; timer = null; }, ms);
}

export function runToastAction(): void {
  const t = current.value;
  current.value = null;
  if (timer) { clearTimeout(timer); timer = null; }
  t?.action();
}

export function dismissToast(): void {
  current.value = null;
  if (timer) { clearTimeout(timer); timer = null; }
}
```

- [ ] **Step 4: Toast component + mount**

```vue
<!-- packages/relay-web/src/components/ActionToast.vue -->
<script setup lang="ts">
import { useActionToastState, runToastAction, dismissToast } from "../lib/use-action-toast";
const toast = useActionToastState();
</script>
<template>
  <Teleport to="body">
    <div v-if="toast" data-test="action-toast"
         class="fixed bottom-[calc(1rem+env(safe-area-inset-bottom))] left-1/2 z-50 flex -translate-x-1/2 items-center gap-3 rounded-lg border border-border bg-surface px-3 py-2 text-sm text-fg shadow-lg">
      <span>{{ toast.message }}</span>
      <button data-test="toast-action" class="font-medium text-accent hover:underline" @click="runToastAction">{{ toast.actionLabel }}</button>
      <button class="text-fg-muted hover:text-fg" :aria-label="$t('common.dismiss')" @click="dismissToast">×</button>
    </div>
  </Teleport>
</template>
```

Mount `<ActionToast />` once in `DashboardView.vue` next to `<NoticeToast />` (import + place in template).

- [ ] **Step 5: Wire archive undo in InstanceTree**

Replace the temporary `showUndoToast` no-op from Task 13 with:

```ts
import { showActionToast } from "../lib/use-action-toast";
import { useI18n } from "vue-i18n";

function showUndoToast(id: string, alias: string) {
  showActionToast({
    message: t("instance.sessionArchivedToast", { alias }),
    actionLabel: t("instance.undo"),
    action: () => { void store.unarchiveSession(id, alias).catch(() => {}); },
  });
}
```

- [ ] **Step 6: Run tests + build**

Run: `bun run --cwd packages/relay-web test -- action-toast instancetree && bun run --cwd packages/relay-web build`
Expected: PASS + clean.

- [ ] **Step 7: Commit**

```bash
git add packages/relay-web/src/lib/use-action-toast.ts packages/relay-web/src/components/ActionToast.vue packages/relay-web/src/views/DashboardView.vue packages/relay-web/src/components/InstanceTree.vue packages/relay-web/src/__tests__/action-toast.test.ts
git commit -m "feat(relay-web): undo toast for session archive"
```

---

### Task 16: Full verification

- [ ] **Step 1: Core typecheck + unit tests**

Run: `npx tsc --noEmit && npm test`
Expected: all green.

- [ ] **Step 2: relay-web full suite + build**

Run: `bun run --cwd packages/relay-web test && bun run --cwd packages/relay-web build`
Expected: all green + build clean.

- [ ] **Step 3: Protocol + connector build**

Run the `tsc`-based builds for `packages/relay-protocol` and `packages/channel-relay` and confirm dist contains the new message keys/cases ([[reference_bun_barrel_empty_export]]).

- [ ] **Step 4: Manual end-to-end (sandbox)**

Per [[reference_sandbox_connector_from_plugin_home]]: rebuild + reinstall the connector into its plugin home, restart the console, then in relay-web: archive a codex session (row greys + sinks, undo toast appears), send it a message (restores + history intact), delete a session (gone; re-create same name → fresh, no history). Verify offline instance disables the actions.

---

## Self-Review notes (addressed)

- **Spec coverage:** Module 1 (acpx-session-files) → Task 1; Module 2 (transport deleteSession) → Tasks 2–3 + archive reuse of removeSession (Task 7); Module 3 → Tasks 6–8; Module 4 → Tasks 9–11; Module 5 → Tasks 12–15. Restore-on-message → Task 6 (`useSession` clear). Smart shared-transport guard → Task 7. Offline-disable → Task 13. Undo → Task 15. Sunk+greyed → Task 13.
- **Type consistency:** `deleteAcpxSessionFiles` (acpx-session-files), `deleteSession` (transport), `setArchived` (SessionService), `archiveSessionWithTransport`/`removeSessionWithTransport`/`unarchiveSession` (router + control deps), `archived` (LogicalSession + ControlSessionInfo + SessionDto), `MSG.sessionsArchive`/`sessionsUnarchive` + `SessionsArchivePayload`/`SessionsUnarchivePayload` (protocol), `control.sessions.archive`/`.unarchive` (RPC strings), `archiveSession`/`unarchiveSession` (web store + control-service) — used consistently across tasks.
- **Sequencing:** Phase 1 (transport `deleteSession` via Route B file deletion — no acpx changes) → Phase 3 before Task 9 (so the `SessionDto.archived` required-field change has its core/web builders updated in the same merge). Task 13 leaves a temporary `showUndoToast` no-op removed in Task 15.
