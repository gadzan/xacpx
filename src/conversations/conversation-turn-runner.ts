import type { ControlService } from "../control/control-service";
import { CANCEL_DRAIN_TIMEOUT_MS } from "../control/turn-support";
import { directConversationChatKey } from "../domain/ids";
import type { PermissionInteractionOrigin } from "../permissions/permission-types";

export interface ConversationTurnRunInput {
  conversationId: string;
  topicId: string;
  botId: string;
  sessionAlias: string;
  logicalSessionId: string;
  text: string;
  /**
   * Server-derived execution provenance from the durable MemberTurn after claim.
   * The dispatcher copies this; callers must not invent human authority.
   */
  executionOrigin: PermissionInteractionOrigin;
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
  /** Bound on how long cancel/run wait for a proven terminal prompt result. */
  cancelSettleTimeoutMs?: number;
}

interface TrackedExecution {
  done: Promise<ConversationTurnRunResult>;
  resolveDone: (result: ConversationTurnRunResult) => void;
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
 *
 * Pre-admission cancel uses the runner-owned AbortController. After TurnQueue
 * admission, cancel stays on the exact promptRequestId path. Abort is not assumed
 * to settle the provider: cancel and the outward `run()` promise both resolve as
 * unknown after `cancelSettleTimeoutMs`.
 */
export class ControlConversationTurnRunner implements ConversationTurnRunner {
  private readonly executions = new Map<string, TrackedExecution>();
  private readonly settledMax: number;
  private readonly settledTtlMs: number;
  private readonly cancelSettleTimeoutMs: number;
  private readonly now: () => number;

  constructor(private readonly control: ControlTurnSeam, options?: ControlConversationTurnRunnerOptions) {
    this.settledMax = options?.settledMax ?? 2_000;
    this.settledTtlMs = options?.settledTtlMs ?? 24 * 60 * 60_000;
    this.cancelSettleTimeoutMs = options?.cancelSettleTimeoutMs ?? CANCEL_DRAIN_TIMEOUT_MS;
    this.now = options?.now ?? (() => Date.now());
  }

  hasTrackedExecution(promptRequestId: string): boolean {
    return this.executions.has(promptRequestId);
  }

  async run(input: ConversationTurnRunInput): Promise<ConversationTurnRunResult> {
    this.pruneSettled();
    const abort = new AbortController();
    let resolveDone!: (result: ConversationTurnRunResult) => void;
    const done = new Promise<ConversationTurnRunResult>((resolve) => {
      resolveDone = resolve;
    });
    const tracked: TrackedExecution = { done, resolveDone, abort };
    this.executions.set(input.promptRequestId, tracked);
    const chatKey = directConversationChatKey(input.conversationId, input.topicId);
    const provider = this.control.promptImmediate({
      chatKey,
      sessionAlias: input.sessionAlias,
      text: input.text,
      senderId: "bot-conversation",
      promptRequestId: input.promptRequestId,
      abortSignal: abort.signal,
      executionOrigin: input.executionOrigin,
    });
    void provider.then(
      (result) => this.finishTracked(tracked, this.mapPromptResult(result)),
      (error) => this.finishTracked(tracked, {
        status: "failed",
        error: error instanceof Error ? error.message : String(error),
      }),
    );
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
      await this.waitForCancelSettlement(tracked);
    }
    return cancelResultFromRun(await tracked.done);
  }

  private async waitForCancelSettlement(tracked: TrackedExecution): Promise<void> {
    if (tracked.finished) {
      return;
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<"timeout">((resolve) => {
      timer = setTimeout(() => resolve("timeout"), this.cancelSettleTimeoutMs);
      if (timer && typeof timer.unref === "function") {
        timer.unref();
      }
    });
    try {
      const winner = await Promise.race([
        tracked.done.then(() => "done" as const),
        timeout,
      ]);
      if (winner === "timeout") {
        this.finishTracked(tracked, { status: "cancelled", unknown: true });
      }
    } finally {
      if (timer) {
        clearTimeout(timer);
      }
    }
  }

  private finishTracked(tracked: TrackedExecution, result: ConversationTurnRunResult): void {
    if (tracked.finished) {
      return;
    }
    tracked.finished = result;
    tracked.finishedAt = this.now();
    this.pruneSettled();
    tracked.resolveDone(result);
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
    if (result.cancelled) {
      return { status: "cancelled", queueItemId: result.queueItemId };
    }
    if (!result.ok) {
      return { status: "failed", error: result.errorMessage ?? "prompt_failed", queueItemId: result.queueItemId };
    }
    return {
      status: "completed",
      text: result.text ?? "",
      queueItemId: result.queueItemId,
    };
  }
}
