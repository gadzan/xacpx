import type { AppLogger } from "../../logging/app-logger";
import type { ScheduledChannelMessageInput } from "../../channels/types";
import type { Agent } from "../agent/interface";
import { executeChatTurn } from "./execute-chat-turn";
import { chunkFinalText } from "./handle-weixin-message-turn";
import { buildFinalHeadsUp } from "./final-heads-up";
import type { PendingFinalChunk } from "./quota-manager";
import { markdownToPlainText, sendMessageWeixin } from "./send";
import { normalizeWeixinUserIdFromChatKey } from "./inbound";
import { t } from "../../i18n/index.js";

export interface ScheduledTurnDeps {
  agent: Agent;
  listAccountIds: () => string[];
  resolveAccount: (accountId: string) => { accountId: string; baseUrl: string; token?: string };
  getContextToken: (accountId: string, userId: string) => string | undefined;
  reserveMidSegment: (chatKey: string) => boolean;
  reserveFinal: (chatKey: string) => boolean;
  finalRemaining?: (chatKey: string) => number;
  enqueuePendingFinal?: (chatKey: string, chunks: PendingFinalChunk[]) => void;
  sendMessage?: typeof sendMessageWeixin;
  logger: AppLogger;
}

export async function executeScheduledTurn(
  input: ScheduledChannelMessageInput,
  deps: ScheduledTurnDeps,
): Promise<void> {
  const userId = normalizeWeixinUserIdFromChatKey(input.chatKey);
  const quotaKey = userId;
  const sendMessage = deps.sendMessage ?? sendMessageWeixin;

  // 1. Send notice text
  const candidateAccountIds = input.accountId ? [input.accountId] : deps.listAccountIds();
  if (candidateAccountIds.length === 0) {
    throw new Error(`no weixin account is available for scheduled message on chatKey: ${input.chatKey}`);
  }

  let noticeSent = false;
  let lastNoticeError: unknown;
  let deliveryAccountId: string | undefined;
  let deliveryContextToken: string | undefined;
  // First candidate that can carry an outbound message (valid context token +
  // account token), regardless of whether the trigger notice itself sends.
  let deliverableAccountId: string | undefined;
  let deliverableContextToken: string | undefined;

  const resolveContextToken = (candidateAccountId: string): string | undefined =>
    deps.getContextToken(candidateAccountId, userId) ??
    (candidateAccountId === input.accountId ? input.replyContextToken : undefined);

  for (const candidateAccountId of candidateAccountIds) {
    const contextToken = resolveContextToken(candidateAccountId);
    if (!contextToken) continue;

    const account = deps.resolveAccount(candidateAccountId);
    if (!account.token) continue;

    if (!deliverableAccountId) {
      deliverableAccountId = candidateAccountId;
      deliverableContextToken = contextToken;
    }

    try {
      if (!deps.reserveMidSegment(quotaKey)) {
        throw new Error("mid segment quota exhausted");
      }
      await sendMessage({
        to: userId,
        text: input.noticeText,
        opts: { baseUrl: account.baseUrl, token: account.token, contextToken },
      });
      noticeSent = true;
      deliveryAccountId = candidateAccountId;
      deliveryContextToken = contextToken;
      break;
    } catch (error) {
      lastNoticeError = error;
      await deps.logger.error(
        "scheduled.notice_send_failed",
        "failed to send scheduled notice",
        { chatKey: input.chatKey, accountId: candidateAccountId, error: String(error) },
      );
    }
  }

  if (!noticeSent) {
    // No account can carry an outbound message (no valid context token / account
    // token). The agent result would be undeliverable too, so do not run it.
    if (!deliverableAccountId || !deliverableContextToken) {
      const message = lastNoticeError instanceof Error
        ? lastNoticeError.message
        : `no deliverable weixin context for scheduled message on chatKey: ${input.chatKey}`;
      throw new Error(message);
    }
    // The trigger notice failed (e.g. mid-segment quota exhausted, transient
    // send error) but a deliverable target exists. Do not cancel the scheduled
    // work: run the agent turn and deliver its result through the final tier.
    deliveryAccountId = deliverableAccountId;
    deliveryContextToken = deliverableContextToken;
    await deps.logger.info(
      "scheduled.notice_skipped",
      "scheduled trigger notice was not delivered; proceeding with agent turn",
      {
        chatKey: input.chatKey,
        accountId: deliveryAccountId,
        reason: lastNoticeError instanceof Error ? lastNoticeError.message : "notice_undelivered",
      },
    );
  }

  const sendReplySegment = async (text: string): Promise<boolean> => {
    const plainText = markdownToPlainText(text).trim();
    if (plainText.length === 0) return false;

    // Normal prompt streaming already goes through QuotaGatedReplySink before
    // it invokes this reply callback. Do not reserve mid quota again here.
    return await sendTextViaAvailableAccount(plainText, "scheduled.mid_send_failed");
  };

  const sendReservedMidText = async (text: string): Promise<boolean> => {
    const plainText = markdownToPlainText(text).trim();
    if (plainText.length === 0) return false;

    if (!deps.reserveMidSegment(quotaKey)) {
      await deps.logger.info(
        "scheduled.mid_dropped",
        "scheduled turn intermediate response dropped due to quota",
        { chatKey: input.chatKey, reason: "quota_exhausted" },
      );
      return false;
    }

    return await sendTextViaAvailableAccount(plainText, "scheduled.mid_send_failed");
  };

  // 2. Execute agent chat turn
  // Use the account/context that delivered the trigger notice for the agent turn.
  const resolvedAccountId = deliveryAccountId ?? input.accountId ?? candidateAccountIds[0]!;
  let turn: Awaited<ReturnType<typeof executeChatTurn>>;
  try {
    turn = await executeChatTurn({
      agent: deps.agent,
      request: {
        accountId: resolvedAccountId,
        conversationId: input.chatKey,
        text: input.promptText,
        ...(deliveryContextToken ? { replyContextToken: deliveryContextToken } : {}),
        ...(input.abortSignal ? { abortSignal: input.abortSignal } : {}),
        metadata: {
          channel: "weixin",
          scheduledSessionAlias: input.sessionAlias,
          ...(input.sessionDescriptor ? { scheduledSessionDescriptor: input.sessionDescriptor } : {}),
        },
      },
      onReplySegment: sendReplySegment,
    });
  } catch (error) {
    await sendReservedMidText(t().misc.scheduledTaskFailed(error instanceof Error ? error.message : String(error))).catch(() => false);
    throw error;
  }

  // 3. Send final response through the same final quota/chunking model as
  // normal Weixin turns. Scheduled tasks do not have a fresh inbound message,
  // so this uses the context token that already delivered the trigger notice.
  if (turn.text) {
    const finalText = markdownToPlainText(turn.text).trim();
    if (finalText.length > 0) {
      await sendFinalText(finalText);
    }
  }

  async function sendFinalText(finalText: string): Promise<void> {
    const rawChunks = chunkFinalText(finalText, 1800);
    if (rawChunks.length === 0) return;

    const total = rawChunks.length;
    const chunks = total === 1
      ? rawChunks
      : rawChunks.map((body, index) => `(${index + 1}/${total}) ${body}`);
    const available = total === 1 ? 1 : Math.max(Math.min(deps.finalRemaining?.(quotaKey) ?? total, total), 0);
    const wave = chunks.slice(0, available);
    if (wave.length > 0 && wave.length < total) {
      wave[wave.length - 1] = `${wave[wave.length - 1]!}\n\n${buildFinalHeadsUp({
        total,
        sentSoFar: wave.length,
      })}`;
    }

    let sent = 0;
    for (let index = 0; index < wave.length; index += 1) {
      if (!deps.reserveFinal(quotaKey)) {
        // With a pending-final queue the remaining chunks are parked below,
        // not dropped — label the log accordingly.
        await deps.logger.info(
          deps.enqueuePendingFinal ? "scheduled.final_parked" : "scheduled.final_dropped",
          deps.enqueuePendingFinal
            ? "scheduled turn final response parked due to quota"
            : "scheduled turn final response dropped due to quota",
          { chatKey: input.chatKey, reason: "quota_exhausted", chunk: index + 1, total },
        );
        break;
      }

      const delivered = await sendTextViaAvailableAccount(wave[index]!, "scheduled.final_send_failed");
      if (!delivered) break;
      sent += 1;
    }

    const restToPark = chunks.slice(sent);
    if (restToPark.length > 0 && deps.enqueuePendingFinal) {
      // Single-chunk finals park too (seq 1/1) instead of being dropped —
      // the /jx drain path handles them like any other pending chunk.
      const pending: PendingFinalChunk[] = restToPark.map((text, index) => {
        const entry: PendingFinalChunk = { text, seq: sent + index + 1, total };
        if (deliveryContextToken) entry.contextToken = deliveryContextToken;
        if (deliveryAccountId) entry.accountId = deliveryAccountId;
        return entry;
      });
      deps.enqueuePendingFinal(quotaKey, pending);
      if (sent === 0) {
        // Zero pages went out, so the in-band heads-up tail never attached
        // anywhere — send ONE standalone parked notice. It is a fixed-size
        // system message, not model output, so it bypasses the final-quota
        // counter (at zero quota it would be unsendable by construction).
        // Sent only after a successful park so it never promises a result
        // that /jx cannot deliver.
        const noticeDelivered = await sendTextViaAvailableAccount(
          t().misc.finalAllParked(restToPark.length),
          "scheduled.final_parked_notice_failed",
        );
        if (!noticeDelivered) {
          await deps.logger.info(
            "scheduled.final_parked_notice_failed",
            "scheduled parked-final notice could not be delivered",
            { chatKey: input.chatKey, parked: restToPark.length },
          );
        }
      }
    }
  }

  async function sendTextViaAvailableAccount(text: string, errorEvent: string): Promise<boolean> {
    const orderedAccountIds = [
      ...(deliveryAccountId ? [deliveryAccountId] : []),
      ...candidateAccountIds.filter((accountId) => accountId !== deliveryAccountId),
    ];

    for (const candidateAccountId of orderedAccountIds) {
      const contextToken =
        candidateAccountId === deliveryAccountId && deliveryContextToken
          ? deliveryContextToken
          : resolveContextToken(candidateAccountId);
      if (!contextToken) continue;

      const account = deps.resolveAccount(candidateAccountId);
      if (!account.token) continue;

      try {
        await sendMessage({
          to: userId,
          text,
          opts: { baseUrl: account.baseUrl, token: account.token, contextToken },
        });
        return true;
      } catch (error) {
        await deps.logger.error(
          errorEvent,
          "failed to send scheduled response text",
          { chatKey: input.chatKey, accountId: candidateAccountId, error: String(error) },
        );
      }
    }

    return false;
  }
}
