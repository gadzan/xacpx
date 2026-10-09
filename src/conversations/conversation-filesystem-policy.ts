import type { MemberTurnEffect, MemberTurnEffectProvenance, WorkspaceIsolationPolicy } from "./conversation-types";

/**
 * PR6 filesystem scheduling seam (§9.6). Decides whether a MemberTurn with a
 * declared effect may execute concurrently with other in-flight turns on the
 * same Topic, given the Topic's effective isolation policy.
 *
  * Rules (plan §9.6 / §16):
   *  - On shared directories, only `read-only` with an enforced runtime proof
   *  permits reader overlap. Unknown/mutating effects take the writer slot.
   *  - `worktree-per-member`: effect alone cannot prove directory isolation.
   *  The dispatcher separately verifies distinct owned launch directories;
   *  without that proof this helper stays conservative.
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
  // Effect proof alone never exempts unproven work. Worktree directory proof
  // is verified separately by the dispatcher at physical admission.
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
