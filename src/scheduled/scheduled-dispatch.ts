import type { AppLogger } from "../logging/app-logger";
import type { ScheduledChannelMessageInput } from "../channels/types";
import type { ResolvedSession } from "../transport/types";
import { toDisplaySessionAlias } from "../channels/channel-scope";
import { preview } from "./scheduled-render";
import type { ScheduledTaskRecord } from "./scheduled-types";
import { t } from "../i18n/index.js";

export interface ScheduledDispatchDeps {
  getSession: (alias: string) => Promise<ResolvedSession | null>;
  // Resolve a task's stored session alias to the internal alias for its chat before
  // lookup. Web (control) tasks store the DISPLAY alias (e.g. "home-opencode"), while
  // sessions are keyed by the channel-scoped internal alias (e.g. "relay:home-opencode").
  // Idempotent for already-internal aliases, so WeChat-stored aliases are unaffected.
  resolveAliasForChat?: (chatKey: string, alias: string) => Promise<string>;
  resolveSession: (
    alias: string,
    agent: string,
    workspace: string,
    transportSession: string,
  ) => ResolvedSession;
  sendScheduledMessage: (input: ScheduledChannelMessageInput) => Promise<void>;
  removeSession?: (session: ResolvedSession) => Promise<void>;
  logger?: AppLogger;
}

export function buildScheduledDispatchTask(deps: ScheduledDispatchDeps) {
  return async (task: ScheduledTaskRecord, abortSignal: AbortSignal): Promise<void> => {
    if (task.session_mode === "temp") {
      await dispatchTemp(task, abortSignal, deps);
      return;
    }
    await dispatchBound(task, abortSignal, deps);
  };
}

async function dispatchBound(
  task: ScheduledTaskRecord,
  abortSignal: AbortSignal,
  deps: ScheduledDispatchDeps,
): Promise<void> {
  const internalAlias = deps.resolveAliasForChat
    ? await deps.resolveAliasForChat(task.chat_key, task.session_alias)
    : task.session_alias;
  const session = await deps.getSession(internalAlias);
  if (!session) {
    throw new Error(`session "${task.session_alias}" not found for scheduled task`);
  }
  const noticeText = t().misc.scheduledDispatchNoticeBound(task.id, toDisplaySessionAlias(task.session_alias), preview(task.message));
  await deps.sendScheduledMessage({
    chatKey: task.chat_key,
    taskId: task.id,
    sessionAlias: task.session_alias,
    executeAt: task.execute_at,
    noticeText,
    promptText: task.message,
    abortSignal,
    ...(task.account_id ? { accountId: task.account_id } : {}),
    ...(task.reply_context_token ? { replyContextToken: task.reply_context_token } : {}),
  });
}

async function dispatchTemp(
  task: ScheduledTaskRecord,
  abortSignal: AbortSignal,
  deps: ScheduledDispatchDeps,
): Promise<void> {
  if (!task.agent || !task.workspace) {
    throw new Error(`temp scheduled task #${task.id} is missing its agent/workspace snapshot`);
  }
  const alias = `later-${task.id}`;
  const transportSession = `${task.workspace}:${alias}`;
  const session = deps.resolveSession(alias, task.agent, task.workspace, transportSession);
  const noticeText = t().misc.scheduledDispatchNoticeTemp(task.id, task.workspace, task.agent, preview(task.message));

  try {
    await deps.sendScheduledMessage({
      chatKey: task.chat_key,
      taskId: task.id,
      sessionAlias: task.session_alias,
      executeAt: task.execute_at,
      sessionDescriptor: { alias, agent: task.agent, workspace: task.workspace, transportSession },
      noticeText,
      promptText: task.message,
      abortSignal,
      ...(task.account_id ? { accountId: task.account_id } : {}),
      ...(task.reply_context_token ? { replyContextToken: task.reply_context_token } : {}),
    });
  } finally {
    if (deps.removeSession) {
      try {
        await deps.removeSession(session);
      } catch (error) {
        await deps.logger?.error(
          "scheduled.temp_session_close_failed",
          "failed to close temp scheduled session",
          { taskId: task.id, transportSession, error: String(error) },
        );
      }
    }
  }
}
