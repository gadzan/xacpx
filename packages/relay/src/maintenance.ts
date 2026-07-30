import type { AccountStore } from "./stores/accounts.js";
import type { InstanceStore } from "./stores/instances.js";
import type { MessageStore } from "./stores/messages.js";

export interface MaintenanceStores {
  accounts: AccountStore;
  instances: InstanceStore;
  messages: MessageStore;
}

export interface MaintenanceOptions {
  historyRetentionDays: number;
  maxPerSession: number;
  now?: () => Date;
}

export interface MaintenanceSummary {
  messagesDeleted: number;
  sessionsDeleted: number;
  pairingTokensDeleted: number;
  inviteCodesDeleted: number;
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
  return { messagesDeleted, sessionsDeleted, pairingTokensDeleted, inviteCodesDeleted };
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
