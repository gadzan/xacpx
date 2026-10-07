import type { RequestedFilesystemPolicy } from "../adapters/conversation-effect-policy";
import { ConversationError } from "./conversation-error";
import type { AcceptRequestResult } from "./conversation-store";

export interface ConversationMemberPolicy {
  botId: string;
  filesystem: RequestedFilesystemPolicy;
}

export function parseMemberPolicies(value: unknown): ConversationMemberPolicy[] {
  const invalid = (): never => { throw new ConversationError("invalid-effect-policy", "memberPolicies must select 1–64 unique Bots with filesystem read-only or read-write"); };
  if (!Array.isArray(value) || value.length < 1 || value.length > 64) return invalid();
  const seen = new Set<string>();
  return value.map((entry: unknown) => {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) return invalid();
    const p = entry as Record<string, unknown>;
    if (Object.keys(p).length !== 2 || typeof p.botId !== "string" || !p.botId.trim() || p.botId.length > 128
      || seen.has(p.botId) || (p.filesystem !== "read-only" && p.filesystem !== "read-write")) return invalid();
    seen.add(p.botId);
    return { botId: p.botId, filesystem: p.filesystem };
  });
}

export function assertPolicySelection(selected: readonly string[], policies?: readonly ConversationMemberPolicy[]): void {
  if (policies && (policies.length !== selected.length || policies.some((p) => !selected.includes(p.botId)))) {
    throw new ConversationError("invalid-effect-policy", "memberPolicies must match the complete explicit member selection");
  }
}

/** A safety request cannot replay an older writable acceptance under the same id. */
export function assertAcceptedPolicies(accepted: AcceptRequestResult, policies?: readonly ConversationMemberPolicy[]): AcceptRequestResult {
  if (policies) for (const policy of policies) {
    const member = accepted.memberTurns.find((m) => m.botId === policy.botId);
    if (!member || (policy.filesystem === "read-only"
      ? member.effect !== "read-only" || member.effectProvenance !== "declared-enforced"
      : member.effect !== "mutating" || member.effectProvenance !== undefined)) {
      throw new ConversationError("effect_policy_conflict", "request id already accepted with a different execution ceiling");
    }
  }
  return accepted;
}
