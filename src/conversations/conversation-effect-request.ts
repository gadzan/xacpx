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

/** Replay matches the original explicit acceptance, not later assigned work. */
export function assertAcceptedPolicies(accepted: AcceptRequestResult, policies?: readonly ConversationMemberPolicy[]): AcceptRequestResult {
  // Handoff and Router work have durable assignment IDs, including handoffs to
  // an originally selected Bot in batch 1. Recovery preserves these identities;
  // origin is mutable during recovery and must not determine request membership.
  const originalMembers = accepted.run.mode === "automatic" ? [] : accepted.memberTurns.filter(
    (member) => member.batch === 1 && member.assignmentId === undefined,
  );
  if (!policies && originalMembers.some((member) => (member.effect ?? "unknown") !== "unknown" || member.effectProvenance !== undefined)) {
    throw new ConversationError("effect_policy_conflict", "request id already accepted with a different execution ceiling");
  }
  if (policies) {
    if (policies.length !== originalMembers.length) {
      throw new ConversationError("effect_policy_conflict", "request id already accepted with a different execution ceiling");
    }
    const requested = new Map(policies.map((policy) => [policy.botId, policy.filesystem]));
    for (const member of originalMembers) {
      const filesystem = requested.get(member.botId);
      if (!filesystem || (filesystem === "read-only"
        ? member.effect !== "read-only" || member.effectProvenance !== "declared-enforced"
        : member.effect !== "mutating" || member.effectProvenance !== undefined)) {
        throw new ConversationError("effect_policy_conflict", "request id already accepted with a different execution ceiling");
      }
      requested.delete(member.botId);
    }
  }
  return accepted;
}
