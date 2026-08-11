/** True for a non-null object; narrows to an indexable record for field access. */
export declare const isObj: (v: unknown) => v is Record<string, unknown>;
/** Required string. */
export declare const isStr: (v: unknown) => boolean;
/** Optional string: absent or a string. */
export declare const optStr: (v: unknown) => boolean;
/** Optional number: absent or a number. */
export declare const optNum: (v: unknown) => boolean;
/** Optional boolean: absent or a boolean. */
export declare const optBool: (v: unknown) => boolean;
/** Required non-empty string with an inclusive max length. */
export declare const isBoundedStr: (v: unknown, maxLen: number) => v is string;
/** Finite integer in `[min, max]` inclusive. */
export declare const isIntInRange: (v: unknown, min: number, max: number) => v is number;
/** Finite non-negative integer. */
export declare const isNonNegInt: (v: unknown) => v is number;
/**
 * Decode a canonical base64 payload with an encoded-length pre-check.
 * Returns null when the encoded length exceeds the bound for `maxDecodedBytes`,
 * the payload is not valid base64, the decoded size exceeds the cap, or the
 * string is a non-canonical encoding of the same bytes (round-trip mismatch).
 */
export declare function parseCanonicalBase64(encoded: unknown, maxDecodedBytes: number): Uint8Array | null;
