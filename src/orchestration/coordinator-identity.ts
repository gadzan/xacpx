/**
 * The orchestration coordinator identity is derived from a session's transport
 * name. `/clear` rotates that name from `workspace:alias` to
 * `workspace:alias:reset-<timestamp>` (see session-reset-handler), which would
 * otherwise orphan every task delegated before the reset. Stripping the
 * volatile `:reset-<digits>` suffix yields the stable `workspace:alias` identity
 * so ownership survives `/clear`.
 *
 * Pure leaf module: do not add imports, so it can be used from sessions/,
 * commands/, and orchestration/ without risking an import cycle.
 *
 * No-op on any value lacking a trailing `:reset-<digits>` segment, so external
 * coordinators (`external_*`) and normal sessions pass through unchanged.
 */
export function stableCoordinatorSession(transportSession: string): string {
  return transportSession.replace(/:reset-\d+$/, "");
}

/**
 * Unified transport-boundary default for the stable coordinator identity.
 *
 * Runtime workers treat `mcpCoordinatorSession + mcpSourceHandle` as immutable
 * construction identity: `none -> coordinator` and `coordinator -> none` both
 * rotate the worker. A plain logical session (no explicit worker binding) must
 * therefore default to the stable coordinator identity on EVERY session-scoped
 * operation — not only ensure/prompt, but also the model/effort reads that
 * Relay Web fires in parallel right after create — otherwise a read carrying
 * `none` rotates the fresh worker back and the next prompt rotates it again.
 *
 * Explicit worker bindings (`mcpCoordinatorSession` already set) win untouched.
 * CLI sessions historically carry this binding too (it drives the MCP queue
 * owner), so the default is unconditional: callers that must preserve the
 * legacy CLI wire shape (bridge direct reads) gate on `transportEngine`
 * themselves instead. Returns the input by reference when no default applies,
 * so callers avoid needless allocation.
 */
export function withDefaultMcpIdentity<
  T extends {
    transportSession: string;
    mcpCoordinatorSession?: string;
  },
>(session: T): T {
  if (session.mcpCoordinatorSession !== undefined) return session;
  return {
    ...session,
    mcpCoordinatorSession: stableCoordinatorSession(session.transportSession),
  };
}

/**
 * The single chokepoint for asking "do these two transport names refer to the
 * same coordinator?". Both sides are reduced to their stable identity before
 * comparison, so it is robust to either side carrying a volatile
 * `:reset-<digits>` suffix (a live post-`/clear` session, or a legacy
 * state.json record persisted before the identity was normalized at write).
 *
 * Every coordinator-ownership comparison must go through this rather than a raw
 * `===`, so the normalization rule lives in one place instead of being
 * re-derived (and inconsistently forgotten) at each call site.
 */
export function sameCoordinatorSession(a: string, b: string): boolean {
  return stableCoordinatorSession(a) === stableCoordinatorSession(b);
}
