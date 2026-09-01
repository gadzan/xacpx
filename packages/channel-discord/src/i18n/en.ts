import type { DiscordMessages } from "./messages.js";

export const en: DiscordMessages = {
  abortAck: "Stopped current task.",
  errorFootnote: (tail) => `_Error: ${tail}_`,
  permissionGenericHint: "The bot is missing required Discord permissions",
  summaryProcessing: "Processing...",
  summaryComplete: "Done",
  summaryStopped: "Stopped",
  summaryError: "Error",
  taskCompleted: "Task completed.",
  scheduledFailureWithId: (taskId, message) => `Scheduled task #${taskId} failed: ${message}`,
  scheduledFailure: (message) => `Scheduled task failed: ${message}`,
  providerMissingToken: "Missing Discord token",
  providerAccountsMissingCredentials:
    "At least one account in channel.options.accounts must have a token configured",
  completionDone: (displayAlias) => `✅ ${displayAlias} done`,
  completionError: (displayAlias) => `⚠️ ${displayAlias} failed`,
};
