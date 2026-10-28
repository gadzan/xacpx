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
import type { PeerRequest, PeerRequestStatus, PeerWatchResult } from "./peer-types";
import { isPeerRequestTerminal } from "./peer-types";
import { sameCoordinatorSession } from "../orchestration/coordinator-identity";
import type { PeerStore } from "./peer-store";

export interface PeerDelegateInput {
  /** Caller binding string (tool sourceHandle, else coordinatorSession). */
  originatorAlias: string;
  originatorWorkspace?: string;
  targetAlias: string;
  targetWorkspace?: string;
  task: string;
  /**
   * Server-injected coordinator session (tool binding, never a tool
   * argument). Recorded on the request as its approval scope; delegate
   * refuses an empty value so no record is ever created without a scope.
   */
  coordinatorSession: string;
  /** Client-supplied idempotency key. Omitted → a fresh UUID. Re-sending
   *  the same requestId with the same originator/target/task returns the
   *  existing record; reusing it for a different delegation is rejected. */
  requestId?: string;
}

export interface PeerApproveInput {
  requestId: string;
  /**
   * Binding-derived identity of the approving caller. The tool layer
   * supplies sourceHandle ?? coordinatorSession; this is never a
   * free-form name the caller reports about itself. The target session
   * cannot approve a delegation addressed to itself. Only the record's
   * coordinator can approve: a worker under the coordinator (sourceHandle
   * set, so approverAlias is the worker handle) is NOT the coordinator,
   * even when it originated the delegation.
   */
  approverAlias: string;
  /**
   * Server-injected coordinator session of the approving caller. Both
   * this and approverAlias must stably match the record's coordinator:
   * approverAlias is the effective caller identity, coordinatorSession
   * is the scope the caller claims to act in. A mismatch on either side
   * rejects, so a binding that disagrees with itself cannot approve.
   */
  coordinatorSession: string;
}

export interface PeerCancelInput {
  requestId: string;
  /** Only the originator can cancel its own delegation. */
  originatorAlias: string;
}

export interface PeerListFilter {
  status?: PeerRequestStatus;
}

/**
 * Caller-scoped list input. `callerAlias` is the binding-derived caller
 * (sourceHandle ?? coordinatorSession); `coordinatorSession` is the
 * server-injected coordinator scope. When the caller IS the coordinator
 * (stable comparison of the two), the result is the coordinator view:
 * every record whose coordinator stably matches, regardless of whether
 * the caller originated or is targeted by it. Otherwise the result is
 * the related view (originator or target only), exactly as listRelated.
 * A missing coordinatorSession degrades to the related view — the
 * narrower, fail-closed shape — never to an unscoped listing.
 */
export interface PeerListInput {
  callerAlias: string;
  coordinatorSession?: string;
  status?: PeerRequestStatus;
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
    const coordinatorSession = input.coordinatorSession?.trim() ?? "";
    if (!coordinatorSession) {
      throw new Error("peer_delegate requires a non-empty coordinatorSession");
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
      coordinator: coordinatorSession,
      task,
      status: "needs_confirmation",
      createdAt: now,
      updatedAt: now,
    };
    return await this.deps.store.upsert(record);
  }

  /**
   * Approval rule, in order: status → empty identity → target
   * self-approval → coordinator match. Only the record's coordinator can
   * approve: the approver's binding identity AND its coordinator scope
   * must both stably match the recorded coordinator (stable comparison,
   * so a `/clear` `:reset-<digits>` suffix on either side does not
   * orphan the record). A record without a coordinator — only possible
   * for hand-built pre-wiring fixtures, since delegate always records
   * one — fails closed with an explicit error instead of admitting any
   * approver.
   */
  async approve(input: PeerApproveInput): Promise<PeerRequest> {
    const record = await this.requireRequest(input.requestId);
    if (record.status !== "needs_confirmation") {
      throw new Error(
        `peer request "${input.requestId}" is not awaiting approval (status=${record.status})`,
      );
    }
    const approverAlias = input.approverAlias.trim();
    if (!approverAlias) {
      throw new Error("peer approve requires a binding-derived approver identity");
    }
    const coordinatorSession = input.coordinatorSession?.trim() ?? "";
    if (!coordinatorSession) {
      throw new Error("peer approve requires a binding-derived coordinatorSession");
    }
    if (approverAlias === record.target.alias) {
      throw new Error(
        `the target session cannot approve a delegation addressed to itself (target=${record.target.alias})`,
      );
    }
    if (!record.coordinator) {
      throw new Error(
        `peer request "${input.requestId}" has no recorded coordinator; it cannot be approved (pre-wiring record — re-delegate with a new requestId)`,
      );
    }
    if (!sameCoordinatorSession(approverAlias, record.coordinator)) {
      throw new Error(
        `only the record's coordinator can approve peer request "${input.requestId}" (coordinator=${record.coordinator})`,
      );
    }
    if (!sameCoordinatorSession(coordinatorSession, record.coordinator)) {
      throw new Error(
        `only the record's coordinator can approve peer request "${input.requestId}" (coordinator=${record.coordinator})`,
      );
    }
    const now = this.now().toISOString();
    const running: PeerRequest = {
      ...record,
      status: "running",
      approvedAt: now,
      approvedBy: approverAlias,
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
   * Cancel a running delegation, or withdraw one still waiting for
   * approval. Record-level only: this does NOT stop the target's turn —
   * the target keeps running, but its result will no longer be
   * backfilled (see backfillIfRunning), and watch reports `cancelled`.
   * Withdrawing a needs_confirmation request needs no turn to stop
   * because it never executed. Terminal requests cannot be cancelled.
   */
  async cancel(input: PeerCancelInput): Promise<PeerRequest> {
    const record = await this.requireRequest(input.requestId);
    if (record.status !== "running" && record.status !== "needs_confirmation") {
      throw new Error(
        `only a running or unapproved peer request can be cancelled (status=${record.status})`,
      );
    }
    if (record.originator.alias !== input.originatorAlias) {
      throw new Error("only the originator can cancel a peer request");
    }
    const now = this.now().toISOString();
    return await this.deps.store.upsert({
      ...record,
      status: "cancelled",
      cancelledAt: now,
      updatedAt: now,
    });
  }

  /**
   * Delegations related to one caller — where the caller is the originator
   * or the target — optionally filtered by status. This is the viewing
   * entry for requestIds lost to context loss or restart, and for what is
   * waiting for approval.
   */
  async listRelated(
    callerAlias: string,
    filter?: PeerListFilter,
  ): Promise<PeerRequest[]> {
    const records = await this.deps.store.list();
    return records.filter(
      (record) =>
        (record.originator.alias === callerAlias ||
          record.target.alias === callerAlias) &&
        (filter?.status === undefined || record.status === filter.status),
    );
  }

  /**
   * Caller-scoped listing for the peer_list tool. When the caller IS the
   * coordinator (stable comparison of callerAlias against
   * coordinatorSession), this is the coordinator view: every record in
   * that coordinator's scope, status filter applying as usual, no filter
   * meaning all in-scope records — the same no-filter semantics as
   * listRelated. Records without a coordinator (pre-wiring fixtures
   * only) never enter a coordinator view; they stay visible only in the
   * related view below. Any other caller gets exactly listRelated.
   */
  async list(input: PeerListInput): Promise<PeerRequest[]> {
    const records = await this.deps.store.list();
    const statusMatches = (record: PeerRequest): boolean =>
      input.status === undefined || record.status === input.status;
    if (
      input.coordinatorSession !== undefined &&
      sameCoordinatorSession(input.callerAlias, input.coordinatorSession)
    ) {
      const scope = input.coordinatorSession;
      return records.filter(
        (record) =>
          record.coordinator !== undefined &&
          sameCoordinatorSession(record.coordinator, scope) &&
          statusMatches(record),
      );
    }
    return records.filter(
      (record) =>
        (record.originator.alias === input.callerAlias ||
          record.target.alias === input.callerAlias) &&
        statusMatches(record),
    );
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
    // Re-read first: a cancel may have landed after approve but before
    // this background task started. Never resurrect a cancelled record
    // with a stale snapshot, and never backfill onto it below.
    const current = await this.deps.store.get(record.requestId);
    if (!current || current.status !== "running") {
      return;
    }
    const target = await this.deps.resolveSession(current.target.alias);
    if (!target) {
      await this.backfillIfRunning(current.requestId, {
        error: `peer target session "${current.target.alias}" is no longer resolvable`,
      });
      return;
    }
    // Resolve the transport name from state at execution time — never
    // compose it from workspace + alias (names may carry suffixes).
    const executing: PeerRequest = {
      ...current,
      targetTransportSession: target.transportSession,
    };
    await this.deps.store.upsert(executing);
    const promptText =
      `Peer delegation from ${current.originator.alias} ` +
      `(request ${current.requestId}):\n\n${current.task}`;
    try {
      const { text } = await this.deps.promptSession(target, promptText);
      await this.backfillIfRunning(current.requestId, { result: text });
    } catch (error) {
      await this.backfillIfRunning(current.requestId, {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * Backfill only while the request is still running. A cancel that lands
   * between the prompt finishing and this write must win: recordCompletion
   * already refuses non-running records, so this re-read is what keeps a
   * cancelled record from being overwritten by a late completion. (A
   * residual race between this re-read and recordCompletion's own check
   * surfaces as a refused completion inside runExecution's swallowed
   * catch; the record stays cancelled either way.)
   */
  private async backfillIfRunning(
    requestId: string,
    outcome: { result: string } | { error: string },
  ): Promise<void> {
    const current = await this.deps.store.get(requestId);
    if (!current || current.status !== "running") {
      return;
    }
    await this.recordCompletion(requestId, outcome);
  }
}
