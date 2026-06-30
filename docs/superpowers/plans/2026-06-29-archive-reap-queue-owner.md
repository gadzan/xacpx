# Archive Reaps the Queue-Owner Process — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make web/control archive immediately free the corresponding acpx warm queue-owner process, while keeping restore lossless and repeatable.

**Architecture:** Add an optional `freeWarmProcess(session)` method to the `SessionTransport` interface that terminates a session's warm queue-owner process **without** closing the acpx session record (reusing the existing `terminateAcpxQueueOwner`). Wire `archiveSessionWithTransport` to call it (best-effort, only when the transport session is not shared). Implement for both the `acpx-cli` and `acpx-bridge` transports. Restore needs no change — the acpx record stays open, so the next prompt resumes full history.

**Tech Stack:** TypeScript, Bun test runner, acpx CLI.

## Global Constraints

- Spec: `docs/superpowers/specs/2026-06-29-archive-reap-queue-owner-design.md`.
- `freeWarmProcess` is **optional** on `SessionTransport` (`freeWarmProcess?`). Callers invoke it with `?.`.
- `freeWarmProcess` MUST NOT close the acpx session: no `acpx sessions close`, no `closed` flag, no metadata change. It only terminates the warm queue-owner process via `terminateAcpxQueueOwner(acpxRecordId)`.
- Idempotent: a missing session (record cannot be resolved) or a missing warm process is a **no-op return**, never a throw.
- Archive must only reap when the transport session is **not shared** by another alias (reuse the existing `!shared` guard). Reap failures are swallowed + logged; `setArchived(true)` still runs.
- Tests run under Bun: `bun test <file>` per-file (never whole-dir — state leak). Typecheck with `npx tsc --noEmit`.
- Record-id resolution already exists: `readSessionRecord(session) → { acpxRecordId }` in both `acpx-cli-transport.ts` and `bridge-runtime.ts`.

---

### Task 1: `freeWarmProcess` on the interface + acpx-cli transport

**Files:**
- Modify: `src/transport/types.ts` (add optional method to `SessionTransport`, after `deleteSession?` ~line 224)
- Modify: `src/transport/acpx-cli/acpx-cli-transport.ts` (import + method, near `deleteSession` ~line 440; comment fix ~line 447-450)
- Test: `tests/unit/transport/acpx-cli-free-warm-process.test.ts` (create)

**Interfaces:**
- Consumes: `terminateAcpxQueueOwner(sessionId: string): Promise<void>` from `src/transport/acpx-queue-owner-launcher.ts` (existing export); private `readSessionRecord(session): Promise<{ acpxRecordId: string; agentSessionId?: string }>`.
- Produces: `SessionTransport.freeWarmProcess?(session: ResolvedSession): Promise<void>`; `AcpxCliTransport.freeWarmProcess(session): Promise<void>`.

- [ ] **Step 1: Write the failing test**

Create `tests/unit/transport/acpx-cli-free-warm-process.test.ts`:

```ts
import { test, expect, spyOn, mock } from "bun:test";

const terminate = mock(async (_sessionId: string) => {});
// Stub the launcher helper so we assert freeWarmProcess kills the warm owner by
// the resolved acpxRecordId, without touching the real ~/.acpx/queues dir.
// AcpxCliTransport imports it from "../acpx-queue-owner-launcher"; mock.module
// matches by resolved source path. Re-export the other named imports the
// transport pulls from that module so the real ones still resolve.
mock.module("../../../src/transport/acpx-queue-owner-launcher", () => ({
  AcpxQueueOwnerLauncher: class {},
  terminateAcpxQueueOwner: terminate,
}));

import { AcpxCliTransport } from "../../../src/transport/acpx-cli/acpx-cli-transport";
import type { ResolvedSession } from "../../../src/transport/types";

const session: ResolvedSession = {
  alias: "api-fix",
  agent: "codex",
  agentCommand: "./node_modules/.bin/codex-acp",
  workspace: "backend",
  transportSession: "backend:api-fix",
  cwd: "/tmp/backend",
};

function makeTransport() {
  const run = mock(async () => ({ code: 0, stdout: "", stderr: "" }));
  const runPty = mock(async () => ({ code: 0, stdout: "", stderr: "" }));
  return new AcpxCliTransport({ command: "acpx" }, run, runPty);
}

test("freeWarmProcess terminates the warm owner by acpxRecordId", async () => {
  terminate.mockClear();
  const transport = makeTransport();
  const recordId = "ws:rec-456";
  const readRecord = spyOn(transport as never, "readSessionRecord").mockResolvedValue({
    acpxRecordId: recordId,
  } as never);

  await transport.freeWarmProcess?.(session);

  expect(readRecord).toHaveBeenCalledTimes(1);
  expect(terminate).toHaveBeenCalledTimes(1);
  expect(terminate).toHaveBeenCalledWith(recordId);
});

test("freeWarmProcess is a no-op when the session can't be resolved", async () => {
  terminate.mockClear();
  const transport = makeTransport();
  spyOn(transport as never, "readSessionRecord").mockRejectedValue(new Error("no session") as never);

  await expect(transport.freeWarmProcess?.(session)).resolves.toBeUndefined();
  expect(terminate).not.toHaveBeenCalled();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/unit/transport/acpx-cli-free-warm-process.test.ts`
Expected: FAIL — `transport.freeWarmProcess` is `undefined` (method not implemented), so the first test fails on `readRecord`/`terminate` not called.

- [ ] **Step 3: Add the optional method to the interface**

In `src/transport/types.ts`, immediately after the `deleteSession?(...)` declaration (~line 224), add:

```ts
  /**
   * Terminate the warm queue-owner process for this session, freeing its
   * resources, WITHOUT closing the acpx session (no `closed` flag, no metadata
   * change) — the session stays open and resumes with full history on the next
   * prompt. Idempotent: a missing warm process or missing session is a no-op.
   * Used by archive to free the process now instead of waiting for acpx's TTL.
   * Optional: transports that can't reap omit it.
   */
  freeWarmProcess?(session: ResolvedSession): Promise<void>;
```

- [ ] **Step 4: Implement in the cli transport**

In `src/transport/acpx-cli/acpx-cli-transport.ts`, extend the existing launcher import (~line 30) to also pull in the terminator:

```ts
import { AcpxQueueOwnerLauncher, terminateAcpxQueueOwner } from "../acpx-queue-owner-launcher";
```

Then add the method right after `deleteSession` (~line 453):

```ts
  async freeWarmProcess(session: ResolvedSession): Promise<void> {
    let acpxRecordId: string;
    try {
      ({ acpxRecordId } = await this.readSessionRecord(session));
    } catch {
      return; // acpx session already gone → no warm process to free
    }
    // Kill ONLY the warm queue-owner process; do NOT `sessions close` it. Closing
    // marks the record `closed` (acpx excludes it from name lookup → unresumable,
    // history lost on next prompt). Terminating the owner leaves the record open,
    // so the next prompt resumes the same conversation with full history.
    await terminateAcpxQueueOwner(acpxRecordId);
  }
```

- [ ] **Step 5: Fix the stale comment in `deleteSession`**

In the same file, replace the stale comment inside `deleteSession` (~line 447-450) that reads:

```ts
    // Close the acpx session (best-effort), then unlink its on-disk files. close
    // returning does NOT mean the backing process exited — acpx keeps a warm
    // queue-owner alive via --ttl. See deleteAcpxSessionFiles for the residual
    // orphan-stream-file risk this leaves (notably on Windows).
```

with:

```ts
    // Close the acpx session (terminates the queue owner + agent process since
    // acpx >=0.10), then unlink its on-disk files. See deleteAcpxSessionFiles for
    // the residual orphan-stream-file risk this leaves (notably on Windows).
```

- [ ] **Step 6: Run test to verify it passes**

Run: `bun test tests/unit/transport/acpx-cli-free-warm-process.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 7: Typecheck**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 8: Commit**

```bash
git add src/transport/types.ts src/transport/acpx-cli/acpx-cli-transport.ts tests/unit/transport/acpx-cli-free-warm-process.test.ts
git commit -m "feat(transport): add freeWarmProcess to reap a session's warm queue owner (cli)"
```

---

### Task 2: Wire archive to reap the warm process

**Files:**
- Modify: `src/commands/command-router.ts` (`archiveSessionWithTransport` ~line 631-659)
- Test: `tests/unit/commands/session-archive-delete.test.ts` (update `makeTransport` + 2 existing archive tests; add 2 new tests)

**Interfaces:**
- Consumes: `SessionTransport.freeWarmProcess?(session): Promise<void>` (Task 1); existing `this.transport.cancel`, `this.sessions.countAliasesSharingTransport`, `this.sessions.setArchived`, `this.logger.error`, `this.activeTurns?.isActiveAnywhere`.
- Produces: updated `archiveSessionWithTransport` behavior (calls `freeWarmProcess` when not shared).

- [ ] **Step 1: Update the test transport mock to expose `freeWarmProcess`**

In `tests/unit/commands/session-archive-delete.test.ts`, update `makeTransport` (~line 30-36):

```ts
function makeTransport(): SessionTransport {
  return {
    cancel: mock(async () => ({ cancelled: true, message: "cancelled" })),
    removeSession: mock(async (_session: ResolvedSession) => {}),
    deleteSession: mock(async (_session: ResolvedSession) => {}),
    freeWarmProcess: mock(async (_session: ResolvedSession) => {}),
  } as unknown as SessionTransport;
}
```

- [ ] **Step 2: Update the two existing archive tests to assert the new behavior (failing)**

Replace the body of the test `"archiveSessionWithTransport cancels the in-flight turn but KEEPS the acpx session resumable"` (~line 65-82) with:

```ts
test("archiveSessionWithTransport cancels the in-flight turn and reaps the warm process but KEEPS the acpx session resumable", async () => {
  const sessions = makeSessions({ sharedCount: 0 });
  const transport = makeTransport();
  const router = new CommandRouter(sessions, transport);

  await router.archiveSessionWithTransport("backend:demo");

  expect((transport.cancel as ReturnType<typeof mock>).mock.calls.length).toBe(1);
  // Frees the warm queue-owner process now (instead of waiting for TTL)...
  expect((transport.freeWarmProcess as ReturnType<typeof mock>).mock.calls.length).toBe(1);
  // ...but must NOT close: closing marks the record `closed`, making it unresumable
  // and losing history on the next prompt. The session stays alive so re-prompting
  // resumes the same conversation.
  expect((transport.removeSession as ReturnType<typeof mock>).mock.calls.length).toBe(0);
  const setArchived = sessions.setArchived as ReturnType<typeof mock>;
  expect(setArchived.mock.calls.length).toBe(1);
  expect(setArchived.mock.calls[0]).toEqual(["backend:demo", true]);
  // archive must not delete history.
  expect((transport.deleteSession as ReturnType<typeof mock>).mock.calls.length).toBe(0);
});
```

Replace the body of `"archiveSessionWithTransport keeps a shared process running"` (~line 84-94) with:

```ts
test("archiveSessionWithTransport keeps a shared process running", async () => {
  const sessions = makeSessions({ sharedCount: 2 });
  const transport = makeTransport();
  const router = new CommandRouter(sessions, transport);

  await router.archiveSessionWithTransport("backend:demo");

  // Shared transport: don't cancel and don't reap — another live alias needs the process.
  expect((transport.cancel as ReturnType<typeof mock>).mock.calls.length).toBe(0);
  expect((transport.freeWarmProcess as ReturnType<typeof mock>).mock.calls.length).toBe(0);
  expect((transport.removeSession as ReturnType<typeof mock>).mock.calls.length).toBe(0);
  expect((sessions.setArchived as ReturnType<typeof mock>).mock.calls.length).toBe(1);
});
```

- [ ] **Step 3: Add a test that a reap failure is swallowed and archive still completes**

Add this test after the "keeps a shared process running" test:

```ts
test("archiveSessionWithTransport still archives when freeWarmProcess throws", async () => {
  const sessions = makeSessions({ sharedCount: 0 });
  const transport = makeTransport();
  (transport.freeWarmProcess as ReturnType<typeof mock>).mockImplementation(async () => {
    throw new Error("kill failed");
  });
  const router = new CommandRouter(sessions, transport);

  await router.archiveSessionWithTransport("backend:demo");

  expect((transport.freeWarmProcess as ReturnType<typeof mock>).mock.calls.length).toBe(1);
  const setArchived = sessions.setArchived as ReturnType<typeof mock>;
  expect(setArchived.mock.calls.length).toBe(1);
  expect(setArchived.mock.calls[0]).toEqual(["backend:demo", true]);
});
```

- [ ] **Step 4: Run tests to verify they fail**

Run: `bun test tests/unit/commands/session-archive-delete.test.ts`
Expected: FAIL — the new `freeWarmProcess` call-count assertions fail (router does not call it yet).

- [ ] **Step 5: Implement the reap in `archiveSessionWithTransport`**

In `src/commands/command-router.ts`, update the `if (!shared)` block (~line 643-657) so that after the `cancel` it also reaps the warm process, and replace the obsolete "intentionally do NOT close" comment:

```ts
    const shared = this.sessions.countAliasesSharingTransport(session.transportSession, internalAlias) > 0;
    if (!shared) {
      try {
        await this.transport.cancel(session);
      } catch {
        /* best-effort */
      }
      // Free the warm queue-owner process now instead of waiting for acpx's TTL to
      // idle it out. freeWarmProcess kills ONLY the owner process — it does NOT
      // `sessions close` the record (no `closed` flag), so the session stays open
      // and the next prompt resumes the same conversation with full history,
      // repeatably across archive→restore cycles. Best-effort: on failure the
      // process simply lingers until TTL (the prior behavior), never a regression.
      try {
        await this.transport.freeWarmProcess?.(session);
      } catch (error) {
        await this.logger.error(
          "session.free_warm_process_failed",
          "failed to free warm queue-owner on archive",
          {
            alias: internalAlias,
            transportSession: session.transportSession,
            message: error instanceof Error ? error.message : String(error),
          },
        );
      }
    }
    await this.sessions.setArchived(internalAlias, true);
```

Also update the method's doc-comment (~line 627-630) to mention the reap:

```ts
  /** Archive: cancel any in-flight turn and free the warm queue-owner process
   *  (when no other alias shares the transport), but keep the acpx session open
   *  and resumable, then flag the logical session archived. Re-prompting later
   *  resumes the same conversation with full history; the first post-archive
   *  prompt cold-starts a fresh queue owner. */
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `bun test tests/unit/commands/session-archive-delete.test.ts`
Expected: PASS (all tests, including the in-flight-turn test which is unchanged — it asserts `cancel`/`removeSession` not called; `freeWarmProcess` is also not reached because the method throws before the `!shared` block).

- [ ] **Step 7: Typecheck**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 8: Commit**

```bash
git add src/commands/command-router.ts tests/unit/commands/session-archive-delete.test.ts
git commit -m "feat(commands): archive frees the warm queue-owner process (keeps session open)"
```

---

### Task 3: `freeWarmProcess` on the acpx-bridge transport

**Files:**
- Modify: `src/transport/acpx-bridge/acpx-bridge-protocol.ts` (add `"freeWarmProcess"` to `BridgeMethod`)
- Modify: `src/transport/acpx-bridge/acpx-bridge-transport.ts` (add method ~near `deleteSession` line 279)
- Modify: `src/bridge/bridge-server.ts` (add to `BRIDGE_METHODS` + `SESSION_SCOPED_METHODS` sets; add dispatch `case`)
- Modify: `src/bridge/bridge-runtime.ts` (import `terminateAcpxQueueOwner`; add `freeWarmProcess`; fix stale comment in `deleteSession` ~line 678-681)
- Test: `tests/unit/bridge/bridge-runtime-free-warm-process.test.ts` (create)

**Interfaces:**
- Consumes: `terminateAcpxQueueOwner` (existing); `BridgeRuntime.readSessionRecord(input): Promise<{ acpxRecordId: string }>`; `this.client.request(method, params)`; `this.toParams(session)`.
- Produces: `BridgeMethod` value `"freeWarmProcess"`; `AcpxBridgeTransport.freeWarmProcess(session)`; `BridgeRuntime.freeWarmProcess(input): Promise<Record<string, never>>`.

- [ ] **Step 1: Write the failing runtime test**

Create `tests/unit/bridge/bridge-runtime-free-warm-process.test.ts`:

```ts
import { test, expect, mock } from "bun:test";

const terminate = mock(async (_sessionId: string) => {});
// Stub the launcher helper; bridge-runtime imports it from
// "../transport/acpx-queue-owner-launcher". Re-export AcpxQueueOwnerLauncher so
// the runtime's other import from that module still resolves.
mock.module("../../../src/transport/acpx-queue-owner-launcher", () => ({
  AcpxQueueOwnerLauncher: class {},
  terminateAcpxQueueOwner: terminate,
}));

import { BridgeRuntime } from "../../../src/bridge/bridge-runtime";

const input = { agent: "codex", cwd: "/repo", name: "demo" };
const recordId = "019d009c-1111-7000-8000-aaaaaaaaaaaa";

test("freeWarmProcess terminates the warm owner by acpxRecordId", async () => {
  terminate.mockClear();
  const calls: string[][] = [];
  const run = mock(async (_command: string, args: string[]) => {
    calls.push(args);
    if (args.includes("show")) {
      return { code: 0, stdout: JSON.stringify({ acpxRecordId: recordId }), stderr: "" };
    }
    return { code: 0, stdout: "", stderr: "" };
  });
  const runtime = new BridgeRuntime("acpx", run);

  await expect(runtime.freeWarmProcess(input)).resolves.toEqual({});

  expect(calls.some((args) => args.includes("show"))).toBe(true);
  // Must NOT close: no `sessions close` is issued.
  expect(calls.some((args) => args.includes("close"))).toBe(false);
  expect(terminate).toHaveBeenCalledTimes(1);
  expect(terminate).toHaveBeenCalledWith(recordId);
});

test("freeWarmProcess is a no-op when the record can't be resolved", async () => {
  terminate.mockClear();
  const run = mock(async (_command: string, _args: string[]) => ({
    code: 1, stdout: "", stderr: "no named session",
  }));
  const runtime = new BridgeRuntime("acpx", run);

  await expect(runtime.freeWarmProcess(input)).resolves.toEqual({});
  expect(terminate).not.toHaveBeenCalled();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/unit/bridge/bridge-runtime-free-warm-process.test.ts`
Expected: FAIL — `runtime.freeWarmProcess` is not a function.

- [ ] **Step 3: Implement `freeWarmProcess` on the bridge runtime**

In `src/bridge/bridge-runtime.ts`, extend the existing launcher import (~line 16) to add the terminator:

```ts
import { AcpxQueueOwnerLauncher, terminateAcpxQueueOwner } from "../transport/acpx-queue-owner-launcher";
```

Add the method next to `deleteSession` (~after line 685):

```ts
  async freeWarmProcess(input: {
    agent: string;
    agentCommand?: string;
    cwd: string;
    name: string;
  }): Promise<Record<string, never>> {
    let acpxRecordId: string;
    try {
      ({ acpxRecordId } = await this.readSessionRecord(input));
    } catch {
      return {}; // acpx session already gone → no warm process to free
    }
    // Kill ONLY the warm queue-owner process; do NOT `sessions close` it (that
    // marks the record `closed` → unresumable, history lost). The record stays
    // open, so the next prompt resumes with full history.
    await terminateAcpxQueueOwner(acpxRecordId);
    return {};
  }
```

- [ ] **Step 4: Fix the stale comment in the runtime's `deleteSession`**

In `src/bridge/bridge-runtime.ts`, replace the stale comment in `deleteSession` (~line 678-681):

```ts
    // Close the acpx session (best-effort), then unlink its on-disk files. close
    // returning does NOT mean the backing process exited — acpx keeps a warm
    // queue-owner alive via --ttl. See deleteAcpxSessionFiles for the residual
    // orphan-stream-file risk this leaves (notably on Windows).
```

with:

```ts
    // Close the acpx session (terminates the queue owner + agent process since
    // acpx >=0.10), then unlink its on-disk files. See deleteAcpxSessionFiles for
    // the residual orphan-stream-file risk this leaves (notably on Windows).
```

- [ ] **Step 5: Run runtime test to verify it passes**

Run: `bun test tests/unit/bridge/bridge-runtime-free-warm-process.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 6: Add the protocol method**

In `src/transport/acpx-bridge/acpx-bridge-protocol.ts`, add `"freeWarmProcess"` to the `BridgeMethod` union (next to `"deleteSession"`):

```ts
  | "removeSession"
  | "deleteSession"
  | "freeWarmProcess"
  | "getAgentSessionId";
```

- [ ] **Step 7: Add the transport method**

In `src/transport/acpx-bridge/acpx-bridge-transport.ts`, add after `deleteSession` (~line 281):

```ts
  async freeWarmProcess(session: ResolvedSession): Promise<void> {
    await this.client.request("freeWarmProcess", this.toParams(session));
  }
```

- [ ] **Step 8: Register the method in the bridge server**

In `src/bridge/bridge-server.ts`:

Add `"freeWarmProcess"` to `BRIDGE_METHODS` (after `"deleteSession"`, ~line 41) and to `SESSION_SCOPED_METHODS` (after `"deleteSession"`, ~line 56).

Add a dispatch case after the `"deleteSession"` case (~line 298):

```ts
      case "freeWarmProcess":
        return await this.runtime.freeWarmProcess({
          agent: requireString(params, "agent"),
          agentCommand: asOptionalString(params.agentCommand),
          cwd: requireString(params, "cwd"),
          name: requireString(params, "name"),
        });
```

- [ ] **Step 9: Typecheck**

Run: `npx tsc --noEmit`
Expected: no errors (the `BridgeMethod` union, the transport method, and the server's exhaustive switch all line up).

- [ ] **Step 10: Run the bridge test suites that touch method routing**

Run: `bun test tests/unit/bridge/bridge-runtime-free-warm-process.test.ts tests/unit/bridge/bridge-server.test.ts tests/unit/transport/acpx-bridge/bridge-protocol.test.ts`
Expected: PASS. If `bridge-server.test.ts` or `bridge-protocol.test.ts` asserts an exhaustive method list, add `"freeWarmProcess"` to that fixture so they pass.

- [ ] **Step 11: Commit**

```bash
git add src/transport/acpx-bridge/acpx-bridge-protocol.ts src/transport/acpx-bridge/acpx-bridge-transport.ts src/bridge/bridge-server.ts src/bridge/bridge-runtime.ts tests/unit/bridge/bridge-runtime-free-warm-process.test.ts
git commit -m "feat(bridge): add freeWarmProcess to reap a session's warm queue owner"
```

---

### Task 4: Full verification sweep

**Files:** none (verification only).

- [ ] **Step 1: Typecheck the whole project**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 2: Run the full unit suite**

Run: `npm test`
Expected: typecheck passes, all unit tests pass. (`npm test` runs the per-file test runner, which avoids the whole-dir Bun state-leak.)

- [ ] **Step 3: (Optional) Manual smoke against real acpx**

With a real acpx session running (a session that has issued at least one prompt, so a warm queue owner exists):
1. Note the queue-owner pid: `cat ~/.acpx/queues/*.lock` (the `pid` field) or `acpx sessions show <name>`.
2. Archive the session from the web UI (or call the control/archive path).
3. Verify the pid is gone: `ps -p <pid>` returns nothing.
4. Verify the session is NOT closed: `acpx sessions show <name>` still reports it (no `closed` state).
5. Send a new message → it resumes with full prior history (cold-starts a fresh owner).
6. Repeat archive → restore once more to confirm repeatability.

Expected: process freed on each archive; history intact on each restore.

---

## Self-Review

**Spec coverage:**
- "archive frees the warm process" → Task 2 (wiring) + Tasks 1 & 3 (per-transport impl). ✓
- "keep record open / no `closed`" → `freeWarmProcess` uses `terminateAcpxQueueOwner` only; asserted in Task 1/3 tests (`close` not issued). ✓
- "restore unchanged / lossless / repeatable" → no restore code changed; manual smoke step 3.5–3.6 confirms. ✓
- "shared transport guard" → Task 2 `!shared` block + "keeps a shared process running" test. ✓
- "in-flight turn refused" → unchanged guard; existing test retained. ✓
- "idempotent / best-effort" → Task 1/3 "no-op when unresolvable" tests + Task 2 "still archives when freeWarmProcess throws" test. ✓
- "both transports" → Task 1 (cli) + Task 3 (bridge). ✓
- "stale-comment fix" → Task 1 Step 5 (cli) + Task 3 Step 4 (bridge runtime). ✓
- "no acpx issue / no resume path / no delete/TTL change / no UI change" → not in scope; no tasks touch them. ✓

**Placeholder scan:** No TBD/TODO; every code step shows full code. ✓

**Type consistency:** `freeWarmProcess(session: ResolvedSession): Promise<void>` (interface + cli + bridge transport); `BridgeRuntime.freeWarmProcess(input): Promise<Record<string, never>>` mirrors `removeSession`/`deleteSession`; `terminateAcpxQueueOwner(sessionId: string)` matches the existing export; `BridgeMethod` value `"freeWarmProcess"` used consistently across protocol/transport/server. ✓
