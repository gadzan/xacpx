import type { AppLogger } from "../../logging/app-logger";
import type { OrchestrationTaskRecord } from "../../orchestration/orchestration-types";
import { normalizeWeixinUserIdFromChatKey } from "./inbound.js";
import { resolveOrchestrationNoticeAccountIds } from "./orchestration-notice-accounts.js";
import { describeWeixinSendError } from "./send-errors.js";
import { sendMessageWeixin } from "./send.js";

export interface DeliverOrchestrationTaskProgressDeps {
  listAccountIds: () => string[];
  resolveAccount: (accountId: string) => { accountId: string; baseUrl: string; token?: string };
  getContextToken: (accountId: string, userId: string) => string | undefined;
  sendMessage?: typeof sendMessageWeixin;
  reserveMidSegment?: (chatKey: string) => boolean;
  logger: AppLogger;
}

export async function deliverOrchestrationTaskProgress(
  task: OrchestrationTaskRecord,
  text: string,
  deps: DeliverOrchestrationTaskProgressDeps,
): Promise<void> {
  if (!task.chatKey || !task.replyContextToken) {
    return;
  }

  const candidates = resolveOrchestrationNoticeAccountIds(task, deps.listAccountIds());
  if (candidates.length === 0) {
    return;
  }

  if (deps.reserveMidSegment && !deps.reserveMidSegment(normalizeWeixinUserIdFromChatKey(task.chatKey))) {
    await deps.logger.info(
      "orchestration.progress.deferred",
      "task progress deferred due to outbound quota",
      {
        taskId: task.taskId,
        chatKey: task.chatKey,
        reason: "quota_exhausted",
      },
    );
    return;
  }

  const sendMessage = deps.sendMessage ?? sendMessageWeixin;
  for (const candidateAccountId of candidates) {
    const contextToken =
      candidateAccountId === task.accountId
        ? deps.getContextToken(candidateAccountId, task.chatKey) ?? task.replyContextToken
        : deps.getContextToken(candidateAccountId, task.chatKey);

    if (!contextToken) {
      continue;
    }

    const account = deps.resolveAccount(candidateAccountId);
    if (!account.token) {
      continue;
    }

    try {
      await sendMessage({
        to: normalizeWeixinUserIdFromChatKey(task.chatKey),
        text,
        opts: {
          baseUrl: account.baseUrl,
          token: account.token,
          contextToken,
        },
      });
      return;
    } catch (error) {
      await deps.logger.error(
        "orchestration.progress.send_failed",
        "failed to send progress through candidate weixin account",
        {
          taskId: task.taskId,
          accountId: candidateAccountId,
          ...describeWeixinSendError(error),
        },
      );
    }
  }
}
