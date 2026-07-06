import type { AppLogger } from "../../logging/app-logger";
import { normalizeWeixinUserIdFromChatKey } from "./inbound.js";
import { QuotaDeferredError } from "./quota-errors.js";
import { describeWeixinSendError } from "./send-errors.js";
import { sendMessageWeixin } from "./send.js";

export interface DeliverCoordinatorMessageInput {
  coordinatorSession: string;
  chatKey: string;
  accountId?: string;
  replyContextToken?: string;
  text: string;
}

export interface DeliverCoordinatorMessageDeps {
  listAccountIds: () => string[];
  resolveAccount: (accountId: string) => { accountId: string; baseUrl: string; token?: string };
  getContextToken: (accountId: string, userId: string) => string | undefined;
  sendMessage?: typeof sendMessageWeixin;
  reserveMidSegment?: (chatKey: string) => boolean;
  logger: AppLogger;
}

export async function deliverCoordinatorMessage(
  input: DeliverCoordinatorMessageInput,
  deps: DeliverCoordinatorMessageDeps,
): Promise<void> {
  if (deps.reserveMidSegment && !deps.reserveMidSegment(normalizeWeixinUserIdFromChatKey(input.chatKey))) {
    await deps.logger.info(
      "orchestration.coordinator_message.deferred",
      "deferring coordinator message because outbound quota is exhausted",
      {
        coordinatorSession: input.coordinatorSession,
        chatKey: input.chatKey,
        reason: "quota_exhausted",
      },
    );
    throw new QuotaDeferredError({
      chatKey: input.chatKey,
      reason: "mid budget exhausted",
    });
  }

  const sendMessage = deps.sendMessage ?? sendMessageWeixin;
  const candidateAccountIds = input.accountId ? [input.accountId] : deps.listAccountIds();
  if (candidateAccountIds.length === 0) {
    throw new Error(`no weixin account is available for coordinator "${input.coordinatorSession}"`);
  }

  let lastError: unknown;
  const singleAccountFallback = input.accountId === undefined && candidateAccountIds.length === 1;

  for (const candidateAccountId of candidateAccountIds) {
    const contextToken =
      deps.getContextToken(candidateAccountId, input.chatKey) ??
      ((candidateAccountId === input.accountId || singleAccountFallback) ? input.replyContextToken : undefined);
    if (!contextToken) {
      continue;
    }

    const account = deps.resolveAccount(candidateAccountId);
    if (!account.token) {
      continue;
    }

    try {
      await sendMessage({
        to: normalizeWeixinUserIdFromChatKey(input.chatKey),
        text: input.text,
        opts: {
          baseUrl: account.baseUrl,
          token: account.token,
          contextToken,
        },
      });
      return;
    } catch (error) {
      lastError = error;
      const described = describeWeixinSendError(error);
      await deps.logger.error(
        "orchestration.coordinator_message.send_failed",
        "failed to deliver coordinator message through candidate weixin account",
        {
          coordinatorSession: input.coordinatorSession,
          chatKey: input.chatKey,
          accountId: candidateAccountId,
          ...described,
        },
      );
    }
  }

  const message =
    lastError instanceof Error
      ? lastError.message
      : `failed to deliver coordinator message for "${input.coordinatorSession}"`;
  throw lastError instanceof Error ? lastError : new Error(message);
}
