import {
  AgentMessagingError,
  isAgentMessagingErrorCode,
  isAmbiguousDeliveryError,
} from "./agent-messaging-error";
import type {
  AgentMessage,
  AgentMessageReceipt,
} from "./agent-messaging-types";

export interface RelayRouteClient {
  sendAgentMessageRoute(payload: {
    sourceNodeId: string;
    sourceEndpointId: string;
    targetNodeId: string;
    targetEndpointId: string;
    messageId: string;
    conversationId?: string;
    depth?: number;
    content: string;
    requestedMode: string;
    replyTo?: string;
  }): Promise<{
    messageId: string;
    status: "injected" | "queued" | "failed";
    modeUsed?: "steer" | "queue" | "interrupt" | "prompt";
    targetState?: "idle" | "running";
    errorCode?: string;
    deduplicated?: boolean;
  }>;
}

export interface RelayRouteRetryOptions {
  /** Total attempts including the first (default 3 = initial + 2 retries). */
  maxAttempts?: number;
  /** Linear backoff base in ms (default 150); attempt N waits backoffMs * N. */
  backoffMs?: number;
  /** Test seam: replaces the real timer backoff. */
  delay?: (ms: number) => Promise<void>;
}

function defaultDelay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class RelayAgentMessageRoute {
  constructor(
    private readonly client?: RelayRouteClient,
    private readonly retry: RelayRouteRetryOptions = {},
  ) {}

  isAvailable(): boolean {
    return Boolean(this.client);
  }

  async send(message: AgentMessage): Promise<AgentMessageReceipt> {
    if (!this.client) {
      throw new AgentMessagingError(
        "ROUTE_UNAVAILABLE",
        `Remote route is unavailable for destination node ${message.to.nodeId}.`,
      );
    }
    const maxAttempts = Math.max(1, this.retry.maxAttempts ?? 3);
    const backoffMs = Math.max(0, this.retry.backoffMs ?? 150);
    const delay = this.retry.delay ?? defaultDelay;

    let lastError: unknown;
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      try {
        const res = await this.client.sendAgentMessageRoute({
          sourceNodeId: message.from.nodeId,
          sourceEndpointId: message.from.endpointId,
          targetNodeId: message.to.nodeId,
          targetEndpointId: message.to.endpointId,
          // Same messageId across retries: the destination deduplicates by it,
          // so an ACK-loss retry cannot double-inject.
          messageId: message.id,
          ...(message.conversationId
            ? { conversationId: message.conversationId }
            : {}),
          ...(message.depth !== undefined ? { depth: message.depth } : {}),
          content: message.content,
          requestedMode: message.requestedMode,
          replyTo: message.replyTo,
        });
        return {
          messageId: res.messageId,
          status: res.status,
          ...(res.modeUsed ? { modeUsed: res.modeUsed } : {}),
          route: "relay",
          ...(res.targetState ? { targetState: res.targetState } : {}),
          ...(res.deduplicated ? { deduplicated: res.deduplicated } : {}),
        };
      } catch (err) {
        lastError = err;
        // Only AMBIGUOUS network failures are retried. Typed business failures
        // (TARGET_NODE_OFFLINE, DELIVERY_DENIED, ...) would fail identically on
        // the next attempt — retrying them only adds latency and duplicate load.
        if (!isAmbiguousDeliveryError(err) || attempt >= maxAttempts) {
          break;
        }
        await delay(backoffMs * attempt);
      }
    }
    const err = lastError;
    if (err instanceof AgentMessagingError) throw err;
    const errorMessage = err instanceof Error ? err.message : String(err);
    const code = isAgentMessagingErrorCode(errorMessage)
      ? errorMessage
      : "DELIVERY_FAILED";
    throw new AgentMessagingError(code, errorMessage);
  }
}
