/** Group-chat wake rules. One shared transcript, one speaking channel. */

export interface GroupWakeMember {
  botId: string;
  /** Live display name. Whole-name matched, never a prefix. */
  name: string;
}

export type GroupWakeTarget =
  | { mode: "members"; botIds: string[] }
  | { mode: "everyone" };

/** A reply that is only whitespace or exactly this token speaks to nobody. */
export const SILENCE_REPLY = "[静默]";

/** Relay rounds after the human turn. The Run ends normally at the cap. */
export const RELAY_MAX_ROUNDS = 6;

/** Appended to the prompt on the final allowed round. */
export const RELAY_CLOSING_HINT = "这一轮快收尾了，只在必要时说话";

/** Context window replayed when a bot's acpx session is new or was reset. */
export const GROUP_RESET_TRANSCRIPT_MESSAGES = 30;

export function isSilenceReply(content: string): boolean {
  const trimmed = content.trim();
  return trimmed.length === 0 || trimmed === SILENCE_REPLY;
}

/**
 * Resolve @mentions to whole member display names. Names containing spaces,
 * `·` or commas match verbatim; the composer's quoted `@"Full Name"` form is
 * accepted too. An unmatched @ mentions nobody, and no @ at all wakes
 * everyone.
 */
export function parseMentions(text: string, members: readonly GroupWakeMember[]): GroupWakeTarget {
  const named = members.filter((member) => member.name.length > 0);
  if (named.length === 0) return { mode: "everyone" };
  // Longest first: "@Bob Reviewer" must not resolve as "@Bob".
  const longestFirst = [...named].sort((a, b) => b.name.length - a.name.length);
  const mentioned = new Set<string>();
  let index = 0;
  while (index < text.length) {
    if (text[index] !== "@") {
      index += 1;
      continue;
    }
    let name: string | undefined;
    let end = index + 1;
    if (text[index + 1] === '"') {
      const close = text.indexOf('"', index + 2);
      if (close > index + 2) {
        name = text.slice(index + 2, close);
        end = close + 1;
      }
    } else {
      const hit = longestFirst.find((member) => text.startsWith(member.name, index + 1));
      if (hit) {
        name = hit.name;
        end = index + 1 + hit.name.length;
      }
    }
    if (name === undefined) {
      index += 1;
      continue;
    }
    for (const member of named) {
      if (member.name === name) mentioned.add(member.botId);
    }
    index = end;
  }
  if (mentioned.size === 0) return { mode: "everyone" };
  return { mode: "members", botIds: [...mentioned] };
}

/** Durable per-bot read position in one topic's shared log. `pendingWake` is a
 *  wake that arrived while the bot was mid-turn; it is consumed by exactly one
 *  extra turn when that turn ends. `contextGeneration` records the topic
 *  generation the bot last read under, so a cleared context is detected as a
 *  reset and replayed instead of silently resumed. */
export interface GroupReadCursor {
  lastSeq: number;
  pendingWake: boolean;
  contextGeneration: number;
}
