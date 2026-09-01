import { DEFAULT_DISCORD_TUNING, type DiscordTuning, resolveDiscordTuning } from "./tuning.js";

export type DiscordDmPolicy = "open" | "allowlist" | "disabled";
export type DiscordGuildPolicy = "open" | "allowlist" | "disabled";
export type DiscordReplyMode = "static" | "streaming" | "auto";
export type DiscordTableMode = "code" | "bullets" | "off";

export interface DiscordChannelGuildChannelConfig {
  requireMention?: boolean;
}

export interface DiscordChannelGuildConfig {
  users?: string[];
  roles?: string[];
  channels?: Record<string, DiscordChannelGuildChannelConfig>;
}

export interface DiscordIntentsConfig {
  messageContent?: boolean;
  guildMembers?: boolean;
}

export interface DiscordMediaConfig {
  maxBytes?: number;
  maxAttachments?: number;
}

export interface DiscordAccountConfig {
  name?: string;
  enabled?: boolean;
  token?: string;
  applicationId?: string;
  enableAutocomplete?: boolean;
  replyMode?: DiscordReplyMode;
  tableMode?: DiscordTableMode;
  maxLinesPerMessage?: number;
  previewThrottleMs?: number;
  minInitialChars?: number;
  typingIndicator?: boolean;
  ackReaction?: string | null;
  requireMention?: boolean;
  dmPolicy?: DiscordDmPolicy;
  guildPolicy?: DiscordGuildPolicy;
  allowFrom?: string[];
  guilds?: Record<string, DiscordChannelGuildConfig>;
  allowBots?: boolean;
  dedupTtlMs?: number;
  dedupMaxEntries?: number;
  inboundExpiryMs?: number;
  intents?: DiscordIntentsConfig;
  media?: DiscordMediaConfig;
}

export interface DiscordResolvedIntentsConfig {
  messageContent: boolean;
  guildMembers: boolean;
}

export interface DiscordResolvedMediaConfig {
  maxBytes: number;
  maxAttachments: number;
}
export interface DiscordResolvedAccountConfig {
  accountId: string;
  name?: string;
  enabled: boolean;
  configured: boolean;
  token: string;
  applicationId: string;
  enableAutocomplete: boolean;
  replyMode: DiscordReplyMode;
  tableMode: DiscordTableMode;
  maxLinesPerMessage: number;
  previewThrottleMs: number;
  minInitialChars: number;
  typingIndicator: boolean;
  ackReaction: string | null;
  requireMention: boolean;
  dmPolicy: DiscordDmPolicy;
  guildPolicy: DiscordGuildPolicy;
  allowFrom: string[];
  guilds: Record<string, DiscordChannelGuildConfig>;
  allowBots: boolean;
  dedupTtlMs: number;
  dedupMaxEntries: number;
  inboundExpiryMs: number;
  intents: DiscordResolvedIntentsConfig;
  media: DiscordResolvedMediaConfig;
}

export interface DiscordChannelConfig extends DiscordAccountConfig {
  defaultAccount: string;
  dedupTtlMs: number;
  dedupMaxEntries: number;
  inboundExpiryMs: number;
  accounts: DiscordResolvedAccountConfig[];
  tuning: DiscordTuning;
}

const DEFAULT_REPLY_MODE: DiscordReplyMode = "auto";
const DEFAULT_TABLE_MODE: DiscordTableMode = "code";
const DEFAULT_MAX_LINES_PER_MESSAGE = 17;
const DEFAULT_PREVIEW_THROTTLE_MS = 1200;
const DEFAULT_MIN_INITIAL_CHARS = 20;
const DEFAULT_TYPING_INDICATOR = true;
const DEFAULT_ACK_REACTION: string | null = null;
const DEFAULT_REQUIRE_MENTION = true;
const DEFAULT_DM_POLICY: DiscordDmPolicy = "allowlist";
const DEFAULT_GUILD_POLICY: DiscordGuildPolicy = "allowlist";
const DEFAULT_ALLOW_BOTS = false;
const DEFAULT_DEDUP_TTL_MS = 24 * 60 * 60 * 1000;
const DEFAULT_DEDUP_MAX_ENTRIES = 10000;
const DEFAULT_INBOUND_EXPIRY_MS = 5 * 60 * 1000;
const DEFAULT_ACCOUNT_ID = "default";
const DEFAULT_MEDIA_MAX_BYTES = 8 * 1024 * 1024;
const DEFAULT_MEDIA_MAX_ATTACHMENTS = 10;

const BASE_RESERVED_KEYS = new Set([
  "accounts",
  "defaultAccount",
  "tuning",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function stringOptional(raw: unknown, path: string): string | undefined {
  if (raw === undefined) return undefined;
  if (typeof raw !== "string") throw new Error(`${path} must be a string`);
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function stringOrNullOptional(raw: unknown, path: string): string | null | undefined {
  if (raw === undefined) return undefined;
  if (raw === null) return null;
  if (typeof raw !== "string") throw new Error(`${path} must be a string or null`);
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function booleanOptional(raw: unknown, path: string): boolean | undefined {
  if (raw === undefined) return undefined;
  if (typeof raw !== "boolean") throw new Error(`${path} must be a boolean`);
  return raw;
}

function enumValue<T extends string>(raw: unknown, path: string, allowed: readonly T[], fallback: T): T {
  if (raw === undefined) return fallback;
  if (typeof raw !== "string" || !allowed.includes(raw as T)) {
    throw new Error(`${path} must be one of: ${allowed.join(", ")}`);
  }
  return raw as T;
}

function stringArray(raw: unknown, path: string): string[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw) || raw.some((item) => typeof item !== "string")) {
    throw new Error(`${path} must be an array of strings`);
  }
  return raw.map((item) => item.trim()).filter(Boolean);
}

function parsePositiveOptionalNumber(value: unknown, path: string, defaultValue: number): number {
  if (value === undefined) return defaultValue;
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    throw new Error(`${path} must be a positive number`);
  }
  return value;
}

function parseIntents(raw: unknown, path: string): DiscordResolvedIntentsConfig {
  if (raw === undefined) return { messageContent: true, guildMembers: false };
  if (!isRecord(raw)) throw new Error(`${path} must be an object`);
  const messageContent = booleanOptional(raw.messageContent, `${path}.messageContent`) ?? true;
  const guildMembers = booleanOptional(raw.guildMembers, `${path}.guildMembers`) ?? false;
  return { messageContent, guildMembers };
}

function parseMedia(raw: unknown, path: string): DiscordResolvedMediaConfig {
  if (raw === undefined) return { maxBytes: DEFAULT_MEDIA_MAX_BYTES, maxAttachments: DEFAULT_MEDIA_MAX_ATTACHMENTS };
  if (!isRecord(raw)) throw new Error(`${path} must be an object`);
  const maxBytes = parsePositiveOptionalNumber(raw.maxBytes, `${path}.maxBytes`, DEFAULT_MEDIA_MAX_BYTES);
  const maxAttachments = parsePositiveOptionalNumber(raw.maxAttachments, `${path}.maxAttachments`, DEFAULT_MEDIA_MAX_ATTACHMENTS);
  return { maxBytes, maxAttachments };
}

/**
 * Account ids are embedded in every chatKey ("discord:<accountId>:<kind>:<channelId>")
 * and chatKeys are parsed back by splitting on ":". An id containing the
 * delimiter therefore round-trips into a different (accountId, kind, channelId)
 * triple, which would misroute replies to another account or chat type.
 * Anything the chatKey grammar can express is accepted, so only the delimiter
 * and the empty id are rejected.
 */
function assertValidAccountId(accountId: string, path: string): void {
  if (!accountId) throw new Error(`${path}: account id must not be empty`);
  if (accountId.includes(":")) {
    throw new Error(
      `${path}: account id must not contain ":" because it is the chatKey separator (discord:<accountId>:<kind>:<channelId>)`,
    );
  }
}

function parseGuilds(raw: unknown, path: string): Record<string, DiscordChannelGuildConfig> {
  if (raw === undefined) return {};
  if (!isRecord(raw)) throw new Error(`${path} must be an object`);
  const out: Record<string, DiscordChannelGuildConfig> = {};
  for (const [guildId, value] of Object.entries(raw)) {
    if (!isRecord(value)) throw new Error(`${path}.${guildId} must be an object`);
    const users = stringArray(value.users, `${path}.${guildId}.users`);
    const roles = stringArray(value.roles, `${path}.${guildId}.roles`);
    let channels: Record<string, DiscordChannelGuildChannelConfig> | undefined;
    if (value.channels !== undefined) {
      if (!isRecord(value.channels)) throw new Error(`${path}.${guildId}.channels must be an object`);
      channels = {};
      for (const [channelId, chVal] of Object.entries(value.channels)) {
        if (!isRecord(chVal)) throw new Error(`${path}.${guildId}.channels.${channelId} must be an object`);
        const requireMention = booleanOptional(chVal.requireMention, `${path}.${guildId}.channels.${channelId}.requireMention`);
        channels[channelId] = {};
        if (requireMention !== undefined) channels[channelId].requireMention = requireMention;
      }
    }
    out[guildId] = {};
    if (users.length > 0) out[guildId].users = users;
    if (roles.length > 0) out[guildId].roles = roles;
    if (channels) out[guildId].channels = channels;
  }
  return out;
}

function parseTuning(raw: unknown): DiscordTuning {
  if (raw === undefined) return resolveDiscordTuning(undefined);
  if (!isRecord(raw)) throw new Error("channel.options.tuning must be an object");
  const partial: Partial<DiscordTuning> = {};
  for (const key of Object.keys(DEFAULT_DISCORD_TUNING) as Array<keyof DiscordTuning>) {
    if (!(key in raw)) continue;
    partial[key] = parsePositiveOptionalNumber(
      raw[key],
      `channel.options.tuning.${key}`,
      DEFAULT_DISCORD_TUNING[key],
    );
  }
  return resolveDiscordTuning(partial);
}

function resolveAccount(
  accountId: string,
  base: Record<string, unknown>,
  override: Record<string, unknown>,
  path: string,
): DiscordResolvedAccountConfig {
  const merged: Record<string, unknown> = { ...base, ...override };
  const enabled = booleanOptional(merged.enabled, `${path}.enabled`) ?? true;
  const token = stringOptional(merged.token, `${path}.token`);
  const applicationId = stringOptional(merged.applicationId, `${path}.applicationId`) ?? "";
  const enableAutocompleteRaw = booleanOptional(merged.enableAutocomplete, `${path}.enableAutocomplete`);
  const enableAutocomplete = enableAutocompleteRaw ?? Boolean(applicationId);
  const configured = Boolean(token && token.length > 0);
  const replyMode = enumValue<DiscordReplyMode>(merged.replyMode, `${path}.replyMode`, ["static", "streaming", "auto"], DEFAULT_REPLY_MODE);
  const tableMode = enumValue<DiscordTableMode>(merged.tableMode, `${path}.tableMode`, ["code", "bullets", "off"], DEFAULT_TABLE_MODE);
  const maxLinesPerMessage = parsePositiveOptionalNumber(merged.maxLinesPerMessage, `${path}.maxLinesPerMessage`, DEFAULT_MAX_LINES_PER_MESSAGE);
  const previewThrottleMs = parsePositiveOptionalNumber(merged.previewThrottleMs, `${path}.previewThrottleMs`, DEFAULT_PREVIEW_THROTTLE_MS);
  const minInitialChars = parsePositiveOptionalNumber(merged.minInitialChars, `${path}.minInitialChars`, DEFAULT_MIN_INITIAL_CHARS);
  const typingIndicator = booleanOptional(merged.typingIndicator, `${path}.typingIndicator`) ?? DEFAULT_TYPING_INDICATOR;
  const ackReactionRaw = stringOrNullOptional(merged.ackReaction, `${path}.ackReaction`);
  const ackReaction = ackReactionRaw === undefined ? DEFAULT_ACK_REACTION : ackReactionRaw;
  const requireMention = booleanOptional(merged.requireMention, `${path}.requireMention`) ?? DEFAULT_REQUIRE_MENTION;
  const dmPolicy = enumValue<DiscordDmPolicy>(merged.dmPolicy, `${path}.dmPolicy`, ["open", "allowlist", "disabled"], DEFAULT_DM_POLICY);
  const guildPolicy = enumValue<DiscordGuildPolicy>(merged.guildPolicy, `${path}.guildPolicy`, ["open", "allowlist", "disabled"], DEFAULT_GUILD_POLICY);
  const allowFrom = stringArray(merged.allowFrom, `${path}.allowFrom`);
  const guilds = parseGuilds(merged.guilds, `${path}.guilds`);
  const allowBots = booleanOptional(merged.allowBots, `${path}.allowBots`) ?? DEFAULT_ALLOW_BOTS;
  const dedupTtlMs = parsePositiveOptionalNumber(merged.dedupTtlMs, `${path}.dedupTtlMs`, DEFAULT_DEDUP_TTL_MS);
  const dedupMaxEntries = parsePositiveOptionalNumber(merged.dedupMaxEntries, `${path}.dedupMaxEntries`, DEFAULT_DEDUP_MAX_ENTRIES);
  const inboundExpiryMs = parsePositiveOptionalNumber(merged.inboundExpiryMs, `${path}.inboundExpiryMs`, DEFAULT_INBOUND_EXPIRY_MS);
  const intents = parseIntents(merged.intents, `${path}.intents`);
  const media = parseMedia(merged.media, `${path}.media`);

  return {
    accountId,
    ...(stringOptional(merged.name, `${path}.name`) ? { name: stringOptional(merged.name, `${path}.name`)! } : {}),
    enabled,
    configured,
    token: token ?? "",
    applicationId,
    enableAutocomplete,
    replyMode,
    tableMode,
    maxLinesPerMessage,
    previewThrottleMs,
    minInitialChars,
    typingIndicator,
    ackReaction,
    requireMention,
    dmPolicy,
    guildPolicy,
    allowFrom,
    guilds,
    allowBots,
    dedupTtlMs,
    dedupMaxEntries,
    inboundExpiryMs,
    intents,
    media,
  };
}

export function parseDiscordChannelConfig(raw: unknown): DiscordChannelConfig {
  if (!isRecord(raw)) {
    throw new Error("channel.options must be an object when channel.type is discord");
  }

  const explicitDefaultAccount = stringOptional(raw.defaultAccount, "channel.options.defaultAccount");
  const accountsRaw = isRecord(raw.accounts) ? raw.accounts : undefined;
  if ("accounts" in raw && raw.accounts !== undefined && !accountsRaw) {
    throw new Error("channel.options.accounts must be an object");
  }

  const baseAccount: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (!BASE_RESERVED_KEYS.has(key)) baseAccount[key] = value;
  }

  const accounts: DiscordResolvedAccountConfig[] = [];
  if (accountsRaw) {
    for (const [accountId, value] of Object.entries(accountsRaw)) {
      if (!isRecord(value)) throw new Error(`channel.options.accounts.${accountId} must be an object`);
      assertValidAccountId(accountId, `channel.options.accounts.${accountId}`);
      accounts.push(resolveAccount(accountId, baseAccount, value, `channel.options.accounts.${accountId}`));
    }
  } else {
    if (explicitDefaultAccount !== undefined) {
      assertValidAccountId(explicitDefaultAccount, "channel.options.defaultAccount");
    }
    accounts.push(resolveAccount(explicitDefaultAccount ?? DEFAULT_ACCOUNT_ID, baseAccount, {}, "channel.options"));
  }

  const enabledAccounts = accounts.filter((account) => account.enabled);
  const configuredAccounts = enabledAccounts.filter((account) => account.configured);
  if (configuredAccounts.length === 0) {
    throw new Error("channel.options.token is required when channel.type is discord");
  }

  // Intra-process uniqueness: each enabled account must own a distinct bot
  // token. Discord allows one Gateway session per token, and two accounts
  // sharing a token have no coherent semantics (the single Gateway client
  // could not honor two different access policies / requireMention / reply
  // modes). createConsumerLock()'s per-token lock files guard the
  // cross-process half; this check guards the same-process half. Disabled
  // accounts may share tokens freely. The message names accountIds only —
  // never the token or a fingerprint of it.
  const tokenOwners = new Map<string, string>();
  for (const account of configuredAccounts) {
    const owner = tokenOwners.get(account.token);
    if (owner) {
      throw new Error(
        `channel.options.accounts.${account.accountId} duplicates the bot token of account "${owner}"; each enabled account must use a unique token`,
      );
    }
    tokenOwners.set(account.token, account.accountId);
  }

  const accountIds = new Set<string>();
  for (const account of accounts) {
    if (accountIds.has(account.accountId)) {
      throw new Error(`channel.options.accounts.${account.accountId} duplicates an earlier account id`);
    }
    accountIds.add(account.accountId);
  }

  const defaultAccount = explicitDefaultAccount ?? (accountIds.has(DEFAULT_ACCOUNT_ID) ? DEFAULT_ACCOUNT_ID : accounts[0]!.accountId);
  if (!accountIds.has(defaultAccount)) {
    throw new Error(`channel.options.defaultAccount "${defaultAccount}" does not match any configured account`);
  }

  const baseAccountReturn: DiscordAccountConfig = {};
  if (typeof baseAccount.token === "string") baseAccountReturn.token = baseAccount.token.trim();
  if (typeof baseAccount.applicationId === "string") baseAccountReturn.applicationId = baseAccount.applicationId.trim();
  if (typeof baseAccount.replyMode === "string") baseAccountReturn.replyMode = baseAccount.replyMode as DiscordReplyMode;
  if (typeof baseAccount.tableMode === "string") baseAccountReturn.tableMode = baseAccount.tableMode as DiscordTableMode;
  if (typeof baseAccount.requireMention === "boolean") baseAccountReturn.requireMention = baseAccount.requireMention;

  return {
    ...baseAccountReturn,
    defaultAccount,
    dedupTtlMs: parsePositiveOptionalNumber(raw.dedupTtlMs, "channel.options.dedupTtlMs", DEFAULT_DEDUP_TTL_MS),
    dedupMaxEntries: parsePositiveOptionalNumber(raw.dedupMaxEntries, "channel.options.dedupMaxEntries", DEFAULT_DEDUP_MAX_ENTRIES),
    inboundExpiryMs: parsePositiveOptionalNumber(raw.inboundExpiryMs, "channel.options.inboundExpiryMs", DEFAULT_INBOUND_EXPIRY_MS),
    accounts,
    tuning: parseTuning(raw.tuning),
  };
}
