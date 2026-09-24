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
  /**
   * Card-action callback channel. Feishu delivers interactive-card events
   * (button clicks, form submits) as CALLBACKS, which the WebSocket long
   * connection cannot carry — it subscribes to events only. So this is a
   * separate, opt-in HTTP surface.
   *
   * `encryptKey` is what makes the callback authenticated: it is the new-protocol
   * signing secret, so it is the trust anchor the plugin's identity check needs.
   * The port is a required companion: an unauthenticated listener on a shared
   * host is worse than no listener at all.
   */
  cardActions?: FeishuCardActionConfig;
}

/**
 * Opt-in card-callback (webhook) listener for one account.
 *
 * `encryptKey` is REQUIRED. `verifyCardRequest` picks the signing secret by
 * protocol: a new-protocol callback (one carrying `encrypt` or `schema`) is
 * verified with SHA-256 over the encrypt key, and an empty key there is
 * `unauthorized`. Every button the renderer emits carries `schema: "2.0"`, so
 * every real click is new-protocol — a token-only config would start cleanly,
 * advertise form support, and then 401 on 100% of clicks. The token is a second
 * factor on the new-protocol push, not an alternative to the key.
 */
export interface FeishuCardActionConfig {
  /**
   * Decryption key for encrypted pushes; also the new-protocol signing secret.
   * Required, and never `""` on a config that came through `parseFeishuChannelConfig`:
   * parsing rejects a missing or blank key (see `parseCardActions`).
   */
  encryptKey: string;
  /**
   * Second factor only. Feishu echoes it on every callback and the host
   * cross-checks it when it is set. It is additionally REQUIRED for a legacy
   * (no `schema`, no `encrypt`) push, which no renderer button produces. An
   * operator who only runs modern cards may leave this unset, which parses to
   * `""` rather than to a missing field.
   */
  verificationToken: string;
  /** Loopback interface to bind. Defaults to 127.0.0.1 — a private surface. */
  host: string;
  port: number;
  /** Route path Feishu POSTs to, e.g. `/webhook/card`. */
  path: string;
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
  // Per-account by nature: each account owns its own listener port, so a shared
  // value would make multiple accounts fight over one socket.
  "cardActions",
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
  const cardActions = parseCardActions(merged.cardActions, `${path}.cardActions`);
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
    ...(cardActions ? { cardActions } : {}),
  };
}

const DEFAULT_CARD_ACTION_HOST = "127.0.0.1";
const DEFAULT_CARD_ACTION_PATH = "/webhook/card";

/**
 * Parse the opt-in card-callback listener.
 *
 * Absent config means "no card channel", which is the default and the safe
 * state: without it the Feishu plugin never receives card interactions and
 * never claims to support form Elicitation.
 *
 * A misconfigured listener is a hard error rather than a silently disabled one.
 * An operator who wrote `cardActions` clearly intends the channel to exist, and
 * an endpoint that never comes up (because, say, the port was a string) would
 * look exactly like "the feature does not work" at runtime.
 *
 * `encryptKey` is REQUIRED for the same reason, one layer up. It is the
 * new-protocol signing secret, and every button the renderer emits carries
 * `schema: "2.0"`, so a real click always lands in that branch. Accepting a
 * token-only config here would produce a channel that starts, advertises form
 * support, and 401s every single click. `verificationToken` stays OPTIONAL
 * because the host only needs it as a second factor on the new-protocol push.
 */
function parseCardActions(raw: unknown, path: string): FeishuCardActionConfig | undefined {
  if (raw === undefined) return undefined;
  if (raw === false) return undefined;
  if (!isRecord(raw)) throw new Error(`${path} must be an object`);
  const encryptKey = stringOptional(raw.encryptKey, `${path}.encryptKey`);
  if (encryptKey === undefined) {
    throw new Error(
      `${path}.encryptKey is required: without the new-protocol signing key every card action would be rejected with 401`,
    );
  }
  const verificationToken = stringOptional(raw.verificationToken, `${path}.verificationToken`);
  const port = raw.port;
  if (typeof port !== "number" || !Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`${path}.port must be an integer between 1 and 65535`);
  }
  const host = stringOptional(raw.host, `${path}.host`) ?? DEFAULT_CARD_ACTION_HOST;
  return {
    // No `?? ""` fallback: the required-key check above already narrowed this.
    encryptKey,
    verificationToken: verificationToken ?? "",
    host,
    port,
    path: stringOptional(raw.path, `${path}.path`) ?? DEFAULT_CARD_ACTION_PATH,
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
