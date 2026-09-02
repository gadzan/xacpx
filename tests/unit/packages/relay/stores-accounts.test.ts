import { expect, test } from "bun:test";

import { createSqlDriver, initSchema } from "../../../../packages/relay/src/db";
import { AccountStore } from "../../../../packages/relay/src/stores/accounts";

async function makeStore(nowIso = "2026-06-13T10:00:00.000Z") {
  const db = await createSqlDriver(":memory:");
  initSchema(db);
  let now = new Date(nowIso);
  const store = new AccountStore(db, { now: () => now });
  return { store, db, setNow: (iso: string) => { now = new Date(iso); } };
}

// ── createAccount ────────────────────────────────────────────────────────────

test("createAccount returns AccountRow with id/username/createdAt (no role)", async () => {
  const { store } = await makeStore();
  const account = store.createAccount("alice");
  expect(account.id).toBeString();
  expect(account.username).toBe("alice");
  expect(account.createdAt).toBe("2026-06-13T10:00:00.000Z");
  expect((account as Record<string, unknown>).role).toBeUndefined();
  expect((account as Record<string, unknown>).password).toBeUndefined();
});

test("createAccount throws on duplicate username", async () => {
  const { store } = await makeStore();
  store.createAccount("alice");
  expect(() => store.createAccount("alice")).toThrow();
});

// ── findByUsername / findById ─────────────────────────────────────────────────

test("findByUsername returns account or null", async () => {
  const { store } = await makeStore();
  const created = store.createAccount("bob");
  const found = store.findByUsername("bob");
  expect(found?.id).toBe(created.id);
  expect(found?.username).toBe("bob");
  expect(store.findByUsername("ghost")).toBeNull();
});

test("findById returns account or null", async () => {
  const { store } = await makeStore();
  const created = store.createAccount("carol");
  expect(store.findById(created.id)?.username).toBe("carol");
  expect(store.findById("nonexistent-id")).toBeNull();
});

// ── createLoginToken ──────────────────────────────────────────────────────────

test("createLoginToken returns raw token and stores only the hash", async () => {
  const { store, db } = await makeStore();
  const account = store.createAccount("alice");
  const { id, token } = store.createLoginToken(account.id, "laptop");

  expect(id).toBeString();
  expect(token).toBeString();
  expect(token.length).toBeGreaterThan(20);

  // The stored row must contain the HASH, not the raw token
  const row = db.get<{ token_hash: string; label: string | null; last_used_at: string | null }>(
    "SELECT token_hash, label, last_used_at FROM login_tokens WHERE id = ?",
    [id],
  );
  expect(row).toBeDefined();
  expect(row!.token_hash).not.toBe(token);  // hash != raw
  expect(row!.label).toBe("laptop");
  expect(row!.last_used_at).toBeNull();
});

test("createLoginToken with no label stores null label", async () => {
  const { store, db } = await makeStore();
  const account = store.createAccount("alice");
  const { id } = store.createLoginToken(account.id);
  const row = db.get<{ label: string | null }>(
    "SELECT label FROM login_tokens WHERE id = ?", [id]
  );
  expect(row!.label).toBeNull();
});

// ── findAccountByLoginToken ───────────────────────────────────────────────────

test("findAccountByLoginToken resolves account for valid token", async () => {
  const { store } = await makeStore();
  const account = store.createAccount("alice");
  const { token } = store.createLoginToken(account.id);

  const found = store.findAccountByLoginToken(token);
  expect(found?.id).toBe(account.id);
  expect(found?.username).toBe("alice");
});

test("findAccountByLoginToken returns null for unknown token", async () => {
  const { store } = await makeStore();
  expect(store.findAccountByLoginToken("totally-fake-token")).toBeNull();
});

test("findAccountByLoginToken bumps last_used_at from null to a timestamp", async () => {
  const { store, db, setNow } = await makeStore("2026-06-13T10:00:00.000Z");
  const account = store.createAccount("alice");
  const { id, token } = store.createLoginToken(account.id);

  // Confirm last_used_at starts null
  const before = db.get<{ last_used_at: string | null }>(
    "SELECT last_used_at FROM login_tokens WHERE id = ?", [id]
  );
  expect(before!.last_used_at).toBeNull();

  setNow("2026-06-13T11:00:00.000Z");
  store.findAccountByLoginToken(token);

  const after = db.get<{ last_used_at: string | null }>(
    "SELECT last_used_at FROM login_tokens WHERE id = ?", [id]
  );
  expect(after!.last_used_at).toBe("2026-06-13T11:00:00.000Z");
});

// ── resolveLoginToken ─────────────────────────────────────────────────────────

test("resolveLoginToken returns {account, loginTokenId} for valid token", async () => {
  const { store } = await makeStore();
  const account = store.createAccount("alice");
  const { id: tokenId, token } = store.createLoginToken(account.id);

  const result = store.resolveLoginToken(token);
  expect(result).not.toBeNull();
  expect(result!.account.id).toBe(account.id);
  expect(result!.loginTokenId).toBe(tokenId);
});

test("resolveLoginToken returns null for unknown token", async () => {
  const { store } = await makeStore();
  expect(store.resolveLoginToken("bad-token")).toBeNull();
});

test("resolveLoginToken bumps last_used_at exactly once", async () => {
  const { store, db, setNow } = await makeStore("2026-06-13T10:00:00.000Z");
  const account = store.createAccount("alice");
  const { id, token } = store.createLoginToken(account.id);

  setNow("2026-06-13T12:00:00.000Z");
  store.resolveLoginToken(token);

  const row = db.get<{ last_used_at: string | null }>(
    "SELECT last_used_at FROM login_tokens WHERE id = ?", [id]
  );
  expect(row!.last_used_at).toBe("2026-06-13T12:00:00.000Z");

  // Second call at later time updates again
  setNow("2026-06-13T13:00:00.000Z");
  store.resolveLoginToken(token);
  const row2 = db.get<{ last_used_at: string | null }>(
    "SELECT last_used_at FROM login_tokens WHERE id = ?", [id]
  );
  expect(row2!.last_used_at).toBe("2026-06-13T13:00:00.000Z");
});

// ── listLoginTokens ───────────────────────────────────────────────────────────

test("listLoginTokens returns tokens oldest-first (ORDER BY created_at)", async () => {
  const { store, setNow } = await makeStore("2026-06-13T10:00:00.000Z");
  const account = store.createAccount("alice");
  // Create two tokens at DIFFERENT clock times so created_at differs.
  setNow("2026-06-13T10:00:00.000Z");
  store.createLoginToken(account.id, "laptop");
  setNow("2026-06-13T11:00:00.000Z");
  store.createLoginToken(account.id, "desktop");

  const tokens = store.listLoginTokens(account.id);
  expect(tokens.length).toBe(2);
  expect(tokens.every(t => "id" in t && "label" in t && "createdAt" in t && "lastUsedAt" in t)).toBe(true);
  // No client-side sort: the query's ORDER BY created_at must yield oldest-first.
  expect(tokens.map(t => t.label)).toEqual(["laptop", "desktop"]);
  expect(tokens.map(t => t.createdAt)).toEqual([
    "2026-06-13T10:00:00.000Z",
    "2026-06-13T11:00:00.000Z",
  ]);
});

test("listLoginTokens returns empty array when no tokens", async () => {
  const { store } = await makeStore();
  const account = store.createAccount("bob");
  expect(store.listLoginTokens(account.id)).toEqual([]);
});

// ── revokeLoginToken ──────────────────────────────────────────────────────────

test("revokeLoginToken deletes the token and its linked web_sessions", async () => {
  const { store, db } = await makeStore();
  const account = store.createAccount("alice");
  const { id: tokenId, token } = store.createLoginToken(account.id);

  // Create a web_session linked to this login token
  const sessionToken = store.createWebSession(account.id, tokenId, 60_000);

  // Confirm session exists before revoke
  expect(store.getSessionAccount(sessionToken)?.id).toBe(account.id);

  const revoked = store.revokeLoginToken(tokenId);
  expect(revoked).toBe(true);

  // Token gone
  expect(store.findAccountByLoginToken(token)).toBeNull();
  // Linked session gone
  expect(store.getSessionAccount(sessionToken)).toBeNull();
});

test("revokeLoginToken leaves NULL-link (legacy) web_sessions intact", async () => {
  const { store, db } = await makeStore();
  const account = store.createAccount("alice");
  const { id: tokenId } = store.createLoginToken(account.id);

  // Seed a legacy session with login_token_id = NULL directly via driver
  const { generateToken, hashToken } = await import("../../../../packages/relay/src/auth");
  const legacyRaw = generateToken();
  const legacyHash = hashToken(legacyRaw);
  db.run(
    "INSERT INTO web_sessions (token_hash, account_id, login_token_id, expires_at) VALUES (?, ?, NULL, ?)",
    [legacyHash, account.id, new Date(Date.now() + 999_999).toISOString()]
  );

  store.revokeLoginToken(tokenId);

  // Legacy session must still be there
  const legacy = db.get<{ token_hash: string }>(
    "SELECT token_hash FROM web_sessions WHERE token_hash = ?", [legacyHash]
  );
  expect(legacy).toBeDefined();
});

test("revokeLoginToken returns false for unknown tokenId", async () => {
  const { store } = await makeStore();
  expect(store.revokeLoginToken("does-not-exist")).toBe(false);
});

// ── createWebSession / getSessionAccount / deleteWebSession ──────────────────

test("createWebSession + getSessionAccount round-trip", async () => {
  const { store } = await makeStore("2026-06-13T10:00:00.000Z");
  const account = store.createAccount("alice");
  const { id: tokenId } = store.createLoginToken(account.id);
  const sessionToken = store.createWebSession(account.id, tokenId, 60_000);

  expect(store.getSessionAccount(sessionToken)?.username).toBe("alice");
  expect(store.getSessionAccount("bad-token")).toBeNull();
});

test("getSessionAccount returns null for expired session", async () => {
  const { store, setNow } = await makeStore("2026-06-13T10:00:00.000Z");
  const account = store.createAccount("alice");
  const { id: tokenId } = store.createLoginToken(account.id);
  const sessionToken = store.createWebSession(account.id, tokenId, 60_000);

  setNow("2026-06-13T10:02:00.000Z");
  expect(store.getSessionAccount(sessionToken)).toBeNull();
});

test("deleteWebSession removes the session", async () => {
  const { store } = await makeStore("2026-06-13T10:00:00.000Z");
  const account = store.createAccount("alice");
  const { id: tokenId } = store.createLoginToken(account.id);
  const sessionToken = store.createWebSession(account.id, tokenId, 60_000);

  store.deleteWebSession(sessionToken);
  expect(store.getSessionAccount(sessionToken)).toBeNull();
});

// ── listAccounts ──────────────────────────────────────────────────────────────

test("listAccounts includes tokenCount and instanceCount", async () => {
  const { store, db } = await makeStore("2026-06-13T10:00:00.000Z");
  const account = store.createAccount("alice");
  store.createLoginToken(account.id, "a");
  store.createLoginToken(account.id, "b");

  // Seed an instance directly
  db.run(
    "INSERT INTO instances (id, account_id, name, credential_hash, created_at) VALUES (?, ?, ?, ?, ?)",
    ["inst-1", account.id, "mybox", "fakehash", "2026-06-13T10:00:00.000Z"]
  );

  const list = store.listAccounts();
  expect(list.length).toBe(1);
  expect(list[0].username).toBe("alice");
  expect(list[0].tokenCount).toBe(2);
  expect(list[0].instanceCount).toBe(1);
});

test("listAccounts returns zero counts when no tokens or instances", async () => {
  const { store } = await makeStore();
  store.createAccount("bob");
  const list = store.listAccounts();
  expect(list[0].tokenCount).toBe(0);
  expect(list[0].instanceCount).toBe(0);
});

// ── countInstances ────────────────────────────────────────────────────────────

test("countInstances returns correct count", async () => {
  const { store, db } = await makeStore("2026-06-13T10:00:00.000Z");
  const account = store.createAccount("alice");
  expect(store.countInstances(account.id)).toBe(0);

  db.run(
    "INSERT INTO instances (id, account_id, name, credential_hash, created_at) VALUES (?, ?, ?, ?, ?)",
    ["inst-1", account.id, "box1", "hash1", "2026-06-13T10:00:00.000Z"]
  );
  db.run(
    "INSERT INTO instances (id, account_id, name, credential_hash, created_at) VALUES (?, ?, ?, ?, ?)",
    ["inst-2", account.id, "box2", "hash2", "2026-06-13T10:00:00.000Z"]
  );
  expect(store.countInstances(account.id)).toBe(2);
});

// ── deleteAccountCascade ──────────────────────────────────────────────────────

test("deleteAccountCascade removes all related rows", async () => {
  const { store, db } = await makeStore("2026-06-13T10:00:00.000Z");
  const account = store.createAccount("alice");
  const { id: tokenId, token } = store.createLoginToken(account.id, "dev");
  const sessionToken = store.createWebSession(account.id, tokenId, 60_000);

  // Seed pairing token
  const { generateToken, hashToken } = await import("../../../../packages/relay/src/auth");
  const pairingRaw = generateToken();
  db.run(
    "INSERT INTO pairing_tokens (token_hash, account_id, expires_at) VALUES (?, ?, ?)",
    [hashToken(pairingRaw), account.id, "2026-12-31T00:00:00.000Z"]
  );

  // Seed instance + message
  db.run(
    "INSERT INTO instances (id, account_id, name, credential_hash, created_at) VALUES (?, ?, ?, ?, ?)",
    ["inst-1", account.id, "box", "fakehash", "2026-06-13T10:00:00.000Z"]
  );
  db.run(
    "INSERT INTO messages (instance_id, session_alias, direction, text, created_at) VALUES (?, ?, ?, ?, ?)",
    ["inst-1", "alias1", "in", "hello", "2026-06-13T10:00:00.000Z"]
  );
  db.run(
    "INSERT INTO turn_slot_anchors (instance_id, session_alias, recovery_id, slot_after_id) VALUES (?, ?, ?, ?)",
    ["inst-1", "alias1", "r-1", 1]
  );

  store.deleteAccountCascade(account.id);

  // Everything gone
  expect(store.findById(account.id)).toBeNull();
  expect(store.findAccountByLoginToken(token)).toBeNull();
  expect(store.getSessionAccount(sessionToken)).toBeNull();
  expect(db.get("SELECT 1 FROM instances WHERE account_id = ?", [account.id])).toBeUndefined();
  expect(db.get("SELECT 1 FROM messages WHERE instance_id = ?", ["inst-1"])).toBeUndefined();
  expect(db.get("SELECT 1 FROM turn_slot_anchors WHERE instance_id = ?", ["inst-1"])).toBeUndefined();
  expect(db.get("SELECT 1 FROM pairing_tokens WHERE account_id = ?", [account.id])).toBeUndefined();
  expect(db.get("SELECT 1 FROM login_tokens WHERE account_id = ?", [account.id])).toBeUndefined();
  expect(db.get("SELECT 1 FROM web_sessions WHERE account_id = ?", [account.id])).toBeUndefined();
});

// ── listTokens ────────────────────────────────────────────────────────────────

test("listTokens returns all tokens across all accounts with instanceCount", async () => {
  const { store, db } = await makeStore("2026-06-13T10:00:00.000Z");
  const alice = store.createAccount("alice");
  const bob = store.createAccount("bob");
  const { id: t1 } = store.createLoginToken(alice.id, "laptop");
  store.createLoginToken(alice.id, "desktop");
  store.createLoginToken(bob.id, null);

  // Seed one instance for alice
  db.run(
    "INSERT INTO instances (id, account_id, name, credential_hash, created_at) VALUES (?, ?, ?, ?, ?)",
    ["inst-1", alice.id, "box", "fakehash", "2026-06-13T10:00:00.000Z"]
  );

  const tokens = store.listTokens();
  expect(tokens.length).toBe(3);
  // alice tokens have instanceCount=1, bob token has instanceCount=0
  const aliceTokens = tokens.filter((t) => t.accountId === alice.id);
  const bobTokens = tokens.filter((t) => t.accountId === bob.id);
  expect(aliceTokens.length).toBe(2);
  expect(aliceTokens.every((t) => t.instanceCount === 1)).toBe(true);
  expect(bobTokens[0].instanceCount).toBe(0);

  // shape check
  const first = tokens[0];
  expect(typeof first.id).toBe("string");
  expect(typeof first.createdAt).toBe("string");
  expect(typeof first.accountId).toBe("string");
});

test("listTokens returns empty array when no tokens", async () => {
  const { store } = await makeStore();
  expect(store.listTokens()).toEqual([]);
});

test("listTokens orders oldest-first", async () => {
  const { store, setNow } = await makeStore("2026-06-13T10:00:00.000Z");
  const alice = store.createAccount("alice");
  setNow("2026-06-13T10:00:00.000Z");
  store.createLoginToken(alice.id, "first");
  setNow("2026-06-13T11:00:00.000Z");
  store.createLoginToken(alice.id, "second");

  const tokens = store.listTokens();
  expect(tokens.map((t) => t.label)).toEqual(["first", "second"]);
});

// ── accountIdForToken ─────────────────────────────────────────────────────────

test("accountIdForToken resolves by raw token value", async () => {
  const { store } = await makeStore();
  const account = store.createAccount("alice");
  const { token } = store.createLoginToken(account.id);

  const resolved = store.accountIdForToken(token);
  expect(resolved).toBe(account.id);
});

test("accountIdForToken resolves by full token id", async () => {
  const { store } = await makeStore();
  const account = store.createAccount("alice");
  const { id: tokenId } = store.createLoginToken(account.id);

  const resolved = store.accountIdForToken(tokenId);
  expect(resolved).toBe(account.id);
});

test("accountIdForToken resolves by unique id prefix", async () => {
  const { store } = await makeStore();
  const account = store.createAccount("alice");
  const { id: tokenId } = store.createLoginToken(account.id);
  const prefix = tokenId.slice(0, 8);

  const resolved = store.accountIdForToken(prefix);
  expect(resolved).toBe(account.id);
});

test("accountIdForToken returns null for unknown value", async () => {
  const { store } = await makeStore();
  expect(store.accountIdForToken("does-not-exist")).toBeNull();
});

test("accountIdForToken returns null for ambiguous prefix", async () => {
  const { store, db } = await makeStore();
  const alice = store.createAccount("alice");
  const bob = store.createAccount("bob");
  // Force two tokens to share the same prefix by inserting directly with crafted ids
  const { generateToken, hashToken } = await import("../../../../packages/relay/src/auth");
  db.run(
    "INSERT INTO login_tokens (id, token_hash, account_id, label, created_at, last_used_at) VALUES (?, ?, ?, NULL, ?, NULL)",
    ["aaaa1111-0000-0000-0000-000000000001", hashToken(generateToken()), alice.id, "2026-06-13T10:00:00.000Z"]
  );
  db.run(
    "INSERT INTO login_tokens (id, token_hash, account_id, label, created_at, last_used_at) VALUES (?, ?, ?, NULL, ?, NULL)",
    ["aaaa1111-0000-0000-0000-000000000002", hashToken(generateToken()), bob.id, "2026-06-13T10:00:00.000Z"]
  );

  // "aaaa1111" matches both rows — must return null
  expect(store.accountIdForToken("aaaa1111")).toBeNull();
});

// ── pruneExpired ──────────────────────────────────────────────────────────────

test("pruneExpired removes only expired web_sessions and returns count", async () => {
  const { store } = await makeStore("2026-06-13T10:00:00.000Z");
  const account = store.createAccount("alice");
  const { id: tokenId } = store.createLoginToken(account.id);

  // Create one session that will expire, one that won't
  const expiredToken = store.createWebSession(account.id, tokenId, 60_000);  // expires +1min
  const validToken = store.createWebSession(account.id, tokenId, 3_600_000); // expires +1hr

  // Prune at 5 minutes in — the 1-minute session is expired, the 1-hour is not
  const pruneTime = new Date("2026-06-13T10:05:00.000Z");
  const count = store.pruneExpired(pruneTime);

  expect(count).toBe(1);
  expect(store.getSessionAccount(validToken)?.id).toBe(account.id);
  // expiredToken was deleted (and getSessionAccount would return null either way since it expired)
});

test("pruneExpired prunes a session whose expires_at equals now exactly (<= boundary)", async () => {
  const { store, db } = await makeStore("2026-06-13T10:00:00.000Z");
  const account = store.createAccount("alice");
  const { id: tokenId } = store.createLoginToken(account.id);

  // ttl of 60s from 10:00 → expires_at exactly 10:01:00.
  store.createWebSession(account.id, tokenId, 60_000);

  // Prune at exactly the expiry instant: <= boundary means it IS pruned.
  const count = store.pruneExpired(new Date("2026-06-13T10:01:00.000Z"));
  expect(count).toBe(1);
  expect(db.get("SELECT 1 FROM web_sessions WHERE account_id = ?", [account.id])).toBeUndefined();
});

test("pruneExpired returns 0 when nothing to prune", async () => {
  const { store } = await makeStore("2026-06-13T10:00:00.000Z");
  expect(store.pruneExpired(new Date("2026-06-13T09:00:00.000Z"))).toBe(0);
});

test("pruneExpired does not touch login_tokens", async () => {
  const { store, db } = await makeStore("2026-06-13T10:00:00.000Z");
  const account = store.createAccount("alice");
  store.createLoginToken(account.id, "permanent");

  store.pruneExpired(new Date("2099-01-01T00:00:00.000Z"));

  const tokens = store.listLoginTokens(account.id);
  expect(tokens.length).toBe(1);
});

// ── invite codes ──────────────────────────────────────────────────────────────

test("issueInviteCode returns plaintext once and stores only the hash", async () => {
  const { store, db } = await makeStore("2026-06-13T10:00:00.000Z");
  const { id, code, expiresAt } = store.issueInviteCode("friend", 7 * 24 * 3_600_000);

  expect(id).toBeString();
  expect(code.length).toBeGreaterThan(20);
  expect(expiresAt).toBe("2026-06-20T10:00:00.000Z");

  const row = db.get<{ code_hash: string; label: string | null; used_at: string | null }>(
    "SELECT code_hash, label, used_at FROM invite_codes WHERE id = ?", [id],
  );
  expect(row).toBeDefined();
  expect(row!.code_hash).not.toBe(code);
  expect(row!.code_hash).not.toContain(code);
  expect(row!.label).toBe("friend");
  expect(row!.used_at).toBeNull();
});

test("redeemInviteCode creates account + login token that resolves", async () => {
  const { store, db } = await makeStore("2026-06-13T10:00:00.000Z");
  const { id, code } = store.issueInviteCode("friend", 60_000);

  const r = store.redeemInviteCode(code);
  expect(r).not.toBeNull();
  expect(r!.username.startsWith("u-")).toBe(true);
  expect(store.findById(r!.accountId)?.username).toBe(r!.username);
  const resolved = store.resolveLoginToken(r!.token);
  expect(resolved?.account.id).toBe(r!.accountId);
  expect(resolved?.loginTokenId).toBe(r!.loginTokenId);

  // used_at / used_account_id stamped; invite label carried onto the login token
  const row = db.get<{ used_at: string | null; used_account_id: string | null }>(
    "SELECT used_at, used_account_id FROM invite_codes WHERE id = ?", [id],
  );
  expect(row!.used_at).toBe("2026-06-13T10:00:00.000Z");
  expect(row!.used_account_id).toBe(r!.accountId);
  expect(store.listLoginTokens(r!.accountId)[0]!.label).toBe("friend");
});

test("redeemInviteCode is single-use", async () => {
  const { store } = await makeStore();
  const { code } = store.issueInviteCode(undefined, 60_000);
  expect(store.redeemInviteCode(code)).not.toBeNull();
  expect(store.redeemInviteCode(code)).toBeNull();
});

test("redeemInviteCode returns null for expired or unknown code", async () => {
  const { store, setNow } = await makeStore("2026-06-13T10:00:00.000Z");
  const { code } = store.issueInviteCode(undefined, 60_000);
  expect(store.redeemInviteCode("no-such-code")).toBeNull();
  setNow("2026-06-13T10:01:00.000Z"); // <= boundary: expired exactly at expiry
  expect(store.redeemInviteCode(code)).toBeNull();
});

test("inviteIdFor resolves by raw code, exact id, unique prefix; null on ambiguous", async () => {
  const { store, db } = await makeStore();
  const { id, code } = store.issueInviteCode(undefined, 60_000);
  expect(store.inviteIdFor(code)).toBe(id);
  expect(store.inviteIdFor(id)).toBe(id);
  expect(store.inviteIdFor(id.slice(0, 8))).toBe(id);
  expect(store.inviteIdFor("does-not-exist")).toBeNull();

  const { generateToken, hashToken } = await import("../../../../packages/relay/src/auth");
  for (const suffix of ["1", "2"]) {
    db.run(
      "INSERT INTO invite_codes (id, code_hash, label, created_at, expires_at) VALUES (?, ?, NULL, ?, ?)",
      [`bbbb2222-0000-0000-0000-00000000000${suffix}`, hashToken(generateToken()),
       "2026-06-13T10:00:00.000Z", "2026-12-31T00:00:00.000Z"],
    );
  }
  expect(store.inviteIdFor("bbbb2222")).toBeNull();
});

test("removeInviteCode deletes and reports missing", async () => {
  const { store } = await makeStore();
  const { id, code } = store.issueInviteCode(undefined, 60_000);
  expect(store.removeInviteCode(id)).toBe(true);
  expect(store.redeemInviteCode(code)).toBeNull();
  expect(store.removeInviteCode(id)).toBe(false);
});

test("pruneInviteCodes removes expired and used codes, keeps live ones", async () => {
  const { store } = await makeStore("2026-06-13T10:00:00.000Z");
  store.issueInviteCode("expired", 60_000);
  const { code: usedCode } = store.issueInviteCode("used", 3_600_000);
  const { id: liveId } = store.issueInviteCode("live", 3_600_000);
  store.redeemInviteCode(usedCode);

  const count = store.pruneInviteCodes(new Date("2026-06-13T10:05:00.000Z"));
  expect(count).toBe(2);
  expect(store.listInviteCodes().map((i) => i.id)).toEqual([liveId]);
});
