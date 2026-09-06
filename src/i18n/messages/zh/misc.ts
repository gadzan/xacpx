import type { MiscMessages } from "../../types";

export const misc: MiscMessages = {
  // console-agent: empty message guard
  emptyMessage: "消息内容为空。",

  // config/default-workspace: default workspace description
  defaultHomeWorkspaceDescription: "用户主目录",

  // plugins/known-plugins: channel descriptions
  pluginChannelFeishu: "飞书频道",
  pluginChannelYuanbao: "腾讯元宝频道",
  pluginChannelDiscord: "Discord 频道",
  pluginChannelRelay: "Relay hub 连接器（从自托管 relay hub 遥控这台实例）",
  pluginChannelInstallHint: (channelType: string, packageName: string) =>
    `频道 ${channelType} 需要安装插件：xacpx plugin add ${packageName}`,

  // doctor/orchestration-health: suggestions
  orchestrationSuggestion1: "查看 /tasks --stuck 定位卡住的任务",
  orchestrationSuggestion2: "/task <id> 可看完整时间线定位错误点",
  orchestrationSuggestion3: "必要时用 /task cancel 或 /tasks clean 恢复",

  // cli/startup-wait-ui
  startupWaitLine: (frame: string, elapsed: number, timeout: number) =>
    `${frame} 正在创建初始会话 ${elapsed}s / ${timeout}s，按 Ctrl+B 跳过等待`,
  startupWaitLineFirstBoot: (frame: string, elapsed: number, timeout: number) =>
    `${frame} 正在创建初始会话，首次启动可能需要准备依赖和运行环境 ${elapsed}s / ${timeout}s，按 Ctrl+B 跳过等待`,

  // sessions/session-service: validation errors (Error messages surfaced to user)
  workspaceNotRegistered: (workspace: string) =>
    `工作区「${workspace}」未注册`,
  agentNotRegistered: (agent: string) =>
    `Agent「${agent}」未注册`,

  // transport/quota-gated-reply-sink: heads-up text and overflow summary
  quotaHeadsUp: "—\n⏳ 推送已达上限。回复 /jx 续看进度，或等待最终结果。",
  quotaOverflowSummary: (count: number) =>
    `（因消息次数限制省略 ${count} 条进度，请继续查看下方最终结果）`,

  // weixin/messaging/final-heads-up
  finalHeadsUp: (total: number, sentSoFar: number, remaining: number) =>
    `—\n📄 结果共 ${total} 段，已发 ${sentSoFar} 段。回复 /jx 续看后 ${remaining} 段。`,

  // weixin/messaging/handle-weixin-message-turn: all pages parked
  finalAllParked: (count: number) =>
    `📄 已达消息上限：结果共 ${count} 段已暂存。回复 /jx 接收。`,

  // weixin/messaging/inbound: quoted message prefix
  quotedMessagePrefix: (parts: string) => `[引用: ${parts}]`,

  // weixin/messaging/scheduled-turn: execution failed
  scheduledTaskFailed: (message: string) => `定时任务执行失败：${message}`,

  // weixin/messaging/send-orchestration-notice: task notices
  orchestrationTaskCompleted: (taskId: string, workerSession: string, result: string) =>
    `委派任务「${taskId}」已完成\n- worker：${workerSession}\n- 结果：${result}`,
  orchestrationTaskFailed: (taskId: string, workerSession: string, reason: string) =>
    `委派任务「${taskId}」执行失败\n- worker：${workerSession}\n- 原因：${reason}`,
  workerUnassigned: "未分配",

  // weixin/messaging/completion-notice: background session done/error
  bgSessionDone: (display: string) =>
    `✅ ${display} 已完成，/use ${display} 查看结果`,
  bgSessionError: (display: string) =>
    `⚠️ ${display} 失败，/use ${display} 查看详情`,

  // weixin/messaging/handle-weixin-message-turn: execution error
  executionError: (message: string) => `⚠️ 执行出错：${message}`,

  // onboarding
  onboardingFirstUsePrompt: (workspaceName: string) =>
    `检测到首次使用 xacpx。是否将当前目录创建为工作区「${workspaceName}」？[Y/n] `,
  onboardingSelectAgent: "请选择要添加并创建初始会话的 Agent：",
  onboardingEnterChoice: "输入数字或名称（默认 1）：",
  onboardingNoValidAgent: "未选择有效 Agent，已跳过首次初始化。",
  onboardingCreatedWorkspace: (workspaceName: string, alias: string) =>
    `已创建工作区「${workspaceName}」，正在创建初始会话「${alias}」...`,

  // orchestration/render-human-question-package
  humanQuestionQueued: (count: number) =>
    `\n\n（另外还有 ${count} 个新问题已排队，等这一轮处理完再继续。）`,
  humanQuestionResumed: (taskId: string, summary: string) =>
    `${taskId}：已恢复（${summary}）`,
  humanQuestionUnresolved: (taskId: string, summary: string) =>
    `${taskId}：仍待补充（${summary}）`,
  humanQuestionQueuedLine: (count: number) =>
    `还有 ${count} 个新问题已排队，等这一轮处理完再继续。`,

  // orchestration/render-delegate-question-package: instructions (coordinator-facing)
  delegateQPackageInstr1: "先判断哪些问题你能直接回答",
  delegateQPackageInstr2: "不能直接回答的，整理成一个面向 human 的问题包",
  delegateQPackageInstr3: "不要直接把 human 原话转发给 worker",

  // commands/command-policy
  commandAccessDeniedSuffix: " 仅限群创建者/频道 owner 使用。",
  commandAccessDeniedHint: "如果需要执行控制类操作，请由 owner 在群内发送，或改用私聊。",
  commandAccessDeniedChatTypeMissingSuffix: " 已被拦截：该频道未上报会话类型（直聊/群聊），控制类命令在此暂不可用。",
  commandAccessDeniedChatTypeMissingHint: "只读命令与普通对话不受影响。这是频道元数据问题，请升级或反馈该频道插件。",
  commandLabelThisMessage: "该消息",

  // commands/handlers/session-reset-handler
  sessionResetNoCurrentSession: "当前还没有选中的会话。请先执行 /session new ... 或 /use <alias>。",
  sessionResetFailed: (alias: string) =>
    `会话「${alias}」重置失败。\n新的后端会话未创建成功，请稍后重试。`,
  sessionResetTurnActive: (alias: string) =>
    `会话「${alias}」仍有正在执行的任务；请先停止后再重置。`,
  sessionResetSuccess: (alias: string) => `会话「${alias}」已重置`,

  // scheduled/scheduled-dispatch: notice texts
  scheduledDispatchNoticeBound: (taskId: string, sessionDisplay: string, preview: string) =>
    `执行定时任务 #${taskId}\n会话：${sessionDisplay}\n内容：${preview}`,
  scheduledDispatchNoticeTemp: (taskId: string, workspace: string, agent: string, preview: string) =>
    `执行定时任务 #${taskId}\n会话：临时会话（${workspace} · ${agent}）\n内容：${preview}`,

  // channels/weixin-channel: no login credentials
  weixinNoCredentials: "[xacpx] 未检测到登录凭证，正在启动扫码登录...",

  // weixin/bot.ts: multi-account log (dev logs - English preferred but keeping localized for UX)
  weixinMultipleAccounts: (accountId: string) =>
    `[weixin] Multiple accounts detected, using first: ${accountId}`,
  weixinBotStarting: (accountId: string) =>
    `[weixin] Starting bot, account=${accountId}`,
};
