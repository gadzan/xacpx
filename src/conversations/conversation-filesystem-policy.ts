import type { MemberTurnEffect, WorkspaceIsolationPolicy } from "./conversation-types";

/**
 * PR6 filesystem scheduling seam (§9.6). Decides whether a MemberTurn with a
 * declared effect may execute concurrently with other in-flight turns on the
 * same Topic, given the Topic's effective isolation policy.
 *
 * Rules (plan §9.6 / §16):
 * - `shared`: parallel execution is allowed only for operations proven
 *   non-mutating by enforced capability/tool policy. Anything else is treated
 *   as potentially mutating — but `shared` itself does not serialize; the
 *   caller (PR7+ scheduler) decides based on this classification.
 * - `shared-single-writer`: side-effect-capable turns serialize. Only an
 *   enforceably `read-only` turn may run alongside another in-flight turn.
 * - `worktree-per-member`: no provisioning exists yet (PR10); treat like
 *   `shared-single-writer` until the worktree lifecycle lands.
 *
 * Never infer from Bot name/description: the caller supplies the declared
 * effect, and only an explicit `read-only` declaration counts as safe.
 */
export function isEffectConcurrencySafe(
  effect: MemberTurnEffect | undefined,
  isolation: WorkspaceIsolationPolicy,
  otherInFlight: number,
): boolean {
  if (otherInFlight <= 0) {
    return true;
  }
  // `shared` parallel execution is safe only for turns proven non-mutating by
  // enforced capability/tool policy. Anything else is treated as potentially
  // mutating, including `mutating` and `unknown` (unproven). The `shared`
  // tree itself never serializes here; the PR7+ scheduler still routes
  // through this classification when deciding what may run alongside.
  return effect === "read-only";
}

/** True when the turn must acquire the Topic's single-writer slot. */
export function requiresSingleWriterSlot(
  effect: MemberTurnEffect | undefined,
  _isolation: WorkspaceIsolationPolicy,
): boolean {
  // Every isolation reports the same answer today: only a proven `read-only`
  // turn skips the writer slot. `shared` never serializes by itself — the
  // scheduler still decides — but this seam must not mark unproven work as
  // safe to run alongside on any tree.
  return effect !== "read-only";
}
