import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import { i18n } from "../i18n";

const KEY = "relay-locale";

describe("locale store", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    localStorage.clear();
    i18n.global.locale.value = "en";
  });
  afterEach(() => vi.unstubAllGlobals());

  it("uses a persisted locale when present", async () => {
    localStorage.setItem(KEY, "zh-CN");
    const { useLocaleStore } = await import("../stores/locale");
    const s = useLocaleStore();
    expect(s.locale).toBe("zh-CN");
    expect(i18n.global.locale.value).toBe("zh-CN");
  });

  it("falls back to navigator.language when nothing persisted", async () => {
    vi.stubGlobal("navigator", { language: "zh-Hans-CN" });
    const { useLocaleStore } = await import("../stores/locale");
    const s = useLocaleStore();
    expect(s.locale).toBe("zh-CN");
  });

  it("set() persists and updates i18n", async () => {
    const { useLocaleStore } = await import("../stores/locale");
    const s = useLocaleStore();
    s.set("zh-CN");
    expect(localStorage.getItem(KEY)).toBe("zh-CN");
    expect(i18n.global.locale.value).toBe("zh-CN");
  });
});
