import type { AppLogger } from "../../logging/app-logger";
import type { OrchestrationTaskRecord } from "../../orchestration/orchestration-types";
import { normalizeWeixinUserIdFromChatKey } from "./inbound.js";
import { resolveOrchestrationNoticeAccountIds } from "./orchestration-notice-accounts.js";
import { describeWeixinSendError } from "./send-errors.js";
import { sendOrchestrationTaskNotice } from "./send-orchestration-notice.js";

export interface DeliverOrchestrationTaskNoticeDeps {
  listAccountIds: () => string[];
  resolveAccount: (accountId: string) => { accountId: string; baseUrl: string; token?: string };
  getContextToken: (accountId: string, userId: string) => string | undefined;
  markDelivered: (taskId: string, accountId: string) => Promise<void>;
  markFailed: (taskId: string, errorMessage: string) => Promise<void>;
  sendNotice?: typeof sendOrchestrationTaskNotice;
  reserveFinal?: (chatKey: string) => boolean;
  logger: AppLogger;
}

export async function deliverOrchestrationTaskNotice(
  task: OrchestrationTaskRecord,
  deps: DeliverOrchestrationTaskNoticeDeps,
): Promise<void> {
  if (!task.chatKey || !task.replyContextToken) {
    await deps.logger.debug(
      "orchestration.notice.skipped",
      "skipping task notice because notification context is incomplete",
      {
        taskId: task.taskId,
        reason: "missing_context",
      },
    );
    return;
  }

  const candidates = resolveOrchestrationNoticeAccountIds(task, deps.listAccountIds());
  if (candidates.length === 0) {
    await deps.logger.debug(
      "orchestration.notice.skipped",
      "skipping task notice because no weixin account is available",
      {
        taskId: task.taskId,
        reason: "no_account",
      },
    );
    return;
  }

  // Task completion notices are user-visible final results; charge them to
  // the final-tier budget. v1.3 made reserveFinal a real budget — if the
  // final tier is exhausted we log and skip the send (markFailed retains the
  // pending state so it gets retried after the next inbound resets quota).
  if (deps.reserveFinal && !deps.reserveFinal(normalizeWeixinUserIdFromChatKey(task.chatKey))) {
    await deps.logger.error(
      "orchestration.notice.final_quota_exhausted",
      "skipping task notice because final quota is exhausted; will retry on next inbound",
      { taskId: task.taskId, chatKey: task.chatKey },
    );
    return;
  }

  const sendNotice = deps.sendNotice ?? sendOrchestrationTaskNotice;
  let lastError: unknown;
  for (const candidateAccountId of candidates) {
    const contextToken =
      candidateAccountId === task.accountId
        ? deps.getContextToken(candidateAccountId, task.chatKey) ?? task.replyContextToken
        : deps.getContextToken(candidateAccountId, task.chatKey);

    if (!contextToken) {
      await deps.logger.debug(
        "orchestration.notice.account_skipped",
        "skipping task notice candidate because no context token is available for that account",
        {
          taskId: task.taskId,
          accountId: candidateAccountId,
          reason: "missing_context_token",
        },
      );
      continue;
    }

    try {
      const account = deps.resolveAccount(candidateAccountId);
      if (!account.token) {
        await deps.logger.debug(
          "orchestration.notice.account_skipped",
          "skipping task notice candidate because the weixin account has no token",
          {
            taskId: task.taskId,
            accountId: candidateAccountId,
            reason: "missing_token",
          },
        );
        continue;
      }

      await sendNotice(task, {
        baseUrl: account.baseUrl,
        token: account.token,
        contextToken,
      });

      await deps.markDelivered(task.taskId, candidateAccountId);

      if (candidateAccountId !== task.accountId && candidateAccountId !== task.deliveryAccountId) {
        await deps.logger.info(
          "orchestration.notice.fallback",
          "delivered task notice through fallback weixin account",
          {
            taskId: task.taskId,
            accountId: task.accountId,
            deliveryAccountId: candidateAccountId,
          },
        );
      }
      return;
    } catch (error) {
      lastError = error;
      await deps.logger.error(
        "orchestration.notice.account_failed",
        "failed to deliver task notice through candidate weixin account",
        {
          taskId: task.taskId,
          accountId: candidateAccountId,
          ...describeWeixinSendError(error),
        },
      );
    }
  }

  const message = lastError instanceof Error ? lastError.message : String(lastError ?? "failed to deliver task notice");
  await deps.markFailed(task.taskId, message);
  throw lastError instanceof Error ? lastError : new Error(message);
}
