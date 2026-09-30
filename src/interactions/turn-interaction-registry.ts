/**
 * Shared exact-turn interaction registry.
 *
 * Permission and Elicitation both need the same fact: "which exact human
 * prompt turn does this opaque interactionId belong to, and is it still
 * alive?" They deliberately do NOT share business semantics — each broker
 * keeps its own request/outcome/timeout logic. This registry owns only the
 * binding lifecycle:
 *
 *   bindTurn()      at prompt dispatch, before the turn exists upstream
 *   resolve()       by opaque interactionId, never by session/chat/alias
 *   subscribeAbort() so a subscribed broker fences its pending work when
 *                  the owning turn is disposed or aborted
 *
 * Route selection (which chatKey a turn may talk to) stays with the callers
 * (`permission-turn-route.ts` resolves trusted ingress first); this registry
 * is intentionally ingress-agnostic.
 */

export type HumanInteractionOrigin =
  | "human"
  | "scheduled"
  | "peer"
  | "orchestration";

/**
 * Which interaction kind a route binding belongs to.
 *
 * Permission and Elicitation resolve DIFFERENT addresses for the same turn:
 * permission keeps the trusted ingress route, while elicitation must keep the
 * product isolation key `bot:<conversation>:<topic>` so TurnQueue, the
 * conversation kernel, and the relay correlation can all read it. They are not a
 * subset relation, so a registry that stored one route per interactionId could
 * only ever keep one of the two — and production silently kept the permission
 * one, which left the elicitation renderer holding `relay:<account>`, from which
 * `parseDirectConversationChatKey()` derives no `conversation` correlation.
 *
 * Turn LIVENESS (abort/dispose) stays keyed by the bare interactionId: both
 * kinds die with the turn and must fence on the same signal.
 */
export type TurnInteractionKind = "permission" | "elicitation";

export interface TurnInteractionContext {
  /** Opaque per-turn identity, minted once at prompt dispatch. */
  interactionId: string;
  /**
   * Which kind of interaction this route serves. Defaults to `"permission"`
   * for a single-broker caller that says nothing, so an existing one-kind
   * binding is unchanged rather than becoming address-less.
   */
  kind?: TurnInteractionKind;
  /** Channel reply route already trusted by the ingress layer. */
  chatKey: string;
  accountId?: string;
  replyContextToken?: string;
  senderId?: string;
  senderName?: string;
  isOwner?: boolean;
  origin: HumanInteractionOrigin;
  /**
   * Whether this turn's destination is provably 1:1.
   *
   * A TRUSTED INGRESS FACT, propagated from the `ChatRequestMetadata` the channel
   * itself supplied for this turn — never inferred downstream from the chatKey,
   * which would be a guess at best.
   *
   * Rendering an elicitation form is a privacy decision, not just a UI one: the
   * form shows the agent's question AND the user's answers, and a group
   * destination shows both to every member. `undefined` means the channel did not
   * tell us, which is not the same as "direct", so it must be treated as not
   * provably private.
   */
  chatType?: "direct" | "group";
}

export interface TurnInteractionRegistry {
  /**
   * Register the exact turn route for one kind. The returned disposer removes
   * ONLY this binding and aborts everything subscribed to it.
   *
   * One interactionId may hold one binding per kind: permission and elicitation
   * legitimately need different addresses for the same turn. Binding the same
   * kind twice is a caller bug and throws.
   *
   * `kind` is a PARAMETER, not only a context field, so a caller that binds on
   * another broker's behalf can state which kind it is storing. A context field
   * alone forced every direct caller to know the broker's internal kind, and the
   * mismatch silently produced an address nobody could read. Defaults to
   * `context.kind`, then to `"permission"`.
   */
  bindTurn(
    context: TurnInteractionContext,
    abortSignal?: AbortSignal,
    kind?: TurnInteractionKind,
  ): () => void;

  /**
   * Exact-turn lookup by opaque id AND kind; `undefined` when unbound or
   * disposed. `kind` defaults to `"permission"`, so a one-kind caller reads
   * back what it wrote without naming a kind at all.
   */
  resolve(
    interactionId: string,
    kind?: TurnInteractionKind,
  ): TurnInteractionContext | undefined;

  /**
   * Fenced abort subscription. The listener fires once when the EITHER KIND's
   * binding is unbound (turn disposed), when the bound AbortSignal aborts, or
   * when the registry is cleared. Returns an unsubscribe function that is
   * always safe to call.
   */
  subscribeAbort(
    interactionId: string,
    listener: () => void,
  ): () => void;

  /** Drop every binding and notify its subscribers (broker shutdown). */
  clear(): void;

  /** Bound interaction count (diagnostics/tests). Counts every kind. */
  readonly boundTurnCount: number;
}

/** Liveness key: the turn dies once, so both kinds fence on one signal. */
function livenessKey(interactionId: string): string {
  return interactionId;
}

/** Storage key: one route per (interactionId, kind). */
function routeKey(interactionId: string, kind: TurnInteractionKind): string {
  return `${interactionId}\u0000${kind}`;
}

class TurnInteractionRegistryImpl implements TurnInteractionRegistry {
  /**
   * Routed addresses, keyed by (interactionId, kind).
   *
   * A Map per kind rather than a nested Map, so `resolve(id, kind)` is one get
   * and a one-kind caller never has to care that a second kind exists.
   */
  private readonly turns = new Map<string, TurnInteractionContext>();
  private readonly abortListeners = new Map<string, Set<() => void>>();

  bindTurn(
    context: TurnInteractionContext,
    abortSignal?: AbortSignal,
    kindArg?: TurnInteractionKind,
  ): () => void {
    const kind = kindArg ?? context.kind ?? "permission";
    const key = routeKey(context.interactionId, kind);
    if (this.turns.has(key)) {
      // Same kind twice is a real caller bug: two addresses for one kind means
      // nobody knows which one the broker will read, and the second would
      // silently overwrite the first. Different kinds never collide here, which
      // is the whole point of the key.
      throw new Error(
        `duplicate turn interaction binding: ${context.interactionId} (${kind})`,
      );
    }
    this.turns.set(key, context);
    let disposed = false;
    const onAbort = (): void => {
      // Unbinding from inside the abort path is what notifies subscribers,
      // so a listener observing abort also observes resolve() === undefined.
      this.unbind(context.interactionId, kind, context);
    };
    if (abortSignal) {
      if (abortSignal.aborted) {
        onAbort();
      } else {
        abortSignal.addEventListener("abort", onAbort, { once: true });
      }
    }
    return () => {
      if (disposed) return;
      disposed = true;
      abortSignal?.removeEventListener("abort", onAbort);
      this.unbind(context.interactionId, kind, context);
    };
  }

  resolve(
    interactionId: string,
    kind: TurnInteractionKind = "permission",
  ): TurnInteractionContext | undefined {
    return this.turns.get(routeKey(interactionId, kind));
  }

  subscribeAbort(interactionId: string, listener: () => void): () => void {
    const live = livenessKey(interactionId);
    let listeners = this.abortListeners.get(live);
    if (!listeners) {
      listeners = new Set();
      this.abortListeners.set(live, listeners);
    }
    listeners.add(listener);
    return () => {
      const set = this.abortListeners.get(live);
      if (!set) return;
      set.delete(listener);
      if (set.size === 0) this.abortListeners.delete(live);
    };
  }

  /** Bound interaction count (diagnostics/tests). Counts every kind. */
  get boundTurnCount(): number {
    return this.turns.size;
  }

  /**
   * Remove one exact binding and notify its subscribers. Identity-checked:
   * a re-bound or already-disposed context never unblocks someone else's
   * subscription.
   *
   * Notification is by LIVENESS, not by storage key: when the LAST kind for a
   * turn goes away the turn is dead, so a broker still holding the other kind's
   * already-unbound route must not be told twice. Notifying on the first
   * removal instead would fence a live permission request because an unrelated
   * elicitation route was disposed.
   */
  private unbind(
    interactionId: string,
    kind: TurnInteractionKind,
    context: TurnInteractionContext,
  ): void {
    const key = routeKey(interactionId, kind);
    if (this.turns.get(key) !== context) return;
    this.turns.delete(key);
    if (this.turnsAlive(interactionId)) return;
    const live = livenessKey(interactionId);
    const listeners = this.abortListeners.get(live);
    if (!listeners) return;
    // Copy first: a listener may unsubscribe (or a new turn may rebind) while
    // iterating.
    for (const listener of [...listeners]) {
      try {
        listener();
      } catch {
        /* subscriber failures never break the registry */
      }
    }
    if (this.abortListeners.get(live) === listeners) {
      this.abortListeners.delete(live);
    }
  }

  /** Is any kind's route still bound for this turn? */
  private turnsAlive(interactionId: string): boolean {
    const prefix = `${interactionId}\u0000`;
    for (const key of this.turns.keys()) {
      if (key.startsWith(prefix)) return true;
    }
    return false;
  }

  /** Test/teardown helper: drop every binding and notify subscribers. */
  clear(): void {
    // Liveness-first: collect the turns that are about to lose their last
    // route, drop everything, then notify once per dead turn. Iterating and
    // deleting per key would notify a turn three times as its kinds vanish.
    const dying = new Set<string>();
    for (const key of this.turns.keys()) {
      const interactionId = key.slice(0, key.indexOf("\u0000"));
      dying.add(interactionId);
    }
    this.turns.clear();
    this.abortListeners.clear();
    for (const interactionId of dying) {
      const listeners = this.abortListeners.get(livenessKey(interactionId));
      if (!listeners) continue;
      for (const listener of [...listeners]) {
        try {
          listener();
        } catch {}
      }
    }
  }
}

export function createTurnInteractionRegistry(): TurnInteractionRegistry {
  return new TurnInteractionRegistryImpl();
}

export { TurnInteractionRegistryImpl };
