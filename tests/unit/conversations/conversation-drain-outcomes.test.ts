import { expect, test } from "bun:test";
import { DrainOutcomeRegistry } from "../../../src/conversations/conversation-dispatcher";

/**
 * Review round 7: `launchedOutcomes` must not grow without bound.
 *
 * A single long Provider turn keeps its drain alive while other Topics complete
 * arbitrarily many short tasks. If settled successes stayed in the registry,
 * memory would grow with cumulative launches (not the concurrency ceiling) and
 * every failure scan would pay for all of that history. The registry drops a
 * success the moment it settles, keeps a pending cell that may still reject
 * (the late-failure case it exists for), and reports rejections in launch
 * order — including a rejection whose reason is legitimately `undefined`.
 */

test("fulfilled cells leave the registry so a long drain stays bounded", () => {
  const registry = new DrainOutcomeRegistry();
  const cells = Array.from({ length: 50 }, () => registry.track());
  expect(registry.size).toBe(50);
  // Settle all but one as successes, out of order: survivor order must not
  // matter for the size bound.
  for (let i = cells.length - 1; i >= 1; i--) {
    registry.fulfill(cells[i]!);
  }
  expect(registry.size).toBe(1);
  expect(registry.hasFailure()).toBe(false);
  // The survivor is still pending and may yet reject — the late-failure case.
  registry.reject(cells[0]!, new Error("late"));
  expect(registry.size).toBe(1);
  expect(registry.hasFailure()).toBe(true);
  expect((registry.firstFailure() as Error).message).toBe("late");
});

test("rejections report in launch order, not settlement order", () => {
  const registry = new DrainOutcomeRegistry();
  const first = registry.track();
  const second = registry.track();
  const third = registry.track();
  // Settle out of order: the second rejects first, the first rejects later.
  registry.fulfill(third);
  registry.reject(second, new Error("second"));
  registry.reject(first, new Error("first"));
  // Launch order wins, so the failure stays attributable.
  expect((registry.firstFailure() as Error).message).toBe("first");
  expect(registry.hasFailure()).toBe(true);
});

test("a rejection with an undefined reason still counts as a failure", () => {
  // `rejected` is a STATUS, not a payload test: a member execution may legally
  // reject with `undefined`, and the drain must still throw rather than resolve.
  const registry = new DrainOutcomeRegistry();
  const cell = registry.track();
  registry.reject(cell, undefined);
  expect(registry.hasFailure()).toBe(true);
  expect(registry.firstFailure()).toBeUndefined();
  expect(registry.size).toBe(1);
});

test("fulfilling an untracked cell only marks it, never corrupts the registry", () => {
  const registry = new DrainOutcomeRegistry();
  const tracked = registry.track();
  // Defensive: fulfill is keyed by identity, so a foreign cell cannot evict a
  // live one. The foreign cell is still marked fulfilled (it settled), but the
  // registry keeps exactly what it tracks.
  registry.fulfill({ status: "pending" });
  expect(registry.size).toBe(1);
  registry.fulfill(tracked);
  expect(registry.size).toBe(0);
  expect(registry.hasFailure()).toBe(false);
});
