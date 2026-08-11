import type { ChannelCliMessages } from "../../types";

export const channelCli: ChannelCliMessages = {
  // listChannels
  noChannels: "No message channels configured yet.",
  channelListHeader: "Message channels:",

  // showChannel / showChannelAccount
  channelNotFound: (type) => `Channel not found: ${type}`,
  channelHeader: (id) => `Channel ${id}:`,
  channelNoMultiAccount: (type) => `Channel ${type} does not support --account (multi-account CLI).`,
  channelAccountNotFound: (type, accountId) => `Account ${accountId} does not exist on channel ${type}.`,
  channelAccountHeader: (id, accountId) => `Channel ${id} / account ${accountId}:`,

  // addChannel
  missingRequiredFlags: (flags) => `Missing required flags: ${flags}`,
  channelAlreadyExistsSame: (type) => `Channel ${type} already exists with the same config.`,
  channelAlreadyExistsDifferent: (type) => `Channel ${type} already exists with a different config; run: xacpx channel rm ${type}, then re-add.`,
  channelAdded: (type) => `Channel ${type} added`,

  // removeChannel
  cannotRemoveLastEnabled: "Cannot remove the last enabled channel.",
  channelRemoved: (id) => `Channel ${id} removed`,
  channelRetirementFailed: (id, error) => `Channel ${id} retirement cleanup failed: ${error}`,
  channelCredentialsCleared: (id) => `Removed stored credentials for channel ${id}`,
  channelCredentialsClearFailed: (id, error) => `Channel ${id} removed, but clearing its stored credentials failed: ${error}`,
  channelCredentialsKept: (id) => `Kept stored credentials for channel ${id} (--keep-credentials)`,

  // setChannelEnabled
  cannotDisableLastEnabled: "Cannot disable the last enabled channel.",
  channelEnabledToggled: (id, enabled) => `Channel ${id} ${enabled ? "enabled" : "disabled"}`,
  channelReplyModeSet: (id, mode) => `Channel ${id} default reply mode set to: ${mode}`,
  channelReplyModeInvalid: (mode) => `reply mode must be stream / final / verbose, got: ${mode}`,

  // addChannelAccount
  channelAccountAlreadyExists: (type, accountId) => `Account ${accountId} already exists on channel ${type}; run xacpx channel rm ${type} --account ${accountId} first`,
  channelAccountAdded: (type, accountId) => `Channel ${type} account ${accountId} added`,
  channelReEnabled: (type) => `Channel ${type} was disabled; it has been automatically re-enabled.`,

  // removeChannelAccount
  channelAccountRemoveBlockedLast: (accountId, type) => `Account ${accountId} is the last account on channel ${type}; removing it would leave the channel empty. Use xacpx channel rm ${type} instead (make sure another enabled channel exists).`,
  channelAccountRemovedWithChannel: (type, accountId) => `Account ${accountId} removed from channel ${type}; it was the last account, so channel ${type} was also removed.`,
  channelAccountRemoveBlockedAllDisabled: (type, accountId, remainingIds) => `Cannot remove ${accountId} from ${type}: remaining accounts (${remainingIds}) are all disabled. First enable one with xacpx channel enable ${type} --account <id>, or disable the whole channel with xacpx channel disable ${type}.`,
  channelAccountDefaultSwitched: (newDefault) => `Default account switched to ${newDefault}`,
  channelAccountRemoved: (type, accountId) => `Channel ${type} account ${accountId} removed`,

  // setChannelAccountEnabled
  channelAccountIncomplete: (accountId, issues) => `Account ${accountId} config is incomplete: ${issues}`,
  channelAccountCannotDisableLast: (type) => `Cannot disable the last enabled account on ${type}.`,
  channelAccountEnabledToggled: (type, accountId, enabled) => `Channel ${type} account ${accountId} ${enabled ? "enabled" : "disabled"}`,

  // unknownChannelType
  unknownChannelType: (type) => `Unknown channel type: ${type}`,
  supportedBuiltinChannels: (types) => `Supported built-in channels: ${types}`,

  // maybeRestartAfterMutation
  savedNoRestart: "Config saved; changes will take effect after the next `xacpx restart`.",
  savedDaemonIndeterminate: "Config saved; daemon state is indeterminate, skipped auto-restart. Resolve the stale PID/status first.",
  savedDaemonRunning: "Config saved; daemon is running, run `xacpx restart` to apply changes.",
  restartPrompt: "Restart xacpx now to apply changes? [y/N] ",
  savedRestartPending: "Config saved; changes will take effect after the next `xacpx restart`.",
  savedDaemonStopped: "Config saved; daemon is not running, changes will take effect after the next `xacpx start`.",

  // runRestart
  savedRestartFailed: (message) => `Config saved, but restart failed: ${message}`,
  checkLog: (path) => `Check the log: ${path}`,
  orRunLater: "Or run later: xacpx start",
};
