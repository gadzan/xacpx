import type { ControlPromptResult } from "../control/control-service";
import { CANCEL_DRAIN_TIMEOUT_MS } from "../control/turn-support";
import { directConversationChatKey } from "../domain/ids";
import type { PermissionInteractionOrigin } from "../permissions/permission-types";
import type { ConversationExecutionPort } from "./conversation-execution-port";
import type { HumanIngressContext } from "./conversation-types";

export interface ConversationTurnRunInput {
  conversationId: string;
  topicId: string;
  botId: string;
  runId: string;
  memberTurnId: string;
  sessionAlias: string;
  logicalSessionId: string;
  text: string;
  /**
   * Server-derived execution provenance from the durable MemberTurn after claim.
   * The dispatcher copies this; callers must not invent human authority.
   */
  executionOrigin: PermissionInteractionOrigin;
  /**
   * Trusted permission return route for human MemberTurns. Isolation `chatKey`
   * stays `bot:<conversation>:<topic>`; the broker must not use that product key.
   */
  permissionRoute?: HumanIngressContext;
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
  ConversationExecutionPort,
  "promptImmediate" | "cancelQueuedConversationItem" | "cancelTurnForPromptRequest"
>;

export interface ControlConversationTurnRunnerOptions {
  settledMax?: number;
  settledTtlMs?: number;
  now?: () => number;
  /** Bound on how long cancel/run wait for a proven terminal prompt result. */
  cancelSettleTimeoutMs?: number;
  /** Late provider settlement after the scheduling outcome was decided
   *  (cancel timeout sealed the Run). §14.3: late results never schedule, but
   *  their durable evidence must not be dropped — the handler routes the
   *  proven result into the store's indeterminate reconciliation path. */
  onLateResult?: (input: ConversationTurnRunInput, result: ConversationTurnRunResult) => void;
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
 * for this Run (minted at Conversation execution-start, then passed into the
 * core-private ConversationExecutionPort.promptImmediate). Cancel/inspect must
 * match that id; aborting the lane alone does not prove the turn produced no effects.
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
  private onLateResult?: (input: ConversationTurnRunInput, result: ConversationTurnRunResult) => void;

  constructor(private readonly control: ControlTurnSeam, options?: ControlConversationTurnRunnerOptions) {
    this.settledMax = options?.settledMax ?? 2_000;
    this.settledTtlMs = options?.settledTtlMs ?? 24 * 60 * 60_000;
    this.cancelSettleTimeoutMs = options?.cancelSettleTimeoutMs ?? CANCEL_DRAIN_TIMEOUT_MS;
    this.now = options?.now ?? (() => Date.now());
    this.onLateResult = options?.onLateResult;
  }

  /** Composition seam: wire the dispatcher's durable-evidence path once both
   *  exist. Overrides the constructor option when both are provided. */
  setLateResultHandler(handler: (input: ConversationTurnRunInput, result: ConversationTurnRunResult) => void): void {
    this.onLateResult = handler;
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
    const permission = input.executionOrigin === "human" ? input.permissionRoute : undefined;
    const provider = this.control.promptImmediate({
      chatKey,
      sessionAlias: input.sessionAlias,
      text: input.text,
      senderId: permission?.senderId ?? "bot-conversation",
      promptRequestId: input.promptRequestId,
      abortSignal: abort.signal,
      executionOrigin: input.executionOrigin,
      ...(permission?.accountId !== undefined ? { accountId: permission.accountId } : {}),
      ...(permission?.isOwner !== undefined ? { isOwner: permission.isOwner } : {}),
      ...(permission?.senderName !== undefined ? { senderName: permission.senderName } : {}),
      ...(permission?.chatKey ? { permissionChatKey: permission.chatKey } : {}),
      conversation: {
        conversationId: input.conversationId,
        topicId: input.topicId,
        botId: input.botId,
        runId: input.runId,
        memberTurnId: input.memberTurnId,
      },
    });
    void provider.then(
      (result) => this.settleProviderResult(input, tracked, this.mapPromptResult(result)),
      (error) => this.settleProviderResult(input, tracked, {
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
        this.control.cancelQueuedConversationItem(chatKey, input.sessionAlias, input.queueItemId);
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

  /**
   * Provider settlement with the scheduling/evidence split (§14.3): the
   * FIRST settlement decides the scheduling outcome (returned to run/cancel).
   * A settlement arriving AFTER that — typically the provider completing past
   * the cancel-settle deadline that sealed the Run as indeterminate — must
   * not change the already-decided outcome, but it is proven evidence about
   * work that possibly mutated state: hand it to onLateResult instead of
   * dropping it. No handler wired (unit tests): drop, same as before.
   */
  private settleProviderResult(
    input: ConversationTurnRunInput,
    tracked: TrackedExecution,
    result: ConversationTurnRunResult,
  ): void {
    if (tracked.finished) {
      this.onLateResult?.(input, result);
      return;
    }
    this.finishTracked(tracked, result);
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

  private mapPromptResult(result: ControlPromptResult): ConversationTurnRunResult {
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
