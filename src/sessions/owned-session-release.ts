import { removeAliasWithPhysicalLifecycle } from "../commands/session-remove-lifecycle";
import type { SessionTransport } from "../transport/types";
import type { SessionService } from "./session-service";

/**
 * Verified release of an owned hidden session.
 *
 * Conversations and Bot runtime must not call `SessionService.removeSession`
 * for teardown: that only drops the LogicalSession row. Production wiring is
 * `createStrictOwnedSessionRelease`, which calls
 * `removeAliasWithPhysicalLifecycle` with `physicalFailurePolicy: "strict"`.
 *
 * Any physical Runtime or CLI release/delete failure throws BEFORE the
 * LogicalSession row disappears. Ordinary user `/session rm` keeps the
 * helper's default legacy CLI best-effort path and is not this seam.
 *
 * Callers keep LogicalSession + binding + deleting tombstone when this throws.
 */
export type ReleaseOwnedSession = (alias: string) => Promise<void>;

export function createStrictOwnedSessionRelease(options: {
  sessions: SessionService;
  transport: Pick<SessionTransport, "releaseLogicalSession" | "deleteSession">;
}): ReleaseOwnedSession {
  const { sessions, transport } = options;
  return async (alias: string) => {
    const session = await sessions.getSession(alias);
    if (!session) {
      return;
    }
    await removeAliasWithPhysicalLifecycle({
      sessions,
      transport,
      session,
      internalAlias: alias,
      physicalFailurePolicy: "strict",
    });
  };
}
