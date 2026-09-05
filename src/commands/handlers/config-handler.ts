import type {
  AppConfig,
  LoggingLevel,
  NonInteractivePermissions,
  PermissionMode,
  ReplyMode,
} from "../../config/types";
import type { RawConfigPath } from "../../config/config-store";
import { isLocale } from "../../i18n/resolve-locale";
import type { HelpTopicMetadata } from "../help/help-types";
import type { CommandRouterContext, RouterResponse } from "../router-types";
import { cloneAppConfig } from "../config-clone";
import { t } from "../../i18n";
import {
  assertEligibleForRuntimePermissionChange,
} from "../../bridge/engine/runtime/runtime-permission-policy";

const SUPPORTED_CONFIG_PATHS = [
  "language",
  "transport.type",
  "transport.command",
  "transport.sessionInitTimeoutMs",
  "transport.permissionMode",
  "transport.nonInteractivePermissions",
  "transport.permissionPolicy",
  "logging.level",
  "logging.maxSizeBytes",
  "logging.maxFiles",
  "logging.retentionDays",
  "channel.replyMode",
  "channels.<id>.replyMode",
  "agents.<name>.driver",
  "agents.<name>.command",
  "workspaces.<name>.cwd",
  "workspaces.<name>.description",
] as const;

function getLegacyConfigPaths(): string[] {
  const c = t().config;
  return [c.legacyWechatReplyMode, c.legacyChannelType, c.legacyChannels];
}

export function configHelp(): HelpTopicMetadata {
  const c = t().config;
  return {
    topic: "config",
    aliases: [],
    summary: c.helpSummary,
    commands: [
      { usage: c.helpCmdShow, description: c.helpCmdShowDesc },
      { usage: c.helpCmdSet, description: c.helpCmdSetDesc },
    ],
    examples: ["/config set channel.replyMode final", "/config set logging.level debug"],
  };
}

export function handleConfigShow(context: CommandRouterContext): RouterResponse {
  const c = t().config;
  const lines = [c.showSupportedHeader, ...SUPPORTED_CONFIG_PATHS.map((path) => `- ${path}`)];

  lines.push("", c.showLegacyHeader, ...getLegacyConfigPaths().map((path) => `- ${path}`));

  if (context.config) {
    lines.push("", c.showExamplesHeader, "- /config set channel.replyMode final", "- /config set logging.level debug");
  }

  return { text: lines.join("\n") };
}

export async function handleConfigSet(
  context: CommandRouterContext,
  path: string,
  rawValue: string,
): Promise<RouterResponse> {
  const c = t().config;
  if (!context.config || !context.configStore) {
    return { text: c.noWritableConfig };
  }

  const plan = planSupportedConfigUpdate(context.config, path, rawValue);
  if ("error" in plan) {
    return { text: plan.error };
  }

  const previousConfig = cloneAppConfig(context.config);
  // Narrowed for the closure below (narrowing does not cross the boundary).
  const configStore = context.configStore;
  // Whole sequence (disk write → permission transaction → live publish or
  // disk+live rollback) runs inside the shared config mutation domain, so a
  // watcher reload can never load this in-flight value and commit it after
  // the rollback below reports failure.
  return await context.configMutationMutex.run(async () => {
    // Capture the raw (file) value before patching so a rollback restores the
    // operator's exact previous state, not a parse-normalized copy of it.
    const previousRaw = await configStore.getRawValue(plan.rawPath);
    const updated = await configStore.setRawValue(plan.rawPath, plan.value);

    if (path === "transport.permissionMode" || path === "transport.nonInteractivePermissions" || path === "transport.permissionPolicy") {
      try {
        assertEligibleForRuntimePermissionChange(
          context.sessions?.hasPersistedRuntimeBindings?.() ?? false,
          {
            permissionPolicy: updated.transport.permissionPolicy,
            nonInteractivePermissions: updated.transport.nonInteractivePermissions,
          },
        );
        await context.transport.updatePermissionPolicy?.(updated.transport);
      } catch (error) {
        if (previousRaw.present) {
          await configStore.setRawValue(plan.rawPath, previousRaw.value);
        } else {
          await configStore.unsetRawValue(plan.rawPath);
        }
        context.replaceConfig(previousConfig);
        throw error;
      }
    }
    if (path === "transport.type" || path === "transport.command") {
      // Scheme A: persist the file edit but do NOT hot-apply it to the live
      // config — the live transport object cannot be rebuilt in place, and a
      // split-brain affinity selector would persist Runtime bindings the
      // running daemon cannot execute. The operator restarts to pick it up.
      return { text: c.restartRequired(path, plan.renderedValue) };
    }
    context.replaceConfig(updated);
    return { text: c.updated(path, plan.renderedValue) };
  });
}

interface PlannedConfigUpdate {
  rawPath: RawConfigPath;
  value: unknown;
  renderedValue: string;
}

function planSupportedConfigUpdate(
  config: AppConfig,
  path: string,
  rawValue: string,
): PlannedConfigUpdate | { error: string } {
  const c = t().config;
  switch (path) {
    case "language": {
      if (!isLocale(rawValue)) return { error: c.languageInvalid };
      return { rawPath: ["language"], value: rawValue, renderedValue: rawValue };
    }
    case "transport.type": {
      const parsed = parseEnum(rawValue, ["acpx-cli", "acpx-bridge"]);
      if (!parsed) return { error: c.transportTypeInvalid };
      return { rawPath: ["transport", "type"], value: parsed, renderedValue: parsed };
    }
    case "transport.command":
      if (!rawValue.trim()) return { error: c.transportCommandEmpty };
      return { rawPath: ["transport", "command"], value: rawValue, renderedValue: rawValue };
    case "transport.sessionInitTimeoutMs": {
      const parsed = parsePositiveNumber(rawValue, "transport.sessionInitTimeoutMs");
      if ("error" in parsed) return parsed;
      return { rawPath: ["transport", "sessionInitTimeoutMs"], value: parsed.value, renderedValue: String(parsed.value) };
    }
    case "transport.permissionMode": {
      const parsed = parseEnum<PermissionMode>(rawValue, ["approve-all", "approve-reads", "deny-all"]);
      if (!parsed) return { error: c.transportPermissionModeInvalid };
      return { rawPath: ["transport", "permissionMode"], value: parsed, renderedValue: parsed };
    }
    case "transport.nonInteractivePermissions": {
      const parsed = parseEnum<NonInteractivePermissions>(rawValue, ["deny", "fail"]);
      if (!parsed) return { error: c.transportNonInteractiveInvalid };
      return { rawPath: ["transport", "nonInteractivePermissions"], value: parsed, renderedValue: parsed };
    }
    case "transport.permissionPolicy":
      if (!rawValue.trim()) return { error: c.transportPermissionPolicyEmpty };
      return { rawPath: ["transport", "permissionPolicy"], value: rawValue, renderedValue: rawValue };
    case "logging.level": {
      const parsed = parseEnum<LoggingLevel>(rawValue, ["error", "info", "debug"]);
      if (!parsed) return { error: c.loggingLevelInvalid };
      return { rawPath: ["logging", "level"], value: parsed, renderedValue: parsed };
    }
    case "logging.maxSizeBytes":
    case "logging.maxFiles":
    case "logging.retentionDays": {
      const field = path.slice("logging.".length);
      const parsed = parsePositiveNumber(rawValue, path);
      if ("error" in parsed) return parsed;
      return { rawPath: ["logging", field], value: parsed.value, renderedValue: String(parsed.value) };
    }
    case "channel.type":
      return { error: c.channelTypeDisabled };
    case "channel.replyMode": {
      const parsed = parseEnum<ReplyMode>(rawValue, ["stream", "final", "verbose"]);
      if (!parsed) return { error: c.channelReplyModeInvalid };
      return { rawPath: ["channel", "replyMode"], value: parsed, renderedValue: parsed };
    }
    case "wechat.replyMode": {
      const parsed = parseEnum<ReplyMode>(rawValue, ["stream", "final", "verbose"]);
      if (!parsed) return { error: c.wechatReplyModeInvalid };
      return {
        rawPath: ["channel", "replyMode"],
        value: parsed,
        renderedValue: c.wechatReplyModeMapped(parsed),
      };
    }
  }

  const agentMatch = path.match(/^agents\.([^.]+)\.(driver|command)$/);
  if (agentMatch) {
    const [, name, field] = agentMatch;
    if (!name || !field || isPrototypePollutingKey(name)) {
      return { error: c.pathNotSupported(path) };
    }
    // hasOwn (not truthy access): `config.agents["__proto__"]` resolves to
    // Object.prototype and would pass a `!config.agents[name]` guard.
    if (!Object.hasOwn(config.agents, name)) {
      return { error: c.agentNotFound(name) };
    }
    if (!rawValue.trim()) {
      return { error: c.fieldEmpty(path) };
    }
    return { rawPath: ["agents", name, field], value: rawValue, renderedValue: rawValue };
  }

  const workspaceMatch = path.match(/^workspaces\.([^.]+)\.(cwd|description)$/);
  if (workspaceMatch) {
    const [, name, field] = workspaceMatch;
    if (!name || !field || isPrototypePollutingKey(name)) {
      return { error: c.pathNotSupported(path) };
    }
    if (!Object.hasOwn(config.workspaces, name)) {
      return { error: c.workspaceNotFound(name) };
    }
    if (!rawValue.trim()) {
      return { error: c.fieldEmpty(path) };
    }
    // Stored verbatim: a `~` cwd stays literal in the file and is expanded at load.
    return { rawPath: ["workspaces", name, field], value: rawValue, renderedValue: rawValue };
  }

  const channelMatch = path.match(/^channels\.([^.]+)\.replyMode$/);
  if (channelMatch) {
    const [, id] = channelMatch;
    if (!id) {
      return { error: c.pathNotSupported(path) };
    }
    const channel = config.channels.find((entry) => entry.id === id);
    if (!channel) {
      return { error: c.channelRuntimeNotFound(id) };
    }
    const parsed = parseEnum<ReplyMode>(rawValue, ["stream", "final", "verbose"]);
    if (!parsed) {
      return { error: c.channelRuntimeReplyModeInvalid(id) };
    }
    return {
      rawPath: [
        "channels",
        // The runtime channel may be synthesized from `channel` (no channels[]
        // in the file yet); materialize a minimal entry — never ownerIds.
        { id, createWith: { id: channel.id, type: channel.type, enabled: channel.enabled } },
        "replyMode",
      ],
      value: parsed,
      renderedValue: parsed,
    };
  }

  return { error: c.pathNotSupported(path) };
}

function isPrototypePollutingKey(key: string): boolean {
  return key === "__proto__" || key === "constructor" || key === "prototype";
}

function parseEnum<T extends string>(value: string, allowed: readonly T[]): T | null {
  return allowed.includes(value as T) ? (value as T) : null;
}

function parsePositiveNumber(
  rawValue: string,
  path: string,
): { value: number } | { error: string } {
  const value = Number(rawValue);
  if (!Number.isFinite(value) || value <= 0) {
    return { error: t().config.mustBePositiveNumber(path) };
  }
  return { value };
}
