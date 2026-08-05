import type { SqlDriver } from "../db.js";

/**
 * Cross-restart dedup ledger for recovered offline turns. The connector stamps every
 * `turn-finished` (live or offline) with a stable `recoveryId`; once this hub has
 * committed that turn's rows it records a receipt here so a RE-delivered
 * `instance.state.sync` (connector never got the ack, or the hub restarted again and
 * the in-memory fingerprint set died) is deduped instead of re-appended. Rows are
 * written in the SAME transaction as the messages they vouch for — a receipt without
 * its rows (or rows without a receipt) can never exist.
 *
 * Growth is bounded by the maintenance loop (`RecoveryReceiptStore.prune`): a
 * receipt is only useful while the connector could still re-deliver the turn, and the
 * connector's finished-offline FIFO holds at most 32 turns, so old rows are dead
 * weight. See RECOVERY_RECEIPT_TTL_MS in maintenance.ts.
 */
export class RecoveryReceiptStore {
  constructor(private readonly db: SqlDriver) {}

  has(instanceId: string, recoveryId: string): boolean {
    return this.db.get<{ found: number }>(
      "SELECT 1 AS found FROM recovery_receipts WHERE instance_id = ? AND recovery_id = ?",
      [instanceId, recoveryId],
    ) !== undefined;
  }

  /** Idempotent; safe to call from inside a `db.transaction` alongside the message rows. */
  remember(instanceId: string, recoveryId: string, nowIso?: string): void {
    this.db.run(
      "INSERT OR IGNORE INTO recovery_receipts (instance_id, recovery_id, created_at) VALUES (?,?,?)",
      [instanceId, recoveryId, nowIso ?? new Date().toISOString()],
    );
  }

  /** Deletes receipts older than maxAgeMs. Returns rows removed. */
  prune(maxAgeMs: number, now: Date = new Date()): number {
    const cutoff = new Date(now.getTime() - maxAgeMs).toISOString();
    const row = this.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM recovery_receipts WHERE created_at < ?", [cutoff]);
    this.db.run("DELETE FROM recovery_receipts WHERE created_at < ?", [cutoff]);
    return row?.n ?? 0;
  }
}
