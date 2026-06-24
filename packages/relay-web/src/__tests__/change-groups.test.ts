import { describe, expect, it } from "vitest";
import { groupChanges, splitPath } from "../lib/change-groups";

describe("groupChanges", () => {
  it("buckets by porcelain XY: X=staged, Y=worktree, ??=untracked", () => {
    const g = groupChanges([
      { path: "a.ts", status: "M " }, // staged only
      { path: "b.ts", status: " M" }, // worktree change only
      { path: "c.ts", status: "MM" }, // both
      { path: "d.ts", status: "A " }, // staged add
      { path: "e.ts", status: "??" }, // untracked
    ]);
    expect(g.staged.map((f) => f.path)).toEqual(["a.ts", "c.ts", "d.ts"]);
    expect(g.changes.map((f) => f.path)).toEqual(["b.ts", "c.ts"]);
    expect(g.untracked.map((f) => f.path)).toEqual(["e.ts"]);
  });

  it("shows merge-conflict statuses (UU/AA/DD) in both Staged and Changes", () => {
    // Unmerged entries have both X and Y set (neither space nor ?), so they
    // surface under both groups — pin this so a future refactor can't silently change it.
    const g = groupChanges([
      { path: "u.ts", status: "UU" },
      { path: "a.ts", status: "AA" },
      { path: "d.ts", status: "DD" },
    ]);
    expect(g.staged.map((f) => f.path)).toEqual(["u.ts", "a.ts", "d.ts"]);
    expect(g.changes.map((f) => f.path)).toEqual(["u.ts", "a.ts", "d.ts"]);
    expect(g.untracked).toEqual([]);
  });
});

describe("splitPath", () => {
  it("splits a relative path into dir prefix + basename", () => {
    expect(splitPath("src/deep/首页.ts")).toEqual({ dir: "src/deep/", name: "首页.ts" });
    expect(splitPath("README.md")).toEqual({ dir: "", name: "README.md" });
  });
});
