import type { NativeSessionMessages } from "../../types";

export const nativeSession: NativeSessionMessages = {
  // handleNativeSessionList — unsupported transport
  transportNotSupported: "当前 transport 不支持列出本地会话，请继续使用 /ss。\n说明：/help ssn",

  // handleNativeSessionList — no sessions found
  noSessionsFound: (agentDisplayName, workspaceLabel) =>
    `没有找到本地 ${agentDisplayName} 会话（${workspaceLabel}）。`,
  noSessionsFoundHint: "你可以稍后再试，或先通过 /ss 保持当前逻辑会话。",

  // handleNativeSessionSelect
  selectPrompt: "请选择要切换的 native 会话编号或 sessionId。\n说明：/help ssn",
  noCachedList: "当前没有可用的 native 会话列表，请先执行 /ssn 再选择。\n说明：/help ssn",
  indexOutOfRange: "编号超出范围，请先执行 /ssn 重新获取列表。",

  // attachNativeSession
  attachNotSupported: "当前 transport 不支持接入本地会话，请继续使用 /ss。",
  alreadySwitched: (agentDisplayName, displayAlias) =>
    `已切换到已接入的本地会话：${agentDisplayName} · ${displayAlias}`,
  attachVerificationFailed: (agentDisplayName) =>
    `本地 ${agentDisplayName} 会话接入失败：未检测到已恢复的后端会话。`,
  attachedAndSwitched: (agentDisplayName, displayAlias) =>
    `已接入本地 ${agentDisplayName} 会话并切换：${displayAlias}`,

  // resolveNativeTarget / resolveNativeWorkspace
  noContextHint: "请先选择上下文，例如：\n/ssn codex --ws project\n/ssn codex -d /Users/me/project\n说明：/help ssn",
  agentNotRegistered: (agent) => `Agent「${agent}」未注册。`,
  workspaceNotRegistered: (workspace) => `工作区「${workspace}」未注册。`,
  workspacePathNotFound: (cwd) => `工作区路径不存在：${cwd}`,
  workspaceNameUnderivable: (cwd) => `无法从目录 ${cwd} 推导工作区名称：目录名不含字母或数字。请重命名目录，或先添加一个命名工作区。`,
  noWritableConfig: "当前没有加载可写入的配置，无法根据路径创建工作区。",

  // renderNativeSessionTableList
  tableHeader: (agentDisplayName, workspaceLabel) =>
    `本地 ${agentDisplayName} 会话（${workspaceLabel}）：`,
  tableColNum: "#",
  tableColTitle: "标题",
  tableColUpdatedAt: "更新时间",
  tableColId: "ID",
  tableAttachedLabel: (displayAlias) => `已接入：${displayAlias}`,
  tableAttachedCurrent: " [当前]",
  tableActions: "操作：",
  tableActionAttach: "接入：/ssn 1",
  tableActionAlias: "指定别名：/ssn 1 -a fix-ci",
  tableActionHelp: "说明：/help ssn",
  tableMore: (cmd) => `更多：${cmd}`,

  // renderNativeSessionCardList
  cardHeader: (agentDisplayName, workspaceLabel) =>
    `本地 ${agentDisplayName} 会话（${workspaceLabel}）：`,
  cardReplyHint: "回复编号接入，ID 尾号用于区分。",
  cardTimeLabel: (updatedAt) => `时间：${updatedAt}`,
  cardIdLabel: (idTail) => `ID：${idTail}`,
  cardAttachedLabel: (displayAlias) => `已接入：${displayAlias}`,
  cardAttachedCurrent: " [当前]",
  cardActions: "操作：",
  cardActionAttach: "接入：/ssn 1",
  cardActionAlias: "指定别名：/ssn 1 -a fix-ci",
  cardActionHelp: "说明：/help ssn",
  cardMore: (cmd) => `更多：${cmd}`,

  // renderNativeListError / renderNativeResumeError
  listError: (agentDisplayName, errorMessage) =>
    `本地 ${agentDisplayName} 会话查询失败：${errorMessage}`,
  listErrorHint: "请确认 acpx/Agent 支持 native 会话查询，或继续使用 /ss。",
  listErrorHelp: "说明：/help ssn",
  resumeError: (agentDisplayName, errorMessage) =>
    `本地 ${agentDisplayName} 会话接入失败：${errorMessage}`,
  resumeErrorHint: "请确认 acpx/Agent 支持 native 会话恢复，或继续使用 /ss。",
  resumeErrorHelp: "说明：/help ssn",
};
