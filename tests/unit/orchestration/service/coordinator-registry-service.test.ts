import { expect, test } from "bun:test";

import { CoordinatorRegistryService } from "../../../../src/orchestration/service/coordinator-registry-service";
import { OrchestrationStateKernel } from "../../../../src/orchestration/service/orchestration-state-kernel";
import { WorkerSessionManager } from "../../../../src/orchestration/service/worker-session-manager";
import { makeGoldenHarness } from "../golden/golden-harness";

test("constructible with only its four ports and persists a coordinator route context", async () => {
  const harness = makeGoldenHarness();
  const kernel = new OrchestrationStateKernel({ logger: harness.deps.logger });
  const workerSessions = new WorkerSessionManager(harness.deps, kernel);
  const coordinators = new CoordinatorRegistryService(
    {
      now: harness.deps.now,
      loadState: harness.deps.loadState,
      saveState: harness.deps.saveState,
      config: harness.deps.config,
    },
    kernel,
    workerSessions,
  );

  const route = await coordinators.recordCoordinatorRouteContext({
    coordinatorSession: "backend:main",
    chatKey: "wx:abc",
    sessionAlias: "main",
    channel: "weixin",
    chatType: "direct",
    senderId: "u1",
  });

  expect(route.coordinatorSession).toBe("backend:main");
  expect(route.chatKey).toBe("wx:abc");
  expect(route.sessionAlias).toBe("main");
  expect(route.channel).toBe("weixin");
  expect(route.chatType).toBe("direct");
  expect(route.senderId).toBe("u1");
  expect(route.updatedAt).toBe("2026-04-13T10:00:00.000Z");

  const persisted = harness.getState().orchestration.coordinatorRoutes["backend:main"];
  expect(persisted).toBeDefined();
  expect(persisted!.chatKey).toBe("wx:abc");
  expect(persisted!.channel).toBe("weixin");
  expect(persisted!.senderId).toBe("u1");
});

test("registerExternalCoordinator throws when the session collides with a live worker-session reservation", async () => {
  const harness = makeGoldenHarness();
  const kernel = new OrchestrationStateKernel({ logger: harness.deps.logger });
  const workerSessions = new WorkerSessionManager(harness.deps, kernel);
  const coordinators = new CoordinatorRegistryService(
    {
      now: harness.deps.now,
      loadState: harness.deps.loadState,
      saveState: harness.deps.saveState,
      config: harness.deps.config,
    },
    kernel,
    workerSessions,
  );

  const session = "backend:main";
  // Hold a worker-session reservation open on the injected manager (do not release it).
  await workerSessions.reserveProposedWorkerSession(session);

  await expect(
    coordinators.registerExternalCoordinator({ coordinatorSession: session }),
  ).rejects.toThrow(`coordinatorSession "${session}" conflicts with an existing worker session`);
});
