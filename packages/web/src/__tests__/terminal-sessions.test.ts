import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  saveTerminalId,
  loadTerminalId,
  clearTerminalId,
  migrateAwayFromLegacyTerminalIds,
} from "../lib/terminal-sessions";

beforeEach(() => sessionStorage.clear());

describe("terminal-sessions (legacy migration)", () => {
  it("migrateAwayFromLegacyTerminalIds clears the legacy map", () => {
    sessionStorage.setItem("xacpx.terminal-ids.v1", JSON.stringify({ "i1::s1": "t1" }));
    migrateAwayFromLegacyTerminalIds();
    expect(sessionStorage.getItem("xacpx.terminal-ids.v1")).toBeNull();
  });

  it("save/load/clear are no-ops after deprecation", () => {
    saveTerminalId("i1::s1", "term-abc");
    expect(loadTerminalId("i1::s1")).toBeNull();
    clearTerminalId("i1::s1");
    expect(loadTerminalId("i1::s1")).toBeNull();
  });

  it("tolerates missing storage", () => {
    const spy = vi.spyOn(Storage.prototype, "removeItem").mockImplementation(() => {
      throw new DOMException("q", "QuotaExceededError");
    });
    expect(() => migrateAwayFromLegacyTerminalIds()).not.toThrow();
    spy.mockRestore();
  });
});
