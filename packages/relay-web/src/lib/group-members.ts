import type { BotAvatarConfig, BotSummaryDto, MemberTurnSummaryDto } from "@ganglion/xacpx-relay-protocol";

/**
 * The Group's membership, projected for display.
 *
 * Two consumers read it: the member panel (the roster) and the "who is
 * working" row (the members that currently hold a turn). Both read the same
 * facts, so the facts live here, pure and store-free.
 *
 * A disabled member is still a member: the Group keeps naming it, it stays
 * in the roster, and it is only excluded from the avatar collage. A removed
 * Bot (retired) and a member the catalog does not know yet are different
 * states and must never be presented as "disabled": one can take no work
 * because it is gone, the other because nothing is known about it yet.
 */
export type GroupMemberState = "enabled" | "disabled" | "removed" | "unknown";

export interface GroupMemberRow {
  botId: string;
  /** The Bot's name, or its id when the catalog does not know it. */
  name: string;
  role?: string;
  avatar?: BotAvatarConfig;
  driver?: string;
  /** The Group's Lead, which takes new work by default. */
  isLead: boolean;
  state: GroupMemberState;
}

export interface GroupMemberRosterInput {
  /** The Group's membership, in the Group's own order. */
  botIds: string[];
  leadBotId?: string;
  /** The instance's Bot catalog. */
  bots: BotSummaryDto[];
  /** The driver behind a Bot's agent, for the avatar fallback. */
  driverFor?: (botId: string) => string | undefined;
}

/**
 * The roster: the Lead first, then the remaining members in the Group's own
 * order. The order is the Group's, not the catalog's — the Group decides who
 * is in, and in which order it lists them.
 */
export function presentGroupMembers(input: GroupMemberRosterInput): GroupMemberRow[] {
  const byId = new Map(input.bots.map((bot) => [bot.id, bot]));
  const rows = input.botIds.map((botId): GroupMemberRow => {
    const bot = byId.get(botId);
    if (!bot) {
      // The catalog has not confirmed this Bot. Claim nothing about it.
      return { botId, name: botId, isLead: botId === input.leadBotId, state: "unknown" };
    }
    const driver = input.driverFor?.(botId);
    return {
      botId,
      name: bot.name,
      role: bot.role,
      avatar: bot.avatar,
      ...(driver ? { driver } : {}),
      isLead: botId === input.leadBotId,
      state: bot.retired ? "removed" : bot.enabled ? "enabled" : "disabled",
    };
  });
  const lead = rows.filter((row) => row.isLead);
  const rest = rows.filter((row) => !row.isLead);
  return [...lead, ...rest];
}

/** How many members are disabled: they keep their seat but take no new work. */
export function countDisabledGroupMembers(rows: GroupMemberRow[]): number {
  return rows.filter((row) => row.state === "disabled").length;
}

export interface GroupWorkingMember {
  botId: string;
  name: string;
}

/**
 * The members that currently hold a turn.
 *
 * Two facts decide it, and both come from the store's live turn state:
 *   · the durable member-turn state — a running turn is executing;
 *   · the live turn map — a member whose live turn is streaming (or whose
 *     live entry survived a reconnect) is still working even when the
 *     durable row has not caught up yet.
 *
 * A queued or dispatched turn has not started executing yet, so it is not
 * "working"; a turn that completed, failed, was cancelled or ended
 * indeterminate is over, and a member with no turn at all is idle.
 */
export function presentGroupWorkingMembers(input: {
  memberTurns: MemberTurnSummaryDto[];
  /** Member-turn ids that currently carry a live turn. */
  liveTurnIds: string[];
  bots: BotSummaryDto[];
}): GroupWorkingMember[] {
  const byId = new Map(input.bots.map((bot) => [bot.id, bot]));
  const live = new Set(input.liveTurnIds);
  const seen = new Set<string>();
  const working: GroupWorkingMember[] = [];
  for (const turn of input.memberTurns) {
    if (turn.state !== "running" && !live.has(turn.id)) continue;
    if (seen.has(turn.botId)) continue;
    seen.add(turn.botId);
    working.push({ botId: turn.botId, name: byId.get(turn.botId)?.name ?? turn.botId });
  }
  return working;
}
