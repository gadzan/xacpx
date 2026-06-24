import { describe, expect, it } from "vitest";
import { resolveLang, langAlias } from "../lib/shiki";

describe("resolveLang", () => {
  it("maps file extensions to shiki languages", () => {
    expect(resolveLang("src/a.ts")).toBe("typescript");
    expect(resolveLang("x.py")).toBe("python");
    expect(resolveLang("Component.vue")).toBe("vue");
    expect(resolveLang("deep/path/to/首页.tsx")).toBe("tsx");
  });
  it("falls back to text for unknown / missing / plaintext", () => {
    expect(resolveLang(undefined)).toBe("text");
    expect(resolveLang("README")).toBe("readme"); // no extension → bare token, lowercased
    expect(resolveLang("notes.txt")).toBe("text");
    expect(resolveLang("data.unknownext")).toBe("unknownext");
  });
  it("exposes a language alias table", () => {
    expect(langAlias.js).toBe("javascript");
    expect(langAlias.yml).toBe("yaml");
  });
});
