import { describe, expect, it } from "vitest";
import { formatModelLabel } from "../lib/model-label";

describe("formatModelLabel", () => {
  it("normalizes a bracketed reasoning-effort suffix to model/effort", () => {
    expect(formatModelLabel("gpt-5.5[high]")).toBe("gpt-5.5/high");
    expect(formatModelLabel("gpt-5.5[minimal]")).toBe("gpt-5.5/minimal");
  });

  it("leaves the already-slashed form unchanged", () => {
    expect(formatModelLabel("gpt-5.5/medium")).toBe("gpt-5.5/medium");
  });

  it("leaves a bare model id unchanged", () => {
    expect(formatModelLabel("gpt-5.5")).toBe("gpt-5.5");
    expect(formatModelLabel("claude-opus-4-8")).toBe("claude-opus-4-8");
  });

  it("does NOT touch a bracketed suffix that isn't a known effort (e.g. context variant)", () => {
    expect(formatModelLabel("claude-opus-4-8[1m]")).toBe("claude-opus-4-8[1m]");
    expect(formatModelLabel("some-model[experimental]")).toBe("some-model[experimental]");
  });
});
