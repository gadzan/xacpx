import type { SqlDriver } from "../db.js";

export interface PushSubscriptionRow {
  accountId: string;
  endpoint: string;
  p256dh: string;
  auth: string;
  createdAt: string;
}

interface PushSubscriptionStoreOptions {
  now?: () => Date;
}

const BATCH_LIMIT = 100;

/** Browser push subscriptions per account. FKs are OFF by codebase invariant —
 *  account deletion cascades via deleteByAccount from the account removal path. */
export class PushSubscriptionStore {
  private readonly now: () => Date;

  constructor(private readonly db: SqlDriver, options: PushSubscriptionStoreOptions = {}) {
    this.now = options.now ?? (() => new Date());
  }

  /** Idempotent per endpoint: the unique index on endpoint makes this a re-bind
   *  when the same browser re-subscribes under a different account. */
  upsert(input: { accountId: string; endpoint: string; p256dh: string; auth: string }): void {
    this.db.run(
      `INSERT INTO push_subscriptions (account_id, endpoint, p256dh, auth, created_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(endpoint) DO UPDATE SET
         account_id = excluded.account_id,
         p256dh = excluded.p256dh,
         auth = excluded.auth`,
      [input.accountId, input.endpoint, input.p256dh, input.auth, this.now().toISOString()],
    );
  }

  listByAccount(accountId: string): PushSubscriptionRow[] {
    const rows: PushSubscriptionRow[] = [];
    for (;;) {
      const batch = this.db.all<{
        account_id: string; endpoint: string; p256dh: string; auth: string; created_at: string;
      }>(
        "SELECT account_id, endpoint, p256dh, auth, created_at FROM push_subscriptions WHERE account_id = ? LIMIT ? OFFSET ?",
        [accountId, BATCH_LIMIT, rows.length],
      );
      rows.push(...batch.map((r) => ({
        accountId: r.account_id, endpoint: r.endpoint, p256dh: r.p256dh, auth: r.auth, createdAt: r.created_at,
      })));
      if (batch.length < BATCH_LIMIT) break;
    }
    return rows;
  }

  deleteByEndpoint(endpoint: string): boolean {
    const existed = this.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM push_subscriptions WHERE endpoint = ?", [endpoint]);
    this.db.run("DELETE FROM push_subscriptions WHERE endpoint = ?", [endpoint]);
    return (existed?.n ?? 0) > 0;
  }

  deleteByEndpointAndAccount(accountId: string, endpoint: string): boolean {
    const existed = this.db.get<{ n: number }>(
      "SELECT COUNT(*) AS n FROM push_subscriptions WHERE account_id = ? AND endpoint = ?", [accountId, endpoint]);
    this.db.run("DELETE FROM push_subscriptions WHERE account_id = ? AND endpoint = ?", [accountId, endpoint]);
    return (existed?.n ?? 0) > 0;
  }

  deleteByAccount(accountId: string): number {
    const counted = this.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM push_subscriptions WHERE account_id = ?", [accountId])?.n ?? 0;
    this.db.run("DELETE FROM push_subscriptions WHERE account_id = ?", [accountId]);
    return counted;
  }
}
