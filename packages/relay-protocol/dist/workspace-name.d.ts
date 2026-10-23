/**
 * Portable, browser-safe workspace naming helpers.
 *
 * The CLI, the relay hub and the Web dashboard must derive the SAME name for
 * the same input, so the rule lives here instead of being re-implemented (and
 * drifting) per runtime.
 */
/** FNV-1a 32-bit, 8 lowercase hex chars. Deterministic across runtimes. */
export declare function stableHash8(input: string): string;
/**
 * True when `input` carries at least one Unicode letter or digit, i.e. enough
 * signal to derive a workspace name from (ASCII slug or opaque hashed name).
 * Blank and symbols-only inputs are not derivable and must be rejected.
 * Shared by the CLI, the daemon and the Web dashboard so they agree.
 */
export declare function hasWorkspaceNameChars(input: string): boolean;
/**
 * Opaque workspace name for an input that carries no usable ASCII characters
 * (e.g. an all-CJK name): `<fallback>-<8 hex>`. Symbols-only input is not
 * derivable; check `hasWorkspaceNameChars` first.
 *
 * The 8-hex suffix is a short non-cryptographic hash: stable for the same
 * input, but NOT collision-free. Callers that need uniqueness must allocate a
 * suffix on top of it.
 *
 * `input` is trimmed before hashing, so surrounding whitespace does not change
 * the result. A blank input is not a valid use of this helper (it hashes to
 * `811c9dc5`); callers keep their own blank semantics.
 */
export declare function workspaceNameFallback(input: string, fallback?: string): string;
