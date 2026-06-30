import type { FeishuMessages } from "./messages.js";

export const en: FeishuMessages = {
  // ---- strings ----
  abortAck: "Stopped current task.",
  errorFootnote: (tail) => `_Error: ${tail}_`,
  permissionScopeMissing: (scopes) => `Missing scopes: ${scopes}`,
  permissionGenericScopeHint: "The bot is missing required Feishu API scopes",
  permissionPromptToGrant: "Ask an admin to authorize via the link below, then retry:",

  // ---- card-builder ----
  summaryProcessing: "Processing...",
  summaryComplete: "Done",
  summaryStopped: "Stopped",
  summaryError: "Error",
  footerThinking: "_Processing..._",
  footerThinkingElapsed: (elapsed) => `_Processing... ${elapsed}_`,
  footerAborted: (elapsedSuffix) => `🛑 _Stopped_${elapsedSuffix}`,
  footerError: (elapsedSuffix) => `❌ _Error_${elapsedSuffix}`,
  footerComplete: (elapsed) => `_Done · ${elapsed}_`,
  footerStreaming: (elapsed) => `⏳ _Processing... ${elapsed}_`,
  reasoningHeader: "🧠 Reasoning",
  reasoningHeaderElapsed: (elapsed) => `🧠 Thought for ${elapsed}`,
  toolPanelOmitted: (count) => `… ${count} more tool call${count === 1 ? "" : "s"} not shown`,
  toolPanelHeader: (count) => `🔧 Tool calls (${count})`,
  planPanelHeader: (done, total) => `📋 Plan (${done}/${total})`,
  planPanelOmitted: (count) => `… ${count} more item${count === 1 ? "" : "s"} not shown`,

  // ---- channel ----
  taskCompleted: "Task completed.",
  scheduledFailureWithId: (taskId, message) => `⏰ Scheduled task #${taskId} failed: ${message}`,
  scheduledFailure: (message) => `⏰ Scheduled task failed: ${message}`,

  // ---- feishu-provider ----
  providerMissingAppId: "Missing Feishu appId",
  providerMissingAppSecret: "Missing Feishu appSecret",
  providerAccountsMissingCredentials:
    "At least one account in channel.options.accounts must have both appId and appSecret configured",

  // ---- completion-notice ----
  completionDone: (displayAlias) => `✅ ${displayAlias} done`,
  completionError: (displayAlias) => `⚠️ ${displayAlias} failed`,
};
