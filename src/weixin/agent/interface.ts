import type { ChannelMediaAttachment, OutboundChannelMedia } from "../../channels/media-types.js";
import type { PlanEntry, ScheduledSessionDescriptor, ToolUseEvent } from "../../channels/types.js";
import type { AgentCommand, PromptUsage } from "../../transport/types.js";
import type { PerfSpan } from "../../perf/perf-tracer.js";

/**
 * Agent interface — any AI backend that can handle a chat message.
 *
 * Implement this interface to connect WeChat to your own AI service.
 * The WeChat bridge calls `chat()` for each inbound message and sends
 * the returned response back to the user.
 */

export interface Agent {
  /** Process a single message and return a reply. */
  chat(request: ChatRequest): Promise<ChatResponse>;
  /** Return true when the text begins with a command prefix handled by this agent. */
  isKnownCommand?(text: string): boolean;
  /** Clear/reset the session for a given conversation. */
  clearSession?(conversationId: string): void | Promise<void>;
}

export interface ChatRequest {
  /** Inbound Weixin account id that received this message. */
  accountId: string;
  /** Conversation / user identifier. Use this to maintain per-user context. */
  conversationId: string;
  /** Text content of the message. */
  text: string;
  /** Attached media file(s) (image, audio, video, or generic file). */
  media?: ChannelMediaAttachment | ChannelMediaAttachment[];
  /**
   * Optional callback for streaming text out during long-running agent
   * processing. When the channel delivers any non-empty reply segment,
   * callers may treat it as the text output channel for that turn and
   * suppress `ChatResponse.text`.
   */
  reply?: (text: string) => Promise<void>;
  /** Latest inbound Weixin context token for follow-up replies in the same chat. */
  replyContextToken?: string;
  /** Channel-provided facts for command authorization and routing policy. */
  metadata?: ChatRequestMetadata;
  /**
   * Signals that the channel has received an abort/stop request for this turn.
   * Agents that can interrupt long-running work (e.g. cancel an in-flight acpx
   * prompt) should observe this and bail out early. Optional; agents that don't
   * support cancellation may ignore it — the channel will still suppress any
   * output produced after abort.
   */
  abortSignal?: AbortSignal;
  /** Structured tool-use side-channel; see PromptOptions.onToolEvent. */
  onToolEvent?: (event: ToolUseEvent) => void | Promise<void>;
  /** Structured thinking side-channel; see PromptOptions.onThought. */
  onThought?: (chunk: string) => void | Promise<void>;
  /** Structured plan/todo side-channel; see PromptOptions.onPlan. */
  onPlan?: (entries: PlanEntry[]) => void | Promise<void>;
  /** Context-usage side-channel; see PromptOptions.onUsage. */
  onUsage?: (usage: PromptUsage) => void | Promise<void>;
  /** Agent-advertised slash commands; see PromptOptions.onCommands. */
  onCommands?: (commands: AgentCommand[]) => void | Promise<void>;
  /**
   * Optional per-turn performance tracing span. When `logging.perf.enabled` is
   * true, the channel handler attaches a `PerfSpan` so downstream layers can
   * inline `request.perfSpan?.mark(event, ctx)` without further plumbing.
   */
  perfSpan?: PerfSpan;
}

export interface ChatRequestMetadata {
  channel?: string;
  chatType?: "direct" | "group";
  senderId?: string;
  senderName?: string;
  groupId?: string;
  isOwner?: boolean;
  /** Internal xacpx session alias to use for non-interactive scheduled prompts. */
  scheduledSessionAlias?: string;
  /** Transient session descriptor for temp-mode scheduled prompts (no persisted alias). */
  scheduledSessionDescriptor?: ScheduledSessionDescriptor;
  // When set, the prompt is bound to this INTERNAL session alias, captured at
  // dispatch time. A queued prompt then runs against the session that was
  // current when the user sent it — not whatever current_session is now (the
  // user may have switched sessions while it waited on the per-session lane).
  boundSessionAlias?: string;
  /**
   * When true, this turn is an internal peer collaboration turn and MUST NOT
   * overwrite the coordinator's recorded human return route context.
   */
  preserveCoordinatorRoute?: boolean;
}

export interface ChatResponse {
  /**
   * Final reply text when no streamed `reply()` output was delivered for
   * the same turn. May contain markdown and will be normalized before send.
   */
  text?: string;
  /** Reply media file(s). */
  media?: OutboundChannelMedia | OutboundChannelMedia[];
}
