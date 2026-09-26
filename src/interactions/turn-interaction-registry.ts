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

export interface TurnInteractionContext {
  /** Opaque per-turn identity, minted once at prompt dispatch. */
  interactionId: string;
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
   * Register the exact turn route. The returned disposer removes ONLY this
   * binding and aborts everything subscribed to it.
   */
  bindTurn(
    context: TurnInteractionContext,
    abortSignal?: AbortSignal,
  ): () => void;

  /** Exact-turn lookup by opaque id; `undefined` when unbound/disposed. */
  resolve(interactionId: string): TurnInteractionContext | undefined;

  /**
   * Fenced abort subscription. The listener fires once when the binding is
   * unbound (turn disposed), when the bound AbortSignal aborts, or when the
   * registry is cleared. Returns an unsubscribe function that is always safe
   * to call.
   */
  subscribeAbort(
    interactionId: string,
    listener: () => void,
  ): () => void;

  /** Drop every binding and notify its subscribers (broker shutdown). */
  clear(): void;

  /** Bound interaction count (diagnostics/tests). */
  readonly boundTurnCount: number;
}

class TurnInteractionRegistryImpl implements TurnInteractionRegistry {
  private readonly turns = new Map<string, TurnInteractionContext>();
  private readonly abortListeners = new Map<string, Set<() => void>>();

  bindTurn(context: TurnInteractionContext, abortSignal?: AbortSignal): () => void {
    if (this.turns.has(context.interactionId)) {
      throw new Error(`duplicate turn interaction binding: ${context.interactionId}`);
    }
    this.turns.set(context.interactionId, context);
    let disposed = false;
    const onAbort = (): void => {
      // Unbinding from inside the abort path is what notifies subscribers,
      // so a listener observing abort also observes resolve() === undefined.
      this.unbind(context.interactionId, context);
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
      this.unbind(context.interactionId, context);
    };
  }

  resolve(interactionId: string): TurnInteractionContext | undefined {
    return this.turns.get(interactionId);
  }

  subscribeAbort(interactionId: string, listener: () => void): () => void {
    let listeners = this.abortListeners.get(interactionId);
    if (!listeners) {
      listeners = new Set();
      this.abortListeners.set(interactionId, listeners);
    }
    listeners.add(listener);
    return () => {
      const set = this.abortListeners.get(interactionId);
      if (!set) return;
      set.delete(listener);
      if (set.size === 0) this.abortListeners.delete(interactionId);
    };
  }

  /** Bound interaction count (diagnostics/tests). */
  get boundTurnCount(): number {
    return this.turns.size;
  }

  /**
   * Remove one exact binding and notify its subscribers. Identity-checked:
   * a re-bound or already-disposed context never unblocks someone else's
   * subscription.
   */
  private unbind(interactionId: string, context: TurnInteractionContext): void {
    const current = this.turns.get(interactionId);
    if (current !== context) return;
    this.turns.delete(interactionId);
    const listeners = this.abortListeners.get(interactionId);
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
    if (this.abortListeners.get(interactionId) === listeners) {
      this.abortListeners.delete(interactionId);
    }
  }

  /** Test/teardown helper: drop every binding and notify subscribers. */
  clear(): void {
    for (const interactionId of [...this.turns.keys()]) {
      const context = this.turns.get(interactionId)!;
      this.turns.delete(interactionId);
      const listeners = this.abortListeners.get(interactionId);
      if (!listeners) continue;
      for (const listener of [...listeners]) {
        try {
          listener();
        } catch {}
      }
      this.abortListeners.delete(interactionId);
    }
    this.abortListeners.clear();
  }
}

export function createTurnInteractionRegistry(): TurnInteractionRegistry {
  return new TurnInteractionRegistryImpl();
}

export { TurnInteractionRegistryImpl };
