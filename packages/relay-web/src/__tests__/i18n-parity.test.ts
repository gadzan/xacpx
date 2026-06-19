import { describe, expect, it } from "vitest";
import en from "../i18n/messages/en";
import zhCN from "../i18n/messages/zh-CN";

function flattenKeys(obj: Record<string, unknown>, prefix = ""): string[] {
  return Object.entries(obj).flatMap(([k, v]) =>
    v && typeof v === "object"
      ? flattenKeys(v as Record<string, unknown>, `${prefix}${k}.`)
      : [`${prefix}${k}`],
  );
}

describe("i18n catalog parity", () => {
  const enKeys = flattenKeys(en as Record<string, unknown>).sort();
  const zhKeys = flattenKeys(zhCN as Record<string, unknown>).sort();

  it("zh-CN has exactly the same keys as en", () => {
    const missingInZh = enKeys.filter((k) => !zhKeys.includes(k));
    const extraInZh = zhKeys.filter((k) => !enKeys.includes(k));
    expect({ missingInZh, extraInZh }).toEqual({ missingInZh: [], extraInZh: [] });
  });

  it("no value is an empty string in either locale", () => {
    const walk = (o: Record<string, unknown>): string[] =>
      Object.values(o).flatMap((v) =>
        v && typeof v === "object" ? walk(v as Record<string, unknown>) : [String(v)],
      );
    expect(walk(en as Record<string, unknown>).every((s) => s.length > 0)).toBe(true);
    expect(walk(zhCN as Record<string, unknown>).every((s) => s.length > 0)).toBe(true);
  });
});
