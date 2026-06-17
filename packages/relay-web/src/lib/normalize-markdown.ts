// Tolerance normalizer for malformed GFM tables in agent output.
//
// Agent output frequently emits tables that markdown-it refuses to parse, so they
// render as raw `| a | b |` text. This pre-parse pass fixes ONLY two table cases:
//
//   1. A table that directly follows a paragraph with NO blank line between it and
//      the lead-in text — markdown-it won't start a table block, so we insert the
//      blank line.
//   2. A header row + data rows with NO `|---|` delimiter row — we synthesize a
//      delimiter so the rows are recognized as a table.
//
// Everything else (headings, lists, blockquotes, inline markup, code-block content,
// already-valid tables, and ordinary prose) is left byte-for-byte unchanged. The
// pass is deliberately conservative: only lines with a leading `|` count as table
// rows, which avoids false positives on prose like `a | b`.

/** A line that, trimmed, starts with a pipe — the only shape we treat as a table row. */
function isPipeRow(line: string): boolean {
  return line.trim().startsWith("|");
}

/**
 * Split a pipe row into its cells: trim, strip a single leading and single trailing
 * `|`, then split on `|`. Naive split — escaped `\|` is rare in agent tables and not
 * worth over-engineering.
 */
function splitCells(line: string): string[] {
  let s = line.trim();
  if (s.startsWith("|")) s = s.slice(1);
  if (s.endsWith("|")) s = s.slice(0, -1);
  return s.split("|");
}

/** A delimiter row: a pipe row whose every cell is `:?-+:?` (with optional surrounding space). */
function isDelimiterRow(line: string): boolean {
  if (!isPipeRow(line)) return false;
  const cells = splitCells(line);
  if (cells.length === 0) return false;
  return cells.every((cell) => /^\s*:?-+:?\s*$/.test(cell));
}

/** Build a `| --- | --- | ... |` delimiter row with `cols` columns. */
function makeDelimiterRow(cols: number): string {
  return "| " + Array(cols).fill("---").join(" | ") + " |";
}

/**
 * Normalize malformed agent tables: insert a missing blank line before a table that
 * follows a paragraph, and synthesize a missing delimiter row. Tables only.
 */
export function normalizeMarkdownTables(src: string): string {
  if (src === "") return "";

  const lines = src.split("\n");
  const out: string[] = [];
  let inFence = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Toggle fenced-code state. Fence markers and their contents pass through verbatim
    // and are never considered for table logic.
    if (/^\s*(```|~~~)/.test(line)) {
      inFence = !inFence;
      out.push(line);
      continue;
    }
    if (inFence) {
      out.push(line);
      continue;
    }

    const prevPushed = out.length > 0 ? out[out.length - 1] : null;
    const prevPushedIsPipeRow = prevPushed !== null && isPipeRow(prevPushed);

    // Detect the START of a pipe-row run: current line is a pipe row, the previously
    // pushed line is NOT a pipe row, and this line is not itself a delimiter row.
    // (Data rows within a run are reached with prevPushedIsPipeRow === true and so
    // never re-fire this branch.)
    if (isPipeRow(line) && !prevPushedIsPipeRow && !isDelimiterRow(line)) {
      const next = i + 1 < lines.length ? lines[i + 1] : null;

      if (next !== null && isPipeRow(next) && isDelimiterRow(next)) {
        // Valid header: header followed by a real delimiter. Just ensure a blank line
        // before, then push the header unchanged.
        if (out.length > 0 && out[out.length - 1].trim() !== "") out.push("");
        out.push(line);
        continue;
      }

      if (next !== null && isPipeRow(next)) {
        // Header followed by data, NO delimiter: ensure blank line before, push the
        // header, then synthesize a delimiter row matching the header column count.
        if (out.length > 0 && out[out.length - 1].trim() !== "") out.push("");
        out.push(line);
        out.push(makeDelimiterRow(splitCells(line).length));
        continue;
      }

      // Lone pipe row (next is not a pipe row or there is no next line): not a table.
      out.push(line);
      continue;
    }

    out.push(line);
  }

  return out.join("\n");
}
