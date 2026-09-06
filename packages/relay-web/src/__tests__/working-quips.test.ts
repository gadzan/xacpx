import { describe, expect, it } from "vitest";
import en from "../i18n/messages/en";
import zhCN from "../i18n/messages/zh-CN";
import { parseQuips, pickQuip } from "../lib/working-quips";

describe("working quips", () => {
  it("parses newline-delimited pools and drops empties", () => {
    expect(parseQuips("a\n b \n\n c")).toEqual(["a", "b", "c"]);
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
    expect(pickQuip(["only"], "only")).toBe("only");
    expect(pickQuip([], undefined)).toBe("");
  });

  it("both locales ship a non-empty pool of unique quips plus an Esc suffix", () => {
    for (const catalog of [en, zhCN]) {
      const chat = catalog.chat as Record<string, string>;
      const quips = parseQuips(chat.workingQuips);
      expect(quips.length).toBeGreaterThanOrEqual(10);
      expect(new Set(quips).size).toBe(quips.length);
      expect(quips.every((q) => q.length > 0 && q.length <= 40)).toBe(true);
      expect(chat.escToStop.length).toBeGreaterThan(0);
    }
  });
});
