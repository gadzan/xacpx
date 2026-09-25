import { isDirectConversationChatKey } from "../domain/ids";
import type { PermissionInteractionOrigin } from "../permissions/permission-types";
import type { HumanIngressContext, MemberTurnOrigin } from "./conversation-types";

export type { HumanIngressContext };

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

/**
 * Server-derived human ingress. Product isolation keys (`bot:…`) cannot be a
 * permission return route. Incomplete or client-shaped values are discarded.
 */
export function parseHumanIngress(value: unknown): HumanIngressContext | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const raw = value as Record<string, unknown>;
  if (!isNonEmptyString(raw.chatKey) || !isNonEmptyString(raw.senderId)) {
    return undefined;
  }
  if (isDirectConversationChatKey(raw.chatKey)) {
    return undefined;
  }
  return {
    chatKey: raw.chatKey.trim(),
    senderId: raw.senderId.trim(),
    ...(isNonEmptyString(raw.accountId) ? { accountId: raw.accountId.trim() } : {}),
    ...(isNonEmptyString(raw.senderName) ? { senderName: raw.senderName.trim() } : {}),
    ...(typeof raw.isOwner === "boolean" ? { isOwner: raw.isOwner } : {}),
  };
}

export function isCompleteHumanIngress(
  value: HumanIngressContext | undefined,
): value is HumanIngressContext {
  return parseHumanIngress(value) !== undefined;
}

/**
 * Server-derived Conversation execution provenance.
 *
 * Human interactive permission authority requires both:
 * - a fresh same-process `authorityEpoch` match, and
 * - complete trusted human ingress (authenticated sender + permission route).
 *
 * Recovery / automatic redispatch / public accepts without ingress are
 * orchestration and cannot mint a human permission interaction. Callers must
 * not invent this value.
 */
export function conversationExecutionOrigin(
  authorityEpoch: string | undefined,
  liveEpoch: string,
  humanIngress?: HumanIngressContext,
): PermissionInteractionOrigin {
  if (authorityEpoch === undefined || authorityEpoch !== liveEpoch) {
    return "orchestration";
  }
  return isCompleteHumanIngress(humanIngress) ? "human" : "orchestration";
}

export function memberTurnOriginFromExecution(
  origin: PermissionInteractionOrigin,
  provenance?: MemberTurnOrigin,
): MemberTurnOrigin {
  if (origin === "human") {
    return "human-explicit";
  }
  // Fresh orchestration provenance (router/handoff/followup/retry) is
  // preserved: only a genuinely redriven claim defaults to "recovery".
  // Legacy "human" reads through the compat layer below.
  return provenance ?? "recovery";
}

export function conversationExecutionOriginFromMemberTurn(
  origin: MemberTurnOrigin | "human",
): PermissionInteractionOrigin {
  return origin === "human-explicit" || origin === "human" ? "human" : "orchestration";
}

/** Same predicate session-handler uses: only explicit human mints an interaction. */
export function canMintHumanPermissionInteraction(
  origin: PermissionInteractionOrigin | undefined,
): boolean {
  return origin === "human";
}
