import { createHash, randomUUID } from "node:crypto";

import type { AppLogger } from "../logging/app-logger";
import type { ControlEventBus } from "../control/control-event-bus";
import { isCommandTimeoutError } from "../transport/command-timeouts";
import {
  MessageInjectionError,
  type SessionMessageReceipt,
} from "../transport/message-injection";
import type {
  AgentEndpointRegistry,
  ResolvedAgentEndpoint,
  ResolvedAgentIdentity,
} from "./agent-endpoint-registry";
import { encodeAgentHandle } from "./agent-handle";
import { renderAgentMessageEnvelope } from "./agent-message-envelope";
import { toDisplaySessionAlias } from "../channels/channel-scope";
import {
  AgentMessagingError,
  type AgentMessagingErrorCode,
} from "./agent-messaging-error";
import {
  boundPeerResult,
  buildPeerCompletionPrompt,
  sanitizeCompletionError,
} from "./agent-message-completion";
import type { PeerTurnOrigin } from "../control/turn-support";
import type {
  AgentAddress,
  AgentEndpointView,
  AgentMessage,
  AgentMessageCompletion,
  AgentMessageCompletionMode,
  AgentMessageCompletionStatus,
  AgentMessageMode,
  AgentMessageReceipt,
  AgentMessageSendInput,
  AgentMessageTraceRecord,
  AgentSenderBinding,
  MessageContext,
  PeerMessageHistoryEntry,
  PeerMessagePeer,
} from "./agent-messaging-types";
import { RelayAgentMessageRoute } from "./relay-agent-message-route";
export interface LocalAgentMessageDelivery {
  deliver(
    target: ResolvedAgentEndpoint,
    message: AgentMessage,
    renderedText: string,
  ): Promise<SessionMessageReceipt>;
  deliverCompletion?(
    sourceAlias: string,
    completion: AgentMessageCompletion,
    requestMessageId: string,
  ): Promise<{ status: "injected" | "queued" } | { status: "rejected"; reason: string }>;
}

/**
 * Terminal result of an inbound delivery attempt, cached by messageId.
 * `receipt` → completed success; `error` → completed failure (tombstone). The
 * tombstone matters for AMBIGUOUS failures: the target may already have
 * accepted the message (e.g. acpx enqueued but the local ACK was lost), so a
 * same-id retry must return the same failure and NEVER re-inject.
 */
type InboundOutcome =
  { receipt: AgentMessageReceipt } | { error: AgentMessagingError };

export interface AgentMessageRouterLimits {
  maxMessageBytes?: number;
  maxReplyToBytes?: number;
  maxPendingPerTarget?: number;
  maxConversationDepth?: number;
  maxMessagesPerConversation?: number;
  duplicateContentWindowMs?: number;
  rateLimit?: {
    maxMessages: number;
    windowMs: number;
  };
  receiptCache?: {
    maxEntries: number;
    ttlMs: number;
  };
  contextCache?: {
    maxEntries: number;
    ttlMs: number;
  };
  pendingCompletion?: {
    maxEntries: number;
    ttlMs: number;
  };
  /** Bounded retention for terminal outcomes + exactly-once tombstones. */
  completionCache?: {
    maxEntries: number;
    ttlMs: number;
  };
  traceRingBufferSize?: number;
}

export class AgentMessageRouter {
  private readonly targetTails = new Map<string, Promise<void>>();
  private readonly pendingByTarget = new Map<string, number>();
  private readonly rateWindows = new Map<string, number[]>();
  private readonly receipts = new Map<
    string,
    { receipt: AgentMessageReceipt; expiresAt: number }
  >();
  /**
   * In-flight inbound deliveries keyed by messageId. The terminal outcome cache
   * is only written AFTER delivery completes, so a source retry that arrives
   * while the first delivery is still executing would otherwise see a cache
   * miss and inject AGAIN. This map single-flights concurrent duplicates: the
   * second caller joins the first delivery's promise and never re-injects.
   */
  private readonly inboundDeliveries = new Map<
    string,
    { work: Promise<AgentMessageReceipt>; fingerprint: string }
  >();
  /**
   * Terminal inbound outcomes keyed by messageId — a COMPLETED delivery's
   * receipt OR its failure tombstone, each bound to the delivery fingerprint.
   * Success dedupes completed retries; a failure tombstone makes a same-id
   * retry after an ambiguous terminal failure (e.g. acpx already enqueued but
   * the local ACK was lost) return the SAME failure instead of re-injecting.
   */
  private readonly inboundOutcomes = new Map<
    string,
    {
      fingerprint: string;
      outcome: InboundOutcome;
      expiresAt: number;
    }
  >();
  private readonly messageContexts = new Map<string, MessageContext>();
  private readonly conversationMessageCounts = new Map<string, number>();
  private readonly recentDuplicateContent = new Map<string, number>();
  private readonly traceRingBuffer: AgentMessageTraceRecord[] = [];
  private readonly outboundMessages = new Map<
    string,
    {
      senderSessionAlias: string;
      message: AgentMessage;
      targetPeer: PeerMessagePeer;
    }
  >();
  /**
   * Terminal completion outcomes, keyed by requestMessageId. Bounded
   * (TTL + max entries) — entries are pruned lazily and by the retry sweep.
   */
  private readonly completionOutcomes = new Map<
    string,
    { value: AgentMessageCompletion; expiresAt: number }
  >();
  /**
   * Source-side exactly-once tombstones. TTL-bounded: after expiry a duplicate
   * delivery may re-inject, which is acceptable (transport is at-least-once)
   * whereas unbounded growth on a long-lived daemon is not.
   */
  private readonly completionInjections = new Map<string, { expiresAt: number }>();
  /**
   * Authoritative pending-completion grants (v0.3 trust boundary). Created ONLY
   * when a logical sender successfully sends with completion != none; inbound
   * completions must exact-match a live grant or they are DELIVERY_DENIED.
   * Bounded (TTL + max entries) and persisted write-through so a daemon
   * restart between request and completion does not revoke the outward
   * "xacpx will return the peer's result" contract.
   */
  private readonly pendingCompletions = new Map<
    string,
    {
      source: AgentAddress;
      target: AgentAddress;
      mode: "notify" | "result";
      expiresAt: number;
      /** pending → delivered (durable, survives restart). Delivered rows are
       *  terminal tombstones until their TTL expires. */
      state: "pending" | "delivered";
    }
  >();
  /**
   * Completions whose terminal outcome is recorded but whose DELIVERY has not
   * yet been admitted (remote route offline, source queue full, transport
   * throw). Swept periodically until admitted or expired — a completion is
   * never silently dropped after the peer turn already finished.
   */
  private readonly deliveryPending = new Map<
    string,
    {
      attempt: () => Promise<boolean>;
      nextAttemptAt: number;
      expiresAt: number;
    }
  >();
  private deliveryRetryTimer: NodeJS.Timeout | undefined;



  /**
   * Durable-reserve a completion contract BEFORE the request is dispatched.
   * Throws when capacity is exhausted: pending grants are active contracts,
   * not a cache — expired entries are pruned, but an existing grant is NEVER
   * evicted to make room for a newer one. Persistence failures propagate so
   * the caller fails closed (nothing is sent).
   */
  private reservePendingCompletion(
    messageId: string,
    source: AgentAddress,
    target: AgentAddress,
    mode: "notify" | "result",
    now: number,
  ): void {
    const ttlMs = this.deps.limits?.pendingCompletion?.ttlMs ?? 24 * 60 * 60_000;
    const maxEntries =
      this.deps.limits?.pendingCompletion?.maxEntries ?? 1_000;
    if (ttlMs <= 0 || maxEntries <= 0) return;
    for (const [id, grant] of [...this.pendingCompletions]) {
      if (grant.expiresAt <= now) this.pendingCompletions.delete(id);
    }
    if (
      this.pendingCompletions.size >= maxEntries ||
      this.deliveryPending.size >= maxEntries
    ) {
      // Backpressure refuses the NEW contract instead of ever evicting an
      // older one — and the terminal-outbox projection is checked here too:
      // every accepted contract may still owe exactly one outbox entry, so
      // accepting more than the budget could later strand a finished result.
      throw new AgentMessagingError(
        "MESSAGE_QUEUE_FULL",
        "Pending completion capacity reached; existing completion contracts are never evicted.",
      );
    }
    this.pendingCompletions.set(messageId, {
      source,
      target,
      mode,
      expiresAt: now + ttlMs,
      state: "pending",
    });
    // Reserve must be durable before the request leaves this daemon — a
    // persistence failure here fails the send closed with a typed error, and
    // the in-memory reservation is rolled back so no phantom grant remains.
    try {
      this.persistPendingCompletions();
    } catch (error) {
      this.pendingCompletions.delete(messageId);
      throw new AgentMessagingError(
        "DELIVERY_FAILED",
        `Pending completion could not be persisted; request not sent: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  /** Compensation for a DEFINITE pre-admission rejection: the target never
   *  accepted the request, so the reservation is released. */
  private releasePendingCompletion(messageId: string): void {
    if (!this.pendingCompletions.delete(messageId)) return;
    try {
      this.persistPendingCompletions();
    } catch {
      // Best-effort on compensation: the stale row expires with its TTL.
    }
  }

  /**
   * DURABLY transition the grant to state=delivered once its completion was
   * delivered/admitted. The row is KEPT until its original TTL expires and
   * becomes a terminal tombstone — a source daemon restart before the target
   * finishes retrying therefore still answers replays with deduplicated
   * instead of DELIVERY_DENIED. Persistence failure here cannot undo the
   * already-performed admission, so it degrades to RAM-only protection with a
   * loud error (the caller boundary logs it).
   */
  private markGrantDelivered(messageId: string): void {
    const grant = this.pendingCompletions.get(messageId);
    if (!grant || grant.state === "delivered") return;
    grant.state = "delivered";
    try {
      this.persistPendingCompletions();
    } catch (error) {
      // FAIL-CLOSED: a terminal transition that is not durable must never be
      // announced as {ok:true}. Roll the RAM state back and rethrow — callers
      // that owe a remote announcement surface a RETRYABLE failure (the Hub
      // keeps its grant, the target's durable outbox retries), and callers
      // without a remote announcement let the error reach their logger.
      grant.state = "pending";
      this.deps.logger?.error(
        "agent_messaging.grant_delivered_persist_failed",
        "failed to persist delivered completion state",
        { requestMessageId: messageId, error: String(error) },
      );
      throw error;
    }
  }

  private static readonly DEFINITE_NOT_SENT_CODES: ReadonlySet<string> = new Set([
    "ROUTE_UNAVAILABLE",
    "TARGET_NODE_OFFLINE",
    "TARGET_NOT_FOUND",
    "TARGET_NOT_REACHABLE",
    "TARGET_NOT_RUNNING",
    "TARGET_AMBIGUOUS",
    "TARGET_UNAVAILABLE",
    "DELIVERY_DENIED",
    "CONVERSATION_LIMIT_REACHED",
    "DUPLICATE_MESSAGE",
    "MESSAGE_RATE_LIMITED",
    "MESSAGE_QUEUE_FULL",
    "TARGET_NOT_STEERABLE",
    "TARGET_NOT_INTERRUPTIBLE",
    "MESSAGE_TOO_LARGE",
  ]);

  /**
   * Write-through persistence for pending grants. The grant is an OUTWARD
   * contract ("xacpx will return the peer's result when it completes") — a
   * daemon restart between request and completion must not turn every future
   * legitimate completion into DELIVERY_DENIED. Only small authorization
   * metadata is persisted, never result bodies.
   */
  /**
   * Throws on storage failure. Callers reserve-time MUST let the error
   * propagate (fail closed — nothing is sent); compensation paths
   * (release/retire) catch it themselves since a stale persisted row expires
   * with its TTL anyway.
   */
  private persistPendingCompletions(): void {
    this.deps.pendingCompletionStore?.save(
      [...this.pendingCompletions].map(([requestMessageId, grant]) => ({
        requestMessageId,
        source: grant.source,
        target: grant.target,
        mode: grant.mode,
        expiresAt: grant.expiresAt,
        state: grant.state,
      })),
    );
  }

  /**
   * Trust-boundary check for inbound completions: a completion is only accepted
   * when an unexpired grant exists for this exact requestMessageId with
   * matching source AND target addresses, and the payload does not upgrade a
   * notify grant into a result-bearing completion.
   */
  private checkPendingCompletion(input: {
    requestMessageId: string;
    source: AgentAddress;
    target: AgentAddress;
    result?: string;
  }): AgentMessagingError | undefined {
    const grant = this.pendingCompletions.get(input.requestMessageId);
    const now = (this.deps.now ?? Date.now)();
    if (!grant || grant.expiresAt <= now) {
      if (grant) this.pendingCompletions.delete(input.requestMessageId);
      return new AgentMessagingError(
        "DELIVERY_DENIED",
        "No pending completion grant exists for this request message id.",
      );
    }
    if (
      !sameAddress(grant.source, input.source) ||
      !sameAddress(grant.target, input.target)
    ) {
      return new AgentMessagingError(
        "DELIVERY_DENIED",
        "Completion source/target do not match the original request.",
      );
    }
    if (grant.mode === "notify" && input.result !== undefined) {
      return new AgentMessagingError(
        "DELIVERY_DENIED",
        "A notify-mode completion must not carry a result body.",
      );
    }
    return undefined;
  }


  constructor(
    private readonly deps: {
      registry: Pick<
        AgentEndpointRegistry,
        | "listReachable"
        | "resolveSender"
        | "resolveTarget"
        | "resolveSelector"
        | "resolveLocalTargetByEndpointId"
      > & {
        resolveTargetByHandle?: (handle: string) => Promise<AgentEndpointView | null>;
        findLocalSessionByEndpointId?: (
          endpointId: string,
        ) => Promise<{ alias: string; archived: boolean; isLogical: boolean } | null>;
      };
      delivery: LocalAgentMessageDelivery;
      remoteRoute?: RelayAgentMessageRoute;
      createId?: () => string;
      now?: () => number;
      limits?: AgentMessageRouterLimits;
      logger?: Pick<AppLogger, "info" | "error">;
      events?: ControlEventBus;
      pendingCompletionStore?: {
        load(): Array<{
          requestMessageId: string;
          source: AgentAddress;
          target: AgentAddress;
          mode: "notify" | "result";
          expiresAt: number;
          state?: "pending" | "delivered";
        }>;
        save(
          grants: Array<{
            requestMessageId: string;
            source: AgentAddress;
            target: AgentAddress;
            mode: "notify" | "result";
            expiresAt: number;
            state: "pending" | "delivered";
          }>,
        ): void;
      };
      /** Durable terminal-completion outbox (v0.3): entries survive daemon
       *  restarts so an accepted completion contract whose delivery was
       *  interrupted (Relay offline, source busy) is still fulfilled after
       *  the restart. Carries the bounded completion payload by necessity —
       *  it IS the undeliverable-yet message. */
      completionOutboxStore?: {
        load(): Array<{
          key: string;
          kind: "local" | "remote";
          requestMessageId: string;
          senderSessionAlias?: string;
          completion: AgentMessageCompletion;
          expiresAt: number;
        }>;
        upsert(entry: {
          key: string;
          kind: "local" | "remote";
          requestMessageId: string;
          senderSessionAlias?: string;
          completion: AgentMessageCompletion;
          expiresAt: number;
        }): void;
        delete(key: string): void;
      };
    },
  ) {
    // Hydrate persisted pending-completion grants. Expired entries are dropped;
    // survivors keep this daemon's outward completion contracts enforceable
    // across restarts.
    const now = (this.deps.now ?? Date.now)();
    try {
      for (const grant of this.deps.pendingCompletionStore?.load() ?? []) {
        if (grant.expiresAt <= now) continue;
        this.pendingCompletions.set(grant.requestMessageId, {
          source: grant.source,
          target: grant.target,
          mode: grant.mode,
          expiresAt: grant.expiresAt,
          state: grant.state ?? "pending",
        });
      }
    } catch {
      // Fail-closed: an unloadable store starts empty (completions for
      // pre-restart requests will be denied rather than mis-attributed).
    }
    // Hydrate the durable terminal-completion outbox: entries whose delivery
    // was interrupted by a restart are re-armed with reconstructed attempt
    // closures and swept like live ones.
    try {
      const now2 = (this.deps.now ?? Date.now)();
      for (const entry of this.deps.completionOutboxStore?.load() ?? []) {
        if (entry.expiresAt <= now2) {
          this.deps.completionOutboxStore?.delete(entry.key);
          continue;
        }
        const attempt =
          entry.kind === "local" && entry.senderSessionAlias
            ? async () =>
                await this.attemptCompletionAdmission(
                  entry.requestMessageId,
                  entry.senderSessionAlias!,
                  entry.completion,
                )
            : async () => {
                if (
                  !this.deps.remoteRoute ||
                  !this.deps.remoteRoute.isAvailable()
                ) {
                  return false;
                }
                const res = await this.deps.remoteRoute.sendCompletion({
                  requestMessageId: entry.completion.requestMessageId,
                  source: entry.completion.to,
                  target: entry.completion.from,
                  status: entry.completion.status,
                  ...(entry.completion.result !== undefined
                    ? { result: entry.completion.result }
                    : {}),
                  ...(entry.completion.error !== undefined
                    ? { error: entry.completion.error }
                    : {}),
                  completedAt: entry.completion.completedAt,
                });
                if (res.ok === true) {
                  this.markGrantDelivered(entry.requestMessageId);
                  return true;
                }
                return false;
              };
        this.deliveryPending.set(entry.key, {
          attempt,
          nextAttemptAt: now2 + AgentMessageRouter.COMPLETION_RETRY_SWEEP_MS,
          expiresAt: entry.expiresAt,
        });
      }
      if (this.deliveryPending.size > 0) this.armDeliveryRetryTimer();
    } catch {
      // An unloadable outbox starts empty; source-side grants remain durable
      // so targets keep retrying into this daemon.
    }
  }

  async listReachable(
    binding: AgentSenderBinding,
  ): Promise<AgentEndpointView[]> {
    return await this.deps.registry.listReachable(binding);
  }
  getTraceRecords(limit = 256): AgentMessageTraceRecord[] {
    return this.traceRingBuffer.slice(-Math.max(1, limit));
  }

  private emitOutboundEvent(
    senderSessionAlias: string,
    message: AgentMessage,
    target: ResolvedAgentEndpoint,
    receipt: AgentMessageReceipt,
  ): void {
    const peer: PeerMessagePeer = {
      handle: target.endpoint.handle,
      displayName: target.endpoint.displayName ?? target.endpoint.agent,
      agent: target.endpoint.agent,
      ...(target.endpoint.workspace ? { workspace: target.endpoint.workspace } : {}),
    };
    const entry: PeerMessageHistoryEntry = {
      kind: "agent_message",
      direction: "sent",
      messageId: message.id,
      conversationId: message.conversationId,
      ...(message.replyTo ? { replyTo: message.replyTo } : {}),
      peer,
      content: message.content,
      createdAt: message.createdAt,
      status: receipt.status === "failed" ? "failed" : "sent",
      completion: message.completion,
      completionStatus:
        message.completion && message.completion !== "none"
          ? receipt.status === "failed"
            ? "failed"
            : "pending"
          : undefined,
    };
    this.deps.events?.emit({
      type: "agent-message",
      sessionAlias: toDisplaySessionAlias(senderSessionAlias),
      message: entry,
    });
    if (message.completion !== "none") {
      this.outboundMessages.set(message.id, {
        senderSessionAlias,
        message,
        targetPeer: peer,
      });
      if (this.outboundMessages.size > 1000) {
        const oldestKey = this.outboundMessages.keys().next().value;
        if (oldestKey) this.outboundMessages.delete(oldestKey);
      }
    }
  }
  private emitInboundEvent(
    targetSessionAlias: string,
    message: AgentMessage,
    sender: ResolvedAgentIdentity,
  ): void {
    const peer: PeerMessagePeer = {
      handle: encodeAgentHandle(sender.address),
      displayName: sender.displayName ?? sender.agent ?? sender.address.endpointId,
      agent: sender.agent ?? "agent",
      ...(sender.workspace ? { workspace: sender.workspace } : {}),
    };
    const entry: PeerMessageHistoryEntry = {
      kind: "agent_message",
      direction: "received",
      messageId: message.id,
      conversationId: message.conversationId,
      ...(message.replyTo ? { replyTo: message.replyTo } : {}),
      peer,
      content: message.content,
      createdAt: message.createdAt,
      status: "delivered",
      completion: message.completion,
    };
    this.deps.events?.emit({
      type: "agent-message",
      sessionAlias: toDisplaySessionAlias(targetSessionAlias),
      message: entry,
    });
  }

  async send(
    binding: AgentSenderBinding,
    input: AgentMessageSendInput,
  ): Promise<AgentMessageReceipt> {
    const maxMessageBytes = this.deps.limits?.maxMessageBytes ?? 16 * 1024;
    if (Buffer.byteLength(input.content, "utf8") > maxMessageBytes) {
      throw new AgentMessagingError(
        "MESSAGE_TOO_LARGE",
        `Peer messages must not exceed ${maxMessageBytes} UTF-8 bytes.`,
      );
    }
    const completion = input.completion ?? "none";
    const maxReplyToBytes = this.deps.limits?.maxReplyToBytes ?? 128;
    if (
      input.replyTo !== undefined &&
      Buffer.byteLength(input.replyTo, "utf8") > maxReplyToBytes
    ) {
      throw new AgentMessagingError(
        "MESSAGE_TOO_LARGE",
        `Reply correlation ids must not exceed ${maxReplyToBytes} UTF-8 bytes.`,
      );
    }
    if (
      input.replyTo !== undefined &&
      !/^[A-Za-z0-9_-]+$/.test(input.replyTo)
    ) {
      throw new AgentMessagingError(
        "DELIVERY_DENIED",
        "The reply correlation id is not a valid opaque message id.",
      );
    }
    const hasTo = typeof input.to === "string" && input.to.trim().length > 0;
    const hasSelector = input.selector !== undefined && input.selector !== null;
    if ((hasTo && hasSelector) || (!hasTo && !hasSelector)) {
      throw new AgentMessagingError(
        "DELIVERY_FAILED",
        "Must provide either 'to' handle or 'selector', not both or neither.",
      );
    }
    const sender = await this.deps.registry.resolveSender(binding);
    const target = input.selector
      ? await this.deps.registry.resolveSelector(sender, input.selector)
      : await this.deps.registry.resolveTarget(sender, input.to!);

    if (completion !== "none") {
      // v0.3 fail-closed scope: completion signals ride the canonical
      // TurnQueue/SessionTurnRunner path, which only logical sessions have on
      // both ends. Worker runtimes inject via transport.injectMessage (no
      // correlated terminal event) and worker/external senders have no logical
      // lane to receive the completion turn in.
      const senderIsLogical = sender.senderKind === "logical";
      const targetSupportsCompletion =
        target.endpoint.capabilities.completion === true;
      if (!senderIsLogical || !targetSupportsCompletion) {
        throw new AgentMessagingError(
          "COMPLETION_NOT_SUPPORTED",
          `Completion mode '${completion}' requires a logical-session sender and a logical-session target.`,
        );
      }
    }
    return await this.enqueueTarget(target.endpoint.handle, async () => {
      const requestedMode = input.requestedMode ?? input.mode ?? "auto";
      if (requestedMode === "steer" && !target.endpoint.capabilities.steer) {
        throw new AgentMessagingError(
          "TARGET_NOT_STEERABLE",
          "The target does not support same-turn steering.",
        );
      }
      if (
        requestedMode === "interrupt" &&
        !target.endpoint.capabilities.interrupt
      ) {
        throw new AgentMessagingError(
          "TARGET_NOT_INTERRUPTIBLE",
          "The target does not support explicit interrupt delivery.",
        );
      }
      const createdAt = (this.deps.now ?? Date.now)();
      const messageId = "msg_" + (this.deps.createId ?? randomUUID)();

      // Conversation threading & fail-closed resolution
      let conversationId = messageId;
      let depth = 0;
      if (input.replyTo !== undefined) {
        if (target.endpoint.capabilities.conversation === false) {
          throw new AgentMessagingError(
            "REPLY_NOT_SUPPORTED",
            "The target endpoint does not support conversation reply threading.",
          );
        }
        const parentContext = this.getMessageContext(input.replyTo, createdAt);
        if (!parentContext) {
          throw new AgentMessagingError(
            "REPLY_CONTEXT_UNAVAILABLE",
            "The reply correlation id is unknown, expired, or was lost due to daemon restart. Please start a new root message.",
          );
        }
        if (
          !sameAddress(sender.address, parentContext.to) ||
          !sameAddress(target.endpoint.address, parentContext.from)
        ) {
          throw new AgentMessagingError(
            "REPLY_TARGET_MISMATCH",
            "A reply must be sent back to the peer that sent the parent message.",
          );
        }
        conversationId = parentContext.conversationId;
        depth = parentContext.depth + 1;
      }

      // Outbound collaboration guards: depth, volume, duplicate content, rate limit
      const maxDepth = this.deps.limits?.maxConversationDepth ?? 6;
      if (depth > maxDepth) {
        throw new AgentMessagingError(
          "CONVERSATION_LIMIT_REACHED",
          `Conversation thread depth exceeded maximum limit of ${maxDepth}.`,
        );
      }
      const maxMessagesInConv =
        this.deps.limits?.maxMessagesPerConversation ?? 12;
      const currentConvCount =
        this.conversationMessageCounts.get(conversationId) ?? 0;
      if (currentConvCount >= maxMessagesInConv) {
        throw new AgentMessagingError(
          "CONVERSATION_LIMIT_REACHED",
          `Conversation total message volume exceeded maximum limit of ${maxMessagesInConv}.`,
        );
      }

      const cached = this.getCachedReceipt(messageId, createdAt);
      if (cached) {
        const receipt = { ...cached, deduplicated: true };
        const message: AgentMessage = {
          id: messageId,
          conversationId,
          depth,
          from: sender.address,
          to: target.endpoint.address,
          content: input.content,
          requestedMode,
          completion,
          createdAt,
          ...(input.replyTo ? { replyTo: input.replyTo } : {}),
        };
        this.logDelivery(message, receipt, createdAt);
        return receipt;
      }

      const contentHash = createHash("sha256")
        .update(input.content.trim())
        .digest("hex");
      const pairKey =
        addressKey(sender.address) + "->" + addressKey(target.endpoint.address);
      this.checkDuplicateContent(pairKey, contentHash, createdAt);
      this.enforceRateLimit(pairKey, createdAt);

      const message: AgentMessage = {
        id: messageId,
        conversationId,
        depth,
        from: sender.address,
        to: target.endpoint.address,
        content: input.content,
        requestedMode,
        completion,
        createdAt,
        ...(input.replyTo ? { replyTo: input.replyTo } : {}),
      };

      // v0.3: durable-reserve the completion contract BEFORE dispatch. A
      // persistence failure throws here → the request fails closed and nothing
      // is sent; capacity exhaustion likewise refuses the NEW request rather
      // than evicting an older still-executing contract.
      if (completion !== "none") {
        this.reservePendingCompletion(
          message.id,
          sender.address,
          target.endpoint.address,
          completion,
          createdAt,
        );
      }

      if (target.endpoint.address.nodeId !== sender.address.nodeId) {
        if (!this.deps.remoteRoute || !this.deps.remoteRoute.isAvailable()) {
          const err = new AgentMessagingError(
            "ROUTE_UNAVAILABLE",
            `Remote route is unavailable for destination node ${target.endpoint.address.nodeId}.`,
          );
          if (completion !== "none") this.releasePendingCompletion(message.id);
          this.logDelivery(message, undefined, createdAt, err.code);
          this.recordTrace({
            messageId,
            conversationId,
            depth,
            replyTo: input.replyTo,
            from: sender.address,
            to: target.endpoint.address,
            route: "relay",
            createdAt,
            status: "failed",
            errorCode: err.code,
            contentLength: Buffer.byteLength(input.content, "utf8"),
            contentHash,
          });
          throw err;
        }
        let remoteReceipt: AgentMessageReceipt;
        try {
          remoteReceipt = await this.deps.remoteRoute.send(message);
        } catch (error) {
          const mapped = mapDeliveryError(error);
          // Definite pre-admission rejections release the reservation;
          // ambiguous outcomes (timeout/race/unknown) retain it — the target
          // may have accepted and the completion must still be honored.
          if (
            completion !== "none" &&
            AgentMessageRouter.DEFINITE_NOT_SENT_CODES.has(mapped.code)
          ) {
            this.releasePendingCompletion(message.id);
          }
          this.logDelivery(message, undefined, createdAt, mapped.code);
          this.recordTrace({
            messageId,
            conversationId,
            depth,
            replyTo: input.replyTo,
            from: sender.address,
            to: target.endpoint.address,
            route: "relay",
            createdAt,
            status: "failed",
            errorCode: mapped.code,
            contentLength: Buffer.byteLength(input.content, "utf8"),
            contentHash,
          });
          const senderSessionAlias =
            sender.sessionAlias ??
            sender.coordinatorSession ??
            binding.coordinatorSession;
          this.emitOutboundEvent(senderSessionAlias, message, target, {
            messageId: message.id,
            status: "failed",
            route: "relay",
          });
          throw mapped;
        }
        if (completion !== "none" && remoteReceipt.status === "failed") {
          this.releasePendingCompletion(message.id);
        }
        this.cacheReceipt(remoteReceipt, createdAt);
        this.conversationMessageCounts.set(
          conversationId,
          currentConvCount + 1,
        );
        this.recordMessageContext({
          messageId,
          conversationId,
          depth,
          from: sender.address,
          to: target.endpoint.address,
          createdAt,
          expiresAt:
            createdAt + (this.deps.limits?.contextCache?.ttlMs ?? 60 * 60_000),
        });
        this.recordDuplicateContent(pairKey, contentHash, createdAt);
        this.recordTrace({
          messageId,
          conversationId,
          depth,
          replyTo: input.replyTo,
          from: sender.address,
          to: target.endpoint.address,
          route: "relay",
          createdAt,
          deliveredAt: (this.deps.now ?? Date.now)(),
          status: remoteReceipt.status,
          modeUsed: remoteReceipt.modeUsed,
          deduplicated: remoteReceipt.deduplicated,
          contentLength: Buffer.byteLength(input.content, "utf8"),
          contentHash,
        });
        this.logDelivery(message, remoteReceipt, createdAt);
        const senderSessionAlias = sender.sessionAlias ?? sender.coordinatorSession ?? binding.coordinatorSession;
        this.emitOutboundEvent(senderSessionAlias, message, target, remoteReceipt);
        return remoteReceipt;
      }

      const renderedText = renderAgentMessageEnvelope({
        id: message.id,
        conversationId: message.conversationId,
        from: encodeAgentHandle(sender.address),
        replyable: sender.receive && target.endpoint.capabilities.receive,
        ...(message.replyTo ? { replyTo: message.replyTo } : {}),
        content: message.content,
      });
      let result: SessionMessageReceipt;
      try {
        result = await this.deps.delivery.deliver(
          target,
          message,
          renderedText,
        );
      } catch (error) {
        const mapped = mapDeliveryError(error);
        // Local admission is synchronous: a throw means the target never
        // accepted → release the reservation.
        if (completion !== "none") this.releasePendingCompletion(message.id);
        this.logDelivery(message, undefined, createdAt, mapped.code);
        this.recordTrace({
          messageId,
          conversationId,
          depth,
          replyTo: input.replyTo,
          from: sender.address,
          to: target.endpoint.address,
          route: "local",
          createdAt,
          status: "failed",
          errorCode: mapped.code,
          contentLength: Buffer.byteLength(input.content, "utf8"),
          contentHash,
        });
        const senderSessionAlias =
          sender.sessionAlias ??
          sender.coordinatorSession ??
          binding.coordinatorSession;
        this.emitOutboundEvent(senderSessionAlias, message, target, {
          messageId: message.id,
          status: "failed",
          route: "local",
        });
        throw mapped;
      }
      const receipt: AgentMessageReceipt = {
        messageId: message.id,
        status: result.status,
        modeUsed: result.modeUsed,
        route: "local",
        ...(result.targetState ? { targetState: result.targetState } : {}),
      };
      this.cacheReceipt(receipt, createdAt);
      this.conversationMessageCounts.set(conversationId, currentConvCount + 1);
      this.recordMessageContext({
        messageId,
        conversationId,
        depth,
        from: sender.address,
        to: target.endpoint.address,
        createdAt,
        expiresAt:
          createdAt + (this.deps.limits?.contextCache?.ttlMs ?? 60 * 60_000),
      });
      this.recordDuplicateContent(pairKey, contentHash, createdAt);
      this.recordTrace({
        messageId,
        conversationId,
        depth,
        replyTo: input.replyTo,
        from: sender.address,
        to: target.endpoint.address,
        route: "local",
        createdAt,
        deliveredAt: (this.deps.now ?? Date.now)(),
        status: receipt.status,
        modeUsed: receipt.modeUsed,
        deduplicated: receipt.deduplicated,
        contentLength: Buffer.byteLength(input.content, "utf8"),
        contentHash,
      });
      this.logDelivery(message, receipt, createdAt);
      const senderSessionAlias = sender.sessionAlias ?? sender.coordinatorSession ?? binding.coordinatorSession;
      this.emitOutboundEvent(senderSessionAlias, message, target, receipt);
      if (target.runtime.kind === "logical") {
        this.emitInboundEvent(target.runtime.alias, message, sender);
      } else if (target.runtime.kind === "worker") {
        this.emitInboundEvent(target.runtime.workerSession, message, sender);
      }
      return receipt;
    });
  }

  /**
   * TARGET-side terminal-outbox admission reservation (v0.3 round-6): a
   * completion-bearing request accepted by THIS daemon creates an obligation
   * to later deliver one bounded completion. Capacity is reserved HERE — at
   * acceptance time — instead of being inferred from each source's budget,
   * so a saturated outbox refuses NEW requests (MESSAGE_QUEUE_FULL) rather
   * than stranding finished work. The reservation is the deliveryPending
   * budget itself; expired entries are pruned before the check.
   */
  ensureTerminalOutboxCapacity(): void {
    for (const [key, task] of [...this.deliveryPending]) {
      if (task.expiresAt <= (this.deps.now ?? Date.now)()) {
        this.deliveryPending.delete(key);
        this.deps.completionOutboxStore?.delete(key);
      }
    }
    const cap =
      this.deps.limits?.pendingCompletion?.maxEntries ?? 1_000;
    if (this.deliveryPending.size >= cap) {
      throw new AgentMessagingError(
        "MESSAGE_QUEUE_FULL",
        "Terminal completion outbox at capacity; existing obligations are never evicted.",
      );
    }
  }

  async deliverInbound(input: {
    sourceNodeId: string;
    sourceEndpointId: string;
    targetEndpointId: string;
    messageId: string;
    conversationId?: string;
    depth?: number;
    content: string;
    requestedMode: string;
    replyTo?: string;
    replyable: boolean;
    completion?: AgentMessageCompletionMode;
  }): Promise<AgentMessageReceipt> {
    const createdAt = (this.deps.now ?? Date.now)();
    const fingerprint = inboundFingerprint(input);

    // 1. IDEMPOTENCY FIRST: Terminal outcome cache
    const cached = this.inboundOutcomes.get(input.messageId);
    if (cached) {
      if (cached.fingerprint !== fingerprint) {
        throw new AgentMessagingError(
          "DELIVERY_DENIED",
          "A delivery for this messageId already completed with a different source, target, or content.",
        );
      }
      if ("error" in cached.outcome) {
        throw cached.outcome.error;
      }
      return { ...cached.outcome.receipt, deduplicated: true };
    }

    // 2. In-flight single-flight: a retry arriving while the first delivery is
    //    still executing joins its promise and never calls the delivery adapter
    //    again.
    const existing = this.inboundDeliveries.get(input.messageId);
    if (existing) {
      if (existing.fingerprint !== fingerprint) {
        throw new AgentMessagingError(
          "DELIVERY_DENIED",
          "A delivery for this messageId is already in flight with a different source, target, or content.",
        );
      }
      const receipt = await existing.work;
      return { ...receipt, deduplicated: true };
    }

    // 3. New delivery: record the terminal outcome (receipt OR failure
    //    tombstone) before releasing the in-flight slot, so there is never a
    //    window where a same-id retry can slip past both caches.
    const work = this.performInboundDelivery(input, createdAt);
    this.inboundDeliveries.set(input.messageId, { work, fingerprint });

    try {
      const receipt = await work;
      this.recordInboundOutcome(input.messageId, fingerprint, { receipt });
      return receipt;
    } catch (error) {
      if (error instanceof AgentMessagingError) {
        this.recordInboundOutcome(input.messageId, fingerprint, { error });
      }
      throw error;
    } finally {
      if (this.inboundDeliveries.get(input.messageId)?.work === work) {
        this.inboundDeliveries.delete(input.messageId);
      }
    }
  }

  private async performInboundDelivery(
    input: {
      sourceNodeId: string;
      sourceEndpointId: string;
      targetEndpointId: string;
      messageId: string;
      conversationId?: string;
      depth?: number;
      content: string;
      requestedMode: string;
      replyTo?: string;
      replyable: boolean;
      completion?: AgentMessageCompletionMode;
    },
    createdAt: number,
  ): Promise<AgentMessageReceipt> {
    const target = await this.deps.registry.resolveLocalTargetByEndpointId(
      input.targetEndpointId,
    );
    const conversationId = input.conversationId ?? input.messageId;
    const depth = input.depth ?? (input.replyTo ? 1 : 0);
    const message: AgentMessage = {
      id: input.messageId,
      conversationId,
      depth,
      from: { nodeId: input.sourceNodeId, endpointId: input.sourceEndpointId },
      to: target.endpoint.address,
      content: input.content,
      requestedMode: (input.requestedMode as AgentMessageMode) ?? "auto",
      completion: input.completion ?? "none",
      createdAt,
      ...(input.replyTo ? { replyTo: input.replyTo } : {}),
    };

    // TARGET-side outbox reservation: a completion-bearing request accepted by
    // this daemon owes exactly one future terminal delivery. Capacity is
    // checked HERE (acceptance time) so saturation refuses the request
    // instead of stranding finished work later.
    if (message.completion !== "none") {
      this.ensureTerminalOutboxCapacity();
    }

    const fromHandle = encodeAgentHandle({
      nodeId: input.sourceNodeId,
      endpointId: input.sourceEndpointId,
    });
    const renderedText = renderAgentMessageEnvelope({
      id: message.id,
      conversationId: message.conversationId,
      from: fromHandle,
      replyable: input.replyable && target.endpoint.capabilities.receive,
      ...(message.replyTo ? { replyTo: message.replyTo } : {}),
      content: message.content,
    });

    const contentHash = createHash("sha256")
      .update(input.content.trim())
      .digest("hex");
    let result: SessionMessageReceipt;
    try {
      result = await this.deps.delivery.deliver(target, message, renderedText);
    } catch (error) {
      const mapped = mapDeliveryError(error);
      this.logDelivery(message, undefined, createdAt, mapped.code);
      this.recordTrace({
        messageId: message.id,
        conversationId: message.conversationId,
        depth: message.depth,
        replyTo: message.replyTo,
        from: message.from,
        to: message.to,
        route: "relay",
        createdAt,
        status: "failed",
        errorCode: mapped.code,
        contentLength: Buffer.byteLength(input.content, "utf8"),
        contentHash,
      });
      throw mapped;
    }

    const receipt: AgentMessageReceipt = {
      messageId: message.id,
      status: result.status,
      modeUsed: result.modeUsed,
      route: "relay",
      ...(result.targetState ? { targetState: result.targetState } : {}),
    };

    // Register inbound message context on destination so subsequent reply works
    const contextTtl = this.deps.limits?.contextCache?.ttlMs ?? 60 * 60_000;
    this.recordMessageContext({
      messageId: message.id,
      conversationId: message.conversationId,
      depth: message.depth,
      from: message.from,
      to: message.to,
      createdAt,
      expiresAt: createdAt + contextTtl,
    });
    const currentConvCount =
      this.conversationMessageCounts.get(conversationId) ?? 0;
    this.conversationMessageCounts.set(conversationId, currentConvCount + 1);

    this.logDelivery(message, receipt, createdAt);
    this.recordTrace({
      messageId: message.id,
      conversationId: message.conversationId,
      depth: message.depth,
      replyTo: message.replyTo,
      from: message.from,
      to: message.to,
      route: "relay",
      createdAt,
      deliveredAt: (this.deps.now ?? Date.now)(),
      status: receipt.status,
      modeUsed: receipt.modeUsed,
      contentLength: Buffer.byteLength(input.content, "utf8"),
      contentHash,
    });
    const targetSessionAlias =
      target.runtime.kind === "logical"
        ? target.runtime.alias
        : target.runtime.kind === "worker"
          ? target.runtime.workerSession
          : target.endpoint.displayName ?? input.targetEndpointId;
    const sourceHandle = encodeAgentHandle({
      nodeId: input.sourceNodeId,
      endpointId: input.sourceEndpointId,
    });
    let sourceEndpoint: AgentEndpointView | null = null;
    try {
      sourceEndpoint = (await this.deps.registry.resolveTargetByHandle?.(sourceHandle)) ?? null;
    } catch {
      sourceEndpoint = null;
    }
    const peer: PeerMessagePeer = {
      handle: sourceHandle,
      displayName: sourceEndpoint?.displayName ?? sourceEndpoint?.agent ?? input.sourceEndpointId,
      agent: sourceEndpoint?.agent ?? "agent",
      ...(sourceEndpoint?.workspace ? { workspace: sourceEndpoint.workspace } : {}),
    };
    const inboundEntry: PeerMessageHistoryEntry = {
      kind: "agent_message",
      direction: "received",
      messageId: message.id,
      conversationId: message.conversationId,
      ...(message.replyTo ? { replyTo: message.replyTo } : {}),
      peer,
      content: message.content,
      createdAt,
      status: "delivered",
      completion: message.completion,
    };
    this.deps.events?.emit({
      type: "agent-message",
      sessionAlias: toDisplaySessionAlias(targetSessionAlias),
      message: inboundEntry,
    });
    return receipt;
  }

  async completePeerTurn(
    origin: PeerTurnOrigin,
    terminal: {
      ok: boolean;
      text?: string;
      errorMessage?: string;
      cancelled?: boolean;
    },
  ): Promise<AgentMessageCompletion | null> {
    if (origin.completion === "none") {
      return null;
    }

    // Target-side terminal idempotency cache (Gate N target half)
    const cachedOutcome = this.completionOutcomes.get(origin.requestMessageId);
    if (cachedOutcome) {
      if (cachedOutcome.expiresAt > (this.deps.now ?? Date.now)()) {
        return cachedOutcome.value;
      }
      this.completionOutcomes.delete(origin.requestMessageId);
    }

    const status: AgentMessageCompletionStatus = terminal.cancelled
      ? "cancelled"
      : !terminal.ok
        ? "failed"
        : "completed";

    const completedAt = (this.deps.now ?? Date.now)();
    const completion: AgentMessageCompletion = {
      requestMessageId: origin.requestMessageId,
      from: origin.target,
      to: origin.source,
      status,
      ...(status === "completed" && origin.completion === "result"
        ? { result: boundPeerResult(terminal.text ?? "") }
        : {}),
      ...(status === "failed"
        ? {
            error: sanitizeCompletionError(
              terminal.errorMessage ?? "Peer turn failed",
            ),
          }
        : {}),
      completedAt,
    };

    while (this.completionOutcomes.size >= (this.deps.limits?.completionCache?.maxEntries ?? 2_000)) {
      const oldest = this.completionOutcomes.keys().next().value;
      if (oldest === undefined) break;
      this.completionOutcomes.delete(oldest);
    }
    this.completionOutcomes.set(origin.requestMessageId, {
      value: completion,
      expiresAt:
        completedAt +
        (this.deps.limits?.completionCache?.ttlMs ?? 24 * 60 * 60_000),
    });

    // Resolve the sender session alias (for the status patch event + local
    // injection). Cache first, then authoritative registry lookup.
    const cachedOutbound = this.outboundMessages.get(origin.requestMessageId);
    let senderSessionAlias = cachedOutbound?.senderSessionAlias;
    let sourceIsArchived = false;
    if (!senderSessionAlias && this.deps.registry.findLocalSessionByEndpointId) {
      try {
        const sourceSession =
          await this.deps.registry.findLocalSessionByEndpointId(
            origin.source.endpointId,
          );
        if (sourceSession) {
          senderSessionAlias = sourceSession.alias;
          sourceIsArchived = sourceSession.archived;
        }
      } catch {
        // ignore lookup error
      }
    }

    // Patch the persisted sender card's completion status (v0.3: patch event,
    // never a fabricated full entry — the durable row belongs to the original send).
    if (senderSessionAlias) {
      this.deps.events?.emit({
        type: "agent-message-completion",
        sessionAlias: toDisplaySessionAlias(senderSessionAlias),
        messageId: origin.requestMessageId,
        completionStatus: status,
      });
    }

    // Reverse route choice
    const isLocalSource = origin.source.nodeId === origin.target.nodeId;
    if (!isLocalSource) {
      if (this.deps.remoteRoute && this.deps.remoteRoute.isAvailable()) {
        try {
          const fwdRes = await this.deps.remoteRoute.sendCompletion({
            requestMessageId: origin.requestMessageId,
            source: origin.source,
            target: origin.target,
            status,
            ...(completion.result !== undefined ? { result: completion.result } : {}),
            ...(completion.error !== undefined ? { error: completion.error } : {}),
            completedAt,
          });
          if (fwdRes.ok === true) {
            // Delivered to the source daemon → retire the reservation; the
            // terminal tombstone absorbs late duplicates.
            this.markGrantDelivered(origin.requestMessageId);
            return completion;
          }
          // Source explicitly reported NOT delivered (e.g. its queue was full).
          // The durable Hub route grant is still live — retain ours and retry.
          this.scheduleCompletionDelivery(
            `remote:${origin.requestMessageId}`,
            async () => {
              if (!this.deps.remoteRoute || !this.deps.remoteRoute.isAvailable()) {
                return false;
              }
              const retryRes = await this.deps.remoteRoute.sendCompletion({
                requestMessageId: origin.requestMessageId,
                source: origin.source,
                target: origin.target,
                status,
                ...(completion.result !== undefined ? { result: completion.result } : {}),
                ...(completion.error !== undefined ? { error: completion.error } : {}),
                completedAt,
              });
              if (retryRes.ok === true) {
                this.markGrantDelivered(origin.requestMessageId);
                return true;
              }
              return false;
            },
            completedAt,
            {
              kind: "remote",
              requestMessageId: origin.requestMessageId,
              completion,
            },
          );
          return completion;
        } catch (error) {
          void this.deps.logger
            ?.info(
              "agent_messaging.remote_completion_retry_scheduled",
              "Remote peer-completion delivery failed; scheduled for reconnect retry.",
              {
                requestMessageId: origin.requestMessageId,
                error: error instanceof Error ? error.message : String(error),
              },
            )
            ?.catch?.(() => undefined);
        }
      } else {
        void this.deps.logger
          ?.info(
            "agent_messaging.remote_completion_retry_scheduled",
            "Remote route unavailable; peer completion scheduled for reconnect retry.",
            { requestMessageId: origin.requestMessageId },
          )
          ?.catch?.(() => undefined);
      }
      // Terminal outcome is recorded, but DELIVERY is still pending: retry until
      // the route comes back or the grant TTL expires. Never silently dropped.
      this.scheduleCompletionDelivery(
        `remote:${origin.requestMessageId}`,
        async () => {
          if (!this.deps.remoteRoute || !this.deps.remoteRoute.isAvailable()) {
            return false;
          }
          await this.deps.remoteRoute.sendCompletion({
            requestMessageId: origin.requestMessageId,
            source: origin.source,
            target: origin.target,
            status,
            ...(completion.result !== undefined ? { result: completion.result } : {}),
            ...(completion.error !== undefined ? { error: completion.error } : {}),
            completedAt,
          });
          this.markGrantDelivered(origin.requestMessageId);
          return true;
        },
        completedAt,
        {
          kind: "remote",
          requestMessageId: origin.requestMessageId,
          completion,
        },
      );
      return completion;
    }

    // Local source delivery
    // Idempotency gate on source injection (Gate N source half)
    const localTombstone = this.completionInjections.get(origin.requestMessageId);
    if (localTombstone) {
      if (localTombstone.expiresAt > (this.deps.now ?? Date.now)()) {
        return completion;
      }
      this.completionInjections.delete(origin.requestMessageId);
    }

    // If source session is missing or archived: do NOT wake (allowRestoreArchived
    // semantics, Gate M). The status patch above is the durable record. No turn.
    if (sourceIsArchived || !senderSessionAlias) {
      return completion;
    }

    // Admission-aware injection: the dedupe tombstone is written ONLY after the
    // source TurnQueue actually admitted the turn (injected | queued). A
    // queue-full rejection or transport throw schedules a retry instead of
    // permanently dropping the result.
    const admitted = await this.attemptCompletionAdmission(
      origin.requestMessageId,
      senderSessionAlias,
      completion,
    );
    if (!admitted) {
      this.scheduleCompletionDelivery(
        `local:${origin.requestMessageId}`,
        async () =>
          await this.attemptCompletionAdmission(
            origin.requestMessageId,
            senderSessionAlias!,
            completion,
          ),
        completedAt,
        {
          kind: "local",
          requestMessageId: origin.requestMessageId,
          senderSessionAlias,
          completion,
        },
      );
    }
    return completion;
  }

  async deliverInboundCompletion(input: {
    requestMessageId: string;
    source: AgentAddress;
    target: AgentAddress;
    status: AgentMessageCompletionStatus;
    result?: string;
    error?: string;
    completedAt: number;
  }): Promise<{ ok: boolean; deduplicated?: boolean; error?: string }> {
    // 1. Idempotency gate on source injection (Gate N source half) runs BEFORE
    // the grant check on purpose: once the contract is fulfilled and retired, a
    // late at-least-once duplicate must still be absorbed by the terminal
    // tombstone instead of surfacing as DELIVERY_DENIED retry noise.
    const tombstone = this.completionInjections.get(input.requestMessageId);
    if (tombstone) {
      if (tombstone.expiresAt > (this.deps.now ?? Date.now)()) {
        return { ok: true, deduplicated: true };
      }
      this.completionInjections.delete(input.requestMessageId);
    }

    // 2. Trust boundary (v0.3): an inbound completion is only honored when THIS
    // daemon originally sent a completion-bearing request whose messageId,
    // source and target exactly match. Without this check any same-account
    // instance could forge a "trusted" peer result into another agent's turn
    // lane. completion=none sends never create a grant, so they can never
    // receive completions; notify grants reject result-bearing payloads.
    //
    // Lifecycle-aware dedupe: a DELIVERED grant is a terminal tombstone — an
    // exact-fingerprint replay is absorbed (the source daemon may have
    // restarted since admission, losing its RAM tombstone); a mismatched
    // replay stays denied.
    const deliveredGrant = this.pendingCompletions.get(input.requestMessageId);
    if (
      deliveredGrant?.state === "delivered" &&
      deliveredGrant.expiresAt > (this.deps.now ?? Date.now)()
    ) {
      const sameFingerprint =
        sameAddress(deliveredGrant.source, input.source) &&
        sameAddress(deliveredGrant.target, input.target);
      if (sameFingerprint) {
        return { ok: true, deduplicated: true };
      }
      throw new AgentMessagingError(
        "DELIVERY_DENIED",
        "Completion identities do not match the original request.",
      );
    }
    const grantError = this.checkPendingCompletion(input);
    if (grantError) {
      throw grantError;
    }

    const completion: AgentMessageCompletion = {
      requestMessageId: input.requestMessageId,
      from: input.target,
      to: input.source,
      status: input.status,
      ...(input.result !== undefined
        ? { result: boundPeerResult(input.result) }
        : {}),
      ...(input.error !== undefined
        ? { error: sanitizeCompletionError(input.error) }
        : {}),
      completedAt: input.completedAt,
    };

    // 3. Resolve the sender session alias (patch event + local injection).
    const cachedOutbound = this.outboundMessages.get(input.requestMessageId);
    let senderSessionAlias = cachedOutbound?.senderSessionAlias;
    let sourceIsArchived = false;
    if (this.deps.registry.findLocalSessionByEndpointId) {
      try {
        const sourceSession =
          await this.deps.registry.findLocalSessionByEndpointId(
            input.source.endpointId,
          );
        if (sourceSession) {
          if (!senderSessionAlias) {
            senderSessionAlias = sourceSession.alias;
          }
          sourceIsArchived = sourceSession.archived;
        }
      } catch {
        // ignore lookup error
      }
    }

    // 4. Patch the persisted sender card's completion status. Never fabricate a
    // full PeerMessageHistoryEntry here — after a daemon restart the outbound
    // cache is gone and a rebuilt entry would clobber the durable history row.
    if (senderSessionAlias) {
      this.deps.events?.emit({
        type: "agent-message-completion",
        sessionAlias: toDisplaySessionAlias(senderSessionAlias),
        messageId: input.requestMessageId,
        completionStatus: input.status,
      });
    }

    // 5. Missing or archived source: recorded above, never woken (Gate M).
    // The contract is TERMINAL at this point (status recorded durably via the
    // patch event), so retire the source grant — leaving it pending would let
    // archived-source contracts permanently consume completion capacity. A
    // tombstone is written as well so late at-least-once duplicates are
    // absorbed as deduplicated instead of surfacing as retry noise.
    if (sourceIsArchived || !senderSessionAlias) {
      this.markGrantDelivered(input.requestMessageId);
      while (
        this.completionInjections.size >=
        (this.deps.limits?.completionCache?.maxEntries ?? 2_000)
      ) {
        const oldest = this.completionInjections.keys().next().value;
        if (oldest === undefined) break;
        this.completionInjections.delete(oldest);
      }
      this.completionInjections.set(input.requestMessageId, {
        expiresAt: Math.max(
          this.pendingCompletions.get(input.requestMessageId)?.expiresAt ?? 0,
          input.completedAt +
            (this.deps.limits?.completionCache?.ttlMs ?? 24 * 60 * 60_000),
        ),
      });
      return { ok: true };
    }

    // 6. Admission-aware injection — dedupe tombstone only after real admission;
    // rejections schedule a retry for the LOCAL same-daemon path; a DURABLE
    // terminal-state failure propagates as retryable failure so the Hub keeps
    // its grant and the target's durable outbox retries.
    let admitted: boolean;
    try {
      admitted = await this.attemptCompletionAdmission(
        input.requestMessageId,
        senderSessionAlias,
        completion,
      );
    } catch (error) {
      return {
        ok: false,
        error: `terminal completion state not durable; retry: ${
          error instanceof Error ? error.message : String(error)
        }`,
      };
    }
    if (!admitted) {
      // DURABLE ACK RULE + SINGLE RETRY OWNER (v0.3 round-5 review): a Relay
      // inbound completion has a durable retry chain already — the target's
      // persisted remote outbox plus the Hub's pending route grant. Scheduling
      // a SECOND source-local retry here would create dual ownership whose
      // tombstones diverge after a restart. Returning {ok:false} keeps that
      // durable chain alive: the Hub forwards the failure to the target, which
      // retains its grant and retries. {ok:true} is returned only on real
      // admission.
      return {
        ok: false,
        error: "source session busy; completion delivery pending",
      };
    }

    return { ok: true };
  }

  /**
   * One delivery attempt against the source session's canonical lane. Returns
   * true only when the TurnQueue admitted the completion turn (injected |
   * queued); the dedupe tombstone is written strictly after that point.
   */
  private async attemptCompletionAdmission(
    requestMessageId: string,
    senderSessionAlias: string,
    completion: AgentMessageCompletion,
  ): Promise<boolean> {
    if (!this.deps.delivery.deliverCompletion) {
      return false;
    }
    const result = await this.deps.delivery.deliverCompletion(
      senderSessionAlias,
      completion,
      requestMessageId,
    );
    if (result.status === "rejected") {
      return false;
    }
    // Durable-first: the delivered transition is persisted BEFORE any
    // {ok:true} can escape. A storage failure THROWS so callers fail closed
    // (retryable failure) instead of announcing a terminal ACK whose
    // tombstone would not survive a restart.
    this.markGrantDelivered(requestMessageId);
    // Tombstone must outlive the authorization contract it deduplicates:
    // expiry is anchored to the grant's own expiresAt when one still exists.
    const now = (this.deps.now ?? Date.now)();
    const grantExpiry =
      this.pendingCompletions.get(requestMessageId)?.expiresAt ?? 0;
    const cacheTtl = this.deps.limits?.completionCache?.ttlMs ?? 24 * 60 * 60_000;
    const tombstoneExpiresAt = Math.max(grantExpiry, now + cacheTtl);
    while (
      this.completionInjections.size >=
      (this.deps.limits?.completionCache?.maxEntries ?? 2_000)
    ) {
      const oldest = this.completionInjections.keys().next().value;
      if (oldest === undefined) break;
      this.completionInjections.delete(oldest);
    }
    this.completionInjections.set(requestMessageId, {
      expiresAt: tombstoneExpiresAt,
    });
    return true;
  }
  /** Retry cadence for pending completion deliveries. */
  private static readonly COMPLETION_RETRY_SWEEP_MS = 5_000;
  private static readonly COMPLETION_RETRY_MAX_ENTRIES = 1_000;

  /**
   * Queue a not-yet-admitted completion delivery for bounded retry. Entries
   * expire with the same TTL as pending grants; the map is size-bounded with
   * oldest-first eviction so a long-lived daemon cannot accumulate unbounded
   * state.
   */
  private scheduleCompletionDelivery(
    key: string,
    attempt: () => Promise<boolean>,
    now: number,
    entry?: {
      kind: "local" | "remote";
      requestMessageId: string;
      senderSessionAlias?: string;
      completion: AgentMessageCompletion;
    },
  ): void {
    const ttlMs = this.deps.limits?.pendingCompletion?.ttlMs ?? 24 * 60 * 60_000;
    if (ttlMs <= 0) return;
    // NO EVICTION: entries here are undelivered terminal completions —
    // obligations for work the peer already finished. Dropping the oldest one
    // on capacity pressure would silently lose a result that can never be
    // regenerated (the outcomes cache would just return the cached terminal).
    // Capacity is reserved UP FRONT at request time (see
    // reservePendingCompletion's deliveryPending backpressure), so this map is
    // bounded by construction; expired entries are pruned by the sweep.
    this.deliveryPending.set(key, {
      attempt,
      nextAttemptAt: now + AgentMessageRouter.COMPLETION_RETRY_SWEEP_MS,
      expiresAt: now + ttlMs,
    });
    if (entry) {
      // Persist the obligation so a daemon restart re-arms it. Best-effort:
      // the turn already ran and cannot be re-run — a persistence failure is
      // logged loudly by the caller boundary, and the in-RAM retry still
      // covers this process lifetime.
      try {
        this.deps.completionOutboxStore?.upsert({
          key,
          kind: entry.kind,
          requestMessageId: entry.requestMessageId,
          ...(entry.senderSessionAlias !== undefined
            ? { senderSessionAlias: entry.senderSessionAlias }
            : {}),
          completion: entry.completion,
          expiresAt: now + ttlMs,
        });
      } catch {
        // best-effort — see comment above
      }
    }
    this.armDeliveryRetryTimer();
  }

  private armDeliveryRetryTimer(): void {
    if (this.deliveryRetryTimer) return;
    this.deliveryRetryTimer = setTimeout(() => {
      this.deliveryRetryTimer = undefined;
      void this.sweepPendingCompletionDeliveries();
    }, AgentMessageRouter.COMPLETION_RETRY_SWEEP_MS);
  }

  /**
   * Run one retry pass over pending completion deliveries. Public so tests can
   * drive retries deterministically without waiting on the timer; `force`
   * ignores the per-entry backoff gate (production timer passes false).
   */
  async sweepPendingCompletionDeliveries(force = false): Promise<void> {
    const now = (this.deps.now ?? Date.now)();
    for (const [key, task] of [...this.deliveryPending]) {
      if (task.expiresAt <= now) {
        this.deliveryPending.delete(key);
        this.deps.completionOutboxStore?.delete(key);
        continue;
      }
      if (!force && task.nextAttemptAt > now) continue;
      try {
        const admitted = await task.attempt();
        if (admitted) {
          this.deliveryPending.delete(key);
          this.deps.completionOutboxStore?.delete(key);
        } else {
          task.nextAttemptAt =
            (this.deps.now ?? Date.now)() +
            AgentMessageRouter.COMPLETION_RETRY_SWEEP_MS;
        }
      } catch {
        task.nextAttemptAt =
          (this.deps.now ?? Date.now)() +
          AgentMessageRouter.COMPLETION_RETRY_SWEEP_MS;
      }
    }
    if (this.deliveryPending.size > 0) {
      this.armDeliveryRetryTimer();
    }
  }

  private getCachedReceipt(
    messageId: string,
    now: number,
  ): AgentMessageReceipt | undefined {
    const cached = this.receipts.get(messageId);
    if (!cached) return undefined;
    if (cached.expiresAt <= now) {
      this.receipts.delete(messageId);
      return undefined;
    }
    return cached.receipt;
  }

  private cacheReceipt(receipt: AgentMessageReceipt, now: number): void {
    const configured = this.deps.limits?.receiptCache;
    const maxEntries = configured?.maxEntries ?? 1_024;
    const ttlMs = configured?.ttlMs ?? 5 * 60_000;
    if (maxEntries <= 0 || ttlMs <= 0) return;

    for (const [messageId, cached] of this.receipts) {
      if (cached.expiresAt <= now) this.receipts.delete(messageId);
    }
    while (this.receipts.size >= maxEntries) {
      const oldest = this.receipts.keys().next().value;
      if (oldest === undefined) break;
      this.receipts.delete(oldest);
    }
    this.receipts.set(receipt.messageId, {
      receipt,
      expiresAt: now + ttlMs,
    });
  }

  /** Cache a terminal inbound outcome (success receipt or failure tombstone)
   *  with the same TTL/eviction policy as the source-side receipt cache. */
  private recordInboundOutcome(
    messageId: string,
    fingerprint: string,
    outcome: InboundOutcome,
  ): void {
    const configured = this.deps.limits?.receiptCache;
    const maxEntries = configured?.maxEntries ?? 1_024;
    const ttlMs = configured?.ttlMs ?? 5 * 60_000;
    if (maxEntries <= 0 || ttlMs <= 0) return;
    const now = (this.deps.now ?? Date.now)();

    for (const [id, entry] of this.inboundOutcomes) {
      if (entry.expiresAt <= now) this.inboundOutcomes.delete(id);
    }
    while (this.inboundOutcomes.size >= maxEntries) {
      const oldest = this.inboundOutcomes.keys().next().value;
      if (oldest === undefined) break;
      this.inboundOutcomes.delete(oldest);
    }
    this.inboundOutcomes.set(messageId, {
      fingerprint,
      outcome,
      expiresAt: now + ttlMs,
    });
  }

  private enforceRateLimit(pairKey: string, now: number): void {
    const configured = this.deps.limits?.rateLimit;
    const maxMessages = configured?.maxMessages ?? 8;
    const windowMs = configured?.windowMs ?? 10_000;
    const cutoff = now - windowMs;
    const current = (this.rateWindows.get(pairKey) ?? []).filter(
      (time) => time > cutoff,
    );
    if (current.length >= maxMessages) {
      throw new AgentMessagingError(
        "MESSAGE_RATE_LIMITED",
        "The sender-to-target Agent message rate limit was exceeded.",
      );
    }
    current.push(now);
    this.rateWindows.set(pairKey, current);
  }

  private logDelivery(
    message: AgentMessage,
    receipt: AgentMessageReceipt | undefined,
    startedAt: number,
    errorCode?: AgentMessagingErrorCode,
  ): void {
    const logger = this.deps.logger;
    if (!logger) return;
    const latencyMs = Math.max(0, (this.deps.now ?? Date.now)() - startedAt);
    // The route is an address fact, not a caller choice: any message whose
    // destination is a different messaging node traveled over the relay.
    const route = message.from.nodeId === message.to.nodeId ? "local" : "relay";
    void logger
      .info(
        "agent.message.delivery",
        receipt
          ? "Agent message delivery accepted."
          : "Agent message delivery failed.",
        {
          messageId: message.id,
          sourceAddress: {
            nodeId: message.from.nodeId,
            endpointId: message.from.endpointId,
          },
          targetAddress: {
            nodeId: message.to.nodeId,
            endpointId: message.to.endpointId,
          },
          route,
          requestedMode: message.requestedMode,
          modeUsed: receipt?.modeUsed,
          status: receipt?.status ?? "failed",
          targetState: receipt?.targetState,
          latencyMs,
          contentLength: Buffer.byteLength(message.content, "utf8"),
          deduplicated: receipt?.deduplicated,
          errorCode,
        },
      )
      .catch(() => undefined);
  }

  private async enqueueTarget<T>(
    targetHandle: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    const pending = this.pendingByTarget.get(targetHandle) ?? 0;
    const maxPending = this.deps.limits?.maxPendingPerTarget ?? 32;
    if (pending >= maxPending) {
      throw new AgentMessagingError(
        "MESSAGE_QUEUE_FULL",
        "The target Agent message delivery queue is full.",
      );
    }
    this.pendingByTarget.set(targetHandle, pending + 1);
    const previous = this.targetTails.get(targetHandle) ?? Promise.resolve();
    const result = previous.then(operation, operation);
    const tail = result.then(
      () => undefined,
      () => undefined,
    );
    this.targetTails.set(targetHandle, tail);
    try {
      return await result;
    } finally {
      const remaining = (this.pendingByTarget.get(targetHandle) ?? 1) - 1;
      if (remaining > 0) {
        this.pendingByTarget.set(targetHandle, remaining);
      } else {
        this.pendingByTarget.delete(targetHandle);
      }
      if (this.targetTails.get(targetHandle) === tail) {
        this.targetTails.delete(targetHandle);
      }
    }
  }

  private recordTrace(record: AgentMessageTraceRecord): void {
    const maxSize = this.deps.limits?.traceRingBufferSize ?? 256;
    if (maxSize <= 0) return;
    if (this.traceRingBuffer.length >= maxSize) {
      this.traceRingBuffer.shift();
    }
    this.traceRingBuffer.push(record);
  }

  private getMessageContext(
    messageId: string,
    now: number,
  ): MessageContext | undefined {
    const ctx = this.messageContexts.get(messageId);
    if (!ctx) return undefined;
    if (ctx.expiresAt <= now) {
      this.messageContexts.delete(messageId);
      return undefined;
    }
    return ctx;
  }

  private recordMessageContext(context: MessageContext): void {
    const maxEntries = this.deps.limits?.contextCache?.maxEntries ?? 2_048;
    const now = (this.deps.now ?? Date.now)();
    for (const [id, ctx] of this.messageContexts) {
      if (ctx.expiresAt <= now) this.messageContexts.delete(id);
    }
    while (this.messageContexts.size >= maxEntries) {
      const oldest = this.messageContexts.keys().next().value;
      if (oldest === undefined) break;
      this.messageContexts.delete(oldest);
    }
    this.messageContexts.set(context.messageId, context);
  }

  private checkDuplicateContent(
    pairKey: string,
    hash: string,
    now: number,
  ): void {
    const windowMs = this.deps.limits?.duplicateContentWindowMs ?? 30_000;
    if (windowMs <= 0) return;
    const expiresAt = this.recentDuplicateContent.get(pairKey + ":" + hash);
    if (expiresAt !== undefined && expiresAt > now) {
      throw new AgentMessagingError(
        "DUPLICATE_MESSAGE",
        "Identical message content was already sent to this peer within the duplicate suppression window.",
      );
    }
  }

  private recordDuplicateContent(
    pairKey: string,
    hash: string,
    now: number,
  ): void {
    const windowMs = this.deps.limits?.duplicateContentWindowMs ?? 30_000;
    if (windowMs <= 0) return;
    const maxEntries = this.deps.limits?.contextCache?.maxEntries ?? 2_048;
    for (const [key, expiresAt] of this.recentDuplicateContent) {
      if (expiresAt <= now) this.recentDuplicateContent.delete(key);
    }
    while (this.recentDuplicateContent.size >= maxEntries) {
      const oldest = this.recentDuplicateContent.keys().next().value;
      if (oldest === undefined) break;
      this.recentDuplicateContent.delete(oldest);
    }
    this.recentDuplicateContent.set(pairKey + ":" + hash, now + windowMs);
  }
}
function addressKey(address: { nodeId: string; endpointId: string }): string {
  return address.nodeId + ":" + address.endpointId;
}

function sameAddress(
  left: { nodeId: string; endpointId: string },
  right: { nodeId: string; endpointId: string },
): boolean {
  return left.nodeId === right.nodeId && left.endpointId === right.endpointId;
}

/** Canonical identity of an inbound delivery attempt: two deliveries with the
 *  same messageId must match on every routing-relevant field or they are
 *  different messages reusing an id (DELIVERY_DENIED, never joined). */
function inboundFingerprint(input: {
  sourceNodeId: string;
  sourceEndpointId: string;
  targetEndpointId: string;
  content: string;
  requestedMode: string;
  replyTo?: string;
  conversationId?: string;
  depth?: number;
  completion?: string;
}): string {
  return JSON.stringify([
    input.sourceNodeId,
    input.sourceEndpointId,
    input.targetEndpointId,
    input.content,
    input.requestedMode,
    input.replyTo ?? "",
    input.conversationId ?? "",
    input.depth ?? 0,
    input.completion ?? "none",
  ]);
}

function mapDeliveryError(error: unknown): AgentMessagingError {
  if (error instanceof AgentMessagingError) return error;
  if (isCommandTimeoutError(error)) {
    return new AgentMessagingError(
      "DELIVERY_TIMEOUT",
      "Agent message delivery timed out before the target runtime accepted it.",
    );
  }
  if (error instanceof MessageInjectionError) {
    const messages: Record<typeof error.code, string> = {
      TARGET_NOT_RUNNING:
        "The target Agent does not have an active turn to steer.",
      TARGET_NOT_STEERABLE: "The target Agent cannot steer its current turn.",
      TARGET_NOT_INTERRUPTIBLE:
        "The target Agent cannot interrupt its current turn.",
      DELIVERY_RACE:
        "The target Agent turn changed while the message was being delivered.",
      DELIVERY_TIMEOUT:
        "Agent message delivery timed out before target acceptance.",
      DELIVERY_FAILED: "The target runtime did not accept the Agent message.",
    };
    return new AgentMessagingError(error.code, messages[error.code]);
  }
  return new AgentMessagingError(
    "DELIVERY_FAILED",
    "The target runtime did not accept the Agent message.",
  );
}
