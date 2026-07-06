import crypto from "node:crypto";
import { readVersion } from "../../version.js";
import { coreEnv } from "../../runtime/core-env.js";

import { loadConfigBotAgent, loadConfigRouteTag } from "../auth/accounts.js";
import { weixinLog } from "../util/weixin-log";
import { redactBody, redactUrl } from "../util/redact.js";
import { WeixinSendError } from "../messaging/send-errors.js";

import type {
  BaseInfo,
  GetUploadUrlReq,
  GetUploadUrlResp,
  GetUpdatesReq,
  GetUpdatesResp,
  SendMessageReq,
  SendTypingReq,
  GetConfigResp,
} from "./types.js";

export type WeixinApiOptions = {
  baseUrl: string;
  token?: string;
  timeoutMs?: number;
  /** Long-poll timeout for getUpdates (server may hold the request up to this). */
  longPollTimeoutMs?: number;
};

// ---------------------------------------------------------------------------
// BaseInfo — attached to every outgoing CGI request
// ---------------------------------------------------------------------------

const CHANNEL_VERSION = readVersion();

/**
 * iLink-App-ClientVersion: uint32 encoded as 0x00MMNNPP
 * High 8 bits fixed to 0; remaining bits: major<<16 | minor<<8 | patch.
 * e.g. "1.0.11" -> 0x0001000B = 65547
 */
function buildClientVersion(version: string): number {
  const parts = version.split(".").map((p) => parseInt(p, 10));
  const major = parts[0] ?? 0;
  const minor = parts[1] ?? 0;
  const patch = parts[2] ?? 0;
  return ((major & 0xff) << 16) | ((minor & 0xff) << 8) | (patch & 0xff);
}

const ILINK_APP_CLIENT_VERSION: number = buildClientVersion(CHANNEL_VERSION);

/**
 * iLink-App-Id: opt-in via env var. Omitted from request headers when unset
 * for back-compat with installs that haven't opted in.
 */
const ILINK_APP_ID: string = (coreEnv("ILINK_APP_ID") ?? "").trim();

/**
 * Default `bot_agent` value used when the upstream app does not declare one.
 * Mirrors the role of HTTP `User-Agent`'s implicit "no UA" fallback.
 */
const DEFAULT_BOT_AGENT = "xacpx";

/** Maximum length (bytes) of the sanitized `bot_agent` string. */
const BOT_AGENT_MAX_LEN = 256;

/**
 * Sanitize a user-supplied `botAgent` config value into a wire-safe string.
 *
 * Grammar (UA-style):
 *   bot_agent = product *( SP product )
 *   product   = name "/" version [ SP "(" comment ")" ]
 *   name      = 1*32( ALPHA / DIGIT / "_" / "." / "-" )
 *   version   = 1*32( ALPHA / DIGIT / "_" / "." / "+" / "-" )
 *   comment   = 1*64( printable ASCII minus "(" ")" )
 *
 * Tokens that fail to parse are dropped silently (no partial tokens kept).
 * Returns `DEFAULT_BOT_AGENT` when the input is empty / all tokens dropped /
 * the result exceeds the length cap after truncation.
 */
export function sanitizeBotAgent(raw: string | undefined): string {
  if (!raw || typeof raw !== "string") return DEFAULT_BOT_AGENT;
  const trimmed = raw.trim();
  if (!trimmed) return DEFAULT_BOT_AGENT;

  const productRe = /^[A-Za-z0-9_.\-]{1,32}\/[A-Za-z0-9_.+\-]{1,32}$/;
  const commentCharRe = /^[\x20-\x27\x2A-\x7E]{1,64}$/;

  // Tokenize on whitespace, but keep `(comment)` glued to the preceding product.
  // Strategy: split by spaces, then re-attach any token that starts with "(".
  const rawTokens = trimmed.split(/\s+/);
  const tokens: string[] = [];
  for (let i = 0; i < rawTokens.length; i += 1) {
    const tok = rawTokens[i]!;
    if (tok.startsWith("(") && !tok.endsWith(")")) {
      // Multi-word comment; greedily collect until we find the closing ")".
      let acc = tok;
      while (i + 1 < rawTokens.length && !acc.endsWith(")")) {
        i += 1;
        acc += " " + rawTokens[i]!;
      }
      tokens.push(acc);
    } else {
      tokens.push(tok);
    }
  }

  const accepted: string[] = [];
  let pendingProduct: string | null = null;
  for (const tok of tokens) {
    if (tok.startsWith("(") && tok.endsWith(")")) {
      const inner = tok.slice(1, -1);
      if (pendingProduct && commentCharRe.test(inner)) {
        accepted.push(`${pendingProduct} (${inner})`);
        pendingProduct = null;
      } else {
        if (pendingProduct) {
          accepted.push(pendingProduct);
          pendingProduct = null;
        }
      }
      continue;
    }
    if (pendingProduct) {
      accepted.push(pendingProduct);
      pendingProduct = null;
    }
    if (productRe.test(tok)) {
      pendingProduct = tok;
    }
  }
  if (pendingProduct) accepted.push(pendingProduct);

  if (accepted.length === 0) return DEFAULT_BOT_AGENT;

  const joined = accepted.join(" ");
  if (Buffer.byteLength(joined, "utf-8") <= BOT_AGENT_MAX_LEN) return joined;

  // Truncate by dropping trailing tokens until under the cap.
  const truncated: string[] = [];
  let len = 0;
  for (const t of accepted) {
    const add = (truncated.length === 0 ? 0 : 1) + Buffer.byteLength(t, "utf-8");
    if (len + add > BOT_AGENT_MAX_LEN) break;
    truncated.push(t);
    len += add;
  }
  return truncated.length > 0 ? truncated.join(" ") : DEFAULT_BOT_AGENT;
}

/** Build the `base_info` payload included in every API request. */
export function buildBaseInfo(): BaseInfo {
  return {
    channel_version: CHANNEL_VERSION,
    bot_agent: sanitizeBotAgent(loadConfigBotAgent()),
  };
}

/** Default timeout for long-poll getUpdates requests. */
const DEFAULT_LONG_POLL_TIMEOUT_MS = 35_000;
/** Default timeout for regular API requests (sendMessage, getUploadUrl). */
const DEFAULT_API_TIMEOUT_MS = 15_000;
/** Default timeout for lightweight API requests (getConfig, sendTyping). */
const DEFAULT_CONFIG_TIMEOUT_MS = 10_000;

function ensureTrailingSlash(url: string): string {
  return url.endsWith("/") ? url : `${url}/`;
}

/** X-WECHAT-UIN header: random uint32 -> decimal string -> base64. */
function randomWechatUin(): string {
  const uint32 = crypto.randomBytes(4).readUInt32BE(0);
  return Buffer.from(String(uint32), "utf-8").toString("base64");
}

/** Build headers shared by both GET and POST requests. */
function buildCommonHeaders(): Record<string, string> {
  const headers: Record<string, string> = {};
  if (ILINK_APP_ID) headers["iLink-App-Id"] = ILINK_APP_ID;
  headers["iLink-App-ClientVersion"] = String(ILINK_APP_CLIENT_VERSION);
  const routeTag = loadConfigRouteTag();
  if (routeTag) {
    headers.SKRouteTag = routeTag;
  }
  return headers;
}

function buildHeaders(opts: { token?: string; body: string }): Record<string, string> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    AuthorizationType: "ilink_bot_token",
    "Content-Length": String(Buffer.byteLength(opts.body, "utf-8")),
    "X-WECHAT-UIN": randomWechatUin(),
    ...buildCommonHeaders(),
  };
  if (opts.token?.trim()) {
    headers.Authorization = `Bearer ${opts.token.trim()}`;
  }
  weixinLog.debug("weixin.api.request_headers", "requestHeaders", {
    headers: JSON.stringify({ ...headers, Authorization: headers.Authorization ? "Bearer ***" : undefined }),
  });
  return headers;
}

/**
 * GET fetch wrapper: send a GET request to a Weixin API endpoint with timeout + abort.
 * Query parameters should already be encoded in `endpoint`.
 * Returns the raw response text on success; throws on HTTP error or timeout.
 */
export async function apiGetFetch(params: {
  baseUrl: string;
  endpoint: string;
  timeoutMs: number;
  label: string;
}): Promise<string> {
  const base = ensureTrailingSlash(params.baseUrl);
  const url = new URL(params.endpoint, base);
  const hdrs = buildCommonHeaders();
  weixinLog.debug("weixin.api.get_request", "GET", { url: redactUrl(url.toString()) });

  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), params.timeoutMs);
  try {
    const res = await fetch(url.toString(), {
      method: "GET",
      headers: hdrs,
      signal: controller.signal,
    });
    clearTimeout(t);
    const rawText = await res.text();
    weixinLog.debug("weixin.api.response", `${params.label} response`, {
      status: res.status,
      raw: redactBody(rawText),
    });
    if (!res.ok) {
      throw new Error(`${params.label} ${res.status}: ${rawText}`);
    }
    return rawText;
  } catch (err) {
    clearTimeout(t);
    throw err;
  }
}

/**
 * Simple POST fetch wrapper for login/auth endpoints.
 * Returns the raw response text on success; throws on HTTP error or timeout.
 */
export async function apiPostFetch(params: {
  baseUrl: string;
  endpoint: string;
  body: string;
  token?: string;
  timeoutMs?: number;
  label: string;
  abortSignal?: AbortSignal;
}): Promise<string> {
  const base = ensureTrailingSlash(params.baseUrl);
  const url = new URL(params.endpoint, base);
  const hdrs = buildCommonHeaders();
  hdrs["Content-Type"] = "application/json";
  weixinLog.debug("weixin.api.post_request", "POST", {
    url: redactUrl(url.toString()),
    body: redactBody(params.body),
  });

  const controller = new AbortController();
  const t =
    params.timeoutMs !== undefined
      ? setTimeout(() => controller.abort(), params.timeoutMs)
      : undefined;

  // Forward external abort signal to our controller
  const onAbort = () => controller.abort();
  params.abortSignal?.addEventListener("abort", onAbort, { once: true });

  try {
    const res = await fetch(url.toString(), {
      method: "POST",
      headers: hdrs,
      body: params.body,
      signal: controller.signal,
    });
    const rawText = await res.text();
    weixinLog.debug("weixin.api.response", `${params.label} response`, {
      status: res.status,
      raw: redactBody(rawText),
    });
    if (!res.ok) {
      throw new Error(`${params.label} ${res.status}: ${rawText}`);
    }
    return rawText;
  } finally {
    if (t !== undefined) clearTimeout(t);
    params.abortSignal?.removeEventListener("abort", onAbort);
  }
}

/**
 * Common fetch wrapper: POST JSON to a Weixin API endpoint with timeout + abort.
 * Returns the raw response text on success; throws on HTTP error or timeout.
 */
async function apiFetch(params: {
  baseUrl: string;
  endpoint: string;
  body: string;
  token?: string;
  timeoutMs: number;
  label: string;
  abortSignal?: AbortSignal;
  /**
   * When true, a 2xx response whose JSON body carries a non-zero `errcode`
   * is treated as a hard failure and a WeixinSendError is thrown. Default
   * false: long-poll endpoints (getUpdates) want to inspect errcode in the
   * happy-path return value rather than crash.
   */
  throwOnLogicalError?: boolean;
}): Promise<string> {
  const base = ensureTrailingSlash(params.baseUrl);
  const url = new URL(params.endpoint, base);
  const hdrs = buildHeaders({ token: params.token, body: params.body });
  weixinLog.debug("weixin.api.post_request", "POST", {
    url: redactUrl(url.toString()),
    body: redactBody(params.body),
  });

  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), params.timeoutMs);

  // Forward external abort signal to our controller
  const onAbort = () => controller.abort();
  params.abortSignal?.addEventListener("abort", onAbort, { once: true });

  try {
    const res = await fetch(url.toString(), {
      method: "POST",
      headers: hdrs,
      body: params.body,
      signal: controller.signal,
    });
    clearTimeout(t);
    const rawText = await res.text();
    weixinLog.debug("weixin.api.response", `${params.label} response`, {
      status: res.status,
      raw: redactBody(rawText),
    });
    if (!res.ok) {
      throw buildSendError({ endpoint: params.label, httpStatus: res.status, rawText });
    }
    // Some endpoints reply 200 but signal logical failure via errcode.
    // The most relevant case for us is the per-user 24h quota of 10
    // outbound messages, which surfaces as a non-zero errcode in a 200
    // body and used to be silently treated as success. Mutation endpoints
    // opt into throwing so their callers see structured errors; long-poll
    // (getUpdates) keeps the old return-value behavior so the monitor's
    // failure-counting logic continues to work.
    if (params.throwOnLogicalError) {
      const logicalErr = parseLogicalError(rawText);
      if (logicalErr) {
        throw new WeixinSendError({
          endpoint: params.label,
          httpStatus: res.status,
          errcode: logicalErr.errcode,
          ...(logicalErr.errmsg !== undefined ? { errmsg: logicalErr.errmsg } : {}),
          textPreview: rawText.slice(0, 500),
        });
      }
    }
    return rawText;
  } catch (err) {
    clearTimeout(t);
    throw err;
  } finally {
    params.abortSignal?.removeEventListener("abort", onAbort);
  }
}

function buildSendError(input: {
  endpoint: string;
  httpStatus: number;
  rawText: string;
}): WeixinSendError {
  const logical = parseLogicalError(input.rawText);
  return new WeixinSendError({
    endpoint: input.endpoint,
    httpStatus: input.httpStatus,
    ...(logical?.errcode !== undefined ? { errcode: logical.errcode } : {}),
    ...(logical?.errmsg !== undefined ? { errmsg: logical.errmsg } : {}),
    textPreview: input.rawText.slice(0, 500),
  });
}

/**
 * Parse a Weixin response body and return the logical error fields when
 * present. Returns null for success responses, malformed bodies, and bodies
 * that don't carry an `errcode` field.
 *
 * Note: `errcode === 0` and missing `errcode` both mean "no logical error"
 * — only an explicit non-zero `errcode` is treated as failure.
 */
function parseLogicalError(rawText: string): { errcode: number; errmsg?: string } | null {
  if (!rawText) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawText);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const body = parsed as { errcode?: unknown; errmsg?: unknown };
  if (typeof body.errcode !== "number" || body.errcode === 0) return null;
  return {
    errcode: body.errcode,
    ...(typeof body.errmsg === "string" ? { errmsg: body.errmsg } : {}),
  };
}

/**
 * Long-poll getUpdates. Server should hold the request until new messages or timeout.
 *
 * On client-side timeout (no server response within timeoutMs), returns an empty response
 * with ret=0 so the caller can simply retry. This is normal for long-poll.
 */
export async function getUpdates(
  params: GetUpdatesReq & {
    baseUrl: string;
    token?: string;
    timeoutMs?: number;
    abortSignal?: AbortSignal;
  },
): Promise<GetUpdatesResp> {
  const timeout = params.timeoutMs ?? DEFAULT_LONG_POLL_TIMEOUT_MS;
  try {
    const rawText = await apiFetch({
      baseUrl: params.baseUrl,
      endpoint: "ilink/bot/getupdates",
      body: JSON.stringify({
        get_updates_buf: params.get_updates_buf ?? "",
        base_info: buildBaseInfo(),
      }),
      token: params.token,
      timeoutMs: timeout,
      label: "getUpdates",
      abortSignal: params.abortSignal,
    });
    const resp: GetUpdatesResp = JSON.parse(rawText);
    return resp;
  } catch (err) {
    // Long-poll timeout is normal; return empty response so caller can retry
    if (err instanceof Error && err.name === "AbortError") {
      weixinLog.debug(
        "weixin.api.get_updates_timeout",
        "getUpdates: client-side timeout, returning empty response",
        { timeoutMs: timeout },
      );
      return { ret: 0, msgs: [], get_updates_buf: params.get_updates_buf };
    }
    throw err;
  }
}

/** Get a pre-signed CDN upload URL for a file. */
export async function getUploadUrl(
  params: GetUploadUrlReq & WeixinApiOptions,
): Promise<GetUploadUrlResp> {
  const rawText = await apiFetch({
    baseUrl: params.baseUrl,
    endpoint: "ilink/bot/getuploadurl",
    body: JSON.stringify({
      filekey: params.filekey,
      media_type: params.media_type,
      to_user_id: params.to_user_id,
      rawsize: params.rawsize,
      rawfilemd5: params.rawfilemd5,
      filesize: params.filesize,
      thumb_rawsize: params.thumb_rawsize,
      thumb_rawfilemd5: params.thumb_rawfilemd5,
      thumb_filesize: params.thumb_filesize,
      no_need_thumb: params.no_need_thumb,
      aeskey: params.aeskey,
      base_info: buildBaseInfo(),
    }),
    token: params.token,
    timeoutMs: params.timeoutMs ?? DEFAULT_API_TIMEOUT_MS,
    label: "getUploadUrl",
  });
  const resp: GetUploadUrlResp = JSON.parse(rawText);
  return resp;
}

/** Send a single message downstream. */
export async function sendMessage(
  params: WeixinApiOptions & { body: SendMessageReq },
): Promise<void> {
  await apiFetch({
    baseUrl: params.baseUrl,
    endpoint: "ilink/bot/sendmessage",
    body: JSON.stringify({ ...params.body, base_info: buildBaseInfo() }),
    token: params.token,
    timeoutMs: params.timeoutMs ?? DEFAULT_API_TIMEOUT_MS,
    label: "sendMessage",
    throwOnLogicalError: true,
  });
}

/** Fetch bot config (includes typing_ticket) for a given user. */
export async function getConfig(
  params: WeixinApiOptions & { ilinkUserId: string; contextToken?: string },
): Promise<GetConfigResp> {
  const rawText = await apiFetch({
    baseUrl: params.baseUrl,
    endpoint: "ilink/bot/getconfig",
    body: JSON.stringify({
      ilink_user_id: params.ilinkUserId,
      context_token: params.contextToken,
      base_info: buildBaseInfo(),
    }),
    token: params.token,
    timeoutMs: params.timeoutMs ?? DEFAULT_CONFIG_TIMEOUT_MS,
    label: "getConfig",
  });
  const resp: GetConfigResp = JSON.parse(rawText);
  return resp;
}

/** Send a typing indicator to a user. */
export async function sendTyping(
  params: WeixinApiOptions & { body: SendTypingReq },
): Promise<void> {
  await apiFetch({
    baseUrl: params.baseUrl,
    endpoint: "ilink/bot/sendtyping",
    body: JSON.stringify({ ...params.body, base_info: buildBaseInfo() }),
    token: params.token,
    timeoutMs: params.timeoutMs ?? DEFAULT_CONFIG_TIMEOUT_MS,
    label: "sendTyping",
  });
}
