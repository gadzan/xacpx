import { expect, test } from "bun:test";

import { AgentMessagingError } from "../../../src/orchestration/agent-messaging-error";
import { AgentEndpointRegistry } from "../../../src/orchestration/agent-endpoint-registry";
import { encodeAgentHandle } from "../../../src/orchestration/agent-handle";
import { createEmptyState } from "../../../src/state/types";

const nodeId = "node_11111111-1111-4111-8111-111111111111";

function makeRegistry() {
  const state = createEmptyState();
  state.sessions.main = {
    alias: "main",
    agent: "codex",
    workspace: "project",
    transport_session: "coordinator",
    logical_session_id: "22222222-2222-4222-8222-222222222222",
    created_at: "2026-08-18T00:00:00.000Z",
    last_used_at: "2026-08-18T00:00:00.000Z",
  };
  state.orchestration.workerBindings.workerA = {
    sourceHandle: "workerA",
    agentEndpointId: "endpoint_worker-a",
    coordinatorSession: "coordinator",
    workspace: "project",
    targetAgent: "claude",
  };
  state.orchestration.workerBindings.workerB = {
    sourceHandle: "workerB",
    agentEndpointId: "endpoint_worker-b",
    coordinatorSession: "coordinator",
    workspace: "project",
    targetAgent: "gemini",
  };
  state.orchestration.workerBindings.otherWorker = {
    sourceHandle: "otherWorker",
    agentEndpointId: "endpoint_other-worker",
    coordinatorSession: "other-coordinator",
    workspace: "other",
    targetAgent: "codex",
  };
  state.orchestration.externalCoordinators.external = {
    coordinatorSession: "external",
    agentEndpointId: "endpoint_external",
    createdAt: "2026-08-18T00:00:00.000Z",
    updatedAt: "2026-08-18T00:00:00.000Z",
  };

  return {
    registry: new AgentEndpointRegistry({
      nodeId,
      loadState: async () => structuredClone(state),
    }),
    state,
  };
}

test("worker lists same-coordinator peers without private runtime metadata", async () => {
  const { registry } = makeRegistry();

  const endpoints = await registry.listReachable({
    coordinatorSession: "coordinator",
    sourceHandle: "workerA",
  });

  expect(endpoints.map((endpoint) => endpoint.address.endpointId)).toEqual([
    "22222222-2222-4222-8222-222222222222",
    "endpoint_worker-b",
  ]);
  expect(endpoints.every((endpoint) => endpoint.capabilities.receive)).toBe(
    true,
  );
  expect(endpoints.every((endpoint) => endpoint.capabilities.queue)).toBe(true);
  expect(
    endpoints.every((endpoint) => endpoint.capabilities.steer === false),
  ).toBe(true);
  expect(
    endpoints.every((endpoint) => endpoint.capabilities.interrupt === false),
  ).toBe(true);
  expect(endpoints.every((endpoint) => !("cwd" in endpoint))).toBe(true);
  expect(
    endpoints.some(
      (endpoint) => endpoint.address.endpointId === "endpoint_other-worker",
    ),
  ).toBe(false);
});

test("registry resolves an authorized peer and rejects self, foreign-node, and cross-coordinator handles", async () => {
  const { registry } = makeRegistry();
  const sender = await registry.resolveSender({
    coordinatorSession: "coordinator",
    sourceHandle: "workerA",
  });
  const peerHandle = encodeAgentHandle({
    nodeId,
    endpointId: "endpoint_worker-b",
  });

  await expect(
    registry.resolveTarget(sender, peerHandle),
  ).resolves.toMatchObject({
    endpoint: {
      address: { nodeId, endpointId: "endpoint_worker-b" },
      agent: "gemini",
    },
    runtime: {
      kind: "worker",
      workerSession: "workerB",
    },
  });

  await expect(
    registry.resolveTarget(sender, encodeAgentHandle(sender.address)),
  ).rejects.toMatchObject<Partial<AgentMessagingError>>({
    code: "SELF_MESSAGE_NOT_ALLOWED",
  });
  await expect(
    registry.resolveTarget(
      sender,
      encodeAgentHandle({
        nodeId: "node_33333333-3333-4333-8333-333333333333",
        endpointId: "endpoint_remote",
      }),
    ),
  ).rejects.toMatchObject<Partial<AgentMessagingError>>({
    code: "ROUTE_UNAVAILABLE",
  });
  await expect(
    registry.resolveTarget(
      sender,
      encodeAgentHandle({
        nodeId,
        endpointId: "endpoint_other-worker",
      }),
    ),
  ).rejects.toMatchObject<Partial<AgentMessagingError>>({
    code: "TARGET_NOT_REACHABLE",
  });
});

test("external coordinators resolve as send-capable but do not appear as receive targets", async () => {
  const { registry } = makeRegistry();

  const sender = await registry.resolveSender({
    coordinatorSession: "external",
    sourceHandle: "external",
  });

  expect(sender.receive).toBe(false);
  await expect(
    registry.listReachable({
      coordinatorSession: "external",
      sourceHandle: "external",
    }),
  ).resolves.toEqual([]);
});

test("unknown or stale sourceHandle must not fall back to coordinator identity", async () => {
  const { registry } = makeRegistry();

  // When sourceHandle is unknown / deleted, it must reject with DELIVERY_DENIED,
  // NEVER fall back to the logical coordinator "coordinator"
  await expect(
    registry.resolveSender({
      coordinatorSession: "coordinator",
      sourceHandle: "staleWorkerOld",
    }),
  ).rejects.toMatchObject<Partial<AgentMessagingError>>({
    code: "DELIVERY_DENIED",
  });
});

test("derives worker activity status and summary from orchestration task state", async () => {
  const { registry, state } = makeRegistry();
  // Set workerA role and workspace
  state.orchestration.workerBindings.workerA.role = "worker-a-role";
  state.orchestration.workerBindings.workerA.workspace = "worker-a-ws";

  // Initially workerA is idle
  let endpoints = await registry.listReachable({
    coordinatorSession: "coordinator",
    sourceHandle: "workerB",
  });
  const workerAIdle = endpoints.find((e) => e.address.endpointId === "endpoint_worker-a");
  expect(workerAIdle?.activity.status).toBe("idle");
  expect(workerAIdle?.activity.summary).toBe("Idle (worker-a-role)");
  expect(workerAIdle?.displayName).toBe("worker-a-role");
  expect(workerAIdle?.workspace).toBe("worker-a-ws");
  expect(workerAIdle?.capabilities.conversation).toBe(true);

  // Set task to running with summary
  state.orchestration.tasks.task1 = {
    taskId: "task_1",
    sourceHandle: "workerA",
    sourceKind: "coordinator",
    coordinatorSession: "coordinator",
    workerSession: "workerA",
    workspace: "worker-a-ws",
    targetAgent: "codex",
    task: "Secret raw prompt: write internal token to /tmp/secret",
    summary: "Implementing User OAuth Migration",
    status: "running",
    resultText: "",
    createdAt: "2026-08-18T00:00:00Z",
    updatedAt: "2026-08-18T00:00:00Z",
  };

  endpoints = await registry.listReachable({
    coordinatorSession: "coordinator",
    sourceHandle: "workerB",
  });
  const workerARunning = endpoints.find((e) => e.address.endpointId === "endpoint_worker-a");
  expect(workerARunning?.activity.status).toBe("working");
  expect(workerARunning?.activity.summary).toBe("Implementing User OAuth Migration");
  // Must NEVER expose the raw prompt text
  expect(JSON.stringify(workerARunning)).not.toContain("Secret raw prompt");

  // Set task to needs_confirmation (attention-required)
  state.orchestration.tasks.task1.status = "needs_confirmation";
  endpoints = await registry.listReachable({
    coordinatorSession: "coordinator",
    sourceHandle: "workerB",
  });
  const workerAWaiting = endpoints.find((e) => e.address.endpointId === "endpoint_worker-a");
  expect(workerAWaiting?.activity.status).toBe("waiting");
  expect(workerAWaiting?.activity.summary).toBe("Waiting for confirmation");
});

test("syncRemoteDirectorySnapshot preserves activity and conversation capabilities", async () => {
  const { registry } = makeRegistry();
  const remoteNode = "node_remote_2222";
  registry.syncRemoteDirectorySnapshot([
    {
      nodeId: remoteNode,
      endpointId: "ep_remote_1",
      displayName: "Remote API Worker",
      agent: "claude",
      workspace: "frontend",
      state: "running",
      activity: {
        status: "working",
        summary: "Refactoring Client Components",
      },
      capabilities: {
        receive: true,
        steer: false,
        queue: true,
        interrupt: false,
        conversation: true,
      },
    },
  ]);

  const endpoints = await registry.listReachable({
    coordinatorSession: "coordinator",
    sourceHandle: "workerA",
  });
  const remote = endpoints.find((e) => e.address.nodeId === remoteNode);
  expect(remote?.displayName).toBe("Remote API Worker");
  expect(remote?.workspace).toBe("frontend");
  expect(remote?.activity.status).toBe("working");
  expect(remote?.activity.summary).toBe("Refactoring Client Components");
  expect(remote?.capabilities.conversation).toBe(true);
});
