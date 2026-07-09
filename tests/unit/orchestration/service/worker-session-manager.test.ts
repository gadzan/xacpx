import { expect, test } from "bun:test";

import { OrchestrationStateKernel } from "../../../../src/orchestration/service/orchestration-state-kernel";
import { WorkerSessionManager } from "../../../../src/orchestration/service/worker-session-manager";
import { createConfig } from "../../commands/command-router-test-support";
import { createEmptyState } from "../../../../src/state/types";
import { makeGoldenHarness } from "../golden/golden-harness";

test("pendingParallelStarts is instance-scoped, not module-global", async () => {
  // CONTROLLER NOTE: the plan's original version of this test reserved a *worker session*
  // and then compared `canStartParallelTask` across two managers. That asserted nothing:
  // reserveProposedWorkerSession writes `pendingWorkerSessions`, while canStartParallelTask
  // reads `pendingParallelStarts`. Both managers returned the same value no matter what.
  //
  // This version exercises the map that actually gates dispatch. With the agent's cap set
  // to 1 and empty state, one claimed start must fill the slot on `manager` and leave
  // `other` seeing it free. That divergence IS the bug a facade with two managers ships:
  // both would pass the gate for the same slot and over-dispatch at capacity.
  const config = createConfig();
  config.orchestration.maxParallelTasksPerAgent = 1;
  const harness = makeGoldenHarness({ config });
  const kernel = new OrchestrationStateKernel({ logger: harness.deps.logger });
  const manager = new WorkerSessionManager(harness.deps, kernel);
  const other = new WorkerSessionManager(harness.deps, kernel);

  const state = await harness.deps.loadState();
  expect(manager.canStartParallelTask(state, "claude")).toBe(true);

  manager.claimParallelStart("claude");

  expect(manager.canStartParallelTask(state, "claude")).toBe(false);
  expect(other.canStartParallelTask(state, "claude")).toBe(true);

  manager.releaseParallelStart("claude");
  expect(manager.canStartParallelTask(state, "claude")).toBe(true);
});

test("the facade constructs exactly one WorkerSessionManager", async () => {
  // This asserts on source text, which is normally a smell. It is deliberate, and it is
  // the only test in this suite that can catch the bug it targets: the facade constructing
  // two WorkerSessionManagers and handing different ones to different services, so each
  // keeps its own pendingParallelStarts counter and both pass the capacity gate for the
  // same slot.
  const source = await Bun.file("src/orchestration/orchestration-service.ts").text();
  const constructions = source.match(/new WorkerSessionManager\(/g) ?? [];
  expect(constructions.length).toBe(1);
});

test("reserveLogicalTransportSession refcounts; it does not lock", async () => {
  // Established by the Task 5 golden fixture: there is NO exclusivity guard. The method
  // increments an in-memory refcount and throws only when the session name collides with a
  // registered external coordinator. A second reservation of the same session SUCCEEDS.
  // The release function is async and decrements; it is idempotent (a second call no-ops).
  const harness = makeGoldenHarness();
  const kernel = new OrchestrationStateKernel({ logger: harness.deps.logger });
  const manager = new WorkerSessionManager(harness.deps, kernel);

  const first = await manager.reserveLogicalTransportSession("backend:claude:logical-1");
  const second = await manager.reserveLogicalTransportSession("backend:claude:logical-1");
  expect(typeof second).toBe("function");

  await first();
  await first(); // idempotent
  await second();
});

test("reserveLogicalTransportSession rejects a name owned by an external coordinator", async () => {
  // The ONLY branch of reserveLogicalTransportSession that throws. Seed a real
  // externalCoordinators entry — a bare loadState/saveState round-trip seeds nothing and
  // the reservation would succeed, failing this test for the wrong reason.
  const seed = createEmptyState();
  seed.orchestration.externalCoordinators = {
    "backend:main": {
      coordinatorSession: "backend:main",
      createdAt: "2026-04-13T10:00:00.000Z",
      updatedAt: "2026-04-13T10:00:00.000Z",
    },
  };
  const harness = makeGoldenHarness({ initialState: seed });
  const kernel = new OrchestrationStateKernel({ logger: harness.deps.logger });
  const manager = new WorkerSessionManager(harness.deps, kernel);

  await expect(
    manager.reserveLogicalTransportSession("backend:main"),
  ).rejects.toThrow(/external coordinator/);
});
