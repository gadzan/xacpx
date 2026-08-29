import type { DiscordInboundMessage, DiscordRoute } from "./types.js";
import type { DiscordResolvedAccountConfig } from "./config.js";

export type DiscordParsedRoute = DiscordRoute & { chatKey: string };

export function buildDiscordChatKey(input: { accountId: string; route: DiscordRoute }): string {
  const { accountId, route } = input;
  if (route.kind === "dm") return `discord:${accountId}:dm:${route.channelId}`;
  if (route.kind === "thread") return `discord:${accountId}:t:${route.channelId}`;
  return `discord:${accountId}:g:${route.channelId}`;
}

export function parseDiscordChatKey(chatKey: string): DiscordParsedRoute | null {
  if (!chatKey.startsWith("discord:")) return null;
  const parts = chatKey.split(":");
  // discord:<accountId>:<kind>:<id...>
  // kind is dm/g/t
  if (parts.length < 4) return null;
  const accountId = parts[1];
  const kindToken = parts[2];
  const channelId = parts.slice(3).join(":");
  if (!accountId || !channelId) return null;
  let kind: DiscordRoute["kind"];
  if (kindToken === "dm") kind = "dm";
  else if (kindToken === "g") kind = "guild";
  else if (kindToken === "t") kind = "thread";
  else return null;
  const route: DiscordRoute = { accountId, kind, channelId };
  return { ...route, chatKey };
}

export function buildDiscordQueueKey(accountId: string, channelId: string, kind: DiscordRoute["kind"]): string {
  return `${accountId}:${kind}:${channelId}`;
}

export function buildDiscordRoute(input: {
  accountId: string;
  message: DiscordInboundMessage;
}): DiscordRoute {
  if (!input.message.guildId) {
    return { accountId: input.accountId, kind: "dm", channelId: input.message.channelId };
  }
  if (input.message.isThread) {
    return { accountId: input.accountId, kind: "thread", channelId: input.message.channelId, guildId: input.message.guildId ?? undefined };
  }
  return { accountId: input.accountId, kind: "guild", channelId: input.message.channelId, guildId: input.message.guildId ?? undefined };
}

export type DiscordPolicyDecision =
  | { allow: true }
  | { allow: false; reason: "dm_disabled" | "guild_disabled" | "sender_not_allowlisted" | "missing_sender_id" };

export function evaluateDiscordAccessPolicy(input: {
  route: DiscordRoute;
  account: DiscordResolvedAccountConfig;
  senderId?: string;
  senderRoleIds?: string[];
}): DiscordPolicyDecision {
  const { route, account, senderId, senderRoleIds } = input;
  if (route.kind === "dm") {
    if (account.dmPolicy === "disabled") return { allow: false, reason: "dm_disabled" };
    if (account.dmPolicy === "allowlist") {
      if (!senderId) return { allow: false, reason: "missing_sender_id" };
      if (!isAllowlisted(senderId, account.allowFrom)) return { allow: false, reason: "sender_not_allowlisted" };
    }
    return { allow: true };
  }

  // guild or thread
  if (account.guildPolicy === "disabled") return { allow: false, reason: "guild_disabled" };

  // guild-specific override
  if (route.guildId) {
    const guildCfg = account.guilds[route.guildId];
    if (guildCfg) {
      // If guild has users/roles allowlist, enforce it when either list is non-empty.
      const hasGuildAllowlist = (guildCfg.users && guildCfg.users.length > 0) || (guildCfg.roles && guildCfg.roles.length > 0);
      if (hasGuildAllowlist) {
        if (!senderId) return { allow: false, reason: "missing_sender_id" };
        const userOk = guildCfg.users ? isAllowlisted(senderId, guildCfg.users) : false;
        const roleOk = guildCfg.roles && senderRoleIds ? senderRoleIds.some((r) => guildCfg.roles!.includes(r)) : false;
        if (!userOk && !roleOk) return { allow: false, reason: "sender_not_allowlisted" };
      }
      // Check channel-level policy if present
      const channelCfg = guildCfg.channels?.[route.channelId];
      // channel policy doesn't block, just affects requireMention elsewhere; allow always when guild allows
    }
  }

  if (account.guildPolicy === "allowlist") {
    if (!senderId) return { allow: false, reason: "missing_sender_id" };
    const guildId = route.guildId;
    const guildCfg = guildId ? account.guilds[guildId] : undefined;
    const hasGuildSpecific = Boolean(guildCfg && ((guildCfg.users && guildCfg.users.length > 0) || (guildCfg.roles && guildCfg.roles.length > 0)));
    if (hasGuildSpecific) return { allow: true };
    if (!isAllowlisted(senderId, account.allowFrom)) return { allow: false, reason: "sender_not_allowlisted" };
  }
  return { allow: true };
}

function isAllowlisted(senderId: string, allowFrom: string[]): boolean {
  if (allowFrom.includes("*")) return true;
  return allowFrom.includes(senderId);
}

export function shouldHandleDiscordMessage(input: {
  message: DiscordInboundMessage;
  botUserId: string;
  requireMention: boolean;
  accountRequireMention: boolean;
  channelRequireMention?: boolean;
  guildId?: string | null;
  isDM: boolean;
}): { handle: true; text: string } | { handle: false; reason: "no_mention" | "unsupported_type" } {
  const { message, botUserId, isDM } = input;
  const raw = message.content ?? "";
  if (!isDM) {
    const effectiveRequireMention = input.requireMention ?? (input.channelRequireMention ?? input.accountRequireMention);
    if (effectiveRequireMention) {
      const mentionsBot = mentionsBotUser(message, botUserId);
      const repliesToBot = isDiscordReplyToBot(message, botUserId);
      if (!mentionsBot && !repliesToBot) {
        // Also allow prefix mention via content check (fallback when mentions not populated)
        const hasMentionTag = raw.includes(`<@${botUserId}>`) || raw.includes(`<@!${botUserId}>`);
        if (!hasMentionTag) return { handle: false, reason: "no_mention" };
      }
    }
  }
  const cleaned = cleanDiscordMention(raw, botUserId);
  return { handle: true, text: cleaned };
}

/**
 * Precise "this message replies to the bot" check. A bare reference id is NOT
 * enough — replying to another human must not count. Shared by the normal
 * mention gate and the abort fast path so they cannot drift apart.
 */
export function isDiscordReplyToBot(message: DiscordInboundMessage, botUserId: string): boolean {
  if (!botUserId) return false;
  if (message.repliedUserId && message.repliedUserId === botUserId) return true;
  return message.mentions?.repliedUser?.id === botUserId;
}

function mentionsBotUser(message: DiscordInboundMessage, botUserId: string): boolean {
  if (!botUserId) return false;
  if (message.mentions?.users) {
    for (const u of message.mentions.users) {
      if (u.id === botUserId) return true;
    }
  }
  return false;
}

export function cleanDiscordMention(text: string, botUserId: string): string {
  if (!text) return "";
  let out = text;
  if (botUserId) {
    out = out.replace(new RegExp(`<@!?${escapeRegExp(botUserId)}>`, "g"), "");
  }
  // Remove any remaining user mentions' raw tags but keep plain text fallback via cleanContent if needed
  // Keep content readable: collapse whitespace
  out = out.replace(/\s+/g, " ").trim();
  return out;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function resolveChannelRequireMention(
  account: DiscordResolvedAccountConfig,
  guildId: string | undefined,
  channelId: string,
): boolean | undefined {
  if (!guildId) return undefined;
  const guildCfg = account.guilds[guildId];
  if (!guildCfg) return undefined;
  const ch = guildCfg.channels?.[channelId];
  if (!ch) return undefined;
  return ch.requireMention;
}
