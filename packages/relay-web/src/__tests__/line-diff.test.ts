import { describe, expect, it } from "vitest";
import { diffLines } from "../lib/line-diff";

describe("diffLines", () => {
  it("treats identical text as all context", () => {
    const d = diffLines("a\nb\nc", "a\nb\nc");
    expect(d.add).toBe(0);
    expect(d.del).toBe(0);
    expect(d.rows.every((r) => r.type === "context")).toBe(true);
    expect(d.rows).toHaveLength(3);
  });

  it("reports pure insertions", () => {
    const d = diffLines("a\nb", "a\nb\nc\nd");
    expect(d.add).toBe(2);
    expect(d.del).toBe(0);
    const adds = d.rows.filter((r) => r.type === "add").map((r) => r.text);
    expect(adds).toEqual(["c", "d"]);
  });

  it("reports pure deletions", () => {
    const d = diffLines("a\nb\nc", "a");
    expect(d.add).toBe(0);
    expect(d.del).toBe(2);
    const dels = d.rows.filter((r) => r.type === "del").map((r) => r.text);
    expect(dels).toEqual(["b", "c"]);
  });

  it("renders a single-line modification as one del + one add around context", () => {
    const d = diffLines("keep\nold\ntail", "keep\nnew\ntail");
    expect(d.add).toBe(1);
    expect(d.del).toBe(1);
    expect(d.rows.filter((r) => r.type === "context").map((r) => r.text)).toEqual(["keep", "tail"]);
    expect(d.rows.find((r) => r.type === "del")?.text).toBe("old");
    expect(d.rows.find((r) => r.type === "add")?.text).toBe("new");
  });

  it("assigns old/new line numbers correctly", () => {
    const d = diffLines("a\nb\nc", "a\nx\nc");
    const del = d.rows.find((r) => r.type === "del");
    const add = d.rows.find((r) => r.type === "add");
    expect(del).toMatchObject({ oldNo: 2, newNo: null });
    expect(add).toMatchObject({ oldNo: null, newNo: 2 });
  });

  it("treats an empty old side as a pure addition (new file), no phantom del row", () => {
    const d = diffLines("", "line1\nline2");
    expect(d.del).toBe(0);
    expect(d.add).toBe(2);
    expect(d.rows.every((r) => r.type === "add")).toBe(true);
    expect(d.rows).toHaveLength(2);
  });

  it("treats an empty new side as a pure deletion (full delete), no phantom add row", () => {
    const d = diffLines("a\nb", "");
    expect(d.add).toBe(0);
    expect(d.del).toBe(2);
    expect(d.rows.every((r) => r.type === "del")).toBe(true);
    expect(d.rows).toHaveLength(2);
  });

  it("falls back to naive block for pathologically large inputs", () => {
    const big = Array.from({ length: 1600 }, (_, i) => `line ${i}`).join("\n");
    const d = diffLines(big, "");
    // Naive path: every old line is a deletion, no context rows, no phantom addition.
    expect(d.del).toBe(1600);
    expect(d.add).toBe(0);
    expect(d.rows.some((r) => r.type === "context")).toBe(false);
  });

  it("handles a single-line file with a trailing newline as 1 addition", () => {
    expect(diffLines("", "export const x = 1;\n")).toMatchObject({ add: 1, del: 0 });
  });

  it("handles deleting a single-line file with a trailing newline as 1 deletion", () => {
    expect(diffLines("export const x = 1;\n", "")).toMatchObject({ add: 0, del: 1 });
  });

  it("handles multi-line files with trailing newline correctly without off-by-one", () => {
    expect(diffLines("", "a\nb\n")).toMatchObject({ add: 2, del: 0 });
    expect(diffLines("a\nb\n", "")).toMatchObject({ add: 0, del: 2 });
  });

  it("preserves true empty lines in the middle of text", () => {
    const d = diffLines("", "a\n\nb\n");
    expect(d.add).toBe(3);
  });

  it("does not treat adding or removing a terminal newline as a whole line addition/deletion", () => {
    expect(diffLines("a", "a\n")).toMatchObject({ add: 0, del: 0 });
    expect(diffLines("a\n", "a")).toMatchObject({ add: 0, del: 0 });
  });

  it("marks exact: true for standard LCS diffs", () => {
    const d = diffLines("a\nb\nc", "a\nx\nc");
    expect(d.exact).toBe(true);
  });

  it("marks exact: false when falling back to naive diff on n * m > 250,000 cells (501 lines)", () => {
    const lines501 = Array.from({ length: 501 }, (_, i) => `${i}`).join("\n");
    const mod501 = lines501.replace("0", "zero");
    const d = diffLines(lines501, mod501);
    expect(d.exact).toBe(false);
  });
});
