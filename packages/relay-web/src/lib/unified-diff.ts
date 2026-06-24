export type DiffRowType = "hunk" | "add" | "del" | "context";

export interface DiffRow {
  type: DiffRowType;
  oldNo: number | null;
  newNo: number | null;
  text: string;
}

export interface ParsedDiff {
  rows: DiffRow[];
  add: number;
  del: number;
}

const HUNK_RE = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)$/;

/** Parse git unified-diff text into renderable rows with old/new line numbers.
 *  File-header lines (diff --git, index, ---, +++) are dropped; only hunks render. */
export function parseUnifiedDiff(diff: string): ParsedDiff {
  const rows: DiffRow[] = [];
  let add = 0;
  let del = 0;
  let oldNo = 0;
  let newNo = 0;
  let inHunk = false;

  for (const line of diff.split("\n")) {
    const hunk = HUNK_RE.exec(line);
    if (hunk) {
      oldNo = Number(hunk[1]);
      newNo = Number(hunk[2]);
      inHunk = true;
      rows.push({ type: "hunk", oldNo: null, newNo: null, text: hunk[3].trim() });
      continue;
    }
    if (!inHunk) continue; // skip pre-hunk file headers / preamble
    const c = line[0];
    if (c === "+") {
      if (line.startsWith("+++")) continue;
      rows.push({ type: "add", oldNo: null, newNo, text: line.slice(1) });
      newNo++;
      add++;
    } else if (c === "-") {
      if (line.startsWith("---")) continue;
      rows.push({ type: "del", oldNo, newNo: null, text: line.slice(1) });
      oldNo++;
      del++;
    } else if (c === " ") {
      rows.push({ type: "context", oldNo, newNo, text: line.slice(1) });
      oldNo++;
      newNo++;
    }
    // "\\ No newline at end of file" and blank trailing lines are ignored
  }
  return { rows, add, del };
}
