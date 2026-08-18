import { expect, test } from "bun:test";

import {
  AgentMessageRouter,
  type LocalAgentMessageDelivery,
} from "../../../src/orchestration/agent-message-router";
import { RelayAgentMessageRoute } from "../../../src/orchestration/relay-agent-message-route";
import { encodeAgentHandle } from "../../../src/orchestration/agent-handle";
import type {
  AgentAddress,
  AgentEndpointView,
  AgentSenderBinding,
} from "../../../src/orchestration/agent-messaging-types";

test("Node A sends message to Node B across simulated Relay Hub", async () => {
  const nodeAAddress: AgentAddress = {
    nodeId: "node_A",
    endpointId: "worker_a1",
  };
  const nodeBAddress: AgentAddress = {
    nodeId: "node_B",
    endpointId: "worker_b1",
  };

  const deliveredToB: Array<{ messageId: string; content: string }> = [];

  // Simulated Relay Route from Node A
  const relayRouteA = new RelayAgentMessageRoute({
    sendAgentMessageRoute: async (payload) => {
      expect(payload.targetNodeId).toBe("node_B");
      expect(payload.targetEndpointId).toBe("worker_b1");
      // Simulate Relay Hub forwarding to Node B and Node B accepting delivery
      deliveredToB.push({
        messageId: payload.messageId,
        content: payload.content,
      });
      return {
        messageId: payload.messageId,
        status: "queued",
        modeUsed: "queue",
        targetState: "idle",
      };
    },
  });

  const nodeBEndpointView: AgentEndpointView = {
    address: nodeBAddress,
    handle: encodeAgentHandle(nodeBAddress),
    node: "node_B",
    agent: "codex",
    state: "idle",
    capabilities: {
      receive: true,
      steer: false,
      queue: true,
      interrupt: false,
    },
  };

  const registryA = {
    listReachable: async () => [nodeBEndpointView],
    resolveSender: async (_binding: AgentSenderBinding) => ({
      address: nodeAAddress,
      handle: encodeAgentHandle(nodeAAddress),
      node: "node_A",
      agent: "claude",
      state: "idle" as const,
      receive: true,
      coordinatorSession: "coord_main",
    }),
    resolveTarget: async (_sender: unknown, handle: string) => {
      if (handle === nodeBEndpointView.handle) {
        return {
          endpoint: nodeBEndpointView,
          target: { kind: "logical" as const, sessionName: "worker_b1" },
        };
      }
      throw new Error("Target not reachable");
    },
  };

  const localDeliveryA: LocalAgentMessageDelivery = {
    deliver: async () => {
      throw new Error("Should not be called for remote node");
    },
  };

  const routerA = new AgentMessageRouter({
    registry: registryA,
    delivery: localDeliveryA,
    remoteRoute: relayRouteA,
  });

  const receipt = await routerA.send(
    { coordinatorSession: "coord_main" },
    {
      to: nodeBEndpointView.handle,
      content: "Hello Node B from Node A via Relay",
      mode: "auto",
    },
  );

  expect(receipt.status).toBe("queued");
  expect(receipt.route).toBe("relay");
  expect(receipt.modeUsed).toBe("queue");
  expect(deliveredToB).toHaveLength(1);
  expect(deliveredToB[0]!.content).toBe("Hello Node B from Node A via Relay");
});

test("Node A receives fail-fast ROUTE_UNAVAILABLE when remote route is disconnected", async () => {
  const nodeAAddress: AgentAddress = {
    nodeId: "node_A",
    endpointId: "worker_a1",
  };
  const nodeBAddress: AgentAddress = {
    nodeId: "node_B",
    endpointId: "worker_b1",
  };

  const nodeBEndpointView: AgentEndpointView = {
    address: nodeBAddress,
    handle: encodeAgentHandle(nodeBAddress),
    node: "node_B",
    agent: "codex",
    state: "idle",
    capabilities: {
      receive: true,
      steer: false,
      queue: true,
      interrupt: false,
    },
  };

  const registryA = {
    listReachable: async () => [nodeBEndpointView],
    resolveSender: async (_binding: AgentSenderBinding) => ({
      address: nodeAAddress,
      handle: encodeAgentHandle(nodeAAddress),
      node: "node_A",
      agent: "claude",
      state: "idle" as const,
      receive: true,
      coordinatorSession: "coord_main",
    }),
    resolveTarget: async (_sender: unknown, _handle: string) => ({
      endpoint: nodeBEndpointView,
      target: { kind: "logical" as const, sessionName: "worker_b1" },
    }),
  };

  // Disconnected remote route (no client)
  const disconnectedRemoteRoute = new RelayAgentMessageRoute();

  const routerA = new AgentMessageRouter({
    registry: registryA,
    delivery: {
      deliver: async () => {
        throw new Error("Local");
      },
    },
    remoteRoute: disconnectedRemoteRoute,
  });

  await expect(
    routerA.send(
      { coordinatorSession: "coord_main" },
      {
        to: nodeBEndpointView.handle,
        content: "Hello",
      },
    ),
  ).rejects.toThrow("Remote route is unavailable");
});
