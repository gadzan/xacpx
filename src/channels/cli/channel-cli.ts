import { isDeepStrictEqual } from "node:util";
import type { AppConfig, ChannelRuntimeConfig } from "../../config/types";
import { coreHomeDisplayPath } from "../../runtime/core-home";
import { getChannelCliProvider, listChannelCliProviders } from "./registry";
import type { ChannelCliIo, ChannelCliProvider, ChannelCliValidationIssue } from "./provider";
import { getMovedChannelInstallHint } from "../create-channel";
import { t } from "../../i18n";

type RestartChoice = "restart" | "no-restart" | "ask";

type DaemonStatusForChannelCli =
  | { state: "stopped"; stale?: boolean }
  | { state: "running"; pid: number }
  | { state: "indeterminate"; pid: number; reason: string };

export interface ChannelCliDeps extends ChannelCliIo {
  loadConfig: () => Promise<AppConfig>;
  /** Persists only the channels[] subtree — never the whole parsed config. */
  saveChannels: (channels: ChannelRuntimeConfig[]) => Promise<void>;
  getDaemonStatus: () => Promise<DaemonStatusForChannelCli>;
  restartDaemon: () => Promise<number>;
  /**
   * Optional: clears a channel's stored credentials via the runtime's
   * destructive `logout()` hook (e.g. the relay instance credential at
   * ~/.xacpx/relay/credential.json). Invoked by `channel rm` unless
   * `--keep-credentials`. Absent in some test harnesses, where rm stays
   * config-only.
   */
  clearChannelCredentials?: (channel: ChannelRuntimeConfig) => Promise<void>;
  /**
   * Optional: async retirement hook invoked before a channel is disabled or
   * removed. Production wires this to `invokeChannelRetireHook`, which calls
   * the loaded plugin's `ChannelPluginDefinition.retireChannel` by type.
   * Failures are logged but do not block the config mutation.
   */
  retireChannel?: (channel: ChannelRuntimeConfig, reason: "disabled" | "removed") => Promise<void>;
}

export async function handleChannelCli(args: string[], deps: ChannelCliDeps): Promise<number | null> {
  const subcommand = args[0];
  switch (subcommand) {
    case "list":
      if (args.length !== 1) return null;
      return await listChannels(deps);
    case "show":
      if (args.length < 2 || !args[1]) return null;
      return await dispatchShow(args[1], args.slice(2), deps);
    case "add":
      if (args.length < 2 || !args[1]) return null;
      return await dispatchAdd(args[1], args.slice(2), deps);
    case "rm":
      if (args.length < 2 || !args[1]) return null;
      return await dispatchRemove(args[1], args.slice(2), deps);
    case "enable":
      if (args.length < 2 || !args[1]) return null;
      return await dispatchSetEnabled(args[1], true, args.slice(2), deps);
    case "disable":
      if (args.length < 2 || !args[1]) return null;
      return await dispatchSetEnabled(args[1], false, args.slice(2), deps);
    case "set-reply-mode":
      if (args.length < 3 || !args[1] || !args[2]) return null;
      return await setChannelReplyMode(args[1], args[2], args.slice(3), deps);
    default:
      return null;
  }
}

function takeAccountFlag(args: string[]): { ok: true; rest: string[]; account?: string } | { ok: false; message: string } {
  const rest: string[] = [];
  let account: string | undefined;
  const setAccount = (value: string): { ok: false; message: string } | null => {
    if (account !== undefined) return { ok: false, message: "--account cannot be specified more than once" };
    const trimmed = value.trim();
    if (trimmed.length === 0) return { ok: false, message: "--account requires a non-empty value" };
    account = trimmed;
    return null;
  };
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]!;
    if (arg === "--account") {
      const value = args[i + 1];
      if (value === undefined || value.startsWith("--")) return { ok: false, message: "--account requires a value" };
      const err = setAccount(value);
      if (err) return err;
      i += 1;
      continue;
    }
    if (arg.startsWith("--account=")) {
      const err = setAccount(arg.slice("--account=".length));
      if (err) return err;
      continue;
    }
    rest.push(arg);
  }
  return { ok: true, rest, ...(account !== undefined ? { account } : {}) };
}

async function dispatchShow(type: string, rawArgs: string[], deps: ChannelCliDeps): Promise<number | null> {
  const accountFlag = takeAccountFlag(rawArgs);
  if (!accountFlag.ok) {
    deps.print(accountFlag.message);
    return 1;
  }
  if (accountFlag.rest.length > 0) return null;
  if (accountFlag.account) return await showChannelAccount(type, accountFlag.account, deps);
  return await showChannel(type, deps);
}

async function dispatchAdd(type: string, rawArgs: string[], deps: ChannelCliDeps): Promise<number> {
  const accountFlag = takeAccountFlag(rawArgs);
  if (!accountFlag.ok) {
    deps.print(accountFlag.message);
    return 1;
  }
  if (accountFlag.account) return await addChannelAccount(type, accountFlag.account, accountFlag.rest, deps);
  return await addChannel(type, accountFlag.rest, deps);
}

async function dispatchRemove(type: string, rawArgs: string[], deps: ChannelCliDeps): Promise<number> {
  const accountFlag = takeAccountFlag(rawArgs);
  if (!accountFlag.ok) {
    deps.print(accountFlag.message);
    return 1;
  }
  if (accountFlag.account) return await removeChannelAccount(type, accountFlag.account, accountFlag.rest, deps);
  return await removeChannel(type, accountFlag.rest, deps);
}

async function dispatchSetEnabled(type: string, enabled: boolean, rawArgs: string[], deps: ChannelCliDeps): Promise<number> {
  const accountFlag = takeAccountFlag(rawArgs);
  if (!accountFlag.ok) {
    deps.print(accountFlag.message);
    return 1;
  }
  if (accountFlag.account) return await setChannelAccountEnabled(type, accountFlag.account, enabled, accountFlag.rest, deps);
  return await setChannelEnabled(type, enabled, accountFlag.rest, deps);
}

function ensureChannelsArray(config: AppConfig): asserts config is AppConfig & { channels: NonNullable<AppConfig["channels"]> } {
  if (!config.channels) config.channels = [];
}

async function listChannels(deps: ChannelCliDeps): Promise<number> {
  const config = await deps.loadConfig();
  ensureChannelsArray(config);
  if (config.channels.length === 0) {
    deps.print(t().channelCli.noChannels);
    return 0;
  }
  deps.print(t().channelCli.channelListHeader);
  for (const channel of config.channels) {
    deps.print(`- ${channel.id} (${channel.enabled ? "enabled" : "disabled"})`);
  }
  return 0;
}

async function showChannel(type: string, deps: ChannelCliDeps): Promise<number> {
  const config = await deps.loadConfig();
  ensureChannelsArray(config);
  const channel = findChannel(config.channels, type);
  if (!channel) {
    deps.print(t().channelCli.channelNotFound(type));
    return 1;
  }
  const provider = getChannelCliProvider(channel.type);
  deps.print(t().channelCli.channelHeader(channel.id));
  const lines = provider?.renderSummary(channel) ?? renderGenericSummary(channel);
  for (const line of lines) deps.print(line);
  return 0;
}

async function showChannelAccount(type: string, accountId: string, deps: ChannelCliDeps): Promise<number> {
  const config = await deps.loadConfig();
  ensureChannelsArray(config);
  const channel = findChannel(config.channels, type);
  if (!channel) {
    deps.print(t().channelCli.channelNotFound(type));
    return 1;
  }
  const provider = getChannelCliProvider(channel.type);
  if (!provider?.supportsMultipleAccounts || !provider.renderAccountSummary) {
    deps.print(t().channelCli.channelNoMultiAccount(type));
    return 1;
  }
  const lines = provider.renderAccountSummary(channel, accountId);
  if (!lines) {
    deps.print(t().channelCli.channelAccountNotFound(type, accountId));
    return 1;
  }
  deps.print(t().channelCli.channelAccountHeader(channel.id, accountId));
  for (const line of lines) deps.print(line);
  return 0;
}

function findChannel(channels: ChannelRuntimeConfig[], type: string): ChannelRuntimeConfig | undefined {
  return channels.find((channel) => channel.type === type || channel.id === type);
}

function renderGenericSummary(channel: ChannelRuntimeConfig): string[] {
  return [`type: ${channel.type}`, `enabled: ${channel.enabled}`];
}

async function addChannel(type: string, rawArgs: string[], deps: ChannelCliDeps): Promise<number> {
  const restartFlags = parseRestartFlags(rawArgs);
  if (!restartFlags.ok) {
    deps.print(restartFlags.message);
    return 1;
  }

  const provider = getChannelCliProvider(type);
  if (!provider) return unknownChannelType(type, deps);

  const parsed = provider.parseAddArgs(restartFlags.rest);
  if (!parsed.ok) {
    deps.print(parsed.message);
    return 1;
  }

  let input = parsed.input;
  let candidate = provider.buildDefaultConfig(input);
  let issues = provider.validateConfig(candidate);
  const missing = missingRequiredFlags(issues);
  if (missing.length > 0) {
    if (!deps.isInteractive()) {
      deps.print(t().channelCli.missingRequiredFlags(missing.join(", ")));
      return 1;
    }
    input = await provider.promptForMissingFields(input, deps);
    candidate = provider.buildDefaultConfig(input);
    issues = provider.validateConfig(candidate);
  }

  const remainingMissing = missingRequiredFlags(issues);
  if (remainingMissing.length > 0) {
    deps.print(t().channelCli.missingRequiredFlags(remainingMissing.join(", ")));
    return 1;
  }

  if (issues.length > 0) {
    deps.print(issues.map((issue) => issue.message).join("；"));
    return 1;
  }

  const config = await deps.loadConfig();
  ensureChannelsArray(config);
  const existing = findChannel(config.channels, type);
  if (existing) {
    if (equivalentChannelConfig(existing, candidate)) {
      deps.print(t().channelCli.channelAlreadyExistsSame(type));
      return 0;
    }
    deps.print(t().channelCli.channelAlreadyExistsDifferent(type));
    return 1;
  }

  config.channels = [...(config.channels ?? []), candidate];
  await deps.saveChannels(config.channels);
  deps.print(t().channelCli.channelAdded(type));
  for (const line of provider.renderSummary(candidate)) deps.print(line);
  return await maybeRestartAfterMutation(restartFlags.restart, deps);
}

function parseRestartFlags(args: string[]): { ok: true; rest: string[]; restart: RestartChoice } | { ok: false; message: string } {
  let restart = false;
  let noRestart = false;
  const rest: string[] = [];
  for (const arg of args) {
    if (arg === "--restart") restart = true;
    else if (arg === "--no-restart") noRestart = true;
    else rest.push(arg);
  }
  if (restart && noRestart) return { ok: false, message: "--restart and --no-restart cannot be used together" };
  return { ok: true, rest, restart: restart ? "restart" : noRestart ? "no-restart" : "ask" };
}

function equivalentChannelConfig(a: ChannelRuntimeConfig, b: ChannelRuntimeConfig): boolean {
  return isDeepStrictEqual(a, b);
}

function missingRequiredFlags(issues: ChannelCliValidationIssue[]): string[] {
  return issues
    .filter((issue): issue is Extract<ChannelCliValidationIssue, { kind: "missing-required-field" }> => issue.kind === "missing-required-field")
    .map((issue) => issue.flag);
}

function unknownChannelType(type: string, deps: ChannelCliDeps): number {
  const movedHint = getMovedChannelInstallHint(type);
  if (movedHint) {
    deps.print(movedHint);
    return 1;
  }
  deps.print(t().channelCli.unknownChannelType(type));
  deps.print(t().channelCli.supportedBuiltinChannels(listChannelCliProviders().map((provider) => provider.type).join(", ")));
  return 1;
}

async function maybeRestartAfterMutation(choice: RestartChoice, deps: ChannelCliDeps): Promise<number> {
  if (choice === "no-restart") {
    deps.print(t().channelCli.savedNoRestart);
    return 0;
  }
  const status = await deps.getDaemonStatus();
  if (choice === "restart") {
    if (status.state === "indeterminate") {
      deps.print(t().channelCli.savedDaemonIndeterminate);
      return 0;
    }
    return await runRestart(deps);
  }
  if (status.state === "running") {
    if (!deps.isInteractive()) {
      deps.print(t().channelCli.savedDaemonRunning);
      return 0;
    }
    const answer = (await deps.promptText(t().channelCli.restartPrompt)).trim().toLowerCase();
    if (answer === "y" || answer === "yes") return await runRestart(deps);
    deps.print(t().channelCli.savedRestartPending);
    return 0;
  }
  if (status.state === "indeterminate") {
    deps.print(t().channelCli.savedDaemonIndeterminate);
    return 0;
  }
  deps.print(t().channelCli.savedDaemonStopped);
  return 0;
}

async function runRestart(deps: ChannelCliDeps): Promise<number> {
  try {
    return await deps.restartDaemon();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    deps.print(t().channelCli.savedRestartFailed(message));
    deps.print(t().channelCli.checkLog(coreHomeDisplayPath("runtime", "stderr.log")));
    deps.print(t().channelCli.orRunLater);
    return 1;
  }
}

function enabledCount(channels: ChannelRuntimeConfig[]): number {
  return channels.filter((channel) => channel.enabled).length;
}

async function removeChannel(type: string, rawArgs: string[], deps: ChannelCliDeps): Promise<number> {
  const restartFlags = parseRestartFlags(rawArgs);
  if (!restartFlags.ok) {
    deps.print(restartFlags.message);
    return 1;
  }
  const keepCredentials = restartFlags.rest.includes("--keep-credentials");
  const config = await deps.loadConfig();
  ensureChannelsArray(config);
  const channel = findChannel(config.channels, type);
  if (!channel) {
    deps.print(t().channelCli.channelNotFound(type));
    return 1;
  }
  if (channel.enabled && enabledCount(config.channels) <= 1) {
    deps.print(t().channelCli.cannotRemoveLastEnabled);
    return 1;
  }

  // Invoke retirement hook before removing config. This allows the channel to
  // perform one-shot maintenance cleanup (e.g. relay terminal cleanup) using
  // the original config before it's discarded. Failures are logged but do not
  // block removal.
  if (deps.retireChannel) {
    try {
      await deps.retireChannel(channel, "removed");
    } catch (error) {
      deps.print(t().channelCli.channelRetirementFailed(channel.id, error instanceof Error ? error.message : String(error)));
    }
  }

  config.channels = config.channels.filter((entry) => entry.id !== channel.id);
  await deps.saveChannels(config.channels);
  deps.print(t().channelCli.channelRemoved(channel.id));
  // Removing a channel also clears its stored credentials (e.g. the relay
  // instance credential) so a later re-add re-pairs cleanly instead of reusing
  // an orphaned credential. --keep-credentials opts out (e.g. temporarily
  // removing a channel without dropping its login).
  if (keepCredentials) {
    deps.print(t().channelCli.channelCredentialsKept(channel.id));
  } else if (deps.clearChannelCredentials) {
    try {
      await deps.clearChannelCredentials(channel);
      deps.print(t().channelCli.channelCredentialsCleared(channel.id));
    } catch (error) {
      deps.print(t().channelCli.channelCredentialsClearFailed(channel.id, error instanceof Error ? error.message : String(error)));
    }
  }
  return await maybeRestartAfterMutation(restartFlags.restart, deps);
}

async function setChannelEnabled(type: string, enabled: boolean, rawArgs: string[], deps: ChannelCliDeps): Promise<number> {
  const restartFlags = parseRestartFlags(rawArgs);
  if (!restartFlags.ok) {
    deps.print(restartFlags.message);
    return 1;
  }
  const config = await deps.loadConfig();
  ensureChannelsArray(config);
  const channel = findChannel(config.channels, type);
  if (!channel) {
    deps.print(t().channelCli.channelNotFound(type));
    return 1;
  }
  if (!enabled && channel.enabled && enabledCount(config.channels) <= 1) {
    deps.print(t().channelCli.cannotDisableLastEnabled);
    return 1;
  }

  // Invoke retirement hook before disabling. This allows the channel to
  // perform one-shot maintenance cleanup using the original enabled config.
  // Failures are logged but do not block disable.
  if (!enabled && channel.enabled && deps.retireChannel) {
    try {
      await deps.retireChannel(channel, "disabled");
    } catch (error) {
      deps.print(t().channelCli.channelRetirementFailed(channel.id, error instanceof Error ? error.message : String(error)));
    }
  }

  channel.enabled = enabled;
  await deps.saveChannels(config.channels);
  deps.print(t().channelCli.channelEnabledToggled(channel.id, enabled));
  return await maybeRestartAfterMutation(restartFlags.restart, deps);
}

async function setChannelReplyMode(type: string, mode: string, rawArgs: string[], deps: ChannelCliDeps): Promise<number> {
  const restartFlags = parseRestartFlags(rawArgs);
  if (!restartFlags.ok) {
    deps.print(restartFlags.message);
    return 1;
  }
  // Mirrors the private isReplyMode guard in src/config/load-config.ts; keep the
  // accepted values in sync if ReplyMode ever changes.
  if (mode !== "stream" && mode !== "final" && mode !== "verbose") {
    deps.print(t().channelCli.channelReplyModeInvalid(mode));
    return 1;
  }
  const config = await deps.loadConfig();
  ensureChannelsArray(config);
  const channel = findChannel(config.channels, type);
  if (!channel) {
    deps.print(t().channelCli.channelNotFound(type));
    return 1;
  }
  channel.replyMode = mode;
  await deps.saveChannels(config.channels);
  deps.print(t().channelCli.channelReplyModeSet(channel.id, mode));
  return await maybeRestartAfterMutation(restartFlags.restart, deps);
}

function requireMultiAccountProvider(type: string, deps: ChannelCliDeps): ChannelCliProvider | null {
  const provider = getChannelCliProvider(type);
  if (!provider) {
    unknownChannelType(type, deps);
    return null;
  }
  if (!provider.supportsMultipleAccounts || !provider.buildAccountOverride) {
    deps.print(t().channelCli.channelNoMultiAccount(type));
    return null;
  }
  return provider;
}

function readOptions(channel: ChannelRuntimeConfig): Record<string, unknown> {
  return (channel.options as Record<string, unknown> | undefined) ?? {};
}

function readAccounts(options: Record<string, unknown>): Record<string, Record<string, unknown>> | null {
  const accounts = options.accounts;
  if (accounts === undefined || accounts === null) return null;
  if (typeof accounts !== "object") return null;
  return accounts as Record<string, Record<string, unknown>>;
}

function buildAccountValidationProbe(
  existing: ChannelRuntimeConfig,
  accountId: string,
  channelLevelKeys: ReadonlySet<string>,
): ChannelRuntimeConfig | null {
  const options = readOptions(existing);
  const accounts = readAccounts(options);
  if (!accounts || !(accountId in accounts)) return null;
  const account = accounts[accountId];
  const flatOptions: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(options)) {
    if (channelLevelKeys.has(key)) continue;
    flatOptions[key] = value;
  }
  Object.assign(flatOptions, account);
  delete flatOptions.enabled;
  delete flatOptions.name;
  return { id: existing.id, type: existing.type, enabled: existing.enabled, options: flatOptions };
}

function countEnabledAccounts(accounts: Record<string, Record<string, unknown>>): number {
  return Object.values(accounts).filter((acc) => acc.enabled !== false).length;
}

function migrateFlatToAccounts(
  options: Record<string, unknown>,
  channelLevelKeys: ReadonlySet<string>,
): { channelLevel: Record<string, unknown>; defaultAccountConfig: Record<string, unknown>; defaultAccountId: string } {
  const channelLevel: Record<string, unknown> = {};
  const defaultAccountConfig: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(options)) {
    if (channelLevelKeys.has(key)) channelLevel[key] = value;
    else defaultAccountConfig[key] = value;
  }
  const defaultAccountId = typeof options.defaultAccount === "string" && options.defaultAccount.trim().length > 0
    ? options.defaultAccount.trim()
    : "default";
  return { channelLevel, defaultAccountConfig, defaultAccountId };
}

async function addChannelAccount(type: string, accountId: string, rawArgs: string[], deps: ChannelCliDeps): Promise<number> {
  const restartFlags = parseRestartFlags(rawArgs);
  if (!restartFlags.ok) {
    deps.print(restartFlags.message);
    return 1;
  }
  const provider = requireMultiAccountProvider(type, deps);
  if (!provider) return 1;

  const parsed = provider.parseAddArgs(restartFlags.rest);
  if (!parsed.ok) {
    deps.print(parsed.message);
    return 1;
  }

  let input = parsed.input;
  let probe = provider.buildDefaultConfig(input);
  let issues = provider.validateConfig(probe);
  const missing = missingRequiredFlags(issues);
  if (missing.length > 0) {
    if (!deps.isInteractive()) {
      deps.print(t().channelCli.missingRequiredFlags(missing.join(", ")));
      return 1;
    }
    input = await provider.promptForMissingFields(input, deps);
    probe = provider.buildDefaultConfig(input);
    issues = provider.validateConfig(probe);
  }
  const remainingMissing = missingRequiredFlags(issues);
  if (remainingMissing.length > 0) {
    deps.print(t().channelCli.missingRequiredFlags(remainingMissing.join(", ")));
    return 1;
  }
  if (issues.length > 0) {
    deps.print(issues.map((issue) => issue.message).join("；"));
    return 1;
  }

  const override = provider.buildAccountOverride!(input);

  const config = await deps.loadConfig();
  ensureChannelsArray(config);
  const existing = findChannel(config.channels, type);
  const channelLevelKeys = new Set<string>([...(provider.channelLevelOptionKeys ?? []), "accounts", "defaultAccount"]);

  let result: ChannelRuntimeConfig;
  let reEnabledChannel = false;
  if (!existing) {
    result = {
      id: type,
      type,
      enabled: true,
      options: { defaultAccount: accountId, accounts: { [accountId]: override } },
    };
    config.channels = [...config.channels, result];
  } else {
    const options = { ...readOptions(existing) };
    let accounts = readAccounts(options);
    if (!accounts) {
      const migrated = migrateFlatToAccounts(options, channelLevelKeys);
      accounts = { [migrated.defaultAccountId]: migrated.defaultAccountConfig };
      for (const key of Object.keys(options)) {
        if (!channelLevelKeys.has(key)) delete options[key];
      }
      options.defaultAccount = migrated.defaultAccountId;
      Object.assign(options, migrated.channelLevel);
    } else {
      accounts = { ...accounts };
    }
    if (accountId in accounts) {
      deps.print(t().channelCli.channelAccountAlreadyExists(type, accountId));
      return 1;
    }
    accounts[accountId] = override;
    options.accounts = accounts;
    if (typeof options.defaultAccount !== "string" || options.defaultAccount.trim().length === 0 || !(options.defaultAccount in accounts)) {
      options.defaultAccount = accountId;
    }
    existing.options = options;
    if (!existing.enabled) {
      existing.enabled = true;
      reEnabledChannel = true;
    }
    result = existing;
  }

  const validation = provider.validateConfig(result);
  if (validation.length > 0) {
    deps.print(validation.map((issue) => issue.message).join("；"));
    return 1;
  }

  await deps.saveChannels(config.channels);
  deps.print(t().channelCli.channelAccountAdded(type, accountId));
  if (reEnabledChannel) deps.print(t().channelCli.channelReEnabled(type));
  const summary = provider.renderAccountSummary?.(result, accountId);
  if (summary) for (const line of summary) deps.print(line);
  return await maybeRestartAfterMutation(restartFlags.restart, deps);
}

async function removeChannelAccount(type: string, accountId: string, rawArgs: string[], deps: ChannelCliDeps): Promise<number> {
  const restartFlags = parseRestartFlags(rawArgs);
  if (!restartFlags.ok) {
    deps.print(restartFlags.message);
    return 1;
  }
  const provider = requireMultiAccountProvider(type, deps);
  if (!provider) return 1;

  const config = await deps.loadConfig();
  ensureChannelsArray(config);
  const existing = findChannel(config.channels, type);
  if (!existing) {
    deps.print(t().channelCli.channelNotFound(type));
    return 1;
  }
  const options = { ...readOptions(existing) };
  const accounts = readAccounts(options);
  if (!accounts || !(accountId in accounts)) {
    deps.print(t().channelCli.channelAccountNotFound(type, accountId));
    return 1;
  }
  const remaining = { ...accounts };
  delete remaining[accountId];

  if (Object.keys(remaining).length === 0) {
    if (existing.enabled && enabledCount(config.channels) <= 1) {
      deps.print(t().channelCli.channelAccountRemoveBlockedLast(accountId, type));
      return 1;
    }
    config.channels = config.channels.filter((channel) => channel.id !== existing.id);
    await deps.saveChannels(config.channels);
    deps.print(t().channelCli.channelAccountRemovedWithChannel(type, accountId));
    return await maybeRestartAfterMutation(restartFlags.restart, deps);
  }

  // 删除后剩下的账号若全部 disabled，启用中的 channel 在 daemon 启动时会被
  // schema 拒绝（至少要一个 enabled+configured 账号）。在这里就拦下。
  if (existing.enabled && countEnabledAccounts(remaining) === 0) {
    const remainingIds = Object.keys(remaining).join(", ");
    deps.print(t().channelCli.channelAccountRemoveBlockedAllDisabled(type, accountId, remainingIds));
    return 1;
  }

  options.accounts = remaining;
  const remainingIds = Object.keys(remaining);
  const currentDefault = typeof options.defaultAccount === "string" ? options.defaultAccount : null;
  if (currentDefault === accountId || (currentDefault !== null && !(currentDefault in remaining))) {
    options.defaultAccount = remainingIds[0]!;
    deps.print(t().channelCli.channelAccountDefaultSwitched(options.defaultAccount as string));
  }
  existing.options = options;
  await deps.saveChannels(config.channels);
  deps.print(t().channelCli.channelAccountRemoved(type, accountId));
  return await maybeRestartAfterMutation(restartFlags.restart, deps);
}

async function setChannelAccountEnabled(type: string, accountId: string, enabled: boolean, rawArgs: string[], deps: ChannelCliDeps): Promise<number> {
  const restartFlags = parseRestartFlags(rawArgs);
  if (!restartFlags.ok) {
    deps.print(restartFlags.message);
    return 1;
  }
  const provider = requireMultiAccountProvider(type, deps);
  if (!provider) return 1;

  const config = await deps.loadConfig();
  ensureChannelsArray(config);
  const existing = findChannel(config.channels, type);
  if (!existing) {
    deps.print(t().channelCli.channelNotFound(type));
    return 1;
  }
  const options = { ...readOptions(existing) };
  const accounts = readAccounts(options);
  if (!accounts || !(accountId in accounts)) {
    deps.print(t().channelCli.channelAccountNotFound(type, accountId));
    return 1;
  }
  const account = { ...accounts[accountId] };
  account.enabled = enabled;
  const nextAccounts = { ...accounts, [accountId]: account };
  // Treat missing `enabled` as true (matches FeishuResolvedAccountConfig defaults).
  const enabledRemaining = Object.values(nextAccounts).filter((acc) => acc.enabled !== false);
  if (!enabled && enabledRemaining.length === 0) {
    deps.print(t().channelCli.channelAccountCannotDisableLast(type));
    return 1;
  }
  options.accounts = nextAccounts;

  // Enable 路径下，要确认目标账号本身可启动；否则会保存出"启用了但运行时
  // 不会真启动这个 bot"的迷惑配置。把 channel-level 字段剥掉、用 account
  // override 合成一个扁平 probe，复用 provider 的扁平校验路径。
  if (enabled) {
    const channelLevelKeys = new Set<string>([...(provider.channelLevelOptionKeys ?? []), "accounts", "defaultAccount"]);
    const accountProbe = buildAccountValidationProbe({ ...existing, options }, accountId, channelLevelKeys);
    if (accountProbe) {
      const accountIssues = provider.validateConfig(accountProbe);
      if (accountIssues.length > 0) {
        deps.print(t().channelCli.channelAccountIncomplete(accountId, accountIssues.map((issue) => issue.message).join("；")));
        return 1;
      }
    }
  }

  const probe: ChannelRuntimeConfig = { ...existing, options };
  const validation = provider.validateConfig(probe);
  const blocking = validation.filter((issue) => issue.kind === "invalid-config");
  if (blocking.length > 0) {
    deps.print(blocking.map((issue) => issue.message).join("；"));
    return 1;
  }
  existing.options = options;
  await deps.saveChannels(config.channels);
  deps.print(t().channelCli.channelAccountEnabledToggled(type, accountId, enabled));
  return await maybeRestartAfterMutation(restartFlags.restart, deps);
}
