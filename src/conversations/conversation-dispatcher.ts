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
import { isEffectConcurrencySafe } from "./conversation-filesystem-policy";
import {
  emitConversationProductEvent,
  type ConversationProductEvent,
  type ConversationProductEventSink,
} from "./conversation-product-events";
import type {
  ConversationTurnCancelResult,
  ConversationTurnRunInput,
  ConversationTurnRunResult,
  ConversationTurnRunner,
} from "./conversation-turn-runner";
import { TERMINAL_MEMBER_STATES, TERMINAL_RUN_STATES, type MemberTurnRecord, type PendingDispatch } from "./conversation-types";

/** Public transcript bound for one frozen Group batch. The window is taken
 *  newest-first immediately before the request boundary, so a Topic longer
 *  than this still hands members the closest prior context. */
export const PUBLIC_TRANSCRIPT_MESSAGES = 500;

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
  /** Executions currently holding provider turns. Keyed by dispatch id: while
   *  an execution is in flight its claim stays `claimed` (not requeueable) and
   *  its sibling-visibility comes from the durable member state, which
   *  `markExecutionStarted` sets to `running` before the provider turn begins.
   *  The drain loop awaits the SET, not each execution, so a second member can
   *  be claimed and started while the first is still running — subject to the
   *  Topic isolation policy, not to drain sequencing. Entries are removed in a
   *  `finally` so a throw can never strand the set (and with it the drain). */
  private readonly inFlightExecutions = new Map<string, Promise<void>>();

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
    // A failed drain rejects while provider turns it launched are still
    // running (the hold-time failure above rejects with A in flight). The
    // drain task no longer tracks them, so shutdown must await the in-flight
    // set directly — otherwise a test or host that shuts down right after a
    // drain failure leaks running executions.
    if (this.inFlightExecutions.size > 0) {
      await Promise.allSettled(this.inFlightExecutions.values());
    }
    // Retire unstarted writer-slot holds: a held claim is durably `claimed`
    // by a dispatcher that is going away. Without this, a fast restart
    // observes a live (unexpired) `claimed` row it can neither recover
    // (recoverExpiredClaims only sees expired leases) nor claim (claimOne
    // only returns `pending`) — the Run stalls until an unrelated wake, past
    // its lease and into provenance-stripping recovery. Retire returns each
    // hold to `pending` with owner cleared and a fresh lease window, keeping
    // generation/authorityEpoch/humanIngress/origin/attempt verbatim, so the
    // next consumer claims it as ordinary pending work on its first kick.
    // Only stale_claim is swallowed per hold (already gone elsewhere); other
    // store errors propagate — a failed retire must be visible, not silent.
    for (const [dispatchId, work] of this.heldWriterSlotClaims) {
      try {
        this.store.retireHeldClaim({
          dispatchId,
          owner: this.ownerId,
          generation: work.dispatch.generation,
          now: this.now().toISOString(),
        });
      } catch (error) {
        if (!(error instanceof ConversationError) || error.code !== "stale_claim") {
          throw error;
        }
      } finally {
        this.heldWriterSlotClaims.delete(dispatchId);
      }
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
        // The drain itself is alive and owns every held claim: renew them
        // BEFORE recoverExpiredClaims() runs, so a scheduling wait that
        // outlasts one lease is never mistaken for a dead owner. Renewal
        // keeps owner/generation/provenance; only the expiry moves. A hold
        // that lost its race (stale owner, bumped generation, recovered
        // elsewhere) fails the fence and is dropped from the hold set.
        this.renewHeldClaims();
        for (;;) {
          if (this.closed) {
            return;
          }
          this.store.recoverExpiredClaims(this.now().toISOString());
          const claimed = this.claimOne();
          if (!claimed) {
            break;
          }
          // PR7 filesystem scheduling: a claimed Group sibling that must
          // take the Topic single-writer slot waits while another member of
          // the same Run is already executing. The claim is parked WITHOUT
          // touching durable provenance (see holdClaimForWriterSlot) and the
          // Topic deferred for this pass so the sibling finishes first. The
          // sibling's completion persist re-wakes the drain (every terminal
          // persistResult kicks), which starts a fresh pass with the deferred
          // set cleared. The Run card still presents one multi-member batch.
          if (this.mustDeferForWriterSlot(claimed)) {
            this.holdClaimForWriterSlot(claimed);
            break;
          }
          // Executions run concurrently: the drain launches each claimed
          // member and keeps draining. Sibling overlap is decided by the
          // isolation policy above, never by drain ordering — a read-only
          // sibling is claimed and started while the first still runs.
          // The loop awaits the SET (below), so kick() still settles only
          // after every launched execution finishes.
          const execution = this.execute(claimed);
          this.inFlightExecutions.set(claimed.dispatch.id, execution);
          void execution.finally(() => {
            if (this.inFlightExecutions.get(claimed.dispatch.id) === execution) {
              this.inFlightExecutions.delete(claimed.dispatch.id);
            }
          });
        }
        // Settle launched executions, then re-check held writer-slot claims —
        // ALWAYS, not only when something was in flight. A held sibling
        // becomes runnable the moment its sibling's provider turn settles,
        // and the drain executes the SAME held claim object (still ours,
        // still human) in this pass — no re-claim, no provenance rewrite —
        // so a two-member Run under shared-single-writer completes without
        // an extra wake. The recheck must also run when the in-flight set is
        // empty: a previous pass may have launched, settled, and parked a
        // hold (or thrown mid-recheck), and nothing else will pick that hold
        // back up — claimOne only returns `pending` rows, never our live
        // `claimed` hold.
        if (this.inFlightExecutions.size > 0) {
          await Promise.allSettled(this.inFlightExecutions.values());
        }
        // The deferred set belongs to the pass that just ended: per-pass
        // deferrals must not leak into the recheck, or a held claim can
        // never become runnable inside this drain.
        this.deferredTopicIds.clear();
        const held = this.recheckHeldClaims();
        if (held) {
          const execution = this.execute(held);
          this.inFlightExecutions.set(held.dispatch.id, execution);
          void execution.finally(() => {
            if (this.inFlightExecutions.get(held.dispatch.id) === execution) {
              this.inFlightExecutions.delete(held.dispatch.id);
            }
          });
          continue;
        }
      }
    } finally {
      this.draining = false;
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
    const cancels = outcome.activeMembers.map(async (active) => {
      const current = this.store.getMemberTurn(active.id);
      if (!current) {
        return;
      }
      try {
        const result = await this.runner.cancel({
          conversationId: outcome.run.conversationId,
          topicId: outcome.run.topicId,
          sessionAlias: current.sessionAlias ?? "",
          queueItemId: current.queueItemId,
          promptRequestId: current.sourceTurnId ?? "",
        });
        fulfilled.push({ member: current, result });
      } catch (error) {
        firstError ??= error;
      }
    });
    // Concurrent fan-out (one runner.cancel per active member): each cancel
    // resolves only after its own provider turn settles, so awaiting them one
    // by one would serialize independent transports. allSettled-style via the
    // per-callback try/catch above — Promise.all here never rejects.
    await Promise.all(cancels);
    // Two-phase settlement: persist ALL observed outcomes as member evidence
    // in one transaction first, then aggregate the Run once — even when a
    // sibling cancel threw. A sibling's unknown can never erase another
    // member's proven completion/failure: A=indeterminate + B=completed
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
  /**
   * PR7 filesystem scheduling gate. PR7 accepts carry no proven read-only
   * capability, so every Group member is conservatively unknown and takes
   * the Topic single-writer slot. While another member of the same Run is
   * already executing, a newly claimed sibling defers instead of running
   * concurrently. Direct Runs are unaffected.
   *
   * Isolation is read from the Topic's durable ExecutionTarget: `shared`
   * allows the overlap (nothing here serializes it), `shared-single-writer`
   * and `worktree-per-member` (unprovisioned in PR7) allow a second member
   * only when it is enforceably read-only — and since PR7 carries no proven
   * capability, every PR7 member defers. `MemberTurnEffect` attaches to the
   * assignment when callers can prove read-only; until then the effect is
   * `undefined` (unproven), which never counts as safe.
   */
  private mustDeferForWriterSlot(work: ClaimedWork): boolean {
    if (this.runtime.conversationKind(work.run.conversationId) !== "group") {
      return false;
    }
    const siblings = this.store.listMemberTurns(work.run.id);
    const otherExecuting = siblings.filter((turn) => turn.id !== work.memberTurn.id
      && (turn.state === "running" || turn.state === "dispatched"));
    if (otherExecuting.length === 0) {
      return false;
    }
    const isolation = this.runtime.groupTopicIsolation(work.run.conversationId, work.run.topicId);
    return !isEffectConcurrencySafe(work.memberTurn.effect, isolation, otherExecuting.length, work.memberTurn.effectProvenance);
  }

  /** Writer-slot-held claims, keyed by dispatch id. The drain KEEPS the
   *  ClaimedWork object across passes: the claim stays `claimed` under this
   *  owner (durable provenance untouched), and the next pass executes the
   *  SAME object — no re-claim, no generation bump, no provenance rewrite.
   *  Entries are removed when executed, when the Run goes terminal, or when
   *  the dispatch stops being ours. A sibling that never finishes leaves its
   *  held claim parked until a later kick reaps it through the normal
   *  pre-start fences in execute(). */
  private readonly heldWriterSlotClaims = new Map<string, ClaimedWork>();
  /** Extend every live held claim's lease. Called once per drain pass,
   *  BEFORE recoverExpiredClaims(): while this drain is alive and holds the
   *  claim object, the owner is by definition not dead, so expiry must not
   *  trigger crash recovery. Holds that fail the fence (lost race, recovered
   *  elsewhere, Run terminal) are dropped; the normal paths reap them. */
  private renewHeldClaims(): void {
    const now = this.now().toISOString();
    const leaseExpiresAt = new Date(this.now().getTime() + this.leaseMs).toISOString();
    for (const [dispatchId, work] of this.heldWriterSlotClaims) {
      try {
        const renewed = this.store.renewHeldClaim({
          dispatchId,
          owner: this.ownerId,
          generation: work.dispatch.generation,
          now,
          leaseExpiresAt,
        });
        this.heldWriterSlotClaims.set(dispatchId, { ...work, dispatch: renewed });
      } catch (error) {
        // Only a lost race drops the hold: anything else (SQLite I/O,
        // driver failure) must fail the drain visibly rather than silently
        // orphan a durable claim that is still ours.
        if (error instanceof ConversationError && error.code === "stale_claim") {
          this.heldWriterSlotClaims.delete(dispatchId);
          continue;
        }
        throw error;
      }
    }
  }

  private holdClaimForWriterSlot(work: ClaimedWork): void {
    // Register FIRST, renew second. The durable dispatch is already `claimed`
    // by us at this point; if the renewal below throws a non-stale store
    // error, the drain fails visibly — but the hold must already exist so
    // the NEXT kick's per-pass renewHeldClaims() picks the claim back up
    // instead of leaving a `claimed` row no path can see (claimOne only
    // returns `pending`; recheck only sees registered holds). Only
    // stale_claim removes the registration: the claim is already gone (lost
    // race, cancelled Run), and execute()'s fences still guard the stale
    // object if it is somehow re-read.
    this.heldWriterSlotClaims.set(work.dispatch.id, work);
    try {
      const renewed = this.store.renewHeldClaim({
        dispatchId: work.dispatch.id,
        owner: this.ownerId,
        generation: work.dispatch.generation,
        now: this.now().toISOString(),
        leaseExpiresAt: new Date(this.now().getTime() + this.leaseMs).toISOString(),
      });
      this.heldWriterSlotClaims.set(work.dispatch.id, { ...work, dispatch: renewed });
    } catch (error) {
      if (error instanceof ConversationError && error.code === "stale_claim") {
        this.heldWriterSlotClaims.delete(work.dispatch.id);
        return;
      }
      throw error;
    }
    this.deferredTopicIds.add(work.run.topicId);
  }

  /** Re-check held claims whose Topic is no longer deferred and whose Run
   *  still needs them. A held claim whose sibling finished is executed
   *  inline (same claim, same generation); a held claim whose Run went
   *  terminal or whose dispatch is no longer ours is dropped. Returns the
   *  claim to execute, if any.
   *
   *  Lease protection: every live held claim gets its lease extended here,
   *  before the expiry check below. A serialized sibling may legitimately
   *  wait longer than one lease (LLM turns routinely exceed 30s); without
   *  renewal the next recoverExpiredClaims() would treat the scheduling wait
   *  as crash recovery — clearing authorityEpoch/humanIngress, rewriting
   *  origin to `recovery`, bumping attempt — and the member would execute
   *  without its original human permission route. Renewal keeps the SAME
   *  owner/generation/provenance; only the expiry moves. */
  private recheckHeldClaims(): ClaimedWork | undefined {
    const now = this.now().toISOString();
    for (const [dispatchId, work] of this.heldWriterSlotClaims) {
      if (this.deferredTopicIds.has(work.run.topicId)) {
        continue;
      }
      const live = this.store.getDispatchForMemberTurn(work.memberTurn.id);
      const run = this.store.getRun(work.run.id);
      if (!run || (TERMINAL_RUN_STATES as readonly string[]).includes(run.state)
        || !live || live.id !== dispatchId || live.state !== "claimed" || live.owner !== this.ownerId) {
        this.heldWriterSlotClaims.delete(dispatchId);
        continue;
      }
      // Renew first: an already-recovered held claim must NOT execute — its
      // lease lapsed while we were not watching, so recovery owns it now.
      // renewHeldClaim's fence rejects it (stale_claim) and we drop the hold;
      // the normal recovery path requeues it with fresh provenance rules.
      // Other store errors propagate: a failed renewal must not silently
      // delete the in-memory hold while the durable claim stays intact.
      let renewed: PendingDispatch;
      try {
        renewed = this.store.renewHeldClaim({
          dispatchId,
          owner: this.ownerId,
          generation: live.generation,
          now,
          leaseExpiresAt: new Date(this.now().getTime() + this.leaseMs).toISOString(),
        });
      } catch (error) {
        if (error instanceof ConversationError && error.code === "stale_claim") {
          this.heldWriterSlotClaims.delete(dispatchId);
          continue;
        }
        throw error;
      }
      if (this.mustDeferForWriterSlot({ ...work, dispatch: renewed })) {
        this.deferredTopicIds.add(work.run.topicId);
        continue;
      }
      this.heldWriterSlotClaims.delete(dispatchId);
      return { ...work, dispatch: renewed };
    }
    return undefined;
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
      const isGroup = this.runtime.conversationKind(work.run.conversationId) === "group";
      if (!isGroup) {
        const live = this.runtime.getBot(work.memberTurn.botId);
        if (live.agent !== snapshot.execution.agent || live.workspace !== snapshot.execution.workspace) {
          this.failOwnClaimBeforeStart(work, "runtime_revision_mismatch");
          return;
        }
      }
      await this.hooks?.afterAcceptedIdentityCheck?.(work);
      const assertStillDispatchable = (): void => {
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
      };
      const binding = isGroup
        ? await this.runtime.getOrCreateGroupMemberSession({
          botId: work.memberTurn.botId,
          conversationId: work.run.conversationId,
          topicId: work.run.topicId,
          execution: snapshot.execution,
          assertStillDispatchable,
        })
        : await this.runtime.getOrCreateDirectSession({
          botId: work.memberTurn.botId,
          conversationId: work.run.conversationId,
          topicId: work.run.topicId,
          execution: snapshot.execution,
          assertStillDispatchable,
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
      const text = isGroup
        ? composeBotTurnPromptFromSnapshot(snapshot, this.frozenGroupTranscript(work))
        : composeBotTurnPromptFromSnapshot(snapshot, this.requestText(work.run.requestMessageId));
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
      if (!started && isUnsupportedTarget(error)) {
        // A Topic whose durable target can never execute (unprovisioned
        // worktree, unsupported cwd, missing workspace) would otherwise stay
        // pending and requeue on every kick forever. Settle the claim
        // terminally before the execution-start CAS fence.
        this.failOwnClaimBeforeStart(work, error instanceof BotError ? error.code : "target_unsupported");
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
      // A deferred writer-slot sibling may be parked on this Topic: wake the
      // drain so it is claimed in a fresh pass. Fire-and-forget by design —
      // persistResult is sync and drain re-entry is generation-guarded.
      void this.kick().catch(() => {});
      return;
    }
    if (result.status === "cancelled") {
      const run = this.store.completeCancel(work.run.id, started.id, now, result.unknown === true, true);
      this.emitRunAndMember(run, started.id);
      void this.kick().catch(() => {});
      return;
    }
    const run = this.store.failExecution({
      runId: work.run.id,
      memberTurnId: started.id,
      now,
      reason: result.error ?? "failed",
    });
    this.emitRunAndMember(run, started.id);
    void this.kick().catch(() => {});
  }

  /**
   * Late provider settlement reached the dispatcher through the runner's
   * onLateResult seam (§14.3): the cancel-settle deadline already sealed the
   * scheduling outcome (Run indeterminate, or fan-out still awaiting
   * siblings), so this NEVER re-invokes the provider, claims work, or kicks
   * the drain. It only persists the proven result as durable evidence via
   * the store's reconciliation — a sealed indeterminate member reclassifies
   * (and re-derives the Run); a live Run under durable cancel intent records
   * member evidence only for the pending batch settlement. Every other Run
   * state is an evidence no-op. A reconciliation/store failure is swallowed:
   * the durable indeterminate seal keeps teardown fail-closed, and nothing
   * in the provider settlement path is in a position to observe or retry
   */
  reconcileLateProviderResult(input: ConversationTurnRunInput, result: ConversationTurnRunResult): void {
    try {
      if (result.status === "completed") {
        const reconciled = this.store.reconcileLateResult({
          runId: input.runId,
          memberTurnId: input.memberTurnId,
          outcome: "completed",
          content: result.text ?? "",
          sourceTurn: { sessionAlias: input.sessionAlias, turnId: input.promptRequestId },
          now: this.now().toISOString(),
        });
        if (reconciled.reconciled) {
          this.emitTerminalProjection(reconciled.run, reconciled.memberTurn, reconciled.message);
        }
        return;
      }
      if (result.status === "failed") {
        const reconciled = this.store.reconcileLateResult({
          runId: input.runId,
          memberTurnId: input.memberTurnId,
          outcome: "failed",
          reason: result.error ?? "failed",
          sourceTurn: { sessionAlias: input.sessionAlias, turnId: input.promptRequestId },
          now: this.now().toISOString(),
        });
        if (reconciled.reconciled) {
          this.emitRunAndMember(reconciled.run, reconciled.memberTurn.id);
        }
        return;
      }
      // A late "cancelled" carries no new evidence: the seal already recorded
      // the stronger unknown/cancelled outcome. Drop it.
    } catch {
      // Evidence persistence must never crash the provider settlement chain.
      // The durable indeterminate seal (and its fences) remain the source of
      // truth for teardown; retry is the operator's reconcile path.
    }
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

  /**
   * Frozen public transcript for one parallel explicit batch. Every primary
   * member carries `triggerMessageIds` stamped at durable accept; rendering
   * only messages at or before that boundary (plus the request itself) keeps
   * sibling completions from leaking into an already-selected input. Reads
   * durable Conversation rows only — never session hidden history, Direct
   * history, other Groups, or other Topics.
   */
  private frozenGroupTranscript(work: ClaimedWork): string {
    const request = this.store.getMessage(work.run.requestMessageId);
    const boundary = request?.seq;
    // The window is the newest PUBLIC_TRANSCRIPT_MESSAGES messages strictly
    // before the request boundary — never the oldest rows in the Topic. On a
    // Topic longer than the bound, the members closest to the request are the
    // relevant context; the tail is ahead of the boundary and is excluded
    // anyway, and the head predates what this batch can react to.
    const transcript = boundary === undefined
      ? []
      : this.store.listMessages({
        conversationId: work.run.conversationId,
        topicId: work.run.topicId,
        beforeSeq: boundary,
        limit: PUBLIC_TRANSCRIPT_MESSAGES,
      });
    const lines = transcript.map((message) => {
      if (message.role === "human") {
        return `Human: ${message.content}`;
      }
      const sender = message.senderBotId ? `Bot ${message.senderBotId}` : "Bot";
      return `${sender}: ${message.content}`;
    });
    const requestText = request?.content ?? this.requestText(work.run.requestMessageId);
    if (lines.length === 0) {
      return requestText;
    }
    return `${lines.join("\n\n")}\n\nHuman: ${requestText}`;
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
  ) || (error instanceof BotError
    && (error.code === "group_member_not_member"
      || error.code === "conversation_not_group"
      || error.code === "bot_not_found"));
}

/** Pre-start materialization refusals that will never succeed while the
 *  Topic's durable ExecutionTarget stays unchanged. Requeueing these spins
 *  forever on every kick, so the claim must settle terminally instead. */
function isUnsupportedTarget(error: unknown): boolean {
  return error instanceof BotError && (
    error.code === "worktree_unprovisioned"
    || error.code === "cwd_unsupported"
    || error.code === "workspace_not_registered"
  );
}
