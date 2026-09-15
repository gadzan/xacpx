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

export type ConversationTurnCancelResult =
  | { outcome: "cancelled" }
  | { outcome: "unknown" }
  | { outcome: "completed"; text?: string }
  | { outcome: "failed"; error?: string };

export interface ConversationTurnRunner {
  run(input: ConversationTurnRunInput): Promise<ConversationTurnRunResult>;
  cancel(input: ConversationTurnCancelInput): Promise<ConversationTurnCancelResult>;
}

type ControlTurnSeam = Pick<
  ControlService,
  "prompt" | "cancelQueuedItem" | "cancelTurnForPromptRequest"
>;

interface TrackedExecution {
  done: Promise<ConversationTurnRunResult>;
  finished?: ConversationTurnRunResult;
}

function cancelResultFromRun(result: ConversationTurnRunResult): ConversationTurnCancelResult {
  if (result.status === "completed") {
    return { outcome: "completed", ...(result.text !== undefined ? { text: result.text } : {}) };
  }
  if (result.status === "failed") {
    return { outcome: "failed", ...(result.error !== undefined ? { error: result.error } : {}) };
  }
  if (result.unknown) {
    return { outcome: "unknown" };
  }
  return { outcome: "cancelled" };
}

/**
 * Control/TurnQueue seam: `promptRequestId` is the durable execution identity
 * for this Run (minted at Conversation execution-start, then passed into
 * Control.prompt). Cancel/inspect must match that id; aborting the lane alone
 * does not prove the turn produced no effects.
 */
export class ControlConversationTurnRunner implements ConversationTurnRunner {
  private readonly executions = new Map<string, TrackedExecution>();

  constructor(private readonly control: ControlTurnSeam) {}

  async run(input: ConversationTurnRunInput): Promise<ConversationTurnRunResult> {
    const chatKey = directConversationChatKey(input.conversationId, input.topicId);
    const tracked: TrackedExecution = {
      done: this.control.prompt({
        chatKey,
        sessionAlias: input.sessionAlias,
        text: input.text,
        senderId: "bot-conversation",
        promptRequestId: input.promptRequestId,
      }).then((result) => this.mapPromptResult(result)),
    };
    tracked.done = tracked.done.then((result) => {
      tracked.finished = result;
      return result;
    });
    this.executions.set(input.promptRequestId, tracked);
    return await tracked.done;
  }

  async cancel(input: ConversationTurnCancelInput): Promise<ConversationTurnCancelResult> {
    const chatKey = directConversationChatKey(input.conversationId, input.topicId);
    const tracked = this.executions.get(input.promptRequestId);
    if (!tracked) {
      if (input.queueItemId) {
        this.control.cancelQueuedItem(chatKey, input.sessionAlias, input.queueItemId);
      }
      return { outcome: "unknown" };
    }
    if (!tracked.finished) {
      this.control.cancelTurnForPromptRequest(chatKey, input.sessionAlias, input.promptRequestId);
    }
    return cancelResultFromRun(await tracked.done);
  }

  private mapPromptResult(result: Awaited<ReturnType<ControlService["prompt"]>>): ConversationTurnRunResult {
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
}
