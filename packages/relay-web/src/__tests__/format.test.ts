import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { i18n } from "../i18n";
import { fmtTime, fmtDateTime } from "../lib/format";

const originalLocale = i18n.global.locale.value;
const now = new Date(2026, 9, 22, 14, 30, 0);

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(now);
  i18n.global.locale.value = "en";
});
afterEach(() => {
  vi.useRealTimers();
  i18n.global.locale.value = originalLocale;
});

describe("format helpers", () => {
  it("returns empty for missing or invalid message timestamps", () => {
    expect(fmtTime(undefined)).toBe("");
    expect(fmtTime("")).toBe("");
    expect(fmtTime("not-a-date")).toBe("");
  });

  it.each([
    [0, "just now"],
    [59_000, "just now"],
    [60_000, "1 min ago"],
    [299_000, "4 min ago"],
  ] as const)("localizes a timestamp aged %i ms", (age, expected) => {
    expect(fmtTime(new Date(now.getTime() - age).toISOString())).toBe(expected);
  });

  it("localizes a relative age in Chinese", () => {
    i18n.global.locale.value = "zh-CN";
    expect(fmtTime(new Date(now.getTime() - 30_000).toISOString())).toBe("刚刚");
    expect(fmtTime(new Date(now.getTime() - 120_000).toISOString())).toBe("2 分钟前");
  });

  it("switches to a zero-padded 24-hour clock at exactly five minutes", () => {
    expect(fmtTime(new Date(now.getTime() - 300_000).toISOString())).toBe("14:25");
    expect(fmtTime(new Date(2026, 9, 22, 3, 4).toISOString())).toBe("03:04");
  });

  it("uses the relative window across a local midnight boundary", () => {
    vi.setSystemTime(new Date(2026, 9, 22, 0, 0, 30));
    expect(fmtTime(new Date(2026, 9, 21, 23, 59, 31).toISOString())).toBe("just now");
    expect(fmtTime(new Date(2026, 9, 21, 23, 55, 30).toISOString())).toBe("10-21 23:55");
  });

  it("uses local calendar days and includes clock time only within the same year", () => {
    expect(fmtTime(new Date(2026, 9, 21, 23, 59).toISOString())).toBe("10-21 23:59");
    expect(fmtTime(new Date(2026, 0, 2, 3, 4).toISOString())).toBe("01-02 03:04");
    expect(fmtTime(new Date(2025, 11, 31, 23, 59).toISOString())).toBe("2025-12-31");
  });

  it("keeps absolute formatting deterministic across supported locales", () => {
    const timestamp = new Date(2026, 8, 2, 3, 4).toISOString();
    i18n.global.locale.value = "en";
    expect(fmtTime(timestamp)).toBe("09-02 03:04");
    i18n.global.locale.value = "zh-CN";
    expect(fmtTime(timestamp)).toBe("09-02 03:04");
    expect(fmtTime(now.getTime() - 60_000)).toBe("1 分钟前");
  });

  it("does not label future timestamps as just now", () => {
    expect(fmtTime(new Date(2026, 9, 22, 14, 31).toISOString())).toBe("14:31");
  });

  it("formats full date-time values and rejects invalid input", () => {
    expect(fmtDateTime("nope")).toBe("");
    expect(fmtDateTime(new Date(2026, 9, 22, 3, 4).toISOString()).length).toBeGreaterThan(0);
  });
});
