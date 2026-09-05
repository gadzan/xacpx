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
