# Relay Token-Based Auth Simplification — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the relay hub's username/password + invite + role auth with a CLI-minted, permanent, revocable **login token** model (paste token → cookie session), keeping per-account scope and connector pairing tokens.

**Architecture:** SQLite-backed hub (`packages/relay`). Accounts lose password/role; a new `login_tokens` table holds per-account bearer tokens (hashed); `web_sessions` links to the minting token for precise revocation. HTTP `/api/login` takes `{token}`; register/invites removed. CLI gains `user new/token/ls/rm` + `token revoke` + `pair` (renamed from `token new`). Frontend login becomes a single token field.

**Tech Stack:** TypeScript, Hono + `@hono/node-server`, `bun:sqlite`/`node:sqlite`, Vue 3 + Pinia + Vitest, bun test.

**Spec:** `docs/superpowers/specs/2026-06-18-relay-token-auth-simplification-spec.md` (read it; it has the full rationale, security notes, and resolved decisions).

**Global constraints (every task):**
- Reply/commit messages: English for code/commits. Never edit `CLAUDE.md` (symlink to `AGENTS.md`).
- Git hygiene: branch off `main` first (`feat/relay-token-auth`); never `git add -A`/`.`; never stage `bun.lock`/`dist`/`node_modules`; do not push/PR/rebase unless asked.
- Tests: run per-file or via `node scripts/run-tests.mjs tests/unit/packages/relay` (dir). NEVER whole-dir `bun test` on a directory in one process (state-leak false failures). Frontend: `npx vitest run <file>` from `packages/relay-web`.
- `relay-protocol` is built via tsc; not touched here.
- `CLAUDE_CODE_TMPDIR=/Users/maijiazhen/Projects/weacpx-github/.tmp` is set to avoid the tmp-full ENOSPC on background commands.

**File structure / responsibilities:**
- `packages/relay/src/db.ts` — schema + idempotent migration (transaction-wrapped).
- `packages/relay/src/auth.ts` — drop password helpers; keep token/hash helpers.
- `packages/relay/src/stores/accounts.ts` — account + login-token + session + cascade store.
- `packages/relay/src/http/app.ts` — token login, removed routes, IP rate limit.
- `packages/relay/src/http/client-ip.ts` (NEW) — client-IP resolution (trust-proxy aware).
- `packages/relay/src/server.ts` — pass `trustProxy` + conn-info to `createApp`; CLI `start` flag.
- `packages/relay/src/cli.ts` — user/token/pair command surface.
- `packages/relay/src/maintenance.ts` — comment only (logic via store).
- `packages/relay-web/src/stores/auth.ts`, `views/LoginView.vue`, `views/SettingsView.vue` — token login UI.
- Docs: `docs/relay-deployment.md`, `docs/relay-module.md`.

---

### Task 1: DB schema + transaction-wrapped migration

**Files:**
- Modify: `packages/relay/src/db.ts` (`initSchema`)
- Test: `tests/unit/packages/relay/db.test.ts`

**Design (from spec §5):** FK enforcement is OFF (never set; both drivers default OFF) — the migration depends on this and must not enable it. Wrap the whole migration in one transaction. `ADD COLUMN` must be a **plain** column (SQLite forbids `ADD COLUMN … REFERENCES`). Order: create `login_tokens` → add `web_sessions.login_token_id` → drop `invites` → rebuild `accounts`.

- [ ] **Step 1: Write failing tests** in `db.test.ts`:
  - Fresh DB: `accounts` columns are exactly `id, username, created_at` (no `password_hash`/`role`); `login_tokens` exists; `web_sessions` has `login_token_id`; `invites` is **absent** (invert any existing assertion expecting it).
  - Migration: seed a legacy DB by exec'ing the OLD schema (accounts with `password_hash`+`role`, an `invites` row, a `web_sessions` row, an `instances` row, a `messages` row), then run `initSchema`, then assert:
    (a) `accounts` lost `password_hash`/`role`, account ids preserved; (b) `login_tokens` + `idx_web_sessions_login_token` exist; (c) `web_sessions.login_token_id` column exists and the legacy row's value `IS NULL`; (d) `invites` gone; (e) the `instances`/`web_sessions`/`messages` rows still reference the same `account_id`/ids (no orphan).
  - Idempotency: run `initSchema` **3×** on the migrated DB → no error, no duplicate-column/table-exists, schema stable.
- [ ] **Step 2: Run → fail.** `bun test tests/unit/packages/relay/db.test.ts` (expect failures / not-yet-migrated).
- [ ] **Step 3: Implement** `initSchema`:
  - Fresh `CREATE TABLE IF NOT EXISTS` blocks for the new `accounts` (no password/role), `login_tokens(id PK, token_hash UNIQUE, account_id, label, created_at, last_used_at)`, `web_sessions(token_hash PK, account_id, login_token_id, expires_at)` with `REFERENCES login_tokens(id)` **only here**, `idx_web_sessions_login_token`, plus unchanged `pairing_tokens/instances/messages` and the existing `messages.structured` ALTER guard. Do **not** create `invites`.
  - Migration (guarded, transaction-wrapped):
    ```ts
    const cols = (t: string) => db.all<{ name: string }>(`PRAGMA table_info(${t})`).map((c) => c.name);
    const tableExists = (t: string) =>
      !!db.get(`SELECT name FROM sqlite_master WHERE type='table' AND name=?`, [t]);
    db.exec("BEGIN");
    try {
      // 1) login_tokens + index already ensured by CREATE IF NOT EXISTS above.
      // 2) add plain nullable login_token_id (NO references) if missing
      if (tableExists("web_sessions") && !cols("web_sessions").includes("login_token_id")) {
        db.exec("ALTER TABLE web_sessions ADD COLUMN login_token_id TEXT");
      }
      // 3) drop invites BEFORE the accounts rebuild
      db.exec("DROP TABLE IF EXISTS invites");
      // 4) rebuild accounts to drop password_hash + role (guard tolerant of half-migrated)
      const accountsCols = tableExists("accounts") ? cols("accounts") : [];
      const needsRebuild = accountsCols.includes("password_hash") || accountsCols.includes("role");
      const halfRenamed = tableExists("accounts_new") && !tableExists("accounts");
      if (needsRebuild || halfRenamed) {
        if (!halfRenamed) {
          db.exec("CREATE TABLE accounts_new (id TEXT PRIMARY KEY, username TEXT NOT NULL UNIQUE, created_at TEXT NOT NULL)");
          db.exec("INSERT INTO accounts_new (id, username, created_at) SELECT id, username, created_at FROM accounts");
          db.exec("DROP TABLE accounts");
        }
        db.exec("ALTER TABLE accounts_new RENAME TO accounts");
      }
      db.exec("COMMIT");
    } catch (e) {
      db.exec("ROLLBACK");
      throw e;
    }
    ```
    (Note: the fresh `CREATE TABLE IF NOT EXISTS accounts` must run BEFORE this block; on a legacy DB it's a no-op because `accounts` already exists, so the rebuild handles the drop.)
- [ ] **Step 4: Run → pass.** `bun test tests/unit/packages/relay/db.test.ts`.
- [ ] **Step 5: Commit.** `git add packages/relay/src/db.ts tests/unit/packages/relay/db.test.ts && git commit -m "feat(relay): token-auth schema + migration (drop password/role/invites, add login_tokens)"`

---

### Task 2: auth.ts — drop password helpers

**Files:**
- Modify: `packages/relay/src/auth.ts`
- Test: `tests/unit/packages/relay/auth.test.ts`

- [ ] **Step 1:** Update `auth.test.ts` to remove `hashPassword`/`verifyPassword` cases; keep `generateToken`/`hashToken`/`hashEquals` cases.
- [ ] **Step 2:** Run → fail (still imports removed-to-be funcs or asserts them).
- [ ] **Step 3:** Delete `hashPassword` + `verifyPassword` (and the scrypt imports/constants they alone use: `scryptSync`, `SCRYPT_*`, `KEY_LENGTH`). Keep `generateToken`, `hashToken`, `hashEquals` and their imports (`createHash`, `randomBytes`, `timingSafeEqual`).
- [ ] **Step 4:** Run → pass. Also `npx tsc -p packages/relay/tsconfig.json --noEmit` to confirm nothing else imports the removed funcs (accounts.ts will be fixed in Task 3 — expect those errors until then; note them, don't block).
- [ ] **Step 5: Commit.** `git add packages/relay/src/auth.ts tests/unit/packages/relay/auth.test.ts && git commit -m "refactor(relay): drop scrypt password helpers (token auth only)"`

---

### Task 3: AccountStore — accounts + login tokens + sessions + cascade

**Files:**
- Modify: `packages/relay/src/stores/accounts.ts`
- Test: `tests/unit/packages/relay/stores-accounts.test.ts`

**New API (spec §5.3):**
```ts
export interface AccountRow { id: string; username: string; createdAt: string }           // no role
createAccount(username: string): AccountRow                                                // no password/role
findByUsername(username): AccountRow | null
findById(id): AccountRow | null
listAccounts(): Array<AccountRow & { tokenCount: number; instanceCount: number }>
countInstances(accountId): number
createLoginToken(accountId: string, label?: string): { id: string; token: string }         // raw token once
findAccountByLoginToken(token: string): AccountRow | null                                   // bumps last_used_at
listLoginTokens(accountId): Array<{ id: string; label: string | null; createdAt: string; lastUsedAt: string | null }>
revokeLoginToken(tokenId: string): boolean                                                  // delete token + its web_sessions
createWebSession(accountId: string, loginTokenId: string, ttlMs: number): string           // now takes loginTokenId
getSessionAccount(token): AccountRow | null
deleteWebSession(token): void
deleteAccountCascade(accountId: string): void                                              // txn; by account_id
pruneExpired(now: Date): number                                                            // web_sessions only
```
Remove: `verifyLogin`, `createInvite`, `validateInvite`, `markInviteUsed`, `AccountRole`, the `role` param/field everywhere.

- [ ] **Step 1: Write failing tests** in `stores-accounts.test.ts` (rewrite): `createAccount(username)` shape; `createLoginToken` returns raw token + stores hash; `findAccountByLoginToken` resolves + bumps `last_used_at` (assert it changes) + returns null on bad token; `revokeLoginToken` deletes the token AND its linked `web_sessions` but **leaves a NULL-`login_token_id` (legacy) session for the same account intact**; `createWebSession(accountId, loginTokenId, ttl)` + `getSessionAccount`; `listAccounts` counts tokens+instances; `deleteAccountCascade` removes login_tokens/web_sessions/pairing_tokens/instances/messages/account; `pruneExpired` removes only expired web_sessions (no invite logic). Use an injected `now` for deterministic `last_used_at`/expiry.
- [ ] **Step 2: Run → fail.**
- [ ] **Step 3: Implement.** Rewrite `accounts.ts`:
  - `createAccount`: `INSERT INTO accounts (id, username, created_at) VALUES (?,?,?)`.
  - `createLoginToken`: `id=randomUUID()`, `token=generateToken()`, `INSERT INTO login_tokens (id, token_hash, account_id, label, created_at, last_used_at) VALUES (?,?,?,?,?,NULL)`; return `{id, token}`.
  - `findAccountByLoginToken`: `SELECT account_id, id FROM login_tokens WHERE token_hash=?`; if found, `UPDATE login_tokens SET last_used_at=? WHERE id=?` then `findById(account_id)`.
  - `revokeLoginToken`: `DELETE FROM web_sessions WHERE login_token_id=?`; `DELETE FROM login_tokens WHERE id=?`; return rows-affected>0 (check via a prior existence `get`).
  - `createWebSession`: add `login_token_id` column to the INSERT.
  - `deleteAccountCascade`: `BEGIN` → delete `messages` for the account's instances (`DELETE FROM messages WHERE instance_id IN (SELECT id FROM instances WHERE account_id=?)`) → `DELETE FROM instances WHERE account_id=?` → `pairing_tokens` → `web_sessions` → `login_tokens` → `accounts` → `COMMIT` (ROLLBACK on throw).
  - `listAccounts`: join/subselect counts.
  - `pruneExpired`: drop the invites branch; keep `web_sessions` GC; return count.
- [ ] **Step 4: Run → pass.** `bun test tests/unit/packages/relay/stores-accounts.test.ts`.
- [ ] **Step 5: Commit.** `git add packages/relay/src/stores/accounts.ts tests/unit/packages/relay/stores-accounts.test.ts && git commit -m "feat(relay): AccountStore login-token + cascade-delete API (drop password/invite/role)"`

---

### Task 4: HTTP — token login, removed routes, IP rate limit

**Files:**
- Create: `packages/relay/src/http/client-ip.ts`
- Modify: `packages/relay/src/http/app.ts`
- Test: `tests/unit/packages/relay/http-app.test.ts`

**Design (spec §6):** `/api/login {token}` → `findAccountByLoginToken` → `createWebSession(account.id, loginTokenId, ttl)` → cookie → `{username}`. Remove `/api/register`, `/api/invites`, `inviteTtlMs`. Auth gate exempts only `/api/login`. Rate limit per resolved client IP + a global ceiling; XFF trusted only when `trustProxy` dep is true.

- [ ] **Step 1: Write failing tests** in `http-app.test.ts`:
  - Rewrite `makeApp()` helper: `createAccount("admin")` (1-arg) + `const {token} = accounts.createLoginToken(acc.id)`; pass that token where tests previously used password.
  - `/api/login` with `{token}` → 200 `{username}` + sets cookie; bad token → 401 `{error:"invalid-token"}`.
  - `/api/register` and `/api/invites` → route gone (404).
  - `/api/me` → `{username}` (no role).
  - Rate limit: N failed logins from the same resolved IP → 429; with `trustProxy=false`, a forged `x-forwarded-for` does NOT create distinct buckets (socket addr used); global ceiling trips after the cross-key threshold.
  - `findAccountByLoginToken` must return loginTokenId too — adjust store method to also return the token id for session linkage (extend return to `{ account, loginTokenId }` or add a sibling method `resolveLoginToken(token): { account, loginTokenId } | null`). Pick `resolveLoginToken` to keep `findAccountByLoginToken` simple; update Task 3 if needed (note cross-task dependency: prefer adding `resolveLoginToken` in Task 3).
- [ ] **Step 2: Run → fail.**
- [ ] **Step 3: Implement.**
  - `client-ip.ts`: `export function clientIp(c, trustProxy: boolean): string` — if `trustProxy`, first `x-forwarded-for` hop (trimmed); else use `@hono/node-server/conninfo` `getConnInfo(c).remote.address ?? "unknown"`.
  - `app.ts`: add `trustProxy?: boolean` to `AppDeps`. `/api/login`: read `{token}`, rate-limit by `clientIp(...)` key + maintain a global failure counter (reuse `loginFailures` machinery; add a separate `globalFailures` window counter checked before per-key). On success `const r = deps.accounts.resolveLoginToken(token); if (!r) → 401; createWebSession(r.account.id, r.loginTokenId, sessionTtlMs)`. Return `{username}`. Delete `/api/register` + `/api/invites` routes and the `inviteTtlMs` dep/default. Auth gate: exempt only `/api/login`. `/api/me` → `{username}`.
- [ ] **Step 4: Run → pass.** `bun test tests/unit/packages/relay/http-app.test.ts`.
- [ ] **Step 5: Commit.** `git add packages/relay/src/http/app.ts packages/relay/src/http/client-ip.ts tests/unit/packages/relay/http-app.test.ts && git commit -m "feat(relay): token login endpoint + per-IP/global rate limit; remove register/invites"`

---

### Task 5: server.ts wiring + CLI start `--trust-proxy`

**Files:**
- Modify: `packages/relay/src/server.ts`, `packages/relay/src/cli.ts` (`start` only)
- Test: extend `tests/unit/packages/relay/http-app.test.ts` or `integration.test.ts` for the wiring; `cli.test.ts` for the flag parse.

- [ ] **Step 1:** Test that `start --trust-proxy` sets `trustProxy:true` on the app deps (assert via a small integration check or a unit on the option parse). Confirm `createApp` receives `trustProxy`.
- [ ] **Step 2:** Run → fail.
- [ ] **Step 3:** `server.ts`: thread a `trustProxy` option from `startRelayServer` into `createApp({ ..., trustProxy })`. `cli.ts` `start`: parse `--trust-proxy` (boolean presence) and pass it. Update the `USAGE` string.
- [ ] **Step 4:** Run → pass.
- [ ] **Step 5: Commit.** `git add packages/relay/src/server.ts packages/relay/src/cli.ts tests/unit/packages/relay/*.test.ts && git commit -m "feat(relay): --trust-proxy plumbing for login rate limit"`

---

### Task 6: CLI user/token/pair commands

**Files:**
- Modify: `packages/relay/src/cli.ts`
- Test: `tests/unit/packages/relay/cli.test.ts`

**Surface (spec §7):** `user new --account <label>` (prints first login token), `user token --account <label> [--label <l>]` (additional token), `user ls`, `user rm --account <label> [--force]`, `token revoke --id <id>`, `pair --account <label> [--name <l>] [--ttl-minutes 10]`. Remove `init-admin` and `token new`.

- [ ] **Step 1: Write failing tests** in `cli.test.ts`: `user new` creates account + prints a token line; duplicate name fails; `user token` adds one; `user ls` lists with counts; `user rm` with instances present and no `--force` → non-zero + lists instances + account survives; `user rm --force` → account + children gone (assert via store); `token revoke --id` removes token + sessions; `pair` prints a pairing token + install command; `init-admin`/`token new` → USAGE/unknown (removed).
- [ ] **Step 2: Run → fail.**
- [ ] **Step 3: Implement** the new command dispatch using the existing `flag()` parser and `createRelayRuntime`. For `user rm`: `const n = runtime.accounts.countInstances(acc.id); if (n>0 && !hasFlag("--force")) { print list; return 1 } else { runtime.accounts.deleteAccountCascade(acc.id) }`. Add a `hasFlag` helper (presence-only). Update `USAGE`.
- [ ] **Step 4: Run → pass.** `bun test tests/unit/packages/relay/cli.test.ts`.
- [ ] **Step 5: Commit.** `git add packages/relay/src/cli.ts tests/unit/packages/relay/cli.test.ts && git commit -m "feat(relay): user/token/pair CLI (replace init-admin + token new)"`

---

### Task 7: Fix remaining backend tests + maintenance comment

**Files:**
- Modify: `packages/relay/src/maintenance.ts` (comment only), and any still-broken tests: `maintenance.test.ts`, `integration.test.ts`, `web-dashboard-e2e.test.ts`, `web-ws-integration.test.ts`, `runtime-fanout.test.ts`, plus `http/` + `stores/` subdir tests.

- [ ] **Step 1: Grep authoritative breakage.** From repo root: `grep -rn "createAccount(\|verifyLogin\|/api/register\|/api/invites\|createInvite\|role\|init-admin\|token new\|login(\"" tests/unit/packages/relay`. List every hit.
- [ ] **Step 2: Run the relay dir** `node scripts/run-tests.mjs tests/unit/packages/relay` → see which files fail.
- [ ] **Step 3: Fix each** failing test's bootstrap to the new API (1-arg `createAccount`, mint token, token login). `maintenance.test.ts`: drop invite assertions. Update `maintenance.ts`'s doc comment ("GC expired sessions/invites/pairing tokens" → drop "invites").
- [ ] **Step 4: Run → all relay backend tests pass** (per-file for any flaky-by-state file).
- [ ] **Step 5: Commit.** `git add packages/relay/src/maintenance.ts tests/unit/packages/relay && git commit -m "test(relay): migrate remaining suites to token auth"`

---

### Task 8: Frontend — token login + settings cleanup

**Files:**
- Modify: `packages/relay-web/src/stores/auth.ts`, `views/LoginView.vue`, `views/SettingsView.vue`
- Test: `packages/relay-web/src/__tests__/auth.test.ts`, `settings.test.ts`

- [ ] **Step 1: Write failing tests.** `auth.test.ts`: `login(token)` single-arg → posts `{token}`; account `toEqual({username})`; 401 leaves null. `settings.test.ts`: invite section gone (no `gen-invite`/`invite-section`); pairing + logout + retention still work; remove the `role` fixtures.
- [ ] **Step 2: Run → fail.** `npx vitest run src/__tests__/auth.test.ts src/__tests__/settings.test.ts` from `packages/relay-web`.
- [ ] **Step 3: Implement.** `auth.ts`: `Account {username}`; `login(token: string)` posts `{token}`. `LoginView.vue`: single token input (type=password, placeholder "Access token", paste-friendly) → `auth.login(token)`; update copy. `SettingsView.vue`: delete the invite `<section>` + `genInvite`/`invite` refs + the `role==='admin'` gate.
- [ ] **Step 4: Run → pass**, then `npx vue-tsc --noEmit` from `packages/relay-web`.
- [ ] **Step 5: Commit.** `git add packages/relay-web/src/stores/auth.ts packages/relay-web/src/views/LoginView.vue packages/relay-web/src/views/SettingsView.vue packages/relay-web/src/__tests__/auth.test.ts packages/relay-web/src/__tests__/settings.test.ts && git commit -m "feat(relay-web): token login + remove invite UI/role"`

---

### Task 9: Docs

**Files:**
- Modify: `docs/relay-deployment.md`, `docs/relay-module.md`

- [ ] **Step 1:** `relay-deployment.md`: replace `init-admin`/password + invite onboarding with `user new` → paste token; add the migration manual step (`user token` for existing accounts), `--trust-proxy`/per-IP note, `user rm --force`, and the `DELETE FROM web_sessions` global-logout lever.
- [ ] **Step 2:** `relay-module.md`: update auth/accounts section (token model, `login_tokens`, revocation, CLI surface) AND the CSRF-backstop/route list + `pruneExpired` description that mention `/api/invites`.
- [ ] **Step 3: Commit.** `git add docs/relay-deployment.md docs/relay-module.md && git commit -m "docs(relay): token-auth onboarding, migration, CLI surface"`

---

### Task 10: Full verification + sandbox redeploy

**Files:** none (build/run only)

- [ ] **Step 1:** `npx tsc -p packages/relay/tsconfig.json --noEmit` (relay) + `npx vue-tsc --noEmit` (relay-web) → both clean.
- [ ] **Step 2:** `node scripts/run-tests.mjs tests/unit/packages/relay` (per-file for any state-leak file) + `npx vitest run` (relay-web) → all green.
- [ ] **Step 3: Build** `bun run build:relay` + `bun run build:relay-web`.
- [ ] **Step 4: Sandbox migrate + redeploy.** The sandbox hub DB (under `/tmp/xacpx-relay-test`) will migrate on hub restart. Steps: stop the sandbox hub process; back up its `relay.db`; start the new hub (migration runs); mint a login token for the sandbox account (`xacpx-relay user ls` to find the label, then `xacpx-relay user token --account <label> --db <path>`); paste it into the web login to confirm end-to-end. Restart the console connector only if needed (connector unaffected — no protocol change). Report the token-login result.
- [ ] **Step 5: Final review.** Dispatch a code-quality review subagent over the whole branch diff (git-hygiene constraints). Then use superpowers:finishing-a-development-branch.

---

## Self-Review Notes
- **Cross-task dependency:** Task 4 needs `resolveLoginToken(token) → {account, loginTokenId}` for session linkage — add it in **Task 3** (noted there). If Task 3 only added `findAccountByLoginToken`, Task 4's first step must extend the store.
- **Migration safety:** Task 1 must keep FKs OFF, wrap in a transaction, use plain `ADD COLUMN` (no REFERENCES), drop invites before the accounts rebuild, and tolerate a half-renamed state — all asserted by tests.
- **No connector/core changes:** `channel-relay` and core `src/` are untouched; the only `role` references there are the unrelated orchestration/message-direction concept (verified in the spec review).
- **Revocation limitation:** open `/ws` sockets aren't force-closed on revoke (documented in spec §4.3); not a task here.
