import { randomUUID } from "node:crypto";

import {
  boundPeerResult,
  sanitizeCompletionError,
} from "../orchestration/agent-message-completion";
import {
  clampWatchPollInterval,
  clampWatchTimeout,
} from "../orchestration/task-watch-timeouts";
import type { ResolvedSession } from "../transport/types";
import type { PeerRequest, PeerWatchResult } from "./peer-types";
import { isPeerRequestTerminal } from "./peer-types";
import type { PeerStore } from "./peer-store";

export interface PeerDelegateInput {
  /** Caller binding string (tool sourceHandle, else coordinatorSession). */
  originatorAlias: string;
  originatorWorkspace?: string;
  targetAlias: string;
  targetWorkspace?: string;
  task: string;
  /** Client-supplied idempotency key. Omitted → a fresh UUID. Re-sending
   *  the same requestId with the same originator/target/task returns the
   *  existing record; reusing it for a different delegation is rejected. */
  requestId?: string;
}

export interface PeerApproveInput {
  requestId: string;
  /** Who authorized execution (operator binding string). */
  approvedBy: string;
}

export interface PeerWatchInput {
  requestId: string;
  timeoutMs?: number;
  pollIntervalMs?: number;
}

export interface PeerConfirmInput {
  requestId: string;
  originatorAlias: string;
}

export interface PeerServiceDeps {
  /** Resolve a session key to a live session. Callers try the alias first
   *  and fall back to transport-session lookup, so both logical aliases and
   *  coordinator transport names resolve. */
  resolveSession: (key: string) => Promise<ResolvedSession | null>;
  /** Prompt the target session. The transport queues behind the target's
   *  active turn; this service never cancels or interrupts it. */
  promptSession: (
    session: ResolvedSession,
    text: string,
  ) => Promise<{ text: string }>;
  store: PeerStore;
  now?: () => Date;
  createRequestId?: () => string;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Peer delegation service (prototype). Owns the delegation leg only:
 * create → approve → execute → backfill → validate. It never touches
 * orchestration tasks, group sessions, or the coordinator dispatch chain,
 * and it never sends messages — peers talk via the existing agent_send.
 */
export class PeerService {
  private readonly now: () => Date;
  private readonly createRequestId: () => string;

  constructor(private readonly deps: PeerServiceDeps) {
    this.now = deps.now ?? (() => new Date());
    this.createRequestId = deps.createRequestId ?? (() => randomUUID());
  }

  async get(requestId: string): Promise<PeerRequest | null> {
    return await this.deps.store.get(requestId);
  }

  async delegate(input: PeerDelegateInput): Promise<PeerRequest> {
    const originatorAlias = input.originatorAlias.trim();
    const targetAlias = input.targetAlias.trim();
    const task = input.task.trim();
    if (!originatorAlias) {
      throw new Error("peer_delegate requires a non-empty originator");
    }
    if (!targetAlias) {
      throw new Error("peer_delegate requires a non-empty targetAlias");
    }
    if (!task) {
      throw new Error("peer_delegate requires a non-empty task");
    }
    if (originatorAlias === targetAlias) {
      throw new Error("peer delegation to self is not allowed");
    }
    const requestId = input.requestId?.trim() || this.createRequestId();
    const existing = await this.deps.store.get(requestId);
    if (existing) {
      if (
        existing.originator.alias === originatorAlias &&
        existing.target.alias === targetAlias &&
        existing.task === task
      ) {
        return existing;
      }
      throw new Error(
        `peer requestId "${requestId}" is already used by a different delegation`,
      );
    }
    const target = await this.deps.resolveSession(targetAlias);
    if (!target) {
      throw new Error(`peer target session "${targetAlias}" not found`);
    }
    if (
      input.targetWorkspace !== undefined &&
      target.workspace !== input.targetWorkspace
    ) {
      throw new Error(
        `peer target session "${targetAlias}" is in workspace "${target.workspace}", not "${input.targetWorkspace}"`,
      );
    }
    const now = this.now().toISOString();
    const record: PeerRequest = {
      requestId,
      originator: {
        alias: originatorAlias,
        ...(input.originatorWorkspace !== undefined
          ? { workspace: input.originatorWorkspace }
          : {}),
      },
      target: {
        alias: targetAlias,
        workspace: target.workspace,
      },
      task,
      status: "needs_confirmation",
      createdAt: now,
      updatedAt: now,
    };
    return await this.deps.store.upsert(record);
  }

  async approve(input: PeerApproveInput): Promise<PeerRequest> {
    const record = await this.requireRequest(input.requestId);
    if (record.status !== "needs_confirmation") {
      throw new Error(
        `peer request "${input.requestId}" is not awaiting approval (status=${record.status})`,
      );
    }
    const now = this.now().toISOString();
    const running: PeerRequest = {
      ...record,
      status: "running",
      approvedAt: now,
      approvedBy: input.approvedBy,
      startedAt: now,
      updatedAt: now,
    };
    await this.deps.store.upsert(running);
    // Execution proceeds in the background: approve returns "running"
    // immediately and the caller observes completion via peer_watch.
    // runExecution persists its own terminal state on every path, so a
    // failure can never leave the record silently stuck without a trace.
    void this.runExecution(running).catch(() => {
      // runExecution already persisted the failure; nothing left to do.
    });
    return running;
  }

  async watch(input: PeerWatchInput): Promise<PeerWatchResult> {
    const timeoutMs = clampWatchTimeout(input.timeoutMs);
    const pollMs = clampWatchPollInterval(input.pollIntervalMs);
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const record = await this.requireRequest(input.requestId);
      if (isPeerRequestTerminal(record.status)) {
        return { status: "terminal", request: record };
      }
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        return { status: "timeout", request: record };
      }
      await sleep(Math.min(pollMs, remaining));
    }
  }

  async confirm(input: PeerConfirmInput): Promise<PeerRequest> {
    const record = await this.requireRequest(input.requestId);
    if (record.status !== "completed") {
      throw new Error(
        `only a completed peer request can be confirmed as delivered (status=${record.status})`,
      );
    }
    if (record.originator.alias !== input.originatorAlias) {
      throw new Error("only the originator can confirm delivery of a peer request");
    }
    const now = this.now().toISOString();
    return await this.deps.store.upsert({
      ...record,
      status: "delivered",
      deliveredAt: now,
      updatedAt: now,
    });
  }

  /**
   * Backfill a terminal outcome by requestId. This is the ONLY path that
   * moves a running request to completed/failed, and it refuses mismatches:
   * unknown ids and non-running records are rejected, so a receipt can
   * never land on the wrong delegation.
   */
  async recordCompletion(
    requestId: string,
    outcome: { result: string } | { error: string },
  ): Promise<PeerRequest> {
    const record = await this.requireRequest(requestId);
    if (record.status !== "running") {
      throw new Error(
        `peer request "${requestId}" is not running (status=${record.status}); refusing mismatched completion`,
      );
    }
    const now = this.now().toISOString();
    if ("result" in outcome) {
      const bounded = boundPeerResult(outcome.result);
      return await this.deps.store.upsert({
        ...record,
        status: "completed",
        result: bounded,
        resultTruncated: bounded !== outcome.result,
        completedAt: now,
        updatedAt: now,
      });
    }
    return await this.deps.store.upsert({
      ...record,
      status: "failed",
      error: sanitizeCompletionError(outcome.error),
      completedAt: now,
      updatedAt: now,
    });
  }

  private async requireRequest(requestId: string): Promise<PeerRequest> {
    const record = await this.deps.store.get(requestId);
    if (!record) {
      throw new Error(`peer request "${requestId}" not found`);
    }
    return record;
  }

  private async runExecution(record: PeerRequest): Promise<void> {
    const target = await this.deps.resolveSession(record.target.alias);
    if (!target) {
      await this.recordCompletion(record.requestId, {
        error: `peer target session "${record.target.alias}" is no longer resolvable`,
      });
      return;
    }
    // Resolve the transport name from state at execution time — never
    // compose it from workspace + alias (names may carry suffixes).
    const executing: PeerRequest = {
      ...record,
      targetTransportSession: target.transportSession,
    };
    await this.deps.store.upsert(executing);
    const promptText =
      `Peer delegation from ${record.originator.alias} ` +
      `(request ${record.requestId}):\n\n${record.task}`;
    try {
      const { text } = await this.deps.promptSession(target, promptText);
      await this.recordCompletion(record.requestId, { result: text });
    } catch (error) {
      await this.recordCompletion(record.requestId, {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}
