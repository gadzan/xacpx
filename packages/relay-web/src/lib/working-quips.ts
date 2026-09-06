// Playful status lines for the busy composer placeholder. The i18n catalog keeps
// values as plain strings, so the pool is stored as one newline-delimited string.
export function parseQuips(raw: string | undefined | null): string[] {
  if (!raw) return [];
  const seen = new Set<string>();
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length > 0) seen.add(trimmed);
  }
  return [...seen];
}

/** Random pick, avoiding an immediate repeat when the pool allows a choice.
 *  Falls back to the full pool when filtering would empty it. */
export function pickQuip(quips: string[], avoid?: string): string {
  if (quips.length === 0) return "";
  const filtered = avoid ? quips.filter((q) => q !== avoid) : quips;
  const pool = filtered.length > 0 ? filtered : quips;
  return pool[Math.floor(Math.random() * pool.length)] ?? "";
}
