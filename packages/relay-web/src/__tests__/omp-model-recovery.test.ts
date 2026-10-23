import { describe, expect, it } from "vitest";
import { isOmpModelRestoreFailure, ompRestoreFailure } from "../lib/omp-model-recovery";

describe("OMP model restore failure guard", () => {
  it("matches the exact backend phrase and extracts the id", () => {
    const message = 'Could not restore model gpt-5.2[high]: the ACP agent did not advertise it';
    expect(isOmpModelRestoreFailure("omp", message)).toBe(true);
    expect(ompRestoreFailure("omp", `${message}.`)?.modelId).toBe("gpt-5.2[high]");
  });

  it("skips ${...} template placeholders and keeps the last valid id", () => {
    const message = 'Could not restore model ${MODEL_ID} then Could not restore model openai/gpt-5.2 retry';
    expect(ompRestoreFailure("omp", message)?.modelId).toBe("openai/gpt-5.2");
    expect(ompRestoreFailure("omp", "Could not restore model ${MODEL_ID}")).toBeNull();
  });
  it("suppresses the non-fatal fallback notice but not an unrelated excerpt line", () => {
    // OMP's retry.modelFallback notice means the switch SUCCEEDED with a
    // substitute — no banner, no repair.
    expect(ompRestoreFailure("omp", "Could not restore model openai/gpt-5.2. Using anthropic/claude-opus-4-8")).toBeNull();
    // An earlier fallback excerpt line must not suppress a real failure on
    // the last line.
    expect(ompRestoreFailure(
      "omp",
      "Could not restore model openai/gpt-5.2. Using other\nerror: Could not restore model magpie/group/auto-deepseek-v4-1-flash",
    )?.modelId).toBe("magpie/group/auto-deepseek-v4-1-flash");
  });

  it("never fires for other drivers or unrelated failures", () => {
    expect(isOmpModelRestoreFailure("codex", "Could not restore model gpt-5.2")).toBe(false);
    expect(isOmpModelRestoreFailure("omp", "prompt failed: adapter timed out")).toBe(false);
    expect(ompRestoreFailure(undefined, "Could not restore model gpt-5.2")).toBeNull();
  });
});
