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

test("RelayAgentMessageRoute.sendCompletion throws ROUTE_UNAVAILABLE when client missing", async () => {
  const route = new RelayAgentMessageRoute();
  await expect(
    route.sendCompletion({
      requestMessageId: "msg_1",
      source: { nodeId: "nodeA", endpointId: "workerA" },
      target: { nodeId: "nodeB", endpointId: "workerB" },
      status: "completed",
      completedAt: Date.now(),
    }),
  ).rejects.toThrow("Remote completion route is unavailable");
});

test("RelayAgentMessageRoute.sendCompletion forwards to client and returns result", async () => {
  let captured: unknown = null;
  const route = new RelayAgentMessageRoute({
    sendAgentMessageRoute: async () => ({ messageId: "1", status: "queued" }),
    sendAgentMessageCompletion: async (payload) => {
      captured = payload;
      return { ok: true };
    },
  });

  const payload = {
    requestMessageId: "msg_100",
    source: { nodeId: "nodeA", endpointId: "workerA" },
    target: { nodeId: "nodeB", endpointId: "workerB" },
    status: "completed" as const,
    result: "Done",
    completedAt: 1700000000000,
  };
  const res = await route.sendCompletion(payload);
  expect(res.ok).toBe(true);
  expect(captured).toEqual(payload);
});

test("RelayAgentMessageRoute.sendCompletion retries ambiguous network failures", async () => {
  let attempts = 0;
  const route = new RelayAgentMessageRoute(
    {
      sendAgentMessageRoute: async () => ({ messageId: "1", status: "queued" }),
      sendAgentMessageCompletion: async () => {
        attempts += 1;
        if (attempts < 3) {
          throw new Error("WebSocket request timed out after 1000ms");
        }
        return { ok: true, deduplicated: true };
      },
    },
    { maxAttempts: 3, backoffMs: 1, delay: async () => undefined },
  );

  const res = await route.sendCompletion({
    requestMessageId: "msg_retry",
    source: { nodeId: "nodeA", endpointId: "workerA" },
    target: { nodeId: "nodeB", endpointId: "workerB" },
    status: "completed",
    completedAt: Date.now(),
  });
  expect(res.ok).toBe(true);
  expect(res.deduplicated).toBe(true);
  expect(attempts).toBe(3);
});
