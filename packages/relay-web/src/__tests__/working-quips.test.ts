import { describe, expect, it } from "vitest";
import en from "../i18n/messages/en";
import zhCN from "../i18n/messages/zh-CN";
import { parseQuips, pickQuip } from "../lib/working-quips";

describe("working quips", () => {
  it("parses newline-delimited pools, trims, drops empties, and dedupes", () => {
    expect(parseQuips("a\n b \n\n c")).toEqual(["a", "b", "c"]);
    expect(parseQuips("a\na\nb")).toEqual(["a", "b"]);
    expect(parseQuips("a\n a ")).toEqual(["a"]);
    expect(parseQuips("")).toEqual([]);
    expect(parseQuips(undefined)).toEqual([]);
    expect(parseQuips(null)).toEqual([]);
  });

  it("picks randomly but never repeats immediately when there is a choice", () => {
    const pool = ["a", "b", "c"];
    for (let i = 0; i < 50; i++) {
      const pick = pickQuip(pool, "a");
      expect(pick).not.toBe("a");
      expect(pool).toContain(pick);
    }
    // Filtering out `avoid` would empty the pool → fall back to the full pool.
    expect(pickQuip(["a", "a"], "a")).toBe("a");
    expect(pickQuip(["only"], "only")).toBe("only");
    expect(pickQuip([], undefined)).toBe("");
  });

  it("both locales ship a non-empty pool of unique quips plus an Esc suffix", () => {
    const pools = [
      { workingQuips: en.chat.workingQuips, escToStop: en.chat.escToStop },
      { workingQuips: zhCN.chat.workingQuips, escToStop: zhCN.chat.escToStop },
    ];
    for (const { workingQuips, escToStop } of pools) {
      const quips = parseQuips(workingQuips);
      expect(quips.length).toBeGreaterThanOrEqual(10);
      expect(new Set(quips).size).toBe(quips.length);
      expect(quips.every((q) => q.length > 0 && q.length <= 40)).toBe(true);
      expect(escToStop.length).toBeGreaterThan(0);
    }
  });
});
