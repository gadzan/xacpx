import type { MemberTurnEffect, MemberTurnEffectProvenance, WorkspaceIsolationPolicy } from "./conversation-types";

/**
 * PR6 filesystem scheduling seam (§9.6). Decides whether a MemberTurn with a
 * declared effect may execute concurrently with other in-flight turns on the
 * same Topic, given the Topic's effective isolation policy.
 *
  * Rules (plan §9.6 / §16):
   *  - No isolation passes unproven work through. `shared` keeps its distinct
   *  policy value for a future capability-enforced caller, but until an
   *  enforceable read-only proof exists the scheduler treats every tree the
   *  same: only a `read-only` turn with an enforced proof may run alongside
   *  another in-flight turn. PR7 persists every explicit member as `unknown`
   *  (no enforceable read-only proof exists), so every PR7 Group member
   *  serializes regardless of isolation.
   *  - `worktree-per-member`: no provisioning exists yet (PR10); treat like
   *  every other tree until the worktree lifecycle lands.
 *
 * Never infer from Bot name/description: the caller supplies the declared
 * effect AND its proof, and only `read-only` + `declared-enforced` together
 * count as safe. A bare `read-only` with missing/invalid provenance reads as
 * unproven and serializes — the seam is fail-closed for the next caller that
 * supplies an effect.
 */
export function isEffectConcurrencySafe(
  effect: MemberTurnEffect | undefined,
  isolation: WorkspaceIsolationPolicy,
  otherInFlight: number,
  provenance?: MemberTurnEffectProvenance,
): boolean {
  if (otherInFlight <= 0) {
    return true;
  }
  // No isolation exempts unproven work: only a proven `read-only` runs
  // alongside, on any tree. `shared` stays a distinct durable policy value
  // (a future capability-enforced caller can open safe parallelism there
  // without migrating Topics), but the scheduler never passes unproven
  // turns through on it.
  return effect === "read-only" && provenance === "declared-enforced";
}

/** True when the turn must acquire the Topic's single-writer slot. */
export function requiresSingleWriterSlot(
  effect: MemberTurnEffect | undefined,
  _isolation: WorkspaceIsolationPolicy,
  provenance?: MemberTurnEffectProvenance,
): boolean {
  // Every isolation reports the same answer: only a proven `read-only`
  // turn skips the writer slot. This seam must not mark unproven work as
  // safe to run alongside on any tree.
  return !(effect === "read-only" && provenance === "declared-enforced");
}
