// Playful status lines for the busy composer placeholder. The i18n catalog keeps
// values as plain strings, so the pool is stored as one newline-delimited string.
export function parseQuips(raw: string | undefined | null): string[] {
  if (!raw) return [];
  return raw
    .split("\n")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/** Random pick, avoiding an immediate repeat when the pool allows a choice. */
export function pickQuip(quips: string[], avoid?: string): string {
  if (quips.length === 0) return "";
  if (quips.length === 1) return quips[0];
  const pool = avoid ? quips.filter((q) => q !== avoid) : quips;
  return pool[Math.floor(Math.random() * pool.length)];
}
