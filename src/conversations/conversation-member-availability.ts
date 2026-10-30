import type { MemberAvailabilityFact } from "./conversation-store";
import { TERMINAL_MEMBER_STATES, type MemberTurnState } from "./conversation-types";
import type { MemberAvailability } from "./conversation-router-types";

/**
 * Runtime availability sampling for the Router (design §8.3).
 *
 * Pure: the caller supplies the Group's member order and the durable facts the
 * store read returned for the Group's ACTIVE Runs, and this function only
 * classifies them. It never reads a clock, a Bot session, or a model answer,
 * and it never decides admission — availability is advice the Router may weigh,
 * while every claim/start re-checks lifecycle, permission, single-writer and
 * capacity against durable rows.
 */

export interface MemberAvailabilitySampleInput {
  /** Group member order; the snapshot preserves it deterministically. */
  members: readonly { botId: string; enabled: boolean }[];
  /** Active-Run MemberTurns of the same Conversation, oldest first. */
  turns: readonly MemberAvailabilityFact[];
  /** Durable Run-local quarantine (design §8.3). */
  quarantinedBotIds?: readonly string[];
  /** One sample time for every entry, stamped by the runtime. */
  sampledAt: string;
}

const EXECUTING_MEMBER_STATES: readonly MemberTurnState[] = ["dispatched", "running"];

/**
 * Classify every member from durable facts. Precedence is deliberate:
 *
 * 1. `unavailable` — disabled/missing Bot, or quarantined for this Run.
 * 2. `working` — in-flight or queued assignments. Busy never means
 *    undispatchable; a legal task still queues behind it.
 * 3. `waiting-children` — the member's own work returned but a public handoff
 *    it dispatched is still open, so it is waiting on its children.
 * 4. `waiting-human` — the member's latest turn sits in a Run parked for the
 *    human; it is not idle for new autonomous work.
 * 5. `idle` — nothing durable says otherwise.
 */
export function sampleMemberAvailability(input: MemberAvailabilitySampleInput): MemberAvailability[] {
  const active = new Map<string, number>();
  const pending = new Map<string, number>();
  const openChildSenders = new Set<string>();
  const latest = new Map<string, MemberAvailabilityFact>();
  for (const turn of input.turns) {
    if (EXECUTING_MEMBER_STATES.includes(turn.state)) active.set(turn.botId, (active.get(turn.botId) ?? 0) + 1);
    else if (turn.state === "queued") pending.set(turn.botId, (pending.get(turn.botId) ?? 0) + 1);
    // An open child means its sender is waiting for that assignment to return.
    if (turn.handoffSenderBotId !== undefined && !TERMINAL_MEMBER_STATES.includes(turn.state)) {
      openChildSenders.add(turn.handoffSenderBotId);
    }
    // Facts arrive in durable causal order, so the last row per Bot is its
    // latest work.
    latest.set(turn.botId, turn);
  }
  const quarantined = new Set(input.quarantinedBotIds ?? []);
  return input.members.map((member) => {
    const quarantinedForRun = quarantined.has(member.botId);
    const activeAssignments = active.get(member.botId) ?? 0;
    const pendingAssignments = pending.get(member.botId) ?? 0;
    const last = latest.get(member.botId);
    const state: MemberAvailability["state"] = !member.enabled || quarantinedForRun
      ? "unavailable"
      : activeAssignments + pendingAssignments > 0
        ? "working"
        : openChildSenders.has(member.botId)
          ? "waiting-children"
          : last?.runState === "waiting-human"
            ? "waiting-human"
            : "idle";
    return { botId: member.botId, state, activeAssignments, pendingAssignments, quarantinedForRun, sampledAt: input.sampledAt };
  });
}
