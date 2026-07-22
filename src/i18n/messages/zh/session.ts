import type { SessionMessages } from "../../types";

export const session: SessionMessages = {
  // Shared / guard
  noCurrent: "当前还没有选中的会话。请先执行 /session new ... 或 /use <alias>。",

  // handleSessions
  noSessions: "还没有会话。",
  crossChannelHint: "提示：检测到其他渠道已有会话记录；不同渠道的会话相互隔离，请在当前渠道重新创建或绑定。",
  createSessionHint: "创建会话：/ss <agent> -d /path/to/the/project",
  createSessionExample: "例如：/ss claude -d /path/to/the/project",
  sessionListHeader: "会话列表：",
  currentLabel: "[当前]",
  sessionListItem: (alias, agent, workspace) =>
    `- ${alias} (${agent} @ ${workspace})`,

  // handleSessionNew / handleSessionAttach
  sessionCreated: (alias) => `会话「${alias}」已创建并切换`,
  sessionAlreadyExists: (alias, agent, workspace) =>
    [
      `会话「${alias}」已存在（${agent} @ ${workspace}）。`,
      `发送 /use ${alias} 切换到它，或先执行 /session rm ${alias} 删除后再创建。`,
    ].join("\n"),
  sessionAttachNotFound: (alias, agent, workspace) =>
    [
      "没有找到可绑定的已有会话。",
      `请确认会话名是否正确，然后重新执行：/session attach ${alias} --agent ${agent} --ws ${workspace} --name <会话名>`,
    ].join("\n"),
  sessionAttached: (alias) => `会话「${alias}」已绑定并切换`,
  sessionLifecycleBusy: (alias) => `会话「${alias}」正在执行另一项变更，请完成后重试。`,

  // renderSwitched / appendSwitchBackContext
  switched: (alias, agent, workspace) =>
    `已切到 ${alias} · ${agent} · ${workspace}`,
  switchedWithPrev: (alias, agent, workspace, previousAlias) =>
    `已切到 ${alias} · ${agent} · ${workspace}（上一个：${previousAlias}）`,
  stillRunning: (alias) => `⏳ ${alias} 仍在执行中…`,

  // handleSessionUse / handleSessionUsePrevious / handleCancel
  noMatchingSession: (input) => `没有匹配「${input}」的会话。发 /sessions 看看有哪些。`,
  ambiguousSession: (input) => `「${input}」匹配到多个会话，请指定：`,
  noPreviousSession: "还没有上一个会话，发 /sessions 看看有哪些。",

  // handleModeShow / handleModeSet
  modeHeader: "当前 mode：",
  modeSessionLabel: (alias) => `- 会话：${alias}`,
  modeModeLabel: (modeId) => `- mode：${modeId}`,
  modeNotSet: "未设置",
  modeSet: (modeId) => `已设置当前会话 mode：${modeId}`,

  modelHeader: "当前 model：",
  modelSessionLabel: (alias) => `- 会话：${alias}`,
  modelModelLabel: (modelId) => `- model：${modelId}`,
  modelNotSet: "未设置（使用 agent 默认）",
  modelAvailableLabel: (models) => `- 可选：${models}`,
  modelSet: (modelId) => `已切换当前会话 model：${modelId}`,
  modelSetFailed: (modelId, detail) => `切换 model 失败：${modelId}\n${detail}`,

  // handleReplyModeShow / handleReplyModeSet / handleReplyModeReset
  replyModeHeader: "当前 reply mode：",
  replyModeSessionLabel: (alias) => `- 会话：${alias}`,
  replyModeGlobalDefault: (value) => `- 全局默认：${value}`,
  replyModeChannelDefault: (value) => `- 频道默认：${value}`,
  replyModeSessionOverride: (value) => `- 当前会话覆盖：${value}`,
  replyModeEffective: (value) => `- 当前生效：${value}`,
  replyModeSet: (replyMode) => `已设置当前会话 reply mode：${replyMode}`,
  replyModeReset: (effective) =>
    `已重置当前会话 reply mode，当前生效：${effective}`,

  // handleStatus
  statusHeader: "当前会话：",
  statusNameLabel: (alias) => `- 名称：${alias}`,
  statusAgentLabel: (agent) => `- Agent：${agent}`,
  statusWorkspaceLabel: (workspace) => `- 工作区：${workspace}`,

  // promptWithSession — orchestration route error
  orchestrationRouteError: "无法记录当前会话路由，已取消本次发送。",
  orchestrationRouteRetry: "请稍后重试；如果问题持续存在，请检查 xacpx 运行日志和 state.json 写入权限。",

  // handleSessionRemove
  sessionNotFound: (alias) => `会话「${alias}」不存在。`,
  sessionBlockedByTasks: (alias, count) =>
    `会话「${alias}」下还有 ${count} 个未结束的任务，请先取消或等待完成。`,
  sessionBlockedByTasksHint: "使用 /tasks 查看任务列表，或 /task cancel <id> 取消任务。",
  sessionRemoved: (alias) => `已删除会话「${alias}」。`,
  sessionArchived: (alias) => `已归档会话「${alias}」。发送消息即可恢复。`,
  sessionRemovedWasActive: "该会话是当前活跃会话，已自动清除相关聊天上下文。",
  sessionRemovedWasActivePromoted: (alias) =>
    `该会话是当前活跃会话，已切换回上一个会话「${alias}」。`,
  sessionTransportShared: (transportSession, count) =>
    `提示：后端会话「${transportSession}」仍被其他 ${count} 个会话引用，未关闭。`,
  sessionOrchestrationPurgeFailed: (warning) =>
    `提示：清理任务编排引用失败（${warning}），请稍后执行 /tasks clean 手动清理。`,
  sessionTransportTeardownFailed: (warning) =>
    `提示：后端会话未能自动关闭（${warning}），如有残留请手动执行 acpx sessions close。`,

  // sessionHelp metadata
  sessionHelpSummary: "创建、复用、切换和重置 xacpx 逻辑会话。",
  sessionHelpCmdSsList: "/sessions",
  sessionHelpCmdSsListDesc: "查看当前会话列表",
  sessionHelpCmdSsOrSlash: "/session 或 /ss",
  sessionHelpCmdSsOrSlashDesc: "查看会话列表",
  sessionHelpCmdSsQuick: "/ss <agent> (-d <path> | --ws <name>)",
  sessionHelpCmdSsQuickDesc: "快速新建或复用一个会话",
  sessionHelpCmdSsNew: "/ss new <agent> (-d <path> | --ws <name>)",
  sessionHelpCmdSsNewDesc: "强制新建会话",
  sessionHelpCmdSsNewAlias: "/ss new <alias> -a <name> --ws <name>",
  sessionHelpCmdSsNewAliasDesc: "按指定配置新建会话",
  sessionHelpCmdSsAttach: "/ss attach <alias> -a <name> --ws <name> --name <transport-session>",
  sessionHelpCmdSsAttachDesc: "绑定已有会话",
  sessionHelpCmdSsn: "/ssn 或 /help ssn",
  sessionHelpCmdSsnDesc: "接入本地 native 会话（Codex 等 Agent 原生会话）",
  sessionHelpCmdTail: "/session tail [N]",
  sessionHelpCmdTailDesc: "补拉当前会话的历史输出（默认 50 行）",
  sessionHelpCmdRm: "/session rm <alias>",
  sessionHelpCmdRmDesc: "删除逻辑会话",
  sessionHelpCmdUse: "/use <alias>",
  sessionHelpCmdUseDesc: "切换当前会话",
  sessionHelpCmdUseFuzzy: "/use <片段>",
  sessionHelpCmdUseFuzzyDesc: "按别名片段切换（精确>前缀>子串；多命中会列候选）",
  sessionHelpCmdUsePrev: "/use -",
  sessionHelpCmdUsePrevDesc: "切回上一个会话（像 shell 的 cd -）",
  sessionHelpCmdReset: "/session reset 或 /clear",
  sessionHelpCmdResetDesc: "重置当前会话上下文",

  // nativeSessionHelp metadata
  nativeHelpSummary: "接入 Codex 等 Agent 的本地原生会话。",
  nativeHelpCmdSsn: "/ssn",
  nativeHelpCmdSsnDesc: "按当前 xacpx 会话上下文查看本地 native 会话",
  nativeHelpCmdSsnAgentWs: "/ssn <agent> --ws <workspace>",
  nativeHelpCmdSsnAgentWsDesc: "查询指定工作区的本地 native 会话；只有一个候选时自动接入",
  nativeHelpCmdSsnAgentDir: "/ssn <agent> -d <path>",
  nativeHelpCmdSsnAgentDirDesc: "按本机绝对路径查询；只有一个候选时自动接入",
  nativeHelpCmdSsnAgentAll: "/ssn <agent> --ws <workspace> --all",
  nativeHelpCmdSsnAgentAllDesc: "跨 cwd 查看该 agent 的 native 会话",
  nativeHelpCmdSsnNumber: "/ssn 1",
  nativeHelpCmdSsnNumberDesc: "接入或切换到最近一次列表里的第 1 个候选",
  nativeHelpCmdSsnNumberAlias: "/ssn 1 -a <alias>",
  nativeHelpCmdSsnNumberAliasDesc: "接入第 1 个候选并指定 xacpx 别名（推荐，无需完整 sessionId）",
  nativeHelpCmdSsnAttach: "/ssn attach <sessionId> -a <alias>",
  nativeHelpCmdSsnAttachDesc: "按原生 sessionId 接入（适合已知完整 id），并指定 xacpx 别名",
  nativeHelpCmdSsnAttachLong: "/ss attach native <sessionId> -a <alias>",
  nativeHelpCmdSsnAttachLongDesc: "/ssn attach 的长写法",
  nativeHelpNote1: "/ss 管 xacpx 逻辑会话；/ssn 只负责查询和接入 Agent 原生会话。",
  nativeHelpNote2: "接入后继续发普通消息，会继续同一个 Agent 原生会话，不是复制一份新上下文。",
  nativeHelpNote3: "如果当前 acpx 或 Agent 不支持 native 会话，请继续使用 /ss。",
  nativeHelpNote4: "完整说明见 docs/native-sessions.md。",

  // modeHelp metadata
  modeHelpSummary: "查看或设置当前会话 mode。",
  modeHelpCmdShow: "/mode",
  modeHelpCmdShowDesc: "查看当前会话已保存的 mode",
  modeHelpCmdSet: "/mode <id>",
  modeHelpCmdSetDesc: "设置当前会话 mode",

  // modelHelp metadata
  modelHelpSummary: "查看或切换当前会话的 LLM model。",
  modelHelpCmdShow: "/model",
  modelHelpCmdShowDesc: "查看当前会话 model 及可选项",
  modelHelpCmdSet: "/model <id>",
  modelHelpCmdSetDesc: "切换当前会话 model（如 gpt-5.2[high]）",

  // replyModeHelp metadata
  replyModeHelpSummary: "查看或设置当前逻辑会话的回复输出模式。",
  replyModeHelpCmdShow: "/replymode",
  replyModeHelpCmdShowDesc: "查看全局默认、当前覆盖和实际生效值",
  replyModeHelpCmdStream: "/replymode stream",
  replyModeHelpCmdStreamDesc: "当前会话使用流式回复",
  replyModeHelpCmdVerbose: "/replymode verbose",
  replyModeHelpCmdVerboseDesc: "当前会话流式回复并显示工具调用",
  replyModeHelpCmdFinal: "/replymode final",
  replyModeHelpCmdFinalDesc: "当前会话只发送最终文本",
  replyModeHelpCmdReset: "/replymode reset",
  replyModeHelpCmdResetDesc: "清除当前会话覆盖并回退到全局默认",

  // statusHelp metadata
  statusHelpSummary: "查看当前选中会话的状态。",
  statusHelpCmdShow: "/status",
  statusHelpCmdShowDesc: "查看当前会话状态",

  // cancelHelp metadata
  cancelHelpSummary: "取消会话里正在执行的任务。",
  cancelHelpCmdCancel: "/cancel",
  cancelHelpCmdCancelDesc: "取消当前前台会话的任务",
  cancelHelpCmdCancelAlias: "/cancel <alias>",
  cancelHelpCmdCancelAliasDesc: "取消指定（含后台）会话的任务",
  cancelHelpCmdStop: "/stop",
  cancelHelpCmdStopDesc: "取消当前任务（/cancel 别名）",
  cancelHelpCmdStopAlias: "/stop <alias>",
  cancelHelpCmdStopAliasDesc: "取消指定会话的任务（/cancel <alias> 别名）",
};
