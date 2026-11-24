import { describe, expect, it } from "vitest";
import { parseUnifiedDiff } from "../lib/unified-diff";

describe("parseUnifiedDiff", () => {
  it("parses a simple modify hunk with correct line numbers", () => {
    const diff = [
      "diff --git a/f.txt b/f.txt",
      "index 111..222 100644",
      "--- a/f.txt",
      "+++ b/f.txt",
      "@@ -1,3 +1,3 @@ section heading",
      " one",
      "-two",
      "+TWO",
      " three",
    ].join("\n");
    const { rows, add, del } = parseUnifiedDiff(diff);
    expect(add).toBe(1);
    expect(del).toBe(1);
    // file-header lines (diff/index/---/+++) are dropped
    expect(rows.map((r) => r.type)).toEqual(["hunk", "context", "del", "add", "context"]);
    const hunk = rows[0];
    expect(hunk.text).toBe("section heading");
    const ctx1 = rows[1];
    expect(ctx1).toMatchObject({ oldNo: 1, newNo: 1, text: "one" });
    const del2 = rows[2];
    expect(del2).toMatchObject({ type: "del", oldNo: 2, newNo: null, text: "two" });
    const add2 = rows[3];
    expect(add2).toMatchObject({ type: "add", oldNo: null, newNo: 2, text: "TWO" });
    const ctx3 = rows[4];
    expect(ctx3).toMatchObject({ oldNo: 3, newNo: 3, text: "three" });
  });

  it("handles an all-additions (untracked) diff vs /dev/null", () => {
    const diff = [
      "diff --git a/dev/null b/n.txt",
      "--- /dev/null",
      "+++ b/n.txt",
      "@@ -0,0 +1,2 @@",
      "+alpha",
      "+beta",
    ].join("\n");
    const { rows, add, del } = parseUnifiedDiff(diff);
    expect(add).toBe(2);
    expect(del).toBe(0);
    expect(rows.filter((r) => r.type === "add").map((r) => r.newNo)).toEqual([1, 2]);
  });

  it("returns no rows for empty diff text", () => {
    expect(parseUnifiedDiff("")).toEqual({ rows: [], add: 0, del: 0 });
  });
});
