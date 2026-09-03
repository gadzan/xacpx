import type { ConfigMessages } from "../../types";

export const config: ConfigMessages = {
  // configHelp metadata
  helpSummary: "View and modify supported configuration fields.",
  helpCmdShow: "/config",
  helpCmdShowDesc: "View the list of supported config paths",
  helpCmdSet: "/config set <path> <value>",
  helpCmdSetDesc: "Modify a supported config value",

  // handleConfigShow — section headers
  showSupportedHeader: "Supported config fields:",
  showLegacyHeader: "Legacy config compatibility:",
  showExamplesHeader: "Examples:",

  // handleConfigShow — legacy path display strings (full display entry including path identifier)
  legacyWechatReplyMode: "wechat.replyMode (deprecated, use channel.replyMode instead)",
  legacyChannelType: "channel.type (write disabled; use xacpx channel ... to manage channels[])",
  legacyChannels: "channels[] (multi-channel config, edit JSON directly)",

  // handleConfigSet — no writable config
  noWritableConfig: "No writable config is currently loaded.",

  // handleConfigSet — success
  updated: (path, value) => `Config updated: ${path} = ${value}`,

  // handleConfigSet — restart-required topology change
  restartRequired: (path, value) => `Config saved: ${path} = ${value}. Transport topology changes require a daemon restart to take effect; the running daemon keeps its previous transport.`,

  // applySupportedConfigUpdate — language
  languageInvalid: "language only supports: en, zh",

  // applySupportedConfigUpdate — transport.type
  transportTypeInvalid: "transport.type only supports: acpx-cli, acpx-bridge",

  // applySupportedConfigUpdate — transport.command
  transportCommandEmpty: "transport.command cannot be empty.",

  // applySupportedConfigUpdate — transport.permissionMode
  transportPermissionModeInvalid: "transport.permissionMode only supports: approve-all, approve-reads, deny-all",

  // applySupportedConfigUpdate — transport.nonInteractivePermissions
  transportNonInteractiveInvalid: "transport.nonInteractivePermissions only supports: deny, fail",

  // applySupportedConfigUpdate — transport.permissionPolicy
  transportPermissionPolicyEmpty: "transport.permissionPolicy cannot be empty.",

  // applySupportedConfigUpdate — logging.level
  loggingLevelInvalid: "logging.level only supports: error, info, debug",

  // applySupportedConfigUpdate — positive number validation
  mustBePositiveNumber: (path) => `${path} must be a positive number.`,

  // applySupportedConfigUpdate — channel.type (legacy, write disabled)
  channelTypeDisabled:
    "channel.type is a legacy single-channel field; /config set writes are disabled. Use `xacpx channel ...` to manage channels[], then restart xacpx.",

  // applySupportedConfigUpdate — channel.replyMode
  channelReplyModeInvalid: "channel.replyMode only supports: stream, final, verbose",

  // applySupportedConfigUpdate — channels.<id>.replyMode (per-channel default)
  channelRuntimeNotFound: (id) => `Channel "${id}" does not exist; add it first with \`xacpx channel add ${id}\`.`,
  channelRuntimeReplyModeInvalid: (id) => `channels.${id}.replyMode only supports: stream, final, verbose`,

  // applySupportedConfigUpdate — wechat.replyMode (legacy)
  wechatReplyModeInvalid: "wechat.replyMode only supports: stream, final, verbose",

  // applySupportedConfigUpdate — wechat.replyMode mapped renderedValue
  wechatReplyModeMapped: (value) => `${value} (mapped to channel.replyMode)`,

  // applySupportedConfigUpdate — dynamic path: agent not found
  agentNotFound: (name) => `Agent "${name}" does not exist. Create it first.`,

  // applySupportedConfigUpdate — dynamic path: field cannot be empty
  fieldEmpty: (path) => `${path} cannot be empty.`,

  // applySupportedConfigUpdate — dynamic path: workspace not found
  workspaceNotFound: (name) => `Workspace "${name}" does not exist. Create it first.`,

  // applySupportedConfigUpdate — unsupported path
  pathNotSupported: (path) => `This config path is not supported: ${path}`,
};
