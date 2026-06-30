import type { FeishuMessages } from "./messages.js";

/**
 * Chinese-language stop words used by abort-detect.ts. These are functional
 * input constants (not user-facing output) and are always active regardless
 * of the configured locale — a zh-speaking user can stop the bot in Chinese
 * even when the configured display language is English.
 */
export const ZH_ABORT_TRIGGER_WORDS: ReadonlySet<string> = new Set([
  "停止",
  "停下",
  "中断",
  "取消",
  "暂停",
  "停一下",
]);

export const zh: FeishuMessages = {
  // ---- strings ----
  abortAck: "已停止当前任务。",
  errorFootnote: (tail) => `_错误:${tail}_`,
  permissionScopeMissing: (scopes) => `缺少权限:${scopes}`,
  permissionGenericScopeHint: "机器人缺少 Feishu API 权限",
  permissionPromptToGrant: "请管理员点击下方链接授权后重试:",

  // ---- card-builder ----
  summaryProcessing: "处理中...",
  summaryComplete: "已完成",
  summaryStopped: "已停止",
  summaryError: "出错",
  footerThinking: "_处理中..._",
  footerThinkingElapsed: (elapsed) => `_处理中... ${elapsed}_`,
  footerAborted: (elapsedSuffix) => `🛑 _已停止_${elapsedSuffix}`,
  footerError: (elapsedSuffix) => `❌ _出错_${elapsedSuffix}`,
  footerComplete: (elapsed) => `_已完成 · ${elapsed}_`,
  footerStreaming: (elapsed) => `⏳ _处理中... ${elapsed}_`,
  reasoningHeader: "🧠 思考过程",
  reasoningHeaderElapsed: (elapsed) => `🧠 已思考 ${elapsed}`,
  toolPanelOmitted: (count) => `… 还有 ${count} 个工具调用未显示`,
  toolPanelHeader: (count) => `🔧 工具调用 (${count})`,
  planPanelHeader: (done, total) => `📋 任务清单 (${done}/${total})`,
  planPanelOmitted: (count) => `… 还有 ${count} 项未显示`,

  // ---- channel ----
  taskCompleted: "任务已完成。",
  scheduledFailureWithId: (taskId, message) => `⏰ 定时任务 #${taskId} 执行失败：${message}`,
  scheduledFailure: (message) => `⏰ 定时任务执行失败：${message}`,

  // ---- feishu-provider ----
  providerMissingAppId: "缺少 Feishu appId",
  providerMissingAppSecret: "缺少 Feishu appSecret",
  providerAccountsMissingCredentials:
    "channel.options.accounts 中至少要有一个账号同时配置了 appId 和 appSecret",

  // ---- completion-notice ----
  completionDone: (displayAlias) => `✅ ${displayAlias} 已完成`,
  completionError: (displayAlias) => `⚠️ ${displayAlias} 失败`,
};
