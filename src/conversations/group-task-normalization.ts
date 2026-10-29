/**
 * Task identity for duplicate-dispatch detection and stuck recovery.
 *
 * One rule for both, so the two cannot drift: a handoff dispatch is refused
 * when its task text normalizes to the same value as one already dispatched
 * to the same member in the same turn, and a stuck turn is only recovered by
 * a later achieved turn on the same normalized task. Whitespace, case and
 * edge punctuation are noise; wording in the middle is the task itself.
 */

/** Punctuation only — sentence-final marks, separators, quotes, ellipsis. Symbols
 * are NOT punctuation (`+` in "C++", `=` in a command) and must survive. */
const EDGE_PUNCTUATION = /^[\p{P}]+|[\p{P}]+$/gu;

/**
 * NFKC (full-width to half-width), whitespace collapsed to single spaces,
 * lowercased, edge punctuation dropped. Middle text is preserved verbatim:
 * no synonym rewriting, so a different instruction stays a different task.
 */
export function normalizeGroupTaskText(text: string): string {
  return text.normalize("NFKC").replace(/\s+/g, " ").trim().toLowerCase()
    .replace(EDGE_PUNCTUATION, "").trim();
}
