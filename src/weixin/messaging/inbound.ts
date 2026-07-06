import fs from "node:fs";
import path from "node:path";
import { t } from "../../i18n/index.js";

import type { ChannelMediaKind } from "../../channels/media-types.js";
import { weixinLog } from "../util/weixin-log";
import { generateId } from "../util/random.js";
import type { WeixinMessage, MessageItem } from "../api/types.js";
import { MessageItemType } from "../api/types.js";
import { resolveStateDir } from "../storage/state-dir.js";
import { writePrivateFileSync } from "../../util/private-file.js";

// ---------------------------------------------------------------------------
// Context token store (in-memory cache + per-account disk persistence)
// ---------------------------------------------------------------------------

/**
 * contextToken is issued per-message by the Weixin getupdates API and must be
 * echoed verbatim in every outbound send. The in-memory map is the hot path;
 * every write is mirrored to
 *   <stateDir>/openclaw-weixin/accounts/<accountId>.context-tokens.json
 * so daemon restarts can recover existing user→token associations and the
 * first reply after restart does not fail with "contextToken is required".
 */
interface ContextTokenEntry {
  token: string;
  updatedAt: number;
}

interface ContextTokenRetentionOptions {
  maxTokensPerAccount?: number;
  tokenTtlMs?: number;
  now?: () => number;
}

const DEFAULT_CONTEXT_TOKEN_MAX_PER_ACCOUNT = 5000;
const DEFAULT_CONTEXT_TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000;

const contextTokenStore = new Map<string, ContextTokenEntry>();
let contextTokenRetention = normalizeContextTokenRetention();

function contextTokenKey(accountId: string, userId: string): string {
  return `${accountId}:${userId}`;
}

function resolveContextTokenFilePath(accountId: string): string {
  return path.join(
    resolveStateDir(),
    "openclaw-weixin",
    "accounts",
    `${accountId}.context-tokens.json`,
  );
}

export function configureContextTokenRetentionForTests(options: ContextTokenRetentionOptions = {}): void {
  contextTokenRetention = normalizeContextTokenRetention(options);
}

function persistContextTokens(accountId: string): void {
  pruneContextTokensForAccount(accountId);
  const prefix = `${accountId}:`;
  const tokens: Record<string, { token: string; updatedAt: number }> = {};
  for (const [k, entry] of contextTokenStore) {
    if (k.startsWith(prefix)) {
      tokens[k.slice(prefix.length)] = { token: entry.token, updatedAt: entry.updatedAt };
    }
  }
  const filePath = resolveContextTokenFilePath(accountId);
  try {
    writePrivateFileSync(filePath, JSON.stringify(tokens));
  } catch (err) {
    weixinLog.error("weixin.message.context_token_persist_failed", "persistContextTokens: failed to write", {
      filePath,
      error: String(err),
    });
  }
}

/**
 * Restore the per-account context-token cache from disk into memory.
 * Called at bot startup (after login). Missing/unreadable files are tolerated
 * silently; corrupt JSON is logged at warn level and ignored.
 */
export function restoreContextTokens(accountId: string): void {
  const filePath = resolveContextTokenFilePath(accountId);
  try {
    if (!fs.existsSync(filePath)) return;
    const raw = fs.readFileSync(filePath, "utf-8");
    const tokens = JSON.parse(raw) as Record<string, unknown>;
    let count = 0;
    for (const [userId, value] of Object.entries(tokens)) {
      const entry = parsePersistedContextToken(value);
      if (entry) {
        contextTokenStore.set(contextTokenKey(accountId, userId), entry);
        count++;
      }
    }
    pruneContextTokensForAccount(accountId);
    persistContextTokens(accountId);
    weixinLog.info("weixin.message.context_token_restored", "restoreContextTokens: restored tokens", {
      accountId,
      count,
    });
  } catch (err) {
    weixinLog.error("weixin.message.context_token_restore_failed", "restoreContextTokens: failed to read", {
      filePath,
      error: String(err),
    });
  }
}

/**
 * Drop all tokens for an account from both the in-memory cache and disk.
 * Called on logout so the next login does not see stale associations.
 */
export function clearContextTokensForAccount(accountId: string): void {
  const prefix = `${accountId}:`;
  for (const k of [...contextTokenStore.keys()]) {
    if (k.startsWith(prefix)) contextTokenStore.delete(k);
  }
  const filePath = resolveContextTokenFilePath(accountId);
  try {
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
  } catch (err) {
    weixinLog.error("weixin.message.context_token_clear_failed", "clearContextTokensForAccount: failed to remove", {
      filePath,
      error: String(err),
    });
  }
  weixinLog.info("weixin.message.context_token_cleared", "clearContextTokensForAccount: cleared tokens", {
    accountId,
  });
}

/** Store a context token for a given account+user pair (memory + disk). */
export function setContextToken(accountId: string, userId: string, token: string): void {
  const k = contextTokenKey(accountId, userId);
  weixinLog.debug("weixin.message.context_token_set", "setContextToken", { accountId, userId });
  contextTokenStore.set(k, { token, updatedAt: contextTokenRetention.now() });
  persistContextTokens(accountId);
}

/** Retrieve the cached context token for a given account+user pair. */
export function getContextToken(accountId: string, userId: string): string | undefined {
  const normalizedUserId = normalizeWeixinUserIdFromChatKey(userId);
  const k = contextTokenKey(accountId, normalizedUserId);
  pruneContextTokensForAccount(accountId);
  const val = contextTokenStore.get(k)?.token;
  weixinLog.debug("weixin.message.context_token_lookup", "getContextToken", {
    accountId,
    userId: normalizedUserId,
    found: val !== undefined,
    storeSize: contextTokenStore.size,
  });
  return val;
}

/**
 * Of the given candidate accountIds, return those that have an active
 * context-token cached for the given user. `userId` may be a raw user id
 * or a `weixin:<accountId>:<userId>` chat-key — both forms resolve.
 */
export function findAccountIdsByContextToken(
  accountIds: string[],
  userId: string,
): string[] {
  const u = normalizeWeixinUserIdFromChatKey(userId);
  for (const accountId of accountIds) {
    pruneContextTokensForAccount(accountId);
  }
  return accountIds.filter((id) => contextTokenStore.has(contextTokenKey(id, u)));
}

function parsePersistedContextToken(value: unknown): ContextTokenEntry | null {
  if (typeof value === "string" && value) {
    return { token: value, updatedAt: contextTokenRetention.now() };
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const record = value as Record<string, unknown>;
  if (typeof record.token !== "string" || record.token.length === 0) {
    return null;
  }
  const updatedAt = typeof record.updatedAt === "number" && Number.isFinite(record.updatedAt)
    ? record.updatedAt
    : contextTokenRetention.now();
  return { token: record.token, updatedAt };
}

function pruneContextTokensForAccount(accountId: string): void {
  const prefix = `${accountId}:`;
  const now = contextTokenRetention.now();
  const entries = [...contextTokenStore.entries()].filter(([key]) => key.startsWith(prefix));
  for (const [key, entry] of entries) {
    if (now - entry.updatedAt > contextTokenRetention.tokenTtlMs) {
      contextTokenStore.delete(key);
    }
  }
  const freshEntries = [...contextTokenStore.entries()]
    .filter(([key]) => key.startsWith(prefix))
    .sort((a, b) => a[1].updatedAt - b[1].updatedAt);
  const excess = freshEntries.length - contextTokenRetention.maxTokensPerAccount;
  for (let i = 0; i < excess; i++) {
    const key = freshEntries[i]?.[0];
    if (key) contextTokenStore.delete(key);
  }
}

function normalizeContextTokenRetention(options: ContextTokenRetentionOptions = {}): Required<ContextTokenRetentionOptions> {
  return {
    maxTokensPerAccount: normalizePositiveInt(
      options.maxTokensPerAccount,
      DEFAULT_CONTEXT_TOKEN_MAX_PER_ACCOUNT,
    ),
    tokenTtlMs: normalizeNonNegativeMs(options.tokenTtlMs, DEFAULT_CONTEXT_TOKEN_TTL_MS),
    now: options.now ?? (() => Date.now()),
  };
}

function normalizePositiveInt(value: number | undefined, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 1) return fallback;
  return Math.floor(value);
}

function normalizeNonNegativeMs(value: number | undefined, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return fallback;
  return value;
}

/** Strip the `weixin:accountId:` prefix from a chat key, returning the bare user id. */
export function normalizeWeixinUserIdFromChatKey(chatKey: string): string {
  const parts = chatKey.split(":");
  if (parts[0] === "weixin" && parts[2]) {
    return parts.slice(2).join(":");
  }
  return chatKey;
}

// ---------------------------------------------------------------------------
// Message ID generation
// ---------------------------------------------------------------------------

function generateMessageSid(): string {
  return generateId("openclaw-weixin");
}

/** Inbound context passed to the OpenClaw core pipeline (matches MsgContext shape). */
export type WeixinMsgContext = {
  Body: string;
  From: string;
  To: string;
  AccountId: string;
  OriginatingChannel: "openclaw-weixin";
  OriginatingTo: string;
  MessageSid: string;
  Timestamp?: number;
  Provider: "openclaw-weixin";
  ChatType: "direct";
  /** Set by monitor after resolveAgentRoute so dispatchReplyFromConfig uses the correct session. */
  SessionKey?: string;
  context_token?: string;
  MediaUrl?: string;
  MediaPath?: string;
  MediaType?: string;
  /** Raw message body for framework command authorization. */
  CommandBody?: string;
  /** Whether the sender is authorized to execute slash commands. */
  CommandAuthorized?: boolean;
};

/** Returns true if the message item is a media type (image, video, file, or voice). */
export function isMediaItem(item: MessageItem): boolean {
  return (
    item.type === MessageItemType.IMAGE ||
    item.type === MessageItemType.VIDEO ||
    item.type === MessageItemType.FILE ||
    item.type === MessageItemType.VOICE
  );
}

export function bodyFromItemList(itemList?: MessageItem[]): string {
  if (!itemList?.length) return "";
  for (const item of itemList) {
    if (item.type === MessageItemType.TEXT && item.text_item?.text != null) {
      const text = String(item.text_item.text);
      const ref = item.ref_msg;
      if (!ref) return text;
      // Quoted media is passed as MediaPath; only include the current text as body.
      if (ref.message_item && isMediaItem(ref.message_item)) return text;
      // Build quoted context from both title and message_item content.
      const parts: string[] = [];
      if (ref.title) parts.push(ref.title);
      if (ref.message_item) {
        const refBody = bodyFromItemList([ref.message_item]);
        if (refBody) parts.push(refBody);
      }
      if (!parts.length) return text;
      return `${t().misc.quotedMessagePrefix(parts.join(" | "))}\n${text}`;
    }
    // 语音转文字：如果语音消息有 text 字段，直接使用文字内容
    if (item.type === MessageItemType.VOICE && item.voice_item?.text) {
      return item.voice_item.text;
    }
  }
  return "";
}

export type WeixinInboundMediaOpts = {
  /** Local path to decrypted image file. */
  decryptedPicPath?: string;
  /** Local path to transcoded/raw voice file (.wav or .silk). */
  decryptedVoicePath?: string;
  /** MIME type for the voice file (e.g. "audio/wav" or "audio/silk"). */
  voiceMediaType?: string;
  /** Local path to decrypted file attachment. */
  decryptedFilePath?: string;
  /** MIME type for the file attachment (guessed from file_name). */
  fileMediaType?: string;
  /** Local path to decrypted video file. */
  decryptedVideoPath?: string;
};

/**
 * Convert a WeixinMessage from getUpdates to the inbound MsgContext for the core pipeline.
 * Media: only pass MediaPath (local file, after CDN download + decrypt).
 * We never pass MediaUrl — the upstream CDN URL is encrypted/auth-only.
 * Priority when multiple media types present: image > video > file > voice.
 */
export function weixinMessageToMsgContext(
  msg: WeixinMessage,
  accountId: string,
  opts?: WeixinInboundMediaOpts,
): WeixinMsgContext {
  const from_user_id = msg.from_user_id ?? "";
  const ctx: WeixinMsgContext = {
    Body: bodyFromItemList(msg.item_list),
    From: from_user_id,
    To: from_user_id,
    AccountId: accountId,
    OriginatingChannel: "openclaw-weixin",
    OriginatingTo: from_user_id,
    MessageSid: generateMessageSid(),
    Timestamp: msg.create_time_ms,
    Provider: "openclaw-weixin",
    ChatType: "direct",
  };
  if (msg.context_token) {
    ctx.context_token = msg.context_token;
  }

  if (opts?.decryptedPicPath) {
    ctx.MediaPath = opts.decryptedPicPath;
    ctx.MediaType = "image/*";
  } else if (opts?.decryptedVideoPath) {
    ctx.MediaPath = opts.decryptedVideoPath;
    ctx.MediaType = "video/mp4";
  } else if (opts?.decryptedFilePath) {
    ctx.MediaPath = opts.decryptedFilePath;
    ctx.MediaType = opts.fileMediaType ?? "application/octet-stream";
  } else if (opts?.decryptedVoicePath) {
    ctx.MediaPath = opts.decryptedVoicePath;
    ctx.MediaType = opts.voiceMediaType ?? "audio/wav";
  }

  return ctx;
}

/** Extract the context_token from an inbound WeixinMsgContext. */
export function getContextTokenFromMsgContext(ctx: WeixinMsgContext): string | undefined {
  return ctx.context_token;
}

// ---------------------------------------------------------------------------
// Multi-media descriptor extraction
// ---------------------------------------------------------------------------

export interface WeixinInboundMediaDescriptor {
  item: MessageItem;
  kind: ChannelMediaKind;
  fileName?: string;
}

export function extractWeixinMediaDescriptors(itemList?: MessageItem[]): WeixinInboundMediaDescriptor[] {
  const out: WeixinInboundMediaDescriptor[] = [];
  for (const item of itemList ?? []) {
    const descriptor = descriptorFromItem(item);
    if (descriptor) out.push(descriptor);
    const ref = item.type === MessageItemType.TEXT ? item.ref_msg?.message_item : undefined;
    const refDescriptor = descriptorFromItem(ref);
    if (refDescriptor) out.push(refDescriptor);
  }
  return out;
}

function descriptorFromItem(item?: MessageItem): WeixinInboundMediaDescriptor | undefined {
  if (!item) return undefined;
  if (item.type === MessageItemType.IMAGE) return { item, kind: "image" };
  if (item.type === MessageItemType.VIDEO) return { item, kind: "video" };
  if (item.type === MessageItemType.FILE) return { item, kind: "file", fileName: item.file_item?.file_name };
  if (item.type === MessageItemType.VOICE) return { item, kind: "audio" };
  return undefined;
}
