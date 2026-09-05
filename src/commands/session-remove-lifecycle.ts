import { AsyncMutex } from "../orchestration/async-mutex";
import { physicalLifecycleKeyForResolvedSession } from "../bridge/engine/runtime/physical-session-identity";
import type { SessionService } from "../sessions/session-service";
import type { ResolvedSession, SessionTransport } from "../transport/types";

/**
 * Process-wide lifecycle locks keyed by canonical physical session
 * identity. Two aliases sharing one physical acpx session MUST serialize
 * their remove transactions: each must recount the remaining physical
 * owners inside the lock, or two concurrent removes both observe each
 * other, both release, and nobody performs the final hard delete (orphaned
 * physical record with no logical retry handle left).
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
  /** "released" for a surviving-sibling alias, "deleted" for the last alias. */
  action: "released" | "deleted";
  /** Physical owners remaining after this transaction (excluding self). */
  sharedAliasCount: number;
}

/**
 * Remove one Runtime-bound logical alias under its physical-group lock.
 * Inside the lock: recount physical co-owners, release this alias's engine
 * state when siblings survive (physical record kept) or hard-delete the
 * physical session when this alias is last, then durably remove the logical
 * row. Any transport failure propagates BEFORE the logical row disappears,
 * so the caller keeps the retry handle. Callers MUST NOT have removed the
 * logical row beforehand.
 */
export async function removeRuntimeAliasWithPhysicalLifecycle(options: {
  sessions: SessionService;
  transport: Pick<SessionTransport, "releaseLogicalSession" | "deleteSession">;
  session: ResolvedSession;
  internalAlias: string;
}): Promise<PhysicalRemoveOutcome> {
  const { sessions, transport, session, internalAlias } = options;
  const groupKey = physicalLifecycleKeyForResolvedSession(session);
  return lockForPhysicalKey(groupKey).run(async () => {
    const remaining = sessions.countAliasesSharingPhysicalIdentity(session, internalAlias);
    if (remaining > 0) {
      if (!transport.releaseLogicalSession) {
        throw new Error(
          `cannot release Runtime alias "${internalAlias}": transport has no releaseLogicalSession operation`,
        );
      }
      await transport.releaseLogicalSession(session);
    } else {
      await transport.deleteSession?.(session);
    }
    const { wasActive } = await sessions.removeSession(internalAlias);
    return { wasActive, action: remaining > 0 ? "released" : "deleted", sharedAliasCount: remaining };
  });
}
