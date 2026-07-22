import { readFile } from "node:fs/promises";
import {
  isExactAdapterVersion,
  isManagedAdapterId,
  type AdapterVersionOverrides,
} from "../adapters/adapter-catalog";
import { normalizeAdapterRegistry } from "../adapters/adapter-registry";
import { isClaudeSettingsPolicy } from "../adapters/claude-settings-policy";

import { normalizeWorkspacePath } from "../commands/workspace-path";
import { isLegacyPluginPackageName, normalizePluginPackageName } from "../plugins/plugin-renames";
import { resolveAgentCommand } from "./resolve-agent-command";
import { isLocale, type Locale } from "../i18n/resolve-locale";
import type {
  AgentConfig,
  AppConfig,
  ChannelConfig,
  ChannelRuntimeConfig,
  LaterConfig,
  LoggingConfig,
  LoggingLevel,
  NonInteractivePermissions,
  OrchestrationConfig,
  PerfLogConfig,
  PermissionMode,
  PluginConfig,
  ReplyMode,
  WorkspaceConfig,
} from "./types";

const DEFAULT_PERF_LOG_CONFIG: PerfLogConfig = {
  enabled: false,
  maxSizeBytes: 5 * 1024 * 1024,
  maxFiles: 3,
  retentionDays: 7,
};

const DEFAULT_LOGGING_CONFIG: LoggingConfig = {
  level: "info",
  maxSizeBytes: 2 * 1024 * 1024,
  maxFiles: 5,
  retentionDays: 7,
  perf: DEFAULT_PERF_LOG_CONFIG,
};
const DEFAULT_PERMISSION_MODE: PermissionMode = "approve-all";
const DEFAULT_NON_INTERACTIVE_PERMISSIONS: NonInteractivePermissions = "deny";
// Warm window for the acpx queue owner / ACP agent. acpx's own default is 300s,
// but WeChat conversations routinely pause longer than that; a 30 min window keeps
// the agent warm across natural gaps so follow-up prompts skip the cold start.
const DEFAULT_QUEUE_OWNER_TTL_SECONDS = 1800;
const DEFAULT_CHANNEL_CONFIG: ChannelConfig = {
  type: "weixin",
  replyMode: "verbose",
};
const DEFAULT_ORCHESTRATION_CONFIG: OrchestrationConfig = {
  maxPendingAgentRequestsPerCoordinator: 3,
  allowWorkerChainedRequests: false,
  allowedAgentRequestTargets: [],
  allowedAgentRequestRoles: [],
  progressHeartbeatSeconds: 300,
  maxParallelTasksPerAgent: 3,
};
const DEFAULT_LATER_CONFIG: LaterConfig = {
  defaultMode: "temp",
};

type ParsedAgentRecord = Record<string, AgentConfig & { command?: string }>;
type ParsedWorkspaceRecord = Record<string, WorkspaceConfig & { allowed_agents?: string[] }>;

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isReplyMode(value: unknown): value is ReplyMode {
  return value === "stream" || value === "final" || value === "verbose";
}

export function parsePositiveOptionalNumber(value: unknown, path: string, defaultValue: number): number {
  if (value === undefined) return defaultValue;
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    throw new Error(`${path} must be a positive number`);
  }
  return value;
}

function parseOwnerIds(value: unknown, path: string): string[] | undefined {
  if (value === undefined) return undefined;
  if (
    !Array.isArray(value) ||
    value.some((entry) => typeof entry !== "string" || entry.trim().length === 0)
  ) {
    throw new Error(`${path} must be an array of non-empty strings`);
  }
  return value.map((entry) => entry.trim());
}

function parseChannelConfig(channel: unknown, legacyWechat: unknown): ChannelConfig {
  if (channel !== undefined) {
    if (!isRecord(channel)) {
      throw new Error("channel must be an object");
    }
    if ("type" in channel && typeof channel.type !== "string") {
      throw new Error("channel.type must be a string");
    }
    if ("replyMode" in channel && !isReplyMode(channel.replyMode)) {
      throw new Error("channel.replyMode must be stream, final, or verbose");
    }
    const type = typeof channel.type === "string" ? channel.type : "weixin";
    const ownerIds = parseOwnerIds(channel.ownerIds, "channel.ownerIds");
    let options: Record<string, unknown> | undefined = undefined;
    if ("feishu" in channel && isRecord(channel.feishu)) {
      options = channel.feishu;
    } else if ("options" in channel && isRecord(channel.options)) {
      options = channel.options;
    }
    return {
      type,
      replyMode: isReplyMode(channel.replyMode) ? channel.replyMode : DEFAULT_CHANNEL_CONFIG.replyMode,
      ...(ownerIds ? { ownerIds } : {}),
      ...(options ? { options } : {}),
    };
  }

  if (legacyWechat !== undefined) {
    if (!isRecord(legacyWechat)) {
      throw new Error("wechat must be an object");
    }
    if ("replyMode" in legacyWechat && !isReplyMode(legacyWechat.replyMode)) {
      throw new Error("wechat.replyMode must be stream, final, or verbose");
    }
    return {
      type: "weixin",
      replyMode: isReplyMode(legacyWechat.replyMode) ? legacyWechat.replyMode : DEFAULT_CHANNEL_CONFIG.replyMode,
    };
  }

  return { ...DEFAULT_CHANNEL_CONFIG };
}

export async function loadConfig(path: string): Promise<AppConfig>;
export async function loadConfig(path: string, options: { defaultLoggingLevel?: LoggingLevel }): Promise<AppConfig>;
export async function loadConfig(
  path: string,
  options: { defaultLoggingLevel?: LoggingLevel } = {},
): Promise<AppConfig> {
  const raw = JSON.parse(await readFile(path, "utf8")) as unknown;
  return parseConfig(raw, options);
}

export function parseConfig(
  raw: unknown,
  options: { defaultLoggingLevel?: LoggingLevel } = {},
): AppConfig {
  if (!isRecord(raw)) {
    throw new Error("config must be a JSON object");
  }

  const transport = raw.transport;
  if (!isRecord(transport)) {
    throw new Error("transport must be an object");
  }
  if (
    "type" in transport &&
    transport.type !== "acpx-cli" &&
    transport.type !== "acpx-bridge"
  ) {
    throw new Error("transport.type must be acpx-cli or acpx-bridge");
  }
  if (
    "sessionInitTimeoutMs" in transport &&
    (typeof transport.sessionInitTimeoutMs !== "number" ||
      !Number.isFinite(transport.sessionInitTimeoutMs) ||
      transport.sessionInitTimeoutMs <= 0)
  ) {
    throw new Error("transport.sessionInitTimeoutMs must be a positive number");
  }
  const adapterVersions = parseAdapterVersions(transport.adapterVersions);
  const adapterRegistry = parseAdapterRegistry(transport.adapterRegistry);
  if (
    "permissionMode" in transport &&
    transport.permissionMode !== "approve-all" &&
    transport.permissionMode !== "approve-reads" &&
    transport.permissionMode !== "deny-all"
  ) {
    throw new Error("transport.permissionMode must be approve-all, approve-reads, or deny-all");
  }
  if (
    "nonInteractivePermissions" in transport &&
    transport.nonInteractivePermissions !== "deny" &&
    transport.nonInteractivePermissions !== "fail"
  ) {
    throw new Error("transport.nonInteractivePermissions must be deny or fail");
  }
  if ("permissionPolicy" in transport && transport.permissionPolicy !== undefined) {
    if (typeof transport.permissionPolicy !== "string" || transport.permissionPolicy.trim().length === 0) {
      throw new Error("transport.permissionPolicy must be a non-empty string");
    }
  }
  if (
    "queueOwnerTtlSeconds" in transport &&
    (typeof transport.queueOwnerTtlSeconds !== "number" ||
      !Number.isFinite(transport.queueOwnerTtlSeconds) ||
      transport.queueOwnerTtlSeconds < 0)
  ) {
    throw new Error("transport.queueOwnerTtlSeconds must be a non-negative number (0 = keep alive forever)");
  }
  if (
    "turnIdleTimeoutSeconds" in transport &&
    (typeof transport.turnIdleTimeoutSeconds !== "number" ||
      !Number.isFinite(transport.turnIdleTimeoutSeconds) ||
      transport.turnIdleTimeoutSeconds < 0)
  ) {
    throw new Error("transport.turnIdleTimeoutSeconds must be a non-negative number (0 disables the turn watchdog)");
  }
  if ("preferLocalAgents" in transport && typeof transport.preferLocalAgents !== "boolean") {
    throw new Error("transport.preferLocalAgents must be a boolean");
  }

  if (!isRecord(raw.agents)) {
    throw new Error("agents must be an object");
  }

  if (!isRecord(raw.workspaces)) {
    throw new Error("workspaces must be an object");
  }

  const logging = raw.logging;
  const channel = raw.channel;
  const legacyWechat = raw.wechat;
  const orchestration = raw.orchestration;
  const files = raw.files;
  if (logging !== undefined && !isRecord(logging)) {
    throw new Error("logging must be an object");
  }
  if (orchestration !== undefined && !isRecord(orchestration)) {
    throw new Error("orchestration must be an object");
  }
  if (files !== undefined && !isRecord(files)) {
    throw new Error("files must be an object");
  }
  if (isRecord(files) && "writeEnabled" in files && typeof files.writeEnabled !== "boolean") {
    throw new Error("files.writeEnabled must be boolean");
  }
  if (
    isRecord(logging) &&
    "level" in logging &&
    logging.level !== "error" &&
    logging.level !== "info" &&
    logging.level !== "debug"
  ) {
    throw new Error("logging.level must be error, info, or debug");
  }
  for (const field of ["maxSizeBytes", "maxFiles", "retentionDays"] as const) {
    if (
      isRecord(logging) &&
      field in logging &&
      (typeof logging[field] !== "number" || !Number.isFinite(logging[field]) || logging[field] <= 0)
    ) {
      throw new Error(`logging.${field} must be a positive number`);
    }
  }

  if (isRecord(logging) && "perf" in logging) {
    if (!isRecord(logging.perf)) {
      throw new Error("logging.perf must be an object");
    }
    if ("enabled" in logging.perf && typeof logging.perf.enabled !== "boolean") {
      throw new Error("logging.perf.enabled must be boolean");
    }
    for (const field of ["maxSizeBytes", "maxFiles", "retentionDays"] as const) {
      if (field in logging.perf) {
        const value = logging.perf[field] as unknown;
        if (typeof value !== "number" || !Number.isFinite(value)) {
          throw new Error(`logging.perf.${field} must be a finite number`);
        }
        if (field === "maxFiles" && value < 0) {
          throw new Error(`logging.perf.${field} must be non-negative`);
        }
        if (field !== "maxFiles" && value <= 0) {
          throw new Error(`logging.perf.${field} must be a positive number`);
        }
      }
    }
  }

  for (const [name, agent] of Object.entries(raw.agents)) {
    if (!isRecord(agent) || typeof agent.driver !== "string" || agent.driver.length === 0) {
      throw new Error(`agent "${name}" must define a non-empty driver`);
    }
    if ("command" in agent && (typeof agent.command !== "string" || agent.command.length === 0)) {
      throw new Error(`agent "${name}" command must be a non-empty string`);
    }
  }

  for (const [name, workspace] of Object.entries(raw.workspaces)) {
    if (!isRecord(workspace) || typeof workspace.cwd !== "string" || workspace.cwd.length === 0) {
      throw new Error(`workspace "${name}" must define a non-empty cwd`);
    }
    if (
      "allowed_agents" in workspace &&
      (!Array.isArray(workspace.allowed_agents) || workspace.allowed_agents.some((value) => typeof value !== "string"))
    ) {
      throw new Error(`workspace "${name}" allowed_agents must be an array of strings`);
    }
  }

  const rawAgents = raw.agents as ParsedAgentRecord;
  const agents: Record<string, AgentConfig> = {};
  for (const [name, agent] of Object.entries(rawAgents)) {
    const driver = agent.driver;
    if ("settingsPolicy" in agent && !isClaudeSettingsPolicy(agent.settingsPolicy)) {
      throw new Error(`agent "${name}" settingsPolicy must be provider-only, isolated, or full-user`);
    }
    const command = typeof agent.command === "string" ? resolveAgentCommand(driver, agent.command) : undefined;
    const model = typeof agent.model === "string" && agent.model.trim().length > 0 ? agent.model.trim() : undefined;
    agents[name] = {
      driver,
      ...(command ? { command } : {}),
      ...(model ? { model } : {}),
      ...(isClaudeSettingsPolicy(agent.settingsPolicy) ? { settingsPolicy: agent.settingsPolicy } : {}),
    };
  }

  const rawWorkspaces = raw.workspaces as ParsedWorkspaceRecord;
  const workspaces: Record<string, WorkspaceConfig> = {};
  for (const [name, workspace] of Object.entries(rawWorkspaces)) {
    workspaces[name] = {
      cwd: normalizeWorkspacePath(workspace.cwd),
      ...(typeof workspace.description === "string" ? { description: workspace.description } : {}),
    };
  }

  const transportType = transport.type === "acpx-cli" || transport.type === "acpx-bridge"
    ? transport.type
    : "acpx-bridge";
  const permissionMode: PermissionMode =
    transport.permissionMode === "approve-all" ||
    transport.permissionMode === "approve-reads" ||
    transport.permissionMode === "deny-all"
      ? transport.permissionMode
      : DEFAULT_PERMISSION_MODE;
  const nonInteractivePermissions: NonInteractivePermissions =
    transport.nonInteractivePermissions === "deny" ||
    transport.nonInteractivePermissions === "fail"
      ? transport.nonInteractivePermissions
      : DEFAULT_NON_INTERACTIVE_PERMISSIONS;
  const loggingLevel = logging?.level;
  const resolvedLoggingLevel: LoggingLevel =
    loggingLevel === "error" || loggingLevel === "info" || loggingLevel === "debug"
      ? loggingLevel
      : (options.defaultLoggingLevel ?? DEFAULT_LOGGING_CONFIG.level);
  const channelConfig = parseChannelConfig(channel, legacyWechat);
  const channelsConfig = parseRuntimeChannels(raw.channels, channelConfig);
  const orchestrationConfig = parseOrchestrationConfig(orchestration);
  const laterConfig = parseLaterConfig(raw.later);
  const plugins = parsePlugins(raw.plugins);
  const language = isLocale(raw.language) ? raw.language : undefined;

  return {
    transport: {
      ...(typeof transport.command === "string" ? { command: transport.command } : {}),
      ...(typeof transport.sessionInitTimeoutMs === "number"
        ? { sessionInitTimeoutMs: transport.sessionInitTimeoutMs }
        : {}),
      ...(typeof transport.permissionPolicy === "string" ? { permissionPolicy: transport.permissionPolicy } : {}),
      ...(typeof transport.preferLocalAgents === "boolean" ? { preferLocalAgents: transport.preferLocalAgents } : {}),
      ...(adapterVersions ? { adapterVersions } : {}),
      ...(adapterRegistry ? { adapterRegistry } : {}),
      ...(typeof transport.turnIdleTimeoutSeconds === "number"
        ? { turnIdleTimeoutSeconds: transport.turnIdleTimeoutSeconds }
        : {}),
      type: transportType,
      permissionMode,
      nonInteractivePermissions,
      queueOwnerTtlSeconds:
        typeof transport.queueOwnerTtlSeconds === "number"
          ? transport.queueOwnerTtlSeconds
          : DEFAULT_QUEUE_OWNER_TTL_SECONDS,
    },
    logging: {
      level: resolvedLoggingLevel,
      maxSizeBytes:
        typeof logging?.maxSizeBytes === "number" ? logging.maxSizeBytes : DEFAULT_LOGGING_CONFIG.maxSizeBytes,
      maxFiles: typeof logging?.maxFiles === "number" ? logging.maxFiles : DEFAULT_LOGGING_CONFIG.maxFiles,
      retentionDays:
        typeof logging?.retentionDays === "number" ? logging.retentionDays : DEFAULT_LOGGING_CONFIG.retentionDays,
      perf: (() => {
        const perfRaw = isRecord(logging?.perf) ? (logging!.perf as Record<string, unknown>) : undefined;
        return {
          enabled: typeof perfRaw?.enabled === "boolean" ? perfRaw.enabled : DEFAULT_PERF_LOG_CONFIG.enabled,
          maxSizeBytes:
            typeof perfRaw?.maxSizeBytes === "number" && Number.isFinite(perfRaw.maxSizeBytes) && perfRaw.maxSizeBytes > 0
              ? perfRaw.maxSizeBytes
              : DEFAULT_PERF_LOG_CONFIG.maxSizeBytes,
          maxFiles:
            typeof perfRaw?.maxFiles === "number" && Number.isFinite(perfRaw.maxFiles) && perfRaw.maxFiles >= 0
              ? perfRaw.maxFiles
              : DEFAULT_PERF_LOG_CONFIG.maxFiles,
          retentionDays:
            typeof perfRaw?.retentionDays === "number" && Number.isFinite(perfRaw.retentionDays) && perfRaw.retentionDays > 0
              ? perfRaw.retentionDays
              : DEFAULT_PERF_LOG_CONFIG.retentionDays,
        };
      })(),
    },
    channel: channelConfig,
    channels: channelsConfig,
    plugins,
    agents,
    workspaces,
    orchestration: orchestrationConfig,
    later: laterConfig,
    ...(language ? { language } : {}),
    ...(raw.terminal && typeof raw.terminal === "object"
      ? {
          terminal: {
            enabled: (raw.terminal as { enabled?: unknown }).enabled === true,
            ...(typeof (raw.terminal as { idleTimeoutSeconds?: unknown }).idleTimeoutSeconds === "number"
              ? { idleTimeoutSeconds: (raw.terminal as { idleTimeoutSeconds: number }).idleTimeoutSeconds }
              : {}),
          },
        }
      : {}),
    ...(isRecord(files)
      ? { files: { writeEnabled: files.writeEnabled === true } }
      : {}),
  };
}

function parseAdapterVersions(raw: unknown): AdapterVersionOverrides | undefined {
  if (raw === undefined) return undefined;
  if (!isRecord(raw)) throw new Error("transport.adapterVersions must be an object");
  const result: AdapterVersionOverrides = {};
  for (const [id, value] of Object.entries(raw)) {
    if (!isManagedAdapterId(id)) {
      throw new Error(`transport.adapterVersions contains unsupported adapter ${id}`);
    }
    if (typeof value !== "string" || !isExactAdapterVersion(value)) {
      throw new Error(`transport.adapterVersions.${id} must be an exact semver version`);
    }
    result[id] = value;
  }
  return Object.keys(result).length > 0 ? result : undefined;
}

function parseAdapterRegistry(raw: unknown): string | undefined {
  if (raw === undefined) return undefined;
  if (typeof raw !== "string") throw new Error("transport.adapterRegistry must be an http(s) URL");
  try {
    return normalizeAdapterRegistry(raw);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`transport.adapterRegistry is invalid: ${detail}`);
  }
}

function parsePluginConfig(raw: unknown, index: number): PluginConfig {
  if (!isRecord(raw)) {
    throw new Error(`plugins[${index}] must be an object`);
  }
  const rawName = typeof raw.name === "string" ? raw.name.trim() : "";
  const name = normalizePluginPackageName(rawName);
  if (!name) {
    throw new Error(`plugins[${index}].name must be a non-empty string`);
  }
  if ("version" in raw && typeof raw.version !== "string") {
    throw new Error(`plugins[${index}].version must be a string`);
  }
  if ("enabled" in raw && typeof raw.enabled !== "boolean") {
    throw new Error(`plugins[${index}].enabled must be a boolean`);
  }
  return {
    name,
    ...(typeof raw.version === "string" ? { version: raw.version } : {}),
    enabled: raw.enabled !== false,
  };
}

function parsePlugins(rawPlugins: unknown): PluginConfig[] {
  if (rawPlugins === undefined) return [];
  if (!Array.isArray(rawPlugins)) {
    throw new Error("plugins must be an array");
  }
  const parsed = rawPlugins.map((entry, index) => ({
    plugin: parsePluginConfig(entry, index),
    originalName: isRecord(entry) && typeof entry.name === "string" ? entry.name.trim() : "",
  }));
  const pluginsByName = new Map<string, { plugin: PluginConfig; originalName: string }>();
  for (const entry of parsed) {
    const existing = pluginsByName.get(entry.plugin.name);
    if (!existing) {
      pluginsByName.set(entry.plugin.name, entry);
      continue;
    }
    const hasLegacyName = isLegacyPluginPackageName(existing.originalName) || isLegacyPluginPackageName(entry.originalName);
    if (!hasLegacyName) {
      throw new Error("plugins names must be unique");
    }
    if (isLegacyPluginPackageName(existing.originalName) && !isLegacyPluginPackageName(entry.originalName)) {
      pluginsByName.set(entry.plugin.name, entry);
    }
  }
  return Array.from(pluginsByName.values()).map((entry) => entry.plugin);
}

function parseRuntimeChannelConfig(raw: unknown, index: number): ChannelRuntimeConfig {
  if (!isRecord(raw)) {
    throw new Error(`channels[${index}] must be an object`);
  }
  const id = typeof raw.id === "string" ? raw.id.trim() : "";
  if (!id) {
    throw new Error(`channels[${index}].id must be a non-empty string`);
  }
  if (typeof raw.type !== "string" || !raw.type.trim()) {
    throw new Error(`channels[${index}].type must be a non-empty string`);
  }
  const enabled = raw.enabled !== false;
  if ("replyMode" in raw && !isReplyMode(raw.replyMode)) {
    throw new Error(`channels[${index}].replyMode must be stream, final, or verbose`);
  }
  const ownerIds = parseOwnerIds(raw.ownerIds, `channels[${index}].ownerIds`);
  let options: Record<string, unknown> | undefined = undefined;
  if ("feishu" in raw && isRecord(raw.feishu)) {
    options = raw.feishu;
  } else if ("options" in raw && isRecord(raw.options)) {
    options = raw.options;
  }
  return {
    id,
    type: raw.type,
    enabled,
    ...(isReplyMode(raw.replyMode) ? { replyMode: raw.replyMode } : {}),
    ...(ownerIds ? { ownerIds } : {}),
    ...(options ? { options } : {}),
  };
}

function parseRuntimeChannels(rawChannels: unknown, channel: ChannelConfig): ChannelRuntimeConfig[] {
  if (rawChannels !== undefined) {
    if (!Array.isArray(rawChannels)) {
      throw new Error("channels must be an array");
    }
    const parsed = rawChannels.map((entry, index) => parseRuntimeChannelConfig(entry, index));
    const ids = new Set<string>();
    for (const entry of parsed) {
      if (ids.has(entry.id)) {
        throw new Error("channels ids must be unique");
      }
      ids.add(entry.id);
    }
    return parsed;
  }

  const legacyType = channel.type ?? "weixin";
  // Deliberately NOT copying channel.ownerIds here: the policy resolver
  // (resolveChannelOwnerIds) unions channel.ownerIds and channels[].ownerIds
  // at evaluation time, and channel mutations (ConfigStore.replaceChannels)
  // persist parsed runtime entries — a baked copy would survive those writes
  // and make a later revocation edit of channel.ownerIds silently ineffective.
  return [
    {
      id: legacyType,
      type: legacyType,
      enabled: true,
      ...(channel.options ? { options: channel.options } : {}),
    },
  ];
}

function parseLaterConfig(raw: unknown): LaterConfig {
  if (!isRecord(raw)) return { ...DEFAULT_LATER_CONFIG };
  return raw.defaultMode === "bind" ? { defaultMode: "bind" } : { ...DEFAULT_LATER_CONFIG };
}

function parseOrchestrationConfig(raw: unknown): OrchestrationConfig {
  if (!isRecord(raw)) {
    return {
      ...DEFAULT_ORCHESTRATION_CONFIG,
    };
  }

  return {
    maxPendingAgentRequestsPerCoordinator:
      typeof raw.maxPendingAgentRequestsPerCoordinator === "number" &&
      Number.isFinite(raw.maxPendingAgentRequestsPerCoordinator) &&
      raw.maxPendingAgentRequestsPerCoordinator > 0
        ? raw.maxPendingAgentRequestsPerCoordinator
        : DEFAULT_ORCHESTRATION_CONFIG.maxPendingAgentRequestsPerCoordinator,
    allowWorkerChainedRequests: raw.allowWorkerChainedRequests === true,
    allowedAgentRequestTargets: Array.isArray(raw.allowedAgentRequestTargets)
      ? raw.allowedAgentRequestTargets.filter((value): value is string => typeof value === "string")
      : [...DEFAULT_ORCHESTRATION_CONFIG.allowedAgentRequestTargets],
    allowedAgentRequestRoles: Array.isArray(raw.allowedAgentRequestRoles)
      ? raw.allowedAgentRequestRoles.filter((value): value is string => typeof value === "string")
      : [...DEFAULT_ORCHESTRATION_CONFIG.allowedAgentRequestRoles],
    progressHeartbeatSeconds:
      typeof raw.progressHeartbeatSeconds === "number" &&
      Number.isFinite(raw.progressHeartbeatSeconds)
        ? raw.progressHeartbeatSeconds
        : DEFAULT_ORCHESTRATION_CONFIG.progressHeartbeatSeconds,
    maxParallelTasksPerAgent:
      typeof raw.maxParallelTasksPerAgent === "number" &&
      Number.isFinite(raw.maxParallelTasksPerAgent) &&
      // Threshold is >= 1 (not > 0 like maxPendingAgentRequestsPerCoordinator):
      // this is a cap on concurrent task dispatch, and a cap of 0 would disable
      // parallel dispatch entirely, so sub-1 values fall back to the default.
      raw.maxParallelTasksPerAgent >= 1
        ? Math.floor(raw.maxParallelTasksPerAgent)
        : DEFAULT_ORCHESTRATION_CONFIG.maxParallelTasksPerAgent,
  };
}
