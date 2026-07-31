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

  it("falls back to naive block for pathologically large inputs", () => {
    const big = Array.from({ length: 1600 }, (_, i) => `line ${i}`).join("\n");
    const d = diffLines(big, "");
    // Naive path: every old line is a deletion, no context rows.
    expect(d.del).toBe(1600);
    expect(d.rows.some((r) => r.type === "context")).toBe(false);
  });
});
