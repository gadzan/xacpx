import { randomUUID } from "node:crypto";

import { composeBotTurnPromptFromSnapshot } from "../bots/bot-profile-prompt";
import { BotError } from "../bots/bot-error";
import type { BotRuntimeManager } from "../bots/bot-runtime-manager";
import { sessionMatchesExecution } from "../bots/bot-types";
import { createSourceTurnId } from "../domain/ids";
import type { SessionService } from "../sessions/session-service";
import { ConversationError } from "./conversation-error";
import { conversationExecutionOrigin, conversationExecutionOriginFromMemberTurn } from "./conversation-execution";
import type { ClaimedWork, ConversationStore } from "./conversation-store";
import {
  emitConversationProductEvent,
  type ConversationProductEvent,
  type ConversationProductEventSink,
} from "./conversation-product-events";
import type {
  ConversationTurnCancelResult,
  ConversationTurnRunner,
} from "./conversation-turn-runner";
import { TERMINAL_MEMBER_STATES, type MemberTurnRecord } from "./conversation-types";

export interface ConversationDispatcherHooks {
  afterClaim?: (work: ClaimedWork) => Promise<void>;
  beforeRuntimeMaterialize?: (work: ClaimedWork) => Promise<void>;
  failRuntimeMaterialize?: boolean | (() => Error | true | undefined);
  afterAcceptedIdentityCheck?: (work: ClaimedWork) => Promise<void>;
  beforeExecutionStart?: (work: ClaimedWork) => Promise<void>;
  afterExecutionStart?: (turn: MemberTurnRecord) => Promise<void>;
  beforeResultPersist?: (work: ClaimedWork) => Promise<void>;
}

export interface ConversationDispatcherOptions {
  now?: () => Date;
  leaseMs?: number;
  ownerId?: string;
  /** Process-lifetime authority epoch. Accept stamps it; claim compares it. */
  authorityEpoch?: string;
  hooks?: ConversationDispatcherHooks;
  onProductEvent?: ConversationProductEventSink;
}

const DEFAULT_LEASE_MS = 30_000;

export class ConversationDispatcher {
  private readonly now: () => Date;
  private readonly leaseMs: number;
  private readonly ownerId: string;
  readonly authorityEpoch: string;
  private readonly hooks?: ConversationDispatcherHooks;
  private draining = false;
  private wakeGeneration = 0;
  /** Topics that failed pre-start in this drain pass. Skipped so a poison row
   *  cannot starve other Topics. A later wake generation starts a fresh pass
   *  with this set cleared; without a new wake the poison Topic does not
   *  hot-loop. */
  private readonly deferredTopicIds = new Set<string>();
  private readonly onProductEvent?: ConversationProductEventSink;
  private closed = false;
  private drainTask: Promise<void> | undefined;

  constructor(
    private readonly store: ConversationStore,
    private readonly runtime: BotRuntimeManager,
    private readonly runner: ConversationTurnRunner,
    private readonly sessions: Pick<SessionService, "getLogicalSessionRecord">,
    options?: ConversationDispatcherOptions,
  ) {
    this.now = options?.now ?? (() => new Date());
    this.leaseMs = options?.leaseMs ?? DEFAULT_LEASE_MS;
    this.ownerId = options?.ownerId ?? `dispatcher:${process.pid}:${randomUUID()}`;
    this.authorityEpoch = options?.authorityEpoch ?? randomUUID();
    this.hooks = options?.hooks;
    this.onProductEvent = options?.onProductEvent;
  }

  async kick(): Promise<void> {
    this.wakeGeneration += 1;
    if (this.closed) {
      return;
    }
    if (this.draining) {
      return;
    }
    this.draining = true;
    const task = this.runDrain();
    this.drainTask = task;
    try {
      await task;
    } finally {
      if (this.drainTask === task) {
        this.drainTask = undefined;
      }
    }
  }

  /** Refuse new claims. In-flight execute may finish. */
  stop(): void {
    this.closed = true;
  }

  async shutdown(): Promise<void> {
    this.closed = true;
    if (this.drainTask) {
      await this.drainTask.catch(() => undefined);
    }
  }

  private async runDrain(): Promise<void> {
    let seen = 0;
    try {
      while (seen !== this.wakeGeneration) {
        if (this.closed) {
          return;
        }
        seen = this.wakeGeneration;
        this.deferredTopicIds.clear();
        for (;;) {
          if (this.closed) {
            return;
          }
          this.store.recoverExpiredClaims(this.now().toISOString());
          const claimed = this.claimOne();
          if (!claimed) {
            break;
          }
          await this.execute(claimed);
        }
      }
    } finally {
      this.draining = false;
      this.deferredTopicIds.clear();
    }
    if (!this.closed && seen !== this.wakeGeneration) {
      await this.kick();
    }
  }

  private emitProduct(event: ConversationProductEvent): void {
    emitConversationProductEvent(this.onProductEvent, event);
  }

  async cancelRun(runId: string): Promise<void> {
    const now = this.now().toISOString();
    const outcome = this.store.cancelRun(runId, now);
    if (outcome.alreadyTerminal) {
      return;
    }
    if (!outcome.executionStarted || outcome.activeMembers.length === 0) {
      this.emitRunAndMember(outcome.run, outcome.memberTurn.id);
      await this.kick();
      return;
    }
    // Snapshot-first with all-settled semantics: issue physical cancel to
    // EVERY active member. A transport throw must not abandon already
    // observed outcomes: persist fulfilled evidence first (below), then
    // rethrow so the barrier stays and retry covers only the unsettled rest.
    const fulfilled: Array<{ member: MemberTurnRecord; result: ConversationTurnCancelResult }> = [];
    let firstError: unknown;
    for (const active of outcome.activeMembers) {
      const current = this.store.getMemberTurn(active.id);
      if (!current) {
        continue;
      }
      try {
        fulfilled.push({
          member: current,
          result: await this.runner.cancel({
            conversationId: outcome.run.conversationId,
            topicId: outcome.run.topicId,
            sessionAlias: current.sessionAlias ?? "",
            queueItemId: current.queueItemId,
            promptRequestId: current.sourceTurnId ?? "",
          }),
        });
      } catch (error) {
        firstError ??= error;
      }
    }
    // Two-phase settlement: persist ALL observed outcomes as member evidence
    // in one transaction first, then aggregate the Run once — even when a
    // sibling cancel threw. A sibling's unknown can never erase another
    // member's proven completion/failure: A=indeterminate + B=completed
    // yields B=completed with evidence and Run=indeterminate.
    // Evidence-only when partial: with a throw pending, settle member rows
    // but skip Run aggregation/release so retry re-derives the outcome from
    // complete evidence instead of a half-persisted aggregate.
    const settled = this.store.settleCancelBatch({
      runId: outcome.run.id,
      now: this.now().toISOString(),
      outcomes: fulfilled.map((entry) => ({
        memberTurnId: entry.member.id,
        outcome: entry.result.outcome,
        ...(entry.result.outcome === "completed" ? { content: entry.result.text ?? "" } : {}),
        ...(entry.result.outcome === "completed"
          ? { sourceTurn: { sessionAlias: entry.member.sessionAlias ?? "", turnId: entry.member.sourceTurnId } }
          : {}),
        ...(entry.result.outcome === "failed" ? { reason: entry.result.error ?? "failed" } : {}),
      })),
      ...(firstError !== undefined ? { deferRunAggregate: true } : {}),
    });
    for (const entry of settled.settled) {
      if (entry.outcome === "completed" && entry.message) {
        this.emitTerminalProjection(settled.run, entry.member, entry.message);
      } else {
        this.emitRunAndMember(settled.run, entry.member.id);
      }
    }
    if (firstError !== undefined) {
      throw firstError;
    }
    await this.kick();
  }

  private claimOne(): ClaimedWork | undefined {
    return this.store.claimNextDispatch({
      now: this.now().toISOString(),
      owner: this.ownerId,
      leaseExpiresAt: new Date(this.now().getTime() + this.leaseMs).toISOString(),
      authorityEpoch: this.authorityEpoch,
      ...(this.deferredTopicIds.size > 0 ? { skipTopicIds: [...this.deferredTopicIds] } : {}),
    });
  }

  private async execute(work: ClaimedWork): Promise<void> {
    await this.hooks?.afterClaim?.(work);
    const current = this.store.getRun(work.run.id);
    if (
      !current
      || current.state === "cancelled"
      || current.state === "failed"
      || current.state === "completed"
      || current.state === "indeterminate"
    ) {
      return;
    }
    let started: MemberTurnRecord | undefined;
    try {
      await this.hooks?.beforeRuntimeMaterialize?.(work);
      const materializeFail = this.resolveMaterializeFail();
      if (materializeFail) {
        throw materializeFail;
      }
      const snapshot = work.memberSnapshot ?? work.memberTurn.profileSnapshot ?? work.run.profileSnapshot;
      const live = this.runtime.getBot(work.memberTurn.botId);
      if (live.agent !== snapshot.execution.agent || live.workspace !== snapshot.execution.workspace) {
        this.failOwnClaimBeforeStart(work, "runtime_revision_mismatch");
        return;
      }
      await this.hooks?.afterAcceptedIdentityCheck?.(work);
      const binding = await this.runtime.getOrCreateDirectSession({
        botId: work.memberTurn.botId,
        conversationId: work.run.conversationId,
        topicId: work.run.topicId,
        execution: snapshot.execution,
        assertStillDispatchable: () => {
          this.store.assertLiveDispatchForMaterialize({
            dispatchId: work.dispatch.id,
            owner: this.ownerId,
            generation: work.dispatch.generation,
            runId: work.run.id,
            memberTurnId: work.memberTurn.id,
            conversationId: work.run.conversationId,
            topicId: work.run.topicId,
            now: this.now().toISOString(),
          });
        },
      });
      const session = this.sessions.getLogicalSessionRecord(binding.sessionAlias);
      if (!session || !sessionMatchesExecution(session, snapshot.execution)) {
        this.failOwnClaimBeforeStart(work, "runtime_revision_mismatch");
        return;
      }
      await this.hooks?.beforeExecutionStart?.(work);
      const latestBeforeStart = this.store.getRun(work.run.id);
      if (!latestBeforeStart || latestBeforeStart.state === "cancelled") {
        this.store.cancelRun(work.run.id, this.now().toISOString());
        return;
      }
      const sourceTurnId = createSourceTurnId();
      try {
        started = this.store.markExecutionStarted({
          dispatchId: work.dispatch.id,
          owner: this.ownerId,
          generation: work.dispatch.generation,
          runId: work.run.id,
          memberTurnId: work.memberTurn.id,
          sessionAlias: binding.sessionAlias,
          logicalSessionId: binding.logicalSessionId,
          sourceTurnId,
          now: this.now().toISOString(),
        });
      } catch (error) {
        if (error instanceof ConversationError && (error.code === "stale_claim" || error.code === "run_not_runnable")) {
          return;
        }
        throw error;
      }
      await this.hooks?.afterExecutionStart?.(started);
      const latestRun = this.store.getRun(work.run.id);
      const latestMember = this.store.getMemberTurn(started.id);
      if (
        !latestRun
        || latestRun.state !== "running"
        || !latestMember
        || latestMember.state !== "running"
        || latestMember.sourceTurnId !== sourceTurnId
      ) {
        return;
      }
      this.emitProduct({ type: "conversation-run-changed", run: latestRun });
      this.emitProduct({ type: "member-turn-started", run: latestRun, memberTurn: latestMember });
      const text = composeBotTurnPromptFromSnapshot(snapshot, this.requestText(work.run.requestMessageId));
      const result = await this.runner.run({
        conversationId: work.run.conversationId,
        topicId: work.run.topicId,
        botId: work.memberTurn.botId,
        runId: work.run.id,
        memberTurnId: started.id,
        sessionAlias: binding.sessionAlias,
        logicalSessionId: binding.logicalSessionId,
        text,
        executionOrigin: conversationExecutionOrigin(
          this.store.getDispatchForMemberTurn(started.id)?.authorityEpoch,
          this.authorityEpoch,
          this.store.getDispatchForMemberTurn(started.id)?.humanIngress,
        ),
        ...(() => {
          const live = this.store.getDispatchForMemberTurn(started.id);
          return conversationExecutionOrigin(live?.authorityEpoch, this.authorityEpoch, live?.humanIngress) === "human"
            && live?.humanIngress
            ? { permissionRoute: live.humanIngress }
            : {};
        })(),
        promptRequestId: sourceTurnId,
      });
      await this.hooks?.beforeResultPersist?.(work);
      this.persistResult(work, started, result);
    } catch (error) {
      if (isRuntimeRevisionMismatch(error)) {
        this.failOwnClaimBeforeStart(work, "runtime_revision_mismatch");
        return;
      }
      if (isMaterializeAbandoned(error)) {
        return;
      }
      if (started?.startedAt) {
        const run = this.store.failExecution({
          runId: work.run.id,
          memberTurnId: work.memberTurn.id,
          now: this.now().toISOString(),
          reason: "started_result_unknown",
          terminalState: "indeterminate",
        });
        this.emitRunAndMember(run, work.memberTurn.id);
        return;
      }
      this.releaseOwnClaim(work);
      this.deferredTopicIds.add(work.run.topicId);
    }
  }

  private failOwnClaimBeforeStart(work: ClaimedWork, reason: string): void {
    try {
      this.store.failClaimBeforeStart({
        dispatchId: work.dispatch.id,
        owner: this.ownerId,
        generation: work.dispatch.generation,
        runId: work.run.id,
        memberTurnId: work.memberTurn.id,
        now: this.now().toISOString(),
        reason,
      });
      const run = this.store.getRun(work.run.id);
      if (run) {
        this.emitRunAndMember(run, work.memberTurn.id);
      }
    } catch (error) {
      if (error instanceof ConversationError && error.code === "stale_claim") {
        return;
      }
      throw error;
    }
  }

  private releaseOwnClaim(work: ClaimedWork): void {
    try {
      this.store.releaseClaimToPending({
        dispatchId: work.dispatch.id,
        owner: this.ownerId,
        generation: work.dispatch.generation,
        now: this.now().toISOString(),
      });
    } catch (error) {
      if (error instanceof ConversationError && error.code === "stale_claim") {
        return;
      }
      throw error;
    }
  }

  private persistCancelOutcome(
    runId: string,
    member: MemberTurnRecord,
    result: ConversationTurnCancelResult,
  ): void {
    const latest = this.store.getRun(runId);
    if (latest && (latest.state === "completed" || latest.state === "failed" || latest.state === "indeterminate")) {
      return;
    }
    const now = this.now().toISOString();
    // Whole-Run human cancel settlement: every branch carries force-terminal
    // so an automatic Run can never return to routing after cancel. The
    // proven member outcome is still preserved (completed/failed message and
    // state); only the Run-level routing eligibility is sealed.
    if (result.outcome === "completed") {
      const completed = this.store.completeExecution({
        runId,
        memberTurnId: member.id,
        botId: member.botId,
        content: result.text ?? "",
        sourceTurn: { sessionAlias: member.sessionAlias ?? "", turnId: member.sourceTurnId },
        now,
        forceRunTerminalOnSettle: true,
      });
      this.emitTerminalProjection(completed.run, completed.memberTurn, completed.assistantMessage);
      return;
    }
    if (result.outcome === "failed") {
      const run = this.store.failExecution({
        runId,
        memberTurnId: member.id,
        now,
        reason: result.error ?? "failed",
        forceRunTerminalOnSettle: true,
      });
      this.emitRunAndMember(run, member.id);
      return;
    }
    const run = this.store.completeCancel(runId, member.id, now, result.outcome === "unknown", true);
    this.emitRunAndMember(run, member.id);
  }

  private persistResult(
    work: ClaimedWork,
    started: MemberTurnRecord,
    result: Awaited<ReturnType<ConversationTurnRunner["run"]>>,
  ): void {
    const now = this.now().toISOString();
    if (result.status === "completed") {
      const completed = this.store.completeExecution({
        runId: work.run.id,
        memberTurnId: started.id,
        botId: work.memberTurn.botId,
        content: result.text ?? "",
        sourceTurn: { sessionAlias: started.sessionAlias ?? "", turnId: started.sourceTurnId },
        now,
      });
      this.emitTerminalProjection(completed.run, completed.memberTurn, completed.assistantMessage);
      return;
    }
    if (result.status === "cancelled") {
      const run = this.store.completeCancel(work.run.id, started.id, now, result.unknown === true, true);
      this.emitRunAndMember(run, started.id);
      return;
    }
    const run = this.store.failExecution({
      runId: work.run.id,
      memberTurnId: started.id,
      now,
      reason: result.error ?? "failed",
    });
    this.emitRunAndMember(run, started.id);
  }

  private emitTerminalProjection(
    run: import("./conversation-types").ConversationRun,
    memberTurn: MemberTurnRecord,
    assistantMessage?: import("./conversation-types").ConversationMessage,
  ): void {
    this.emitProduct({ type: "conversation-run-changed", run });
    this.emitProduct({ type: "member-turn-finished", run, memberTurn });
    if (assistantMessage) {
      this.emitProduct({ type: "conversation-message", message: assistantMessage });
    }
  }

  private emitRunAndMember(
    run: import("./conversation-types").ConversationRun,
    memberTurnId: string,
  ): void {
    this.emitProduct({ type: "conversation-run-changed", run });
    const memberTurn = this.store.getMemberTurn(memberTurnId);
    if (memberTurn) {
      this.emitProduct({ type: "member-turn-finished", run, memberTurn });
    }
  }

  private requestText(messageId: string): string {
    return this.store.getMessage(messageId)?.content ?? "";
  }

  private resolveMaterializeFail(): Error | undefined {
    const fail = this.hooks?.failRuntimeMaterialize;
    if (!fail) {
      return undefined;
    }
    if (fail === true) {
      return new Error("simulated AppState/runtime materialize failure");
    }
    const result = fail();
    if (result === true) {
      return new Error("simulated AppState/runtime materialize failure");
    }
    return result;
  }
}

function isRuntimeRevisionMismatch(error: unknown): boolean {
  return (error instanceof BotError || error instanceof ConversationError)
    && error.code === "runtime_revision_mismatch";
}

function isMaterializeAbandoned(error: unknown): boolean {
  return error instanceof ConversationError && (
    error.code === "stale_claim"
    || error.code === "run_not_runnable"
    || error.code === "conversation_deleting"
    || error.code === "topic_deleting"
  );
}
