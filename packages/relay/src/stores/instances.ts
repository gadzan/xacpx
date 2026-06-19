import { randomUUID } from "node:crypto";

import { generateToken, hashEquals, hashToken } from "../auth.js";
import type { SqlDriver } from "../db.js";

export interface InstanceRow {
  id: string;
  accountId: string;
  name: string;
  coreVersion: string | null;
  lastSeenAt: string | null;
  createdAt: string;
}

export interface RedeemedInstance {
  instanceId: string;
  credential: string;
  accountId: string;
  name: string;
}

interface InstanceStoreOptions {
  now?: () => Date;
}

export class InstanceStore {
  private readonly now: () => Date;

  constructor(private readonly db: SqlDriver, options: InstanceStoreOptions = {}) {
    this.now = options.now ?? (() => new Date());
  }

  issuePairingToken(accountId: string, name: string | undefined, ttlMs: number): { token: string; expiresAt: string } {
    const token = generateToken();
    const expiresAt = new Date(this.now().getTime() + ttlMs).toISOString();
    this.db.run(
      "INSERT INTO pairing_tokens (token_hash, account_id, name, expires_at) VALUES (?, ?, ?, ?)",
      [hashToken(token), accountId, name ?? null, expiresAt],
    );
    return { token, expiresAt };
  }

  /**
   * Creates a new instance for an account directly (without a pairing token).
   * Used when the connector presents a login token instead of a pairing token.
   */
  registerInstanceForAccount(accountId: string, name: string | undefined, coreVersion?: string): RedeemedInstance {
    const instanceId = randomUUID();
    const credential = generateToken();
    const nowIso = this.now().toISOString();
    const instanceName = name ?? `instance-${instanceId.slice(0, 8)}`;
    this.db.run(
      "INSERT INTO instances (id, account_id, name, credential_hash, core_version, created_at) VALUES (?, ?, ?, ?, ?, ?)",
      [instanceId, accountId, instanceName, hashToken(credential), coreVersion ?? null, nowIso],
    );
    return { instanceId, credential, accountId, name: instanceName };
  }

  /** Single-use: marks the token used and creates the instance row atomically-enough for our single-writer server. */
  redeemPairingToken(token: string, coreVersion?: string): RedeemedInstance | null {
    const tokenHash = hashToken(token);
    const row = this.db.get<{ account_id: string; name: string | null; expires_at: string; used_at: string | null }>(
      "SELECT account_id, name, expires_at, used_at FROM pairing_tokens WHERE token_hash = ?",
      [tokenHash],
    );
    const nowIso = this.now().toISOString();
    if (!row || row.used_at !== null || new Date(row.expires_at).getTime() <= this.now().getTime()) {
      return null;
    }
    this.db.run("UPDATE pairing_tokens SET used_at = ? WHERE token_hash = ?", [nowIso, tokenHash]);
    const instanceId = randomUUID();
    const credential = generateToken();
    const name = row.name ?? `instance-${instanceId.slice(0, 8)}`;
    this.db.run(
      "INSERT INTO instances (id, account_id, name, credential_hash, core_version, created_at) VALUES (?, ?, ?, ?, ?, ?)",
      [instanceId, row.account_id, name, hashToken(credential), coreVersion ?? null, nowIso],
    );
    return { instanceId, credential, accountId: row.account_id, name };
  }

  verifyCredential(instanceId: string, credential: string): InstanceRow | null {
    const row = this.db.get<{
      id: string; account_id: string; name: string; credential_hash: string;
      core_version: string | null; last_seen_at: string | null; created_at: string;
    }>("SELECT * FROM instances WHERE id = ?", [instanceId]);
    if (!row || !hashEquals(row.credential_hash, hashToken(credential))) return null;
    return toInstanceRow(row);
  }

  touch(instanceId: string, coreVersion?: string): void {
    if (coreVersion !== undefined) {
      this.db.run("UPDATE instances SET last_seen_at = ?, core_version = ? WHERE id = ?", [
        this.now().toISOString(), coreVersion, instanceId,
      ]);
      return;
    }
    this.db.run("UPDATE instances SET last_seen_at = ? WHERE id = ?", [this.now().toISOString(), instanceId]);
  }

  listByAccount(accountId: string): InstanceRow[] {
    return this.db
      .all<{
        id: string; account_id: string; name: string; credential_hash: string;
        core_version: string | null; last_seen_at: string | null; created_at: string;
      }>("SELECT * FROM instances WHERE account_id = ? ORDER BY created_at", [accountId])
      .map(toInstanceRow);
  }

  getOwned(instanceId: string, accountId: string): InstanceRow | null {
    const row = this.db.get<{
      id: string; account_id: string; name: string; credential_hash: string;
      core_version: string | null; last_seen_at: string | null; created_at: string;
    }>("SELECT * FROM instances WHERE id = ? AND account_id = ?", [instanceId, accountId]);
    return row ? toInstanceRow(row) : null;
  }

  remove(instanceId: string, accountId: string): boolean {
    if (!this.getOwned(instanceId, accountId)) return false;
    this.db.run("DELETE FROM instances WHERE id = ?", [instanceId]);
    return true;
  }

  rename(instanceId: string, accountId: string, name: string): boolean {
    if (!this.getOwned(instanceId, accountId)) return false;
    this.db.run("UPDATE instances SET name = ? WHERE id = ?", [name, instanceId]);
    return true;
  }

  /** Deletes expired or already-used pairing tokens. Returns rows removed. */
  prunePairingTokens(now: Date): number {
    const iso = now.toISOString();
    const row = this.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM pairing_tokens WHERE expires_at <= ? OR used_at IS NOT NULL", [iso]);
    this.db.run("DELETE FROM pairing_tokens WHERE expires_at <= ? OR used_at IS NOT NULL", [iso]);
    return row?.n ?? 0;
  }
}

function toInstanceRow(row: {
  id: string; account_id: string; name: string;
  core_version: string | null; last_seen_at: string | null; created_at: string;
}): InstanceRow {
  return {
    id: row.id,
    accountId: row.account_id,
    name: row.name,
    coreVersion: row.core_version,
    lastSeenAt: row.last_seen_at,
    createdAt: row.created_at,
  };
}
