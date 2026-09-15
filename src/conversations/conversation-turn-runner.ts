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
  "promptImmediate" | "cancelQueuedItem" | "cancelTurnForPromptRequest"
>;

export interface ControlConversationTurnRunnerOptions {
  settledMax?: number;
  settledTtlMs?: number;
  now?: () => number;
}

interface TrackedExecution {
  done: Promise<ConversationTurnRunResult>;
  abort: AbortController;
  finished?: ConversationTurnRunResult;
  finishedAt?: number;
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
 * Control.promptImmediate). Cancel/inspect must match that id; aborting the lane alone
 * does not prove the turn produced no effects.
 */
export class ControlConversationTurnRunner implements ConversationTurnRunner {
  private readonly executions = new Map<string, TrackedExecution>();
  private readonly settledMax: number;
  private readonly settledTtlMs: number;
  private readonly now: () => number;

  constructor(private readonly control: ControlTurnSeam, options?: ControlConversationTurnRunnerOptions) {
    this.settledMax = options?.settledMax ?? 2_000;
    this.settledTtlMs = options?.settledTtlMs ?? 24 * 60 * 60_000;
    this.now = options?.now ?? (() => Date.now());
  }

  hasTrackedExecution(promptRequestId: string): boolean {
    return this.executions.has(promptRequestId);
  }

  async run(input: ConversationTurnRunInput): Promise<ConversationTurnRunResult> {
    this.pruneSettled();
    const abort = new AbortController();
    const tracked: TrackedExecution = {
      done: Promise.resolve({ status: "failed", error: "execution_not_started" }),
      abort,
    };
    this.executions.set(input.promptRequestId, tracked);
    const chatKey = directConversationChatKey(input.conversationId, input.topicId);
    tracked.done = this.control.promptImmediate({
      chatKey,
      sessionAlias: input.sessionAlias,
      text: input.text,
      senderId: "bot-conversation",
      promptRequestId: input.promptRequestId,
      abortSignal: abort.signal,
    }).then((result) => this.mapPromptResult(result)).then((result) => {
      tracked.finished = result;
      tracked.finishedAt = this.now();
      this.pruneSettled();
      return result;
    });
    return await tracked.done;
  }

  async cancel(input: ConversationTurnCancelInput): Promise<ConversationTurnCancelResult> {
    this.pruneSettled();
    const chatKey = directConversationChatKey(input.conversationId, input.topicId);
    const tracked = this.executions.get(input.promptRequestId);
    if (!tracked) {
      if (input.queueItemId) {
        this.control.cancelQueuedItem(chatKey, input.sessionAlias, input.queueItemId);
      }
      return { outcome: "unknown" };
    }
    if (!tracked.finished) {
      tracked.abort.abort();
      this.control.cancelTurnForPromptRequest(chatKey, input.sessionAlias, input.promptRequestId);
    }
    return cancelResultFromRun(await tracked.done);
  }

  private pruneSettled(): void {
    const now = this.now();
    for (const [id, tracked] of this.executions) {
      if (tracked.finishedAt !== undefined && tracked.finishedAt + this.settledTtlMs <= now) {
        this.executions.delete(id);
      }
    }
    const settledIds: string[] = [];
    for (const [id, tracked] of this.executions) {
      if (tracked.finishedAt !== undefined) {
        settledIds.push(id);
      }
    }
    const overflow = settledIds.length - this.settledMax;
    if (overflow > 0) {
      for (const id of settledIds.slice(0, overflow)) {
        this.executions.delete(id);
      }
    }
  }

  private mapPromptResult(result: Awaited<ReturnType<ControlService["promptImmediate"]>>): ConversationTurnRunResult {
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
