import type { Agent } from "../agent/interface.js";
import { getUpdates } from "../api/api.js";
import { WeixinConfigManager } from "../api/config-cache.js";
import { SESSION_EXPIRED_ERRCODE, pauseSession } from "../api/session-guard.js";
import { createConversationExecutor } from "../../runtime/conversation-executor.js";
import {
  buildWeixinChatKey,
  getWeixinMessageTurnLane,
  handleWeixinMessageTurn,
} from "../messaging/handle-weixin-message-turn.js";
import type { PendingFinalChunk } from "../messaging/quota-manager.js";
import type { ActiveTurnRegistry } from "../../sessions/active-turn-registry.js";
import type { RuntimeMediaStore } from "../../channels/media-store.js";
import type { PerfTracer } from "../../perf/perf-tracer.js";
import { MessageItemType, type MessageItem } from "../api/types.js";
import { getSyncBufFilePath, loadGetUpdatesBuf, saveGetUpdatesBuf } from "../storage/sync-buf.js";
import { weixinLog } from "../util/weixin-log";
import { redactBody } from "../util/redact.js";
import { resolveWeixinAccount, listWeixinAccountIds } from "../auth/accounts.js";
import { resetSessionPause } from "../api/session-guard.js";
import { clearContextTokensForAccount, restoreContextTokens } from "../messaging/inbound.js";

const DEFAULT_LONG_POLL_TIMEOUT_MS = 35_000;
const MAX_CONSECUTIVE_FAILURES = 3;
const BACKOFF_DELAY_MS = 30_000;
const RETRY_DELAY_MS = 2_000;
const CREDENTIAL_RECOVERY_POLL_INTERVAL_MS = 30_000;

export type MonitorWeixinOpts = {
  baseUrl: string;
  cdnBaseUrl: string;
  token?: string;
  accountId: string;
  agent: Agent;
  abortSignal?: AbortSignal;
  longPollTimeoutMs?: number;
  log?: (msg: string) => void;
  onInbound?: (chatKey: string) => void;
  reserveFinal?: (chatKey: string) => boolean;
  // v1.4: pending-final pagination wiring. `dropPendingFinal` is fired
  // alongside `onInbound` when the inbound is anything OTHER than `/jx` —
  // this enforces the "user moved on, drop unfinished pages" policy.
  // `finalRemaining`, `hasPendingFinal`, `drainPendingFinal`, and
  // `enqueuePendingFinal` are forwarded into the message turn / slash command
  // pipeline so wave-sending and `/jx` drain can happen.
  finalRemaining?: (chatKey: string) => number;
  hasPendingFinal?: (chatKey: string) => boolean;
  drainPendingFinal?: (chatKey: string, available: number) => PendingFinalChunk[];
  prependPendingFinal?: (chatKey: string, chunks: PendingFinalChunk[]) => void;
  enqueuePendingFinal?: (chatKey: string, chunks: PendingFinalChunk[]) => void;
  dropPendingFinal?: (chatKey: string) => void;
  mediaStore?: RuntimeMediaStore;
  allowedMediaRoots?: string[];
  perfTracer?: PerfTracer;
  // Dispatch-time session binding: read the chat's current session synchronously
  // so prompts bind to the session that was current when the message arrived.
  peekCurrentSessionAlias?: (chatKey: string) => string | undefined;
  // Persist a background turn's final result for later replay when the chat has
  // since switched away from the session that produced it.
  setBackgroundResult?: (
    chatKey: string,
    alias: string,
    result: { text: string; status: "done" | "error"; finished_at: string },
  ) => Promise<void>;
  // Shared registry of in-flight (chatKey, alias) turns.
  activeTurns?: ActiveTurnRegistry;
};

function extractInboundText(itemList?: MessageItem[]): string {
  if (!itemList?.length) return "";
  for (const item of itemList) {
    if (item.type === MessageItemType.TEXT && item.text_item?.text != null) {
      return String(item.text_item.text);
    }
  }
  return "";
}

function parseSlashCommand(textBody: string): string | null {
  const trimmed = textBody.trim();
  if (!trimmed.startsWith("/")) return null;
  const spaceIdx = trimmed.indexOf(" ");
  return spaceIdx === -1 ? trimmed.toLowerCase() : trimmed.slice(0, spaceIdx).toLowerCase();
}

function shouldFetchTypingConfig(textBody: string): boolean {
  const command = parseSlashCommand(textBody);
  if (!command) return true;

  // These commands are fast local/control paths and intentionally do not show
  // typing. Skipping getConfig keeps control commands (especially /cancel and
  // /stop) from being blocked by a typing-ticket fetch before lane dispatch.
  //
  // /clear is deliberately NOT listed here: resetting/recreating a session can
  // take noticeable time, so handleWeixinMessageTurn wraps /clear with typing.
  return !["/cancel", "/stop", "/jx", "/echo", "/toggle-debug"].includes(command);
}

/**
 * Long-poll loop: getUpdates → process message → call agent → send reply.
 * Runs until aborted.
 */
export async function monitorWeixinProvider(opts: MonitorWeixinOpts): Promise<void> {
  const {
    agent,
    abortSignal,
    longPollTimeoutMs,
  } = opts;
  let baseUrl = opts.baseUrl;
  let cdnBaseUrl = opts.cdnBaseUrl;
  let token = opts.token;
  let accountId = opts.accountId;
  const log = opts.log ?? ((msg: string) => console.log(msg));
  const errLog = (msg: string) => {
    log(msg);
    weixinLog.error("weixin.monitor.error", msg, { accountId });
  };

  log(`[weixin] monitor started (${baseUrl}, account=${accountId})`);
  weixinLog.info("weixin.monitor.started", "monitor started", { accountId, baseUrl });

  let syncFilePath = getSyncBufFilePath(accountId);
  const previousGetUpdatesBuf = loadGetUpdatesBuf(syncFilePath);
  let getUpdatesBuf = previousGetUpdatesBuf ?? "";

  if (previousGetUpdatesBuf) {
    log(`[weixin] resuming from previous sync buf (${getUpdatesBuf.length} bytes)`);
  } else {
    log(`[weixin] no previous sync buf, starting fresh`);
  }

  let configManager = new WeixinConfigManager({ baseUrl, token }, log);
  const conversationExecutor = createConversationExecutor();

  const seenMessageIds = new Set<number>();
  const messageIdOrder: number[] = [];
  const DEDUP_WINDOW = 100;

  let nextTimeoutMs = longPollTimeoutMs ?? DEFAULT_LONG_POLL_TIMEOUT_MS;
  let consecutiveFailures = 0;

  while (!abortSignal?.aborted) {
    try {
      const resp = await getUpdates({
        baseUrl,
        token,
        get_updates_buf: getUpdatesBuf,
        timeoutMs: nextTimeoutMs,
        abortSignal,
      });

      if (resp.longpolling_timeout_ms != null && resp.longpolling_timeout_ms > 0) {
        nextTimeoutMs = resp.longpolling_timeout_ms;
      }

      const isApiError =
        (resp.ret !== undefined && resp.ret !== 0) ||
        (resp.errcode !== undefined && resp.errcode !== 0);

      if (isApiError) {
        const isSessionExpired =
          resp.errcode === SESSION_EXPIRED_ERRCODE || resp.ret === SESSION_EXPIRED_ERRCODE;

        if (isSessionExpired) {
          const staleToken = token;
          const staleAccountId = accountId;
          errLog(
            `[weixin] session expired (errcode ${SESSION_EXPIRED_ERRCODE}), entering credential recovery. Please run \`xacpx login\` to re-login.`,
          );
          pauseSession(accountId);
          consecutiveFailures = 0;

          const recovered = await pollForFreshCredentials(
            staleAccountId,
            staleToken,
            log,
            abortSignal,
          );

          if (recovered === null) {
            weixinLog.info(
              "weixin.monitor.stopped",
              "monitor stopped (aborted during credential recovery)",
              { accountId },
            );
            return;
          }

          // Hot-swap credentials and reset all dependent state.
          const oldAccountId = accountId;
          accountId = recovered.accountId;
          baseUrl = recovered.baseUrl;
          cdnBaseUrl = recovered.cdnBaseUrl;
          token = recovered.token;
          syncFilePath = getSyncBufFilePath(accountId);
          const previousBuf = loadGetUpdatesBuf(syncFilePath);
          getUpdatesBuf = previousBuf ?? "";
          configManager = new WeixinConfigManager({ baseUrl, token }, log);
          seenMessageIds.clear();
          messageIdOrder.length = 0;
          consecutiveFailures = 0;
          nextTimeoutMs = longPollTimeoutMs ?? DEFAULT_LONG_POLL_TIMEOUT_MS;
          resetSessionPause(oldAccountId);
          resetSessionPause(accountId);
          if (oldAccountId !== accountId) {
            clearContextTokensForAccount(oldAccountId);
            restoreContextTokens(accountId);
          }
          log(`[weixin] credential recovered, resuming monitor with account=${accountId}`);
          continue;
        }

        consecutiveFailures += 1;
        errLog(
          `[weixin] getUpdates failed: ret=${resp.ret} errcode=${resp.errcode} errmsg=${resp.errmsg ?? ""} (${consecutiveFailures}/${MAX_CONSECUTIVE_FAILURES})`,
        );
        if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
          errLog(`[weixin] ${MAX_CONSECUTIVE_FAILURES} consecutive failures, backing off 30s`);
          consecutiveFailures = 0;
          await sleep(BACKOFF_DELAY_MS, abortSignal);
        } else {
          await sleep(RETRY_DELAY_MS, abortSignal);
        }
        continue;
      }

      consecutiveFailures = 0;

      if (resp.get_updates_buf != null && resp.get_updates_buf !== "") {
        saveGetUpdatesBuf(syncFilePath, resp.get_updates_buf);
        getUpdatesBuf = resp.get_updates_buf;
      }

      const list = resp.msgs ?? [];
      for (const full of list) {
        const msgId = full.message_id;
        if (msgId != null) {
          if (seenMessageIds.has(msgId)) {
            weixinLog.info("weixin.monitor.duplicate_message_skipped", "duplicate message skipped", {
              accountId,
              messageId: msgId,
            });
            continue;
          }
          seenMessageIds.add(msgId);
          messageIdOrder.push(msgId);
          if (messageIdOrder.length > DEDUP_WINDOW) {
            seenMessageIds.delete(messageIdOrder.shift()!);
          }
        }

        weixinLog.info("weixin.monitor.inbound", "inbound message received", {
          accountId,
          from: full.from_user_id,
          types: full.item_list?.map((i) => i.type).join(",") ?? "none",
        });

        const fromUserId = full.from_user_id ?? "";
        const inboundText = extractInboundText(full.item_list);
        const cachedConfig =
          fromUserId && shouldFetchTypingConfig(inboundText)
            ? await configManager.getForUser(fromUserId, full.context_token)
            : { typingTicket: "" };

        // Fire onInbound before lane queueing: a user reply during a long-running
        // prompt would otherwise sit behind the in-flight turn on the normal
        // lane, delaying quota reset until the prior task finishes — defeating
        // the heads-up "reply to continue" UX.
        //
        // v1.4: also drop pending paginated-final chunks unless the inbound is
        // `/jx` (the only command that drains pending). Doing this here in the
        // monitor — alongside onInbound, before lane queueing — keeps the
        // policy consistent with onInbound's "reset window immediately" intent.
        if (fromUserId) {
          opts.onInbound?.(fromUserId);
          if (opts.dropPendingFinal) {
            if (inboundText.trim().toLowerCase() !== "/jx") {
              opts.dropPendingFinal(fromUserId);
            }
          }
        }

        // Dispatch-time session binding. Capture the chat's current session at
        // the moment the message arrives. Prompts bind to that alias so a queued
        // prompt runs against the session that was current when the user sent it
        // — even if they switch sessions while it waits on the per-session lane.
        // Slash commands never bind: they act on whatever the chat context
        // resolves to when they actually run.
        const chatKey = buildWeixinChatKey(accountId, fromUserId);
        const isSlash = inboundText.trim().startsWith("/");
        const boundAlias = isSlash ? undefined : opts.peekCurrentSessionAlias?.(chatKey);
        // Serialize prompts per bound session; slash/unbound turns share the
        // chat-level lane.
        const sessionKey = boundAlias ?? "__chat__";
        // Foreground gate: this turn is foreground only while its bound session
        // is still the chat's current session at send time.
        const isForeground = boundAlias
          ? () => opts.peekCurrentSessionAlias?.(chatKey) === boundAlias
          : undefined;

        if (boundAlias) {
          opts.activeTurns?.markActive(chatKey, boundAlias);
        }

        const runPromise = conversationExecutor.run(
          full.from_user_id ?? "",
          getWeixinMessageTurnLane(full),
          () =>
            handleWeixinMessageTurn(full, {
              accountId,
              agent,
              baseUrl,
              cdnBaseUrl,
              token,
              typingTicket: cachedConfig.typingTicket,
              log,
              errLog,
              ...(opts.onInbound ? { onInbound: opts.onInbound } : {}),
              ...(opts.reserveFinal ? { reserveFinal: opts.reserveFinal } : {}),
              ...(opts.finalRemaining ? { finalRemaining: opts.finalRemaining } : {}),
              ...(opts.enqueuePendingFinal
                ? { enqueuePendingFinal: opts.enqueuePendingFinal }
                : {}),
              ...(opts.hasPendingFinal ? { hasPendingFinal: opts.hasPendingFinal } : {}),
              ...(opts.drainPendingFinal ? { drainPendingFinal: opts.drainPendingFinal } : {}),
              ...(opts.prependPendingFinal
                ? { prependPendingFinal: opts.prependPendingFinal }
                : {}),
              ...(opts.mediaStore ? { mediaStore: opts.mediaStore } : {}),
              ...(opts.allowedMediaRoots ? { allowedMediaRoots: opts.allowedMediaRoots } : {}),
              ...(opts.perfTracer ? { perfTracer: opts.perfTracer } : {}),
              ...(boundAlias ? { boundSessionAlias: boundAlias } : {}),
              ...(isForeground ? { isForeground } : {}),
              ...(opts.setBackgroundResult
                ? {
                    onBackgroundFinal: async (
                      alias: string,
                      text: string,
                      status: "done" | "error",
                    ) => {
                      await opts.setBackgroundResult!(chatKey, alias, {
                        text,
                        status,
                        finished_at: new Date().toISOString(),
                      });
                    },
                  }
                : {}),
            }),
          sessionKey,
        );

        void runPromise
          .catch((err) => {
            errLog(`[weixin] message turn failed: ${String(err)}`);
          })
          .finally(() => {
            if (boundAlias) {
              opts.activeTurns?.markInactive(chatKey, boundAlias);
            }
          });
      }
    } catch (err) {
      if (abortSignal?.aborted) {
        weixinLog.info("weixin.monitor.stopped", "monitor stopped (aborted)", { accountId });
        return;
      }
      consecutiveFailures += 1;
      errLog(
        `[weixin] getUpdates error (${consecutiveFailures}/${MAX_CONSECUTIVE_FAILURES}): ${String(err)}`,
      );
      if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
        consecutiveFailures = 0;
        await sleep(BACKOFF_DELAY_MS, abortSignal);
      } else {
        await sleep(RETRY_DELAY_MS, abortSignal);
      }
    }
  }
  weixinLog.info("weixin.monitor.ended", "monitor ended", { accountId });
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(t);
        reject(new Error("aborted"));
      },
      { once: true },
    );
  });
}

type FreshCredentials = {
  accountId: string;
  baseUrl: string;
  cdnBaseUrl: string;
  token: string;
};

/**
 * Poll the account credential store for a fresh token every 30 seconds.
 * Checks two paths:
 *   1. The original accountId got a new token on disk (re-login refreshed same account).
 *   2. A new accountId was registered with a valid token (fresh QR login).
 * Returns the fresh credentials when found, or null if abortSignal fires.
 */
async function pollForFreshCredentials(
  staleAccountId: string,
  staleToken: string | undefined,
  log: (msg: string) => void,
  abortSignal?: AbortSignal,
): Promise<FreshCredentials | null> {
  let attempt = 0;
  while (!abortSignal?.aborted) {
    attempt += 1;

    // Priority 1: same accountId, fresh token on disk.
    const currentAccount = resolveWeixinAccount(staleAccountId);
    if (currentAccount.token && currentAccount.token !== staleToken) {
      log(`[weixin] credential recovery: fresh token detected for account=${staleAccountId}`);
      return {
        accountId: currentAccount.accountId,
        baseUrl: currentAccount.baseUrl,
        cdnBaseUrl: currentAccount.cdnBaseUrl,
        token: currentAccount.token,
      };
    }

    // Priority 2: a new accountId was registered with a valid token.
    const ids = listWeixinAccountIds();
    for (const id of ids) {
      if (id === staleAccountId) continue;
      const account = resolveWeixinAccount(id);
      if (account.configured && account.token) {
        log(`[weixin] credential recovery: new account detected, switching to account=${id}`);
        return {
          accountId: account.accountId,
          baseUrl: account.baseUrl,
          cdnBaseUrl: account.cdnBaseUrl,
          token: account.token,
        };
      }
    }

    if (attempt % 10 === 0) {
      log(`[weixin] credential recovery: still waiting for fresh credentials (checked ${attempt} times)`);
    }

    await sleep(CREDENTIAL_RECOVERY_POLL_INTERVAL_MS, abortSignal);
  }
  return null;
}
