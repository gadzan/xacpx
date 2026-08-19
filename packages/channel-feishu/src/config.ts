import { DEFAULT_FEISHU_TUNING, type FeishuTuning, resolveFeishuTuning } from "./tuning.js";

export type FeishuDmPolicy = "open" | "allowlist" | "disabled";
export type FeishuGroupPolicy = "open" | "allowlist" | "disabled";
export type FeishuReplyMode = "static" | "streaming" | "auto";

export interface FeishuAccountConfig {
  name?: string;
  enabled?: boolean;
  appId?: string;
  appSecret?: string;
  domain?: string;
  requireMention?: boolean;
  dmPolicy?: FeishuDmPolicy;
  groupPolicy?: FeishuGroupPolicy;
  allowFrom?: string[];
  replyMode?: FeishuReplyMode;
  /**
   * Opt-in: assert `isOwner` on group turns when the sender is the Feishu
   * chat owner (queried via GET /im/v1/chats). Only enable when you control
   * who can add this bot to groups - anyone who creates a group and adds the
   * bot becomes its owner, and owner-gated control commands run with the
   * operator's authority. Defaults to false.
   */
  trustGroupOwner?: boolean;
}

export interface FeishuResolvedAccountConfig {
  accountId: string;
  name?: string;
  enabled: boolean;
  configured: boolean;
  appId: string;
  appSecret: string;
  domain: string;
  requireMention: boolean;
  dmPolicy: FeishuDmPolicy;
  groupPolicy: FeishuGroupPolicy;
  allowFrom: string[];
  replyMode: FeishuReplyMode;
  trustGroupOwner: boolean;
}

export interface FeishuChannelConfig extends FeishuAccountConfig {
  defaultAccount: string;
  textMessageFormat: "text";
  dedupTtlMs: number;
  dedupMaxEntries: number;
  accounts: FeishuResolvedAccountConfig[];
  tuning: FeishuTuning;
}

const DEFAULT_FEISHU_DOMAIN = "feishu";
const DEFAULT_REQUIRE_MENTION = true;
const DEFAULT_FEISHU_DEDUP_TTL_MS = 12 * 60 * 60 * 1000;
const DEFAULT_FEISHU_DEDUP_MAX_ENTRIES = 5000;
const DEFAULT_ACCOUNT_ID = "default";

const BASE_RESERVED_KEYS = new Set([
  "accounts",
  "defaultAccount",
  "textMessageFormat",
  "dedupTtlMs",
  "dedupMaxEntries",
  "tuning",
]);

function parseTuning(raw: unknown): FeishuTuning {
  if (raw === undefined) return resolveFeishuTuning(undefined);
  if (!isRecord(raw)) throw new Error("channel.options.tuning must be an object");
  const partial: Partial<FeishuTuning> = {};
  for (const key of Object.keys(DEFAULT_FEISHU_TUNING) as Array<keyof FeishuTuning>) {
    if (!(key in raw)) continue;
    partial[key] = parsePositiveOptionalNumber(
      raw[key],
      `channel.options.tuning.${key}`,
      DEFAULT_FEISHU_TUNING[key],
    );
  }
  return resolveFeishuTuning(partial);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function stringOptional(raw: unknown, path: string): string | undefined {
  if (raw === undefined) return undefined;
  if (typeof raw !== "string") throw new Error(`${path} must be a string`);
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : undefined;
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

function resolveAccount(
  accountId: string,
  base: Record<string, unknown>,
  override: Record<string, unknown>,
  path: string,
): FeishuResolvedAccountConfig {
  const merged: Record<string, unknown> = { ...base, ...override };
  const enabled = booleanOptional(merged.enabled, `${path}.enabled`) ?? true;
  const appId = stringOptional(merged.appId, `${path}.appId`);
  const appSecret = stringOptional(merged.appSecret, `${path}.appSecret`);
  const configured = Boolean(appId && appSecret);
  const dmPolicy = enumValue<FeishuDmPolicy>(merged.dmPolicy, `${path}.dmPolicy`, ["open", "allowlist", "disabled"], "open");
  const groupPolicy = enumValue<FeishuGroupPolicy>(merged.groupPolicy, `${path}.groupPolicy`, ["open", "allowlist", "disabled"], "open");
  const allowFrom = stringArray(merged.allowFrom, `${path}.allowFrom`);
  if ((dmPolicy === "allowlist" || groupPolicy === "allowlist") && allowFrom.length === 0) {
    throw new Error(`${path}.allowFrom must list at least one open_id (or "*") when dmPolicy/groupPolicy is "allowlist"`);
  }
  const replyMode = enumValue<FeishuReplyMode>(merged.replyMode, `${path}.replyMode`, ["static", "streaming", "auto"], "auto");
  return {
    accountId,
    ...(stringOptional(merged.name, `${path}.name`) ? { name: stringOptional(merged.name, `${path}.name`)! } : {}),
    enabled,
    configured,
    appId: appId ?? "",
    appSecret: appSecret ?? "",
    domain: stringOptional(merged.domain, `${path}.domain`) ?? DEFAULT_FEISHU_DOMAIN,
    requireMention: booleanOptional(merged.requireMention, `${path}.requireMention`) ?? DEFAULT_REQUIRE_MENTION,
    dmPolicy,
    groupPolicy,
    allowFrom,
    replyMode,
    trustGroupOwner: booleanOptional(merged.trustGroupOwner, `${path}.trustGroupOwner`) ?? false,
  };
}

export function parseFeishuChannelConfig(raw: unknown): FeishuChannelConfig {
  if (!isRecord(raw)) {
    throw new Error("channel.options must be an object when channel.type is feishu");
  }
  if ("textMessageFormat" in raw && raw.textMessageFormat !== "text") {
    throw new Error("channel.options.textMessageFormat currently only supports \"text\"");
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

  const accounts: FeishuResolvedAccountConfig[] = [];
  if (accountsRaw) {
    for (const [accountId, value] of Object.entries(accountsRaw)) {
      if (!isRecord(value)) throw new Error(`channel.options.accounts.${accountId} must be an object`);
      accounts.push(resolveAccount(accountId, baseAccount, value, `channel.options.accounts.${accountId}`));
    }
  } else {
    accounts.push(resolveAccount(explicitDefaultAccount ?? DEFAULT_ACCOUNT_ID, baseAccount, {}, "channel.options"));
  }

  const enabledAccounts = accounts.filter((account) => account.enabled);
  const configuredAccounts = enabledAccounts.filter((account) => account.configured);
  if (configuredAccounts.length === 0) {
    throw new Error("channel.options.appId and channel.options.appSecret are required when channel.type is feishu");
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

  const baseAccountReturn: FeishuAccountConfig = {};
  if (typeof baseAccount.appId === "string") baseAccountReturn.appId = baseAccount.appId.trim();
  if (typeof baseAccount.appSecret === "string") baseAccountReturn.appSecret = baseAccount.appSecret;
  if (typeof baseAccount.domain === "string") baseAccountReturn.domain = baseAccount.domain.trim();
  if (typeof baseAccount.requireMention === "boolean") baseAccountReturn.requireMention = baseAccount.requireMention;
  if (typeof baseAccount.trustGroupOwner === "boolean") baseAccountReturn.trustGroupOwner = baseAccount.trustGroupOwner;

  return {
    ...baseAccountReturn,
    defaultAccount,
    textMessageFormat: "text" as const,
    dedupTtlMs: parsePositiveOptionalNumber(raw.dedupTtlMs, "channel.options.dedupTtlMs", DEFAULT_FEISHU_DEDUP_TTL_MS),
    dedupMaxEntries: parsePositiveOptionalNumber(raw.dedupMaxEntries, "channel.options.dedupMaxEntries", DEFAULT_FEISHU_DEDUP_MAX_ENTRIES),
    accounts,
    tuning: parseTuning(raw.tuning),
  };
}
