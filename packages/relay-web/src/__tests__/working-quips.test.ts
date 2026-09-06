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

  it("both locales ship a 20-entry unique quip pool plus an Esc suffix (catalog invariant)", () => {
    const pools = [
      { workingQuips: en.chat.workingQuips, escToStop: en.chat.escToStop },
      { workingQuips: zhCN.chat.workingQuips, escToStop: zhCN.chat.escToStop },
    ];
    for (const { workingQuips, escToStop } of pools) {
      // Inspect raw catalog lines: parseQuips dedupes, so routing the catalog
      // through it would mask accidental duplicate entries.
      const rawQuips = workingQuips
        .split("\n")
        .map((q) => q.trim())
        .filter(Boolean);
      expect(rawQuips).toHaveLength(20);
      expect(new Set(rawQuips).size).toBe(rawQuips.length);
      // vue-i18n reserves @ | { } in message syntax — quips must never use them.
      expect(rawQuips.every((q) => !/[@|{}]/.test(q))).toBe(true);
      expect(rawQuips.every((q) => q.length > 0 && q.length <= 40)).toBe(true);
      expect(escToStop.length).toBeGreaterThan(0);
    }
  });
});
