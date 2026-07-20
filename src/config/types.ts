import type { Locale } from "../i18n/resolve-locale";
import type { AdapterVersionOverrides } from "../adapters/adapter-catalog";
import type { ClaudeSettingsPolicy } from "../adapters/claude-settings-policy";

export type PermissionMode = "approve-all" | "approve-reads" | "deny-all";
export type NonInteractivePermissions = "deny" | "fail";
export type ReplyMode = "stream" | "final" | "verbose";
/** @deprecated Use ReplyMode. */
export type WechatReplyMode = ReplyMode;

export interface ChannelConfig {
  type: string;
  replyMode: ReplyMode;
  /**
   * Sender ids the operator trusts as channel owners. Group turns from these
   * senders pass owner-gated command authorization even when the channel
   * protocol carries no group-role information (e.g. WeChat).
   */
  ownerIds?: string[];
  options?: Record<string, unknown>;
}

/** @deprecated Legacy input shape only. Use ChannelConfig. */
export interface WechatConfig {
  replyMode: ReplyMode;
}

export interface TransportConfig {
  type: "acpx-cli" | "acpx-bridge";
  command?: string;
  sessionInitTimeoutMs?: number;
  permissionMode: PermissionMode;
  nonInteractivePermissions: NonInteractivePermissions;
  permissionPolicy?: string;
  /**
   * Idle TTL (seconds) passed to acpx as `--ttl` on prompt commands. Governs how
   * long the acpx queue owner (and the warm ACP agent it holds) survives between
   * prompts, so follow-up messages in a conversation skip the agent cold start.
   * `0` keeps the owner alive forever. Defaults to 1800 (30 min).
   */
  queueOwnerTtlSeconds?: number;
  /**
   * Prefer a locally-installed native agent CLI over acpx's `npx -y <pkg>` fallback
   * when one is on PATH (currently the unpinned-npx drivers: opencode, kilocode). This
   * avoids a per-cold-start npm-registry fetch — faster and immune to network blips
   * (e.g. ECONNRESET during agent init). Defaults to `true`; set `false` to always use
   * acpx's default resolution. A per-agent `command` override still takes precedence.
   */
  preferLocalAgents?: boolean;
  /** Exact local overrides for xacpx-managed ACP adapter versions. Omitted entries
   * use the tested defaults compiled into this xacpx release. */
  adapterVersions?: AdapterVersionOverrides;
  /** Registry used only for xacpx-managed ACP adapters. Defaults to the public
   * npm registry instead of inheriting the machine's npm registry. */
  adapterRegistry?: string;
  /**
   * Inactivity watchdog: abort a turn that produces NO agent activity (no streamed
   * output/tool/thought/usage event) for this many seconds, reclaiming its in-flight
   * slot. Reset on every agent event, so long but actively-working turns are unaffected.
   * `0` disables the watchdog. Defaults to 600 (10 min).
   */
  turnIdleTimeoutSeconds?: number;
}

export interface TerminalConfig {
  /** Default false. When false, control.terminal.create is rejected before any PTY spawns. */
  enabled: boolean;
  /** Idle seconds before a terminal PTY is auto-killed. Defaults to 900 (15 min). */
  idleTimeoutSeconds?: number;
  /** Explicit shell override (absolute path or bare name). Cross-platform: wins over SHELL / platform default. */
  shell?: string;
}

export interface FilesConfig {
  /** Default false. When false, all fs write ops (new/rename/delete/copy) are rejected
   *  before touching disk. Download is a read and stays available regardless. */
  writeEnabled: boolean;
}

export type LoggingLevel = "error" | "info" | "debug";

export interface PerfLogConfig {
  enabled: boolean;
  maxSizeBytes: number;
  maxFiles: number;
  retentionDays: number;
}

export interface LoggingConfig {
  level: LoggingLevel;
  maxSizeBytes: number;
  maxFiles: number;
  retentionDays: number;
  perf: PerfLogConfig;
}

export interface AgentConfig {
  driver: string;
  command?: string;
  /** Default LLM model id for sessions of this agent (e.g. `gpt-5.2[high]`); a session-level model overrides it. */
  model?: string;
  /** Claude user-settings exposure. Defaults to filtered third-party provider/model settings. */
  settingsPolicy?: ClaudeSettingsPolicy;
}

export interface WorkspaceConfig {
  cwd: string;
  description?: string;
}

export interface OrchestrationConfig {
  maxPendingAgentRequestsPerCoordinator: number;
  allowWorkerChainedRequests: boolean;
  allowedAgentRequestTargets: string[];
  allowedAgentRequestRoles: string[];
  progressHeartbeatSeconds: number;
  maxParallelTasksPerAgent: number;
}

export type LaterDefaultMode = "temp" | "bind";

export interface LaterConfig {
  defaultMode: LaterDefaultMode;
}

export interface ChannelRuntimeConfig {
  id: string;
  type: string;
  enabled: boolean;
  replyMode?: ReplyMode;
  /** See ChannelConfig.ownerIds — per-channel trusted owner sender ids. */
  ownerIds?: string[];
  options?: Record<string, unknown>;
}

export interface PluginConfig {
  name: string;
  version?: string;
  enabled: boolean;
}

export interface AppConfig {
  transport: TransportConfig;
  logging: LoggingConfig;
  channel: ChannelConfig;
  channels: ChannelRuntimeConfig[];
  plugins: PluginConfig[];
  agents: Record<string, AgentConfig>;
  workspaces: Record<string, WorkspaceConfig>;
  orchestration: OrchestrationConfig;
  later?: LaterConfig;
  language?: Locale;
  terminal?: TerminalConfig;
  files?: FilesConfig;
}

export function terminalEnabled(config: AppConfig): boolean {
  return config.terminal?.enabled === true;
}

export function terminalIdleTimeoutSeconds(config: AppConfig): number {
  const v = config.terminal?.idleTimeoutSeconds;
  return typeof v === "number" && v > 0 ? v : 900;
}

export function turnIdleTimeoutSeconds(config: AppConfig): number {
  const v = config.transport?.turnIdleTimeoutSeconds;
  // NB: unlike terminalIdleTimeoutSeconds, 0 is a valid "disabled" value (>= 0), not a
  // fall-through to the default — only a negative/absent value uses the 600 default.
  return typeof v === "number" && v >= 0 ? v : 600;
}

export function terminalShell(config: AppConfig): string | undefined {
  const v = config.terminal?.shell;
  return typeof v === "string" && v.trim() ? v : undefined;
}

export function filesWriteEnabled(config: AppConfig): boolean {
  return config.files?.writeEnabled === true;
}
