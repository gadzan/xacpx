import type { MiscMessages } from "../../types";

export const misc: MiscMessages = {
  // console-agent: empty message guard
  emptyMessage: "Message is empty.",

  // config/default-workspace: default workspace description
  defaultHomeWorkspaceDescription: "Home directory",

  // plugins/known-plugins: channel descriptions
  pluginChannelFeishu: "Feishu channel",
  pluginChannelYuanbao: "Tencent Yuanbao channel",
  pluginChannelRelay: "Relay hub connector (drive this instance from a self-hosted relay hub)",
  pluginChannelInstallHint: (channelType: string, packageName: string) =>
    `Channel ${channelType} requires a plugin: xacpx plugin add ${packageName}`,

  // doctor/orchestration-health: suggestions
  orchestrationSuggestion1: "Run /tasks --stuck to locate stuck tasks",
  orchestrationSuggestion2: "/task <id> shows the full timeline to locate errors",
  orchestrationSuggestion3: "Use /task cancel or /tasks clean to recover",

  // cli/startup-wait-ui
  startupWaitLine: (frame: string, elapsed: number, timeout: number) =>
    `${frame} Creating initial session... ${elapsed}s / ${timeout}s, press Ctrl+B to skip`,
  startupWaitLineFirstBoot: (frame: string, elapsed: number, timeout: number) =>
    `${frame} Creating initial session (first boot may need to prepare dependencies) ${elapsed}s / ${timeout}s, press Ctrl+B to skip`,

  // sessions/session-service: validation errors (Error messages surfaced to user)
  workspaceNotRegistered: (workspace: string) =>
    `Workspace "${workspace}" is not registered`,
  agentNotRegistered: (agent: string) =>
    `Agent "${agent}" is not registered`,

  // transport/quota-gated-reply-sink: heads-up text and overflow summary
  quotaHeadsUp: "—\n⏳ Push limit reached. Reply /jx to continue watching, or wait for the final result.",
  quotaOverflowSummary: (count: number) =>
    `(${count} progress updates omitted due to message limit; see final result below)`,

  // weixin/messaging/final-heads-up
  finalHeadsUp: (total: number, sentSoFar: number, remaining: number) =>
    `—\n📄 Result: ${total} parts total, ${sentSoFar} sent. Reply /jx to see the next ${remaining} parts.`,

  // weixin/messaging/handle-weixin-message-turn: all pages parked
  finalAllParked: (count: number) =>
    `📄 Message limit reached: the result (${count} parts) is parked. Reply /jx to receive it.`,

  // weixin/messaging/inbound: quoted message prefix
  quotedMessagePrefix: (parts: string) => `[Quote: ${parts}]`,

  // weixin/messaging/scheduled-turn: execution failed
  scheduledTaskFailed: (message: string) => `Scheduled task failed: ${message}`,

  // weixin/messaging/send-orchestration-notice: task notices
  orchestrationTaskCompleted: (taskId: string, workerSession: string, result: string) =>
    `Delegation task "${taskId}" completed\n- worker: ${workerSession}\n- result: ${result}`,
  orchestrationTaskFailed: (taskId: string, workerSession: string, reason: string) =>
    `Delegation task "${taskId}" failed\n- worker: ${workerSession}\n- reason: ${reason}`,
  workerUnassigned: "unassigned",

  // weixin/messaging/completion-notice: background session done/error
  bgSessionDone: (display: string) =>
    `✅ ${display} finished, /use ${display} to view result`,
  bgSessionError: (display: string) =>
    `⚠️ ${display} failed, /use ${display} to view details`,

  // weixin/messaging/handle-weixin-message-turn: execution error
  executionError: (message: string) => `⚠️ Execution error: ${message}`,

  // onboarding
  onboardingFirstUsePrompt: (workspaceName: string) =>
    `First use detected. Create current directory as workspace "${workspaceName}"? [Y/n] `,
  onboardingSelectAgent: "Select an agent to add and create the initial session:",
  onboardingEnterChoice: "Enter number or name (default 1): ",
  onboardingNoValidAgent: "No valid agent selected, skipping first-time setup.",
  onboardingCreatedWorkspace: (workspaceName: string, alias: string) =>
    `Created workspace "${workspaceName}", creating initial session "${alias}"...`,

  // orchestration/render-human-question-package
  humanQuestionQueued: (count: number) =>
    `\n\n(${count} more new questions have been queued; they will be handled after this round.)`,
  humanQuestionResumed: (taskId: string, summary: string) =>
    `${taskId}: resumed (${summary})`,
  humanQuestionUnresolved: (taskId: string, summary: string) =>
    `${taskId}: still pending (${summary})`,
  humanQuestionQueuedLine: (count: number) =>
    `${count} more new questions queued; they will be handled after this round.`,

  // orchestration/render-delegate-question-package: instructions (coordinator-facing)
  delegateQPackageInstr1: "First assess which questions you can answer directly",
  delegateQPackageInstr2: "For those you cannot answer, compile them into a human question package",
  delegateQPackageInstr3: "Do not forward the human's exact words to the worker",

  // commands/command-policy
  commandAccessDeniedSuffix: " is restricted to group owner only.",
  commandAccessDeniedHint: "To perform control operations, have the owner send them in the group, or use a private chat.",
  commandAccessDeniedChatTypeMissingSuffix:
    " was blocked: this channel did not report the chat type (direct or group), so control commands are disabled here.",
  commandAccessDeniedChatTypeMissingHint:
    "Read-only commands and prompts still work. This is a channel metadata issue — update or report the channel plugin.",
  commandLabelThisMessage: "This message",

  // commands/handlers/session-reset-handler
  sessionResetNoCurrentSession: "No session is currently selected. Run /session new ... or /use <alias> first.",
  sessionResetFailed: (alias: string) =>
    `Session "${alias}" reset failed. The new backend session was not created, please try again later.`,
  sessionResetSuccess: (alias: string) => `Session "${alias}" has been reset`,

  // scheduled/scheduled-dispatch: notice texts
  scheduledDispatchNoticeBound: (taskId: string, sessionDisplay: string, preview: string) =>
    `Running scheduled task #${taskId}\nSession: ${sessionDisplay}\nContent: ${preview}`,
  scheduledDispatchNoticeTemp: (taskId: string, workspace: string, agent: string, preview: string) =>
    `Running scheduled task #${taskId}\nSession: temporary (${workspace} · ${agent})\nContent: ${preview}`,

  // channels/weixin-channel: no login credentials
  weixinNoCredentials: "[xacpx] No login credentials detected, starting QR code login...",

  // weixin/bot.ts: multi-account log
  weixinMultipleAccounts: (accountId: string) =>
    `[weixin] Multiple accounts detected, using first: ${accountId}`,
  weixinBotStarting: (accountId: string) =>
    `[weixin] Starting bot, account=${accountId}`,
};
