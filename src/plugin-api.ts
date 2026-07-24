export type { ChannelPluginDefinition } from "./channels/plugin.js";
export type { ChannelFactory, CreateChannelDeps } from "./channels/create-channel.js";
export type {
  ChannelStartInput,
  ConsumerLock,
  ConsumerLockMetadata,
  ConsumerLockOptions,
  CoordinatorMessageInput,
  MessageChannelRuntime,
  ScheduledChannelMessageInput,
  OrchestrationDeliveryCallbacks,
  OutboundQuota,
  PlanEntry,
  PlanEntryStatus,
  ToolUseEvent,
  ToolUseKind,
  ToolUseStatus,
} from "./channels/types.js";
// Text-channel subagent degradation: a shared formatter + per-turn dedup
// tracker so WeChat/Yuanbao surface delegations as one honest line each,
// consuming the same normalized `isSubagent` contract the web card uses.
export { formatSubagentNotice, SubagentNoticeTracker } from "./channels/subagent-notice.js";
// Streaming side-channel payloads (context usage + advertised commands) so
// channel plugins can render token/context footers and command hints. These
// originate in the transport layer; surfaced here as the public plugin contract.
export type {
  AgentCommand,
  PromptUsage,
  UsageBreakdown,
  UsageCost,
} from "./transport/types.js";
export type {
  ChannelCliInput,
  ChannelCliIo,
  ChannelCliParseResult,
  ChannelCliProvider,
  ChannelCliValidationIssue,
} from "./channels/cli/provider.js";
export type { ChannelRuntimeConfig } from "./config/types.js";
export type { CommandHint } from "./commands/command-hints.js";
export type { AppLogger } from "./logging/app-logger.js";
export type { WeacpxPlugin, XacpxPlugin } from "./plugins/types.js";
export {
  XACPX_PLUGIN_API_VERSION,
  XACPX_PLUGIN_API_SUPPORTED_VERSIONS,
  XACPX_PLUGIN_MIN_CORE_VERSION,
  WEACPX_PLUGIN_API_VERSION,
  WEACPX_PLUGIN_API_SUPPORTED_VERSIONS,
  WEACPX_PLUGIN_MIN_CORE_VERSION,
} from "./plugins/types.js";

// Realtime session switching + per-session concurrency primitives, shared with
// channel plugins (feishu, yuanbao, …) that re-implement their own dispatch/
// output layer but reuse core lane scheduling + session state.
export { createConversationExecutor } from "./runtime/conversation-executor.js";
export type { ConversationExecutor, ConversationExecutorLane } from "./runtime/conversation-executor.js";
export { resolveTurnLane } from "./runtime/turn-lane.js";
export { createActiveTurnRegistry } from "./sessions/active-turn-registry.js";
export type { ActiveTurnRegistry } from "./sessions/active-turn-registry.js";
export { toDisplaySessionAlias } from "./channels/channel-scope.js";
export type { SessionService } from "./sessions/session-service.js";
export type { BackgroundResult } from "./state/types.js";
export type { ChatRequestMetadata } from "./weixin/agent/interface.js";

// Localization: the resolved runtime locale and its type, so channel plugins can
// select language for their own per-package string catalogs. Plugins keep their
// OWN catalog (core's typed Messages contract is core-only); they read the active
// locale here, or take it from `ChannelStartInput.locale` for explicit threading.
export { getLocale } from "./i18n/index.js";
export type { Locale } from "./i18n/index.js";

// Structured control facade — for relay connectors and other non-text consumers
// that need programmatic access to sessions, prompt, scheduler, and orchestration.
export type {
  ControlExecuteCommandInput,
  ControlPromptInput,
  ControlPromptResult,
  ControlService,
  ControlSessionInfo,
} from "./control/control-service.js";
export type { ControlEvent, ControlEventBus, ControlEventListener } from "./control/control-event-bus.js";

// Core home directory (~/.xacpx or env override). Channel plugins that persist
// their own runtime credentials (weixin precedent) anchor their state files here.
export { coreHomeDir } from "./runtime/core-home.js";
