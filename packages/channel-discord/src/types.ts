/**
 * Protocol-side shapes for the Discord channel.
 */

export type DiscordReplyMode = "auto" | "streaming" | "static";
export type DiscordTableMode = "code" | "bullets" | "off";
export type DiscordChatKind = "dm" | "guild" | "thread";

export type DiscordDmPolicy = "open" | "allowlist" | "disabled";
export type DiscordGuildPolicy = "open" | "allowlist" | "disabled";

export interface DiscordRoute {
  accountId: string;
  kind: DiscordChatKind;
  channelId: string;
  guildId?: string;
}

export interface DiscordParsedRoute extends DiscordRoute {
  chatKey: string;
}

export interface DeliveryTarget {
  channelId: string;
  guildId?: string;
}

export interface DiscordInboundMessage {
  id: string;
  channelId: string;
  guildId?: string | null;
  author: { id: string; bot?: boolean };
  content: string;
  cleanContent?: string;
  createdTimestamp: number;
  mentions?: { users?: Array<{ id: string }>; everyone?: boolean; repliedUser?: { id: string } | null };
  senderRoleIds?: string[];
  attachments?: Array<{
    id: string;
    url: string;
    name?: string;
    contentType?: string | null;
    size?: number;
  }>;
  isThread?: boolean;
  parentChannelId?: string | null;
  referencedMessageId?: string | null;
  repliedUserId?: string | null;
  // Raw discord.js Message for mention checks when available
  raw?: unknown;
}
export interface OutboundBody {
  content?: string;
  files?: Array<{ attachment: Buffer | string; name?: string; description?: string }>;
  allowedMentions?: { parse?: string[]; users?: string[]; roles?: string[]; repliedUser?: boolean };
}
