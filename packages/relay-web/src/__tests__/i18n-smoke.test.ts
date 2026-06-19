import { describe, expect, it } from "vitest";
import { i18n, resolveLocale } from "../i18n";

describe("i18n instance", () => {
  it("translates a shared key in English by default", () => {
    expect(i18n.global.t("connection.online")).toBe("Connected");
  });

  it("translates the same key in Chinese", () => {
    const prev = i18n.global.locale.value;
    i18n.global.locale.value = "zh-CN";
    expect(i18n.global.t("connection.online")).toBe("已连接");
    i18n.global.locale.value = prev;
  });

  it("resolveLocale maps zh-* to zh-CN and everything else to en", () => {
    expect(resolveLocale("zh-Hans-CN")).toBe("zh-CN");
    expect(resolveLocale("zh")).toBe("zh-CN");
    expect(resolveLocale("en-US")).toBe("en");
    expect(resolveLocale(undefined)).toBe("en");
  });
});
