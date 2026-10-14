import { isRecord } from "./type-guards";

/**
 * Wire state for the per-instance Jev (TypeSafe SystemOne) routing settings.
 *
 * The API key is a secret: it is stored daemon-side in a private file next to
 * the daemon config and NEVER crosses the wire in plaintext. `get` answers
 * with `keyConfigured` plus a masked preview; `update` accepts a new key or an
 * explicit `null` to clear it. Settings are INSTANCE-scoped (like
 * `conversations.router`), not chat-scoped.
 */

/** Wire bounds. The daemon re-validates semantics (scheme, emptiness); these
 *  keep an overlong value from ever being persisted. */
export const JEV_ENDPOINT_MAX_LENGTH = 2048;
export const JEV_PROXY_URL_MAX_LENGTH = 2048;
export const JEV_API_KEY_MAX_LENGTH = 512;
/** Upper bound on one `test` failure message. */
export const JEV_TEST_MESSAGE_MAX_LENGTH = 500;

/** The masked form of a stored key: a prefix of at most this many characters
 *  plus the last 4, with the middle elided. Short keys mask to nothing. */
export const JEV_KEY_MASK_PREFIX = 3;

/** Stored settings as the daemon reports them back. `proxyUrl` is ABSENT, never
 *  empty, when unset: an empty proxy means "fall back to the daemon process
 *  HTTPS_PROXY / https_proxy", which is the default, so absence is the honest
 *  form of "nothing configured". `model` is the pinned effective model. */
export interface JevSettingsDto {
  endpoint: string;
  proxyUrl?: string;
  model: string;
  keyConfigured: boolean;
  /** Masked preview (`sk-…abcd`), or null when no key is stored. */
  keyMasked: string | null;
}

/** A live connection test against Jev. `ok` answers carry the observed latency;
 *  failures carry a stable code the UI maps to actionable copy. */
export type JevTestResult =
  | { ok: true; latencyMs: number }
  | { ok: false; code: JevTestFailureCode; message: string };

export type JevTestFailureCode =
  /** HTTP 451: TypeSafe is not available in this region; a proxy is required. */
  | "region-blocked"
  /** HTTP 401/403: the API key was rejected. */
  | "bad-key"
  /** Connect / timeout / proxy failure. */
  | "network"
  /** Any other non-2xx status. */
  | "http-error"
  /** 2xx whose body was not the expected answer shape. */
  | "malformed-response"
  /** No key was stored and none was supplied for the test. */
  | "no-key";

const JEV_TEST_FAILURE_CODES: Record<JevTestFailureCode, true> = {
  "region-blocked": true,
  "bad-key": true,
  network: true,
  "http-error": true,
  "malformed-response": true,
  "no-key": true,
};

const JEV_SETTINGS_KEYS: Record<string, true> = {
  endpoint: true,
  proxyUrl: true,
  model: true,
  keyConfigured: true,
  keyMasked: true,
};

/** Parse a connector `control.jev.get` / `control.jev.update` answer. Throws
 *  when the shape is not a settings view. */
export function parseJevSettings(value: unknown): JevSettingsDto {
  if (!isRecord(value)) throw new Error("jev settings must be an object");
  if (typeof value.endpoint !== "string" || !value.endpoint) {
    throw new Error("jev settings endpoint must be a non-empty string");
  }
  if (typeof value.model !== "string" || !value.model) {
    throw new Error("jev settings model must be a non-empty string");
  }
  if (typeof value.keyConfigured !== "boolean") {
    throw new Error("jev settings keyConfigured must be a boolean");
  }
  if (value.proxyUrl !== undefined && typeof value.proxyUrl !== "string") {
    throw new Error("jev settings proxyUrl must be a string when present");
  }
  if (value.keyMasked !== null && typeof value.keyMasked !== "string") {
    throw new Error("jev settings keyMasked must be a string or null");
  }
  if (Object.keys(value).some((key) => !JEV_SETTINGS_KEYS[key])) {
    throw new Error("jev settings contains an unsupported field");
  }
  return {
    endpoint: value.endpoint,
    ...(value.proxyUrl !== undefined ? { proxyUrl: value.proxyUrl } : {}),
    model: value.model,
    keyConfigured: value.keyConfigured,
    keyMasked: value.keyMasked,
  };
}

/** Parse a connector `control.jev.test` answer. Throws when the shape is not a
 *  test result. */
export function parseJevTestResult(value: unknown): JevTestResult {
  if (!isRecord(value)) throw new Error("jev test result must be an object");
  if (value.ok === true) {
    if (typeof value.latencyMs !== "number" || !Number.isFinite(value.latencyMs) || value.latencyMs < 0) {
      throw new Error("jev test result requires a non-negative latencyMs");
    }
    if (Object.keys(value).some((key) => key !== "ok" && key !== "latencyMs")) {
      throw new Error("jev test result contains an unsupported field");
    }
    return { ok: true, latencyMs: value.latencyMs };
  }
  if (value.ok === false) {
    if (typeof value.code !== "string" || !JEV_TEST_FAILURE_CODES[value.code as JevTestFailureCode]) {
      throw new Error("jev test result carries an unrecognized failure code");
    }
    if (typeof value.message !== "string" || !value.message.trim() || value.message.length > JEV_TEST_MESSAGE_MAX_LENGTH) {
      throw new Error("jev test result requires a bounded failure message");
    }
    if (Object.keys(value).some((key) => key !== "ok" && key !== "code" && key !== "message")) {
      throw new Error("jev test result contains an unsupported field");
    }
    return { ok: false, code: value.code as JevTestFailureCode, message: value.message };
  }
  throw new Error("jev test result must declare ok true or false");
}
