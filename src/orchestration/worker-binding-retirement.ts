import type { AppState, SessionTransportEngine } from "../state/types";
import type { OrchestrationTaskStatus, WorkerBindingRecord } from "./orchestration-types";

/** Outcome of a worker-binding retirement attempt. */
export type RetireWorkerBindingOutcome = "retired" | "retained";

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
}

/**
 * Retire one worker binding as a durable ownership handle — never as plain
 * orchestration metadata. A binding WITH a complete identity (LID + engine)
 * is the Runtime owner/fence/journal/recovery handle: it may be deleted only
 * after verified engine-side convergence, never speculatively.
 *
 * Snapshot the exact identity → verified release outside the lock → re-enter
 * the lock and delete ONLY if the binding is still the same generation with
 * no active owner. Any deviation (release unverifiable or failed, generation
 * changed, active owner appeared, release port missing) retains the binding
 * for recovery/retry. Already-gone reads as retired (idempotent).
 *
 * Bindings WITHOUT an identity resolve as no owner anywhere (scans,
 * recovery, dispatch all fail closed on them), so they delete directly —
 * still under the lock and still refusing while actively owned.
 */
export async function retireWorkerBinding(
  env: WorkerBindingRetirementEnv,
  workerSession: string,
): Promise<RetireWorkerBindingOutcome> {
  const snapshot = await env.runExclusive(async () => {
    const state = await env.loadState();
    const binding = state.orchestration.workerBindings[workerSession];
    if (!binding) return null;
    return { ...binding };
  });
  if (!snapshot) return "retired";
  if (!snapshot.logicalSessionId || !snapshot.transportEngine) {
    return await env.runExclusive(async () => {
      const state = await env.loadState();
      const current = state.orchestration.workerBindings[workerSession];
      if (!current) return "retired" as const;
      if (current.logicalSessionId || current.transportEngine) {
        // Completed concurrently — the complete path below owns this now.
        return "retained" as const;
      }
      if (hasActiveOwner(env, state, workerSession)) return "retained" as const;
      delete state.orchestration.workerBindings[workerSession];
      await env.saveState(state);
      return "retired" as const;
    });
  }
  if (!env.releaseWorkerSession) return "retained";
  // Best-effort pre-release check (no lock held): an owner that went
  // active after collection must not be released. The verify-mutate below
  // remains the correctness backstop for deletion; this only narrows the
  // window in which release itself could disturb a newly-active worker.
  // (Ephemeral `:p-uuid` names make even this window unreachable — no other
  // delegation can ever reference them.)
  const preRelease = await env.loadState();
  const preBinding = preRelease.orchestration.workerBindings[workerSession];
  if (!preBinding || !sameBindingGeneration(preBinding, snapshot)) return "retained";
  if (hasActiveOwner(env, preRelease, workerSession)) return "retained";
  try {
    await env.releaseWorkerSession({
      workerSession,
      targetAgent: snapshot.targetAgent,
      workspace: snapshot.workspace,
      ...(snapshot.cwd ? { cwd: snapshot.cwd } : {}),
      ...(snapshot.role ? { role: snapshot.role } : {}),
      logicalSessionId: snapshot.logicalSessionId,
      transportEngine: snapshot.transportEngine,
    });
  } catch {
    return "retained";
  }
  return await env.runExclusive(async () => {
    const state = await env.loadState();
    const current = state.orchestration.workerBindings[workerSession];
    if (!current) return "retired" as const;
    if (!sameBindingGeneration(current, snapshot)) return "retained" as const;
    if (hasActiveOwner(env, state, workerSession)) return "retained" as const;
    delete state.orchestration.workerBindings[workerSession];
    await env.saveState(state);
    return "retired" as const;
  });
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
