import { randomUUID } from "node:crypto";

import { composeBotTurnPromptFromSnapshot } from "../bots/bot-profile-prompt";
import { BotError } from "../bots/bot-error";
import type { BotRuntimeManager } from "../bots/bot-runtime-manager";
import { sessionMatchesExecution } from "../bots/bot-types";
import { createSourceTurnId } from "../domain/ids";
import type { SessionService } from "../sessions/session-service";
import { ConversationError } from "./conversation-error";
import { conversationExecutionOriginFromMemberTurn } from "./conversation-execution";
import type { ClaimedWork, ConversationStore } from "./conversation-store";
import type {
  ConversationTurnCancelResult,
  ConversationTurnRunner,
} from "./conversation-turn-runner";
import type { MemberTurnRecord } from "./conversation-types";

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
}

const DEFAULT_LEASE_MS = 30_000;

export class ConversationDispatcher {
  private readonly now: () => Date;
  private readonly leaseMs: number;
  private readonly ownerId: string;
  readonly authorityEpoch: string;
  private readonly hooks?: ConversationDispatcherHooks;
  private draining = false;
  private kicked = false;
  private abortDrain = false;

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
  }

  async kick(): Promise<void> {
    this.kicked = true;
    if (this.draining) {
      return;
    }
    this.draining = true;
    try {
      for (;;) {
        this.kicked = false;
        this.abortDrain = false;
        this.store.recoverExpiredClaims(this.now().toISOString());
        const claimed = this.claimOne();
        if (!claimed) {
          if (this.kicked) {
            continue;
          }
          break;
        }
        await this.execute(claimed);
        if (this.abortDrain) {
          break;
        }
      }
    } finally {
      this.draining = false;
    }
  }

  async cancelRun(runId: string): Promise<void> {
    const now = this.now().toISOString();
    const outcome = this.store.cancelRun(runId, now);
    if (outcome.alreadyTerminal) {
      return;
    }
    if (!outcome.executionStarted) {
      await this.kick();
      return;
    }
    const result = await this.runner.cancel({
      conversationId: outcome.run.conversationId,
      topicId: outcome.run.topicId,
      sessionAlias: outcome.memberTurn.sessionAlias ?? "",
      queueItemId: outcome.memberTurn.queueItemId,
      promptRequestId: outcome.memberTurn.sourceTurnId ?? "",
    });
    this.persistCancelOutcome(outcome.run.id, outcome.memberTurn, result);
    await this.kick();
  }

  private claimOne(): ClaimedWork | undefined {
    return this.store.claimNextDispatch({
      now: this.now().toISOString(),
      owner: this.ownerId,
      leaseExpiresAt: new Date(this.now().getTime() + this.leaseMs).toISOString(),
      authorityEpoch: this.authorityEpoch,
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
      const snapshot = work.run.profileSnapshot;
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
      const text = composeBotTurnPromptFromSnapshot(snapshot, this.requestText(work.run.requestMessageId));
      const result = await this.runner.run({
        conversationId: work.run.conversationId,
        topicId: work.run.topicId,
        botId: work.memberTurn.botId,
        sessionAlias: binding.sessionAlias,
        logicalSessionId: binding.logicalSessionId,
        text,
        executionOrigin: conversationExecutionOriginFromMemberTurn(latestMember.origin),
        promptRequestId: sourceTurnId,
      });
      await this.hooks?.beforeResultPersist?.(work);
      this.persistResult(work, started, result);
    } catch (error) {
      if (isRuntimeRevisionMismatch(error)) {
        this.failOwnClaimBeforeStart(work, "runtime_revision_mismatch");
        return;
      }
      if (started?.startedAt) {
        this.store.failExecution({
          runId: work.run.id,
          memberTurnId: work.memberTurn.id,
          now: this.now().toISOString(),
          reason: "started_result_unknown",
          terminalState: "indeterminate",
        });
        return;
      }
      this.releaseOwnClaim(work);
      this.abortDrain = true;
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
    if (result.outcome === "completed") {
      this.store.completeExecution({
        runId,
        memberTurnId: member.id,
        botId: member.botId,
        content: result.text ?? "",
        sourceTurn: { sessionAlias: member.sessionAlias ?? "", turnId: member.sourceTurnId },
        now,
      });
      return;
    }
    if (result.outcome === "failed") {
      this.store.failExecution({
        runId,
        memberTurnId: member.id,
        now,
        reason: result.error ?? "failed",
      });
      return;
    }
    this.store.completeCancel(runId, member.id, now, result.outcome === "unknown");
  }

  private persistResult(
    work: ClaimedWork,
    started: MemberTurnRecord,
    result: Awaited<ReturnType<ConversationTurnRunner["run"]>>,
  ): void {
    const now = this.now().toISOString();
    if (result.status === "completed") {
      this.store.completeExecution({
        runId: work.run.id,
        memberTurnId: started.id,
        botId: work.memberTurn.botId,
        content: result.text ?? "",
        sourceTurn: { sessionAlias: started.sessionAlias ?? "", turnId: started.sourceTurnId },
        now,
      });
      return;
    }
    if (result.status === "cancelled") {
      this.store.completeCancel(work.run.id, started.id, now, result.unknown === true);
      return;
    }
    this.store.failExecution({
      runId: work.run.id,
      memberTurnId: started.id,
      now,
      reason: result.error ?? "failed",
    });
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
