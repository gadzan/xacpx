import type { ConfigMessages } from "../../types";

export const config: ConfigMessages = {
  // configHelp metadata
  helpSummary: "查看和修改受支持的配置字段。",
  helpCmdShow: "/config",
  helpCmdShowDesc: "查看当前支持修改的配置路径",
  helpCmdSet: "/config set <path> <value>",
  helpCmdSetDesc: "修改一个受支持的配置值",

  // handleConfigShow — section headers
  showSupportedHeader: "支持修改的配置字段：",
  showLegacyHeader: "兼容旧配置：",
  showExamplesHeader: "示例：",

  // handleConfigShow — legacy path display strings (full display entry including path identifier)
  legacyWechatReplyMode: "wechat.replyMode（已弃用，请使用 channel.replyMode）",
  legacyChannelType: "channel.type（已禁用写入；请使用 xacpx channel ... 管理 channels[]）",
  legacyChannels: "channels[]（多频道运行配置，请编辑 JSON）",

  // handleConfigSet — no writable config
  noWritableConfig: "当前没有加载可写入的配置。",

  // handleConfigSet — success
  updated: (path, value) => `配置已更新：${path} = ${value}`,

  // handleConfigSet — restart-required topology change
  restartRequired: (path, value) => `配置已保存：${path} = ${value}。传输拓扑变更需要重启 daemon 才能生效；当前运行的 daemon 继续使用之前的传输配置。`,

  // applySupportedConfigUpdate — language
  languageInvalid: "language 只支持：en、zh",

  // applySupportedConfigUpdate — transport.type
  transportTypeInvalid: "transport.type 只支持：acpx-cli、acpx-bridge",

  // applySupportedConfigUpdate — transport.command
  transportCommandEmpty: "transport.command 不能为空。",

  // applySupportedConfigUpdate — transport.permissionMode
  transportPermissionModeInvalid: "transport.permissionMode 只支持：approve-all、approve-reads、deny-all",

  // applySupportedConfigUpdate — transport.nonInteractivePermissions
  transportNonInteractiveInvalid: "transport.nonInteractivePermissions 只支持：deny、fail",

  // applySupportedConfigUpdate — transport.permissionPolicy
  transportPermissionPolicyEmpty: "transport.permissionPolicy 不能为空。",

  // applySupportedConfigUpdate — logging.level
  loggingLevelInvalid: "logging.level 只支持：error、info、debug",

  // applySupportedConfigUpdate — positive number validation
  mustBePositiveNumber: (path) => `${path} 必须是正数。`,

  // applySupportedConfigUpdate — channel.type (legacy, write disabled)
  channelTypeDisabled:
    "channel.type 是旧单频道字段，/config set 已禁用写入；请使用 `xacpx channel ...` 管理 channels[]，然后重启 xacpx。",

  // applySupportedConfigUpdate — channel.replyMode
  channelReplyModeInvalid: "channel.replyMode 只支持：stream、final、verbose",

  // applySupportedConfigUpdate — channels.<id>.replyMode (per-channel default)
  channelRuntimeNotFound: (id) => `频道「${id}」不存在；请先用 \`xacpx channel add ${id}\` 添加。`,
  channelRuntimeReplyModeInvalid: (id) => `channels.${id}.replyMode 只支持：stream、final、verbose`,

  // applySupportedConfigUpdate — wechat.replyMode (legacy)
  wechatReplyModeInvalid: "wechat.replyMode 只支持：stream、final、verbose",

  // applySupportedConfigUpdate — wechat.replyMode mapped renderedValue
  wechatReplyModeMapped: (value) => `${value}（已映射到 channel.replyMode）`,

  // applySupportedConfigUpdate — dynamic path: agent not found
  agentNotFound: (name) => `Agent「${name}」不存在，请先创建。`,

  // applySupportedConfigUpdate — dynamic path: field cannot be empty
  fieldEmpty: (path) => `${path} 不能为空。`,

  // applySupportedConfigUpdate — dynamic path: workspace not found
  workspaceNotFound: (name) => `工作区「${name}」不存在，请先创建。`,

  // applySupportedConfigUpdate — unsupported path
  pathNotSupported: (path) => `不支持修改这个配置路径：${path}`,
};
