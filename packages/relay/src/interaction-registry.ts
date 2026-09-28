/**
 * The hub's pending-interaction registry.
 *
 * WHY a map exists now, when the original design deliberately had none: the
 * direction flipped. A connector-initiated OPEN is a request that lives until a
 * browser answers it, so the hub must hold the resolver between the two halves.
 * The alternative — the hub answering the connector immediately and re-issuing a
 * second frame for the answer — would let two different frames carry the same
 * decision, and only one of them could be authoritative.
 *
 * WHAT IT HOLDS, and what it deliberately does NOT hold:
 *
 *   requestId -> { instanceId, resolve, reject, expiresAt, ... }
 *
 * No responder identity, and no session identity beyond the connector that
 * opened it. The responder is stamped at answer time from the authenticated
 * browser session, which is the only place that identity exists. Storing it
 * earlier would mean deriving it from a frame — exactly the self-reported
 * identity the M1 contract forbids.
 *
 * LIFECYCLE, all four closers:
 *
 *   answer      -> the browser's response resolves the pending call
 *   withdrawn   -> the connector's socket went away (its call can never return)
 *   expired     -> the window closed without an answer
 *   hub close   -> the account or instance was revoked
 *
 * Closing is idempotent and first-wins. A late answer after a close is dropped
 * rather than answered into a dead promise: the interaction no longer exists,
 * and accepting an answer that arrives after expiry is how a decision gets
 * applied to a turn that already moved on.
 */

import type {
  InteractionRequestDto,
  InteractionResponseDto,
  InteractionResult,
} from "@ganglion/xacpx-relay-protocol";

/** Why an interaction is no longer answerable. */
export type InteractionCloseReason = "resolved" | "withdrawn" | "expired";

export interface PendingInteraction {
  requestId: string;
  /** Connector that opened it — the only half that can be notified on withdrawal. */
  instanceId: string;
  /** Account that owns both the connector and the browser that answers. */
  accountId: string;
  kind: "permission" | "elicitation";
  expiresAt: number;
  chatKey: string;
  sessionAlias: string;
  /** Product correlation for the browser's surface, if the turn had one. */
  conversation?: InteractionRequestDto["conversation"];
  /**
   * How long the opening RPC is allowed to stay open. The window at `expiresAt`
   * is when answering STOPS being legal; this is when the call stops being
   * answerable-in-transit. The gap is the reserve a decision made in time needs
   * to travel back.
   */
  timeoutMs: number;
  /**
   * How long the interaction stays answerable — the window, without the reserve.
   *
   * Deliberately not spelled `expiresAt - now` at the timer so the two clocks
   * cannot drift: `expiresAt` is the authority and is re-checked on every answer,
   * while this only decides when the hub stops waiting. Sharing `timeoutMs` here
   * would extend the answer window by the reserve.
   */
  answerWindowMs: number;
  /** Settles the opening call with the human's decision. */
  resolve: (decision: InteractionResponseDto) => void;
  /** Rejects with the close reason, so a connector that is still waiting learns
   *  the window ended rather than waiting for a transport timeout. */
  reject: (reason: InteractionCloseReason) => void;
  timer?: ReturnType<typeof setTimeout>;
  closed: boolean;
}

export interface InteractionRegistryLogger {
  debug(event: string, message: string, fields?: Record<string, unknown>): void;
}

/**
 * Notified whenever an interaction leaves the open set, from ANY closer.
 *
 * The broadcast exists so the browser never has to infer a closure: a form must
 * stop being interactive the moment the interaction is no longer answerable,
 * whether that was a resolve, an expiry, or a withdrawal. Reasoning that this
 * belongs to the HTTP handler instead is what led to the gap this closes — the
 * handler only saw the paths it triggered itself.
 */
export interface InteractionClosedListener {
  (closed: {
    requestId: string;
    instanceId: string;
    accountId: string;
    kind: "permission" | "elicitation";
    reason: InteractionCloseReason;
  }): void;
}

/**
 * Shape an interaction's outcome for the connector, stamping the responder
 * identity.
 *
 * This is the ONLY place a responder identity is added, and it comes from the
 * hub's own authenticated session — never from the frame. Two consequences:
 *
 *   - A browser cannot assert an identity: the field is stamped over whatever the
 *     frame carried, so a connector or tampered client that sets one has no
 *     effect.
 *   - The identity is the one the hub already trusts for this RPC, which is the
 *     same account identity the trusted conversation prompt path stamps
 *     (`relay:<accountId>` / `senderId: account.id`).
 *
 * `responded: false` keeps its reason intact: the connector must distinguish "the
 * human never answered" from "the human chose cancel", and collapsing the two
 * would show a user's own dismissal as an infrastructure error.
 *
 * Lives beside the registry — the one component both the connector-facing
 * (WebSocket) and browser-facing (HTTP) transports share — so the stamp is
 * applied identically no matter which surface delivered the answer. Two copies
 * of a security-critical stamp is how the two drifts apart.
 */
export function interactionResultForBrowser(result: unknown, accountId: string): InteractionResult {
  if (typeof result !== "object" || result === null) {
    return { responded: false, reason: "aborted" };
  }
  const outcome = result as { responded?: unknown; reason?: unknown; response?: unknown };
  if (outcome.responded !== true) {
    const reason = typeof outcome.reason === "string" ? outcome.reason : "aborted";
    // The wire's closed reasons, plus the transport failures that can reach an
    // opening. Anything unrecognized reads as `aborted` rather than leaking a
    // hub-internal reason string to the connector.
    return {
      responded: false,
      reason: reason === "timeout" || reason === "aborted" || reason === "shutdown"
        || reason === "unsupported" || reason === "channel-missing"
        ? reason
        : "aborted",
    };
  }
  const response = outcome.response;
  if (typeof response !== "object" || response === null) {
    return { responded: false, reason: "aborted" };
  }
  const decision = response as Partial<InteractionResponseDto>;
  // Stamp OVER anything the frame carried: the hub's session is the authority.
  return {
    responded: true,
    response: { ...decision, responderId: accountId } as InteractionResponseDto,
  };
}

export class InteractionRegistry {
  private readonly pending = new Map<string, PendingInteraction>();
  private readonly closedListeners = new Set<InteractionClosedListener>();

  constructor(private readonly logger: InteractionRegistryLogger) {}

  /**
   * Subscribe to every close. Used by the hub to broadcast `interaction-closed`
   * so the browser stops showing a form nobody may answer.
   */
  onClose(listener: InteractionClosedListener): () => void {
    this.closedListeners.add(listener);
    return () => {
      this.closedListeners.delete(listener);
    };
  }

  /** Open count, for diagnostics. */
  get size(): number {
    return this.pending.size;
  }

  /**
   * Register an opened interaction.
   *
   * The expiry timer closes the entry rather than resolving it with an answer:
   * the caller learns the window ended, and the browser gets `interaction-closed`
   * so it stops showing a form nobody may submit.
   */
  open(entry: Omit<PendingInteraction, "closed" | "timer">): void {
    const withTimer: PendingInteraction = { ...entry, closed: false };
    withTimer.timer = setTimeout(() => {
      this.close(entry.requestId, "expired");
    }, Math.max(0, entry.answerWindowMs));
    if (typeof withTimer.timer.unref === "function") withTimer.timer.unref();
    this.pending.set(entry.requestId, withTimer);
    this.logger.debug("relay.interaction.opened", "interaction opened", {
      requestId: entry.requestId,
      instanceId: entry.instanceId,
      kind: entry.kind,
    });
  }

  /**
   * Answer an open interaction.
   *
   * Returns the pending entry that was closed, or `null` when the requestId names
   * nothing open — an expired, withdrawn, or never-opened interaction. The caller
   * reports that as "gone": a decision that arrives after the window closed is
   * not a late win, and treating it as one would apply an answer to a turn that
   * has already settled.
   */
  answer(requestId: string, decision: InteractionResponseDto): PendingInteraction | null {
    const entry = this.pending.get(requestId);
    if (!entry || entry.closed) return null;
    // The window's own fence, re-checked here even though a timer exists.
    //
    // `expiresAt` is when answering STOPS being legal; `timeoutMs` is only when
    // the CALL stops waiting. They differ by the transport reserve, so an answer
    // can arrive after `expiresAt` while the timer is still armed. Timer
    // granularity makes that a real race, not a theoretical one: accepting it
    // would tell the human "answered" for a window that already closed, and would
    // deliver a late decision to a turn that already expired.
    if (Date.now() >= entry.expiresAt) {
      this.close(requestId, "expired");
      return null;
    }
    this.finish(entry, "resolved");
    entry.resolve(decision);
    return entry;
  }

  /**
   * Close without an answer. Second and later calls are no-ops, so a window that
   * both expires and gets withdrawn closes once.
   */
  close(requestId: string, reason: InteractionCloseReason): boolean {
    const entry = this.pending.get(requestId);
    if (!entry || entry.closed) return false;
    this.finish(entry, reason);
    entry.reject(reason);
    return true;
  }

  /** Every interaction opened by one instance (connector withdrawal, teardown). */
  listForInstance(instanceId: string): PendingInteraction[] {
    const entries: PendingInteraction[] = [];
    for (const entry of this.pending.values()) {
      if (entry.instanceId === instanceId) entries.push(entry);
    }
    return entries;
  }

  /** Every interaction for one account (account revocation). */
  listForAccount(accountId: string): PendingInteraction[] {
    const entries: PendingInteraction[] = [];
    for (const entry of this.pending.values()) {
      if (entry.accountId === accountId) entries.push(entry);
    }
    return entries;
  }

  get(requestId: string): PendingInteraction | null {
    const entry = this.pending.get(requestId);
    return entry && !entry.closed ? entry : null;
  }

  private finish(entry: PendingInteraction, reason: InteractionCloseReason): void {
    entry.closed = true;
    if (entry.timer !== undefined) {
      clearTimeout(entry.timer);
      entry.timer = undefined;
    }
    this.pending.delete(entry.requestId);
    this.logger.debug("relay.interaction.closed", "interaction closed", {
      requestId: entry.requestId,
      instanceId: entry.instanceId,
      reason,
    });
    // Every closer, so the browser's form is retired on the actual close rather
    // than on the reader's guess about which path closed it.
    for (const listener of this.closedListeners) {
      try {
        listener({
          requestId: entry.requestId,
          instanceId: entry.instanceId,
          accountId: entry.accountId,
          kind: entry.kind,
          reason,
        });
      } catch (error) {
        // A listener failure is not a reason to leave an interaction half closed:
        // the entry is already gone and the opener already settled.
        this.logger.debug("relay.interaction.close_listener_failed", "interaction close listener threw", {
          requestId: entry.requestId,
          message: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }
}
