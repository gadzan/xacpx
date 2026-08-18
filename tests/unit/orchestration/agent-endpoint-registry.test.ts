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
