import { RECOVERY_RETENTION_MS } from "@ganglion/xacpx-relay-protocol";

import type { AccountStore } from "./stores/accounts.js";
import type { InstanceStore } from "./stores/instances.js";
import type { MessageStore } from "./stores/messages.js";
import type { RecoveryReceiptStore } from "./stores/recovery-receipts.js";

/** Clock-skew grace on top of the shared retention horizon: the connector evicts a
 *  pendingFinished entry at RECOVERY_RETENTION_MS, so the hub only needs its receipt
 *  to survive until the moment of the (latest possible) redelivery — the grace
 *  absorbs delivery delay and wall-clock drift between the two hosts so a redelivery
 *  made just under the connector's expiry always still finds its receipt. */
export const RECOVERY_RECEIPT_TTL_MS = RECOVERY_RETENTION_MS + 24 * 60 * 60 * 1000;

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
