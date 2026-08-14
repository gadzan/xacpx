import { expect, test } from "bun:test";

import { sessionEffortToReapply } from "../../../src/transport/session-effort";

test("sessionEffortToReapply skips only when the live record matches and the owner is reused", () => {
  expect(sessionEffortToReapply({
    persisted: "high",
    observedCurrent: "medium",
    advertised: ["low", "medium", "high"],
    ownerWillBeReplaced: false,
  })).toBe("high");
  expect(sessionEffortToReapply({
    persisted: "  high  ",
    observedCurrent: "medium",
    advertised: ["high"],
    ownerWillBeReplaced: false,
  })).toBe("high");
  expect(sessionEffortToReapply({
    persisted: "high",
    observedCurrent: "high",
    advertised: ["medium", "high"],
    ownerWillBeReplaced: false,
  })).toBeUndefined();
  expect(sessionEffortToReapply({
    persisted: "high",
    observedCurrent: "high",
    advertised: ["medium", "high"],
    ownerWillBeReplaced: true,
  })).toBe("high");
  expect(sessionEffortToReapply({
    persisted: "xhigh",
    observedCurrent: "high",
    advertised: ["medium", "high"],
    ownerWillBeReplaced: false,
  })).toBeUndefined();
  expect(sessionEffortToReapply({
    persisted: undefined,
    observedCurrent: "medium",
    advertised: ["medium"],
    ownerWillBeReplaced: true,
  })).toBeUndefined();
  expect(sessionEffortToReapply({
    persisted: "   ",
    advertised: ["high"],
    ownerWillBeReplaced: true,
  })).toBeUndefined();
});
