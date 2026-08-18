import { expect, test } from "bun:test";

import { RelayAgentMessageRoute } from "../../../src/orchestration/relay-agent-message-route";
import type { AgentMessage } from "../../../src/orchestration/agent-messaging-types";

test("RelayAgentMessageRoute reports unavailable when constructed without client", async () => {
  const route = new RelayAgentMessageRoute();
  expect(route.isAvailable()).toBe(false);

  const message: AgentMessage = {
    id: "msg_1",
    from: { nodeId: "node_a", endpointId: "ep_a" },
    to: { nodeId: "node_b", endpointId: "ep_b" },
    content: "hello",
    requestedMode: "auto",
    createdAt: Date.now(),
  };

  await expect(route.send(message)).rejects.toThrow(
    "Remote route is unavailable",
  );
});

test("RelayAgentMessageRoute forwards to client and formats receipt", async () => {
  let capturedPayload: unknown = null;
  const route = new RelayAgentMessageRoute({
    sendAgentMessageRoute: async (payload) => {
      capturedPayload = payload;
      return {
        messageId: payload.messageId,
        status: "queued",
        modeUsed: "queue",
        targetState: "idle",
      };
    },
  });

  expect(route.isAvailable()).toBe(true);

  const message: AgentMessage = {
    id: "msg_2",
    from: { nodeId: "node_a", endpointId: "ep_a" },
    to: { nodeId: "node_b", endpointId: "ep_b" },
    content: "hello remote",
    requestedMode: "auto",
    createdAt: Date.now(),
    replyTo: "msg_orig",
  };

  const receipt = await route.send(message);
  expect(receipt.messageId).toBe("msg_2");
  expect(receipt.route).toBe("relay");
  expect(receipt.status).toBe("queued");
  expect(receipt.modeUsed).toBe("queue");
  expect(capturedPayload).toEqual({
    targetNodeId: "node_b",
    targetEndpointId: "ep_b",
    messageId: "msg_2",
    content: "hello remote",
    requestedMode: "auto",
    replyTo: "msg_orig",
  });
});
