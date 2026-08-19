import { expect, test } from "bun:test";

import { CoordinatorRegistryService } from "../../../../src/orchestration/service/coordinator-registry-service";
import { OrchestrationStateKernel } from "../../../../src/orchestration/service/orchestration-state-kernel";
import { WorkerSessionManager } from "../../../../src/orchestration/service/worker-session-manager";
import { buildFeishuRouteMetadata } from "../../../../packages/channel-feishu/src/inbound";
import { createScheduledTaskFromRoute } from "../../../../src/scheduled/scheduled-route-create";
import type { ResolvedSession } from "../../../../src/transport/types";
import type { ScheduledTaskRecord } from "../../../../src/scheduled/scheduled-types";
import { makeGoldenHarness } from "../golden/golden-harness";

test("constructible with only its five ports and persists a coordinator route context", async () => {
  const harness = makeGoldenHarness();
  const kernel = new OrchestrationStateKernel({ logger: harness.deps.logger });
  const workerSessions = new WorkerSessionManager(harness.deps, kernel);
  const coordinators = new CoordinatorRegistryService(
    {
      now: harness.deps.now,
      createAgentEndpointId: harness.deps.createAgentEndpointId,
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

test("registerExternalCoordinator mints and preserves its endpoint identity", async () => {
  const harness = makeGoldenHarness({ endpointIds: ["external-endpoint-1"] });
  const kernel = new OrchestrationStateKernel({ logger: harness.deps.logger });
  const workerSessions = new WorkerSessionManager(harness.deps, kernel);
  const coordinators = new CoordinatorRegistryService(
    {
      now: harness.deps.now,
      createAgentEndpointId: harness.deps.createAgentEndpointId,
      loadState: harness.deps.loadState,
      saveState: harness.deps.saveState,
      config: harness.deps.config,
    },
    kernel,
    workerSessions,
  );

  const first = await coordinators.registerExternalCoordinator({ coordinatorSession: "external:main" });
  const second = await coordinators.registerExternalCoordinator({ coordinatorSession: "external:main" });

  expect(first.agentEndpointId).toBe("endpoint_external-endpoint-1");
  expect(second.agentEndpointId).toBe(first.agentEndpointId);
});

test("registerExternalCoordinator throws when the session collides with a live worker-session reservation", async () => {
  const harness = makeGoldenHarness();
  const kernel = new OrchestrationStateKernel({ logger: harness.deps.logger });
  const workerSessions = new WorkerSessionManager(harness.deps, kernel);
  const coordinators = new CoordinatorRegistryService(
    {
      now: harness.deps.now,
      createAgentEndpointId: harness.deps.createAgentEndpointId,
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

test("member turn overwrites a stale owner route and scheduled_create stays owner-gated", async () => {
  // Cross-layer regression for the trustGroupOwner stale-owner bug: the
  // coordinator route merges with `input.isOwner ?? existing.isOwner`, so a
  // group turn that OMITS isOwner inherits the previous owner turn's true.
  // The Feishu plugin therefore emits an explicit boolean on every group turn.
  const harness = makeGoldenHarness();
  const kernel = new OrchestrationStateKernel({ logger: harness.deps.logger });
  const workerSessions = new WorkerSessionManager(harness.deps, kernel);
  const coordinators = new CoordinatorRegistryService(
    {
      now: harness.deps.now,
      createAgentEndpointId: harness.deps.createAgentEndpointId,
      loadState: harness.deps.loadState,
      saveState: harness.deps.saveState,
      config: harness.deps.config,
    },
    kernel,
    workerSessions,
  );
  const chatKey = "feishu:default:oc_group";

  // 1. Owner turn records the route.
  await coordinators.recordCoordinatorRouteContext({
    coordinatorSession: "backend:demo",
    chatKey,
    sessionAlias: "demo",
    ...buildFeishuRouteMetadata({ chatType: "group", senderOpenId: "ou_owner", chatId: "oc_group", senderIsOwner: true }),
  });
  let persisted = harness.getState().orchestration.coordinatorRoutes["backend:demo"];
  expect(persisted!.isOwner).toBe(true);

  // 2. A member turn in the same group/session - owner lookup resolved false.
  await coordinators.recordCoordinatorRouteContext({
    coordinatorSession: "backend:demo",
    chatKey,
    sessionAlias: "demo",
    ...buildFeishuRouteMetadata({ chatType: "group", senderOpenId: "ou_member", chatId: "oc_group", senderIsOwner: false }),
  });
  persisted = harness.getState().orchestration.coordinatorRoutes["backend:demo"];
  expect(persisted!.senderId).toBe("ou_member");
  expect(persisted!.isOwner).toBe(false);

  // 3. The scheduled_* tools read exactly this route: the member must not be
  // able to schedule through the previously-owner-recorded route.
  const session: ResolvedSession = {
    alias: "demo",
    agent: "codex",
    workspace: "backend",
    transportSession: "backend:demo",
    cwd: "/repo/backend",
  };
  await expect(
    createScheduledTaskFromRoute(
      { coordinatorSession: "backend:demo", timeText: "in 10m", message: "do X" },
      {
        state: harness.getState(),
        config: { later: { defaultMode: "temp" } },
        sessions: { getSession: async () => session, getPreferredSessionForTransport: async () => session },
        scheduled: { createTask: async (input) => taskFromScheduledInput(input) },
        now: () => new Date("2026-04-13T10:00:00.000Z"),
      },
    ),
  ).rejects.toThrow("scheduled_create is owner-only in group chats");

  // 4. Sanity: the owner's own route still passes the gate.
  await coordinators.recordCoordinatorRouteContext({
    coordinatorSession: "backend:demo",
    chatKey,
    sessionAlias: "demo",
    ...buildFeishuRouteMetadata({ chatType: "group", senderOpenId: "ou_owner", chatId: "oc_group", senderIsOwner: true }),
  });
  const created = await createScheduledTaskFromRoute(
    { coordinatorSession: "backend:demo", timeText: "in 10m", message: "do X" },
    {
      state: harness.getState(),
      config: { later: { defaultMode: "temp" } },
      sessions: { getSession: async () => session, getPreferredSessionForTransport: async () => session },
      scheduled: { createTask: async (input) => taskFromScheduledInput(input) },
      now: () => new Date("2026-04-13T10:00:00.000Z"),
    },
  );
  expect(created.session_alias).toBe("demo");
});

function taskFromScheduledInput(input: { chatKey: string; sessionAlias: string; executeAt: Date; message: string }): ScheduledTaskRecord {
  return {
    id: "k8f2",
    chat_key: input.chatKey,
    session_alias: input.sessionAlias,
    execute_at: input.executeAt.toISOString(),
    message: input.message,
    status: "pending",
    created_at: "2026-04-13T10:00:00.000Z",
  };
}
