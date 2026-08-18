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
    sourceNodeId: "node_a",
    sourceEndpointId: "ep_a",
    targetNodeId: "node_b",
    targetEndpointId: "ep_b",
    messageId: "msg_2",
    content: "hello remote",
    requestedMode: "auto",
    replyTo: "msg_orig",
  });
});

function sampleMessage(): AgentMessage {
  return {
    id: "msg_retry_1",
    from: { nodeId: "node_a", endpointId: "ep_a" },
    to: { nodeId: "node_b", endpointId: "ep_b" },
    content: "retry me",
    requestedMode: "auto",
    createdAt: Date.now(),
  };
}

test("RelayAgentMessageRoute retries ambiguous network failures reusing the SAME messageId", async () => {
  const attemptedPayloads: Array<{ messageId: string }> = [];
  let failuresRemaining = 1;
  const route = new RelayAgentMessageRoute(
    {
      sendAgentMessageRoute: async (payload) => {
        attemptedPayloads.push({ messageId: payload.messageId });
        if (failuresRemaining > 0) {
          failuresRemaining -= 1;
          // Ambiguous: the Hub could not confirm delivery (ACK lost).
          throw new Error("DELIVERY_FAILED");
        }
        return {
          messageId: payload.messageId,
          status: "queued",
          modeUsed: "queue",
          deduplicated: true,
        };
      },
    },
    // Deterministic backoff: no real timers.
    { maxAttempts: 3, backoffMs: 1, delay: async () => undefined },
  );

  const receipt = await route.send(sampleMessage());

  expect(attemptedPayloads).toHaveLength(2);
  // The retry MUST reuse the SAME messageId so the destination can deduplicate.
  expect(attemptedPayloads[0]!.messageId).toBe("msg_retry_1");
  expect(attemptedPayloads[1]!.messageId).toBe("msg_retry_1");
  expect(receipt.messageId).toBe("msg_retry_1");
  expect(receipt.status).toBe("queued");
  expect(receipt.route).toBe("relay");
  expect(receipt.deduplicated).toBe(true);
});

test("RelayAgentMessageRoute stops retrying after maxAttempts and throws", async () => {
  let attempts = 0;
  const route = new RelayAgentMessageRoute(
    {
      sendAgentMessageRoute: async (payload) => {
        attempts += 1;
        // "timeout" is ambiguous (the message may have been delivered) → retried
        // up to maxAttempts, then the typed error surfaces.
        throw new Error("timeout");
      },
    },
    { maxAttempts: 3, backoffMs: 1, delay: async () => undefined },
  );

  await expect(route.send(sampleMessage())).rejects.toMatchObject({
    code: "DELIVERY_FAILED",
  });
  expect(attempts).toBe(3);
});

test("RelayAgentMessageRoute fails fast on relay-offline without retrying", async () => {
  // relay-offline is DEFINITE (nothing left the process): the socket was not
  // ready, so a same-id retry can never have been injected — and the default
  // ~450ms retry window exhausts before the ~1s reconnect anyway. No retry.
  let attempts = 0;
  const route = new RelayAgentMessageRoute(
    {
      sendAgentMessageRoute: async () => {
        attempts += 1;
        throw new Error("relay-offline");
      },
    },
    { maxAttempts: 3, backoffMs: 1, delay: async () => undefined },
  );

  await expect(route.send(sampleMessage())).rejects.toMatchObject({
    code: "DELIVERY_FAILED",
  });
  expect(attempts).toBe(1);
});

test("RelayAgentMessageRoute does NOT retry typed business failures", async () => {
  let attempts = 0;
  const route = new RelayAgentMessageRoute(
    {
      sendAgentMessageRoute: async () => {
        attempts += 1;
        throw new Error("TARGET_NODE_OFFLINE");
      },
    },
    { maxAttempts: 3, backoffMs: 1, delay: async () => undefined },
  );

  await expect(route.send(sampleMessage())).rejects.toMatchObject({
    code: "TARGET_NODE_OFFLINE",
  });
  // Typed business failure: exactly one attempt, no retry.
  expect(attempts).toBe(1);
});

test("RelayAgentMessageRoute does NOT retry DELIVERY_DENIED", async () => {
  let attempts = 0;
  const route = new RelayAgentMessageRoute(
    {
      sendAgentMessageRoute: async () => {
        attempts += 1;
        throw new Error("DELIVERY_DENIED");
      },
    },
    { maxAttempts: 3, backoffMs: 1, delay: async () => undefined },
  );

  await expect(route.send(sampleMessage())).rejects.toMatchObject({
    code: "DELIVERY_DENIED",
  });
  expect(attempts).toBe(1);
});
