// packages/relay-protocol/src/validate-primitives.ts
// Shared runtime field predicates for wire-payload validation. Kept dependency-free
// and framework-free so both web-dtos.ts (relay→web push) and payload-validators.ts
// (hub↔connector control RPCs) draw from one implementation instead of drifting copies.

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
