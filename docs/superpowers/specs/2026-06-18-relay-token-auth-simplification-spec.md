# Relay Token-Based Auth Simplification — Design Spec

> Status: DRAFT (for review)
> Date: 2026-06-18
> Scope: `packages/relay` (hub server, CLI, DB), `packages/relay-web` (login + settings + auth store), docs. No changes to `packages/channel-relay` (connector) or core `src/`.

## 1. Motivation

The relay hub today carries a full multi-tenant credential system — username/password accounts, `admin`/`member` roles, an invite-token self-registration flow — but **no admin surface to manage any of it**. Accounts can be created (CLI `init-admin`, or self-service `/api/register` via an admin-issued invite) but never listed, disabled, password-reset, role-changed, or revoked from the UI. The only management is "an admin generates an invite token". This is over-built for the actual use case and has an unmanaged tail (orphan accounts/sessions only fixable by editing SQLite directly).

**Decision (agreed with maintainer):** collapse to a token-only model — *the operator mints a login token per user via the hub CLI; each user pastes that token into the hub web UI to log in and manage their own instances.* Per-account scoping (`relay:<accountId>`) is retained; passwords, invites, self-registration, and web-facing roles are removed.

## 2. Goals / Non-Goals

### Goals
- A login token is a **permanent per-account credential** (API-key-like), minted only by the hub CLI.
- A user logs in by pasting the token into the web UI; the server exchanges it for a normal `web_sessions` cookie (so the browser stays logged in; the token is reusable on other devices).
- The operator can **revoke** a token (and a whole account) via CLI; revoking a token immediately invalidates the cookie sessions derived from it.
- Remove passwords, the `invites` flow, `/api/register`, and the web-facing `admin`/`member` role distinction.
- Keep per-account scope (`relay:<accountId>`) and the **connector pairing-token** flow unchanged in behavior (only CLI command naming is clarified).
- `relay user rm <name> --force` cascade-deletes the account and everything it owns.

### Non-Goals
- No web-based account/user management UI (provisioning stays CLI-only — that is the whole point of the simplification).
- No change to the connector↔instance-gateway pairing/credential mechanism (`pairing_tokens`, `instances.credential_hash`).
- No change to message storage, history retention, gateways, or session/turn semantics.
- No SSO/OAuth/multi-factor. No rate-limit redesign beyond re-keying the existing limiter.

## 3. Current State (as-is)

### 3.1 Data model (`packages/relay/src/db.ts`)
- `accounts(id, username UNIQUE, password_hash NOT NULL, role CHECK(admin|member), created_at)`
- `invites(token_hash PK, created_by → accounts.id, expires_at, used_by NULL)`
- `web_sessions(token_hash PK, account_id → accounts.id, expires_at)`
- `pairing_tokens(token_hash PK, account_id → accounts.id, name, expires_at, used_at)` — connector pairing
- `instances(id, account_id → accounts.id, name, credential_hash, core_version, last_seen_at, created_at)`
- `messages(...)` — unaffected

### 3.2 Auth primitives (`packages/relay/src/auth.ts`)
- `hashPassword`/`verifyPassword` (scrypt) — **password login only**.
- `generateToken` (32 random bytes, base64url), `hashToken` (sha256), `hashEquals` — used by invites, pairing, web sessions; **retained**.

### 3.3 AccountStore (`packages/relay/src/stores/accounts.ts`)
- `createAccount(username, password, role)`, `findByUsername`, `findById`, `verifyLogin(username,password)`
- `createInvite`, `validateInvite`, `markInviteUsed`
- `createWebSession(accountId, ttl)`, `getSessionAccount(token)`, `deleteWebSession(token)`
- `pruneExpired(now)` — GCs expired web_sessions + expired/used invites

### 3.4 HTTP (`packages/relay/src/http/app.ts`)
- `POST /api/login` `{username,password}` → verify → set `SESSION_COOKIE` → `{username,role}`. IP-less failure limiter keyed by **username**.
- `POST /api/register` `{invite,username,password}` → create `member` → mark invite used.
- `GET /api/me` → `{username,role}`.
- `POST /api/invites` (admin-only) → mint invite.
- `POST /api/instances/pairing-token`, `GET /api/instances`, `DELETE /api/instances/:id` — per-account.
- `app.use("/api/*")` auth gate: skips `/api/login` + `/api/register`; else requires a valid session cookie.

### 3.5 CLI (`packages/relay/src/cli.ts`)
- `init-admin --username [--password] --db` → create `admin` account, print password.
- `token new --account <username> [--name] [--ttl-minutes 10] --db` → mint a **pairing** token.
- `start ...`.

### 3.6 Frontend (`packages/relay-web`)
- `views/LoginView.vue` — username + password form → `auth.login(username,password)`.
- `stores/auth.ts` — `Account {username, role}`, `login(username,password)`, `fetchMe`, `logout`.
- `views/SettingsView.vue` — pairing-token section (all users) + invite section (`v-if role==='admin'`) + retention + logout.

### 3.7 Tests (relay backend under `tests/unit/packages/relay/`)
`auth.test.ts`, `stores-accounts.test.ts`, `http-app.test.ts`, `cli.test.ts`, `db.test.ts`, `maintenance.test.ts`, `integration.test.ts`, `web-dashboard-e2e.test.ts`, plus gateway/store tests unaffected. Frontend: `auth.test.ts`, `settings.test.ts`.

## 4. Target Design (to-be)

### 4.1 Concept
- **Account** = an identity with a human **label** (the former `username`, kept unique for CLI reference) and `id`. No password, no role.
- **Login token** = a high-entropy secret bound to an account, stored **hashed** (`hashToken`/sha256, same as today's tokens). Permanent (no expiry). An account may have **multiple** login tokens (multi-device / rotation), each independently revocable and labelled.
- **Web session** = unchanged cookie mechanism, but each session records **which login token minted it**, so revoking a token cascades to its sessions.
- **Pairing token** = unchanged; only the CLI command name is clarified to avoid confusion with login tokens.

### 4.2 Login flow
1. Operator: `relay user new --name alice --db <path>` → creates account + first login token → prints the token once.
2. Alice opens the hub, pastes the token into a single "Access token" field → `POST /api/login {token}`.
3. Server validates the token (hash lookup), creates a `web_sessions` row (with `login_token_id`), sets the `SESSION_COOKIE`. Subsequent requests use the cookie as today.
4. The raw token is **not persisted client-side**; Alice re-pastes on a new device (or relies on the cookie on the current one).

### 4.3 Revocation model
- `xacpx-relay token revoke --id <token-id> --db` → delete the `login_tokens` row **and** all `web_sessions WHERE login_token_id = <id>`. The user's browser session dies on its next HTTP request / next WS (re)connect.
- `xacpx-relay user rm --account <label> --db` → refuse if the account owns instances (lists them), unless `--force`.
- `xacpx-relay user rm --account <label> --force --db` → cascade-delete **by `account_id`** (so it also reaches legacy NULL-link sessions): the account's `messages` (via its instances) → `instances` → `pairing_tokens` → `web_sessions WHERE account_id` → `login_tokens` → the account row. All inside one transaction.
- **Revocation scope (documented limitation):** auth is re-checked on every HTTP request and on each `/ws` WebSocket **upgrade** (`server.ts` authenticates the live-event socket via the session cookie → `getSessionAccount`). An **already-open** WebSocket is **not** force-closed when its session/token is revoked — it persists until the client reconnects (no per-frame re-auth exists in `WebGateway`). So "immediate" means "no new HTTP/WS access"; a streaming socket may linger briefly. Force-closing live sockets on revoke is out of scope (possible follow-up); to hard-cut everything, restart the hub.

## 5. Data Model & Migration

### 5.1 New/changed schema (fresh DB)
```sql
CREATE TABLE accounts (
  id TEXT PRIMARY KEY,
  username TEXT NOT NULL UNIQUE,   -- now purely a human label for CLI reference
  created_at TEXT NOT NULL
);                                  -- password_hash + role REMOVED

CREATE TABLE login_tokens (
  id TEXT PRIMARY KEY,
  token_hash TEXT NOT NULL UNIQUE,
  account_id TEXT NOT NULL REFERENCES accounts(id),
  label TEXT,
  created_at TEXT NOT NULL,
  last_used_at TEXT
);

CREATE TABLE web_sessions (
  token_hash TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id),
  login_token_id TEXT REFERENCES login_tokens(id),  -- NEW; NULL for legacy rows. REFERENCES is legal in CREATE TABLE (fresh DB) only.
  expires_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_web_sessions_login_token ON web_sessions(login_token_id);  -- revocation deletes by this column
-- invites table: DROPPED
-- pairing_tokens, instances, messages: UNCHANGED
```

### 5.2 Migration (existing DBs)
`initSchema` runs idempotently on every `start`. **FK enforcement is OFF** in this codebase — `PRAGMA foreign_keys` is never set, and both `bun:sqlite` and `node:sqlite` default it to OFF per connection. The migration **depends on this** (the `accounts` rebuild's DROP/RENAME is only safe because child FK rows are not enforced/rewritten). The migration must NOT enable FKs. The whole migration runs inside a **single transaction** (`db.exec("BEGIN")` … `db.exec("COMMIT")`) so a crash can't leave a half-rebuilt schema. Steps, each guarded by `PRAGMA table_info`/`sqlite_master` existence checks so they run once:

1. **Create `login_tokens`** if absent (`CREATE TABLE IF NOT EXISTS`) + its index.
2. **Add `web_sessions.login_token_id`** if absent — **plain nullable column, NO `REFERENCES` clause**: `ALTER TABLE web_sessions ADD COLUMN login_token_id TEXT;` then `CREATE INDEX IF NOT EXISTS idx_web_sessions_login_token …`.
   > ⚠️ SQLite forbids `ADD COLUMN … REFERENCES …` (and PK/UNIQUE/NOT-NULL-without-default). The `REFERENCES` lives only in the fresh-DB `CREATE TABLE` (§5.1); on upgraded DBs the column is plain. FKs are off anyway, so the declared FK is decorative — integrity is enforced by the application-level cascade in `revokeLoginToken`/`deleteAccountCascade`, not by SQLite. This mirrors the existing `messages.structured` ALTER precedent (`db.ts:97`).
   Legacy sessions keep working until they expire (NULL link = not tied to any token; unaffected by token revocation — acceptable for pre-existing sessions).
3. **Drop `invites`** (`DROP TABLE IF EXISTS invites`) — done **before** the accounts rebuild (invites has `created_by → accounts`, so dropping it first avoids a dangling ref and matches child→parent ordering).
4. **Rebuild `accounts`** to drop `password_hash` + `role` (canonical SQLite column-drop via table rebuild):
   - `CREATE TABLE accounts_new (id, username UNIQUE, created_at)`
   - `INSERT INTO accounts_new SELECT id, username, created_at FROM accounts`
   - `DROP TABLE accounts; ALTER TABLE accounts_new RENAME TO accounts`
   - **Guard tolerant of a half-migrated state:** run when old `accounts` still has a `password_hash` column **OR** when `accounts_new` exists and `accounts` does not (finish the interrupted rename). Because the whole migration is transaction-wrapped this window shouldn't persist, but the guard must not mis-skip if it ever does.

**Existing accounts are NOT auto-issued tokens** (we will not print secrets into server logs on startup). After upgrade the operator runs `xacpx-relay user token --account <label>` for each user who needs web access — called out in the migration docs as a required manual step. Pre-existing **cookie sessions remain valid** until expiry, so currently-logged-in users are not kicked. (To force a global re-login on upgrade, the operator stops the hub and runs `DELETE FROM web_sessions` — documented, not built.)

**`node:sqlite` is untested:** the test suite runs under Bun, so `createSqlDriver`'s `node:sqlite` branch is never exercised. The DDL used (plain `ADD COLUMN`, `CREATE TABLE`, `DROP`/`RENAME`, `BEGIN`/`COMMIT`) is standard and identical across both, but the plan should note this gap (optionally add a node-run smoke check).

### 5.3 AccountStore changes
- Remove: `createAccount(role)` signature's password+role, `verifyLogin`, `createInvite`, `validateInvite`, `markInviteUsed`.
- `createAccount(username) → AccountRow{ id, username, createdAt }` (no password/role).
- Add login-token methods:
  - `createLoginToken(accountId, label?) → { id, token }` (returns raw token once; stores hash).
  - `findAccountByLoginToken(token) → AccountRow | null` (hash lookup; bumps `last_used_at`).
  - `listLoginTokens(accountId) → {id,label,createdAt,lastUsedAt}[]`.
  - `revokeLoginToken(tokenId) → boolean` (delete token row + its web_sessions).
- `createWebSession(accountId, loginTokenId, ttl)` — gains `loginTokenId`.
- `getSessionAccount`, `deleteWebSession` unchanged.
- `pruneExpired` — drop the invites branch; keep web_sessions GC. (login_tokens are permanent; not pruned.)
- Add account-management helpers for CLI: `listAccounts()`, `deleteAccountCascade(accountId)` (within a transaction), `countInstances(accountId)`.

### 5.4 `AccountRole` type
Remove `AccountRole` and all `role` fields from `AccountRow` and DTOs.

## 6. HTTP API Changes (`packages/relay/src/http/app.ts`)

- `POST /api/login`: body `{ token }`. Validate via `findAccountByLoginToken`; on success `createWebSession(account.id, loginTokenId, ttl)`, set cookie, return `{ username }` (no role). On failure 401 `{error:"invalid-token"}`.
- **Rate limiter** (the login body no longer carries a username to key on):
  - **Primary: per-IP.** Trust an `x-forwarded-for` client IP **only** when an explicit `--trust-proxy` flag/env is set (else XFF is attacker-forgeable and the limiter is trivially bypassed — *worse* than today's per-username limiter); otherwise use the socket remote address.
  - **Plus a global failure ceiling**: a total failed-`/api/login` count per window across all keys (reuse the existing `loginFailures` map machinery), as a backstop so XFF spoofing / many IPs can't fully bypass throttling. Keep the existing window/threshold/sweep logic for both.
- `POST /api/register`: **removed** (route deleted; auth gate no longer exempts it).
- `POST /api/invites`: **removed**.
- `GET /api/me`: return `{ username }` (drop `role`).
- Auth gate (`app.use("/api/*")`): exempt only `/api/login`.
- `inviteTtlMs` dep + default: removed. `pairingTtlMs`/`sessionTtlMs`: unchanged — note they are **dead defaults** today (`server.ts`'s `createApp(...)` never passes them), so no `server.ts` call-site change is needed for TTLs.
- Pairing/instances routes: unchanged (no role checks existed there).
- **`/ws` (live events, `server.ts`)**: authenticates via the same session cookie at the WS **upgrade** only. No route change needed, but note it in the revocation-scope limitation (§4.3) — open sockets aren't force-closed on revoke.

## 7. CLI Changes (`packages/relay/src/cli.ts`)

New command surface (clear split between **login tokens** for humans and **pairing tokens** for connectors):

```
xacpx-relay <command>
  start        ...                                   (unchanged)
  user new     --name <label> --db <path>            create account + first login token (prints token once)
  user token   --account <label> [--label <l>] --db  mint an ADDITIONAL login token for an account
  user ls      --db                                  list accounts (label, created, #tokens, #instances)
  user rm      --account <label> [--force] --db      delete account; refuses if it owns instances unless --force
  token revoke --id <login-token-id> --db            revoke one login token (+ its sessions)
  pair         --account <label> [--name <l>] [--ttl-minutes 10] --db   mint a connector PAIRING token
```

- `init-admin` → **removed**; replaced by `user new` (first user is just a user; there is no admin role).
- `token new` (old pairing minter) → **hard-renamed to `pair`** (no deprecation alias). Pre-release, self-hosted, and the only consumers are the operator docs we update in the same change. Update `docs/relay-deployment.md` + `relay-module.md` accordingly.
- All token-printing commands print "store it now — not shown again".
- `user rm` without `--force` and with instances present: print the blocking instance list and exit non-zero.
- **Arg style:** the existing `flag()` parser only supports `--flag value` (no positionals), so all commands use `--account <label>` / `--id <id>` (not positional `<name>`).
- **Binary name** is `xacpx-relay` (per the `USAGE` string and bin), not `relay`; the `relay <cmd>` forms elsewhere in this spec are shorthand.

## 8. Frontend Changes (`packages/relay-web`)

- `stores/auth.ts`: `Account { username }` (drop `role`); `login(token: string)` posts `{token}`; `fetchMe`/`logout` unchanged.
- `views/LoginView.vue`: replace username+password with a single **"Access token"** input (type=password, paste-friendly) + submit; same error display. Update copy ("Paste the access token from `relay user new`").
- `views/SettingsView.vue`: remove the invite section entirely (and its `genInvite`/`invite` state + `role` gate). Keep pairing-token, retention, theme, logout sections.
- Any other `account.role` reads: none outside `SettingsView` (verified via grep — only `auth.ts`, `SettingsView.vue`, and tests reference `role`).

## 9. Security Considerations

- A login token is a **bearer credential** equal in power to the old password — must be transmitted over TLS (operator responsibility; documented), stored **hashed at rest** (sha256 over 256-bit random is sufficient — same as existing tokens), shown in plaintext **once** at mint time.
- `SESSION_COOKIE` stays `httpOnly; SameSite=Lax; Path=/`. The raw login token is never stored in a cookie or localStorage; only the opaque session token is (httpOnly cookie).
- Login rate-limit moves to per-IP; behind a reverse proxy the operator must forward a trustworthy client IP, else the limiter is coarse (per-proxy). Documented; not a regression vs today (today's per-username limiter is also bypassable by varying usernames).
- Token comparison uses hash-table lookup on `hashToken` (constant-time per-byte not required for a hashed random 256-bit secret; matches existing web-session/pairing handling).
- Revocation is immediate for token-derived sessions; legacy (NULL-link) sessions expire naturally — acceptable, documented.

## 10. Test Impact

> **First task of the plan: grep every test for the removed surface before declaring impact complete.** Search `createAccount(` (3-arg → 1-arg), `verifyLogin`, `/api/register`, `/api/invites`, `createInvite`, `role:`/`role ===`, `init-admin`, `token new`, `login("`/`login(username`. Reviews flagged that the list below is necessary-but-maybe-not-sufficient; the grep is authoritative. Known extra hits: `http-app.test.ts` `makeApp()` helper calls `createAccount("admin","admin-pw","admin")` (used by ~10 tests) + dedicated invite/register/rate-limit-by-username tests; `maintenance.test.ts` has 3-arg `createAccount` at multiple lines + `createInvite`; also check `runtime-fanout.test.ts`, `web-ws-integration.test.ts`, `integration.test.ts`, and the `http/` + `stores/` subdirs.

### Backend (`tests/unit/packages/relay/`)
- `stores-accounts.test.ts`: rewrite for token methods (`createLoginToken`/`findAccountByLoginToken` (+`last_used_at` bump)/`revokeLoginToken`/`deleteAccountCascade`/`listAccounts`/`countInstances`); 1-arg `createAccount`. Drop password/invite/role cases. **Add:** revoke deletes only the token's linked sessions and **leaves a NULL-link (legacy) session intact**.
- `http-app.test.ts`: `/api/login` with `{token}`; removed `/api/register` + `/api/invites` (assert route gone); `/api/me` shape `{username}`; per-IP rate limit + global ceiling + `--trust-proxy` XFF trust toggle; rewrite the `makeApp()` bootstrap to 1-arg `createAccount` + minted token; pairing/instances unchanged.
- `cli.test.ts`: `user new`/`user token`/`user ls`/`user rm`(+`--force` refusal when instances exist, + cascade with `--force`)/`token revoke`/`pair`; remove `init-admin`/`token new`.
- `db.test.ts`: fresh schema asserts (`invites` **absent** — invert the current line that expects it present); **migration suite** from a seeded legacy DB (accounts with password_hash/role + a web_session row + an instance + an invite):
  1. post-migration: `accounts` has no `password_hash`/`role`, `login_tokens` + index exist, `web_sessions.login_token_id` exists, `invites` gone;
  2. **data survival / no-orphan**: account rows keep ids; the instance + web_session still reference the same `account_id`; `messages` untouched;
  3. **legacy session**: its `login_token_id IS NULL` and it still resolves via `getSessionAccount`;
  4. **idempotent triple re-run** on the migrated DB is a clean no-op (covers the half-migrated guard);
  5. re-run when `login_tokens`/`login_token_id` already present → no "duplicate column"/"table exists" error.
- `maintenance.test.ts`: rewrite the 3-arg `createAccount` calls; `pruneExpired` no longer touches invites (drop the invite assertions).
- `integration.test.ts` / `web-dashboard-e2e.test.ts` / `web-ws-integration.test.ts` / `runtime-fanout.test.ts`: bootstrap via token login instead of username/password wherever they create accounts or hit `/api/login`.

### Frontend (`packages/relay-web/src/__tests__/`)
- `auth.test.ts`: `login(token)` single-arg signature (all three call sites at lines 12/20/27) success/401; account shape exact-match `{username}` (drop `role`).
- `settings.test.ts`: remove invite-section/role cases; keep pairing + logout + retention.

## 11. Docs Impact
- `docs/relay-deployment.md`: replace `init-admin`/password + invite onboarding (lines ~20-21, 30, 40) with `user new` → paste token; document the migration manual step (`user token` for existing accounts), the `--trust-proxy` / per-IP rate-limit note, the `--force` cascade, and the "stop hub + `DELETE FROM web_sessions` to force global re-login" lever.
- `docs/relay-module.md`: update the auth/accounts section (token model, `login_tokens`, revocation, CLI surface) AND the two spots that name the removed surface — the **CSRF-backstop / route list** (mentions `/api/invites`) and the **`pruneExpired` description** (mentions invite GC).
- `CLAUDE.md`/`AGENTS.md`: no structural change; the relay doc links already exist.

## 12. Rollout / Migration Steps (operator-facing)
1. Deploy new hub build; `start` runs `initSchema` migration automatically (adds `login_tokens`, `web_sessions.login_token_id`; rebuilds `accounts`; drops `invites`).
2. For each user needing web access: `relay user token --account <label> --db <path>` (or `user new` for new ones); hand them the printed token.
3. Users log in by pasting the token. Existing cookie sessions keep working until expiry.
4. Old `init-admin`/`token new`/invite flows are gone (or `token new` warns + redirects to `pair` for one release).

## 13. Resolved Decisions
- **Token lifetime:** permanent credential, CLI-revocable (chosen over one-time/TTL).
- **`user rm`:** refuse-by-default, `--force` cascade-deletes the account and all it owns (by `account_id`, in a transaction).
- **Roles:** removed from the web entirely; "operator" power = whoever has hub CLI/server access.
- **Pairing vs login tokens:** kept as two distinct mechanisms; CLI commands renamed to disambiguate (`pair` vs `user token`/`token revoke`).
- **(Q1) `token new` → `pair`:** hard-rename, no deprecation alias (pre-release; docs updated in the same change).
- **(Q2) `user new`:** always mints the first login token (an account with zero tokens is unusable — exactly the "unmanaged tail" being removed). `user token` mints additional ones.
- **(Q3) Tokens per account:** multiple (supports rotate-without-lockout + multi-device; trivial cost; `user rm --force` deletes all regardless).
- **(Q4) Rate limit:** per-IP **with** XFF trusted only under `--trust-proxy`, **plus** a global failure ceiling backstop (XFF spoofing must not fully bypass throttling).
- **(Q5) Legacy sessions:** leave NULL-link web_sessions valid until expiry (don't kick logged-in users on upgrade); a manual `DELETE FROM web_sessions` is the documented global-logout lever. Cascade `user rm --force` reaches them via `account_id`.

## 14. Known Limitations (carried, not blockers)
- **Live WebSocket revocation:** an already-open `/ws` socket isn't force-closed on token/account revocation; it persists until reconnect (§4.3). Force-closing is a possible follow-up; hub restart hard-cuts everything.
- **`node:sqlite` path untested:** tests run under Bun only (§5.2); the DDL is standard and shared, risk accepted (optional node smoke check).
