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
  AgentMessageReceipt,
  AgentMessageSendInput,
  AgentSenderBinding,
} from "./agent-messaging-types";

export interface LocalAgentMessageDelivery {
  deliver(
    target: ResolvedAgentEndpoint,
    message: AgentMessage,
    renderedText: string,
  ): Promise<SessionMessageReceipt>;
}

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

  constructor(
    private readonly deps: {
      registry: Pick<
        AgentEndpointRegistry,
        "listReachable" | "resolveSender" | "resolveTarget"
      >;
      delivery: LocalAgentMessageDelivery;
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
          route: "local",
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
