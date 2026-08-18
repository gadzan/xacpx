import {
  AgentMessagingError,
  isAgentMessagingErrorCode,
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
    content: string;
    requestedMode: string;
    replyTo?: string;
  }): Promise<{
    messageId: string;
    status: "injected" | "queued" | "failed";
    modeUsed?: "steer" | "queue" | "interrupt" | "prompt";
    targetState?: "idle" | "running";
    errorCode?: string;
  }>;
}

export class RelayAgentMessageRoute {
  constructor(private readonly client?: RelayRouteClient) {}

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
    try {
      const res = await this.client.sendAgentMessageRoute({
        sourceNodeId: message.from.nodeId,
        sourceEndpointId: message.from.endpointId,
        targetNodeId: message.to.nodeId,
        targetEndpointId: message.to.endpointId,
        messageId: message.id,
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
      };
    } catch (err) {
      if (err instanceof AgentMessagingError) throw err;
      const message = err instanceof Error ? err.message : String(err);
      const code = isAgentMessagingErrorCode(message)
        ? message
        : "DELIVERY_FAILED";
      throw new AgentMessagingError(code, message);
    }
  }
}
