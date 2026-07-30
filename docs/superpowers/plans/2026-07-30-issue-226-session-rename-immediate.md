# Issue #226 Session Rename Immediate Update — Implementation Plan

> **For agentic workers:** execute the plan task-by-task. Keep the two production
> changes in separate commits so the Hub ordering fix and Web optimistic-state
> hardening can be reviewed and reverted independently.

**Goal:** When a Relay Web user renames a session during an active agent turn,
show the new name immediately and persist it without waiting for the turn to
finish, while preserving lifecycle ordering, trusted chat scoping, error
visibility, and cross-dashboard convergence.

**Architecture:** Split cosmetic metadata from lifecycle serialization at the
Hub boundary: `control.sessions.rename` remains chat-scoped but no longer takes
the same keyed lock as prompt/create/remove/archive/unarchive. In Relay Web,
apply the display name before the RPC resolves and keep a per-session pending
overlay across `sessions-changed` reloads. Serialize only Web rename mutations
for the same session so consecutive attempts have deterministic confirmation
and rollback semantics.

**Tech Stack:** TypeScript, Hono Relay Hub, Vue 3 + Pinia Relay Web, Bun tests
for Hub code, Vitest/jsdom for Relay Web.

**Research:** `docs/superpowers/specs/2026-07-30-issue-226-session-rename-latency-research.md`

## Global Constraints

- `MSG.sessionsRename` stays in `CHAT_SCOPED_TYPES`; the Hub must continue to
  overwrite client-supplied `chatKey`, `senderId`, and `isOwner`.
- Only cosmetic rename bypasses the keyed RPC lock. Prompt,
  command-execute, create, remove, archive, and unarchive retain their current
  same-session ordering.
- Wire protocol, RPC names/payloads, Core persistence, `alias`,
  `transportSession`, and `/use` semantics do not change.
- Preserve #212 behavior: connector errors are unwrapped, the existing error
  toast remains visible, and successful persistence emits
  `sessions-changed`.
- A stale failure must never overwrite a newer rename. A server refresh must
  not overwrite the latest rename while its RPC is pending.
- Relay Web tests run with Vitest, not `bun test`. Smoke tests are out of scope
  because they require real acpx and WeChat infrastructure.
- Preserve the unrelated untracked
  `docs/superpowers/specs/2026-07-27-relay-web-message-fork-design.md`.

## File Structure

- **Modify** `packages/relay/src/http/app.ts` — remove rename from the
  lifecycle-lock classifier while retaining chat scoping.
- **Modify** `tests/unit/packages/relay/http-app.test.ts` — prove rename
  bypasses a pending prompt and lifecycle mutations still wait.
- **Modify** `packages/relay-web/src/stores/instances.ts` — immediate local
  update, per-session rename queue, pending overlay during session reloads,
  confirmed-value rollback.
- **Modify** `packages/relay-web/src/__tests__/instances-rename.test.ts` —
  deferred-RPC, reload-overlay, and consecutive-rename coverage.
- **Modify** `packages/relay-web/src/__tests__/instancetree-rename.test.ts` —
  assert the visible row changes before the RPC resolves.
- **Modify** `docs/relay-web-module.md` — document immediate optimistic rename,
  pending reconciliation, and the Hub lock exception.

---

## Task 1: Let cosmetic rename bypass the Hub lifecycle lock

**Files:**

- Modify: `packages/relay/src/http/app.ts`
- Test: `tests/unit/packages/relay/http-app.test.ts`

**Contract:**

- `control.prompt` for `(instance, alias)` may remain pending.
- A later `control.sessions.rename` for the same key reaches
  `gateway.sendRequest` and returns without waiting for that prompt.
- A later lifecycle operation such as `control.sessions.remove` still waits
  for the prompt, proving the lock was narrowed rather than disabled.
- Rename still receives the server-stamped `chatKey`.

- [ ] **Step 1: Add a controllable gateway seam to the test helper**

Extend `makeApp(opts)` in `http-app.test.ts` with an optional
`sendRequest` function. Keep `rpcCalls` recording in the helper wrapper so
existing tests retain the same observations:

```ts
async function makeApp(opts: {
  trustProxy?: boolean;
  now?: () => Date;
  sendRequest?: (instanceId: string, type: string, payload: unknown) => Promise<unknown>;
} = {}) {
  // ...
  const gateway = {
    isOnline: (id: string) => id !== "offline-id",
    sendRequest: async (instanceId: string, type: string, payload: unknown) => {
      rpcCalls.push({ instanceId, type, payload });
      return await (opts.sendRequest?.(instanceId, type, payload)
        ?? Promise.resolve({ sessions: [] }));
    },
  };
  // ...
}
```

Add a small local `deferred<T>()` helper returning
`{ promise, resolve, reject }`; do not use real sleeps.

- [ ] **Step 2: Write the failing concurrency regression test**

Add a test that:

1. Logs in and redeems an instance as existing HTTP tests do.
2. Starts a `MSG.prompt` request for alias `backend`.
3. Holds only that gateway call on a deferred Promise and waits for a
   `promptStarted` signal.
4. Starts `MSG.sessionsRename` for the same alias.
5. Races a `renameForwarded` deferred (resolved by the fake gateway) against a
   short bounded test sentinel and expects `renameForwarded` to win. This keeps
   the current buggy implementation red without leaving the test hung on a
   never-resolving Promise.
6. Awaits the rename HTTP response and asserts status 200 plus stamped
   `chatKey`.
7. Releases and awaits the prompt request so the test leaves no pending work.

The test must fail on the current code because rename waits inside
`acquireSessionRpcLock`.

- [ ] **Step 3: Add the lifecycle-lock counterexample**

Using the same deferred-prompt shape, start `MSG.sessionsRemove` for the same
alias. Assert its gateway signal has not fired while the prompt is pending;
after releasing the prompt, assert remove is forwarded and completes.

Use a deterministic observation seam (recorded call/signal driven by the fake
gateway), not a long wall-clock timeout. A single event-loop yield is allowed
only to let Hono begin processing the second request.

- [ ] **Step 4: Run the new tests and confirm the intended red state**

Run:

```bash
bun test tests/unit/packages/relay/http-app.test.ts
```

Expected before the fix:

- rename-bypasses-prompt test fails because `renameForwarded` is not reached;
- lifecycle counterexample and existing chatKey stamping tests remain valid.

- [ ] **Step 5: Narrow `rpcSessionAlias()`**

In `packages/relay/src/http/app.ts`, remove only:

```ts
type === MSG.sessionsRename
```

from the alias-returning lifecycle branch. Leave
`MSG.sessionsRename` in `CHAT_SCOPED_TYPES`.

Add a short comment near `rpcSessionAlias()` explaining that the function
classifies RPCs needing lifecycle ordering, not every RPC that carries a
session alias; cosmetic metadata writes intentionally bypass it.

- [ ] **Step 6: Verify Hub behavior**

Run:

```bash
bun test tests/unit/packages/relay/http-app.test.ts
bun test tests/unit/packages/relay/gateway.test.ts tests/unit/packages/relay/integration.test.ts
```

Expected: all pass; the new rename test completes before prompt release, while
the remove counterexample remains blocked until release.

- [ ] **Step 7: Commit**

```bash
git add packages/relay/src/http/app.ts tests/unit/packages/relay/http-app.test.ts
git commit -m "fix(relay): let session rename bypass turn lifecycle lock"
```

---

## Task 2: Make Relay Web rename genuinely optimistic and race-safe

**Files:**

- Modify: `packages/relay-web/src/stores/instances.ts`
- Test: `packages/relay-web/src/__tests__/instances-rename.test.ts`
- Test: `packages/relay-web/src/__tests__/instancetree-rename.test.ts`

**Store invariants:**

1. Calling `renameSession` mutates the visible row synchronously before its RPC
   settles.
2. `loadSessions` overlays the newest pending display name onto an
   authoritative list response.
3. Same-session rename RPCs execute FIFO even if users submit again quickly.
4. Each success advances the last confirmed value.
5. The latest failure rolls back to the last confirmed value; a stale
   success/failure never replaces a newer optimistic value.
6. Different instance/session keys remain independent.

- [ ] **Step 1: Add deferred-RPC tests for immediate update**

Replace the misleading current “optimistically sets” test with a Promise that
does not resolve immediately:

1. Seed `displayName: "old"`.
2. Call `store.renameSession(..., "New label")` without awaiting it.
3. Immediately assert the row is `"New label"` and the correct RPC was sent.
4. Resolve the RPC and await the returned Promise.

Keep the existing whitespace trim and empty-clears assertions.

- [ ] **Step 2: Add pending-overlay and rollback tests**

Add store tests for:

- `loadSessions()` returns server value `"old"` while rename is pending; the
  visible row remains `"New label"`.
- A single RPC error rejects and restores `"old"`.
- `unknown-type` still produces the connector-upgrade hint and restores the
  previous label.

Seed a non-empty `agents` list, or route the mock by RPC type, so
`loadSessions`' optional agent prefetch cannot make call-order assertions
fragile.

- [ ] **Step 3: Add consecutive-rename tests**

Use two deferred RPC results for the same key:

- Submit A, then submit B before A resolves. The row must immediately show B,
  while only A has reached `api.rpc`.
- A succeeds, then B is sent and fails: the row rolls back to confirmed A.
- A fails, then B succeeds: A's failure never removes optimistic B, and the
  final row is B.

Also add a small independence test showing a pending rename for
`i1/backend` does not delay `i1/frontend` (or `i2/backend`).

- [ ] **Step 4: Add the component-level visible regression**

In `instancetree-rename.test.ts`, use the real store method with a deferred
`api.rpc` instead of spying `renameSession` to immediate resolution:

1. Open Rename, set the input, press Enter.
2. Await Vue DOM flushing only—not the RPC.
3. Assert the input is gone and `[data-test="session-name"]` contains the new
   value while the RPC is still unresolved.
4. Resolve the RPC and cleanly await pending promises.

Keep the existing Escape and Enter+blur double-commit tests.

- [ ] **Step 5: Run tests and confirm the intended red state**

Run:

```bash
bun run --cwd packages/relay-web test -- \
  src/__tests__/instances-rename.test.ts \
  src/__tests__/instancetree-rename.test.ts
```

Expected before the store fix: immediate-update and pending-overlay cases fail.

- [ ] **Step 6: Implement per-session pending state**

Inside `useInstancesStore`, add private store-local state keyed by a collision-
safe value such as `JSON.stringify([instanceId, alias])`:

```ts
interface PendingSessionRename {
  latestRevision: number;
  desiredDisplayName?: string;
  confirmedDisplayName?: string;
}

const pendingSessionRenames = new Map<string, PendingSessionRename>();
const sessionRenameTails = new Map<string, Promise<void>>();
let sessionRenameRevision = 0;
```

Do not expose these as protocol DTO fields or persist them to local storage.

- [ ] **Step 7: Overlay pending names in `loadSessions()`**

Before assigning the server array to `inst.sessions`, map each row. When a
pending entry exists, first copy the server row's `displayName` into
`pending.confirmedDisplayName`, then overlay the local desired value:

```ts
const pending = pendingSessionRenames.get(renameKey(instanceId, session.alias));
if (!pending) return session;
pending.confirmedDisplayName = session.displayName;
return { ...session, displayName: pending.desiredDisplayName };
```

Use the overlaid rows for display only. Tail-cache reconciliation must continue
to use alias and `transportSession`; rename state must not affect incarnation
logic. Updating `confirmedDisplayName` is important: if another dashboard
changes the name while this client has a pending rename that later fails,
rollback must use the newest server value rather than the value captured before
the request began.

- [ ] **Step 8: Implement immediate update plus FIFO mutation handling**

Refactor `renameSession` so its synchronous prefix:

1. trims the requested name and converts empty to `undefined`;
2. finds the current row;
3. creates or updates the pending state, preserving its confirmed value across
   consecutive attempts;
4. increments `latestRevision`;
5. immediately updates the live row;
6. chains the RPC behind the previous same-key rename tail.

When one queued operation runs:

- on success, update the pending state's confirmed value to that operation's
  value; clear pending state only if it is still the latest revision;
- on failure, if it is the latest revision, clear pending state and restore the
  last confirmed value on the current live row; if a newer revision exists,
  leave its optimistic value untouched;
- always rethrow the operation's error so `InstanceTree` keeps showing the
  existing error toast;
- clean `sessionRenameTails` only if the completing Promise is still the map's
  current tail;
- use both fulfillment and rejection cleanup handlers so cleanup itself does
  not create an unhandled rejected Promise.

Same-key FIFO is a Web consistency mechanism only; it must not reintroduce
prompt/rename coupling. Different keys get different tails.

- [ ] **Step 9: Verify focused Web tests**

Run:

```bash
bun run --cwd packages/relay-web test -- \
  src/__tests__/instances-rename.test.ts \
  src/__tests__/instancetree-rename.test.ts \
  src/__tests__/chatpane-displayname.test.ts \
  src/__tests__/commandpalette.test.ts
```

Expected: all pass, including deferred update, overlay, rollback, and
consecutive rename cases.

- [ ] **Step 10: Commit**

```bash
git add \
  packages/relay-web/src/stores/instances.ts \
  packages/relay-web/src/__tests__/instances-rename.test.ts \
  packages/relay-web/src/__tests__/instancetree-rename.test.ts
git commit -m "fix(relay-web): update session names optimistically"
```

---

## Task 3: Update documentation and run cross-layer validation

**Files:**

- Modify: `docs/relay-web-module.md`

- [ ] **Step 1: Update the rename behavior documentation**

In `docs/relay-web-module.md`'s session rename section, document:

- the row changes immediately on Enter;
- pending names survive `sessions-changed` list reloads;
- same-session Web rename attempts reconcile FIFO with confirmed-value
  rollback;
- rename remains chat-scoped but intentionally bypasses the Hub lifecycle lock
  because it does not change session identity.

Do not describe alias/transport rename; those remain out of scope.

- [ ] **Step 2: Run formatting and static checks**

Run:

```bash
git diff --check
npx tsc --noEmit
bun run --cwd packages/relay-web build
```

Expected: no whitespace errors, TypeScript errors, or Vue build errors.

- [ ] **Step 3: Run focused cross-layer tests**

Run:

```bash
bun test \
  tests/unit/packages/relay/http-app.test.ts \
  tests/unit/packages/relay/gateway.test.ts \
  tests/unit/packages/relay/integration.test.ts \
  tests/unit/packages/channel-relay/control-bridge.test.ts \
  tests/unit/control/control-service-display-name.test.ts

bun run --cwd packages/relay-web test -- \
  src/__tests__/instances-rename.test.ts \
  src/__tests__/instancetree-rename.test.ts \
  src/__tests__/chatpane-displayname.test.ts \
  src/__tests__/commandpalette.test.ts
```

Expected: all pass.

- [ ] **Step 4: Run the repository unit suite**

Run:

```bash
npm test
```

Expected: typecheck and all `tests/unit/**/*.test.ts` pass. Do not run
`npm run test:smoke`.

- [ ] **Step 5: Manual acceptance in Relay Web**

With a locally built Relay stack:

1. Start a turn that runs long enough to keep the working indicator visible.
2. Rename that same session and press Enter.
3. Confirm the sidebar and ChatPane header change immediately.
4. Confirm the turn continues uninterrupted.
5. Refresh before the turn finishes and confirm the persisted new name remains.
6. Open a second dashboard and confirm it receives the name via
   `sessions-changed`.
7. Rename twice quickly; confirm the last successful value wins.
8. Simulate connector failure/offline and confirm the name rolls back with an
   error toast.

- [ ] **Step 6: Commit documentation**

```bash
git add docs/relay-web-module.md
git commit -m "docs(relay-web): document immediate session rename semantics"
```

## Done When

- Rename is forwarded and persisted while an agent turn for the same session is
  still active.
- The new label appears immediately on Enter without waiting for network
  completion.
- Refresh/list reconciliation cannot replace a pending optimistic label with
  stale server data.
- Consecutive rename success/failure order is deterministic.
- `CHAT_SCOPED_TYPES`, error unwrap/toast, `sessions-changed`, and lifecycle
  locking remain intact.
- Focused tests, `npx tsc --noEmit`, Relay Web build, and `npm test` pass.
