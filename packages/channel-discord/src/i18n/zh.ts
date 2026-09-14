import type { DiscordMessages } from "./messages.js";

export const ZH_ABORT_TRIGGER_WORDS: ReadonlySet<string> = new Set([
  "停止",
  "停下",
  "中断",
  "取消",
  "暂停",
  "停一下",
]);

export const zh: DiscordMessages = {
  abortAck: "已停止当前任务。",
  errorFootnote: (tail) => `_错误:${tail}_`,
  permissionGenericHint: "机器人缺少 Discord 权限",
  permissionTitle: "需要授权",
  permissionAllowOnce: "允许一次",
  permissionAllowAlways: "始终允许",
  permissionDeny: "拒绝",
  permissionDenyAlways: "始终拒绝",
  permissionCancel: "取消",
  permissionResolved: (outcome) => `权限请求已处理：${outcome}。`,
  permissionExpired: "权限请求已过期。",
  permissionCancelled: "权限请求已取消。",
  permissionUnauthorized: "只有发起该请求的用户才能审批。",
  permissionAlreadyResolved: "该权限请求已处理。",
  summaryProcessing: "处理中...",
  summaryComplete: "已完成",
  summaryStopped: "已停止",
  summaryError: "出错",
  taskCompleted: "任务已完成。",
  scheduledFailureWithId: (taskId, message) => `定时任务 #${taskId} 执行失败：${message}`,
  scheduledFailure: (message) => `定时任务执行失败：${message}`,
  providerMissingToken: "缺少 Discord token",
  providerAccountsMissingCredentials:
    "channel.options.accounts 中至少要有一个账号配置了 token",
  completionDone: (displayAlias) => `✅ ${displayAlias} 已完成`,
  completionError: (displayAlias) => `⚠️ ${displayAlias} 失败`,
};
