import { expect, test } from "bun:test";

import { sessionEffortToReapply } from "../../../src/transport/session-effort";

test("sessionEffortToReapply is cold-only and skips the warmth probe without effort", async () => {
  const mustNotProbe = async (): Promise<boolean> => {
    throw new Error("should not probe warmth without effort");
  };

  await expect(sessionEffortToReapply("max", async () => false)).resolves.toBe("max");
  await expect(sessionEffortToReapply("  high  ", async () => false)).resolves.toBe("high");
  await expect(sessionEffortToReapply("max", async () => true)).resolves.toBeUndefined();
  await expect(sessionEffortToReapply(undefined, mustNotProbe)).resolves.toBeUndefined();
  await expect(sessionEffortToReapply("   ", mustNotProbe)).resolves.toBeUndefined();
});
