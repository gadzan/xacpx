import { MAX_DESKTOP_CREDENTIAL_FIELD_BYTES } from "./limits.js";
import type { DesktopCredential } from "./messages.js";
import { hasOnlyKeys, isObj } from "./validate-primitives.js";

const CREDENTIAL_KEYS = { kind: true, username: true, password: true } satisfies Record<keyof DesktopCredential, true>;

const utf8 = new TextEncoder();

/**
 * The only credential validator: the web `desktop-open` parser, the connector's prepare
 * validator, and the relay-web form all call it. Returns a freshly built object, so a key
 * that a looser caller let through never rides along.
 */
export function parseDesktopCredential(value: unknown): DesktopCredential | null {
  if (!isObj(value) || !hasOnlyKeys(value, CREDENTIAL_KEYS)) return null;
  if (value.kind !== "ard" || !isCredentialField(value.username) || !isCredentialField(value.password)) return null;
  return { kind: "ard", username: value.username, password: value.password };
}

function isCredentialField(value: unknown): value is string {
  return typeof value === "string"
    && value.length > 0
    && !value.includes("\0")
    && utf8.encode(value).byteLength <= MAX_DESKTOP_CREDENTIAL_FIELD_BYTES;
}
