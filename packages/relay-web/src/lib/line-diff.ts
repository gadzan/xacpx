import type { DiffRow, ParsedDiff } from "./unified-diff";

// Guard against pathological O(n·m) LCS on large inputs. Connector already caps
// each side at DIFF_CAP=4000 chars, so this is rarely hit.
const MAX_CELLS = 250_000;
const MAX_SIDE = 1500;

/** Naive fallback: render every old line as a deletion, then every new line as
 *  an addition. Used when the LCS table would be too large. */
function naiveDiff(oldLines: string[], newLines: string[]): ParsedDiff {
  const rows: DiffRow[] = [];
  let oldNo = 1;
  let newNo = 1;
  let del = 0;
  let add = 0;
  for (const text of oldLines) {
    rows.push({ type: "del", oldNo: oldNo++, newNo: null, text });
    del++;
  }
  for (const text of newLines) {
    rows.push({ type: "add", oldNo: null, newNo: newNo++, text });
    add++;
  }
  return { rows, add, del };
}

/** Diff two independent text blobs at line granularity via classic LCS DP, then
 *  backtrack into renderable rows with old/new line numbers. */
export function diffLines(oldText: string, newText: string): ParsedDiff {
  const oldLines = oldText.split("\n");
  const newLines = newText.split("\n");
  const n = oldLines.length;
  const m = newLines.length;

  if (n > MAX_SIDE || m > MAX_SIDE || n * m > MAX_CELLS) {
    return naiveDiff(oldLines, newLines);
  }

  // lcs[i][j] = length of the longest common subsequence of oldLines[i:] and newLines[j:].
  const lcs: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i][j] = oldLines[i] === newLines[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
    }
  }

  const rows: DiffRow[] = [];
  let add = 0;
  let del = 0;
  let i = 0;
  let j = 0;
  let oldNo = 1;
  let newNo = 1;
  while (i < n && j < m) {
    if (oldLines[i] === newLines[j]) {
      rows.push({ type: "context", oldNo: oldNo++, newNo: newNo++, text: oldLines[i] });
      i++;
      j++;
    } else if (lcs[i + 1][j] >= lcs[i][j + 1]) {
      rows.push({ type: "del", oldNo: oldNo++, newNo: null, text: oldLines[i] });
      del++;
      i++;
    } else {
      rows.push({ type: "add", oldNo: null, newNo: newNo++, text: newLines[j] });
      add++;
      j++;
    }
  }
  while (i < n) {
    rows.push({ type: "del", oldNo: oldNo++, newNo: null, text: oldLines[i++] });
    del++;
  }
  while (j < m) {
    rows.push({ type: "add", oldNo: null, newNo: newNo++, text: newLines[j++] });
    add++;
  }
  return { rows, add, del };
}
