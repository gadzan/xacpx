import type { NonInteractivePermissions, PermissionMode } from "../config/types";
import type { QuotaManager } from "../weixin/messaging/quota-manager.js";
import type { PlanEntry, ToolUseEvent } from "../channels/types.js";
import type { ToolEventMode } from "./tool-event-mode.js";

export type { ToolEventMode } from "./tool-event-mode.js";

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
  agentCommand?: string;
  /**
   * LLM model id to run this session under (e.g. `gpt-5.2[high]`). Resolved from
   * the session's own override first, then the agent config default. When unset,
   * no `--model` is passed and acpx uses the agent adapter's default.
   */
  model?: string;
  workspace: string;
  transportSession: string;
  source?: "xacpx" | "agent-side";
  agentSessionId?: string;
  agentSessionTitle?: string;
  agentSessionUpdatedAt?: string;
  attachedAt?: string;
  mcpCoordinatorSession?: string;
  mcpSourceHandle?: string;
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
  onUsage?: (usage: { used: number; size: number }) => void | Promise<void>;
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
  setMode(session: ResolvedSession, modeId: string): Promise<void>;
  /** Switch the running session's model. Optional: transports that can't omit it. */
  setModel?(session: ResolvedSession, modelId: string): Promise<void>;
  /** Read the current model and the agent-advertised available model ids. Optional. */
  getSessionModel?(session: ResolvedSession): Promise<{ current?: string; available: string[] }>;
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
