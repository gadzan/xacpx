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
          ...(message.completion && message.completion !== "none"
            ? { completion: message.completion }
            : {}),
        });
        if (res && typeof res === "object" && "errorCode" in res && res.errorCode) {
          const code = isAgentMessagingErrorCode(res.errorCode) ? res.errorCode : "DELIVERY_FAILED";
          throw new AgentMessagingError(code, String(res.errorCode));
        }
        if (res && typeof res === "object" && "error" in res && res.error) {
          const errPayload = (res as { error: { code?: string; message?: string } }).error;
          const code = isAgentMessagingErrorCode(errPayload.code) ? errPayload.code : "DELIVERY_FAILED";
          throw new AgentMessagingError(code, errPayload.message || errPayload.code || "DELIVERY_FAILED");
        }
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
        if (!isAmbiguousDeliveryError(err) || attempt >= maxAttempts) {
          break;
        }
        await delay(backoffMs * attempt);
      }
    }
    const err = lastError;
    if (err instanceof AgentMessagingError) throw err;
    const rawCode = (err as Error & { code?: string }).code;
    const errorMessage = err instanceof Error ? err.message : String(err);
    const code = isAgentMessagingErrorCode(rawCode)
      ? rawCode
      : isAgentMessagingErrorCode(errorMessage)
        ? errorMessage
        : "DELIVERY_FAILED";
    throw new AgentMessagingError(code, errorMessage);
  }
}
