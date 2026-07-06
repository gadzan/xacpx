import type { Agent } from "./agent/interface.js";
import {
  clearAllWeixinAccounts,
  DEFAULT_BASE_URL,
  listWeixinAccountIds,
  loadWeixinAccount,
  normalizeAccountId,
  registerWeixinAccountId,
  resolveWeixinAccount,
  saveWeixinAccount,
} from "./auth/accounts.js";
import {
  DEFAULT_ILINK_BOT_TYPE,
  startWeixinLoginWithQr,
  waitForWeixinLogin,
} from "./auth/login-qr.js";
import {
  clearContextTokensForAccount,
  restoreContextTokens,
} from "./messaging/inbound.js";
import { monitorWeixinProvider } from "./monitor/monitor.js";
import type { PendingFinalChunk } from "./messaging/quota-manager.js";
import type { RuntimeMediaStore } from "../channels/media-store.js";
import type { PerfTracer } from "../perf/perf-tracer.js";
import type { ActiveTurnRegistry } from "../sessions/active-turn-registry.js";
import { t } from "../i18n/index.js";

export type LoginOptions = {
  /** Override the API base URL. */
  baseUrl?: string;
  /** Log callback (defaults to console.log). */
  log?: (msg: string) => void;
};

export type StartOptions = {
  /** Account ID to use. Auto-selects the first registered account if omitted. */
  accountId?: string;
  /** Additional allowed root directories for outbound media paths. */
  allowedMediaRoots?: string[];
  /** AbortSignal to stop the bot. */
  abortSignal?: AbortSignal;
  /** Log callback (defaults to console.log). */
  log?: (msg: string) => void;
  /** Reset outbound quota when an inbound message arrives. */
  onInbound?: (chatKey: string) => void;
  /** Reserve the per-chat final-tier slot before sending the final reply.
   * Returns false when the final tier (FINAL_BUDGET) is exhausted; callers
   * must drop the send and log when this happens. */
  reserveFinal?: (chatKey: string) => boolean;
  // v1.4: pagination wiring forwarded into the message turn pipeline.
  finalRemaining?: (chatKey: string) => number;
  hasPendingFinal?: (chatKey: string) => boolean;
  drainPendingFinal?: (chatKey: string, available: number) => PendingFinalChunk[];
  prependPendingFinal?: (chatKey: string, chunks: PendingFinalChunk[]) => void;
  enqueuePendingFinal?: (chatKey: string, chunks: PendingFinalChunk[]) => void;
  dropPendingFinal?: (chatKey: string) => void;
  mediaStore?: RuntimeMediaStore;
  perfTracer?: PerfTracer;
  /** Read the chat's current session synchronously for dispatch-time binding. */
  peekCurrentSessionAlias?: (chatKey: string) => string | undefined;
  /** Persist a background turn's final result for later replay. */
  setBackgroundResult?: (
    chatKey: string,
    alias: string,
    result: { text: string; status: "done" | "error"; finished_at: string },
  ) => Promise<void>;
  /** Shared in-flight turn registry for dispatch-time foreground tracking. */
  activeTurns?: ActiveTurnRegistry;
};

/**
 * Interactive QR-code login. Prints the QR code to the terminal and waits
 * for the user to scan it with WeChat.
 *
 * Returns the normalized account ID on success.
 */
export async function login(opts?: LoginOptions): Promise<string> {
  const log = opts?.log ?? console.log;
  const apiBaseUrl = opts?.baseUrl ?? DEFAULT_BASE_URL;

  log(t().login.startingLogin);

  const startResult = await startWeixinLoginWithQr({
    apiBaseUrl,
    botType: DEFAULT_ILINK_BOT_TYPE,
  });

  if (!startResult.qrcodeUrl) {
    throw new Error(startResult.message);
  }

  log(t().login.scanInstruction);
  try {
    const qrcodeterminal = await import("qrcode-terminal");
    await new Promise<void>((resolve) => {
      qrcodeterminal.default.generate(startResult.qrcodeUrl!, { small: true }, (qr: string) => {
        console.log(qr);
        resolve();
      });
    });
  } catch {
    log(t().login.qrLinkFallback(startResult.qrcodeUrl!));
  }

  log(t().login.waitingForScan);

  const waitResult = await waitForWeixinLogin({
    sessionKey: startResult.sessionKey,
    apiBaseUrl,
    timeoutMs: 480_000,
    botType: DEFAULT_ILINK_BOT_TYPE,
  });

  if (!waitResult.connected || !waitResult.botToken || !waitResult.accountId) {
    throw new Error(waitResult.message);
  }

  const normalizedId = normalizeAccountId(waitResult.accountId);
  saveWeixinAccount(normalizedId, {
    token: waitResult.botToken,
    baseUrl: waitResult.baseUrl,
    userId: waitResult.userId,
  });
  registerWeixinAccountId(normalizedId);

  log(t().login.loginSuccessLine);
  return normalizedId;
}

/**
 * Remove all stored WeChat account credentials.
 */
export function logout(opts?: { log?: (msg: string) => void }): void {
  const log = opts?.log ?? console.log;
  const ids = listWeixinAccountIds();
  if (ids.length === 0) {
    log(t().login.noAccountsLoggedIn);
    return;
  }
  for (const id of ids) clearContextTokensForAccount(id);
  clearAllWeixinAccounts();
  log(t().login.logoutSuccess);
}

/**
 * Check whether at least one WeChat account is logged in and configured.
 */
export function isLoggedIn(): boolean {
  const ids = listWeixinAccountIds();
  if (ids.length === 0) return false;
  const account = resolveWeixinAccount(ids[0]);
  return account.configured;
}

/**
 * Start the bot — long-polls for new messages and dispatches them to the agent.
 * Blocks until the abort signal fires or an unrecoverable error occurs.
 */
export async function start(agent: Agent, opts?: StartOptions): Promise<void> {
  const log = opts?.log ?? console.log;

  // Resolve account
  let accountId = opts?.accountId;
  if (!accountId) {
    const ids = listWeixinAccountIds();
    if (ids.length === 0) {
      throw new Error(t().login.noAccountsError);
    }
    accountId = ids[0];
    if (ids.length > 1) {
      log(t().misc.weixinMultipleAccounts(accountId!));
    }
  }

  const account = resolveWeixinAccount(accountId);
  if (!account.configured) {
    throw new Error(t().login.accountNotConfigured(accountId!));
  }

  restoreContextTokens(account.accountId);

  log(t().misc.weixinBotStarting(account.accountId));

  await monitorWeixinProvider({
    baseUrl: account.baseUrl,
    cdnBaseUrl: account.cdnBaseUrl,
    ...(opts?.allowedMediaRoots ? { allowedMediaRoots: opts.allowedMediaRoots } : {}),
    token: account.token,
    accountId: account.accountId,
    agent,
    abortSignal: opts?.abortSignal,
    log,
    ...(opts?.onInbound ? { onInbound: opts.onInbound } : {}),
    ...(opts?.reserveFinal ? { reserveFinal: opts.reserveFinal } : {}),
    ...(opts?.finalRemaining ? { finalRemaining: opts.finalRemaining } : {}),
    ...(opts?.hasPendingFinal ? { hasPendingFinal: opts.hasPendingFinal } : {}),
    ...(opts?.drainPendingFinal ? { drainPendingFinal: opts.drainPendingFinal } : {}),
    ...(opts?.prependPendingFinal ? { prependPendingFinal: opts.prependPendingFinal } : {}),
    ...(opts?.enqueuePendingFinal ? { enqueuePendingFinal: opts.enqueuePendingFinal } : {}),
    ...(opts?.dropPendingFinal ? { dropPendingFinal: opts.dropPendingFinal } : {}),
    ...(opts?.mediaStore ? { mediaStore: opts.mediaStore } : {}),
    ...(opts?.perfTracer ? { perfTracer: opts.perfTracer } : {}),
    ...(opts?.peekCurrentSessionAlias
      ? { peekCurrentSessionAlias: opts.peekCurrentSessionAlias }
      : {}),
    ...(opts?.setBackgroundResult ? { setBackgroundResult: opts.setBackgroundResult } : {}),
    ...(opts?.activeTurns ? { activeTurns: opts.activeTurns } : {}),
  });
}
