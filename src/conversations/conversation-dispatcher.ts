import { randomUUID } from "node:crypto";

import { composeBotTurnPromptFromSnapshot } from "../bots/bot-profile-prompt";
import { BotError } from "../bots/bot-error";
import type { BotRuntimeManager } from "../bots/bot-runtime-manager";
import { sessionMatchesExecution } from "../bots/bot-types";
import { createSourceTurnId } from "../domain/ids";
import type { SessionService } from "../sessions/session-service";
import type { LogicalSession } from "../state/types";
import { ConversationError } from "./conversation-error";
import { isRunCancelling, requireMemberResult } from "./conversation-store";
import { conversationExecutionOrigin, conversationExecutionOriginFromMemberTurn } from "./conversation-execution";
import { publicMessageMatchesRunScope, requestSnapshotMatches, type ClaimedWork, type ConversationStore } from "./conversation-store";
import { isEffectConcurrencySafe } from "./conversation-filesystem-policy";
import {
  ResourceReservationTable,
  canonicalizePhysicalPath,
  physicalResourceKey,
  type PhysicalResourceIdentity,
  type ResourceReservation,
} from "./conversation-resource-admission";
import {
  TopicFairnessRotator,
  hasGlobalCapacity,
  resolveMaxConcurrentRunExecutions,
} from "./conversation-admission-policy";
import type { GroupHandoffService } from "./group-handoff";
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
import { TERMINAL_MEMBER_STATES, TERMINAL_RUN_STATES, type ConversationRun, type MemberTurnRecord, type PendingDispatch } from "./conversation-types";

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

/** Injected so tests can fire lease renewal without a wall-clock sleep. */
export interface LeaseScheduler {
  schedule(delayMs: number, callback: () => void): { cancel(): void };
}

/**
 * Renewal period for a live claim. At most one third of the lease, and at
 * least 1ms, so a single delayed tick cannot by itself expire a lease of
 * 3ms or more.
 */
export function claimLeaseRenewalDelayMs(leaseMs: number): number {
  if (!Number.isFinite(leaseMs) || leaseMs < 1) {
    throw new Error("leaseMs must be a positive number of milliseconds");
  }
  return Math.max(1, Math.floor(leaseMs / 3));
}

function defaultLeaseScheduler(): LeaseScheduler {
  return {
    schedule(delayMs, callback) {
      const handle = setTimeout(callback, delayMs);
      if (typeof handle === "object" && handle !== null && "unref" in handle && typeof handle.unref === "function") {
        handle.unref();
      }
      return { cancel: () => clearTimeout(handle) };
    },
  };
}

export interface ConversationDispatcherOptions {
  now?: () => Date;
  leaseMs?: number;
  ownerId?: string;
  /** Process-lifetime authority epoch. Accept stamps it; claim compares it. */
  authorityEpoch?: string;
  hooks?: ConversationDispatcherHooks;
  onProductEvent?: ConversationProductEventSink;
  /** Defaults to an unref'd timer. Tests pass a manual clock. */
  leaseScheduler?: LeaseScheduler;
  /** PR C: ceiling on concurrently executing member turns across all Runs.
   *  Undefined uses the documented default; invalid values fall back to it
   *  rather than being coerced to 0 or treated as unlimited. */
  maxConcurrentRunExecutions?: number;
}

/**
 * PR8 automatic-Run continuation seam. Invoked by the dispatcher as soon as
 * a batch settles on an automatic Run (every batch member terminal and the
 * Run still nonterminal). The handler decides whether to route again; the
 * dispatcher never routes itself.
 */
export type AutomaticRoutingHandler = (runId: string) => void;

const DEFAULT_LEASE_MS = 30_000;

export class ConversationDispatcher {
  private worktrees?: import("./conversation-worktree-manager").ConversationWorktreeManager;
  setWorktreeManager(manager: import("./conversation-worktree-manager").ConversationWorktreeManager): void { this.worktrees = manager; }
  private readonly now: () => Date;
  private readonly leaseMs: number;
  /** Stable per-process claim owner. Published so activation can sweep
   *  previous-owner claims after acquiring the exclusive consumer lock. */
  readonly ownerId: string;
  readonly authorityEpoch: string;
  private readonly hooks?: ConversationDispatcherHooks;
  private draining = false;
  private wakeGeneration = 0;
  /** Resolved whenever a wake is raised, so a drain blocked on in-flight work
   *  can re-scan immediately instead of staying parked until a turn settles.
   *  Without this, a long Provider turn on one Topic would hold the `draining`
   *  guard and silently drop every other Topic's kick — head-of-line blocking. */
  private wakeSignal: Promise<void> = Promise.resolve();
  private resolveWakeSignal?: () => void;
  /** Topics that failed pre-start in this drain pass. Skipped so a poison row
   *  cannot starve other Topics. A later wake generation starts a fresh pass
   *  with this set cleared; without a new wake the poison Topic does not
   *  hot-loop. */
  private readonly deferredTopicIds = new Set<string>();
  private readonly onProductEvent?: ConversationProductEventSink;
  /** PR8 automatic continuation. Set by the composition/runtime (not the
   *  constructor) because the routing service owns the dispatcher, mirroring
   *  the runner's late-result handler wiring. */
  private onAutomaticBatchSettled?: AutomaticRoutingHandler;
  private closed = false;
  private handoffs?: GroupHandoffService;
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
  private readonly inFlightWork = new Map<string, ClaimedWork>();
  private readonly leaseScheduler: LeaseScheduler;
  private leaseTicket: { cancel(): void } | undefined;
  /** Serializes renewal ticks so shutdown can wait for the one in progress. */
  private leaseRenewalTask: Promise<void> = Promise.resolve();
  private leaseKeeperStopped = false;
  /** Separate from the error value so `throw undefined` is still a recorded failure. */
  private leaseFailure: { error: unknown } | undefined;
  /** Unexpected drain failure that is not a dead lease keeper. A later explicit
   *  kick may still drain work already accepted; accept stays fail-closed. */
  private schedulingFailure: { error: unknown } | undefined;
  /** Set by ConversationRunService so the first fatal scheduling error fail-closes accept and can be logged. */
  private onFatalSchedulingError?: (error: unknown) => void;
  /** PR C: bounded global admission. Never exceeded, so a busy host cannot
   *  start an unbounded number of Provider turns across independent Runs. */
  private readonly maxConcurrentRunExecutions: number;
  /** PR C: Topic round-robin so a high-traffic Topic cannot starve the rest. */
  private readonly fairness = new TopicFairnessRotator();
  /** Cross-Run physical resource reservations. In-memory only — the
   *  durable claim, lease and generation fences remain the sole authority. */
  private readonly resourceReservations = new ResourceReservationTable();
  /** Held claims parked by a CROSS-RUN resource conflict, keyed by this
   *  dispatch id → the blocking holder's dispatch id. Lets the recheck tell a
   *  resource wait (retry when the blocker settles) apart from a same-Run
   *  writer-slot hold (retry when the sibling settles) without re-deriving
   *  either, and lets a blocker's release wake exactly the claims it blocked. */
  private readonly resourceConflictHolds = new Map<string, string>();

  constructor(
    private readonly store: ConversationStore,
    private readonly runtime: BotRuntimeManager,
    private readonly runner: ConversationTurnRunner,
    private readonly sessions: Pick<SessionService, "getLogicalSessionRecord" | "getResolvedSessionByInternalAlias">,
    options?: ConversationDispatcherOptions,
  ) {
    this.now = options?.now ?? (() => new Date());
    this.leaseMs = options?.leaseMs ?? DEFAULT_LEASE_MS;
    this.ownerId = options?.ownerId ?? `dispatcher:${process.pid}:${randomUUID()}`;
    this.authorityEpoch = options?.authorityEpoch ?? randomUUID();
    this.hooks = options?.hooks;
    this.onProductEvent = options?.onProductEvent;
    this.leaseScheduler = options?.leaseScheduler ?? defaultLeaseScheduler();
    this.maxConcurrentRunExecutions = resolveMaxConcurrentRunExecutions({
      ...(options?.maxConcurrentRunExecutions !== undefined ? { maxConcurrentRunExecutions: options.maxConcurrentRunExecutions } : {}),
    });
    this.armLeaseKeeper();
  }

  /** The Run service registers this before activation. The first fatal
   *  scheduling error invokes it once, synchronously, with the original
   *  value, before that value is rethrown. */
  setFatalSchedulingHandler(handler: (error: unknown) => void): void {
    this.onFatalSchedulingError = handler;
  }

  async kick(): Promise<void> {
    this.surfaceLeaseFailure();
    this.wakeGeneration += 1;
    // Release any drain blocked on in-flight work so it re-scans now. The
    // resolver is swapped first so the NEXT block waits on a fresh signal.
    this.resolveWakeSignal?.();
    const { promise, resolve } = Promise.withResolvers<void>();
    this.wakeSignal = promise;
    this.resolveWakeSignal = resolve;
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
      // A completed drain recovered from a previous claim/execute failure.
      // The lease-keeper failure stays sticky. Accept stays fail-closed
      // until process restart; this only stops shutdown from re-reporting
      // an error a later kick already got past.
      this.schedulingFailure = undefined;
    } catch (error) {
      this.noteSchedulingFailure(error);
      throw error;
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

  /**
   * Test seam: return every writer-slot hold to durable `pending` and forget
   * it, without the rest of shutdown. Models a crash where this process dies
   * before its held claims ever start, so a fixture can assert recovery from a
   * genuinely unclaimed row. Production never calls this — shutdown retires the
   * same way as part of teardown.
   */
  retireHeldClaimsForTest(): void {
    for (const [dispatchId, work] of [...this.heldWriterSlotClaims]) {
      this.store.retireHeldClaim({
        dispatchId,
        owner: this.ownerId,
        generation: work.dispatch.generation,
        now: this.now().toISOString(),
      });
      this.heldWriterSlotClaims.delete(dispatchId);
    }
    this.deferredTopicIds.clear();
  }

  async shutdown(): Promise<void> {
    this.closed = true;
    this.stopLeaseKeeper();
    await this.leaseRenewalTask;
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
    // by a dispatcher that is going away. Graceful retire is an optimization
    // (activation's convergePreviousOwnerClaims is the correctness backstop),
    // but without this a fast restart would fall back to lease-driven
    // recovery: a live (unexpired) `claimed` row it can neither recover
    // (recoverExpiredClaims only sees expired leases) nor claim (claimOne
    // only returns `pending`) — unstarted rows into provenance-stripping
    // recovery, started rows stalled behind the old lease instead of sealing
    // immediately at handoff. Retire returns each hold to `pending` with
    // owner cleared and a fresh lease window, keeping
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
        // stale_claim means the hold already resolved elsewhere (recovered,
        // started, terminal): forget it. Any OTHER store error keeps the
        // hold registered — the durable row may still be our live `claimed`
        // claim, and deleting the in-memory entry would orphan it from every
        // recovery path this process still owns. The error still propagates
        // so shutdown fails visibly instead of reporting a clean retire.
        if (error instanceof ConversationError && error.code === "stale_claim") {
          this.heldWriterSlotClaims.delete(dispatchId);
          continue;
        }
        throw error;
      }
      this.heldWriterSlotClaims.delete(dispatchId);
    }
    this.surfaceShutdownFailure();
    // Cross-Run reservations are in-memory only: nothing durable depends on
    // them, and this process is going away, so they cannot gate any future
    // work. The next process converges through the durable claim/lease path.
    this.resourceReservations.clear();
    this.resourceConflictHolds.clear();
  }

  private async runDrain(): Promise<void> {
    // Unexpected-failure capture: execute() rejections that escape its
    // handled settlement paths must reject kick() — and therefore fail
    // activation — after every launched execution settles. Each launch gets
    // its own outcome cell: the settle handlers write ONLY their cell (no
    // shared mutable error state, no clear-then-throw race window), and the
    // drain consumes the cohort exactly once, in LAUNCH order — so the
    // rethrown failure is deterministic and attributable, never whichever
    // rejection happened to settle first.
    // `rejected` is a STATUS, not a payload test: a member execution may
    // legally reject with `undefined`, which must still propagate.
    const cohort: Array<{
      guard: Promise<void>;
      outcome: { status: "pending" | "fulfilled" | "rejected"; reason?: unknown };
    }> = [];
    const launchExecution = (work: ClaimedWork): void => {
      const outcome: { status: "pending" | "fulfilled" | "rejected"; reason?: unknown } = { status: "pending" };
      const releasePhysicalResource = (): void => {
        // The resource is free the moment the Provider turn settles, whether the
        // turn completed, failed, or was cancelled. Leaving it held would
        // serialize unrelated Runs behind a finished one. Any claim this one was
        // blocking must also be re-runnable, so drop its conflict marker too.
        this.resourceReservations.release(work.dispatch.id);
        for (const [held, blocker] of [...this.resourceConflictHolds]) {
          if (blocker === work.dispatch.id) this.resourceConflictHolds.delete(held);
        }
      };
      // The guard never rejects (both handlers settle normally), so no
      // `finally` child can leak an unhandled rejection; it settles only
      // AFTER its handler ran, so awaiting every guard means every outcome
      // cell is final.
      const guard = this.execute(work).then(
        () => {
          releasePhysicalResource();
          if (this.inFlightExecutions.get(work.dispatch.id) === guard) {
            this.inFlightExecutions.delete(work.dispatch.id);
            this.inFlightWork.delete(work.dispatch.id);
          }
        },
        (error: unknown) => {
          outcome.status = "rejected";
          outcome.reason = error;
          releasePhysicalResource();
          if (this.inFlightExecutions.get(work.dispatch.id) === guard) {
            this.inFlightExecutions.delete(work.dispatch.id);
            this.inFlightWork.delete(work.dispatch.id);
          }
        },
      );
      this.inFlightExecutions.set(work.dispatch.id, guard);
      this.inFlightWork.set(work.dispatch.id, work);
      cohort.push({ guard, outcome });
    };
    const awaitCohortInFlight = async (): Promise<void> => {
      const launched = cohort.splice(0);
      if (launched.length === 0) {
        return;
      }
      await Promise.allSettled(launched.map((entry) => entry.guard));
      const failure = launched.find((entry) => entry.outcome.status === "rejected");
      if (failure) {
        throw failure.outcome.reason;
      }
    };
    // A logical drain = one global first claim, then same-Run siblings
    // only (cohortRunId) for that PASS, until the cohort settles or a held
    // handoff continues the SAME run without a new global claim. A pass
    // that defers Topics on pre-start failures chains a same-scope extra
    // pass (no wake consumed, deferrals preserved) when unrelated pending
    // work may remain; a chained pass that claims nothing ends the drain —
    // a failed Topic is never retried without a fresh wake.
    let seen = 0;
    let chainedExtraPass = false;
    try {
      while (seen !== this.wakeGeneration || chainedExtraPass) {
        if (this.closed) {
          return;
        }
        if (!chainedExtraPass) {
          seen = this.wakeGeneration;
          this.deferredTopicIds.clear();
        }
        chainedExtraPass = false;
        // Cohort scope and progress are PER PASS: a held handoff is awaited
        // inline, so the next pass starts with an empty in-flight set and a
        // fresh global first claim.
        // The drain itself is alive and owns every held claim: renew them
        // BEFORE recoverExpiredClaims() runs, so a scheduling wait that
        // outlasts one lease is never mistaken for a dead owner. Renewal
        // keeps owner/generation/provenance; only the expiry moves. A hold
        // that lost its race (stale owner, bumped generation, recovered
        // elsewhere) fails the fence and is dropped from the hold set.
        // Holds this drain already finished (dispatch no longer claimed)
        // are dropped before renewal: renewing them would throw a visible
        // stale_claim on a healthy drain.
        for (const [dispatchId, work] of this.heldWriterSlotClaims) {
          const live = this.store.getDispatchForMemberTurn(work.memberTurn.id);
          if (!live || live.id !== dispatchId || live.state !== "claimed") {
            this.heldWriterSlotClaims.delete(dispatchId);
          }
        }
        this.renewOwnedClaims();
        // Cross-Run cohort (PR C): independent Runs execute concurrently.
        // The cohort is a SET of Run ids rather than one Run: the first claim
        // goes out globally, and afterwards any Run whose Topic still has
        // durable capacity may join, so a Run blocked by a resource conflict
        // or a pre-start failure never blocks a compatible one. Same-Topic
        // strict serialization is NOT relaxed here — it stays a durable
        // claim-time invariant in claimNextDispatch, so at most one Run per
        // Topic can ever be in this set.
        const cohortRunIds = new Set<string>();
        // True once this pass claimed anything (launched or held): the
        // extra-pass decision below may only chain off a pass that made
        // progress, never off an empty preview.
        let passProgress = false;
        // Renew ONCE per pass, before the claim loop — not on every iteration.
        // A pass that parks on an in-flight turn (ceiling wait, refill wait)
        // re-enters this loop, and renewing each time would keep the store busy
        // for the whole Provider turn. That breaks the documented "a parked
        // drain performs no further sqlite access" precondition a crash-recovery
        // test relies on, and it is unnecessary: the lease keeper renews on its
        // own schedule while the turn is open.
        //
        // Renewal MUST still precede recoverExpiredClaims() so a scheduling wait
        // that outlasts one lease is never mistaken for a dead owner.
        this.renewOwnedClaims();
        this.store.recoverExpiredClaims(this.now().toISOString());
        for (;;) {
          if (this.closed) {
            return;
          }
          // Bounded global admission: never start more Provider turns than the
          // configured ceiling. Over-ceiling work simply stays `pending` for a
          // later pass — nothing durable is rewritten.
          //
          // At the ceiling, block on ONE in-flight settle — or on a wake — and
          // then re-claim. Falling through to the pass tail's
          // awaitCohortInFlight would keep the freed capacity idle until every
          // other Run finished, which is the head-of-line blocking this change
          // removes. Racing the wake keeps a newly accepted Run on another Topic
          // from waiting behind a long turn that already holds the ceiling.
          if (!hasGlobalCapacity(this.inFlightExecutions.size, this.maxConcurrentRunExecutions)) {
            if (this.inFlightExecutions.size === 0) break;
            await Promise.race([...this.inFlightExecutions.values(), this.wakeSignal]);
            continue;
          }
          // Cross-Run admission (PR C): claims stay GLOBAL. The durable store
          // already forbids two Runs of one Topic from both holding claims, so
          // a global scan can only ever return a Run from a different Topic —
          // which is precisely the overlap this change enables. The old code
          // pinned the scan to the first Run's id, which is what prevented it.
          const claimed = this.claimNextFair();
          if (!claimed) {
            // Nothing more is claimable right now. Keep the drain alive while
            // our own work is in flight, so a finishing member refills its
            // capacity in THIS pass — the pre-PR refill semantics.
            //
            // Block on the in-flight set OR on a wake, rather than polling.
            // Blocking (not polling) is what keeps a parked drain free of store
            // access while a Provider turn is open — the precondition
            // crash-recovery relies on — and what stops an idle dispatcher from
            // spinning. Racing the wake is what stops head-of-line blocking:
            // without it, a long turn would hold the `draining` guard and
            // silently drop another Topic's kick until the turn settled.
            //
            // Only wait when this pass actually launched a cohort. A pass that
            // merely parked a writer-slot hold (nothing launched) must not wait:
            // the hold is re-checked at the pass tail, and waiting here would
            // strand a Topic this pass deliberately deferred.
            if (cohortRunIds.size > 0 && this.inFlightExecutions.size > 0) {
              await Promise.race([...this.inFlightExecutions.values(), this.wakeSignal]);
              continue;
            }
            break;
          }
          // PR7 filesystem scheduling: a claimed Group sibling that must
          // take the Topic single-writer slot waits while another member of
          // the same Run is already executing. The claim is parked WITHOUT
          // touching durable provenance (see holdClaimForWriterSlot) and the
          // Topic deferred for this drain so the sibling finishes first. The
          // sibling's completion persist re-wakes the drain (every terminal
          // persistResult kicks), which starts a fresh drain with the deferred
          // set cleared. The Run card still presents one multi-member batch.
          if (this.mustDeferForWriterSlot(claimed)) {
            this.holdClaimForWriterSlot(claimed);
            passProgress = true;
            // A parked writer is a capacity reservation, not a physical
            // writer. Existing reader-safe siblings may still use remaining
            // capacity without changing the logical batch or dependencies.
            const readers = [...this.inFlightWork.values()];
            if (cohortRunIds.has(claimed.run.id) && readers.length > 0 && readers.every((active) =>
              active.memberTurn.effect === "read-only" && active.memberTurn.effectProvenance === "declared-enforced")) {
              this.deferredTopicIds.delete(claimed.run.topicId);
              continue;
            }
            // The held Run's own Topic is deferred so its remaining rows are not
            // re-claimed in this pass, and the scan CONTINUES. Stopping here
            // would fall through to awaitCohortInFlight(), which waits for the
            // whole cohort with no wake race — so a long sibling turn on this
            // Topic would block every other Topic for its entire duration.
            // Deferring and continuing keeps the drain scanning globally, which
            // is the whole point of cross-Run admission.
            this.deferredTopicIds.add(claimed.run.topicId);
            continue;
          }
          // Executions of independent Runs run concurrently: the drain
          // launches each claim and keeps admitting further Runs whose Topics
          // still have durable capacity. Cross-Run physical isolation is
          // decided by the resource admission table inside execute(), never
          // by drain ordering.
          launchExecution(claimed);
          cohortRunIds.add(claimed.run.id);
          passProgress = true;
        }
        // Settle everything this pass launched first. An unexpected execution
        // failure rethrows here, after every launched execution settled.
        await awaitCohortInFlight();
        // Shutdown owns unstarted holds from here: once `closed` is set, a
        // held sibling must never start — the retire loop in shutdown()
        // returns it to `pending` with provenance intact instead. Without
        // this fence the recheck below launches B after shutdown began,
        // extending shutdown by a whole provider turn (or wedging it) and
        // bypassing retire entirely. Returning exits via `finally`
        // (draining=false); the tail kick is already closed-guarded.
        if (this.closed) {
          return;
        }
        // Snapshot the pass deferrals before they are cleared. A Topic this
        // pass deferred on a pre-start failure may still have unrelated pending
        // work, so a chained extra pass (no wake consumed) preserves them and
        // claims only OTHER Topics. The chain is bounded by the Topic count and
        // ends when a link claims nothing — a failed Topic is never retried
        // without a wake.
        //
        // A STILL-HELD sibling's Topic is not a failure, so it is removed from
        // the snapshot: the recheck below is about to run it, and preserving its
        // Topic as a deferral would make the recheck skip it forever.
        const passDeferred = new Set(this.deferredTopicIds);
        for (const work of this.heldWriterSlotClaims.values()) {
          passDeferred.delete(work.run.topicId);
        }
        this.deferredTopicIds.clear();
        // Re-check held writer-slot claims — ALWAYS, not only when something
        // was in flight. A held sibling becomes runnable the moment its
        // sibling's provider turn settles, and the drain executes the SAME
        // held claim object (still ours, still human) in this drain — no
        // re-claim, no provenance rewrite — so a two-member Run under
        // shared-single-writer completes without an extra wake. The recheck
        // must also run when the in-flight set is empty: a previous drain may
        // have launched, settled, and parked a hold (or thrown mid-recheck),
        // and nothing else will pick that hold back up — claimOne only returns
        // `pending` rows, never our live `claimed` hold.
        //
        // This runs AFTER the settle above so the sibling the hold waits on has
        // actually finished — the only state in which the hold can clear.
        const held = this.recheckHeldClaims();
        if (held) {
          // The handoff is launched into this drain's `cohort`, so the settle
          // BELOW awaits it in the same pass. That is what makes an unexpected
          // failure rethrow out of the drain (rejecting activation) instead of
          // escaping as an unhandled rejection — the regression the original
          // inline await was protecting against.
          //
          // Awaiting the handoff here does NOT reintroduce head-of-line
          // blocking, because the settle is a COHORT wait, not a whole-set
          // wait: `cohort` holds only what this pass launched, and the claim
          // loop above has already parked on one in-flight settle OR a wake
          // while admitting other Topics. A long sibling therefore cannot hold
          // the `draining` guard, and an incoming kick is observed.
          //
          // Registering it in `cohortRunIds` keeps it inside the drain's scope:
          // the `!claimed` branch above waits (racing the wake) rather than
          // breaking whenever a cohort is in flight, so kick() cannot resolve
          // while the sibling still runs. Same-Topic overlap stays impossible
          // because the durable claim fence refuses a second Run of one Topic
          // while this claim is held.
          launchExecution(held);
          cohortRunIds.add(held.run.id);
          passProgress = true;
          // Settle the handoff (and anything else this pass launched) before
          // deciding whether to chain, so its failure propagates from HERE.
          await awaitCohortInFlight();
          if (this.closed) {
            return;
          }
        }
        // A drain that deferred Topics on pre-start failures may still have
        // unrelated pending work: chain one extra pass (no wake consumed)
        // with the deferrals preserved. The chained pass claims only OTHER
        // Topics, so every chain link needs fresh progress and the chain is
        // bounded by the Topic count. A chained pass that claims nothing
        // ends the drain — a failed Topic is never retried without a wake.
        if (passProgress && passDeferred.size > 0) {
          for (const topicId of passDeferred) {
            this.deferredTopicIds.add(topicId);
          }
          chainedExtraPass = true;
          continue;
        }
        this.deferredTopicIds.clear();
      }
    } finally {
      this.draining = false;
    }
    this.surfaceLeaseFailure();
    if (!this.closed && seen !== this.wakeGeneration) {
      await this.kick();
    }
  }

  private emitProduct(event: ConversationProductEvent): void {
    emitConversationProductEvent(this.onProductEvent, event);
  }

  /** Release every physical reservation and conflict marker belonging to a Run. */
  private releaseRunPhysicalResources(runId: string): void {
    this.resourceReservations.releaseRun(runId);
    // A held claim blocked by THIS Run must become re-runnable the moment the
    // Run's reservations go, otherwise it would stay parked forever.
    for (const [held, blocker] of [...this.resourceConflictHolds]) {
      const blockerRun = this.resourceReservations.runOf(blocker);
      if (blockerRun === runId || blocker === runId) this.resourceConflictHolds.delete(held);
    }
    // Also drop markers whose blocker is simply gone (settled and released).
    for (const [held, blocker] of [...this.resourceConflictHolds]) {
      if (!this.resourceReservations.has(blocker)) this.resourceConflictHolds.delete(held);
    }
  }

  async cancelRun(runId: string): Promise<void> {
    const now = this.now().toISOString();
    const outcome = this.store.cancelRun(runId, now);
    if (outcome.alreadyTerminal) {
      return;
    }
    if (!outcome.executionStarted || outcome.activeMembers.length === 0) {
      // Nothing ever entered the Provider for this Run, so nothing holds a
      // physical resource. Releasing here is safe and lets a waiting Run on
      // another Topic proceed immediately.
      this.releaseRunPhysicalResources(runId);
      if (outcome.memberTurn) this.emitRunAndMember(outcome.run, outcome.memberTurn.id);
      else this.emitProduct({ type: "conversation-run-changed", run: outcome.run });
      await this.kick();
      return;
    }
    // Snapshot-first with all-settled semantics: issue physical cancel to
    // EVERY active member. A transport throw must not abandon already
    // observed outcomes: persist fulfilled evidence first (below), then
    // rethrow so the barrier stays and retry covers only the unsettled rest.
    const fulfilled: Array<{ member: MemberTurnRecord; result: ConversationTurnCancelResult }> = [];
    // `hasError` is a STATUS flag, never derived from the thrown value: a
    // transport may legally reject with `undefined`.
    let cancelFailed = false;
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
        cancelFailed = true;
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
      ...(cancelFailed ? { deferRunAggregate: true } : {}),
    });
    for (const entry of settled.settled) {
      if (entry.outcome === "completed" && entry.message) {
        this.emitTerminalProjection(settled.run, entry.member, entry.message);
      } else {
        this.emitRunAndMember(settled.run, entry.member.id);
      }
    }
    // Release the physical reservations only now: every active member's
    // `runner.cancel()` has returned, so each Provider turn has actually
    // stopped. Releasing earlier would open a window where the cancelled Run's
    // writer is still inside the directory while another Run is admitted to it
    // — the exact overlap cross-Run admission exists to prevent. `execute()`'s
    // own settle path also releases, so this is the belt to that braces: it
    // covers a cancel that ended the turn before execute() observed it.
    //
    // An UNCONFIRMED cancel is the one case that must not release. `cancelFailed`
    // means some `runner.cancel()` rejected, so the settlement below is
    // evidence-only (`deferRunAggregate`) and the Run is NOT terminal: its
    // Provider turn may still be writing this directory. Releasing here would
    // hand the writer slot to another Run while this one is still inside.
    // Instead the reservation stays held and the failure is retried — the retry
    // either confirms the cancel (release happens in the confirmed path, or in
    // execute()'s own settle) or fails again, and the reservation is only ever
    // dropped by shutdown, which refuses new starts anyway.
    if (!cancelFailed) {
      this.releaseRunPhysicalResources(runId);
    }
    if (cancelFailed) {
      throw firstError;
    }
    await this.kick();
  }

  private claimOne(cohortRunId?: string): ClaimedWork | undefined {
    return this.store.claimNextDispatch({
      now: this.now().toISOString(),
      owner: this.ownerId,
      leaseExpiresAt: new Date(this.now().getTime() + this.leaseMs).toISOString(),
      authorityEpoch: this.authorityEpoch,
      topicConcurrencyLimits: this.runtime.topicConcurrencyLimits(),
      ...(cohortRunId !== undefined ? { runId: cohortRunId } : {}),
      ...(this.deferredTopicIds.size > 0 ? { skipTopicIds: [...this.deferredTopicIds] } : {}),
    });
  }

  /**
   * Claim the next execution, preferring the Topic the fairness rotator chooses.
   *
   * The durable order is `msg.seq`, which alone lets one high-traffic Topic take
   * every freed slot while another ready Topic waits. The rotator reorders the
   * *candidates* only: it peeks which Topics are claimable, moves the Topic that
   * just received capacity behind the others, and claims from the winner. The
   * chosen Topic's own internal order is still `seq`, so a Topic never runs its
   * requests out of order, and a Topic with no ready work is simply absent from
   * the peek.
   *
   * Falls back to the plain claim when the peek is empty or the preferred Topic
   * turns out not to be claimable (a concurrent claim, a capacity change): the
   * durable claim remains the authority on admissibility.
   */
  private claimNextFair(): ClaimedWork | undefined {
    const base = {
      now: this.now().toISOString(),
      owner: this.ownerId,
      leaseExpiresAt: new Date(this.now().getTime() + this.leaseMs).toISOString(),
      authorityEpoch: this.authorityEpoch,
      topicConcurrencyLimits: this.runtime.topicConcurrencyLimits(),
      ...(this.deferredTopicIds.size > 0 ? { skipTopicIds: [...this.deferredTopicIds] } : {}),
    };
    const candidates = this.store.peekClaimableTopicIds(base, 8);
    if (candidates.length === 0) {
      return undefined;
    }
    const ordered = this.fairness.order(candidates.map((topicId) => ({ topicId })));
    for (const candidate of ordered) {
      const claimed = this.store.claimNextDispatch({
        ...base,
        topicId: candidate.topicId,
      });
      if (claimed) {
        this.fairness.served(candidate.topicId);
        return claimed;
      }
    }
    // Every peeked Topic refused the claim (raced away). Fall back to the plain
    // durable claim so a stale peek can never stall the drain.
    return this.claimOne();
  }

  /**
   * PR7 filesystem scheduling gate. PR7 accepts carry no proven read-only
   * capability, so every Group member is conservatively unknown and takes
   * the Topic single-writer slot. While another member of the same Run is
   * already executing, a newly claimed sibling defers instead of running
   * concurrently. Started members never defer: a claim whose member already
   * started (recovery redelivery after a crash) must execute, not park
   * behind siblings that may themselves settle while it waits. Direct Runs
   * are unaffected.
   *
   * Isolation is read from the Topic's durable ExecutionTarget. No isolation
   * passes unproven work through: only an enforceably read-only member
   * (`read-only` + `declared-enforced` proof) may overlap another in-flight
   * turn. The policy-aware producer supplies a runtime-enforced proof;
   * ordinary, Router and handoff work remains unproven. Both participants
   * must be readers. A parked claim is a reservation, not physical execution.
   */
  private mustDeferForWriterSlot(work: ClaimedWork): boolean {
    if (work.memberTurn.startedAt) {
      return false;
    }
    if (this.runtime.conversationKind(work.run.conversationId) !== "group") {
      return false;
    }
    const siblings = this.store.listMemberTurns(work.run.id);
    const heldMembers = new Set([...this.heldWriterSlotClaims.values()].map((held) => held.memberTurn.id));
    const otherExecuting = siblings.filter((turn) => turn.id !== work.memberTurn.id
      && (turn.state === "running" || (turn.state === "dispatched" && !heldMembers.has(turn.id))));
    if (otherExecuting.length === 0) {
      return false;
    }
    const isolation = this.runtime.groupTopicIsolation(work.run.conversationId, work.run.topicId);
    // Allow preparation to overlap; physical admission verifies distinct cwd
    // bindings below. The flag alone never authorizes provider execution.
    if (isolation === "worktree-per-member" && this.worktrees) return false;
    return !isEffectConcurrencySafe(work.memberTurn.effect, isolation, otherExecuting.length, work.memberTurn.effectProvenance)
      || otherExecuting.some((turn) => !isEffectConcurrencySafe(turn.effect, isolation, 1, turn.effectProvenance));
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
  /**
   * Refresh every claim this process still holds: in-flight provider turns
   * and writer-slot waits. The timer is independent of provider completion
   * and of whether the Topic configured maxConcurrentMemberTurns. Teardown
   * calls the public flush so its scoped recovery cannot observe a stale
   * lease for work this process is still executing.
   */
  async flushOwnedClaimLeases(): Promise<void> {
    await this.leaseRenewalTask;
    this.surfaceLeaseFailure();
    if (this.leaseKeeperStopped && this.inFlightWork.size === 0 && this.heldWriterSlotClaims.size === 0) {
      return;
    }
    this.renewOwnedClaims();
  }

  private armLeaseKeeper(): void {
    if (this.leaseKeeperStopped || this.leaseTicket) return;
    this.leaseTicket = this.leaseScheduler.schedule(claimLeaseRenewalDelayMs(this.leaseMs), () => {
      this.leaseTicket = undefined;
      if (this.leaseKeeperStopped) return;
      this.leaseRenewalTask = this.leaseRenewalTask.then(() => {
        if (this.leaseKeeperStopped) return;
        this.renewOwnedClaims();
      }).then(() => {
        if (!this.leaseKeeperStopped) this.armLeaseKeeper();
      }, (error: unknown) => {
        // The rejection is handled here so a timer tick cannot become an
        // unhandled rejection. A non-benign error fail-closes the consumer
        // and stops the keeper; a stale fence keeps renewing.
        this.noteLeaseFailure(error);
        if (!this.leaseFailure && !this.leaseKeeperStopped) this.armLeaseKeeper();
      });
    });
  }

  private stopLeaseKeeper(): void {
    this.leaseKeeperStopped = true;
    this.leaseTicket?.cancel();
    this.leaseTicket = undefined;
  }

  /** Lost owner/generation and a run that is no longer runnable are fences
   *  the drain already handles inside renew, recheck, hold, and execution
   *  start. `claimNextDispatch` does not throw them. They must not fail-close
   *  the consumer or end the kick. */
  private isBenignSchedulingError(error: unknown): boolean {
    return error instanceof ConversationError
      && (error.code === "stale_claim" || error.code === "run_not_runnable");
  }

  private notifyFatalScheduling(error: unknown): void {
    try {
      this.onFatalSchedulingError?.(error);
    } catch {
      // The stored error remains the failure kick and shutdown report.
    }
  }

  private surfaceLeaseFailure(): void {
    if (this.leaseFailure) throw this.leaseFailure.error;
  }

  private surfaceShutdownFailure(): void {
    // A drain failure was already returned by kick(). Repeating it here would
    // skip hold retirement. A lease-keeper failure is only stored on the
    // timer path, so shutdown is the place that reports it.
    if (this.leaseFailure) throw this.leaseFailure.error;
  }

  /** Renewal I/O that is not a lost fence. The presence flag is the object,
   *  so the stored error may itself be `undefined`. */
  private noteLeaseFailure(error: unknown): void {
    if (this.isBenignSchedulingError(error)) return;
    const first = this.leaseFailure === undefined && this.schedulingFailure === undefined;
    if (!this.leaseFailure) this.leaseFailure = { error };
    this.stopLeaseKeeper();
    if (!first) return;
    this.notifyFatalScheduling(error);
  }

  /** Drain failure that does not by itself prove the lease keeper is dead.
   *  A later explicit kick may still drain accepted work. */
  private noteSchedulingFailure(error: unknown): void {
    if (this.isBenignSchedulingError(error)) return;
    if (this.leaseFailure || this.schedulingFailure) return;
    this.schedulingFailure = { error };
    this.notifyFatalScheduling(error);
  }

  private renewOwnedClaims(): void {
    if (this.leaseFailure) throw this.leaseFailure.error;
    try {
      this.renewHeldClaims();
      this.renewInFlightClaims();
    } catch (error) {
      this.noteLeaseFailure(error);
      throw error;
    }
  }

  private renewInFlightClaims(): void {
    const now = this.now().toISOString();
    const leaseExpiresAt = new Date(this.now().getTime() + this.leaseMs).toISOString();
    for (const active of this.inFlightWork.values()) {
      try {
        const renewed = this.store.renewInFlightClaim({
          dispatchId: active.dispatch.id,
          owner: this.ownerId,
          generation: active.dispatch.generation,
          now,
          leaseExpiresAt,
        });
        this.inFlightWork.set(active.dispatch.id, { ...active, dispatch: renewed });
      } catch (error) {
        if (error instanceof ConversationError && error.code === "stale_claim") {
          this.inFlightWork.delete(active.dispatch.id);
          continue;
        }
        throw error;
      }
    }
  }

  /** Extend every live held claim's lease. Called from the owned-claim
   *  renewal pass, BEFORE recoverExpiredClaims(): while this drain is alive
   *  and holds the claim object, the owner is by definition not dead, so
   *  expiry must not trigger crash recovery. Holds that fail the fence (lost
   *  race, recovered elsewhere, Run terminal) are dropped; the normal paths
   *  reap them. */
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
  /**
   * Cross-Run physical resource identity for one claimed execution (PR C).
   *
   * `session` is the materialized logical session when admission has one; the
   * recheck path passes the session it can resolve from durable state, or
   * undefined when none is resolvable. Returns undefined when the identity
   * cannot be verified, which fails admission closed. Never guesses from a
   * Topic id, Bot name or declared effect.
   *
   * Worktree-bound executions key on the verified worktree id, so two
   * different owned worktrees are never conflated even if their paths share a
   * prefix. Shared-workspace executions key on the canonical workspace cwd,
   * which is what makes two Runs on the same directory conflict.
   */
  private resolvePhysicalResourceIdentity(
    work: ClaimedWork,
    session: LogicalSession | undefined,
    worktreeRef: import("./conversation-worktree-types").ConversationWorktreeRef | undefined,
  ): PhysicalResourceIdentity | undefined {
    const isolation = this.runtime.groupTopicIsolation(work.run.conversationId, work.run.topicId);
    if (worktreeRef) {
      // The caller already awaited verifyReference() above, so the worktree is
      // registered to this durable owner at this generation. resolveSessionCwd
      // re-asserts that binding and returns the verified physical path; a throw
      // here means the identity is not verifiable and must not be admitted.
      if (!session) return undefined;
      let cwd: string;
      try {
        cwd = this.worktrees!.resolveSessionCwd(session);
      } catch {
        return undefined;
      }
      return { cwd, worktreeId: worktreeRef.worktreeId, isolation };
    }
    // Shared workspace: the physical directory is the workspace root the
    // session was actually materialized against, resolved through the session
    // service so an unregistered workspace reads as unverifiable rather than
    // being guessed from a name.
    //
    // The configured cwd is only LEXICALLY normalized by the config layer, so
    // two workspaces reached through a symlink, a junction or a Windows path
    // alias can be different strings for the SAME directory. Comparing the raw
    // strings would then treat one physical directory as two resources and let
    // two writers run concurrently on it. Canonicalize the real path and fold
    // it with the same helper the worktree manager uses, which already handles
    // Windows 8.3 short names, extended-length prefixes and separator
    // differences. A path that cannot be canonicalized is unverifiable.
    if (!session) return undefined;
    const resolved = this.sessions.getResolvedSessionByInternalAlias(session.alias);
    if (!resolved) {
      // The session exists but its workspace no longer resolves: that is config
      // drift, already owned by the runtime-revision checks that ran earlier in
      // execute() against the frozen claim snapshot. Fall back to the workspace
      // NAME so the reservation still keys consistently — two Runs whose
      // sessions resolve to the same workspace still conflict — and let the
      // revision check own the verdict.
      return { cwd: `workspace:${session.workspace}`, isolation };
    }
    const canonical = canonicalizePhysicalPath(resolved.cwd);
    if (!canonical) return undefined;
    return { cwd: canonical, isolation };
  }
  /** Identity for the reservation recheck, derived without a Provider turn. */
  private reservationIdentityFor(work: ClaimedWork): PhysicalResourceIdentity | undefined {
    const alias = work.memberTurn.sessionAlias;
    const session = alias ? this.sessions.getLogicalSessionRecord(alias) : undefined;
    const worktreeRef = session?.execution_worktree;
    return this.resolvePhysicalResourceIdentity(work, session ?? undefined, worktreeRef);
  }

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
        this.resourceConflictHolds.delete(dispatchId);
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
          this.resourceConflictHolds.delete(dispatchId);
          continue;
        }
        throw error;
      }
      if (this.mustDeferForWriterSlot({ ...work, dispatch: renewed })) {
        this.deferredTopicIds.add(work.run.topicId);
        continue;
      }
      // A claim parked by a CROSS-RUN resource conflict stays parked until the
      // conflicting reservation is actually gone. Re-deriving the identity here
      // would need the materialized session, which this claim never got; the
      // reservation table is the authority, so ask it directly.
      if (this.resourceConflictHolds.has(dispatchId) && this.reservationStillBlocked(work)) {
        continue;
      }
      this.heldWriterSlotClaims.delete(dispatchId);
      this.resourceConflictHolds.delete(dispatchId);
      return { ...work, dispatch: renewed };
    }
    return undefined;
  }

  /**
   * True when any live reservation still conflicts with `work`'s physical
   * resource. Uses the same identity derivation as admission, so a claim parked
   * on a shared directory is released exactly when that directory's writer slot
   * frees — and never on a guess.
   */
  private reservationStillBlocked(work: ClaimedWork): boolean {
    const identity = this.reservationIdentityFor(work);
    if (!identity) return false;
    const reader = work.memberTurn.effect === "read-only" && work.memberTurn.effectProvenance === "declared-enforced";
    return this.resourceReservations.conflicts(identity, reader) !== undefined;
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
    if (current.quarantinedBotIds?.includes(work.memberTurn.botId)) {
      this.failOwnClaimBeforeStart(work, "member_quarantined");
      return;
    }
    let started: MemberTurnRecord | undefined;
    let releaseGroupExecution: (() => void) | undefined;
    let worktreeRef: import("./conversation-worktree-types").ConversationWorktreeRef | undefined;
    try {
      await this.hooks?.beforeRuntimeMaterialize?.(work);
      const materializeFail = this.resolveMaterializeFail();
      if (materializeFail) {
        throw materializeFail;
      }
      const snapshot = work.memberSnapshot ?? work.memberTurn.profileSnapshot ?? work.run.profileSnapshot;
      const executionPolicy = this.runtime.executionPolicyFor(work.memberTurn, snapshot.execution.agent);
      // Unified request-snapshot contract (claim LEFT JOINs messages so a
      // corrupted reference reaches this check instead of being silently
      // invisible): a missing or wrong-reference request row is corrupted
      // durable state — fail the claim terminally BEFORE execution start
      // (no live-lookup fallback that would hand members of one batch
      // different inputs, no indeterminate seal, no requeue loop on state
      // that cannot heal itself). Applies to Direct and Group alike.
      if (!requestSnapshotMatches(this.store.getMessage(work.run.requestMessageId), work.run)) {
        const corrupted = this.store.getMessage(work.run.requestMessageId) !== undefined;
        this.failOwnClaimBeforeStart(work, corrupted ? "request_snapshot_mismatch" : "missing_request_snapshot");
        return;
      }
      // Re-read the durable MemberTurn before the transcript/scope checks. A
      // writer-slot hold can park this claim for a whole Provider turn of its
      // sibling, during which durable state may change (a corrupted trigger
      // reference, a rewritten task). The claim snapshot is then stale, so
      // validating it would pass on data that no longer exists. Rebind `work` so
      // every later check in this function sees the durable row; the claim's own
      // owner/generation still fences who may execute it.
      const liveMember = this.store.getMemberTurn(work.memberTurn.id);
      if (liveMember && liveMember !== work.memberTurn) {
        work = { ...work, memberTurn: liveMember };
      }
      const isGroup = this.runtime.conversationKind(work.run.conversationId) === "group";
      if (isGroup && (work.run.mode === "automatic" || work.memberTurn.assignmentId) && !work.memberTurn.task?.trim()) {
        this.failOwnClaimBeforeStart(work, "missing_assignment_task");
        return;
      }
      if (isGroup) this.referencedTranscript(work);
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
      if (isGroup && this.runtime.groupTopicIsolation(work.run.conversationId, work.run.topicId) === "worktree-per-member") {
        if (!this.worktrees) throw new ConversationError("worktree_unprovisioned", "worktree manager unavailable");
        try { worktreeRef = await this.worktrees.prepare(work.run.id, work.memberTurn.botId, assertStillDispatchable); }
        catch (e) { assertStillDispatchable(); throw new ConversationError("worktree_prepare_failed", e instanceof Error ? e.message : String(e)); }
        assertStillDispatchable();
      }
      const binding = isGroup
        ? await this.runtime.getOrCreateGroupMemberSession({
          botId: work.memberTurn.botId,
          conversationId: work.run.conversationId,
          topicId: work.run.topicId,
          execution: snapshot.execution,
          executionPolicy,
          assertStillDispatchable,
          ...(worktreeRef ? { executionWorktree: worktreeRef } : {}),
        })
        : await this.runtime.getOrCreateDirectSession({
          botId: work.memberTurn.botId,
          conversationId: work.run.conversationId,
          topicId: work.run.topicId,
          execution: snapshot.execution,
          executionPolicy,
          assertStillDispatchable,
        });
      const session = this.sessions.getLogicalSessionRecord(binding.sessionAlias);
      if (!session || !sessionMatchesExecution(session, snapshot.execution)) {
        this.failOwnClaimBeforeStart(work, "runtime_revision_mismatch");
        return;
      }
      await this.hooks?.beforeExecutionStart?.(work);
      // Cross-Run physical admission (PR C). Re-verified here, immediately
      // before the Provider turn, because materialization above is async: two
      // Runs can both decide a directory looks free and only converge at this
      // point. The identity comes from the SAME verified session/worktree
      // binding the single-Run check just validated, so an identity that was
      // never verified can never be treated as compatible.
      const resourceIdentity = this.resolvePhysicalResourceIdentity(work, session, worktreeRef);
      if (!resourceIdentity) {
        // No verifiable identity: fail closed rather than guess. A resource we
        // cannot name must not be assumed shareable with another Run.
        this.failOwnClaimBeforeStart(work, "resource_identity_unverified");
        return;
      }
      const reservation: ResourceReservation = {
        key: physicalResourceKey(resourceIdentity),
        runId: work.run.id,
        memberTurnId: work.memberTurn.id,
        dispatchId: work.dispatch.id,
        identity: resourceIdentity,
        // Only a proven enforced read-only turn may overlap another Run on the
        // same physical directory. Anything else takes that resource's writer
        // slot for the duration of the turn.
        reader: work.memberTurn.effect === "read-only" && work.memberTurn.effectProvenance === "declared-enforced",
      };
      const blocking = this.resourceReservations.conflicts(reservation.identity, reservation.reader);
      if (blocking) {
        // Another Run already holds this physical resource in an incompatible
        // mode. This is a TRANSIENT scheduling condition, not an execution
        // failure: the holder is a live Provider turn that will settle, and the
        // directory becomes free then.
        //
        // Fail-closed means "do not enter the Provider now" — it must NOT mean
        // "fail the user's request". Terminalising here would make a shared
        // workspace unusable under concurrency: any Topic B request arriving
        // while Topic A holds the directory would fail permanently, even after
        // A completes. Instead the claim is parked exactly like a same-Run
        // writer-slot hold: durably `claimed` under our lease with provenance
        // untouched, registered in the hold set, and re-run by the recheck the
        // moment the conflicting reservation is released. No Provider turn, no
        // partial execution, no indeterminate seal.
        this.holdClaimForWriterSlot(work);
        this.resourceConflictHolds.set(work.dispatch.id, blocking.dispatchId);
        return;
      }
      this.resourceReservations.add(reservation);
      if (worktreeRef) {
        await this.worktrees!.verifyReference(worktreeRef);
        assertStillDispatchable();
        const cwd = this.worktrees!.resolveSessionCwd(session);
        for (const sibling of this.store.listMemberTurns(work.run.id).filter(m => m.id !== work.memberTurn.id && m.state === "running")) {
          const other = sibling.sessionAlias ? this.sessions.getLogicalSessionRecord(sibling.sessionAlias) : undefined;
          if (!other?.execution_worktree || other.execution_worktree.worktreeId === worktreeRef.worktreeId
            || this.worktrees!.resolveSessionCwd(other) === cwd) {
            throw new ConversationError("worktree_identity_mismatch", "physical overlap requires distinct verified cwd bindings");
          }
        }
      }
      if (this.runtime.executionPolicyFor(work.memberTurn, snapshot.execution.agent) !== session.execution_policy) {
        this.failOwnClaimBeforeStart(work, "runtime_revision_mismatch");
        return;
      }
      const latestBeforeStart = this.store.getRun(work.run.id);
      if (!latestBeforeStart || latestBeforeStart.state === "cancelled") {
        this.store.cancelRun(work.run.id, this.now().toISOString());
        return;
      }
      // Re-read exact dependency evidence after async materialization/hooks,
      // immediately before start; corruption cannot invalidate a cached prompt.
      const groupPrompt = isGroup ? this.groupTurnPrompt(work) : undefined;
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
      if (worktreeRef) {
        this.worktrees!.resolveSessionCwd(session);
        await this.worktrees!.mark(worktreeRef, "active");
        this.worktrees!.resolveSessionCwd(session);
      }
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
      if (isRunCancelling(latestRun)) {
        // This exact attempt has not called runner.run(): durable start is
        // not provider admission. Persist the known pre-provider cancellation
        // instead of abandoning a running member/claimed dispatch that lease
        // recovery would later misclassify as unknown side effects.
        this.persistResult(work, started, { status: "cancelled" });
        return;
      }
      this.emitProduct({ type: "conversation-run-changed", run: latestRun });
      this.emitProduct({ type: "member-turn-started", run: latestRun, memberTurn: latestMember });
      const text = isGroup
        ? composeBotTurnPromptFromSnapshot(snapshot, groupPrompt!)
        : composeBotTurnPromptFromSnapshot(snapshot, this.requestText(work.run.requestMessageId));
      const groupExecution = isGroup ? this.handoffs?.bindExecution({ senderMemberTurnId: started.id, sourceTurnId,
        dispatchId: work.dispatch.id, owner: this.ownerId, generation: work.dispatch.generation }) : undefined;
      releaseGroupExecution = groupExecution?.release;
      const result = await this.runner.run({
        ...(groupExecution ? { groupExecutionToken: groupExecution.token } : {}),
        conversationId: work.run.conversationId,
        topicId: work.run.topicId,
        botId: work.memberTurn.botId,
        runId: work.run.id,
        memberTurnId: started.id,
        sessionAlias: binding.sessionAlias,
        logicalSessionId: binding.logicalSessionId,
        text: groupExecution ? `${this.handoffs!.memberContext(groupExecution.token)}\n\n${text}` : text,
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
      releaseGroupExecution?.();
      releaseGroupExecution = undefined;
      await this.hooks?.beforeResultPersist?.(work);
      this.persistResult(work, started, result);
    } catch (error) {
      if (!started && error instanceof ConversationError && error.code.startsWith("worktree_")) {
        this.failOwnClaimBeforeStart(work, error.code); return;
      }
      if (!started && work.memberTurn.assignmentId && error instanceof BotError
        && ["group_member_not_member", "conversation_not_group", "bot_not_found", "bot_disabled"].includes(error.code)) {
        this.failOwnClaimBeforeStart(work, error.code);
        return;
      }
      if (!started && error instanceof ConversationError
        && (error.code === "member_result_missing" || error.code === "trigger_message_not_found"
          || error.code === "member_quarantined")) {
        this.failOwnClaimBeforeStart(work, error.code);
        return;
      }
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
          sourceTurnId: started.sourceTurnId,
          terminalState: "indeterminate",
        });
        this.emitRunAndMember(run, work.memberTurn.id);
        return;
      }
      this.releaseOwnClaim(work);
      this.deferredTopicIds.add(work.run.topicId);
    } finally {
      releaseGroupExecution?.();
      if (worktreeRef) await this.worktrees!.mark(worktreeRef, "awaiting-integration");
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
        this.maybeRouteAutomatic(run);
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
        sourceTurnId: member.sourceTurnId,
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
    if (result.status === "completed" && !result.unknown) {
      const completed = this.store.completeExecution({
        runId: work.run.id,
        memberTurnId: started.id,
        botId: work.memberTurn.botId,
        content: result.text ?? "",
        sourceTurn: { sessionAlias: started.sessionAlias ?? "", turnId: started.sourceTurnId },
        now,
      });
      this.emitTerminalProjection(completed.run, completed.memberTurn, completed.assistantMessage);
      // PR8 automatic continuation: once every member of the active batch is
      // terminal on an automatic Run, the Router decides the next step. The
      // store is the authority on "batch settled" — it only leaves the Run
      // nonterminal for automatic Runs when a next decision is still owed.
      this.maybeRouteAutomatic(completed.run);
      // A deferred writer-slot sibling may be parked on this Topic: wake the
      // drain so it is claimed in a fresh pass. Fire-and-forget by design —
      // persistResult is sync and drain re-entry is generation-guarded.
      this.kickInBackground();
      return;
    }
    if (result.status === "cancelled" || result.unknown) {
      const unstartedSiblings = !result.unknown ? this.store.listMemberTurns(work.run.id)
        .filter((member) => !member.startedAt && !TERMINAL_MEMBER_STATES.includes(member.state)) : [];
      const run = this.store.completeCancel(work.run.id, started.id, now, result.unknown === true, true, started.sourceTurnId);
      this.emitRunAndMember(run, started.id);
      for (const sibling of unstartedSiblings) {
        const memberTurn = this.store.getMemberTurn(sibling.id);
        if (memberTurn?.state === "cancelled") this.emitProduct({ type: "member-turn-finished", run, memberTurn });
      }
      this.maybeRouteAutomatic(run);
      this.kickInBackground();
      return;
    }
    const run = this.store.failExecution({
      runId: work.run.id,
      memberTurnId: started.id,
      now,
      reason: result.error ?? "failed",
      sourceTurnId: started.sourceTurnId,
      ...(started.origin !== "human-explicit" && result.blockedReason ? { blockedReason: result.blockedReason } : {}),
    });
    this.emitRunAndMember(run, started.id);
    this.maybeRouteAutomatic(run);
    this.kickInBackground();
  }

  /** Fire-and-forget drain wake. kick() records a non-benign rejection and
   *  fail-closes accept before this catch consumes the rejection. */
  private kickInBackground(): void {
    void this.kick().catch(() => {});
  }

  /**
   * PR8 automatic continuation. Fires only when the Run is automatic, still
   * nonterminal, and every member of the settled batch is terminal — i.e.
   * exactly when a next decision is owed. Fire-and-forget: routing runs
   * outside the dispatch path and its outcome lands durably (dispatch rows,
   * waiting-human, terminal completion), then the handler kicks the drain.
   */
  private maybeRouteAutomatic(_settledRun: ConversationRun): void {
    if (this.closed || !this.onAutomaticBatchSettled) return;
    // An explicit Run settling can also release a queued automatic Run.
    // Eligibility and request ordering come from durable rows, never callbacks' timing.
    for (const { run } of this.store.automaticRunsAwaitingRouting()) {
      this.onAutomaticBatchSettled(run.id);
    }
  }

  /** PR8 wiring seam: the runtime registers the routing service here. */
  setAutomaticRoutingHandler(handler: AutomaticRoutingHandler): void {
    this.onAutomaticBatchSettled = handler;
  }

  setHandoffService(handoffs: GroupHandoffService): void { this.handoffs = handoffs; }

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
      if (result.unknown) return;
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

  private groupTurnPrompt(work: ClaimedWork): string {
    const context = this.frozenGroupTranscript(work);
    if (work.run.mode !== "automatic" && !work.memberTurn.assignmentId) return context;
    // Recovery changes execution provenance, not the durable assignment.
    // Assignment instructions are per-member execution input, separate from
    // the frozen public transcript shared by parallel siblings.
    const expected = work.memberTurn.expectedOutput === undefined
      ? "" : `\n\nExpected output:\n${work.memberTurn.expectedOutput}`;
    return `Group assignment:\nTask:\n${work.memberTurn.task}${expected}\n\nPublic Group context:\n${context}`;
  }

  /**
   * Frozen pre-request public baseline plus exact allowed result references.
   * Parallel members share their effective reference set; sequential members
   * add only completed dependency results, never intervening queued requests.
   * Reads durable rows of this Conversation+Topic only.
   */
  private frozenGroupTranscript(work: ClaimedWork): string {
    const request = this.store.getMessage(work.run.requestMessageId);
    // execute() validated the snapshot before start; a miss here would mean
    // the row vanished mid-flight, and the deterministic-input contract
    // forbids silently composing from a fallback lookup.
    if (request === undefined || !requestSnapshotMatches(request, work.run)) {
      throw new ConversationError("request_snapshot_mismatch", `run "${work.run.id}" lost its request snapshot`);
    }
    const baseline = this.store.listMessages({
      conversationId: work.run.conversationId,
      topicId: work.run.topicId,
      beforeSeq: request.seq,
      limit: PUBLIC_TRANSCRIPT_MESSAGES,
    });
    // Keep the pre-request snapshot frozen. Later rows enter ONLY by exact
    // references, never by widening a contiguous seq window across queued work.
    const allowed = new Map(baseline.map((message) => [message.id, message]));
    for (const message of this.referencedTranscript(work)) allowed.set(message.id, message);
    allowed.delete(request.id);
    const transcript = [...allowed.values()].sort((a, b) => a.seq - b.seq);
    const lines = transcript.map((message) => {
      if (message.role === "human") {
        return `Human: ${message.content}`;
      }
      const sender = message.senderBotId ? `Bot ${message.senderBotId}` : "Bot";
      return `${sender}: ${message.content}`;
    });
    const requestText = request.content;
    if (lines.length === 0) {
      return requestText;
    }
    return `${lines.join("\n\n")}\n\nHuman: ${requestText}`;
  }

  /**
   * Exact additional public rows this member may consume. Resolve dependency
   * assignment → MemberTurn → sourceTurnId, and revalidate every trigger in
   * scope. A fabricated or borrowed reference fails before execution starts.
   */
  private referencedTranscript(work: ClaimedWork) {
    const rows = new Map<string, NonNullable<ReturnType<ConversationStore["getMessage"]>>>();
    const claim = (messageId: string): void => {
      const message = this.getMessageInScope(messageId, work);
      if (message === undefined) {
        throw new ConversationError(
          "trigger_message_not_found",
          `member turn "${work.memberTurn.id}" references message "${messageId}" outside this run's topic`,
        );
      }
      rows.set(message.id, message);
    };
    const dependencies = work.memberTurn.dependsOn ?? [];
    if (dependencies.length > 0) {
      // Public results of this Run's terminal dependency assignments. Exact
      // durable join: assignment id → member turn → its public message. A
      // completed dependency without its exact public result is corruption,
      // not an empty successful result.
      const completed = this.store.listMemberTurns(work.run.id).filter((turn) =>
        turn.assignmentId !== undefined
        && dependencies.includes(turn.assignmentId)
        && turn.state === "completed");
      for (const turn of completed) {
        claim(requireMemberResult(this.store, turn).id);
      }
    }
    for (const messageId of work.memberTurn.triggerMessageIds) {
      claim(messageId);
    }
    return [...rows.values()];
  }

  /** Durable lookup revalidates the request boundary as well as Topic scope. */
  private getMessageInScope(messageId: string, work: ClaimedWork) {
    const message = this.store.getMessage(messageId);
    const request = this.store.getMessage(work.run.requestMessageId);
    if (!publicMessageMatchesRunScope(message, work.run, request)) {
      return undefined;
    }
    return message;
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
