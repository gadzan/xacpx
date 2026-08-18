import { randomUUID } from "node:crypto";

import type { AppLogger } from "../logging/app-logger";
import { isCommandTimeoutError } from "../transport/command-timeouts";
import {
  MessageInjectionError,
  type SessionMessageReceipt,
} from "../transport/message-injection";
import type {
  AgentEndpointRegistry,
  ResolvedAgentEndpoint,
} from "./agent-endpoint-registry";
import { encodeAgentHandle } from "./agent-handle";
import { renderAgentMessageEnvelope } from "./agent-message-envelope";
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
  AgentSenderBinding,
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
  rateLimit?: {
    maxMessages: number;
    windowMs: number;
  };
  receiptCache?: {
    maxEntries: number;
    ttlMs: number;
  };
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

  constructor(
    private readonly deps: {
      registry: Pick<
        AgentEndpointRegistry,
        | "listReachable"
        | "resolveSender"
        | "resolveTarget"
        | "resolveLocalTargetByEndpointId"
      >;
      delivery: LocalAgentMessageDelivery;
      remoteRoute?: RelayAgentMessageRoute;
      createId?: () => string;
      now?: () => number;
      limits?: AgentMessageRouterLimits;
      logger?: Pick<AppLogger, "info">;
    },
  ) {}

  async listReachable(
    binding: AgentSenderBinding,
  ): Promise<AgentEndpointView[]> {
    return await this.deps.registry.listReachable(binding);
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
    return await this.enqueueTarget(input.to, async () => {
      const sender = await this.deps.registry.resolveSender(binding);
      const target = await this.deps.registry.resolveTarget(sender, input.to);
      const requestedMode = input.mode ?? "auto";
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
      const message: AgentMessage = {
        id: messageId,
        from: sender.address,
        to: target.endpoint.address,
        content: input.content,
        requestedMode,
        createdAt,
        ...(input.replyTo ? { replyTo: input.replyTo } : {}),
      };
      const cached = this.getCachedReceipt(messageId, createdAt);
      if (cached) {
        const receipt = { ...cached, deduplicated: true };
        this.logDelivery(message, receipt, createdAt);
        return receipt;
      }
      this.enforceRateLimit(
        addressKey(sender.address) + "->" + addressKey(target.endpoint.address),
        createdAt,
      );
      if (target.endpoint.address.nodeId !== sender.address.nodeId) {
        if (!this.deps.remoteRoute || !this.deps.remoteRoute.isAvailable()) {
          const err = new AgentMessagingError(
            "ROUTE_UNAVAILABLE",
            `Remote route is unavailable for destination node ${target.endpoint.address.nodeId}.`,
          );
          this.logDelivery(message, undefined, createdAt, err.code);
          throw err;
        }
        let remoteReceipt: AgentMessageReceipt;
        try {
          remoteReceipt = await this.deps.remoteRoute.send(message);
        } catch (error) {
          const mapped = mapDeliveryError(error);
          this.logDelivery(message, undefined, createdAt, mapped.code);
          throw mapped;
        }
        this.cacheReceipt(remoteReceipt, createdAt);
        this.logDelivery(message, remoteReceipt, createdAt);
        return remoteReceipt;
      }
      const renderedText = renderAgentMessageEnvelope({
        id: message.id,
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
      this.logDelivery(message, receipt, createdAt);
      return receipt;
    });
  }

  async deliverInbound(input: {
    sourceNodeId: string;
    sourceEndpointId: string;
    targetEndpointId: string;
    messageId: string;
    content: string;
    requestedMode: string;
    replyTo?: string;
    replyable: boolean;
  }): Promise<AgentMessageReceipt> {
    const createdAt = (this.deps.now ?? Date.now)();
    const fingerprint = inboundFingerprint(input);

    // 1. Terminal outcome cache — a COMPLETED delivery dedupes immediately:
    //    success returns the cached receipt, and an ambiguous terminal failure
    //    (the target may already have accepted the message) rethrows the same
    //    failure instead of re-injecting. Same id with a different payload is
    //    a different message reusing the id → DELIVERY_DENIED, never cached.
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
    const message: AgentMessage = {
      id: input.messageId,
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
      from: fromHandle,
      replyable: input.replyable && target.endpoint.capabilities.receive,
      ...(message.replyTo ? { replyTo: message.replyTo } : {}),
      content: message.content,
    });

    let result: SessionMessageReceipt;
    try {
      result = await this.deps.delivery.deliver(target, message, renderedText);
    } catch (error) {
      const mapped = mapDeliveryError(error);
      this.logDelivery(message, undefined, createdAt, mapped.code);
      throw mapped;
    }

    const receipt: AgentMessageReceipt = {
      messageId: message.id,
      status: result.status,
      modeUsed: result.modeUsed,
      route: "relay",
      ...(result.targetState ? { targetState: result.targetState } : {}),
    };
    // Outcome recording (receipt OR failure tombstone) happens in deliverInbound
    // so the terminal state is cache-visible before the in-flight slot releases.
    this.logDelivery(message, receipt, createdAt);
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
}

function addressKey(address: { nodeId: string; endpointId: string }): string {
  return address.nodeId + ":" + address.endpointId;
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
}): string {
  return JSON.stringify([
    input.sourceNodeId,
    input.sourceEndpointId,
    input.targetEndpointId,
    input.content,
    input.requestedMode,
    input.replyTo ?? "",
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
