import { randomUUID } from "node:crypto";

import { generateToken, hashToken } from "../auth.js";
import type { SqlDriver } from "../db.js";

export interface AccountRow {
  id: string;
  username: string;
  createdAt: string;
}

interface AccountStoreOptions {
  now?: () => Date;
}

export class AccountStore {
  private readonly now: () => Date;

  constructor(private readonly db: SqlDriver, options: AccountStoreOptions = {}) {
    this.now = options.now ?? (() => new Date());
  }

  createAccount(username: string): AccountRow {
    const id = randomUUID();
    const createdAt = this.now().toISOString();
    this.db.run(
      "INSERT INTO accounts (id, username, created_at) VALUES (?, ?, ?)",
      [id, username, createdAt],
    );
    return { id, username, createdAt };
  }

  findByUsername(username: string): AccountRow | null {
    const row = this.db.get<{ id: string; username: string; created_at: string }>(
      "SELECT id, username, created_at FROM accounts WHERE username = ?",
      [username],
    );
    return row ? { id: row.id, username: row.username, createdAt: row.created_at } : null;
  }

  findById(id: string): AccountRow | null {
    const row = this.db.get<{ id: string; username: string; created_at: string }>(
      "SELECT id, username, created_at FROM accounts WHERE id = ?",
      [id],
    );
    return row ? { id: row.id, username: row.username, createdAt: row.created_at } : null;
  }

  listAccounts(): Array<AccountRow & { tokenCount: number; instanceCount: number }> {
    return this.db.all<{
      id: string;
      username: string;
      created_at: string;
      token_count: number;
      instance_count: number;
    }>(
      `SELECT a.id, a.username, a.created_at,
        (SELECT COUNT(*) FROM login_tokens lt WHERE lt.account_id = a.id) AS token_count,
        (SELECT COUNT(*) FROM instances i WHERE i.account_id = a.id) AS instance_count
       FROM accounts a
       ORDER BY a.created_at`,
    ).map((row) => ({
      id: row.id,
      username: row.username,
      createdAt: row.created_at,
      tokenCount: row.token_count,
      instanceCount: row.instance_count,
    }));
  }

  countInstances(accountId: string): number {
    const row = this.db.get<{ n: number }>(
      "SELECT COUNT(*) AS n FROM instances WHERE account_id = ?",
      [accountId],
    );
    return row?.n ?? 0;
  }

  createLoginToken(accountId: string, label?: string): { id: string; token: string } {
    const id = randomUUID();
    const token = generateToken();
    const createdAt = this.now().toISOString();
    this.db.run(
      "INSERT INTO login_tokens (id, token_hash, account_id, label, created_at, last_used_at) VALUES (?, ?, ?, ?, ?, NULL)",
      [id, hashToken(token), accountId, label ?? null, createdAt],
    );
    return { id, token };
  }

  /**
   * Single source of truth for login-token resolution: find the token row by
   * hashed token, confirm the account still exists, THEN bump last_used_at.
   * The bump happens only after the account is confirmed, so a token whose
   * account was deleted does not get a wasted last_used_at update. Both
   * findAccountByLoginToken and resolveLoginToken go through here, so the bump
   * happens exactly once and identically for both.
   */
  private _resolveLoginToken(token: string): { account: AccountRow; loginTokenId: string } | null {
    const row = this.db.get<{ id: string; account_id: string }>(
      "SELECT id, account_id FROM login_tokens WHERE token_hash = ?",
      [hashToken(token)],
    );
    if (!row) return null;
    const account = this.findById(row.account_id);
    if (!account) return null;
    this.db.run(
      "UPDATE login_tokens SET last_used_at = ? WHERE id = ?",
      [this.now().toISOString(), row.id],
    );
    return { account, loginTokenId: row.id };
  }

  findAccountByLoginToken(token: string): AccountRow | null {
    return this._resolveLoginToken(token)?.account ?? null;
  }

  resolveLoginToken(token: string): { account: AccountRow; loginTokenId: string } | null {
    return this._resolveLoginToken(token);
  }

  listLoginTokens(accountId: string): Array<{ id: string; label: string | null; createdAt: string; lastUsedAt: string | null }> {
    return this.db.all<{
      id: string;
      label: string | null;
      created_at: string;
      last_used_at: string | null;
    }>(
      "SELECT id, label, created_at, last_used_at FROM login_tokens WHERE account_id = ? ORDER BY created_at",
      [accountId],
    ).map((row) => ({
      id: row.id,
      label: row.label,
      createdAt: row.created_at,
      lastUsedAt: row.last_used_at,
    }));
  }

  /**
   * Returns all login tokens across all accounts, each with its owning account's
   * total instance count. Intended for the `xacpx-relay ls` command output.
   */
  listTokens(): Array<{ id: string; label: string | null; createdAt: string; accountId: string; instanceCount: number }> {
    return this.db.all<{
      id: string;
      label: string | null;
      created_at: string;
      account_id: string;
      instance_count: number;
    }>(
      `SELECT lt.id, lt.label, lt.created_at, lt.account_id,
        (SELECT COUNT(*) FROM instances i WHERE i.account_id = lt.account_id) AS instance_count
       FROM login_tokens lt
       ORDER BY lt.created_at`,
    ).map((row) => ({
      id: row.id,
      label: row.label,
      createdAt: row.created_at,
      accountId: row.account_id,
      instanceCount: row.instance_count,
    }));
  }

  /**
   * Resolves a token value or id/prefix to the owning account_id.
   * Try order:
   *   1. Raw token value hash lookup (resolveLoginToken)
   *   2. Exact id match in login_tokens
   *   3. Unique prefix match (WHERE id LIKE ? || '%') — accepts only if exactly one row
   * Returns null if not found or prefix is ambiguous.
   */
  accountIdForToken(valueOrId: string): string | null {
    // 1. Try raw token value
    const byValue = this._resolveLoginToken(valueOrId);
    if (byValue) return byValue.account.id;

    // 2. Try exact id
    const byId = this.db.get<{ account_id: string }>(
      "SELECT account_id FROM login_tokens WHERE id = ?",
      [valueOrId],
    );
    if (byId) return byId.account_id;

    // 3. Try prefix
    const byPrefix = this.db.all<{ account_id: string }>(
      "SELECT account_id FROM login_tokens WHERE id LIKE ? || '%'",
      [valueOrId],
    );
    if (byPrefix.length === 1) return byPrefix[0]!.account_id;

    return null;
  }

  revokeLoginToken(tokenId: string): boolean {
    // SELECT-then-DELETE is not atomic, but the hub is single-writer so no
    // concurrent revoke can race between these statements (same pattern as instances.ts).
    const existing = this.db.get<{ id: string }>(
      "SELECT id FROM login_tokens WHERE id = ?",
      [tokenId],
    );
    if (!existing) return false;
    this.db.run("DELETE FROM web_sessions WHERE login_token_id = ?", [tokenId]);
    this.db.run("DELETE FROM login_tokens WHERE id = ?", [tokenId]);
    return true;
  }

  createWebSession(accountId: string, loginTokenId: string, ttlMs: number): string {
    const token = generateToken();
    const expiresAt = new Date(this.now().getTime() + ttlMs).toISOString();
    this.db.run(
      "INSERT INTO web_sessions (token_hash, account_id, login_token_id, expires_at) VALUES (?, ?, ?, ?)",
      [hashToken(token), accountId, loginTokenId, expiresAt],
    );
    return token;
  }

  getSessionAccount(token: string): AccountRow | null {
    const row = this.db.get<{ account_id: string; expires_at: string }>(
      "SELECT account_id, expires_at FROM web_sessions WHERE token_hash = ?",
      [hashToken(token)],
    );
    if (!row || new Date(row.expires_at).getTime() <= this.now().getTime()) return null;
    return this.findById(row.account_id);
  }

  deleteWebSession(token: string): void {
    this.db.run("DELETE FROM web_sessions WHERE token_hash = ?", [hashToken(token)]);
  }

  deleteAccountCascade(accountId: string): void {
    this.db.exec("BEGIN");
    try {
      this.db.run(
        "DELETE FROM messages WHERE instance_id IN (SELECT id FROM instances WHERE account_id = ?)",
        [accountId],
      );
      this.db.run("DELETE FROM instances WHERE account_id = ?", [accountId]);
      this.db.run("DELETE FROM pairing_tokens WHERE account_id = ?", [accountId]);
      this.db.run("DELETE FROM web_sessions WHERE account_id = ?", [accountId]);
      this.db.run("DELETE FROM push_subscriptions WHERE account_id = ?", [accountId]);
      this.db.run("DELETE FROM login_tokens WHERE account_id = ?", [accountId]);
      this.db.run("DELETE FROM accounts WHERE id = ?", [accountId]);
      this.db.exec("COMMIT");
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }

  /** Deletes expired web sessions. Returns rows removed. */
  pruneExpired(now: Date): number {
    const iso = now.toISOString();
    const ws = this.db.get<{ n: number }>(
      "SELECT COUNT(*) AS n FROM web_sessions WHERE expires_at <= ?",
      [iso],
    );
    this.db.run("DELETE FROM web_sessions WHERE expires_at <= ?", [iso]);
    return ws?.n ?? 0;
  }

  /** CLI-only mint: the plaintext code is returned exactly once; only its hash is stored. */
  issueInviteCode(label: string | undefined, ttlMs: number): { id: string; code: string; expiresAt: string } {
    const id = randomUUID();
    const code = generateToken();
    const nowMs = this.now().getTime();
    const expiresAt = new Date(nowMs + ttlMs).toISOString();
    this.db.run(
      "INSERT INTO invite_codes (id, code_hash, label, created_at, expires_at) VALUES (?, ?, ?, ?, ?)",
      [id, hashToken(code), label ?? null, new Date(nowMs).toISOString(), expiresAt],
    );
    return { id, code, expiresAt };
  }

  /**
   * Single-use redeem: uniform null for unknown/used/expired (no oracle for
   * guessing attempts, same as redeemPairingToken). Marks the code used and
   * creates the new account + login token in one transaction.
   */
  redeemInviteCode(code: string): { token: string; username: string; accountId: string; loginTokenId: string } | null {
    const codeHash = hashToken(code);
    const row = this.db.get<{ id: string; label: string | null; expires_at: string; used_at: string | null }>(
      "SELECT id, label, expires_at, used_at FROM invite_codes WHERE code_hash = ?",
      [codeHash],
    );
    if (!row || row.used_at !== null || new Date(row.expires_at).getTime() <= this.now().getTime()) {
      return null;
    }
    const nowIso = this.now().toISOString();
    const accountId = randomUUID();
    const username = `u-${randomUUID()}`;
    const loginTokenId = randomUUID();
    const token = generateToken();
    this.db.exec("BEGIN");
    try {
      this.db.run(
        "UPDATE invite_codes SET used_at = ?, used_account_id = ? WHERE code_hash = ? AND used_at IS NULL",
        [nowIso, accountId, codeHash],
      );
      this.db.run(
        "INSERT INTO accounts (id, username, created_at) VALUES (?, ?, ?)",
        [accountId, username, nowIso],
      );
      this.db.run(
        "INSERT INTO login_tokens (id, token_hash, account_id, label, created_at, last_used_at) VALUES (?, ?, ?, ?, ?, NULL)",
        [loginTokenId, hashToken(token), accountId, row.label, nowIso],
      );
      this.db.exec("COMMIT");
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
    return { token, username, accountId, loginTokenId };
  }

  listInviteCodes(): Array<{ id: string; label: string | null; createdAt: string; expiresAt: string; usedAt: string | null }> {
    return this.db.all<{
      id: string;
      label: string | null;
      created_at: string;
      expires_at: string;
      used_at: string | null;
    }>(
      "SELECT id, label, created_at, expires_at, used_at FROM invite_codes ORDER BY created_at",
    ).map((row) => ({
      id: row.id,
      label: row.label,
      createdAt: row.created_at,
      expiresAt: row.expires_at,
      usedAt: row.used_at,
    }));
  }

  /**
   * Resolves an invite code value or id/prefix to the invite id, mirroring
   * accountIdForToken: raw code hash, then exact id, then unique id prefix.
   */
  inviteIdFor(valueOrId: string): string | null {
    const byValue = this.db.get<{ id: string }>(
      "SELECT id FROM invite_codes WHERE code_hash = ?",
      [hashToken(valueOrId)],
    );
    if (byValue) return byValue.id;

    const byId = this.db.get<{ id: string }>(
      "SELECT id FROM invite_codes WHERE id = ?",
      [valueOrId],
    );
    if (byId) return byId.id;

    const byPrefix = this.db.all<{ id: string }>(
      "SELECT id FROM invite_codes WHERE id LIKE ? || '%'",
      [valueOrId],
    );
    if (byPrefix.length === 1) return byPrefix[0]!.id;

    return null;
  }

  removeInviteCode(id: string): boolean {
    const existing = this.db.get<{ id: string }>(
      "SELECT id FROM invite_codes WHERE id = ?",
      [id],
    );
    if (!existing) return false;
    this.db.run("DELETE FROM invite_codes WHERE id = ?", [id]);
    return true;
  }

  /**
   * Deletes expired or already-used invite codes. Returns rows removed.
   * Runs on the hourly maintenance pass, so a "used" row is only visible in
   * `xacpx-relay ls` until the next pass (same lifecycle as pairing tokens).
   */
  pruneInviteCodes(now: Date): number {
    const iso = now.toISOString();
    const row = this.db.get<{ n: number }>(
      "SELECT COUNT(*) AS n FROM invite_codes WHERE expires_at <= ? OR used_at IS NOT NULL",
      [iso],
    );
    this.db.run("DELETE FROM invite_codes WHERE expires_at <= ? OR used_at IS NOT NULL", [iso]);
    return row?.n ?? 0;
  }
}
