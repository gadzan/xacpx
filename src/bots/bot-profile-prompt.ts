import { isKnownXacpxCommandText } from "../commands/command-list";
import type { BotProfile, BotProfileSnapshot } from "./bot-types";

/**
 * Version of the lead-seat prompt layer, baked into the prompt text itself.
 * Bump this when the seat wording changes so a prompt can be told apart
 * from an older seat layer at a glance, without re-reading the code.
 */
export const LEAD_SEAT_PROMPT_VERSION = 1;

/**
 * The lead-seat layer, verbatim. It is a code constant, never a line copied
 * out of a Bot profile: whichever Bot holds the lead seat gets exactly this
 * text, so swapping `leadBotId` changes who receives it, never what it says.
 * It states seat behaviour only (discover members, dispatch independent work
 * in parallel, wire unclaimed or stuck work, summarise conclusions, turn
 * leftovers into follow-up tasks); it carries no business rules.
 */
export const LEAD_SEAT_PROMPT =
  `You are sitting in the Group lead seat (lead seat prompt v${LEAD_SEAT_PROMPT_VERSION}). ` +
  `This seat layer takes priority over your personal instructions below: where they conflict, the seat layer wins. ` +
  `As lead, discover the other members and their current work, dispatch independent tasks in parallel rather than one by one, ` +
  `connect unclaimed or stuck work with a member who can take it, summarise each settled result as a conclusion, ` +
  `and turn anything left unfinished into an explicit follow-up task instead of dropping it. ` +
  `When you are working as an ordinary member, this layer does not apply and your professional capability leads.`;

/** Group scope for prompt composition. `leadBotId` is the durable seat
 *  assignment, read live by the caller: changing it takes effect on the
 *  next turn without editing any Bot profile. */
export interface GroupPromptScope {
  title?: string;
  description?: string;
  leadBotId?: string;
}

/** Identity of the turn being composed, for the seat check. */
export interface LeadSeatContext {
  /** The Bot executing this turn. */
  botId: string;
  /** True only for a lead turn (see the dispatcher): the lead Bot doing
   *  member work — a dispatched assignment, including a peer handoff — is
   *  not a lead turn and never receives the seat layer. */
  isLeadTurn: boolean;
}

/** True exactly when this turn sits in the lead seat: the executing Bot is
 *  the Group's current lead, and this is a lead turn rather than member work. */
export function isLeadSeatTurn(scope: GroupPromptScope | undefined, lead: LeadSeatContext | undefined): boolean {
  return lead !== undefined
    && lead.isLeadTurn
    && scope?.leadBotId !== undefined
    && lead.botId === scope.leadBotId;
}

export function composeBotTurnPrompt(
  profile: Pick<BotProfile, "name" | "instructions">,
  userText: string,
  group?: GroupPromptScope,
  lead?: LeadSeatContext,
): string {
  if (isKnownXacpxCommandText(userText)) {
    return userText;
  }

  const lines = [
    isLeadSeatTurn(group, lead) ? LEAD_SEAT_PROMPT : undefined,
    `You are acting as the Bot named "${profile.name}".`,
    profile.instructions ? `Instructions:\n${profile.instructions}` : undefined,
    "This Bot profile does not change the underlying model, tools, or permission policy.",
    groupScopeLine(group),
  ].filter((line): line is string => Boolean(line));

  const body = userText;
  if (!body.trim()) {
    return lines.join("\n\n");
  }
  return `${lines.join("\n\n")}\n\n${body}`;
}

export function composeBotTurnPromptFromSnapshot(
  snapshot: BotProfileSnapshot,
  userText: string,
  group?: GroupPromptScope,
  lead?: LeadSeatContext,
): string {
  return composeBotTurnPrompt({
    name: snapshot.presentation.name,
    instructions: snapshot.behavior.instructions,
  }, userText, group, lead);
}

/** Group scope header: the Group title/description is presentation, not
 *  execution identity, so callers pass the live record, never a snapshot. */
function groupScopeLine(group: GroupPromptScope | undefined): string | undefined {
  const title = group?.title?.trim();
  const description = group?.description?.trim();
  if (!title && !description) return undefined;
  return [
    "You are collaborating in the Group" + (title ? ` "${title}"` : "") + ".",
    description ? `Group description:\n${description}` : undefined,
  ].filter((line): line is string => Boolean(line)).join("\n");
}
