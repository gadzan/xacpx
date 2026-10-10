import { realpathSync } from "node:fs";

import { ConversationError } from "./conversation-error";
import type { WorkspaceIsolationPolicy } from "./conversation-types";
import { normalizeWindowsWorktreePath } from "../control/workspace-git";

/**
 * Cross-Run physical resource admission (PR C).
 *
 * Within one Run the dispatcher already reasons about sibling overlap using
 * the Topic's isolation policy and each member's declared effect proof. That
 * reasoning is scoped to `listMemberTurns(run.id)`, so it says nothing about
 * two DIFFERENT Runs that happen to touch the same physical directory.
 *
 * PR C lets independent Runs execute concurrently, so this module supplies the
 * missing cross-Run decision. It is deliberately an in-memory reservation
 * layer over the durable claim, never a second source of truth:
 *
 *  - Every reservation is keyed by a VERIFIED physical identity (canonical
 *    path, or a verified owned worktree id), never by Topic id, Bot name or a
 *    declared effect string.
 *  - A reservation is only taken AFTER the durable claim exists and only held
 *    while this process owns that claim. Losing the claim, cancelling, or
 *    shutting down releases it; nothing durable depends on it surviving.
 *  - Admission is fail-closed: an unverified identity, a materialize still in
 *    progress, or an unknown effect all serialize.
 *
 * The rules mirror §9.6, extended across Runs:
 *  - Shared physical directory: only `read-only` + `declared-enforced` may
 *    overlap; unknown/mutating work takes the single writer slot for that
 *    resource.
 *  - Distinct verified worktrees/cwds: concurrent, provided BOTH sides are
 *    proven distinct.
 */

/** Identity of a physical resource an execution will touch. */
export interface PhysicalResourceIdentity {
  /** Canonical absolute path of the execution directory. */
  readonly cwd: string;
  /** Verified owned worktree id, when the execution is bound to one. */
  readonly worktreeId?: string;
  /** Effective isolation for the owning Topic, read from durable config. */
  readonly isolation: WorkspaceIsolationPolicy;
}

/** What one in-flight execution holds against a physical resource. */
export interface ResourceReservation {
  /** Stable key of the reserved resource, used for conflict lookup. */
  readonly key: string;
  readonly runId: string;
  readonly memberTurnId: string;
  readonly dispatchId: string;
  readonly identity: PhysicalResourceIdentity;
  /** True when this execution may overlap other proven readers. */
  readonly reader: boolean;
}

/** Why admission refused, so the caller can classify the failure. */
export type ResourceAdmissionDenial =
  | "shared-writer-conflict"
  | "worktree-identity-unproven";

export class ResourceAdmissionError extends ConversationError {
  constructor(readonly denial: ResourceAdmissionDenial, message: string) {
    super("resource_admission_denied", message, { denial });
    this.name = "ResourceAdmissionError";
  }
}

/**
 * Canonical key for a physical resource. Two executions conflict only when
 * their keys match, so this must be the most specific verified identity: a
 * bound worktree id when present (distinct worktrees are physically distinct
 * even when their paths share a prefix), otherwise the canonical cwd.
 *
 * Callers must have already normalized the path (realpath, Windows 8.3
 * expansion, case folding) — this function deliberately does no I/O so it can
 * never disagree with the identity the worktree manager verified.
 */
export function physicalResourceKey(identity: PhysicalResourceIdentity): string {
  return identity.worktreeId ? `worktree:${identity.worktreeId}` : `cwd:${identity.cwd}`;
}

/**
 * Canonicalize a configured workspace cwd into a stable physical identity.
 *
 * The config layer only normalizes lexically, so two workspaces reached through
 * a symlink, a junction or a Windows path alias are different strings for the
 * SAME directory. Keying reservations on those raw strings would let two writers
 * run concurrently on one physical directory — the exact failure cross-Run
 * admission exists to prevent.
 *
 * Resolves the real path when the directory exists, so a junction and its target
 * produce the same key. On Windows the folded spelling is produced by the SAME
 * helper the worktree manager verifies worktrees with (`\\?\` device prefix,
 * separator and case folding, trailing separators, 8.3 short-name components
 * resolved through their nearest existing ancestor). Two divergent Windows rules
 * would let one directory compare unequal and admit two writers to it, so there
 * is deliberately exactly one rule.
 *
 * When the directory cannot be resolved the path is normalized anyway rather
 * than rejected: the workspace is a configured directory that may be created
 * later (or a fixture path on another platform), and the reservation table is a
 * fence over the durable claim, not a filesystem authority. What matters is that
 * every spelling of the SAME directory folds to ONE key, which the shared
 * normalizer guarantees, and that the identity is never derived from anything
 * other than this function.
 */
export function canonicalizePhysicalPath(cwd: string): string {
  const trimmed = cwd.trim();
  if (!trimmed) return "";
  let real: string;
  try {
    real = realpathSync(trimmed);
  } catch {
    real = trimmed;
  }
  return process.platform === "win32" ? normalizeWindowsWorktreePath(real) : real;
}

/**
 * Decide whether `candidate` may physically execute alongside `incumbent`.
 *
 * Fail-closed on every unknown: an unproven effect serializes, and a
 * worktree-per-member Topic that cannot prove distinct directories serializes
 * too — the isolation flag alone never authorizes overlap.
 */
export function canExecuteAlongside(
  candidate: Pick<ResourceReservation, "identity" | "reader">,
  incumbent: Pick<ResourceReservation, "identity" | "reader">,
): boolean {
  // Different physical resources never conflict.
  if (physicalResourceKey(candidate.identity) !== physicalResourceKey(incumbent.identity)) {
    return true;
  }
  // Same resource: only proven readers may overlap, and only when BOTH sides
  // are proven readers. One unproven participant serializes the pair.
  return candidate.reader && incumbent.reader;
}

/**
 * In-memory cross-Run resource reservations for one dispatcher process.
 *
 * Not a work queue and not durable state: it is a fence that keeps two
 * concurrent Runs off the same physical directory. Every entry is released
 * when its execution settles, when its claim is lost, or at shutdown, so a
 * crashed process leaves nothing behind and the next process converges
 * through the ordinary durable claim/lease path.
 */
export class ResourceReservationTable {
  private readonly byKey = new Map<string, Set<ResourceReservation>>();
  /** Reservations held per dispatch id, for O(1) release. */
  private readonly byDispatch = new Map<string, ResourceReservation>();

  get size(): number {
    return this.byDispatch.size;
  }

  /** All reservations currently held, in insertion order. */
  values(): IterableIterator<ResourceReservation> {
    return this.byDispatch.values();
  }

  /** The Run owning a reservation, or undefined when nothing holds it. */
  runOf(dispatchId: string): string | undefined {
    return this.byDispatch.get(dispatchId)?.runId;
  }

  /** True when a reservation is currently held for this dispatch id. */
  has(dispatchId: string): boolean {
    return this.byDispatch.has(dispatchId);
  }

  /** The first incumbent that blocks `candidate`, if any. */
  conflicts(candidate: PhysicalResourceIdentity, reader: boolean): ResourceReservation | undefined {
    const key = physicalResourceKey(candidate);
    for (const incumbent of this.byKey.get(key) ?? []) {
      if (!canExecuteAlongside({ identity: candidate, reader }, incumbent)) {
        return incumbent;
      }
    }
    return undefined;
  }

  /** Register a reservation, replacing any prior entry for the same dispatch. */
  add(reservation: ResourceReservation): void {
    this.release(reservation.dispatchId);
    let bucket = this.byKey.get(reservation.key);
    if (!bucket) {
      bucket = new Set();
      this.byKey.set(reservation.key, bucket);
    }
    bucket.add(reservation);
    this.byDispatch.set(reservation.dispatchId, reservation);
  }

  /** Drop one dispatch's reservation. Idempotent. */
  release(dispatchId: string): void {
    const existing = this.byDispatch.get(dispatchId);
    if (!existing) return;
    this.byDispatch.delete(dispatchId);
    const bucket = this.byKey.get(existing.key);
    if (!bucket) return;
    bucket.delete(existing);
    if (bucket.size === 0) this.byKey.delete(existing.key);
  }

  /** Drop every reservation belonging to a Run (cancel, terminal, teardown). */
  releaseRun(runId: string): void {
    for (const reservation of [...this.byDispatch.values()]) {
      if (reservation.runId === runId) this.release(reservation.dispatchId);
    }
  }

  clear(): void {
    this.byKey.clear();
    this.byDispatch.clear();
  }
}
