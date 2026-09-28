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

import type { InteractionRequestDto, InteractionResponseDto } from "@ganglion/xacpx-relay-protocol";

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

export class InteractionRegistry {
  private readonly pending = new Map<string, PendingInteraction>();

  constructor(private readonly logger: InteractionRegistryLogger) {}

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
    // The transport ceiling, not the window: a decision that arrived inside the
    // window still needs its trip home.
    withTimer.timer = setTimeout(() => {
      this.close(entry.requestId, "expired");
    }, Math.max(0, entry.timeoutMs));
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
  }
}
