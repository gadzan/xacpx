import type { ChannelCliMessages } from "../../types";

export const channelCli: ChannelCliMessages = {
  // listChannels
  noChannels: "还没有配置消息频道。",
  channelListHeader: "消息频道：",

  // showChannel / showChannelAccount
  channelNotFound: (type) => `没有找到频道：${type}`,
  channelHeader: (id) => `频道 ${id}:`,
  channelNoMultiAccount: (type) => `频道 ${type} 不支持 --account（多账号 CLI）。`,
  channelAccountNotFound: (type, accountId) => `频道 ${type} 的账号 ${accountId} 不存在。`,
  channelAccountHeader: (id, accountId) => `频道 ${id} / 账号 ${accountId}:`,

  // addChannel
  missingRequiredFlags: (flags) => `缺少必填参数：${flags}`,
  channelAlreadyExistsSame: (type) => `频道 ${type} 已存在，配置相同。`,
  channelAlreadyExistsDifferent: (type) => `频道 ${type} 已存在但配置不同；请先执行：xacpx channel rm ${type}，然后重新 add。`,
  channelAdded: (type) => `频道 ${type} 已添加`,

  // removeChannel
  cannotRemoveLastEnabled: "不能删除最后一个启用的频道。",
  channelRemoved: (id) => `频道 ${id} 已删除`,
  channelRetirementFailed: (id, error) => `频道 ${id} 退役清理失败：${error}`,
  channelRetirementDeferredUntilRestart: (id) =>
    `频道 ${id} 的终端退役已推迟到守护进程重启（当前 sidecar 仍持有会话）`,
  channelCredentialsCleared: (id) => `已移除频道 ${id} 的存储凭证`,
  channelCredentialsClearFailed: (id, error) => `频道 ${id} 已删除，但清除其存储凭证失败：${error}`,
  channelCredentialsKept: (id) => `已保留频道 ${id} 的存储凭证（--keep-credentials）`,

  // setChannelEnabled
  cannotDisableLastEnabled: "不能禁用最后一个启用的频道。",
  channelEnabledToggled: (id, enabled) => `频道 ${id} 已${enabled ? "启用" : "禁用"}`,
  channelReplyModeSet: (id, mode) => `频道 ${id} 的默认 reply mode 已设置为：${mode}`,
  channelReplyModeInvalid: (mode) => `reply mode 只支持 stream / final / verbose，收到：${mode}`,

  // addChannelAccount
  channelAccountAlreadyExists: (type, accountId) => `频道 ${type} 的账号 ${accountId} 已存在；先 xacpx channel rm ${type} --account ${accountId}`,
  channelAccountAdded: (type, accountId) => `频道 ${type} 账号 ${accountId} 已添加`,
  channelReEnabled: (type) => `频道 ${type} 此前是 disabled 状态，已自动启用。`,

  // removeChannelAccount
  channelAccountRemoveBlockedLast: (accountId, type) => `账号 ${accountId} 是频道 ${type} 的最后一个账号；删除会导致频道空配置。请改用 xacpx channel rm ${type}（先确认还有别的启用频道）。`,
  channelAccountRemovedWithChannel: (type, accountId) => `频道 ${type} 的账号 ${accountId} 已移除；该账号是最后一个，频道 ${type} 也已删除。`,
  channelAccountRemoveBlockedAllDisabled: (type, accountId, remainingIds) => `不能移除 ${type} 的 ${accountId}：剩余账号 (${remainingIds}) 都已 disabled。先 xacpx channel enable ${type} --account <id> 一个，或 xacpx channel disable ${type} 整个频道。`,
  channelAccountDefaultSwitched: (newDefault) => `默认账号已切换到 ${newDefault}`,
  channelAccountRemoved: (type, accountId) => `频道 ${type} 账号 ${accountId} 已移除`,

  // setChannelAccountEnabled
  channelAccountIncomplete: (accountId, issues) => `账号 ${accountId} 配置不完整：${issues}`,
  channelAccountCannotDisableLast: (type) => `不能禁用 ${type} 的最后一个启用账号。`,
  channelAccountEnabledToggled: (type, accountId, enabled) => `频道 ${type} 账号 ${accountId} 已${enabled ? "启用" : "禁用"}`,

  // unknownChannelType
  unknownChannelType: (type) => `未知频道类型：${type}`,
  supportedBuiltinChannels: (types) => `支持的内置频道：${types}`,

  // maybeRestartAfterMutation
  savedNoRestart: "配置已保存；变更会在下次 `xacpx restart` 后生效。",
  savedDaemonIndeterminate: "配置已保存；daemon 状态异常，已跳过自动重启。请先处理 stale PID/status。",
  savedDaemonRunning: "配置已保存；daemon 正在运行，请执行 `xacpx restart` 使变更生效。",
  restartPrompt: "现在重启 xacpx 使变更生效？[y/N] ",
  savedRestartPending: "配置已保存；变更会在下次 `xacpx restart` 后生效。",
  savedDaemonStopped: "配置已保存；daemon 未运行，变更会在下次 `xacpx start` 后生效。",

  // runRestart
  savedRestartFailed: (message) => `配置已保存，但重启失败：${message}`,
  checkLog: (path) => `请查看日志：${path}`,
  orRunLater: "也可以稍后执行：xacpx start",
};
