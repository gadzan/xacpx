export interface ChangeEntry {
  path: string;
  status: string;
}

export interface ChangeGroups {
  staged: ChangeEntry[];
  changes: ChangeEntry[];
  untracked: ChangeEntry[];
}

/** Bucket porcelain entries: X (index) → Staged, Y (worktree) → Changes, "??" → Untracked.
 *  A both-staged-and-modified file intentionally appears in both Staged and Changes. */
export function groupChanges(files: ChangeEntry[]): ChangeGroups {
  const staged: ChangeEntry[] = [];
  const changes: ChangeEntry[] = [];
  const untracked: ChangeEntry[] = [];
  for (const f of files) {
    if (f.status === "??") {
      untracked.push(f);
      continue;
    }
    const x = f.status[0] ?? " ";
    const y = f.status[1] ?? " ";
    if (x !== " " && x !== "?") staged.push(f);
    if (y !== " " && y !== "?") changes.push(f);
  }
  return { staged, changes, untracked };
}

/** Split a workspace-relative path into a directory prefix (with trailing /) and basename. */
export function splitPath(rel: string): { dir: string; name: string } {
  const i = rel.lastIndexOf("/");
  return i < 0 ? { dir: "", name: rel } : { dir: rel.slice(0, i + 1), name: rel.slice(i + 1) };
}
