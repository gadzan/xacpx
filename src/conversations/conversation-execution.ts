import type { PermissionInteractionOrigin } from "../permissions/permission-types";
import type { MemberTurnOrigin } from "./conversation-types";

/**
 * Server-derived Conversation execution provenance.
 *
 * Human interactive permission authority is allowed only for a fresh direct
 * request dispatched by the same live authority epoch that accepted it.
 * Recovery / automatic redispatch is orchestration and cannot mint a human
 * permission interaction. Callers must not invent this value.
 */
export function conversationExecutionOrigin(
  authorityEpoch: string | undefined,
  liveEpoch: string,
): PermissionInteractionOrigin {
  return authorityEpoch !== undefined && authorityEpoch === liveEpoch ? "human" : "orchestration";
}

export function memberTurnOriginFromExecution(
  origin: PermissionInteractionOrigin,
): MemberTurnOrigin {
  return origin === "human" ? "human" : "recovery";
}

export function conversationExecutionOriginFromMemberTurn(
  origin: MemberTurnOrigin,
): PermissionInteractionOrigin {
  return origin === "human" ? "human" : "orchestration";
}

/** Same predicate session-handler uses: only explicit human mints an interaction. */
export function canMintHumanPermissionInteraction(
  origin: PermissionInteractionOrigin | undefined,
): boolean {
  return origin === "human";
}
