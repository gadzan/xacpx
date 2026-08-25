import { randomUUID } from "node:crypto";

import type { PromptAttachmentRef } from "@ganglion/xacpx-relay-protocol";
import type { TurnRequest, TurnResult } from "./session-turn-runner";
import {
  turnKey,
  raceWithTimeout,
  type QueuedPrompt,
  CANCEL_DRAIN_TIMEOUT_MS,
  QUEUE_MAX_DEPTH,
  QUEUE_PREVIEW_MAX,
  TURN_IDLE_TIMEOUT_REASON,
  type PeerTurnOrigin,
  type AgentMessageCompletion,
  type TurnIdleTimeoutDetail,
} from "./turn-support";

export interface QueuedItemSnapshot {
  id: string;
  textPreview: string;
  enqueuedAt: string;
  /** v0.4: present ONLY for a reserved-but-not-started peer interrupt
   *  (snapshot-first item). Lets the existing per-item cancel surface reach
   *  the interrupt slot by id (spec §11.1) without a new RPC. */
  kind?: "interrupt";
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
  // Invoked at the moment the inactivity watchdog fires an abort, carrying the concrete
  // threshold (idleMs) and the session it fired for, so the caller can log the reclaim
  // (main wires this to the app logger). Absent = no observability hook.
  onIdleTimeout?: (detail: TurnIdleTimeoutDetail) => void;
  // Injectable timers (default setTimeout/clearTimeout), for deterministic tests.
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (id: unknown) => void;
  // Bound on how long clearSession waits for an aborted turn to unwind before reporting
  // `cleared: false`. Defaults to CANCEL_DRAIN_TIMEOUT_MS; injectable for tests.
  cancelDrainTimeoutMs?: number;
  // v0.3: a queued PEER item carrying a completion contract (peerOrigin.completion
  // !== "none") was removed BEFORE it could start (cancelQueuedItem or
  // clearSession/archive). No turn-finished(peerOrigin) will ever fire for it, so
  // the source's terminal-completion contract would dangle forever. The caller
  // MUST route exactly one terminal cancelled outcome through the completion state
  // machine. Best-effort and synchronous; must not throw.
  onQueuedPeerCancelled?: (detail: {
    chatKey: string;
    sessionAlias: string;
    peerOrigin: PeerTurnOrigin;
    promptRequestId?: string;
  }) => void;
  // v0.4 Peer Interrupt Delivery: structured lifecycle events (spec §17) —
  // reserved / abort_signalled / started / cancelled_before_start /
  // rejected_pending. Best-effort: a throwing observer never affects lane
  // state.
  onPeerInterruptEvent?: (event: PeerInterruptEvent) => void;
}

/** v0.4: structured peer-interrupt lifecycle event (spec §17). Ids and lane
 *  keys only — never message content. */
export interface PeerInterruptEvent {
  kind:
    | "reserved"
    | "abort_signalled"
    | "started"
    | "cancelled_before_start"
    | "rejected_pending";
  chatKey: string;
  sessionAlias: string;
  requestMessageId?: string;
  promptRequestId?: string;
  /** rejected_pending only: requestMessageId of the reservation that occupied
   *  the slot (the event's own ids describe the REJECTED request). */
  pendingRequestMessageId?: string;
  predecessorWasAlreadyAborted?: boolean;
}

export interface SubmitParams {
  chatKey: string;
  sessionAlias: string;
  boundSessionAlias?: string;
  concurrencyKey?: string;
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
  agentMentions?: Array<{ range: [number, number]; handle: string }>;
  isPeerMessage?: boolean;
  allowRestoreArchived?: boolean;
  preserveCoordinatorRoute?: boolean;
  /** Hub-issued pre-write correlation; stored on the queue item and carried onto the

   *  drained turn-started so the hub can correlate a queue item back to its
   *  pre-written inbound row (see PromptPayload.promptRequestId). */
  promptRequestId?: string;
  peerOrigin?: PeerTurnOrigin;
  /** v0.3 structured system completion — see QueuedPrompt.trustedPeerCompletion. */
  trustedPeerCompletion?: AgentMessageCompletion;
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
/** v0.4: result of `submitPeerInterrupt`. `queued`+`interrupt` = busy target:
 * the reservation is held and the predecessor cancel has been signalled.
 * `injected`+`prompt` = idle target: ordinary synchronous peer admission with
 * zero cancellations. Rejections reuse the existing reasons ("target-unavailable",
 * "queue-full" — the latter also enforces the one-pending-interrupt slot rule,
 * spec §8/§16). */
export type PeerInterruptAdmission =
  | { status: "injected"; modeUsed: "prompt" }
  | { status: "queued"; modeUsed: "interrupt"; queueItemId: string }
  | { status: "rejected"; reason: string };

// The three-state concurrency gate (inFlight/queues/draining) that used to live inline in
// ControlService.executeTurn. Session-free by design: post-turn sessions-changed detection is
// threaded in via TurnQueueDeps.detectSessionsChanged rather than TurnQueue reaching for a
// sessions dependency itself.
export class TurnQueue {
  private readonly setTimer: (fn: () => void, ms: number) => unknown;
  private readonly clearTimer: (id: unknown) => void;
  private readonly cancelDrainTimeoutMs: number;

  constructor(private readonly deps: TurnQueueDeps) {
    this.setTimer = deps.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
    this.clearTimer = deps.clearTimer ?? ((id) => clearTimeout(id as ReturnType<typeof setTimeout>));
    this.cancelDrainTimeoutMs = deps.cancelDrainTimeoutMs ?? CANCEL_DRAIN_TIMEOUT_MS;
  }

  // Each in-flight turn carries its AbortController plus a `settled` promise that resolves
  // once the turn has fully unwound (transport cancelled, inFlight cleared).
  private readonly inFlight = new Map<
    string,
    { controller: AbortController; settled: Promise<void>; promptRequestId?: string }
  >();
  /**
   * Settled request-id tombstones (v0.3): a completion delivery whose
   * promptRequestId already RAN to completion must not be re-admitted by a
   * late retry — the in-flight/queued dedupe above no longer covers it once
   * the turn resolved. Bounded FIFO eviction.
   */
  private readonly settledRequestIds = new Map<string, number>();
  private static readonly SETTLED_REQUEST_IDS_MAX = 2_000;

  // Per-session FIFO queue of prompts that arrived while a turn was already running. Only
  // interactive submissions with `queueable: true` enqueue; non-queueable (scheduled) turns
  // keep rejecting immediately. Drained by the turn-finish hand-off in advanceQueue.
  private readonly queues = new Map<string, QueuedPrompt[]>();

  // v0.4 Peer Interrupt Delivery: at most ONE reserved interrupt per lane, held
  // OUTSIDE the normal FIFO (spec §7): in-flight → pending interrupt → normal
  // queue. The slot is independent of QUEUE_MAX_DEPTH and never evicts or
  // reorders queued prompts. advanceQueue drains it ahead of the FIFO head
  // after the predecessor has TRULY settled (inFlight cleared).
  private readonly pendingInterrupts = new Map<string, QueuedPrompt>();

  // Set synchronously during a turn-finish drain hand-off: the finished turn has cleared its
  // inFlight entry but the drained head has not yet re-registered its own. The enqueue gate
  // treats `draining.has(key)` as busy so nothing starts a parallel turn in that window. The
  // drained turn clears it right after it re-registers inFlight.
  private readonly draining = new Set<string>();

  // Held between a successful clearSession and the caller's finishClear, i.e. across the
  // transport teardown of a session being removed/archived. The busy gate honors it so a
  // scheduled (non-queueable) turn firing in that window is rejected instead of cold-starting
  // a fresh turn on the session being torn down (which would write ghost history). The hub's
  // exclusive turn-lock already serializes web/lifecycle RPCs; this closes the connector-local
  // scheduler path that never touches that lock.
  private readonly removing = new Set<string>();

  private resolveKey(chatKey: string, sessionAlias: string, concurrencyKey?: string): string {
    if (concurrencyKey) {
      return concurrencyKey;
    }
    const directKey = turnKey(chatKey, sessionAlias);
    if (
      this.inFlight.has(directKey) ||
      this.queues.has(directKey) ||
      this.draining.has(directKey) ||
      this.removing.has(directKey) ||
      this.pendingInterrupts.has(directKey)
    ) {
      return directKey;
    }
    const cleanAlias = sessionAlias.includes(":") ? sessionAlias.split(":").pop()! : sessionAlias;
    for (const k of this.inFlight.keys()) {
      if (k === directKey || k.endsWith(":" + cleanAlias) || k.endsWith(" " + cleanAlias) || k === cleanAlias) return k;
    }
    for (const k of this.queues.keys()) {
      if (k === directKey || k.endsWith(":" + cleanAlias) || k.endsWith(" " + cleanAlias) || k === cleanAlias) return k;
    }
    for (const k of this.draining) {
      if (k === directKey || k.endsWith(":" + cleanAlias) || k.endsWith(" " + cleanAlias) || k === cleanAlias) return k;
    }
    for (const k of this.removing) {
      if (k === directKey || k.endsWith(":" + cleanAlias) || k.endsWith(" " + cleanAlias) || k === cleanAlias) return k;
    }
    for (const k of this.pendingInterrupts.keys()) {
      if (k === directKey || k.endsWith(":" + cleanAlias) || k.endsWith(" " + cleanAlias) || k === cleanAlias) return k;
    }
    return directKey;
  }

  queueLength(chatKey: string, sessionAlias: string, concurrencyKey?: string): number {
    return this.queues.get(this.resolveKey(chatKey, sessionAlias, concurrencyKey))?.length ?? 0;
  }

  isBusy(chatKey: string, sessionAlias: string, concurrencyKey?: string): boolean {
    const key = this.resolveKey(chatKey, sessionAlias, concurrencyKey);
    const existing = this.inFlight.get(key);
    return this.draining.has(key) || (existing !== undefined && !existing.controller.signal.aborted);
  }

  submitPeerTurn(params: SubmitParams): { status: "injected" | "queued" } | { status: "rejected"; reason: string } {
    const key = this.resolveKey(params.chatKey, params.sessionAlias, params.concurrencyKey);
    if (this.removing.has(key)) {
      return { status: "rejected", reason: "target-unavailable" };
    }
    // Request-id admission dedupe (v0.3): a completion delivery whose
    // promptRequestId already sits in this session's lane — in flight OR
    // queued — is absorbed idempotently. A retry after an ambiguous outcome
    // must never admit a second turn for the same request.
    if (params.promptRequestId !== undefined && params.isPeerMessage) {
      // Settled tombstone first: covers turns that already RAN. The
      // tombstone is only consulted while its TTL holds.
      if (this.hasSettledRequestId(params.promptRequestId)) {
        return { status: "injected" };
      }
      const queuedDup = (this.queues.get(key) ?? []).some(
        (item) => item.promptRequestId === params.promptRequestId,
      );
      const inFlightEntry = this.inFlight.get(key);
      const inFlightDup =
        inFlightEntry?.promptRequestId === params.promptRequestId;
      if (queuedDup || inFlightDup) {
        return { status: "injected" };
      }
    }
    const existing = this.inFlight.get(key);
    // Peer admission must be SYNCHRONOUS: either a queued push or a fresh
    // inFlight registration. An aborted-but-unwound predecessor breaks
    // submit()'s synchronous prefix — submit awaits existing.settled BEFORE
    // registering and may then reject turn-already-running, long after this
    // caller returned injected and tombstoned a request that never entered
    // the queue. For peer turns ANY registered predecessor (aborted or not)
    // counts as busy, so the request takes the synchronous enqueue path
    // behind the unwind; the turn-finish hand-off drains it.
    const busy = this.draining.has(key) || existing !== undefined;
    if (busy) {
      const q = this.queues.get(key) ?? [];
      if (q.length >= QUEUE_MAX_DEPTH) {
        return { status: "rejected", reason: "queue-full" };
      }
      const id = randomUUID();
      const item: QueuedPrompt = {
        id,
        text: params.text,
        enqueuedAt: new Date().toISOString(),
        senderId: params.senderId,
        executionContext: {
          chatKey: params.chatKey,
          sessionAlias: params.sessionAlias,
          ...(params.boundSessionAlias ? { boundSessionAlias: params.boundSessionAlias } : {}),
        },
        concurrencyKey: params.concurrencyKey,
        isPeerMessage: true,
        allowRestoreArchived: false,
        ...(params.isOwner !== undefined ? { isOwner: params.isOwner } : {}),
        ...(params.preserveCoordinatorRoute !== undefined ? { preserveCoordinatorRoute: params.preserveCoordinatorRoute } : {}),
        ...(params.accountId !== undefined ? { accountId: params.accountId } : {}),
        ...(params.media !== undefined ? { media: params.media } : {}),
        ...(params.agentMentions !== undefined ? { agentMentions: params.agentMentions } : {}),
        ...(params.promptRequestId !== undefined ? { promptRequestId: params.promptRequestId } : {}),
        ...(params.peerOrigin !== undefined ? { peerOrigin: params.peerOrigin } : {}),
        ...(params.trustedPeerCompletion !== undefined ? { trustedPeerCompletion: params.trustedPeerCompletion } : {}),
      };
      q.push(item);
      this.queues.set(key, q);
      this.emitQueueUpdated(params.chatKey, params.sessionAlias, key);
      // Admitted (queued): NOW the request id is terminal-safe to tombstone.
      // A queue-full rejection above returns WITHOUT recording, so a retry
      // after capacity frees still gets a real turn.
      this.recordSettledRequestId(params.promptRequestId);
      return { status: "queued" };
    }

    void this.submit({
      ...params,
      queueable: true,
      isPeerMessage: true,
      allowRestoreArchived: false,
    });
    // Admitted (injected): submit's synchronous prefix registers inFlight
    // before any await (see the SYNCHRONOUS PREFIX note in submit), so by
    // this line the turn genuinely holds the lane. Same-tick duplicates now
    // dedupe via the tombstone.
    this.recordSettledRequestId(params.promptRequestId);
    return { status: "injected" };
  }

  /** v0.4 test/observability seam: 1 when a reserved-but-not-started peer
   *  interrupt occupies the lane's slot, else 0 (spec §7: at most one). */
  pendingInterruptCount(chatKey: string, sessionAlias: string, concurrencyKey?: string): number {
    return this.pendingInterrupts.has(this.resolveKey(chatKey, sessionAlias, concurrencyKey)) ? 1 : 0;
  }

  /**
   * v0.4 Peer Interrupt Delivery (spec §6.4/§9): atomic reserve → abort →
   * true-settle → priority-drain, owned entirely by this lane. Synchronous:
   * by the time the accepted result returns, the reservation exists in the
   * lane and a live predecessor's AbortController has been signalled. The
   * interrupting turn itself starts only after the predecessor's `settled`
   * resolves and its inFlight entry is gone (drain hand-off in advanceQueue).
   * Router-level cancel();submit() races are impossible by construction here.
   */
  submitPeerInterrupt(params: SubmitParams): PeerInterruptAdmission {
    const key = this.resolveKey(params.chatKey, params.sessionAlias, params.concurrencyKey);
    if (this.removing.has(key)) {
      return { status: "rejected", reason: "target-unavailable" };
    }
    // Request-id dedupe (spec §13) participates in the SAME lookup family as
    // submitPeerTurn: pending interrupt slot, settled tombstones, normal
    // queue, in-flight. A duplicate returns the ORIGINAL accepted semantic —
    // queued/interrupt while the reservation is pending, injected/prompt once
    // the turn was admitted through the ordinary path. Never a second abort.
    if (params.promptRequestId !== undefined && params.isPeerMessage) {
      const pendingDup = this.pendingInterrupts.get(key);
      if (pendingDup?.promptRequestId === params.promptRequestId) {
        return { status: "queued", modeUsed: "interrupt", queueItemId: pendingDup.id };
      }
      if (this.hasSettledRequestId(params.promptRequestId)) {
        return { status: "injected", modeUsed: "prompt" };
      }
      const queuedDup = (this.queues.get(key) ?? []).some(
        (item) => item.promptRequestId === params.promptRequestId,
      );
      const inFlightDup = this.inFlight.get(key)?.promptRequestId === params.promptRequestId;
      if (queuedDup || inFlightDup) {
        return { status: "injected", modeUsed: "prompt" };
      }
    }
    const existing = this.inFlight.get(key);
    // Busy determination (spec §9): draining OR any registered inFlight entry,
    // even an already-aborted one — the predecessor owns the lane until its
    // `settled` resolves (mirrors the v0.3 peer-admission fix).
    const busy = this.draining.has(key) || existing !== undefined;
    if (!busy) {
      // Idle target: NO cancellation — an ordinary synchronous peer admission
      // (spec G1: cancel count = 0, receipt injected/prompt).
      const idle = this.submitPeerTurn(params);
      if (idle.status === "rejected") return idle;
      if (idle.status === "queued") {
        // Unreachable: submitPeerTurn queues only when the lane reads busy,
        // and the gate above proved it idle. Fail closed rather than invent
        // a receipt shape.
        return { status: "rejected", reason: "queue-full" };
      }
      return { status: "injected", modeUsed: "prompt" };
    }
    // One-slot rule (spec §8): a DIFFERENT interrupt never replaces, cancels
    // again, or silently downgrades to the ordinary queue.
    const pending = this.pendingInterrupts.get(key);
    if (pending) {
      // The event describes the REJECTED request (I2), not the reservation
      // that occupied the slot — the rejected ids come from the incoming
      // params; the occupied reservation's id rides along for storm analysis.
      this.emitPeerInterrupt("rejected_pending", params.chatKey, params.sessionAlias, pending, {
        requestMessageId: params.peerOrigin?.requestMessageId,
        promptRequestId: params.promptRequestId,
        pendingRequestMessageId: pending.peerOrigin?.requestMessageId,
      });
      return { status: "rejected", reason: "queue-full" };
    }
    const id = randomUUID();
    const item: QueuedPrompt = {
      id,
      text: params.text,
      enqueuedAt: new Date().toISOString(),
      senderId: params.senderId,
      executionContext: {
        chatKey: params.chatKey,
        sessionAlias: params.sessionAlias,
        ...(params.boundSessionAlias ? { boundSessionAlias: params.boundSessionAlias } : {}),
      },
      concurrencyKey: params.concurrencyKey,
      isPeerMessage: true,
      allowRestoreArchived: false,
      ...(params.isOwner !== undefined ? { isOwner: params.isOwner } : {}),
      ...(params.preserveCoordinatorRoute !== undefined ? { preserveCoordinatorRoute: params.preserveCoordinatorRoute } : {}),
      ...(params.accountId !== undefined ? { accountId: params.accountId } : {}),
      ...(params.media !== undefined ? { media: params.media } : {}),
      ...(params.agentMentions !== undefined ? { agentMentions: params.agentMentions } : {}),
      ...(params.promptRequestId !== undefined ? { promptRequestId: params.promptRequestId } : {}),
      ...(params.peerOrigin !== undefined ? { peerOrigin: params.peerOrigin } : {}),
      ...(params.trustedPeerCompletion !== undefined ? { trustedPeerCompletion: params.trustedPeerCompletion } : {}),
    };
    // Reservation FIRST (synchronous acceptance invariant, spec §9.1): the ACK
    // may return before the predecessor unwinds because the lane already owns
    // the next turn. Tombstone only AFTER the reservation exists, mirroring
    // submitPeerTurn's ordering (a rejection must never poison the request id).
    this.pendingInterrupts.set(key, item);
    this.recordSettledRequestId(params.promptRequestId);
    const predecessorWasAlreadyAborted = existing?.controller.signal.aborted ?? false;
    this.emitPeerInterrupt("reserved", params.chatKey, params.sessionAlias, item, {
      predecessorWasAlreadyAborted,
    });
    // Exactly-once cancel: a pre-aborted predecessor (user Stop unwinding) is
    // never aborted again (spec §6.4 aborted-but-unsettled). AbortController
    // abort() is idempotent; the guard keeps the intent explicit.
    if (existing && !predecessorWasAlreadyAborted) {
      existing.controller.abort();
      this.emitPeerInterrupt("abort_signalled", params.chatKey, params.sessionAlias, item);
    }
    // Publish the reservation: the snapshot leads with the kind:"interrupt"
    // item, so the existing per-item cancel surface can address this slot by
    // id (spec §11.1) — no new RPC, no receipt-shape change.
    this.emitQueueUpdated(params.chatKey, params.sessionAlias, key);
    return { status: "queued", modeUsed: "interrupt", queueItemId: id };
  }

  // Best-effort structured observability (spec §17): a throwing observer never
  // affects lane state; events carry ids and lane keys, never message content.
  private emitPeerInterrupt(
    kind: "reserved" | "abort_signalled" | "started" | "cancelled_before_start" | "rejected_pending",
    chatKey: string,
    sessionAlias: string,
    item: QueuedPrompt | undefined,
    ids?: {
      requestMessageId?: string;
      promptRequestId?: string;
      /** rejected_pending only: requestMessageId of the reservation that
       *  occupied the slot. */
      pendingRequestMessageId?: string;
      predecessorWasAlreadyAborted?: boolean;
    },
  ): void {
    if (!this.deps.onPeerInterruptEvent) return;
    try {
      this.deps.onPeerInterruptEvent({
        kind,
        chatKey,
        sessionAlias,
        ...(ids?.requestMessageId !== undefined
          ? { requestMessageId: ids.requestMessageId }
          : item?.peerOrigin?.requestMessageId !== undefined
            ? { requestMessageId: item.peerOrigin.requestMessageId }
            : {}),
        ...(ids?.promptRequestId !== undefined
          ? { promptRequestId: ids.promptRequestId }
          : item?.promptRequestId !== undefined
            ? { promptRequestId: item.promptRequestId }
            : {}),
        ...(ids?.pendingRequestMessageId !== undefined
          ? { pendingRequestMessageId: ids.pendingRequestMessageId }
          : {}),
        ...(ids?.predecessorWasAlreadyAborted !== undefined
          ? { predecessorWasAlreadyAborted: ids.predecessorWasAlreadyAborted }
          : {}),
      });
    } catch {
      // observer errors are swallowed by contract
    }
  }

  private hasSettledRequestId(id: string): boolean {
    const expiresAt = this.settledRequestIds.get(id);
    if (expiresAt === undefined) return false;
    if (expiresAt <= Date.now()) {
      this.settledRequestIds.delete(id);
      return false;
    }
    return true;
  }

  private recordSettledRequestId(id: string | undefined): void {
    if (id === undefined) return;
    this.settledRequestIds.set(id, Date.now() + 24 * 60 * 60_000);
    while (this.settledRequestIds.size > TurnQueue.SETTLED_REQUEST_IDS_MAX) {
      const oldest = this.settledRequestIds.keys().next().value;
      if (oldest === undefined) break;
      this.settledRequestIds.delete(oldest);
    }
  }

  /** Terminal cancellation for queued peer items dropped before execution. */
  private notifyQueuedPeerCancelled(items: readonly QueuedPrompt[]): void {
    for (const item of items) {
      if (item.isPeerMessage !== true) continue;
      if (!item.peerOrigin || item.peerOrigin.completion === "none") continue;
      try {
        this.deps.onQueuedPeerCancelled?.({
          chatKey: item.executionContext.chatKey,
          sessionAlias: item.executionContext.sessionAlias,
          peerOrigin: item.peerOrigin,
          ...(item.promptRequestId !== undefined
            ? { promptRequestId: item.promptRequestId }
            : {}),
        });
      } catch {
        // best-effort by contract — removal proceeds regardless
      }
    }
  }

  private emitQueueUpdated(chatKey: string, sessionAlias: string, queueKey?: string): void {
    const key = queueKey ?? this.resolveKey(chatKey, sessionAlias);
    const interrupt = this.pendingInterrupts.get(key);
    const items: QueuedItemSnapshot[] = interrupt
      ? [{
          id: interrupt.id,
          textPreview:
            interrupt.text.length > QUEUE_PREVIEW_MAX
              ? interrupt.text.slice(0, QUEUE_PREVIEW_MAX)
              : interrupt.text,
          enqueuedAt: interrupt.enqueuedAt,
          kind: "interrupt",
        }]
      : [];
    for (const q of this.queues.get(key) ?? []) {
      items.push({
        id: q.id,
        textPreview: q.text.length > QUEUE_PREVIEW_MAX ? q.text.slice(0, QUEUE_PREVIEW_MAX) : q.text,
        enqueuedAt: q.enqueuedAt,
      });
    }
    this.deps.emitQueueUpdated(chatKey, sessionAlias, items);
  }

  async submit(params: SubmitParams): Promise<SubmitResult> {
    const key = params.concurrencyKey ?? turnKey(params.chatKey, params.sessionAlias);
    // A drained head turn (params.drained) is the turn the just-finished turn intentionally
    // started next; it must bypass this gate (it re-registers its own inFlight and clears the
    // `draining` guard synchronously at its top). Every other caller treats a live turn OR an
    // in-progress drain hand-off as busy.
    if (!params.drained) {
      const existing = this.inFlight.get(key);
      // Busy when a live un-cancelled turn holds the slot, a drain hand-off is mid-flight
      // (inFlight momentarily cleared but the drained head not yet re-registered), OR the
      // session is mid-teardown (clearSession succeeded, transport removal in flight) — the
      // last guards against a scheduled turn cold-starting on a session being removed.
      const busy =
        this.removing.has(key) ||
        this.draining.has(key) ||
        (existing !== undefined && !existing.controller.signal.aborted);
      if (busy) {
        if (params.queueable) {
          const q = this.queues.get(key) ?? [];
          if (q.length >= QUEUE_MAX_DEPTH) {
            return { ok: false, errorMessage: "queue-full" };
          }
          const id = randomUUID();
          const item: QueuedPrompt = {
            id,
            text: params.text,
            enqueuedAt: new Date().toISOString(),
            senderId: params.senderId,
            executionContext: {
              chatKey: params.chatKey,
              sessionAlias: params.sessionAlias,
              ...(params.boundSessionAlias ? { boundSessionAlias: params.boundSessionAlias } : {}),
            },
            concurrencyKey: params.concurrencyKey,
            isPeerMessage: params.isPeerMessage,
            allowRestoreArchived: params.allowRestoreArchived,
            ...(params.isOwner !== undefined ? { isOwner: params.isOwner } : {}),
            ...(params.preserveCoordinatorRoute !== undefined ? { preserveCoordinatorRoute: params.preserveCoordinatorRoute } : {}),
            ...(params.accountId !== undefined ? { accountId: params.accountId } : {}),
            ...(params.media !== undefined ? { media: params.media } : {}),
            ...(params.agentMentions !== undefined ? { agentMentions: params.agentMentions } : {}),
            ...(params.promptRequestId !== undefined ? { promptRequestId: params.promptRequestId } : {}),
            ...(params.peerOrigin !== undefined ? { peerOrigin: params.peerOrigin } : {}),
            ...(params.trustedPeerCompletion !== undefined ? { trustedPeerCompletion: params.trustedPeerCompletion } : {}),
          };
          q.push(item);
          this.queues.set(key, q);
          this.emitQueueUpdated(params.chatKey, params.sessionAlias, key);
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
    this.inFlight.set(key, {
      controller,
      settled,
      ...(params.promptRequestId !== undefined
        ? { promptRequestId: params.promptRequestId }
        : {}),
    });
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
    // Exactly-once latch. The abort is cooperative, so a final agent event can still arrive AFTER
    // the watchdog fires (or after a user Stop) and drive onActivity → armIdle again — that would
    // arm a second timer and fire a second onIdleTimeout / abort. Once fired (or once the turn is
    // aborted for any reason), the watchdog is done: neither arm nor reset does anything more.
    let watchdogFired = false;
    const armIdle = () => {
      if (idleMs <= 0 || watchdogFired || controller.signal.aborted) return;
      idleTimer = this.setTimer(() => {
        if (watchdogFired || controller.signal.aborted) return; // lost a race with a prior fire/Stop
        watchdogFired = true;
        // Log the concrete threshold that reclaimed this wedged turn BEFORE aborting, so the
        // reclaim is observable (spec: TurnQueue owns the threshold and logs the concrete N). The
        // abort runs in `finally` so a throwing log hook can never leave the wedged turn un-aborted.
        try {
          this.deps.onIdleTimeout?.({ chatKey: params.chatKey, sessionAlias: params.sessionAlias, idleMs });
        } finally {
          controller.abort(TURN_IDLE_TIMEOUT_REASON);
        }
      }, idleMs);
      const t = idleTimer as { unref?: () => void };
      if (typeof t.unref === "function") t.unref();
    };
    armIdle();
    const onActivity = () => {
      if (idleMs <= 0 || watchdogFired || controller.signal.aborted) return;
      if (idleTimer) this.clearTimer(idleTimer);
      armIdle();
    };
    let result: TurnResult | undefined;
    try {
      const turnStarted = params.turnStarted
        ? (params.promptRequestId !== undefined && params.turnStarted.promptRequestId === undefined
            ? { ...params.turnStarted, promptRequestId: params.promptRequestId }
            : params.turnStarted)
        : (params.promptRequestId !== undefined
            ? { promptRequestId: params.promptRequestId }
            : undefined);
      result = await this.deps.runTurn(
        {
          chatKey: params.chatKey,
          sessionAlias: params.sessionAlias,
          boundSessionAlias: params.boundSessionAlias,
          text: params.text,
          senderId: params.senderId,
          isOwner: params.isOwner,
          accountId: params.accountId,
          turnStarted,
          media: params.media,
          agentMentions: params.agentMentions,
          allowRestoreArchived: params.allowRestoreArchived,
          preserveCoordinatorRoute: params.preserveCoordinatorRoute,
          peerOrigin: params.peerOrigin,
          trustedPeerCompletion: params.trustedPeerCompletion,
        },
        controller.signal,
        onActivity,
      );
    } catch (error) {
      result = { ok: false, errorMessage: String(error) };
    } finally {
      if (idleTimer) this.clearTimer(idleTimer);
      // If a queued head OR a reserved peer interrupt is waiting, mark `draining` synchronously NOW — before the slot is
      // parallel turn during the release→drain window, even for an *aborted* turn whose
      // lingering inFlight entry no longer reads as busy. This is the single writer of the
      // hand-off guard; advanceQueue (called synchronously below) relies on it already being
      // set and the drained turn clears it once it re-registers its own inFlight. When the
      // queue is empty, this turn's still-present inFlight entry is itself the busy marker (a
      // normally-finished turn's controller is not aborted), so no drain is possible.
      if ((this.queues.get(key)?.length ?? 0) > 0 || this.pendingInterrupts.has(key)) {
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
      this.advanceQueue(key);
    }
    // Strip the internal postTurnDetection so the return value stays exactly
    // {ok, text?, errorMessage?} — the golden fixtures record this return value.
    return {
      ok: result!.ok,
      ...(result!.text !== undefined ? { text: result!.text } : {}),
      ...(result!.errorMessage !== undefined ? { errorMessage: result!.errorMessage } : {}),
    };
  }

  // Advances the per-session lane after a turn ends. Drain priority (spec §10):
  // 1. pending interrupt, 2. normal FIFO head, 3. idle release. The chosen head
  // starts as the next (drained) turn while holding the busy slot via `draining`.
  // Must be called exactly once per ended turn. Fully synchronous: `draining` is
  // added BEFORE the fire-and-forget drained `submit`, whose `inFlight.set` runs
  // synchronously before its first await — so there is no window in which an
  // incoming submission could observe a not-busy session between the ended turn
  // and the drained turn.
  private advanceQueue(key: string): void {
    const interrupt = this.pendingInterrupts.get(key);
    if (interrupt) {
      // Removed from the slot SYNCHRONOUSLY before it re-registers as inFlight
      // (spec §10) — a cancel racing after this point addresses a running turn,
      // not a reservable slot.
      this.pendingInterrupts.delete(key);
      this.emitPeerInterrupt(
        "started",
        interrupt.executionContext.chatKey,
        interrupt.executionContext.sessionAlias,
        interrupt,
      );
      this.drainQueuedPrompt(key, interrupt);
      return;
    }
    const q = this.queues.get(key);
    const next = q?.shift();
    if (q && q.length === 0) this.queues.delete(key);
    if (next) {
      this.drainQueuedPrompt(key, next);
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

  // Fire-and-forget drained-turn start (shared by interrupt + FIFO heads): the
  // drained turn drives its own settled lifecycle. It bypasses the busy gate
  // (drained: true), re-registers inFlight and clears `draining` at its top —
  // all synchronously before the first await — so there is no parallel-turn
  // window. The prompt and queueItemId let web clients associate the optimistic
  // enqueue-time bubble with this execution-time event without guessing by
  // message text.
  private drainQueuedPrompt(key: string, next: QueuedPrompt): void {
    // `draining` is already set here: this runs synchronously inside submit's finally, which
    // set `draining` (when the queue was non-empty) before calling advanceQueue. That guard
    // stays up across the fire-and-forget drained submit below until the drained turn
    // re-registers its own inFlight, so a submit landing in that gap sees a busy gate rather
    // than starting a parallel turn — pinned by turn-queue.test.ts "a submit arriving during
    // the drain hand-off enqueues (no parallel turn)".
    this.emitQueueUpdated(
      next.executionContext.chatKey,
      next.executionContext.sessionAlias,
      key,
    );
    const concurrencyKey = next.concurrencyKey ?? key;
    const turnStarted = next.isPeerMessage
      ? { queueItemId: next.id, ...(next.promptRequestId !== undefined ? { promptRequestId: next.promptRequestId } : {}) }
      : { prompt: next.text, queueItemId: next.id, ...(next.promptRequestId !== undefined ? { promptRequestId: next.promptRequestId } : {}) };
    void this.submit({
      chatKey: next.executionContext.chatKey,
      sessionAlias: next.executionContext.sessionAlias,
      boundSessionAlias: next.executionContext.boundSessionAlias,
      concurrencyKey,
      text: next.text,
      senderId: next.senderId,
      queueable: true,
      drained: true,
      isPeerMessage: next.isPeerMessage,
      allowRestoreArchived: next.allowRestoreArchived,
      preserveCoordinatorRoute: next.preserveCoordinatorRoute,
      promptRequestId: next.promptRequestId,
      peerOrigin: next.peerOrigin,
      trustedPeerCompletion: next.trustedPeerCompletion,
      ...(next.isOwner !== undefined ? { isOwner: next.isOwner } : {}),
      ...(next.accountId !== undefined ? { accountId: next.accountId } : {}),
      ...(next.media !== undefined ? { media: next.media } : {}),
      ...(next.agentMentions !== undefined ? { agentMentions: next.agentMentions } : {}),
      turnStarted,
    });
  }

  cancelTurn(chatKey: string, sessionAlias: string, concurrencyKey?: string): boolean {
    const key = this.resolveKey(chatKey, sessionAlias, concurrencyKey);
    const entry = this.inFlight.get(key);
    if (!entry) {
      return false;
    }
    entry.controller.abort();
    return true;
  }

  /** Tear down all turn state for a session that is being removed or archived: drop every
   *  queued prompt, abort a running turn, and wait (bounded) for it to unwind. The queue is
   *  cleared BEFORE the abort so the aborting turn's finally sees it empty and releases the
   *  slot instead of draining a head onto the dead session. Returns `cleared: false` when the
   *  session still holds turn state after the bounded wait (a wedged turn that outlived the
   *  timeout, or a fresh prompt that slipped in during the unwind) — the caller MUST NOT
   *  proceed with removal/archive then, or the surviving turn's events would write history
   *  rows for a session that no longer exists.
   *
   *  NOT side-effect-free even when it returns `cleared: false`: it has already aborted the
   *  in-flight turn and dropped every queued prompt (emitting `queue-updated([])`). The caller
   *  should surface a retry, not present the failure as a no-op.
   *
   *  The teardown guard (`removing`) is armed SYNCHRONOUSLY on ENTRY — before
   *  any await — so peer admissions (`submitPeerTurn` / `submitPeerInterrupt`)
   *  fail closed `target-unavailable` for the ENTIRE clear lifecycle; a peer
   *  interrupt arriving mid-unwind can never be reserved and drained onto the
   *  dying session. On `cleared: true` the guard stays armed across the
   *  caller's transport teardown; on `cleared: false` it is released so a
   *  retry sees a usable lane. The caller MUST call `finishClear` once
   *  teardown settles (success or failure) to release the guard. */
  async clearSession(chatKey: string, sessionAlias: string, concurrencyKey?: string): Promise<{ cleared: boolean }> {
    const key = this.resolveKey(chatKey, sessionAlias, concurrencyKey);
    // v0.4 P1: arm the teardown guard SYNCHRONOUSLY, BEFORE any await. The
    // unwind window below (awaiting the aborted turn's `settled`) otherwise
    // lets a fresh submitPeerTurn/submitPeerInterrupt read the lane as merely
    // busy: the interrupt would be RESERVED, then the old turn's finally
    // drains it straight onto the dying session — teardown resurrection
    // (spec §11.2). With the guard up, both peer admissions fail closed
    // `target-unavailable` for the whole clear lifecycle. Released below on
    // `cleared: false` so a retryable failure leaves the lane usable.
    const guardPreexisting = this.removing.has(key);
    this.removing.add(key);
    const droppedFirst = this.queues.get(key);
    if (droppedFirst) {
      this.queues.delete(key);
      this.emitQueueUpdated(chatKey, sessionAlias, key);
      this.notifyQueuedPeerCancelled(droppedFirst);
    }
    const droppedInterruptFirst = this.pendingInterrupts.get(key);
    if (droppedInterruptFirst) {
      this.pendingInterrupts.delete(key);
      this.emitPeerInterrupt(
        "cancelled_before_start",
        droppedInterruptFirst.executionContext.chatKey,
        droppedInterruptFirst.executionContext.sessionAlias,
        droppedInterruptFirst,
      );
      this.notifyQueuedPeerCancelled([droppedInterruptFirst]);
      // Republish: queue-updated is a REPLACE snapshot and the web cannot
      // infer the interrupt's removal — without this the UI keeps showing
      // the dropped reservation (P2 follow-up).
      this.emitQueueUpdated(chatKey, sessionAlias, key);
    }
    const entry = this.inFlight.get(key);
    if (entry) {
      entry.controller.abort();
      await raceWithTimeout(entry.settled, this.cancelDrainTimeoutMs);
      // The await is a window: new prompts may have enqueued (behind the aborted-but-live
      // turn) — drop those too so nothing drains later.
      const droppedSecond = this.queues.get(key);
      if (droppedSecond) {
        this.queues.delete(key);
        this.emitQueueUpdated(chatKey, sessionAlias, key);
        this.notifyQueuedPeerCancelled(droppedSecond);
      }
      // Same window applies to a peer interrupt reserved DURING the unwind: the
      // aborted-but-registered predecessor reads as busy, so submitPeerInterrupt
      // reserves instead of rejecting — drop that reservation too.
      const droppedInterruptSecond = this.pendingInterrupts.get(key);
      if (droppedInterruptSecond) {
        this.pendingInterrupts.delete(key);
        this.emitPeerInterrupt(
          "cancelled_before_start",
          droppedInterruptSecond.executionContext.chatKey,
          droppedInterruptSecond.executionContext.sessionAlias,
          droppedInterruptSecond,
        );
        this.notifyQueuedPeerCancelled([droppedInterruptSecond]);
        // Same REPLACE-snapshot contract as the first-window drop above.
        this.emitQueueUpdated(chatKey, sessionAlias, key);
      }
    }
    // Re-check rather than trusting the race: `inFlight` still present means the turn
    // outlived the timeout (or a fresh turn started); `draining` means a hand-off is live.
    const cleared =
      !this.inFlight.has(key) && !this.draining.has(key) && !this.pendingInterrupts.has(key);
    if (cleared) {
      // Hold the teardown guard across the caller's transport removal so a
      // scheduled (non-queueable) turn firing in that window is rejected, not
      // run on a dying session. `finishClear` releases it.
    } else if (!guardPreexisting) {
      // Failed clear: release the entry guard so the lane stays usable for the
      // caller's retry. A pre-existing guard (concurrent clear) is not ours to
      // drop.
      this.removing.delete(key);
    }
    return { cleared };
  }

  /** Release the teardown guard armed by a successful `clearSession`. MUST be called by the
   *  caller once transport removal/archive settles (in a finally), whether it succeeded or
   *  threw — otherwise the session key stays wedged as busy forever. */
  finishClear(chatKey: string, sessionAlias: string, concurrencyKey?: string): void {
    this.removing.delete(this.resolveKey(chatKey, sessionAlias, concurrencyKey));
  }

  /** Remove a pending queued prompt (by id) before it drains. No-ops (returns
   *  `{ cancelled: false }`) when the queue or the id is absent/already drained — e.g. a race
   *  where the item drained into a running turn just before the cancel arrived. Does NOT touch
   *  a turn that is already running (use `cancelTurn`). */
  cancelQueuedItem(chatKey: string, sessionAlias: string, itemId: string, concurrencyKey?: string): { cancelled: boolean } {
    const key = this.resolveKey(chatKey, sessionAlias, concurrencyKey);
    const pendingInterrupt = this.pendingInterrupts.get(key);
    if (pendingInterrupt?.id === itemId) {
      this.pendingInterrupts.delete(key);
      this.emitQueueUpdated(chatKey, sessionAlias, key);
      this.emitPeerInterrupt(
        "cancelled_before_start",
        pendingInterrupt.executionContext.chatKey,
        pendingInterrupt.executionContext.sessionAlias,
        pendingInterrupt,
      );
      // The reservation will never start: its completion contract is resolved
      // as terminal cancelled through the SAME path as ordinary queued peers.
      this.notifyQueuedPeerCancelled([pendingInterrupt]);
      return { cancelled: true };
    }
    const q = this.queues.get(key);
    if (!q) return { cancelled: false };
    const i = q.findIndex((x) => x.id === itemId);
    if (i < 0) return { cancelled: false };
    const removed = q.splice(i, 1)[0]!;
    if (q.length === 0) this.queues.delete(key);
    this.emitQueueUpdated(chatKey, sessionAlias, key);
    // The item will never start: any completion contract it carried is
    // resolved as terminal cancelled so the source is not left Waiting.
    this.notifyQueuedPeerCancelled([removed]);
    return { cancelled: true };
  }
}
