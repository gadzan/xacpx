import type { AppState, SessionTransportEngine } from "../state/types";
import type { OrchestrationTaskStatus, WorkerBindingRecord } from "./orchestration-types";

/** Outcome of a worker-binding retirement attempt. */
export type RetireWorkerBindingOutcome = "retired" | "retained";

/**
 * Process-wide retirement lease: the mutual-exclusion domain shared by
 * delegation admission (`reserveProposedWorkerSession` /
 * `assertWorkerSessionAvailable`) and every teardown path (terminal
 * retirement, startup rollback). A claimed name refuses new admissions, so
 * no delegation can stage, ensure, or dispatch a new generation while a
 * teardown holds the lease — closing the check-then-release TOCTOU where a
 * post-check admission would be killed by a stale cleanup.
 *
 * In-memory only, never durable: a crash clears every claim, and every
 * claim site deletes durable state only AFTER verified convergence, so a
 * crash can only leave a retained binding behind for a later retry — never
 * a half-torn-down owner. Every claim MUST pair with a finally-release.
 */
const retiringWorkerSessions = new Set<string>();

/** True while a retirement/teardown holds the lease for `workerSession`. */
export function isWorkerRetirementClaimed(workerSession: string): boolean {
  return retiringWorkerSessions.has(workerSession);
}

/**
 * Claim the retirement lease (atomic check-and-set). False means another
 * teardown already owns this session — the caller must retain/fail closed,
 * never wait: the holder always releases in a finally.
 */
export function tryClaimWorkerRetirement(workerSession: string): boolean {
  if (retiringWorkerSessions.has(workerSession)) return false;
  retiringWorkerSessions.add(workerSession);
  return true;
}

/** Release a previously claimed lease. No-op when not held. */
export function releaseWorkerRetirement(workerSession: string): void {
  retiringWorkerSessions.delete(workerSession);
}

export interface WorkerBindingRetirementEnv {
  loadState: () => Promise<AppState>;
  saveState: (state: AppState) => Promise<void>;
  runExclusive: <T>(critical: () => Promise<T>) => Promise<T>;
  releaseWorkerSession:
    | ((request: {
        workerSession: string;
        targetAgent: string;
        workspace: string;
        cwd?: string;
        role?: string;
        logicalSessionId: string;
        transportEngine: SessionTransportEngine;
      }) => Promise<void>)
    | undefined;
  isTerminalStatus: (status: OrchestrationTaskStatus) => boolean;
  /**
   * True while a delegation start holds the admission reservation for
   * `workerSession` (reserve → persist → release). The primitive treats a
   * held reservation like an active owner: never release into a starting
   * delegation, and never delete under one.
   */
  hasStartReservation: (workerSession: string) => boolean;
}
/**
 * Retire one worker binding as a durable ownership handle — never as plain
 * orchestration metadata. A binding WITH a complete identity (LID + engine)
 * is the Runtime owner/fence/journal/recovery handle: it may be deleted only
 * after verified engine-side convergence, never speculatively.
 *
 * Claim-then-converge protocol (closes the check-then-release TOCTOU):
 * snapshot + lease-claim atomically under the lock (plus start-reservation
 * and active-owner checks) → re-check without the lock → verified release
 * outside the lock → re-enter, re-verify generation + ownership, then
 * delete. The lease bars fresh delegation admissions for the whole window,
 * so no new generation can be admitted between the checks and the release.
 * Any deviation (claim contention, reservation held, release unverifiable
 * or failed, generation changed, owner active, release port missing)
 * retains the binding for recovery/retry. Already-gone reads as retired
 * (idempotent). The lease always releases in a finally; a crash clears it
 * from memory while the binding stays retained.
 *
 * Bindings WITHOUT an identity resolve as no owner anywhere (scans,
 * recovery, dispatch all fail closed on them), so they delete directly —
 * still under the lock and still refusing while reserved or actively owned.
 */
export async function retireWorkerBinding(
  env: WorkerBindingRetirementEnv,
  workerSession: string,
): Promise<RetireWorkerBindingOutcome> {
  // Snapshot + claim atomically under the lock: claiming first means no new
  // delegation can be admitted for this name (reserve and availability both
  // refuse claimed names) from here through the verify-mutate below — the
  // release I/O between them cannot race a fresh admission.
  const snapshot = await env.runExclusive(async () => {
    const state = await env.loadState();
    const binding = state.orchestration.workerBindings[workerSession];
    if (!binding) return null;
    const copy = { ...binding };
    if (!copy.logicalSessionId || !copy.transportEngine) {
      // Incomplete: no ownership handle, so the single-mutate direct path
      // below needs no lease (no engine I/O gap to protect).
      return { kind: "incomplete", binding: copy } as const;
    }
    // A held start reservation is a starting delegation: treat like an
    // active owner and back off before claiming anything.
    if (env.hasStartReservation(workerSession)) return { kind: "blocked" } as const;
    if (hasActiveOwner(env, state, workerSession)) return { kind: "blocked" } as const;
    if (!tryClaimWorkerRetirement(workerSession)) return { kind: "blocked" } as const;
    return { kind: "complete", binding: copy } as const;
  });
  if (!snapshot) return "retired";
  if (snapshot.kind === "blocked") return "retained";
  if (snapshot.kind === "incomplete") {
    return await env.runExclusive(async () => {
      const state = await env.loadState();
      const current = state.orchestration.workerBindings[workerSession];
      if (!current) return "retired" as const;
      if (current.logicalSessionId || current.transportEngine) {
        // Completed concurrently — the complete path below owns this now.
        return "retained" as const;
      }
      if (env.hasStartReservation(workerSession)) return "retained" as const;
      if (hasActiveOwner(env, state, workerSession)) return "retained" as const;
      delete state.orchestration.workerBindings[workerSession];
      await env.saveState(state);
      return "retired" as const;
    });
  }
  const claimed = snapshot.binding;
  if (!claimed.logicalSessionId || !claimed.transportEngine) {
    // Unreachable: incomplete snapshots take the direct path above. Retained
    // defensively — never release without a proven identity.
    releaseWorkerRetirement(workerSession);
    return "retained";
  }
  if (!env.releaseWorkerSession) {
    releaseWorkerRetirement(workerSession);
    return "retained";
  }
  try {
    // Re-checks (no lock held): the lease already bars fresh admissions,
    // so these only observe task-side changes (a task going active, a
    // generation swap by a path that does not reserve).
    const preRelease = await env.loadState();
    const preBinding = preRelease.orchestration.workerBindings[workerSession];
    if (!preBinding || !sameBindingGeneration(preBinding, claimed)) return "retained";
    if (env.hasStartReservation(workerSession)) return "retained";
    if (hasActiveOwner(env, preRelease, workerSession)) return "retained";
    try {
      await env.releaseWorkerSession({
        workerSession,
        targetAgent: claimed.targetAgent,
        workspace: claimed.workspace,
        ...(claimed.cwd ? { cwd: claimed.cwd } : {}),
        ...(claimed.role ? { role: claimed.role } : {}),
        logicalSessionId: claimed.logicalSessionId,
        transportEngine: claimed.transportEngine,
      });
    } catch {
      return "retained";
    }
    return await env.runExclusive(async () => {
      const state = await env.loadState();
      const current = state.orchestration.workerBindings[workerSession];
      if (!current) return "retired" as const;
      if (!sameBindingGeneration(current, claimed)) return "retained" as const;
      if (hasActiveOwner(env, state, workerSession)) return "retained" as const;
      delete state.orchestration.workerBindings[workerSession];
      await env.saveState(state);
      return "retired" as const;
    });
  } finally {
    releaseWorkerRetirement(workerSession);
  }
}

/**
 * Whether a non-terminal (or review-reopened) task still owns the session.
 * Mirrors the otherActiveOwner guards on the startup paths: terminal state
 * alone never proves the owner converged.
 */
function hasActiveOwner(
  env: WorkerBindingRetirementEnv,
  state: AppState,
  workerSession: string,
): boolean {
  return Object.values(state.orchestration.tasks).some(
    (task) =>
      task.workerSession === workerSession &&
      (!env.isTerminalStatus(task.status) || task.reviewPending !== undefined),
  );
}

/**
 * Same-generation check: the routing + identity fields that pin one worker
 * owner (name, coordinator, location, agent, role, LID, engine). Any drift
 * means another writer staged a new generation after our snapshot — never
 * delete what we did not converge.
 */
function sameBindingGeneration(
  current: WorkerBindingRecord,
  snapshot: WorkerBindingRecord,
): boolean {
  return (
    current.sourceHandle === snapshot.sourceHandle &&
    current.coordinatorSession === snapshot.coordinatorSession &&
    current.workspace === snapshot.workspace &&
    current.cwd === snapshot.cwd &&
    current.targetAgent === snapshot.targetAgent &&
    current.role === snapshot.role &&
    current.logicalSessionId === snapshot.logicalSessionId &&
    current.transportEngine === snapshot.transportEngine
  );
}
