/** Wire mirror of the core control session listing. */
export interface SessionDto {
  alias: string;
  agent: string;
  /** The acpx driver backing `agent` (codex/claude/…), resolved from the instance's
   *  agent config. Lets the web render the brand icon without a second agents lookup
   *  — critical for sleeping (archived) sessions, whose rows can live outside the
   *  active session list. Omitted by old instances; web falls back to its agents map. */
  driver?: string;
  workspace: string;
  transportSession: string;
  running: boolean;
  archived: boolean;
  /** ISO timestamp when the session was archived. */
  archivedAt?: string;
  /** Whether the session's agent process is currently alive (next prompt responds without
   *  a cold start). Drives the web cold-session indicator, shown only when `warm === false`.
   *  Omitted when unknown — old instances that don't report warmth, or a session not yet
   *  sampled — so old connectors and old web builds stay wire-compatible. */
  warm?: boolean;
  /** True when this logical session was attached to an existing agent-side (native) rollout
   *  — e.g. a resumed codex session — rather than freshly created via `/session new`. Lets
   *  the web badge native sessions distinctly. Omitted (not `false`) for fresh sessions. */
  native?: boolean;
  /** The agent adapter command this session actually runs (acpx-recorded, or the agent's
   *  resolved default). Lets the web avoid seeding a new session's model picker from a
   *  session running a different adapter version — those advertise model ids in
   *  incompatible formats (e.g. codex `gpt-5.5[high]` vs `gpt-5.5/high`). Omitted when
   *  unknown. */
  agentCommand?: string;
  /** Cosmetic display label set from relay-web. When present, the web shows this instead of
   *  `alias`. Identity stays `alias`. Omitted when unset. */
  displayName?: string;
}

/** Wire DTO for a configured agent on an instance. */
export interface AgentDto {
  name: string;
  driver: string;
}

/** Wire DTO for a machine-available agent driver and its readiness. */
export interface AgentCatalogEntryDto {
  driver: string;
  configured: boolean;
  installed: "builtin" | "yes" | "unknown";
}

/** Wire DTO for a configured workspace on an instance. */
export interface WorkspaceDto {
  name: string;
  cwd: string;
  description?: string;
}

/** A single entry in a workspace directory listing (read-only file browser). */
export interface FsEntryDto {
  name: string;
  type: "dir" | "file";
  /** File size in bytes; omitted for directories. */
  size?: number;
  /** True when git considers the entry ignored (omitted in non-git workspaces). */
  ignored?: boolean;
}

/** One content-search match line (mode:"content"). */
export interface FsSearchHitDto {
  path: string;
  line: number;
  text: string;
}

/** A changed file in a workspace's git working tree. `status` is the porcelain XY
 *  code (e.g. " M", "A ", "??", "D "). */
export interface FsDiffFileDto {
  path: string;
  status: string;
}

// Keep in sync with ScheduledTaskStatus in src/scheduled/scheduled-types.ts
export type ScheduledTaskStatusDto =
  "pending" | "triggering" | "executed" | "cancelled" | "missed" | "failed";

/** Wire DTO for a scheduled task; maps from core ScheduledTaskRecord. */
export interface ScheduledTaskDto {
  id: string;
  sessionAlias: string;
  executeAt: string;
  message: string;
  status: ScheduledTaskStatusDto;
  createdAt: string;
  /** Set once the task has fired successfully (status "executed"). */
  executedAt?: string;
  /** Set when a fire attempt failed (status "failed"). */
  failedAt?: string;
  /** Failure reason, present alongside `failedAt`. */
  lastError?: string;
}

/** Marks a turn (and its inbound prompt message) as originating from a fired
 *  scheduled task, so the web can badge it and link back to the schedule entry. */
export interface ScheduledOriginDto {
  taskId: string;
  executeAt: string;
}

// Keep in sync with OrchestrationTaskStatus in src/orchestration/orchestration-types.ts
export type OrchestrationTaskStatusDto =
  | "needs_confirmation"
  | "queued"
  | "running"
  | "blocked"
  | "waiting_for_human"
  | "completed"
  | "failed"
  | "cancelled";

/** Wire DTO for an orchestration task; projected from core OrchestrationTaskRecord. */
export interface OrchestrationTaskDto {
  taskId: string;
  status: OrchestrationTaskStatusDto;
  targetAgent: string;
  workspace: string;
  task: string;
  summary: string;
  createdAt: string;
  updatedAt: string;
}

export type ToolStepStatus = "running" | "success" | "error";
export type ToolStepKind =
  | "read"
  | "search"
  | "execute"
  | "edit"
  | "delete"
  | "move"
  | "fetch"
  | "think"
  | "other";

/** Friendly, presentation-ready detail for one tool call (no raw JSON crosses the wire). */
export type ToolDetailDto =
  // `instruction` carries an edit's human-readable intent (Edit's instruction/description);
  // optional so old connectors and old web builds stay wire-compatible.
  | {
      type: "diff";
      path: string;
      oldText: string;
      newText: string;
      instruction?: string;
    }
  | { type: "read"; path: string; lines?: string; preview?: string }
  | { type: "command"; command: string; output?: string; exitCode?: number; truncated?: boolean }
  | { type: "search"; query: string; output?: string; count?: number; truncated?: boolean }
  // `output` carries a subagent's streamed/finished result text (see isSubagent steps),
  // rendered as its report; ordinary prose text steps omit it. Optional so old connectors
  // and old web builds stay wire-compatible.
  | { type: "text"; text: string; output?: string }
  | {
      type: "fields";
      fields: Array<{ label: string; value: string }>;
      output?: string;
    };

/** One collapsed tool-call step, normalized at the connector from a core ToolUseEvent. */
export interface ToolStepDto {
  toolCallId: string;
  /** Parent tool call for steps executed inside a delegated subagent. */
  parentToolCallId?: string;
  /** Marks the Agent/Task tool call that owns a delegated subagent trace. */
  isSubagent?: boolean;
  toolName: string;
  kind: ToolStepKind;
  status: ToolStepStatus;
  title: string;
  /** True when `title` is a bare file path the connector resolved from the
   *  tool's own arguments/location (never an adapter summary). The web uses
   *  it to head-ellipsis path previews (`…tail`) so the filename survives;
   *  absent (older connectors) falls back to a kind+separator heuristic. */
  titleIsPath?: boolean;
  durationMs?: number;
  /** First-frame epoch ms for this step (connector clock), so a still-running step
   *  can render a live elapsed timer. STEP-level — unrelated to
   *  `MessageRecordDto.startedAt`, which is the TURN's start. Present only while
   *  running; absent on finished/history rows (they carry `durationMs` instead). */
  startedAt?: number;
  detail?: ToolDetailDto;
  /** Failure message, present only when status === "error". */
  error?: string;
  /** Agent Messaging receipt correlation — populated only for the `agent_send`
   * tool when the connector extracted a valid structured receipt (messageId).
   * Enables anchoring the sent peer-message card to this exact step. */
  agentMessageId?: string;
  /** Terminal id when the driver routed the call through an agent-side terminal
   * and reports only `{type:"terminal",terminalId}` (Kimi). The output is not on
   * the wire, so the UI can say so instead of showing an empty result. */
  terminalId?: string;
}

/** One entry in a turn's canonical ordered wire transcript, retained for transport,
 *  persistence, and presentation timeline construction. Consecutive text may be
 *  coalesced, but consumers must preserve canonical wire provenance: activities
 *  never reorder against each other, and presentation may only delay an activity
 *  to a legal Markdown slot — never move it earlier than its wire offset. */
export type TurnPartDto =
  | { type: "text"; text: string }
  | { type: "reasoning"; text: string }
  | { type: "tool"; step: ToolStepDto };

/** One entry in the agent's ACP plan (todo list). STRUCTURALLY IDENTICAL to core
 *  PlanEntry — the connector forwards plan events as pass-through, so any drift here
 *  silently breaks the wire. */
export interface PlanEntryDto {
  content: string;
  status: "pending" | "in_progress" | "completed";
  priority?: "high" | "medium" | "low";
}

/** Cumulative session cost the agent reported (mirror of src UsageCost). Both optional. */
export interface UsageCostDto {
  amount?: number;
  currency?: string;
}
/** An agent-advertised slash command (mirror of src AgentCommand). */
export interface AgentCommandDto {
  name: string;
  description?: string;
  hasInput?: boolean;
}
/** Per-turn token breakdown (mirror of src UsageBreakdown). All fields optional. */
export interface UsageBreakdownDto {
  inputTokens?: number;
  outputTokens?: number;
  cachedReadTokens?: number;
  cachedWriteTokens?: number;
  thoughtTokens?: number;
  totalTokens?: number;
}

/** One pending item in a session's server-side prompt queue. */
export interface QueueItemDto {
  id: string;
  textPreview: string;
  enqueuedAt: string;
  /** v0.4: present ONLY for a reserved-but-not-started peer interrupt
   *  (snapshot-first item). Additive and backward compatible. */
  kind?: "interrupt";
}

/**
 * Exact join from a live turn event onto ConversationRun / MemberTurn.
 *
 * When this field is present on a Control event, `sessionAlias` is legacy
 * transport plumbing for old clients. Product liveness, ownership, and
 * routing use these ids — never the hidden session alias.
 */
export interface ConversationTurnCorrelationDto {
  conversationId: string;
  topicId: string;
  /**
   * Product row ids, present when the opener HAS them.
   *
   * A hub-sourced frame (conversation prompt) knows all three; a connector that
   * opens an interaction from a turn knows only the product keys the turn's own
   * route carried, and manufacturing ids would put fabricated joins in front of
   * the UI. So they are optional and a consumer that needs one MUST handle its
   * absence rather than treat "" as "none".
   */
  botId?: string;
  runId?: string;
  memberTurnId?: string;
  /**
   * Hub-issued id for the prompt row that started this turn, when it was
   * pre-written. Present on the correlation so a consumer can join a turn to its
   * originating message without a second lookup; absent for turns the hub did
   * not pre-write.
   */
  promptRequestId?: string;
}

export interface BotSummaryDto {
  id: string;
  name: string;
  avatar?: string;
  role?: string;
  agent: string;
  workspace: string;
  model?: string;
  effort?: string;
  enabled: boolean;
  updatedAt: string;
  /** Monotonic per-Bot revision, bumped on every update. Lets the Web order
   *  summary snapshots against cached details: a summary with a newer
   *  revision than the cached detail proves the detail is stale (including
   *  instructions-only updates that change no other summary field).
   *  Optional to stay wire-compatible with older connectors that predate
   *  it; the Web treats a missing revision as unknown (field comparison
   *  still applies). */
  profileRevision?: number;
  /** True once the Bot materialized any runtime (direct or group-member).
   *  Agent changes lock on this; workspace-default changes lock only on
   *  direct runtime (Group Topics always carry an explicit workspace). A
   *  persisted Direct Conversation alone keeps delete fail-closed via
   *  bot_in_use but does not lock identity. */
  hasRuntime?: boolean;
}
export interface BotDetailDto extends BotSummaryDto {
  instructions?: string;
  profileRevision: number;
  createdAt: string;
}

export interface ExecutionTargetDto {
  workspace: string;
  cwd?: string;
  /** Responses must stay legacy-tolerant: a Topic persisted before the
   *  worktree gate can still carry `worktree-per-member`. Creation refuses it. */
  isolation: "shared" | "shared-single-writer" | "worktree-per-member";
}

/** Create-time Topic execution target. PR7 supports the two shared policies
 *  only: `worktree-per-member` has no provisioning lifecycle, so a Topic
 *  created with it could never execute (materialization fails closed). */
export interface GroupTopicCreateTargetDto {
  workspace: string;
  cwd?: string;
  isolation: "shared" | "shared-single-writer";
}

export interface TopicSummaryDto {
  id: string;
  conversationId: string;
  title: string;
  status: "active" | "archived" | "deleting";
  createdAt: string;
  updatedAt: string;
  executionTarget?: ExecutionTargetDto;
}

export interface GroupSummaryDto {
  id: string;
  kind: "group";
  title: string;
  description?: string;
  botIds: string[];
  leadBotId?: string;
  defaultTopicId?: string;
  lifecycle?: "active" | "deleting";
  createdAt: string;
  updatedAt: string;
}

export interface GroupDetailDto extends GroupSummaryDto {
  topics: TopicSummaryDto[];
}

export interface ConversationSummaryDto {
  id: string;
  kind: "bot";
  title: string;
  botId: string;
  defaultTopicId?: string;
  lifecycle?: "active" | "deleting";
  createdAt: string;
  updatedAt: string;
}

export interface ConversationDetailDto extends ConversationSummaryDto {
  description?: string;
  topics: TopicSummaryDto[];
}

export interface ConversationMessageDto {
  id: string;
  conversationId: string;
  topicId: string;
  seq: number;
  role: "human" | "bot" | "system";
  senderBotId?: string;
  content: string;
  replyTo?: string;
  runId?: string;
  createdAt: string;
  promptRequestId?: string;
}

export type ConversationRunStateDto =
  | "queued"
  | "running"
  | "waiting-human"
  | "completed"
  | "failed"
  | "cancelled"
  | "indeterminate";

export interface ConversationRunDto {
  id: string;
  conversationId: string;
  topicId: string;
  requestMessageId: string;
  requestId: string;
  mode: "explicit" | "automatic";
  state: ConversationRunStateDto;
  completionReason?: string;
  profileRevision: number;
  /** Active batch for multi-member Runs. Absent on older single-member shapes. */
  activeBatch?: number;
  /** Guardrail cap; absent on older wire shapes (direct legacy default 1). */
  maxMemberTurns?: number;
  /** Progress counter; absent on older wire shapes (direct legacy default 0). */
  consumedMemberTurns?: number;
  /** Members that failed in the current batch; absent on older wire shapes. */
  failedBotIds?: string[];
  /** Members unavailable for the current batch; absent on older wire shapes. */
  unavailableBotIds?: string[];
  createdAt: string;
  startedAt?: string;
  finishedAt?: string;
}

export interface BotProfileSnapshotDto {
  revision: number;
  capturedAt: string;
  presentation: { name: string; avatar?: string; role?: string };
  behavior: { instructions?: string };
  execution: { agent: string; workspace: string; model?: string; effort?: string };
}

/** Explicit Group routing target. IDs are authority; display names never route.
 *  `everyone` expands at accept to the current eligible members — live Group
 *  membership filtered by the Bot being enabled. `automatic` is a durable-mode
 *  reservation (PR8) rejected by PR7 accept. */
export type ConversationTargetDto =
  | { botId: string }
  | { mode: "members"; botIds: string[] }
  | { mode: "everyone" }
  | { mode: "automatic" };

export interface MemberTurnSummaryDto {
  id: string;
  runId: string;
  conversationId: string;
  topicId: string;
  botId: string;
  batch: number;
  /** Durable accept order within the batch (0-based). Absent on older wire shapes. */
  memberIndex?: number;
  attempt: number;
  origin: "human-explicit" | "human" | "router" | "handoff" | "followup" | "retry" | "recovery";
  state: "queued" | "dispatched" | "running" | "completed" | "failed" | "cancelled" | "indeterminate";
  promptRequestId?: string;
  createdAt: string;
  startedAt?: string;
  finishedAt?: string;
  assignmentId?: string;
  task?: string;
  expectedOutput?: string;
  dependsOn?: string[];
  /** Machine-readable terminal failure reason (failed only). */
  failureReason?: string;
}

export interface ConversationRunDetailDto extends ConversationRunDto {
  profileSnapshot?: BotProfileSnapshotDto;
  memberTurns: MemberTurnSummaryDto[];
}

export interface ConversationPromptResponseDto {
  reused: boolean;
  conversationId: string;
  topicId: string;
  requestId: string;
  run: ConversationRunDto;
  message: ConversationMessageDto;
  memberTurn: MemberTurnSummaryDto;
  /** Every accepted member in durable order (first mirrors `memberTurn`).
   *  Optional for wire compat with older connectors. */
  memberTurns?: MemberTurnSummaryDto[];
  /** Topic-wide authoritative owner as of accept (executing, else oldest
   *  queued). Lets the caller adopt the true owner without a second
   *  runs.list round trip: an HTTP accept proves only the accepted Run is
   *  durable, never that it owns the Topic. Optional for wire compat with
   *  older connectors; when absent the caller must treat the accepted Run
   *  as unconfirmed and re-run discovery before cancelling it. */
  activeRunId?: string;
  activeRun?: ConversationRunDto;
}

export interface ConversationHistoryResponseDto {
  conversationId: string;
  topicId: string;
  messages: ConversationMessageDto[];
  oldestSeq?: number;
  newestSeq?: number;
  hasMoreBefore: boolean;
  hasMoreAfter: boolean;
}

export interface ConversationRunsListDto {
  conversationId: string;
  topicId: string;
  runs: ConversationRunDto[];
  activeRunId?: string;
  activeRun?: ConversationRunDto;
}

/** Wire mirror of src/control ControlEvent (tool-event carries the NORMALIZED step). */
export type ControlEventDto =
  | {
      type: "turn-output";
      chatKey: string;
      sessionAlias: string;
      chunk: string;
      conversation?: ConversationTurnCorrelationDto;
    }
  // `prompt` is set for scheduled turns and drained queued prompts. `queueItemId`
  // associates the latter with the message originally persisted at enqueue time.
  // `promptRequestId` (new connectors) correlates a drained queue item back to the
  // hub pre-written inbound row when the queued RPC response was lost.
  | {
      type: "turn-started";
      chatKey: string;
      sessionAlias: string;
      prompt?: string;
      scheduled?: ScheduledOriginDto;
      queueItemId?: string;
      promptRequestId?: string;
      peerOrigin?: PeerTurnOriginDto;
      /** Connector-local per-session seq at this turn-start (receive order, not a clock). */
      startedAfterSeq?: number;
      /** Connector recovery id for this turn; Hub keys the durable slot anchor with it. */
      recoveryId?: string;
      /** Hub-stamped last message id at turn-start (0 = empty transcript). Web live slot. */
      slotAfterId?: number;
      /** Hub-stamped epoch ms for this turn's start — the SAME value the eventual
       *  persisted row's `startedAt` carries, so web optimistic rows and their
       *  persisted replacements share one identity (trace-key stability). Optional:
       *  older hubs omit it and the web falls back to its own clock. */
      startedAt?: number;
      conversation?: ConversationTurnCorrelationDto;
    }
  | {
      type: "tool-event";
      chatKey: string;
      sessionAlias: string;
      step: ToolStepDto;
      conversation?: ConversationTurnCorrelationDto;
    }
  | {
      type: "turn-thought";
      chatKey: string;
      sessionAlias: string;
      chunk: string;
      conversation?: ConversationTurnCorrelationDto;
    }
  | {
      type: "plan";
      chatKey: string;
      sessionAlias: string;
      entries: PlanEntryDto[];
      conversation?: ConversationTurnCorrelationDto;
    }
  // Context-usage meter: `used` tokens in context, `size` total context window. Replace-latest.
  // `cost`/`breakdown` are optional extras (acpx ≥0.11.0); absent for adapters that don't report them.
  | {
      type: "turn-usage";
      chatKey: string;
      sessionAlias: string;
      used: number;
      size: number;
      cost?: UsageCostDto;
      breakdown?: UsageBreakdownDto;
      conversation?: ConversationTurnCorrelationDto;
    }
  // Agent-advertised slash commands (e.g. /compact). Session-scoped, replace-latest.
  | {
      type: "agent-commands";
      chatKey: string;
      sessionAlias: string;
      commands: AgentCommandDto[];
      conversation?: ConversationTurnCorrelationDto;
    }
  // `text` carries the final reply text for hub-side fallback persistence: a hub that
  // restarted mid-turn has no buffer for this finish, so it persists `text` directly.
  | {
      type: "turn-finished";
      chatKey: string;
      sessionAlias: string;
      ok: boolean;
      errorMessage?: string;
      cancelled?: boolean;
      text?: string;
      /** Skip persisting an empty out row (queue-overflow tips are toast-only). */
      silent?: boolean;
      recoveryId?: string;
      peerOrigin?: PeerTurnOriginDto;
      /** Connector-local seq captured at the original turn-start (Hub maps to insert order). */
      startedAfterSeq?: number;
      /** Connector-local epoch ms at turn-start — HUD telemetry only; never a reorder key. */
      startedAt?: number;
      conversation?: ConversationTurnCorrelationDto;
    }
  | { type: "sessions-changed" }
  // The configured workspace set changed (out-of-band CLI edit or `/config`); the web
  // re-fetches the workspace list. No payload.
  | { type: "workspaces-changed" }
  | { type: "scheduled-changed"; chatKey: string }
  // Recovered prior conversation for a freshly-attached native session; the hub seeds
  // these rows into the session's history so the dashboard isn't blank.
  | {
      type: "session-history";
      chatKey: string;
      sessionAlias: string;
      messages: SessionHistoryRowDto[];
    }
  | { type: "terminal-output"; terminalId: string; seq: number; data: string }
  | { type: "terminal-exit"; terminalId: string; code: number }
  | { type: "orchestration-changed" }
  // The session's server-side prompt queue changed (item enqueued/dequeued/cancelled);
  // replace-latest snapshot of the pending items.
  | {
      type: "queue-updated";
      chatKey: string;
      sessionAlias: string;
      items: QueueItemDto[];
    }
  | {
      type: "agent-message";
      chatKey?: string;
      sessionAlias: string;
      message: PeerMessageHistoryEntry;
    }
  | {
      /** v0.3 completion-status PATCH for an already-persisted sender card.
       *  Carries only the correlation id and new terminal status — the durable
       *  row's content/peer/mode must never be rebuilt from this event. */
      type: "agent-message-completion";
      sessionAlias: string;
      messageId: string;
      completionStatus: "completed" | "failed" | "cancelled";
    }
  | { type: "bots-changed" }
  | { type: "conversations-changed" }
  | { type: "conversation-topic-changed"; topic: TopicSummaryDto }
  | { type: "conversation-message"; message: ConversationMessageDto }
  | { type: "conversation-run-changed"; run: ConversationRunDto }
  | { type: "member-turn-started"; run: ConversationRunDto; memberTurn: MemberTurnSummaryDto }
  | { type: "member-turn-finished"; run: ConversationRunDto; memberTurn: MemberTurnSummaryDto }
  /** An interaction (permission or elicitation) opened for a human. Pushed to
   *  every connected browser for the account, so a tab that did not open it still
   *  sees the prompt. `chatKey`/`sessionAlias` are the runtime plumbing the web
   *  already ignores in favour of the product keys. */
  | {
      type: "interaction-opened";
      chatKey: string;
      sessionAlias: string;
      /**
       * The connector instance that opened this interaction.
       *
       * NOT optional and never "": the web gateway fences control-events on each
       * socket's instance subscription and the dashboard subscribes to its real
       * instances on connect, so a blank id is dropped by every subscribed
       * socket. It is also the instance the store routes an answer back to.
       */
      instanceId: string;
      interaction: InteractionRequestDto;
    }
  /** An interaction ended without a browser-supplied decision (resolved,
   *  withdrawn, or timed out). Lets web drop the pending row instead of leaving
   *  a dead form on screen. */
  | {
      type: "interaction-closed";
      chatKey: string;
      sessionAlias: string;
      /** See `interaction-opened.instanceId` — the same connector that opened it. */
      instanceId: string;
      requestId: string;
      reason: "resolved" | "withdrawn" | "expired";
      /**
       * The action a resolve actually carried, so a tab that did NOT click knows
       * what happened. Without it every resolve reads as "accepted", which is
       * why a Decline from one tab shows as Accepted in all the others.
       */
      action?: "accept" | "decline" | "cancel";
    };

export interface TerminalAttachRequest {
  terminalId: string;
}
export type TerminalAttachResult =
  { ok: false } | { ok: true; buffer: string; lastSeq: number };

/** One recovered history row (a persisted-shaped message) for a native-session seed. */
export interface SessionHistoryRowDto {
  direction: "in" | "out";
  text: string;
  structured?: {
    toolSteps?: ToolStepDto[];
    reasoning?: string;
    parts?: TurnPartDto[];
  };
}

/** Wire DTO for an agent endpoint published to Relay Hub for remote discovery. */
export interface PublishedAgentEndpointDto {
  nodeId: string;
  endpointId: string;
  displayName?: string;
  sessionAlias?: string;
  agent: string;
  workspace?: string;
  state: "idle" | "running";
  activity?: {
    status: "idle" | "working" | "waiting";
    summary?: string;
  };
  capabilities: {
    receive: boolean;
    steer: boolean;
    queue: boolean;
    interrupt: boolean;
    conversation?: boolean;
    completion?: boolean;
  };
  labels?: string[];
  /** Endpoint context for presentation ranking. logical = normal logical session endpoint; worker = orchestration worker endpoint. Optional: old peers omit it. */
  endpointKind?: "logical" | "worker";
  /** Source channel namespace owning the endpoint when known (e.g. "relay", "weixin", "feishu"). Optional. */
  channelId?: string;
  updatedAt: number;
}

export type AgentMessageCompletionMode = "none" | "notify" | "result";
export type AgentMessageCompletionStatus = "completed" | "failed" | "cancelled";

export interface AgentAddressDto {
  nodeId: string;
  endpointId: string;
}

export interface PeerTurnOriginDto {
  requestMessageId: string;
  completion: AgentMessageCompletionMode;
  source: AgentAddressDto;
  target: AgentAddressDto;
}

export interface PeerMessagePeer {
  handle: string;
  displayName: string;
  agent: string;
  workspace?: string;
}

export interface PeerMessageHistoryEntry {
  kind: "agent_message";
  direction: "sent" | "received";
  messageId: string;
  conversationId: string;
  replyTo?: string;
  peer: PeerMessagePeer;
  content: string;
  createdAt: number;
  status?: "sending" | "sent" | "queued" | "delivered" | "failed";
  completion?: AgentMessageCompletionMode;
  completionStatus?: "pending" | "completed" | "failed" | "cancelled";
}

/* ------------------------------------------------------------------ *
 * Relay interaction transport (shared by permission + elicitation).
 *
 * One envelope carries both decision kinds: core keeps the two brokers
 * separate, and so does the wire. `kind` is the discriminant; each kind keeps
 * its own payload and its own action set, so a later permission follow-up adds
 * a payload without touching this transport.
 * ------------------------------------------------------------------ */

/** Which decision model an opened interaction uses. */
export type InteractionKindDto = "permission" | "elicitation";

/** Terminal actions, per kind. */
export type InteractionActionDto =
  | "accept"
  | "decline"
  | "cancel"
  | "allow_once"
  | "allow_always"
  | "reject_once"
  | "reject_always";

/**
 * One normalized form field, already validated by core against ACP.
 *
 * Deliberately NOT the ACP SDK type: the web renderer must never be handed a raw
 * schema, only a shape core has already bounded. `options` are present for
 * select kinds only, and each option's `value` (not its agent-controlled label)
 * is what the answer must carry.
 */
export interface InteractionFieldDto {
  kind: "text" | "single-select" | "number" | "boolean" | "multi-select";
  key: string;
  title: string;
  description?: string;
  required: boolean;
  options?: Array<{ value: string; label: string; description?: string }>;
  minItems?: number;
  maxItems?: number;
  minLength?: number;
  maxLength?: number;
  /**
   * A named format core validates the answer against.
   *
   * Present because the transport is terminal: a value core rejects arrives
   * after the interaction has already resolved, so the renderer has to be able
   * to catch an unparseable value while the form is still open. A renderer that
   * cannot check it simply ignores it and core still validates.
   *
   * NOT text-only. Core applies the same format to a `single-select`'s chosen
   * option — its validator comment is "The agent's own string constraints apply
   * to the chosen option too" — so `enum: ["2026-02-30"]` with `format: "date"`
   * is a legal schema whose only offered value core will reject. A renderer
   * that scopes this to text would let that through.
   *
   * OPEN string, not an enum: core's schema is the authority on which names
   * exist and it declares `format?: string`, so an enum here would need updating
   * per new format and would reject a legal one. Bounded by the field validator.
   * The values core knows are `email`, `uri`, `date`, and `date-time`; an
   * unknown name is an annotation core preserves and does not reject.
   *
   * Note what a renderer can safely do with this: NONE of them are checkable
   * without duplicating core. `email` and `uri` are `ajv-formats` regexes, and
   * `date`/`date-time` need real calendar validation — `Date.parse` normalizes
   * `2026-02-30` into March instead of rejecting it. A renderer with no shared
   * implementation of these must treat the field as UNVERIFIABLE rather than
   * approximate it.
   */
  format?: string;
  /**
   * A regex the answer must match, as source text.
   *
   * Metadata, carried so a renderer can DISPLAY the required shape to the human.
   * It is never executed — not by core and not by the renderer: core's stated
   * rule is that an agent-supplied regex is a resource-exhaustion vector, so it
   * validates nothing against it and leaves the check to the asking Agent, which
   * validates its own pattern on the answer it receives. Bounded and passed as
   * TEXT only.
   */
  pattern?: string;
  /** Integer-ness for `number` fields; ACP has no separate integer kind. */
  integer?: boolean;
  minimum?: number;
  maximum?: number;
  defaultValue?: string | number | boolean | string[];
}

/** Answer values, by field key. Mirrors core's `ChannelElicitationValue`. */
export type InteractionValueDto = string | number | boolean | string[];

/** Hub -> connector, then down to the authenticated human. */
export interface InteractionRequestDto {
  /** xacpx broker correlation id. Ephemeral; core never persists it. */
  requestId: string;
  kind: InteractionKindDto;
  /**
   * Product identity for the web UI. Optional because an interaction on an
   * ordinary channel turn has no Conversation product row; a Direct Bot turn
   * does. Never a hidden `brt_*` session alias — those are runtime plumbing.
   */
  conversation?: ConversationTurnCorrelationDto;
  /** Absolute ms after which the interaction is no longer answerable. */
  expiresAt: number;
  /** Present iff `kind === "elicitation"`. */
  elicitation?: {
    mode: "form";
    message: string;
    fields: InteractionFieldDto[];
    schemaTitle?: string;
    /**
     * Schema-level descriptive text, shown beside the title.
     *
     * Carried because the wire validator deliberately allows `message: ""`: a
     * schema with a good title and description needs no prose. Dropping this left
     * the relay web form with nothing at all above the fields, so an agent that
     * carried its whole question in the schema produced a form that asked nothing.
     *
     * OPTIONAL and independent of `message` — either, both, or neither may be
     * present. Bounded like the other agent-controlled strings.
     */
    schemaDescription?: string;
    /**
     * The Agent that asked, pinned to the exact turn.
     *
     * REQUIRED, not presentation: ACP's User Interaction Requirements oblige a
     * client to show WHO is asking, so a human cannot mistake one agent's
     * question for another's. A renderer must display it and must not substitute
     * `message`/`schemaTitle` text for it — that text is agent-controlled, so
     * mounting an identity out of it would let any agent claim any name.
     *
     * Dropping it on the core → relay hop is what made the relay web form show
     * only a generic "Input needed": the trusted identity existed in core and
     * vanished at the wire.
     */
    agent: { name: string; sessionAlias?: string };
  };
  /** Present iff `kind === "permission"`. Reserved; M3 does not implement it. */
  permission?: {
    title?: string;
    kind?: string;
    summary?: string;
    availableOutcomes: string[];
  };
}

/** Connector -> hub, then up to core. Carries NO responder identity. */
export interface InteractionResponseDto {
  requestId: string;
  kind: InteractionKindDto;
  action: InteractionActionDto;
  /** Elicitation `accept` only. `null` is a valid all-optional accept. */
  content?: Record<string, InteractionValueDto> | null;
}

/** Hub -> browser: the authoritative open-interaction set for one instance. */
export interface InteractionSnapshotDto {
  /**
   * The instance this set is ABOUT. One snapshot speaks for exactly one instance,
   * so a client reconciling instance A may conclude nothing about B's forms — which
   * is what makes the per-entry omission below safe to act on.
   */
  readonly instanceId: string;
  /**
   * One entry per interaction the hub still holds open for `instanceId`, already
   * filtered to those whose window has not passed.
   *
   * Each entry carries the ROUTING fields (`chatKey`, `sessionAlias`) beside the
   * request — exactly as the live `interaction-opened` event shapes them, because a
   * browser that has never seen the interaction needs the same routing information
   * to open it. Omitting them would force the client to invent a chatKey, which is
   * the kind of guess the interaction contract forbids.
   *
   * NOTE: `instanceId` is NOT here. It belongs to the snapshot's outer field; an
   * entry repeats it in the live event only because that event is not itself
   * scoped. Both shapes are validated by the same `validInteractionOpenShape`, so
   * an entry and a live event are provably the same wire object.
   *
   * The request itself is the same object, so a browser that already holds the
   * interaction merges it rather than depending on field-by-field equality
   * between two wire paths.
   */
  readonly interactions: readonly {
    chatKey: string;
    sessionAlias: string;
    interaction: InteractionRequestDto;
  }[];
}

/** Connector -> hub: WITHDRAW an still-open interaction. */
export interface InteractionWithdrawDto {
  /** The interaction to withdraw. Idempotent for ids that already closed. */
  requestId: string;
}
