/**
 * Portable, browser-safe workspace naming helpers.
 *
 * The CLI, the relay hub and the Web dashboard must derive the SAME name for
 * the same input, so the rule lives here instead of being re-implemented (and
 * drifting) per runtime.
 */

/** FNV-1a 32-bit, 8 lowercase hex chars. Deterministic across runtimes. */
export function stableHash8(input: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

/**
 * Opaque workspace name for an input that carries no usable ASCII characters
 * (an all-CJK name, a symbols-only name, …): `<fallback>-<8 hex>`.
 *
 * The 8-hex suffix is a short non-cryptographic hash: stable for the same
 * input, but NOT collision-free. Callers that need uniqueness must allocate a
 * suffix on top of it.
 *
 * `input` is trimmed before hashing, so surrounding whitespace does not change
 * the result. A blank input is not a valid use of this helper (it hashes to
 * `811c9dc5`); callers keep their own blank semantics.
 */
export function workspaceNameFallback(input: string, fallback = "workspace"): string {
  const prefix = fallback.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "workspace";
  return `${prefix}-${stableHash8(input.trim())}`;
}
