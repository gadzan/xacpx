/** A substring match within a specific source line. `line` is 0-based; `start` is the
 *  character offset within that line; `length` is the query length. */
export interface LineMatch {
  line: number;
  start: number;
  length: number;
}

/** Find every occurrence of `query` across `lines`, in document order (top line first,
 *  left-to-right within a line). Plain substring (not regex); case-insensitive unless
 *  `caseSensitive`. Overlapping matches step by 1 char so e.g. "aa" in "aaa" yields two.
 *  An empty query → no matches (callers should trim to reject a whitespace-only query).
 *  Case-insensitive matching assumes length-preserving lowercasing — offsets would drift
 *  for the rare chars whose `toLowerCase()` changes length (e.g. İ); not a concern for code. */
export function findInLines(lines: string[], query: string, caseSensitive = false): LineMatch[] {
  const out: LineMatch[] = [];
  if (!query) return out;
  const needle = caseSensitive ? query : query.toLowerCase();
  const len = query.length;
  for (let line = 0; line < lines.length; line++) {
    const hay = caseSensitive ? lines[line] : lines[line].toLowerCase();
    let from = 0;
    let idx: number;
    while ((idx = hay.indexOf(needle, from)) !== -1) {
      out.push({ line, start: idx, length: len });
      from = idx + 1; // step by 1 so overlapping occurrences are all found
    }
  }
  return out;
}
