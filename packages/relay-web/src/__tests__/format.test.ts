import { describe, expect, it } from "vitest";
import { fmtTime, fmtDateTime } from "../lib/format";

describe("format helpers", () => {
  it("fmtTime returns empty for missing/invalid input", () => {
    expect(fmtTime(undefined)).toBe("");
    expect(fmtTime("not-a-date")).toBe("");
  });

  it("fmtTime formats a valid ISO string to HH:MM", () => {
    expect(fmtTime("2026-06-19T15:45:00Z")).toMatch(/\d{1,2}[:.]\d{2}/);
  });

  it("fmtDateTime returns empty for invalid input and a non-empty string otherwise", () => {
    expect(fmtDateTime("nope")).toBe("");
    expect(fmtDateTime("2026-06-19T15:45:00Z").length).toBeGreaterThan(0);
  });
});
