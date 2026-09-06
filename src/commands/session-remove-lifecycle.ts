import { AsyncMutex } from "../orchestration/async-mutex";
import { physicalLifecycleKeyForResolvedSession } from "../bridge/engine/runtime/physical-session-identity";
import type { SessionService } from "../sessions/session-service";
import type { ResolvedSession, SessionTransport } from "../transport/types";

/**
 * Process-wide lifecycle locks keyed by canonical physical session
 * identity. Every alias sharing one physical acpx session — CLI or
 * Runtime — MUST serialize remove transactions through its group lock:
 * each recounts the remaining physical owners inside the lock, so
 * concurrent removes cannot both observe each other and both skip the
 * final hard delete (orphaned physical record with no logical retry
 * handle left).
 */
const physicalRemoveLocks = new Map<string, AsyncMutex>();

function lockForPhysicalKey(physicalKey: string): AsyncMutex {
  let mutex = physicalRemoveLocks.get(physicalKey);
  if (!mutex) {
    mutex = new AsyncMutex();
    physicalRemoveLocks.set(physicalKey, mutex);
  }
  return mutex;
}

export interface PhysicalRemoveOutcome {
  wasActive: boolean;
  /**
   * "released" (Runtime sibling survives, physical kept), "deleted"
   * (last owner, physical hard-deleted), or "logical-only" (CLI alias with
   * surviving siblings — no engine state to settle, matching legacy).
   */
  action: "released" | "deleted" | "logical-only";
  /** Physical owners remaining after this transaction (excluding self). */
  sharedAliasCount: number;
  /** Legacy CLI best-effort warning; Runtime failures throw instead. */
  transportTeardownWarning?: string;
}

/**
 * Remove one logical alias under its physical-group lock. Inside the lock:
 * recount physical co-owners (fail closed on indeterminate membership),
 * settle this alias's engine state, then durably remove the logical row.
 * Any Runtime transport failure propagates BEFORE the logical row
 * disappears, so the caller keeps the retry handle. Callers MUST NOT have
 * removed the logical row beforehand.
 */
export async function removeAliasWithPhysicalLifecycle(options: {
  sessions: SessionService;
  transport: Pick<SessionTransport, "releaseLogicalSession" | "deleteSession">;
  session: ResolvedSession;
  internalAlias: string;
}): Promise<PhysicalRemoveOutcome> {
  const { sessions, transport, session, internalAlias } = options;
  const groupKey = physicalLifecycleKeyForResolvedSession(session);
  const isRuntime = session.transportEngine === "runtime";
  return lockForPhysicalKey(groupKey).run(async () => {
    const { siblings, indeterminateAliases } = sessions.findPhysicalSiblings(session, internalAlias);
    if (indeterminateAliases.length > 0) {
      throw new Error(
        `cannot remove alias "${internalAlias}": ${indeterminateAliases.length} persisted alias(es) ` +
          `(${indeterminateAliases.join(", ")}) cannot be resolved, so this alias cannot be proven ` +
          `to be (or not to be) the last physical owner; repair or remove those aliases first`,
      );
    }
    const remaining = siblings.length;
    let action: PhysicalRemoveOutcome["action"];
    let transportTeardownWarning: string | undefined;
    if (isRuntime) {
      if (remaining > 0) {
        if (!transport.releaseLogicalSession) {
          throw new Error(
            `cannot release Runtime alias "${internalAlias}": transport has no releaseLogicalSession operation`,
          );
        }
        await transport.releaseLogicalSession(session);
        action = "released";
      } else {
        if (!transport.deleteSession) {
          throw new Error(
            `cannot hard-delete last Runtime alias "${internalAlias}": transport has no deleteSession operation`,
          );
        }
        await transport.deleteSession(session);
        action = "deleted";
      }
    } else if (remaining === 0 && transport.deleteSession) {
      try {
        await transport.deleteSession(session);
        action = "deleted";
      } catch (error) {
        transportTeardownWarning = error instanceof Error ? error.message : String(error);
        action = "logical-only";
      }
    } else {
      action = "logical-only";
    }
    const { wasActive } = await sessions.removeSession(internalAlias);
    return { wasActive, action, sharedAliasCount: remaining, ...(transportTeardownWarning ? { transportTeardownWarning } : {}) };
  });
}

export interface ProvisionalSessionCleanup {
  sessions: SessionService;
  transport: Pick<SessionTransport, "deleteSession" | "releaseLogicalSession" | "removeSession">;
  session: ResolvedSession;
  internalAlias: string;
  cause?: unknown;
}

function provisionalCauseSuffix(cause: unknown): string {
  return cause instanceof Error ? `: ${cause.message}` : "";
}

/**
 * Converge a failed CREATE's provisional physical incarnation BEFORE the
 * logical row disappears: a daemon-side timeout is not a bridge-side
 * cancellation, so the ensure may still complete and leave a live
 * worker/record behind. The physical session is xacpx-created here, so a
 * verified hard delete is correct. If the cleanup cannot be verified, the
 * logical row is kept and the combined failure propagates for retry/delete.
 */
export async function convergeProvisionalCreate(cleanup: ProvisionalSessionCleanup): Promise<void> {
  // Fail-closed contract: a missing deleteSession operation is NOT success.
  // Optional-chaining it would drop the only retry handle while the
  // provisional owner may still be alive.
  if (!cleanup.transport.deleteSession) {
    throw new Error(
      `session creation failed${provisionalCauseSuffix(cleanup.cause)} and the provisional ` +
        `physical session could not be verified cleaned up: ` +
        `transport has no deleteSession operation; ` +
        `logical session "${cleanup.internalAlias}" kept for retry/delete`,
    );
  }
  try {
    await cleanup.transport.deleteSession(cleanup.session);
  } catch (cleanupError) {
    throw new Error(
      `session creation failed${provisionalCauseSuffix(cleanup.cause)} and the provisional ` +
        `physical session could not be verified cleaned up: ` +
        `${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}; ` +
        `logical session "${cleanup.internalAlias}" kept for retry/delete`,
    );
  }
  try {
    await cleanup.sessions.removeSession(cleanup.internalAlias);
  } catch {}
}

/**
 * Converge a failed NATIVE ATTACH's provisional incarnation. The physical
 * session is UPSTREAM-owned (an agent-native thread): it must never be
 * hard-deleted. Release this incarnation's logical engine state instead —
 * for Runtime that stops the provisional worker and drops a journal a
 * timed-out resume may still be converging toward, without stamping the
 * upstream record — then soft-close the provisional CLI owner. Like the
 * create path, an unverifiable cleanup keeps the logical row and the
 * combined failure propagates.
 */
export async function convergeProvisionalNativeAttach(cleanup: ProvisionalSessionCleanup): Promise<void> {
  try {
    if (cleanup.session.transportEngine === "runtime") {
      if (!cleanup.transport.releaseLogicalSession) {
        throw new Error("transport has no releaseLogicalSession operation");
      }
      await cleanup.transport.releaseLogicalSession(cleanup.session);
    } else {
      if (!cleanup.transport.removeSession) {
        throw new Error("transport has no removeSession operation");
      }
      await cleanup.transport.removeSession(cleanup.session);
    }
  } catch (cleanupError) {
    throw new Error(
      `native attach failed${provisionalCauseSuffix(cleanup.cause)} and the provisional ` +
        `incarnation could not be verified cleaned up: ` +
        `${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}; ` +
        `logical session "${cleanup.internalAlias}" kept for retry/delete`,
    );
  }
  try {
    await cleanup.sessions.removeSession(cleanup.internalAlias);
  } catch {}
}
