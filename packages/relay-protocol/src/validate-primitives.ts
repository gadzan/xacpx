// packages/relay-protocol/src/validate-primitives.ts
// Shared runtime field predicates for wire-payload validation. Kept dependency-free
// and framework-free so both web-dtos.ts (relay→web push) and payload-validators.ts
// (hub↔connector control RPCs) draw from one implementation instead of drifting copies.

import { maxBase64EncodedLength } from "./limits.js";

/** True for a non-null object; narrows to an indexable record for field access. */
export const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null;

/** Required string. */
export const isStr = (v: unknown): boolean => typeof v === "string";

/** Optional string: absent or a string. */
export const optStr = (v: unknown): boolean => v === undefined || typeof v === "string";

/** Optional number: absent or a number. */
export const optNum = (v: unknown): boolean => v === undefined || typeof v === "number";

/** Optional boolean: absent or a boolean. */
export const optBool = (v: unknown): boolean => v === undefined || typeof v === "boolean";

/** Required non-empty string with an inclusive max length. */
export const isBoundedStr = (v: unknown, maxLen: number): v is string =>
  typeof v === "string" && v.length > 0 && v.length <= maxLen;

/** Finite integer in `[min, max]` inclusive. */
export const isIntInRange = (v: unknown, min: number, max: number): v is number =>
  typeof v === "number" && Number.isInteger(v) && v >= min && v <= max;

/** Finite non-negative integer. */
export const isNonNegInt = (v: unknown): v is number =>
  typeof v === "number" && Number.isInteger(v) && v >= 0;

type Base64BufferCtor = {
  from(value: string, encoding: "base64"): {
    length: number;
    buffer: ArrayBufferLike;
    byteOffset: number;
    byteLength: number;
    toString(encoding: "base64"): string;
  };
};

function decodeCanonicalBase64(encoded: string): Uint8Array | null {
  if (typeof globalThis.atob === "function" && typeof globalThis.btoa === "function") {
    const binary = globalThis.atob(encoded);
    if (globalThis.btoa(binary) !== encoded) return null;
    const decoded = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
      decoded[i] = binary.charCodeAt(i) & 0xff;
    }
    return decoded;
  }

  const BufferCtor = (globalThis as typeof globalThis & { Buffer?: Base64BufferCtor }).Buffer;
  if (!BufferCtor) return null;
  const decoded = BufferCtor.from(encoded, "base64");
  if (decoded.toString("base64") !== encoded) return null;
  return new Uint8Array(decoded.buffer, decoded.byteOffset, decoded.byteLength);
}

/**
 * Decode a canonical base64 payload with an encoded-length pre-check.
 * Runtime-neutral: browsers use `atob`/`btoa`; Node/Bun can fall back to
 * `Buffer`. Returns null when the encoded length exceeds the bound for
 * `maxDecodedBytes`, the payload is not valid base64, the decoded size
 * exceeds the cap, or the string is a non-canonical encoding of the same
 * bytes (round-trip mismatch).
 */
export function parseCanonicalBase64(encoded: unknown, maxDecodedBytes: number): Uint8Array | null {
  if (typeof encoded !== "string") return null;
  if (encoded.length > maxBase64EncodedLength(maxDecodedBytes)) return null;
  try {
    const decoded = decodeCanonicalBase64(encoded);
    if (!decoded || decoded.length > maxDecodedBytes) return null;
    return decoded;
  } catch {
    return null;
  }
}
