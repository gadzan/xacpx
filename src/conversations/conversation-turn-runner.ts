import type { ControlService } from "../control/control-service";
import { directConversationChatKey } from "../domain/ids";

export interface ConversationTurnRunInput {
  conversationId: string;
  topicId: string;
  botId: string;
  sessionAlias: string;
  logicalSessionId: string;
  text: string;
  origin: "human";
  promptRequestId: string;
  abortSignal?: AbortSignal;
}

export interface ConversationTurnRunResult {
  status: "completed" | "cancelled" | "failed";
  text?: string;
  queueItemId?: string;
  error?: string;
  unknown?: boolean;
}

export interface ConversationTurnCancelInput {
  conversationId: string;
  topicId: string;
  sessionAlias: string;
  queueItemId?: string;
  promptRequestId: string;
}

export interface ConversationTurnRunner {
  run(input: ConversationTurnRunInput): Promise<ConversationTurnRunResult>;
  cancel(input: ConversationTurnCancelInput): Promise<"cancelled" | "unknown">;
}

/** Smallest Control/TurnQueue seam: reuse the normal xacpx prompt/cancel path. */
export class ControlConversationTurnRunner implements ConversationTurnRunner {
  constructor(
    private readonly control: Pick<ControlService, "prompt" | "cancelTurn" | "cancelQueuedItem">,
  ) {}

  async run(input: ConversationTurnRunInput): Promise<ConversationTurnRunResult> {
    const chatKey = directConversationChatKey(input.conversationId, input.topicId);
    const result = await this.control.prompt({
      chatKey,
      sessionAlias: input.sessionAlias,
      text: input.text,
      senderId: "bot-conversation",
      promptRequestId: input.promptRequestId,
    });
    if (result.queued) {
      return { status: "failed", error: "turn_queued_unexpectedly", queueItemId: result.queueItemId };
    }
    if (!result.ok) {
      const message = result.errorMessage ?? "prompt_failed";
      if (/cancel/i.test(message)) {
        return { status: "cancelled", queueItemId: result.queueItemId };
      }
      return { status: "failed", error: message, queueItemId: result.queueItemId };
    }
    return {
      status: "completed",
      text: result.text ?? "",
      queueItemId: result.queueItemId,
    };
  }

  async cancel(input: ConversationTurnCancelInput): Promise<"cancelled" | "unknown"> {
    const chatKey = directConversationChatKey(input.conversationId, input.topicId);
    if (input.queueItemId) {
      this.control.cancelQueuedItem(chatKey, input.sessionAlias, input.queueItemId);
    }
    this.control.cancelTurn(chatKey, input.sessionAlias);
    return "cancelled";
  }
}
