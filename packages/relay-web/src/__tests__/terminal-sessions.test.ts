import { describe, it, expect, beforeEach, vi } from "vitest";
import { saveTerminalId, loadTerminalId, clearTerminalId } from "../lib/terminal-sessions";

beforeEach(() => sessionStorage.clear());

describe("terminal-sessions", () => {
  it("save then load round-trips the id", () => {
    saveTerminalId("i1::s1", "term-abc");
    expect(loadTerminalId("i1::s1")).toBe("term-abc");
  });
  it("returns null when absent", () => {
    expect(loadTerminalId("i1::none")).toBeNull();
  });
  it("clear removes the id", () => {
    saveTerminalId("i1::s1", "t");
    clearTerminalId("i1::s1");
    expect(loadTerminalId("i1::s1")).toBeNull();
  });
  it("tolerates corrupt storage", () => {
    sessionStorage.setItem("xacpx.terminal-ids.v1", "{bad");
    expect(loadTerminalId("i1::s1")).toBeNull();
  });
  it("swallows setItem quota errors", () => {
    const spy = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new DOMException("q", "QuotaExceededError"); });
    expect(() => saveTerminalId("i1::s1", "t")).not.toThrow();
    spy.mockRestore();
  });
});
