import { describe, it, expect } from "vitest";
import { findInLines } from "../lib/find-in-lines";

describe("findInLines", () => {
  it("returns matches in document order (top line first, left-to-right)", () => {
    const lines = ["const foo = bar", "return foobar"];
    expect(findInLines(lines, "foo")).toEqual([
      { line: 0, start: 6, length: 3 },
      { line: 1, start: 7, length: 3 },
    ]);
  });

  it("finds overlapping occurrences by stepping one char", () => {
    expect(findInLines(["aaa"], "aa")).toEqual([
      { line: 0, start: 0, length: 2 },
      { line: 0, start: 1, length: 2 },
    ]);
  });

  it("is case-insensitive by default, case-sensitive when asked", () => {
    expect(findInLines(["Foo foo FOO"], "foo").length).toBe(3);
    expect(findInLines(["Foo foo FOO"], "foo", true)).toEqual([{ line: 0, start: 4, length: 3 }]);
  });

  it("returns nothing for an empty query", () => {
    expect(findInLines(["anything"], "")).toEqual([]);
  });

  it("reports the offset within each line, not a global offset", () => {
    const m = findInLines(["", "  x = y", "zzz x"], "x");
    expect(m).toEqual([
      { line: 1, start: 2, length: 1 },
      { line: 2, start: 4, length: 1 },
    ]);
  });
});
