# Independent Fix Report — Terminal Feature Fixes

Date: 2026-07-01  
Branch: feat/relay-web-terminal  
Base commit: 341aaf2

---

## Fix 1: terminal store must surface RPC errors

**File changed:** `packages/relay-web/src/stores/terminal.ts`

Added `isErrorPayload` import from `@ganglion/xacpx-relay-protocol` and a local `unwrap<T>` helper mirroring `files.ts`. In `create()`, the raw result from `api.rpc` is now passed through `unwrap` before destructuring `terminalId`. Previously, a connector error payload like `{ error: { code: "internal", message: "terminal-disabled" } }` would be silently destructured (`terminalId` = `undefined`), producing a blank open box in the UI instead of an error. Now `create()` rejects with the error message so callers can handle it properly.

**Evidence:**
- RED (before): `create()` returned `undefined` silently on errorPayload.
- GREEN (after): new test `"create rejects when api.rpc resolves an errorPayload"` in `terminal-store.test.ts` passes.

---

## Fix 2: guard in-flight create() against teardown/supersede race

**File changed:** `packages/relay-web/src/components/TerminalTab.vue`

Added a module-scoped `let epoch = 0`. `teardown()` now increments `epoch` at the top, invalidating any in-flight `start()`. In `start()`:

1. `teardown()` is called first (increments epoch to N).
2. `const myEpoch = epoch` is captured immediately after.
3. `const newId = await terminals.create(...)` stores the result in a local.
4. After the await: if `myEpoch !== epoch` (superseded), `terminals.close(instanceId, newId)` is called and `currentAdapter.dispose()` is called, then we return WITHOUT assigning module state, installing the ResizeObserver, or updating status.
5. Only when still current (`myEpoch === epoch`) does `terminalId = newId`, `status = "open"`, and the ResizeObserver get installed.
6. In the catch branch, a matching `myEpoch !== epoch` guard prevents clobbering the new status.

This eliminates the orphan PTY + ResizeObserver leak when the user switches sessions or unmounts the component while `create()` is still in flight.

**Race approach:** epoch token — cheap, single-integer, immune to async interleaving because both increment (teardown) and read (post-await check) happen in the same microtask boundary relative to each other.

**Evidence:**
- GREEN: new test `"superseded create() is closed and does not leak the terminal"` in `terminal-tab.test.ts` passes; it controls resolution timing via a deferred mock promise and asserts that `terminal-close` is sent for the orphan `terminalId`.

---

## Fix 3: error mapping + generic `terminal.error` key

**Files changed:** `packages/relay-web/src/components/TerminalTab.vue`, `packages/relay-web/src/i18n/messages/en.ts`, `packages/relay-web/src/i18n/messages/zh-CN.ts`

In `TerminalTab.vue` catch block, the final fallback was `"terminal.offline"` for any unrecognized error (including `session-not-found`). Changed to `"terminal.error"` for any unrecognized message. Explicit mappings remain:
- `"terminal-disabled"` → `"terminal.disabled"`
- `"terminal-unsupported-platform"` → `"terminal.unsupported"`
- `"instance-offline"` → `"terminal.offline"`
- anything else (incl. `"session-not-found"`) → `"terminal.error"`

Added `terminal.error` key to both catalogs:
- en: `"Could not open the terminal."`
- zh-CN: `"无法打开终端。"`

**Evidence:**
- GREEN: i18n-parity test (`"zh-CN has exactly the same keys as en"` + `"no value is an empty string in either locale"`) passes with the new key.
- GREEN: new test `"shows terminal.disabled hint when api.rpc RESOLVES an errorPayload"` asserts the correct key renders.
- GREEN: new test `"shows terminal.error for unrecognized error message"` passes.

---

## Fix 4: drop dead `now` dep

**Files changed:** `src/control/terminal-service.ts`, `tests/unit/control/terminal-service.test.ts`

Removed the `now?: () => number` field from `TerminalServiceDeps`. The field was added as a timer seam during a prior fix but was never read anywhere in the implementation. Also removed `now: () => 0` from the `setup()` helper in the test (would have caused an excess property TypeScript error after the interface field was removed).

**Evidence:**
- GREEN: all 10 existing `terminal-service.test.ts` tests pass without change to their logic.
- Both `npx tsc --noEmit` and `npx vue-tsc --noEmit -p packages/relay-web` are clean.

---

## Fix 5: stop overpromising in spec

**File changed:** `docs/superpowers/specs/2026-06-30-relay-web-terminal-design.md`

Two corrections applied:

1. **Lifecycle/safety section (item 4)** — replaced the claim that "browser `/ws` disconnect or session switch immediately closes/kills PTY" and "instance offline disposes all PTYs" with accurate v1 description: the three actual v1 reapers are (a) explicit `terminal-close` on web teardown, (b) the idle timer, and (c) `disposeAll` on daemon shutdown. A browser that reloads/closes without triggering teardown leaves the PTY alive until the idle timeout. Hub→core cleanup on `/ws` drop and connector-link-loss dispose are marked **v2** (alongside reconnect-keepalive).

2. **Error handling section** — replaced "cwd 不存在 → 回退实例默认目录 + notice" with accurate v1 description: no cwd validation or fallback is implemented; a bad cwd causes node-pty spawn to throw, which after Fix 1+Fix 3 surfaces as a `terminal.error` message in the UI. Validation/fallback is explicitly deferred to v2.

3. **Lifecycle step 5** — updated to list the three actual v1 close paths and note that browser-close without teardown leaves PTY alive.

---

## Tests added/changed

### terminal-store.test.ts
- **Added:** `"create rejects when api.rpc resolves an errorPayload (Fix 1 guard)"` — mocks `api.rpc` to RESOLVE (not throw) an `{ error: { code, message } }` payload; asserts `create()` rejects with the message. Guards against regression where the store swallowed connector errors silently.

### terminal-tab.test.ts
- **Changed (premise fix):** the existing error-path tests were removed because they mocked `api.rpc` to THROW (incorrect — `api.rpc` resolves on connector errors, not throws). Replaced with:
  - `"shows terminal.disabled hint when api.rpc RESOLVES an errorPayload"` — mocks a resolved errorPayload with `message: "terminal-disabled"`, asserts `terminal.disabled` key is rendered.
  - `"shows terminal.error for unrecognized error message"` — mocks `session-not-found` errorPayload, asserts `terminal.error` key renders.
  - `"superseded create() is closed and does not leak the terminal"` — deferred mock controls resolution timing; session-prop change fires while first `create()` is pending; after resolving the orphan, asserts `terminal-close` was sent for the orphan's `terminalId`. The supersede race test was **feasible** and is implemented.

---

## RED/GREEN Evidence

```
# Before fixes (baseline):
Terminal store tests: 3 passed
Terminal tab tests:   2 passed
i18n parity:         2 passed
Terminal service:    10 passed

# After fixes:
$ npx vitest run src/__tests__/terminal-store.test.ts src/__tests__/terminal-tab.test.ts src/__tests__/i18n-parity.test.ts
✓ i18n-parity.test.ts (2 tests)
✓ terminal-store.test.ts (4 tests)   ← +1 (Fix 1 errorPayload guard)
✓ terminal-tab.test.ts (5 tests)     ← +3 (errorPayload hint, error key, supersede race)
Test Files: 3 passed | Tests: 11 passed

$ bun test tests/unit/control/terminal-service.test.ts
10 pass, 0 fail                      ← unchanged, now: () => 0 removed cleanly

$ npx tsc --noEmit             → clean (no output)
$ npx vue-tsc --noEmit -p packages/relay-web → clean (no output)
```

---

## Concerns

None. All fixes are contained, all tests pass, both typechecks are clean. The supersede-race test was feasible using a deferred mock pattern with `setTimeout(r, 0)` microtask drains.
