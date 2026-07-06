import fs from "node:fs";
import path from "node:path";

import { ensureDirSync } from "../storage/ensure-dir.js";
import { resolveStateDir } from "../storage/state-dir.js";
import { writePrivateFileSync } from "../../util/private-file.js";
import { sanitizeString } from "../../util/sanitize.js";

export const DEFAULT_BASE_URL = "https://ilinkai.weixin.qq.com";
export const CDN_BASE_URL = "https://novac2c.cdn.weixin.qq.com/c2c";

export function normalizeAccountId(raw: string): string {
  return sanitizeString(raw.trim(), {
    deny: /[@.]/g,
    replacement: "-",
    lowercase: true,
  });
}


// ---------------------------------------------------------------------------
// Account ID compatibility (legacy raw ID → normalized ID)
// ---------------------------------------------------------------------------

/**
 * Pattern-based reverse of normalizeWeixinAccountId for known weixin ID suffixes.
 * Used only as a compatibility fallback when loading accounts / sync bufs stored
 * under the old raw ID.
 * e.g. "b0f5860fdecb-im-bot" → "b0f5860fdecb@im.bot"
 */
export function deriveRawAccountId(normalizedId: string): string | undefined {
  if (normalizedId.endsWith("-im-bot")) {
    return `${normalizedId.slice(0, -7)}@im.bot`;
  }
  if (normalizedId.endsWith("-im-wechat")) {
    return `${normalizedId.slice(0, -10)}@im.wechat`;
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Account index (persistent list of registered account IDs)
// ---------------------------------------------------------------------------

function resolveWeixinStateDir(): string {
  return path.join(resolveStateDir(), "openclaw-weixin");
}

function resolveAccountIndexPath(): string {
  return path.join(resolveWeixinStateDir(), "accounts.json");
}


function listAccountFileIds(): string[] {
  const dir = resolveAccountsDir();
  try {
    if (!fs.existsSync(dir)) return [];
    return fs.readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
      .map((entry) => ({
        id: entry.name.slice(0, -5),
        data: readAccountFile(path.join(dir, entry.name)),
      }))
      .filter((entry) => entry.id.trim() !== "" && Boolean(entry.data?.token?.trim()))
      .map((entry) => entry.id)
      .sort();
  } catch {
    return [];
  }
}

function uniqueAccountIds(ids: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const raw of ids) {
    const id = raw.trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    result.push(id);
  }
  return result;
}

/** Returns all accountIds registered via QR login. */
export function listIndexedWeixinAccountIds(): string[] {
  const filePath = resolveAccountIndexPath();
  try {
    if (!fs.existsSync(filePath)) return [];
    const raw = fs.readFileSync(filePath, "utf-8");
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return uniqueAccountIds(parsed.filter((id): id is string => typeof id === "string" && id.trim() !== ""));
  } catch {
    return [];
  }
}

/** Register accountId as the sole account in the persistent index. */
export function registerWeixinAccountId(accountId: string): void {
  const dir = resolveWeixinStateDir();
  ensureDirSync(dir);

  fs.writeFileSync(resolveAccountIndexPath(), JSON.stringify([accountId], null, 2), "utf-8");
}

// ---------------------------------------------------------------------------
// Account store (per-account credential files)
// ---------------------------------------------------------------------------

/** Unified per-account data: token + baseUrl in one file. */
export type WeixinAccountData = {
  token?: string;
  savedAt?: string;
  baseUrl?: string;
  /** Last linked Weixin user id from QR login (optional). */
  userId?: string;
};

function resolveAccountsDir(): string {
  return path.join(resolveWeixinStateDir(), "accounts");
}

function resolveAccountPath(accountId: string): string {
  return path.join(resolveAccountsDir(), `${accountId}.json`);
}

/**
 * Legacy single-file token: `credentials/openclaw-weixin/credentials.json` (pre per-account files).
 */
function loadLegacyToken(): string | undefined {
  const legacyPath = path.join(resolveStateDir(), "credentials", "openclaw-weixin", "credentials.json");
  try {
    if (!fs.existsSync(legacyPath)) return undefined;
    const raw = fs.readFileSync(legacyPath, "utf-8");
    const parsed = JSON.parse(raw) as { token?: string };
    return typeof parsed.token === "string" ? parsed.token : undefined;
  } catch {
    return undefined;
  }
}

function readAccountFile(filePath: string): WeixinAccountData | null {
  try {
    if (fs.existsSync(filePath)) {
      return JSON.parse(fs.readFileSync(filePath, "utf-8")) as WeixinAccountData;
    }
  } catch {
    // ignore
  }
  return null;
}

/** Load account data by ID, with compatibility fallbacks. */
export function loadWeixinAccount(accountId: string): WeixinAccountData | null {
  // Primary: try given accountId (normalized IDs written after this change).
  const primary = readAccountFile(resolveAccountPath(accountId));
  if (primary) return primary;

  // Compatibility: if the given ID is normalized, derive the old raw filename
  // (e.g. "b0f5860fdecb-im-bot" → "b0f5860fdecb@im.bot") for existing installs.
  const rawId = deriveRawAccountId(accountId);
  if (rawId) {
    const compat = readAccountFile(resolveAccountPath(rawId));
    if (compat) return compat;
  }

  // Legacy fallback: read token from old single-account credentials file.
  const token = loadLegacyToken();
  if (token) return { token };

  return null;
}

/**
 * Persist account data after QR login (merges into existing file).
 * - token: overwritten when provided.
 * - baseUrl: stored when non-empty; resolveWeixinAccount falls back to DEFAULT_BASE_URL.
 * - userId: set when `update.userId` is provided; omitted from file when cleared to empty.
 */
export function saveWeixinAccount(
  accountId: string,
  update: { token?: string; baseUrl?: string; userId?: string },
): void {
  const existing = loadWeixinAccount(accountId) ?? {};

  const token = update.token?.trim() || existing.token;
  const baseUrl = update.baseUrl?.trim() || existing.baseUrl;
  const userId =
    update.userId !== undefined
      ? update.userId.trim() || undefined
      : existing.userId?.trim() || undefined;

  const data: WeixinAccountData = {
    ...(token ? { token, savedAt: new Date().toISOString() } : {}),
    ...(baseUrl ? { baseUrl } : {}),
    ...(userId ? { userId } : {}),
  };

  writePrivateFileSync(resolveAccountPath(accountId), JSON.stringify(data, null, 2));
}

/** Remove account data file. */
export function clearWeixinAccount(accountId: string): void {
  try {
    fs.unlinkSync(resolveAccountPath(accountId));
  } catch {
    // ignore if not found
  }
}

/** Remove all account data files and clear the account index. */
export function clearAllWeixinAccounts(): void {
  const ids = uniqueAccountIds([
    ...listIndexedWeixinAccountIds(),
    ...listAccountFileIds(),
  ]);
  for (const id of ids) {
    clearWeixinAccount(id);
  }
  try {
    fs.writeFileSync(resolveAccountIndexPath(), "[]", "utf-8");
  } catch {
    // ignore
  }
}

/**
 * Resolve the openclaw.json config file path.
 * Checks OPENCLAW_CONFIG env var, then state dir.
 */
function resolveConfigPath(): string {
  const envPath = process.env.OPENCLAW_CONFIG?.trim();
  if (envPath) return envPath;
  return path.join(resolveStateDir(), "openclaw.json");
}

/**
 * Read `routeTag` from openclaw.json (for callers without an `OpenClawConfig` object).
 * Checks per-account `channels.<id>.accounts[accountId].routeTag` first, then section-level
 * `channels.<id>.routeTag`. Matches `feat_weixin_extension` behavior; channel key is `"openclaw-weixin"`.
 */
export function loadConfigRouteTag(accountId?: string): string | undefined {
  try {
    const configPath = resolveConfigPath();
    if (!fs.existsSync(configPath)) return undefined;
    const raw = fs.readFileSync(configPath, "utf-8");
    const cfg = JSON.parse(raw) as Record<string, unknown>;
    const channels = cfg.channels as Record<string, unknown> | undefined;
    const section = channels?.["openclaw-weixin"] as Record<string, unknown> | undefined;
    if (!section) return undefined;
    if (accountId) {
      const accounts = section.accounts as Record<string, Record<string, unknown>> | undefined;
      const tag = accounts?.[accountId]?.routeTag;
      if (typeof tag === "number") return String(tag);
      if (typeof tag === "string" && tag.trim()) return tag.trim();
    }
    if (typeof section.routeTag === "number") return String(section.routeTag);
    return typeof section.routeTag === "string" && section.routeTag.trim()
      ? section.routeTag.trim()
      : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Read `botAgent` from openclaw.json (for callers without an `OpenClawConfig` object).
 * Checks per-account `channels.<id>.accounts[accountId].botAgent` first, then section-level
 * `channels.<id>.botAgent`. Channel key is `"openclaw-weixin"`. Caller is responsible for
 * sanitization (see `sanitizeBotAgent`).
 */
export function loadConfigBotAgent(accountId?: string): string | undefined {
  try {
    const configPath = resolveConfigPath();
    if (!fs.existsSync(configPath)) return undefined;
    const raw = fs.readFileSync(configPath, "utf-8");
    const cfg = JSON.parse(raw) as Record<string, unknown>;
    const channels = cfg.channels as Record<string, unknown> | undefined;
    const section = channels?.["openclaw-weixin"] as Record<string, unknown> | undefined;
    if (!section) return undefined;
    if (accountId) {
      const accounts = section.accounts as Record<string, Record<string, unknown>> | undefined;
      const agent = accounts?.[accountId]?.botAgent;
      if (typeof agent === "string" && agent.trim()) return agent.trim();
    }
    return typeof section.botAgent === "string" && section.botAgent.trim()
      ? section.botAgent.trim()
      : undefined;
  } catch {
    return undefined;
  }
}

/**
 * No-op stub — config reload is now handled externally via `openclaw gateway restart`.
 */
export async function triggerWeixinChannelReload(): Promise<void> {}

// ---------------------------------------------------------------------------
// Account resolution (merge config + stored credentials)
// ---------------------------------------------------------------------------

export type ResolvedWeixinAccount = {
  accountId: string;
  baseUrl: string;
  cdnBaseUrl: string;
  token?: string;
  enabled: boolean;
  /** true when a token has been obtained via QR login. */
  configured: boolean;
};

/** List accountIds from the index file (written at QR login), with a credential-file fallback for legacy/broken indexes. */
export function listWeixinAccountIds(): string[] {
  const indexed = listIndexedWeixinAccountIds();
  if (indexed.length > 0) return indexed;
  return listAccountFileIds();
}

/** Resolve a weixin account by ID, reading stored credentials. */
export function resolveWeixinAccount(accountId?: string | null): ResolvedWeixinAccount {
  const raw = accountId?.trim();
  if (!raw) {
    throw new Error("weixin: accountId is required (no default account)");
  }
  const id = normalizeAccountId(raw);

  const accountData = loadWeixinAccount(id);
  const token = accountData?.token?.trim() || undefined;
  const stateBaseUrl = accountData?.baseUrl?.trim() || "";

  return {
    accountId: id,
    baseUrl: stateBaseUrl || DEFAULT_BASE_URL,
    cdnBaseUrl: CDN_BASE_URL,
    token,
    enabled: true,
    configured: Boolean(token),
  };
}
