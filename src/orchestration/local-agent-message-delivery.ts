import type { PeerTurnOrigin } from "../control/turn-support";
import type { ResolvedSession, SessionTransport } from "../transport/types";
import {
  MessageInjectionError,
  type SessionMessageReceipt,
} from "../transport/message-injection";
import type { ResolvedAgentEndpoint } from "./agent-endpoint-registry";
import type {
  AgentMessage,
  AgentMessageCompletion,
  AgentMessageMode,
} from "./agent-messaging-types";
import { AgentMessagingError } from "./agent-messaging-error";

export class LocalAgentMessageDeliveryAdapter {
  constructor(
    private readonly deps: {
      transport: Pick<SessionTransport, "injectMessage">;
      resolveLogicalSession: (
        transportSession: string,
      ) => Promise<ResolvedSession | null>;
      resolveWorkerSession: (
        target: Extract<ResolvedAgentEndpoint["runtime"], { kind: "worker" }>,
      ) => ResolvedSession | null;
      deliverLogicalTurn?: (
        alias: string,
        renderedText: string,
        messageId: string,
        peerOrigin?: PeerTurnOrigin,
        /** v0.4: "interrupt" selects the TurnQueue control-plane preempt path;
         *  every other mode keeps the non-cancelling peer turn path. */
        requestedMode?: AgentMessageMode,
      ) => Promise<{
        status: "injected" | "queued";
        modeUsed?: "prompt" | "queue" | "interrupt";
        targetState?: "idle" | "running";
      }>;
      deliverCompletionTurn?: (
        alias: string,
        completion: AgentMessageCompletion,
        requestMessageId: string,
      ) => Promise<{ status: "injected" | "queued" } | { status: "rejected"; reason: string }>;
    },
  ) {}

  async deliver(
    target: ResolvedAgentEndpoint,
    message: AgentMessage,
    renderedText: string,
  ): Promise<SessionMessageReceipt> {
    if (target.runtime.kind === "remote") {
      throw new AgentMessagingError(
        "ROUTE_UNAVAILABLE",
        "The target belongs to a remote messaging node; use the remote route.",
      );
    }
    if (target.runtime.kind === "logical" && this.deps.deliverLogicalTurn) {
      const peerOrigin: PeerTurnOrigin = {
        requestMessageId: message.id,
        completion: message.completion ?? "none",
        source: message.from,
        target: message.to,
      };
      const res = await this.deps.deliverLogicalTurn(
        target.runtime.alias,
        renderedText,
        message.id,
        peerOrigin,
        message.requestedMode,
      );
      return {
        status: res.status,
        modeUsed: res.modeUsed ?? "queue",
        ...(res.targetState ? { targetState: res.targetState } : {}),
      };
    }
    const session =
      target.runtime.kind === "logical"
        ? await this.deps.resolveLogicalSession(target.runtime.transportSession)
        : this.deps.resolveWorkerSession(target.runtime);
    if (!session) {
      throw new AgentMessagingError(
        "TARGET_UNAVAILABLE",
        "The target Agent session is not currently resolvable.",
      );
    }
    if (!this.deps.transport.injectMessage) {
      throw new MessageInjectionError(
        "DELIVERY_FAILED",
        "The configured session transport does not support Agent Messaging delivery.",
      );
    }

    const boundSession: ResolvedSession =
      target.runtime.kind === "worker"
        ? {
            ...session,
            mcpCoordinatorSession: target.runtime.binding.coordinatorSession,
            mcpSourceHandle: target.runtime.workerSession,
          }
        : {
            ...session,
            mcpCoordinatorSession: target.runtime.transportSession,
          };
    return await this.deps.transport.injectMessage(boundSession, {
      text: renderedText,
      messageId: message.id,
      mode: message.requestedMode,
    });
  }

  async deliverCompletion(
    sourceAlias: string,
    completion: AgentMessageCompletion,
    requestMessageId: string,
  ): Promise<{ status: "injected" | "queued" } | { status: "rejected"; reason: string }> {
    if (this.deps.deliverCompletionTurn) {
      return await this.deps.deliverCompletionTurn(
        sourceAlias,
        completion,
        requestMessageId,
      );
    }
    return { status: "queued" };
  }
}
