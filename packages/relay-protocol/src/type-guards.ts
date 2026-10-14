/**
 * The package's canonical object guard.
 *
 * A `Record<string, unknown>` guard proves an object, not its fields: callers
 * still check each property they read. One shared definition keeps that
 * contract single-sourced instead of re-declared per call site.
 */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
