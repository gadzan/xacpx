import { ConversationError } from "./conversation-error";

/**
 * Pure roundtable planning and speech parsing (design §5.3/§6.1/§6.3).
 *
 * A roundtable Run is planned once at accept: `rounds × speakers` MemberTurns
 * are pre-generated in round-major order, all in batch 1. Durable
 * `memberIndex` is the speaking order; `roundIndex`/`speakerIndex` are the
 * readable grouping and the claim-floor position. Neither the planner nor the
 * parser touches the store, so accept can validate the whole plan before any
 * durable write.
 */

export const MAX_ROUNDTABLE_ROUNDS = 3;
export const MAX_ROUNDTABLE_MEMBER_TURNS = 24;
export const MIN_ROUNDTABLE_SPEAKERS = 2;

export interface RoundtableTurnPlan {
  botId: string;
  /** Continuous global speaking order (0-based). */
  memberIndex: number;
  /** 1-based round. */
  roundIndex: number;
  /** 0-based speaker position within the round. */
  speakerIndex: number;
}

export interface RoundtablePlan {
  rounds: number;
  /** Opening speaker snapshot, present exactly when the Group lead is among
   *  the selected speakers. Absent when the selection excludes the lead. */
  leadBotId?: string;
  turns: RoundtableTurnPlan[];
}

export interface PlanRoundtableInput {
  /** Caller order. The UI puts the lead first; the planner enforces that when
   *  the lead is included so the durable opener snapshot is truthful. */
  botIds: readonly string[];
  /** 1–3; default 1. */
  rounds?: number;
  /** Durable Group lead. It need not be in this selection. */
  leadBotId?: string;
}

function invalid(message: string): ConversationError {
  return new ConversationError("invalid-roundtable", message);
}

/**
 * Validate and expand a roundtable selection. Fails closed (never truncates)
 * when the selection is malformed or exceeds the design bounds. The same Bot
 * may speak in several rounds, but a Bot appears at most once per round.
 */
export function planRoundtable(input: PlanRoundtableInput): RoundtablePlan {
  const botIds = input.botIds;
  if (!Array.isArray(botIds) || botIds.length < MIN_ROUNDTABLE_SPEAKERS) {
    throw invalid(`a roundtable needs at least ${MIN_ROUNDTABLE_SPEAKERS} speakers`);
  }
  if (botIds.length > MAX_ROUNDTABLE_MEMBER_TURNS) {
    throw invalid(`a roundtable selects at most ${MAX_ROUNDTABLE_MEMBER_TURNS} speakers`);
  }
  const seen = new Set<string>();
  for (const botId of botIds) {
    if (typeof botId !== "string" || botId.length === 0) {
      throw invalid("a roundtable speaker must be a Bot id");
    }
    if (seen.has(botId)) {
      throw invalid("a roundtable speaker list must be unique within a round");
    }
    seen.add(botId);
  }
  const rounds = input.rounds ?? 1;
  if (!Number.isInteger(rounds) || rounds < 1 || rounds > MAX_ROUNDTABLE_ROUNDS) {
    throw invalid(`a roundtable holds between 1 and ${MAX_ROUNDTABLE_ROUNDS} rounds`);
  }
  if (botIds.length * rounds > MAX_ROUNDTABLE_MEMBER_TURNS) {
    throw invalid(`a roundtable plans at most ${MAX_ROUNDTABLE_MEMBER_TURNS} member turns`);
  }
  // The lead is a snapshot of the opening speaker, never a required
  // participant: a discussion may target a subset that excludes the Group
  // lead. When the lead IS selected it opens (caller order is re-derived from
  // that fact); when it is not, the plan carries no lead snapshot at all.
  const lead = input.leadBotId;
  if (lead !== undefined && (typeof lead !== "string" || lead.length === 0)) {
    throw invalid("a roundtable lead must be a Bot id");
  }
  const ordered = lead !== undefined && seen.has(lead)
    ? [lead, ...botIds.filter((botId) => botId !== lead)]
    : [...botIds];
  const turns: RoundtableTurnPlan[] = [];
  for (let roundIndex = 1; roundIndex <= rounds; roundIndex += 1) {
    for (const [speakerIndex, botId] of ordered.entries()) {
      turns.push({ botId, roundIndex, speakerIndex, memberIndex: turns.length });
    }
  }
  return {
    rounds,
    ...(lead !== undefined && seen.has(lead) ? { leadBotId: lead } : {}),
    turns,
  };
}

export type RoundtableSpeech =
  | { outcome: "message"; content: string }
  | { outcome: "pass" }
  | { outcome: "empty" };

/**
 * Parse the final text of a roundtable turn BEFORE it is persisted.
 *
 * - Trimmed, case-insensitive `(pass)` is an explicit abstention.
 * - Empty text is a failure (`empty-speech`), never a pass: silence is not
 *   consent to skip, and the caller fails the turn instead.
 * - Anything else is a normal public message, preserved verbatim.
 */
export function parseRoundtableSpeech(text: string): RoundtableSpeech {
  const trimmed = text.trim();
  if (trimmed.length === 0) {
    return { outcome: "empty" };
  }
  if (trimmed.toLowerCase() === "(pass)") {
    return { outcome: "pass" };
  }
  return { outcome: "message", content: text };
}
