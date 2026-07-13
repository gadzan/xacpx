import { randomUUID } from "node:crypto";

import type { PromptAttachmentRef } from "@ganglion/xacpx-relay-protocol";
import type { TurnRequest, TurnResult } from "./session-turn-runner";
import {
  turnKey,
  raceWithTimeout,
  CANCEL_DRAIN_TIMEOUT_MS,
  QUEUE_PREVIEW_MAX,
  TURN_IDLE_TIMEOUT,
  type QueuedPrompt,
} from "./turn-support";

export interface QueuedItemSnapshot {
  id: string;
  textPreview: string;
  enqueuedAt: string;
}

export interface TurnQueueDeps {
  // Runs the per-turn execution body (SessionTurnRunner.run in production). `onActivity` is
  // invoked by the runner on every agent event; TurnQueue uses it to reset the idle watchdog.
  runTurn(req: TurnRequest, signal: AbortSignal, onActivity: () => void): Promise<TurnResult>;
  emitQueueUpdated(chatKey: string, sessionAlias: string, items: QueuedItemSnapshot[]): void;
  // Post-turn `sessions-changed` detection (a transport session that moved during the turn —
  // archived-restore or `/clear`). Called AFTER `draining.add` and BEFORE `resolveSettled`, so
  // the await it takes stays inside the draining-guarded window (see submit's finally). Must be
  // best-effort itself — TurnQueue does not catch on its behalf.
  detectSessionsChanged(detection: NonNullable<TurnResult["postTurnDetection"]>): Promise<void>;
  // Inactivity watchdog threshold in ms; <= 0 (or absent) disables it. Read per-submit.
  turnIdleTimeoutMs?: () => number;
  // Injectable timers (default setTimeout/clearTimeout), for deterministic tests.
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (id: unknown) => void;
}

export interface SubmitParams {
  chatKey: string;
  sessionAlias: string;
  text: string;
  senderId: string;
  isOwner?: boolean;
  accountId?: string;
  // External abort (e.g. the scheduler's per-dispatch timeout) linked to this turn.
  abortSignal?: AbortSignal;
  // Extra fields stamped onto turn-started for scheduled-origin turns. `queueItemId`
  // is set only for a drained queue head so the web can reconcile the badge.
  turnStarted?: TurnRequest["turnStarted"];
  media?: PromptAttachmentRef[];
  // Only interactive prompt() sets this. When true and a turn is already running, the
  // submission is appended to the per-session queue instead of being rejected. Scheduled
  // turns omit it, so they keep the immediate-or-reject behavior.
  queueable?: boolean;
  // Set only by the turn-finish drain hand-off. A drained head turn bypasses the busy gate
  // (it is what the finished turn intentionally started next), re-registers its own inFlight,
  // and clears the `draining` guard — all synchronously at its top.
  drained?: boolean;
}

export type SubmitResult = TurnResult | { ok: true; queued: true; queueItemId: string };

// The three-state concurrency gate (inFlight/queues/draining) that used to live inline in
// ControlService.executeTurn. Session-free by design: post-turn sessions-changed detection is
// threaded in via TurnQueueDeps.detectSessionsChanged rather than TurnQueue reaching for a
// sessions dependency itself.
export class TurnQueue {
  private readonly setTimer: (fn: () => void, ms: number) => unknown;
  private readonly clearTimer: (id: unknown) => void;

  constructor(private readonly deps: TurnQueueDeps) {
    this.setTimer = deps.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
    this.clearTimer = deps.clearTimer ?? ((id) => clearTimeout(id as ReturnType<typeof setTimeout>));
  }

  // Each in-flight turn carries its AbortController plus a `settled` promise that resolves
  // once the turn has fully unwound (transport cancelled, inFlight cleared).
  private readonly inFlight = new Map<string, { controller: AbortController; settled: Promise<void> }>();

  // Per-session FIFO queue of prompts that arrived while a turn was already running. Only
  // interactive submissions with `queueable: true` enqueue; non-queueable (scheduled) turns
  // keep rejecting immediately. Drained by the turn-finish hand-off in advanceQueue.
  private readonly queues = new Map<string, QueuedPrompt[]>();

  // Set synchronously during a turn-finish drain hand-off: the finished turn has cleared its
  // inFlight entry but the drained head has not yet re-registered its own. The enqueue gate
  // treats `draining.has(key)` as busy so nothing starts a parallel turn in that window. The
  // drained turn clears it right after it re-registers inFlight.
  private readonly draining = new Set<string>();

  queueLength(chatKey: string, sessionAlias: string): number {
    return this.queues.get(turnKey(chatKey, sessionAlias))?.length ?? 0;
  }

  isBusy(chatKey: string, sessionAlias: string): boolean {
    const key = turnKey(chatKey, sessionAlias);
    const existing = this.inFlight.get(key);
    return this.draining.has(key) || (existing !== undefined && !existing.controller.signal.aborted);
  }

  private emitQueueUpdated(chatKey: string, sessionAlias: string): void {
    const items = (this.queues.get(turnKey(chatKey, sessionAlias)) ?? []).map((q) => ({
      id: q.id,
      textPreview: q.text.length > QUEUE_PREVIEW_MAX ? q.text.slice(0, QUEUE_PREVIEW_MAX) : q.text,
      enqueuedAt: q.enqueuedAt,
    }));
    this.deps.emitQueueUpdated(chatKey, sessionAlias, items);
  }

  async submit(params: SubmitParams): Promise<SubmitResult> {
    const key = turnKey(params.chatKey, params.sessionAlias);
    // A drained head turn (params.drained) is the turn the just-finished turn intentionally
    // started next; it must bypass this gate (it re-registers its own inFlight and clears the
    // `draining` guard synchronously at its top). Every other caller treats a live turn OR an
    // in-progress drain hand-off as busy.
    if (!params.drained) {
      const existing = this.inFlight.get(key);
      // Busy when a live un-cancelled turn holds the slot, OR a drain hand-off is mid-flight
      // (inFlight momentarily cleared but the drained head not yet re-registered).
      const busy = this.draining.has(key) || (existing !== undefined && !existing.controller.signal.aborted);
      if (busy) {
        if (params.queueable) {
          const id = randomUUID();
          const item: QueuedPrompt = {
            id,
            text: params.text,
            enqueuedAt: new Date().toISOString(),
            senderId: params.senderId,
            ...(params.isOwner !== undefined ? { isOwner: params.isOwner } : {}),
            ...(params.accountId !== undefined ? { accountId: params.accountId } : {}),
            ...(params.media !== undefined ? { media: params.media } : {}),
          };
          const q = this.queues.get(key) ?? [];
          q.push(item);
          this.queues.set(key, q);
          this.emitQueueUpdated(params.chatKey, params.sessionAlias);
          return { ok: true, queued: true, queueItemId: id };
        }
        // Not queueable (e.g. a scheduled turn) — reject right away.
        return { ok: false, errorMessage: "turn-already-running" };
      }
      if (existing) {
        // existing is present but its controller is aborted (a Stop is unwinding it) and no
        // drain is in progress. Cancelling the transport and draining the agent takes time,
        // during which the turn stays registered. Wait (bounded) for it to clear so the user's
        // immediate follow-up starts a fresh turn instead of hitting "turn-already-running"; a
        // wedged turn still falls through to the rejection below.
        await raceWithTimeout(existing.settled, CANCEL_DRAIN_TIMEOUT_MS);
        if (this.inFlight.has(key)) {
          return { ok: false, errorMessage: "turn-already-running" };
        }
      }
    }
    const controller = new AbortController();
    // Link an external abort (scheduler dispatch timeout) to this turn so a wedged scheduled
    // prompt is cancelled cooperatively, just like a user Stop.
    if (params.abortSignal) {
      if (params.abortSignal.aborted) controller.abort();
      else params.abortSignal.addEventListener("abort", () => controller.abort(), { once: true });
    }
    let resolveSettled!: () => void;
    const settled = new Promise<void>((resolve) => { resolveSettled = resolve; });
    // SYNCHRONOUS PREFIX: everything from the busy-decision above through this inFlight.set runs
    // with no await, so two submits in the same tick see a consistent gate — the first registers
    // inFlight, the second reads it as busy and enqueues. Moving this set (or the busy-check
    // above) behind the runTurn await opens a same-tick window where the second submit starts a
    // parallel turn. Pinned by turn-queue.test.ts "submit's busy-decision + enqueue is a
    // synchronous prefix (same tick, zero await)": that mutation reddens its zero-await
    // queueLength===1 / isBusy===true assertions.
    this.inFlight.set(key, { controller, settled });
    // A drained head turn has now re-registered its own inFlight synchronously (no await since
    // the finished turn's finally). Clear the hand-off guard: the slot is genuinely held again,
    // so the temporary `draining` busy marker is no longer needed.
    if (params.drained) {
      this.draining.delete(key);
    }
    // Inactivity watchdog: abort a turn that produces no agent activity for turnIdleTimeoutMs.
    // Armed here (covers the silent cold-start / agent-init window), reset on each onActivity,
    // cleared in the finally when the turn settles. `<= 0`/absent disables it.
    const idleMs = this.deps.turnIdleTimeoutMs?.() ?? 0;
    let idleTimer: unknown;
    const armIdle = () => {
      if (idleMs <= 0) return;
      idleTimer = this.setTimer(() => controller.abort(TURN_IDLE_TIMEOUT), idleMs);
      const t = idleTimer as { unref?: () => void };
      if (typeof t.unref === "function") t.unref();
    };
    const onActivity = () => {
      if (idleMs <= 0) return;
      if (idleTimer) this.clearTimer(idleTimer);
      armIdle();
    };
    armIdle();
    let result: TurnResult | undefined;
    try {
      result = await this.deps.runTurn(
        {
          chatKey: params.chatKey,
          sessionAlias: params.sessionAlias,
          text: params.text,
          senderId: params.senderId,
          ...(params.isOwner !== undefined ? { isOwner: params.isOwner } : {}),
          ...(params.accountId !== undefined ? { accountId: params.accountId } : {}),
          ...(params.turnStarted ? { turnStarted: params.turnStarted } : {}),
          ...(params.media !== undefined ? { media: params.media } : {}),
        },
        controller.signal,
        onActivity,
      );
    } finally {
      if (idleTimer) this.clearTimer(idleTimer);
      // If a queued head is waiting, mark `draining` synchronously NOW — before the slot is
      // handed off, and before the awaited post-turn detection below — so nothing starts a
      // parallel turn during the release→drain window, even for an *aborted* turn whose
      // lingering inFlight entry no longer reads as busy. This is the single writer of the
      // hand-off guard; advanceQueue (called synchronously below) relies on it already being
      // set and the drained turn clears it once it re-registers its own inFlight. When the
      // queue is empty, this turn's still-present inFlight entry is itself the busy marker (a
      // normally-finished turn's controller is not aborted), so no drain is possible.
      if ((this.queues.get(key)?.length ?? 0) > 0) {
        this.draining.add(key);
      }
      // Post-turn `sessions-changed` detection runs HERE, after `draining` is set. A transport
      // session that moved during the turn (archived-restore or `/clear`) needs a dashboard
      // refresh, but the await it takes must stay inside the draining-guarded window, or an
      // aborted turn with a queued item lets a fresh prompt race in. Moving the draining.add
      // above to AFTER this await reddens the golden fixture `aborted-queue-sessions-window`
      // (turn-oracle.test.ts): during that window an aborted turn's lingering inFlight no longer
      // reads as busy, so a fresh prompt would start a parallel turn instead of queueing.
      const detection = result?.postTurnDetection;
      if (detection) {
        await this.deps.detectSessionsChanged(detection);
      }
      resolveSettled();
      // Single decision point (shared whether the run failed at useSession or at the chat
      // drive): start the next queued head as the drained turn while holding the slot, or
      // release inFlight if empty.
      this.advanceQueue(key, params.chatKey, params.sessionAlias);
    }
    // Strip the internal postTurnDetection so the return value stays exactly
    // {ok, text?, errorMessage?} — the golden fixtures record this return value.
    return {
      ok: result!.ok,
      ...(result!.text !== undefined ? { text: result!.text } : {}),
      ...(result!.errorMessage !== undefined ? { errorMessage: result!.errorMessage } : {}),
    };
  }

  // Advances the per-session FIFO queue after a turn ends. If a head exists, starts it as the
  // next (drained) turn while holding the busy slot via `draining`; otherwise releases the
  // inFlight slot. Must be called exactly once per ended turn. Fully synchronous: `draining` is
  // added BEFORE the fire-and-forget drained `submit`, whose `inFlight.set` runs synchronously
  // before its first await — so there is no window in which an incoming submission could
  // observe a not-busy session between the ended turn and the drained turn.
  private advanceQueue(key: string, chatKey: string, sessionAlias: string): void {
    const q = this.queues.get(key);
    const next = q?.shift();
    if (q && q.length === 0) this.queues.delete(key);
    if (next) {
      // `draining` is already set here: this runs synchronously inside submit's finally, which
      // set `draining` (when the queue was non-empty) before calling advanceQueue. That guard
      // stays up across the fire-and-forget drained submit below until the drained turn
      // re-registers its own inFlight, so a submit landing in that gap sees a busy gate rather
      // than starting a parallel turn — pinned by turn-queue.test.ts "a submit arriving during
      // the drain hand-off enqueues (no parallel turn)".
      // The head was already popped above; emit the shorter snapshot.
      this.emitQueueUpdated(chatKey, sessionAlias);
      // Fire-and-forget: the drained turn drives its own settled lifecycle. It bypasses the
      // busy gate (drained: true), re-registers inFlight and clears `draining` at its top — all
      // synchronously before the first await — so there is no parallel-turn window. Pass
      // queueItemId ONLY, never prompt: the hub already persisted the inbound at enqueue, so
      // re-emitting prompt would double-persist and duplicate the bubble.
      void this.submit({
        chatKey,
        sessionAlias,
        text: next.text,
        senderId: next.senderId,
        queueable: true,
        drained: true,
        ...(next.isOwner !== undefined ? { isOwner: next.isOwner } : {}),
        ...(next.accountId !== undefined ? { accountId: next.accountId } : {}),
        ...(next.media !== undefined ? { media: next.media } : {}),
        turnStarted: { queueItemId: next.id },
      });
    } else {
      // The queue emptied during the drain hand-off (e.g. a cancel removed the only queued
      // item while the finally's post-turn detection was in flight, after the finally set
      // `draining`). No drained turn is coming to clear the guard, so clear it here too —
      // otherwise `draining` leaks and every future submission enqueues forever (permanent
      // wedge).
      this.draining.delete(key);
      this.inFlight.delete(key);
    }
  }

  cancelTurn(chatKey: string, sessionAlias: string): boolean {
    const entry = this.inFlight.get(turnKey(chatKey, sessionAlias));
    if (!entry) {
      return false;
    }
    entry.controller.abort();
    return true;
  }

  /** Remove a pending queued prompt (by id) before it drains. No-ops (returns
   *  `{ cancelled: false }`) when the queue or the id is absent/already drained — e.g. a race
   *  where the item drained into a running turn just before the cancel arrived. Does NOT touch
   *  a turn that is already running (use `cancelTurn`). */
  cancelQueuedItem(chatKey: string, sessionAlias: string, itemId: string): { cancelled: boolean } {
    const key = turnKey(chatKey, sessionAlias);
    const q = this.queues.get(key);
    if (!q) return { cancelled: false };
    const i = q.findIndex((x) => x.id === itemId);
    if (i < 0) return { cancelled: false };
    q.splice(i, 1);
    if (q.length === 0) this.queues.delete(key);
    this.emitQueueUpdated(chatKey, sessionAlias);
    return { cancelled: true };
  }
}
