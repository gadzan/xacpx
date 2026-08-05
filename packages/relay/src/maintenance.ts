import type { AccountStore } from "./stores/accounts.js";
import type { InstanceStore } from "./stores/instances.js";
import type { MessageStore } from "./stores/messages.js";
import type { RecoveryReceiptStore } from "./stores/recovery-receipts.js";

/** How long a recovery receipt stays useful. The connector's finished-offline FIFO
 *  caps at 32 turns and evicts on overflow, so a receipt older than this can never
 *  be re-delivered — keeping it only grows the table forever (one row per turn). */
export const RECOVERY_RECEIPT_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export interface MaintenanceStores {
  accounts: AccountStore;
  instances: InstanceStore;
  messages: MessageStore;
  recoveryReceipts: RecoveryReceiptStore;
}

export interface MaintenanceOptions {
  historyRetentionDays: number;
  maxPerSession: number;
  /** TTL for recovery_receipts rows; defaults to RECOVERY_RECEIPT_TTL_MS. */
  recoveryReceiptTtlMs?: number;
  now?: () => Date;
}

export interface MaintenanceSummary {
  messagesDeleted: number;
  sessionsDeleted: number;
  pairingTokensDeleted: number;
  inviteCodesDeleted: number;
  receiptsDeleted: number;
}

/** Runs one maintenance pass: prune old/excess messages, GC expired sessions/pairing tokens/invite codes. */
export function runMaintenance(stores: MaintenanceStores, opts: MaintenanceOptions): MaintenanceSummary {
  const now = (opts.now ?? (() => new Date()))();
  const messagesDeleted = stores.messages.prune({
    maxAgeMs: opts.historyRetentionDays * 24 * 60 * 60 * 1000,
    maxPerSession: opts.maxPerSession,
  });
  const sessionsDeleted = stores.accounts.pruneExpired(now);
  const pairingTokensDeleted = stores.instances.prunePairingTokens(now);
  const inviteCodesDeleted = stores.accounts.pruneInviteCodes(now);
  const receiptsDeleted = stores.recoveryReceipts.prune(opts.recoveryReceiptTtlMs ?? RECOVERY_RECEIPT_TTL_MS, now);
  return { messagesDeleted, sessionsDeleted, pairingTokensDeleted, inviteCodesDeleted, receiptsDeleted };
}

/** Starts a periodic maintenance loop. Returns a stop function. */
export function startMaintenanceLoop(
  stores: MaintenanceStores,
  opts: MaintenanceOptions,
  intervalMs: number,
  onError?: (err: unknown) => void,
): () => void {
  const tick = () => {
    try {
      runMaintenance(stores, opts);
    } catch (err) {
      onError?.(err);
    }
  };
  const timer = setInterval(tick, intervalMs);
  if (typeof timer === "object" && timer && "unref" in timer) (timer as { unref: () => void }).unref();
  return () => clearInterval(timer);
}
