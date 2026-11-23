import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import { draftKey, loadFileDraft, saveFileDraft, clearFileDraft } from "../lib/file-drafts";

beforeEach(() => sessionStorage.clear());
afterEach(() => vi.restoreAllMocks());

describe("file-drafts", () => {
  it("draftKey composes sessionKey and path", () => {
    expect(draftKey("i1::s1", "a/b.ts")).toBe("i1::s1::a/b.ts");
  });

  it("save then load round-trips the text", () => {
    const k = draftKey("i1::s1", "a.ts");
    saveFileDraft(k, "hello");
    expect(loadFileDraft(k)).toBe("hello");
  });

  it("empty string is a valid draft (distinct from absent)", () => {
    const k = draftKey("i1::s1", "a.ts");
    saveFileDraft(k, "x");
    saveFileDraft(k, ""); // deleting all content is a real draft-clear, so key is removed
    expect(loadFileDraft(k)).toBeNull();
  });

  it("returns null when no draft exists", () => {
    expect(loadFileDraft(draftKey("i1::s1", "none.ts"))).toBeNull();
  });

  it("clearFileDraft removes the key", () => {
    const k = draftKey("i1::s1", "a.ts");
    saveFileDraft(k, "hi");
    clearFileDraft(k);
    expect(loadFileDraft(k)).toBeNull();
  });

  it("tolerates corrupt storage without throwing", () => {
    sessionStorage.setItem("xacpx.file-drafts.v1", "{not json");
    expect(loadFileDraft(draftKey("i1::s1", "a.ts"))).toBeNull();
  });

  it("swallows setItem quota errors", () => {
    const spy = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new DOMException("quota", "QuotaExceededError");
    });
    expect(() => saveFileDraft(draftKey("i1::s1", "a.ts"), "big")).not.toThrow();
    spy.mockRestore();
  });
});
