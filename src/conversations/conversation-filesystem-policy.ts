import type { MemberTurnEffect, WorkspaceIsolationPolicy } from "./conversation-types";

/**
 * PR6 filesystem scheduling seam (§9.6). Decides whether a MemberTurn with a
 * declared effect may execute concurrently with other in-flight turns on the
 * same Topic, given the Topic's effective isolation policy.
 *
 * Rules (plan §9.6 / §16):
 * - `shared`: the tree itself never serializes — requested parallelism
 *   passes straight through, whatever the declared effect. (A future
 *   enforced capability/tool policy may refuse unsafe work at accept; the
 *   scheduler does not second-guess it here.)
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
  // `shared` never serializes: requested parallelism passes through
  // regardless of declared effect. Every other tree serializes unproven
  // work — only an explicit `read-only` runs alongside.
  if (isolation === "shared") {
    return true;
  }
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
