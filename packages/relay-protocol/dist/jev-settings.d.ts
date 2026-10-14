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
export declare const JEV_ENDPOINT_MAX_LENGTH = 2048;
export declare const JEV_PROXY_URL_MAX_LENGTH = 2048;
export declare const JEV_API_KEY_MAX_LENGTH = 512;
/** Upper bound on one `test` failure message. */
export declare const JEV_TEST_MESSAGE_MAX_LENGTH = 500;
/** The masked form of a stored key: a prefix of at most this many characters
 *  plus the last 4, with the middle elided. Short keys mask to nothing. */
export declare const JEV_KEY_MASK_PREFIX = 3;
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
export type JevTestResult = {
    ok: true;
    latencyMs: number;
} | {
    ok: false;
    code: JevTestFailureCode;
    message: string;
};
export type JevTestFailureCode = 
/** HTTP 451: TypeSafe is not available in this region; a proxy is required. */
"region-blocked"
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
/** Parse a connector `control.jev.get` / `control.jev.update` answer. Throws
 *  when the shape is not a settings view. */
export declare function parseJevSettings(value: unknown): JevSettingsDto;
/** Parse a connector `control.jev.test` answer. Throws when the shape is not a
 *  test result. */
export declare function parseJevTestResult(value: unknown): JevTestResult;
