/**
 * A selected mention is a bot id plus the display token the user sees.
 * The textarea string is not re-parsed as the only source of truth.
 */

export interface MentionBinding {
  botId: string;
  displayToken: string;
}

export interface GroupMentionMember {
  botId: string;
  name: string;
  role?: string;
  enabled: boolean;
  lead: boolean;
}

export type MentionTarget =
  | { mode: "members"; botIds: string[] }
  | { mode: "everyone" };

export type MentionApply =
  | { kind: "pending" }
  | { kind: "resolved"; target: MentionTarget; bindings: MentionBinding[] }
  | {
      kind: "unresolved";
      displayToken: string;
      reason: "unknown" | "ambiguous" | "disabled" | "removed";
      bindings: MentionBinding[];
    };

interface MentionToken {
  name: string;
  everyone: boolean;
  displayToken: string;
}

const BARE_MENTION_END = /[\s\n,;:!?.，。：；！？]/;
const MENTION_TOKEN = /(^|[\s\n])@("([^"]*)"|([^\s@,;:!?.，。：；！？]*))/g;

export function mentionDisplayToken(name: string): string {
  if (name === "everyone") return "@everyone";
  if (/[\s\n,;:!?.，。：；！？"]/.test(name)) return `@"${name.replaceAll('"', "")}"`;
  return `@${name}`;
}

function committedTokens(text: string, endOfTextTerminates: boolean): MentionToken[] {
  const tokens: MentionToken[] = [];
  for (const match of text.matchAll(MENTION_TOKEN)) {
    const quoted = match[3];
    const bare = match[4] ?? "";
    if (quoted !== undefined) {
      if (quoted.length === 0) continue;
      tokens.push({ name: quoted, everyone: false, displayToken: `@"${quoted}"` });
      continue;
    }
    const start = match.index ?? 0;
    const end = start + match[0].length;
    if (end >= text.length ? !endOfTextTerminates : !BARE_MENTION_END.test(text[end] ?? "")) continue;
    if (bare.length === 0) continue;
    tokens.push({
      name: bare,
      everyone: bare === "everyone",
      displayToken: `@${bare}`,
    });
  }
  return tokens;
}

function takeBinding(bindings: MentionBinding[], displayToken: string): MentionBinding | undefined {
  const index = bindings.findIndex((binding) => binding.displayToken === displayToken);
  if (index < 0) return undefined;
  return bindings.splice(index, 1)[0];
}

export function reconcileMentions(
  text: string,
  prior: readonly MentionBinding[],
  members: readonly GroupMentionMember[],
  endOfTextTerminates = false,
): MentionApply {
  const tokens = committedTokens(text, endOfTextTerminates);
  if (tokens.length === 0) return { kind: "pending" };
  const pool = prior.map((binding) => ({ ...binding }));
  const bindings: MentionBinding[] = [];
  const botIds: string[] = [];
  let everyone = false;
  for (const token of tokens) {
    if (token.everyone) {
      everyone = true;
      continue;
    }
    const bound = takeBinding(pool, token.displayToken);
    if (bound) {
      const member = members.find((row) => row.botId === bound.botId);
      if (!member) {
        return { kind: "unresolved", displayToken: token.displayToken, reason: "removed", bindings };
      }
      if (!member.enabled) {
        return { kind: "unresolved", displayToken: token.displayToken, reason: "disabled", bindings };
      }
      if (!botIds.includes(bound.botId)) botIds.push(bound.botId);
      bindings.push({ botId: bound.botId, displayToken: token.displayToken });
      continue;
    }
    const key = token.name.toLowerCase();
    const named = members.filter((row) => row.name.toLowerCase() === key);
    const enabled = named.filter((row) => row.enabled);
    if (named.length === 0) {
      return { kind: "unresolved", displayToken: token.displayToken, reason: "unknown", bindings };
    }
    if (enabled.length === 0) {
      return { kind: "unresolved", displayToken: token.displayToken, reason: "disabled", bindings };
    }
    if (enabled.length > 1) {
      return { kind: "unresolved", displayToken: token.displayToken, reason: "ambiguous", bindings };
    }
    const match = enabled[0]!;
    if (!botIds.includes(match.botId)) botIds.push(match.botId);
    bindings.push({ botId: match.botId, displayToken: token.displayToken });
  }
  if (everyone) return { kind: "resolved", target: { mode: "everyone" }, bindings };
  return { kind: "resolved", target: { mode: "members", botIds }, bindings };
}

/** Menu query while the user is still typing. Quoted names may contain spaces. */
export function groupMentionQuery(text: string, cursor: number): { query: string; range: { start: number; end: number } } | null {
  const pos = Math.max(0, Math.min(cursor, text.length));
  const before = text.slice(0, pos);
  const at = before.lastIndexOf("@");
  if (at < 0) return null;
  if (at > 0 && !/[\s(]/.test(before[at - 1]!)) return null;
  const raw = before.slice(at + 1);
  if (raw.startsWith('"')) {
    const body = raw.slice(1);
    if (body.includes('"') || /[\n]/.test(body)) return null;
    return { query: body.toLowerCase(), range: { start: at, end: pos } };
  }
  if (/[\s\n,;:!?.，。：；！？]/.test(raw)) return null;
  return { query: raw.toLowerCase(), range: { start: at, end: pos } };
}

export function filterMentionMembers(members: readonly GroupMentionMember[], query: string): GroupMentionMember[] {
  const q = query.toLowerCase();
  return members.filter((member) => {
    if (!q) return true;
    return member.name.toLowerCase().includes(q) || member.botId.toLowerCase().includes(q);
  });
}
