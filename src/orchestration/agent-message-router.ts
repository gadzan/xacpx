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
import type {
  AgentEndpointView,
  AgentMessage,
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
      };
      delivery: LocalAgentMessageDelivery;
      remoteRoute?: RelayAgentMessageRoute;
      createId?: () => string;
      now?: () => number;
      limits?: AgentMessageRouterLimits;
      logger?: Pick<AppLogger, "info">;
      events?: ControlEventBus;
    },
  ) {}

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
    };
    this.deps.events?.emit({
      type: "agent-message",
      sessionAlias: toDisplaySessionAlias(senderSessionAlias),
      message: entry,
    });
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
        createdAt,
        ...(input.replyTo ? { replyTo: input.replyTo } : {}),
      };

      if (target.endpoint.address.nodeId !== sender.address.nodeId) {
        if (!this.deps.remoteRoute || !this.deps.remoteRoute.isAvailable()) {
          const err = new AgentMessagingError(
            "ROUTE_UNAVAILABLE",
            `Remote route is unavailable for destination node ${target.endpoint.address.nodeId}.`,
          );
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
          throw mapped;
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
      createdAt,
      ...(input.replyTo ? { replyTo: input.replyTo } : {}),
    };

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
    };
    this.deps.events?.emit({
      type: "agent-message",
      sessionAlias: toDisplaySessionAlias(targetSessionAlias),
      message: inboundEntry,
    });
    return receipt;
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
