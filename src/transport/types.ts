import type { NonInteractivePermissions, PermissionMode } from "../config/types";
import type { SessionTransportEngine } from "../state/types";
import type { ClaudeSettingsPolicy } from "../adapters/claude-settings-policy";
import type { QuotaManager } from "../weixin/messaging/quota-manager.js";
import type { PlanEntry, ToolUseEvent } from "../channels/types.js";
import type { ToolEventMode } from "./tool-event-mode.js";
import type {
  SessionMessageInput,
  SessionMessageReceipt,
} from "./message-injection";

export type { ToolEventMode } from "./tool-event-mode.js";
export type {
  SessionMessageInput,
  SessionMessageMode,
  SessionMessageReceipt,
} from "./message-injection";

/** Cumulative session cost the agent reported (ACP `usage_update.cost`). Both optional. */
export interface UsageCost {
  amount?: number;
  currency?: string;
}
/**
 * Per-turn token breakdown from ACP `usage_update._meta.usage` (Claude reports it;
 * codex may omit). All fields optional — treat missing as "unknown", not zero.
 */
export interface UsageBreakdown {
  inputTokens?: number;
  outputTokens?: number;
  cachedReadTokens?: number;
  cachedWriteTokens?: number;
  thoughtTokens?: number;
  totalTokens?: number;
}
/** Context-usage side-channel payload: window fill plus optional cost & token breakdown. */
export interface PromptUsage {
  used: number;
  size: number;
  cost?: UsageCost;
  breakdown?: UsageBreakdown;
}

/** An agent-advertised slash command (ACP `available_commands_update`). */
export interface AgentCommand {
  name: string;
  description?: string;
  /** Whether the command accepts an argument (ACP advertised a non-null `input`). */
  hasInput?: boolean;
}

export interface ReplyQuotaContext {
  chatKey: string;
  quota: QuotaManager;
}

export interface PromptMedia {
  type: "image" | "audio" | "video" | "file";
  filePath: string;
  mimeType: string;
  fileName?: string;
}

export interface PermissionPolicy {
  permissionMode: PermissionMode;
  nonInteractivePermissions: NonInteractivePermissions;
  permissionPolicy?: string;
}

export interface ResolvedSession {
  alias: string;
  agent: string;
  /** Resolved ACP driver behind the configured agent alias. */
  driver?: string;
  settingsPolicy?: ClaudeSettingsPolicy;
  /** Canonical acpx session identity (renderArgvIdentity for structured launches). */
  agentCommand?: string;
  /**
   * Positional acpx agent: bare built-in driver or xacpx-managed overlay alias.
   * Structured launches (managed adapters, hermes, user argv) resolve to the
   * alias provisioned in ~/.acpx/config.json; bare drivers pass through.
   */
  acpxAgent?: string;
  /** Legacy raw override / historical session selector passed as acpx `--agent`. */
  rawCommand?: string;
  /** Exact executable + argument boundaries for overlay/migration. */
  agentArgv?: string[];
  /**
   * LLM model id to run this session under (e.g. `gpt-5.2[high]`). Resolved from
   * the session's own override first, then the agent config default. When unset,
   * no `--model` is passed and acpx uses the agent adapter's default.
   */
  model?: string;
  /** Persisted reasoning-effort preference to reapply when the adapter process is recreated. */
  effort?: string;
  /** Cosmetic per-session display label (relay-web only). Mirrors LogicalSession.display_name;
   *  undefined when unset. Does not affect identity or transport. */
  displayName?: string;
  workspace: string;
  transportSession: string;
  source?: "xacpx" | "agent-side";
  agentSessionId?: string;
  agentSessionTitle?: string;
  agentSessionUpdatedAt?: string;
  attachedAt?: string;
  /** Immutable logical-session identity; sent as bridge logicalSessionId (plan §9.1). */
  logicalSessionId?: string;
  mcpCoordinatorSession?: string;
  mcpSourceHandle?: string;
  /** Bridge engine affinity resolved for this session ("cli" | "runtime"). */
  transportEngine?: SessionTransportEngine;
  modeId?: string;
  replyMode?: "stream" | "final" | "verbose";
  /**
   * Channel-resolved effective reply mode. The relay/control channel defaults to
   * "stream" (its dashboard is a streaming UI) so multi-line markdown isn't shredded
   * by batched paragraph reconstruction. Consumers prefer this over `replyMode`;
   * it's undefined for channels with no channel-level default (preserving their
   * existing `replyMode ?? "verbose"` behavior).
   */
  effectiveReplyMode?: "stream" | "final" | "verbose";
  cwd: string;
  /**
   * True for a non-persisted, single-use session (e.g. a `/later` temp-mode
   * scheduled run). Transport errors for such a session must not suggest
   * `/session new`/`attach`, and missing-session recovery (which mutates
   * persisted state by alias) does not apply.
   */
  transient?: boolean;
  /**
   * True when the user archived this session (process closed, greyed out in the
   * web dashboard). Surfaced to the control/web path via ControlSessionInfo.
   */
  archived?: boolean;
  /** ISO timestamp when the session was archived. */
  archivedAt?: string;
}

export interface AgentSession {
  sessionId: string;
  cwd?: string;
  title?: string | null;
  updatedAt?: string;
  _meta?: Record<string, unknown>;
}

export interface AgentSessionListQuery {
  agent: string;
  agentCommand?: string;
  /** Positional acpx agent for list/show queries (overlay alias or bare driver). */
  acpxAgent?: string;
  /** Legacy raw override / historical selector; the shared builder prefers it over acpxAgent. */
  rawCommand?: string;
  /** Resolved acpx driver for `agent` (e.g. a custom `my-codex` agent has driver `codex`). Used to gate driver-specific list filtering. */
  driver?: string;
  settingsPolicy?: ClaudeSettingsPolicy;
  cwd: string;
  cursor?: string;
  filterCwd?: string;
}

export interface AgentSessionListResult {
  source: "agent";
  sessions: AgentSession[];
  cursor?: string;
  nextCursor?: string | null;
  cwd?: string;
}

export type EnsureSessionProgressStage = "spawn" | "initializing" | "ready";
export type EnsureSessionProgress =
  | EnsureSessionProgressStage
  | { kind: "note"; text: string };

export type PromptMediaInput = PromptMedia | PromptMedia[];

export interface PromptOptions {
  /** Abort the whole prompt lifecycle, including transport-owned continuations. */
  signal?: AbortSignal;
  onSegment?: (text: string) => void | Promise<void>;
  /**
   * Structured side-channel for tool calls. See `toolEventMode` for routing.
   *
   * Async semantics: callbacks are invoked in event order and serialized —
   * each invocation is awaited before the next is dispatched. The transport
   * waits for all callbacks to settle before resolving the prompt. If any
   * invocation throws or returns a rejected promise, the prompt rejects
   * with the first observed error (matching `onSegment` behavior).
   */
  onToolEvent?: (event: ToolUseEvent) => void | Promise<void>;
  /**
   * Optional structured side-channel for the agent's thinking/reasoning.
   *
   * Each acpx `agent_thought_chunk` is forwarded raw (no buffering, no
   * paragraph splitting). Channels that register this callback opt in to
   * receiving thoughts and are responsible for their own accumulation /
   * rendering. When omitted, thought chunks are dropped at the transport
   * boundary — the built-in WeChat channel does not register it.
   *
   * Async semantics match `onSegment`: invocations are serialized and the
   * transport awaits all of them before resolving the prompt; the first
   * error observed rejects the prompt.
   */
  onThought?: (chunk: string) => void | Promise<void>;
  /**
   * Structured plan/todo side-channel: the agent's full ACP `plan` entry list,
   * re-sent on every update (REPLACE, not append). Optional — text channels omit it.
   */
  onPlan?: (entries: PlanEntry[]) => void | Promise<void>;
  /**
   * Context-usage side-channel: the agent's ACP `usage_update` — `used` tokens
   * currently in context and `size`, the model's total context window. Replace-latest
   * scalar (re-sent during a turn). Optional — only agents that report it fire this
   * (e.g. claude does, codex does not), and text channels omit the handler.
   */
  onUsage?: (usage: PromptUsage) => void | Promise<void>;
  /**
   * Agent-advertised slash commands (ACP `available_commands_update`). Replace-latest
   * list, re-sent when the agent updates it. Optional — not every adapter advertises.
   */
  onCommands?: (commands: AgentCommand[]) => void | Promise<void>;
  /**
   * How tool_call / tool_call_update events are surfaced for this prompt.
   *
   * - "text" (default when no handler): legacy emoji-prefixed segments in the reply stream.
   * - "structured" (default when a handler is provided): events go to `onToolEvent` only.
   * - "both": events go to `onToolEvent` AND legacy text segments — useful for migration.
   *
   * Resolved at the transport boundary via `resolveToolEventMode`.
   */
  toolEventMode?: ToolEventMode;
  media?: PromptMediaInput;
}

export interface SessionTransport {
  ensureSession(
    session: ResolvedSession,
    onProgress?: (progress: EnsureSessionProgress) => void,
  ): Promise<void>;
  tailSessionHistory(session: ResolvedSession, lines: number): Promise<{ text: string }>;
  prompt(
    session: ResolvedSession,
    text: string,
    reply?: (text: string) => Promise<void>,
    replyContext?: ReplyQuotaContext,
    options?: PromptOptions,
  ): Promise<{ text: string }>;
  injectMessage?(
    session: ResolvedSession,
    input: SessionMessageInput,
  ): Promise<SessionMessageReceipt>;
  setMode(session: ResolvedSession, modeId: string): Promise<void>;
  /** Switch the running session's model. Optional: transports that can't omit it. */
  setModel?(session: ResolvedSession, modelId: string): Promise<void>;
  /** Read the current model and the agent-advertised available model ids. Optional. */
  getSessionModel?(session: ResolvedSession): Promise<{ current?: string; available: string[] }>;
  /** Set the adapter-advertised reasoning effort for this session. Optional. */
  setSessionEffort?(session: ResolvedSession, effort: string): Promise<void>;
  /** Read the current and adapter-advertised reasoning-effort values. Optional. */
  getSessionEffort?(session: ResolvedSession): Promise<SessionEffortState>;
  cancel(session: ResolvedSession): Promise<{ cancelled: boolean; message: string }>;
  hasSession(session: ResolvedSession): Promise<boolean>;
  listAgentSessions?(query: AgentSessionListQuery): Promise<AgentSessionListResult | undefined>;
  resumeAgentSession?(session: ResolvedSession, agentSessionId: string): Promise<void>;
  removeSession?(session: ResolvedSession): Promise<void>;
  /**
   * Hard-delete the transport session AND its on-disk history: close the acpx
   * process, then delete acpx's record files. Distinct from removeSession (=
   * `acpx sessions close`, which keeps history for resume). Optional: transports
   * that can't delete omit it. A missing acpx session is a no-op (idempotent).
   */
  deleteSession?(session: ResolvedSession): Promise<void>;
  /**
   * Release one logical alias's engine-side state WITHOUT touching the
   * shared physical session: terminate/release its worker, retire its fence
   * ownership, drop its queue journal/catalog/timers — but keep the acpx
   * record and history (a sibling alias still owns them). Fails closed
   * while the alias has an active turn (caller keeps the logical row).
   * Optional: transports without per-logical engine state omit it.
   */
  releaseLogicalSession?(session: ResolvedSession): Promise<void>;
  /**
   * Terminate the warm queue-owner process for this session, freeing its
   * resources, WITHOUT closing the acpx session (no `closed` flag, no metadata
   * change) — the session stays open and resumes with full history on the next
   * prompt. Idempotent: a missing warm process or missing session is a no-op.
   * Used by archive to free the process now instead of waiting for acpx's TTL.
   * Optional: transports that can't reap omit it.
   */
  freeWarmProcess?(session: ResolvedSession): Promise<void>;
  /**
   * Whether this session's warm queue-owner process is currently alive (=
   * the next prompt responds immediately instead of cold-starting). False
   * when the owner exited via TTL, archive, or any other reason. Optional:
   * transports that can't observe process liveness omit it.
   */
  isSessionWarm?(session: ResolvedSession): Promise<boolean>;
  /**
   * Read the underlying agent-native session id for an existing transport
   * session. Used by `/clear` to keep a native session native: the fresh
   * post-clear session is itself backed by a new agent rollout, and this
   * returns that rollout's resumable id. Returns undefined when the agent did
   * not advertise one. Optional: transports that can't resolve it omit it.
   */
  getAgentSessionId?(session: ResolvedSession): Promise<string | undefined>;
  updatePermissionPolicy?(policy: PermissionPolicy): Promise<void>;
  dispose?(): Promise<void>;
}

export interface SessionEffortState {
  current?: string;
  available: string[];
}
