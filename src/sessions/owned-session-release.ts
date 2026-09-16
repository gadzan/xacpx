/**
 * Verified release of an owned hidden session.
 *
 * Conversations and Bot runtime must not call `SessionService.removeSession`
 * for teardown: that only drops the LogicalSession row. Production wiring
 * is `CommandRouter.removeSessionWithTransport` / `removeAliasWithPhysicalLifecycle`,
 * which settles the physical acpx/Runtime session under the physical-group
 * lock and throws before the logical row disappears on Runtime failure.
 *
 * Callers keep LogicalSession + binding + deleting tombstone when this throws.
 */
export type ReleaseOwnedSession = (alias: string) => Promise<void>;
