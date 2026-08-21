import { expect, test } from "bun:test";

import type { AppLogger } from "../../../src/logging/app-logger";
import { createControlEventBus, type ControlEvent, type ControlEventBus } from "../../../src/control/control-event-bus";
import {
  AgentEndpointRegistry,
  type ResolvedAgentEndpoint,
} from "../../../src/orchestration/agent-endpoint-registry";
import { encodeAgentHandle } from "../../../src/orchestration/agent-handle";
import {
  AgentMessageRouter,
  type AgentMessageRouterLimits,
} from "../../../src/orchestration/agent-message-router";
import { AgentMessagingError } from "../../../src/orchestration/agent-messaging-error";
import type { AgentMessage } from "../../../src/orchestration/agent-messaging-types";
import type { SessionMessageReceipt } from "../../../src/transport/message-injection";
import { MessageInjectionError } from "../../../src/transport/message-injection";
import { createEmptyState } from "../../../src/state/types";

const nodeId = "node_11111111-1111-4111-8111-111111111111";

function makeRouter(
  options: {
    deliver?: (
      target: ResolvedAgentEndpoint,
      message: AgentMessage,
      renderedText: string,
    ) => Promise<SessionMessageReceipt>;
    createId?: () => string;
    limits?: AgentMessageRouterLimits;
    now?: () => number;
    logger?: Pick<AppLogger, "info">;
    events?: ControlEventBus;
  } = {},
) {
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
  state.orchestration.workerBindings.workerC = {
    sourceHandle: "workerC",
    agentEndpointId: "endpoint_worker-c",
    coordinatorSession: "coordinator",
    workspace: "project",
    targetAgent: "codex",
  };
  state.orchestration.workerBindings.externalWorker = {
    sourceHandle: "externalWorker",
    agentEndpointId: "endpoint_external-worker",
    coordinatorSession: "external-coordinator",
    workspace: "project",
    targetAgent: "codex",
  };
  state.orchestration.externalCoordinators["external-coordinator"] = {
    coordinatorSession: "external-coordinator",
    agentEndpointId: "endpoint_external",
    createdAt: "2026-08-18T00:00:00.000Z",
    updatedAt: "2026-08-18T00:00:00.000Z",
  };

  const registry = new AgentEndpointRegistry({
    nodeId,
    loadState: async () => structuredClone(state),
  });
  const deliveries: Array<{ message: AgentMessage; renderedText: string }> = [];
  const router = new AgentMessageRouter({
    registry,
    delivery: {
      deliver: async (target, message, renderedText) => {
        deliveries.push({ message, renderedText });
        return await (options.deliver?.(target, message, renderedText) ??
          Promise.resolve({
            status: "queued" as const,
            modeUsed: "queue" as const,
          }));
      },
    },
    createId: options.createId ?? (() => "message-1"),
    now: options.now ?? (() => 1_000),
    limits: options.limits,
    logger: options.logger,
    events: options.events,
  });

  return { router, deliveries, state };
}

test("lists only the current sender's reachable peer endpoints", async () => {
  const { router } = makeRouter();

  const endpoints = await router.listReachable({
    coordinatorSession: "coordinator",
    sourceHandle: "workerA",
  });

  expect(endpoints.map((endpoint) => endpoint.address.endpointId)).toEqual([
    "22222222-2222-4222-8222-222222222222",
    "endpoint_worker-b",
    "endpoint_worker-c",
  ]);
});

test("sends an auto message as an escaped one-way queue delivery", async () => {
  const { router, deliveries } = makeRouter();

  const receipt = await router.send(
    { coordinatorSession: "coordinator", sourceHandle: "workerA" },
    {
      to: encodeAgentHandle({ nodeId, endpointId: "endpoint_worker-b" }),
      content: "Use <schema> & tests.",
    },
  );

  expect(receipt).toEqual({
    messageId: "msg_message-1",
    status: "queued",
    modeUsed: "queue",
    route: "local",
  });
  expect(deliveries).toEqual([
    {
      message: {
        id: "msg_message-1",
        conversationId: "msg_message-1",
        depth: 0,
        from: { nodeId, endpointId: "endpoint_worker-a" },
        to: { nodeId, endpointId: "endpoint_worker-b" },
        content: "Use <schema> & tests.",
        requestedMode: "auto",
        createdAt: 1_000,
      },
      renderedText:
        '<xacpx-message id="msg_message-1" ' +
        'conversation-id="msg_message-1" ' +
        'from="agent:node_11111111-1111-4111-8111-111111111111:endpoint_worker-a" ' +
        'replyable="true">\n' +
        "Use &lt;schema&gt; &amp; tests.\n" +
        "</xacpx-message>",
    },
  ]);
});

test("rejects an oversized Unicode message before resolving the target", async () => {
  const { router } = makeRouter();

  await expect(
    router.send(
      { coordinatorSession: "coordinator", sourceHandle: "workerA" },
      { to: "not-a-handle", content: "界".repeat(5_462) },
    ),
  ).rejects.toMatchObject<Partial<AgentMessagingError>>({
    code: "MESSAGE_TOO_LARGE",
  });
});

test("rejects unsafe reply correlation ids before resolving the target", async () => {
  const { router } = makeRouter();

  await expect(
    router.send(
      { coordinatorSession: "coordinator", sourceHandle: "workerA" },
      { to: "not-a-handle", content: "hello", replyTo: "msg_bad!" },
    ),
  ).rejects.toMatchObject<Partial<AgentMessagingError>>({
    code: "DELIVERY_DENIED",
  });
});

test("rejects reply correlation ids over 128 bytes", async () => {
  const { router } = makeRouter();

  await expect(
    router.send(
      { coordinatorSession: "coordinator", sourceHandle: "workerA" },
      {
        to: encodeAgentHandle({ nodeId, endpointId: "endpoint_worker-b" }),
        content: "hello",
        replyTo: "m".repeat(129),
      },
    ),
  ).rejects.toMatchObject<Partial<AgentMessagingError>>({
    code: "MESSAGE_TOO_LARGE",
  });
});

test("strict steer fails without invoking queue delivery", async () => {
  const { router, deliveries } = makeRouter();

  await expect(
    router.send(
      { coordinatorSession: "coordinator", sourceHandle: "workerA" },
      {
        to: encodeAgentHandle({ nodeId, endpointId: "endpoint_worker-b" }),
        content: "change direction",
        mode: "steer",
      },
    ),
  ).rejects.toMatchObject<Partial<AgentMessagingError>>({
    code: "TARGET_NOT_STEERABLE",
  });
  expect(deliveries).toEqual([]);
});

test("explicit interrupt fails when the target cannot interrupt", async () => {
  const { router, deliveries } = makeRouter();

  await expect(
    router.send(
      { coordinatorSession: "coordinator", sourceHandle: "workerA" },
      {
        to: encodeAgentHandle({ nodeId, endpointId: "endpoint_worker-b" }),
        content: "stop now",
        mode: "interrupt",
      },
    ),
  ).rejects.toMatchObject<Partial<AgentMessagingError>>({
    code: "TARGET_NOT_INTERRUPTIBLE",
  });
  expect(deliveries).toEqual([]);
});

test("explicit queue mode remains a next-turn queue request", async () => {
  const { router, deliveries } = makeRouter();

  await router.send(
    { coordinatorSession: "coordinator", sourceHandle: "workerA" },
    {
      to: encodeAgentHandle({ nodeId, endpointId: "endpoint_worker-b" }),
      content: "read this next",
      mode: "queue",
    },
  );

  expect(deliveries[0]?.message.requestedMode).toBe("queue");
});

test("serializes concurrent deliveries to the same target", async () => {
  const firstDelivery = createDeferred<void>();
  const started: string[] = [];
  let nextId = 0;
  const { router } = makeRouter({
    createId: () => `message-${++nextId}`,
    deliver: async (_target, message) => {
      started.push(message.content);
      if (message.content === "first") {
        await firstDelivery.promise;
      }
      return { status: "queued", modeUsed: "queue" };
    },
  });
  const to = encodeAgentHandle({ nodeId, endpointId: "endpoint_worker-b" });

  const first = router.send(
    { coordinatorSession: "coordinator", sourceHandle: "workerA" },
    { to, content: "first" },
  );
  const second = router.send(
    { coordinatorSession: "coordinator", sourceHandle: "workerA" },
    { to, content: "second" },
  );
  await waitUntil(() => started.length > 0);

  expect(started).toEqual(["first"]);
  firstDelivery.resolve();
  await Promise.all([first, second]);
  expect(started).toEqual(["first", "second"]);
});

test("keeps one target FIFO across different authorized senders", async () => {
  const firstDelivery = createDeferred<void>();
  const started: string[] = [];
  let nextId = 0;
  const { router } = makeRouter({
    createId: () => `message-${++nextId}`,
    deliver: async (_target, message) => {
      started.push(message.content);
      if (message.content === "worker first") await firstDelivery.promise;
      return { status: "queued", modeUsed: "queue" };
    },
  });
  const to = encodeAgentHandle({ nodeId, endpointId: "endpoint_worker-b" });

  const fromWorker = router.send(
    { coordinatorSession: "coordinator", sourceHandle: "workerA" },
    { to, content: "worker first" },
  );
  const fromCoordinator = router.send(
    { coordinatorSession: "coordinator" },
    { to, content: "coordinator second" },
  );
  await waitUntil(() => started.length > 0);

  expect(started).toEqual(["worker first"]);
  firstDelivery.resolve();
  await Promise.all([fromWorker, fromCoordinator]);
  expect(started).toEqual(["worker first", "coordinator second"]);
});

test("allows deliveries to different targets to proceed in parallel", async () => {
  const workerDelivery = createDeferred<void>();
  const started: string[] = [];
  let nextId = 0;
  const { router } = makeRouter({
    createId: () => `message-${++nextId}`,
    deliver: async (target) => {
      started.push(target.endpoint.address.endpointId);
      if (target.endpoint.address.endpointId === "endpoint_worker-b") {
        await workerDelivery.promise;
      }
      return { status: "queued", modeUsed: "queue" };
    },
  });

  const worker = router.send(
    { coordinatorSession: "coordinator", sourceHandle: "workerA" },
    {
      to: encodeAgentHandle({ nodeId, endpointId: "endpoint_worker-b" }),
      content: "worker",
    },
  );
  const coordinator = router.send(
    { coordinatorSession: "coordinator", sourceHandle: "workerA" },
    {
      to: encodeAgentHandle({
        nodeId,
        endpointId: "22222222-2222-4222-8222-222222222222",
      }),
      content: "coordinator",
    },
  );
  await waitUntil(() => started.length === 2);

  expect(started).toContain("endpoint_worker-b");
  expect(started).toContain("22222222-2222-4222-8222-222222222222");
  workerDelivery.resolve();
  await Promise.all([worker, coordinator]);
});

test("rejects a delivery when the target pending depth is full", async () => {
  const firstDelivery = createDeferred<void>();
  let deliveryCount = 0;
  let nextId = 0;
  const { router } = makeRouter({
    createId: () => `message-${++nextId}`,
    limits: { maxPendingPerTarget: 2 },
    deliver: async () => {
      deliveryCount += 1;
      if (deliveryCount === 1) await firstDelivery.promise;
      return { status: "queued", modeUsed: "queue" };
    },
  });
  const to = encodeAgentHandle({ nodeId, endpointId: "endpoint_worker-b" });

  const first = router.send(
    { coordinatorSession: "coordinator", sourceHandle: "workerA" },
    { to, content: "first" },
  );
  const second = router.send(
    { coordinatorSession: "coordinator", sourceHandle: "workerA" },
    { to, content: "second" },
  );
  const third = router.send(
    { coordinatorSession: "coordinator", sourceHandle: "workerA" },
    { to, content: "third" },
  );
  firstDelivery.resolve();

  await expect(third).rejects.toMatchObject<Partial<AgentMessagingError>>({
    code: "MESSAGE_QUEUE_FULL",
  });
  await Promise.all([first, second]);
  expect(deliveryCount).toBe(2);
});

test("rate limits repeated deliveries from one sender to one target", async () => {
  let nextId = 0;
  const { router, deliveries } = makeRouter({
    createId: () => `message-${++nextId}`,
    limits: {
      rateLimit: { maxMessages: 2, windowMs: 1_000 },
    },
  });
  const binding = {
    coordinatorSession: "coordinator",
    sourceHandle: "workerA",
  };
  const to = encodeAgentHandle({ nodeId, endpointId: "endpoint_worker-b" });

  await router.send(binding, { to, content: "one" });
  await router.send(binding, { to, content: "two" });
  await expect(
    router.send(binding, { to, content: "three" }),
  ).rejects.toMatchObject<Partial<AgentMessagingError>>({
    code: "MESSAGE_RATE_LIMITED",
  });
  expect(deliveries).toHaveLength(2);
});

test("deduplicates a repeated generated message id without a second injection", async () => {
  const { router, deliveries } = makeRouter({
    createId: () => "same-id",
  });
  const binding = {
    coordinatorSession: "coordinator",
    sourceHandle: "workerA",
  };
  const to = encodeAgentHandle({ nodeId, endpointId: "endpoint_worker-b" });

  const first = await router.send(binding, { to, content: "only once" });
  const duplicate = await router.send(binding, { to, content: "only once" });

  expect(first).toEqual({
    messageId: "msg_same-id",
    status: "queued",
    modeUsed: "queue",
    route: "local",
  });
  expect(duplicate).toEqual({ ...first, deduplicated: true });
  expect(deliveries).toHaveLength(1);
});

test("does not cache a rejected in-flight delivery as an accepted receipt", async () => {
  let attempts = 0;
  const { router } = makeRouter({
    createId: () => "retry-id",
    deliver: async () => {
      attempts += 1;
      if (attempts === 1) throw new Error("transient failure");
      return { status: "queued", modeUsed: "queue" };
    },
  });
  const binding = {
    coordinatorSession: "coordinator",
    sourceHandle: "workerA",
  };
  const input = {
    to: encodeAgentHandle({ nodeId, endpointId: "endpoint_worker-b" }),
    content: "retry me",
  };

  await expect(router.send(binding, input)).rejects.toMatchObject({
    code: "DELIVERY_FAILED",
  });
  await expect(router.send(binding, input)).resolves.toMatchObject({
    messageId: "msg_retry-id",
    status: "queued",
  });
  expect(attempts).toBe(2);
});

test("single-flights concurrent inbound duplicates without a second injection", async () => {
  // The source retry arrives while the FIRST delivery is still executing (ACK
  // lost / socket dropped): the receipt cache has not been written yet, so only
  // the in-flight single-flight map can stop the duplicate injection.
  const gate = createDeferred<void>();
  let deliveryCount = 0;
  const { router } = makeRouter({
    deliver: async () => {
      deliveryCount += 1;
      await gate.promise;
      return { status: "queued", modeUsed: "queue" };
    },
  });
  const input = {
    sourceNodeId: "node_remote",
    sourceEndpointId: "endpoint_remote",
    targetEndpointId: "endpoint_worker-b",
    messageId: "msg_inflight_1",
    content: "concurrent retry",
    requestedMode: "auto",
    replyable: true,
  };

  const first = router.deliverInbound(input);
  const second = router.deliverInbound(input);
  await waitUntil(() => deliveryCount === 1);

  // The second call joined the in-flight promise: still exactly one injection.
  expect(deliveryCount).toBe(1);

  gate.resolve();
  const [receiptFirst, receiptSecond] = await Promise.all([first, second]);

  expect(receiptFirst.status).toBe("queued");
  expect(receiptFirst.deduplicated).toBeUndefined();
  expect(receiptSecond).toEqual({ ...receiptFirst, deduplicated: true });
  expect(deliveryCount).toBe(1);
});

test("rejects a concurrent messageId reuse with a different payload", async () => {
  const gate = createDeferred<void>();
  let deliveryCount = 0;
  const { router } = makeRouter({
    deliver: async () => {
      deliveryCount += 1;
      await gate.promise;
      return { status: "queued", modeUsed: "queue" };
    },
  });
  const base = {
    sourceNodeId: "node_remote",
    sourceEndpointId: "endpoint_remote",
    targetEndpointId: "endpoint_worker-b",
    messageId: "msg_inflight_2",
    requestedMode: "auto",
    replyable: true,
  };

  const first = router.deliverInbound({ ...base, content: "original" });
  await waitUntil(() => deliveryCount === 1);

  // Same id but different content: not a retry — a different message reusing
  // the id. Never join/cache-return it.
  await expect(
    router.deliverInbound({ ...base, content: "tampered" }),
  ).rejects.toMatchObject({ code: "DELIVERY_DENIED" });

  gate.resolve();
  await first;
  expect(deliveryCount).toBe(1);
});

test("tombstones an ambiguous failed inbound delivery so a same-id retry never re-injects", async () => {
  // The acpx queue owner may already have enqueued the message when the local
  // ACK is lost (injectMessage uses only input.text; the queue owner never sees
  // the messageId, so only the destination can dedupe). The terminal failure
  // must be cached as a tombstone: a same-id retry returns the SAME failure
  // instead of calling the delivery adapter again.
  let deliveryCount = 0;
  const { router } = makeRouter({
    deliver: async () => {
      deliveryCount += 1;
      throw new MessageInjectionError("DELIVERY_TIMEOUT", "ambiguous ack loss");
    },
  });
  const input = {
    sourceNodeId: "node_remote",
    sourceEndpointId: "endpoint_remote",
    targetEndpointId: "endpoint_worker-b",
    messageId: "msg_failed_1",
    content: "retry after ambiguous failure",
    requestedMode: "auto",
    replyable: true,
  };

  await expect(router.deliverInbound(input)).rejects.toMatchObject({
    code: "DELIVERY_TIMEOUT",
  });
  // Retry with the same messageId: tombstone hit → same failure, no re-inject.
  await expect(router.deliverInbound(input)).rejects.toMatchObject({
    code: "DELIVERY_TIMEOUT",
  });
  expect(deliveryCount).toBe(1);
});

test("rejects a completed messageId reuse with a different payload", async () => {
  const { router, deliveries } = makeRouter();
  const input = {
    sourceNodeId: "node_remote",
    sourceEndpointId: "endpoint_remote",
    targetEndpointId: "endpoint_worker-b",
    messageId: "msg_completed_1",
    requestedMode: "auto",
    replyable: true,
  };

  const first = await router.deliverInbound({ ...input, content: "original" });
  expect(first.deduplicated).toBeUndefined();

  // Same id, different content, AFTER completion: the outcome cache stores the
  // fingerprint, so this is DELIVERY_DENIED — not a stale cached receipt.
  await expect(
    router.deliverInbound({ ...input, content: "tampered" }),
  ).rejects.toMatchObject({ code: "DELIVERY_DENIED" });
  expect(deliveries).toHaveLength(1);
});

test("expires cached receipts after the configured dedupe TTL", async () => {
  let clock = 1_000;
  const { router, deliveries } = makeRouter({
    createId: () => "expiring-id",
    now: () => clock,
    limits: {
      receiptCache: { maxEntries: 4, ttlMs: 100 },
      duplicateContentWindowMs: 50,
    },
  });
  const binding = {
    coordinatorSession: "coordinator",
    sourceHandle: "workerA",
  };
  const input = {
    to: encodeAgentHandle({ nodeId, endpointId: "endpoint_worker-b" }),
    content: "fresh context",
  };

  await router.send(binding, input);
  clock = 1_101;
  const receipt = await router.send(binding, input);

  expect(receipt.deduplicated).toBeUndefined();
  expect(deliveries).toHaveLength(2);
});

test("bounds the receipt cache by evicting its oldest accepted receipt", async () => {
  const ids = ["old", "new", "old"];
  const { router, deliveries } = makeRouter({
    createId: () => ids.shift() ?? "unexpected",
    limits: {
      receiptCache: { maxEntries: 1, ttlMs: 10_000 },
    },
  });
  const binding = {
    coordinatorSession: "coordinator",
    sourceHandle: "workerA",
  };
  const to = encodeAgentHandle({ nodeId, endpointId: "endpoint_worker-b" });

  await router.send(binding, { to, content: "old" });
  await router.send(binding, { to, content: "new" });
  const oldAgain = await router.send(binding, { to, content: "old again" });

  expect(oldAgain.deduplicated).toBeUndefined();
  expect(deliveries).toHaveLength(3);
});

test("maps a transport timeout to a stable error without leaking diagnostics", async () => {
  const { router } = makeRouter({
    deliver: async () => {
      throw new MessageInjectionError(
        "DELIVERY_TIMEOUT",
        "timed out writing /private/tmp/xacpx-secret.sock --token secret",
      );
    },
  });

  try {
    await router.send(
      { coordinatorSession: "coordinator", sourceHandle: "workerA" },
      {
        to: encodeAgentHandle({ nodeId, endpointId: "endpoint_worker-b" }),
        content: "hello",
      },
    );
    throw new Error("expected send to fail");
  } catch (error) {
    expect(error).toBeInstanceOf(AgentMessagingError);
    expect(error).toMatchObject({ code: "DELIVERY_TIMEOUT" });
    expect((error as Error).message).not.toContain("/private/tmp");
    expect((error as Error).message).not.toContain("secret");
  }
});

test.each([
  "TARGET_NOT_RUNNING",
  "TARGET_NOT_STEERABLE",
  "TARGET_NOT_INTERRUPTIBLE",
  "DELIVERY_RACE",
  "DELIVERY_FAILED",
] as const)(
  "preserves the typed transport outcome %s at the router seam",
  async (code) => {
    const { router } = makeRouter({
      deliver: async () => {
        throw new MessageInjectionError(code, "private transport detail");
      },
    });

    await expect(
      router.send(
        { coordinatorSession: "coordinator", sourceHandle: "workerA" },
        {
          to: encodeAgentHandle({ nodeId, endpointId: "endpoint_worker-b" }),
          content: "hello",
        },
      ),
    ).rejects.toMatchObject<Partial<AgentMessagingError>>({ code });
  },
);

test("propagates the target runtime state from the delivery receipt", async () => {
  const { router } = makeRouter({
    deliver: async () => ({
      status: "queued",
      modeUsed: "queue",
      targetState: "running",
    }),
  });

  await expect(
    router.send(
      { coordinatorSession: "coordinator", sourceHandle: "workerA" },
      {
        to: encodeAgentHandle({ nodeId, endpointId: "endpoint_worker-b" }),
        content: "hello",
      },
    ),
  ).resolves.toMatchObject({
    status: "queued",
    modeUsed: "queue",
    targetState: "running",
  });
});

test("maps an unknown transport failure to a safe delivery error", async () => {
  const { router } = makeRouter({
    deliver: async () => {
      throw new Error("spawn failed: /secret/acpx --credential hunter2");
    },
  });

  try {
    await router.send(
      { coordinatorSession: "coordinator", sourceHandle: "workerA" },
      {
        to: encodeAgentHandle({ nodeId, endpointId: "endpoint_worker-b" }),
        content: "hello",
      },
    );
    throw new Error("expected send to fail");
  } catch (error) {
    expect(error).toMatchObject({ code: "DELIVERY_FAILED" });
    expect((error as Error).message).not.toContain("/secret");
    expect((error as Error).message).not.toContain("hunter2");
  }
});

test("marks messages from a non-receive-capable external sender as not replyable", async () => {
  const { router, deliveries } = makeRouter();

  await router.send(
    {
      coordinatorSession: "external-coordinator",
      sourceHandle: "external-coordinator",
    },
    {
      to: encodeAgentHandle({ nodeId, endpointId: "endpoint_external-worker" }),
      content: "external notice",
    },
  );

  expect(deliveries[0]?.renderedText).toContain('replyable="false"');
});

test("emits a safe structured delivery log without message content", async () => {
  const logs: Array<{
    event: string;
    message: string;
    context?: Record<string, unknown>;
  }> = [];
  const { router } = makeRouter({
    logger: {
      info: async (event, message, context) => {
        logs.push({ event, message, context });
      },
    },
  });
  await router.send(
    { coordinatorSession: "coordinator", sourceHandle: "workerA" },
    {
      to: encodeAgentHandle({ nodeId, endpointId: "endpoint_worker-b" }),
      content: "TOP SECRET schema text",
    },
  );

  expect(logs).toEqual([
    {
      event: "agent.message.delivery",
      message: "Agent message delivery accepted.",
      context: {
        messageId: "msg_message-1",
        sourceAddress: { nodeId, endpointId: "endpoint_worker-a" },
        targetAddress: { nodeId, endpointId: "endpoint_worker-b" },
        route: "local",
        requestedMode: "auto",
        modeUsed: "queue",
        status: "queued",
        targetState: undefined,
        latencyMs: 0,
        contentLength: 22,
      },
    },
  ]);
  expect(JSON.stringify(logs)).not.toContain("TOP SECRET");
  expect(JSON.stringify(logs)).not.toContain("msg_parent");
});

test("failure logs expose only the stable error code and safe metadata", async () => {
  const logs: Array<{ context?: Record<string, unknown> }> = [];
  const { router } = makeRouter({
    logger: {
      info: async (_event, _message, context) => {
        logs.push({ context });
      },
    },
    deliver: async () => {
      throw new Error("socket /private/tmp/hidden.sock rejected SECRET BODY");
    },
  });

  await expect(
    router.send(
      { coordinatorSession: "coordinator", sourceHandle: "workerA" },
      {
        to: encodeAgentHandle({ nodeId, endpointId: "endpoint_worker-b" }),
        content: "SECRET BODY",
      },
    ),
  ).rejects.toMatchObject({ code: "DELIVERY_FAILED" });

  expect(logs[0]?.context).toMatchObject({
    status: "failed",
    errorCode: "DELIVERY_FAILED",
    contentLength: 11,
  });
  expect(JSON.stringify(logs)).not.toContain("SECRET BODY");
  expect(JSON.stringify(logs)).not.toContain("/private/tmp");
});

test("rejects reply when parent message context is unknown or expired (REPLY_CONTEXT_UNAVAILABLE)", async () => {
  const { router } = makeRouter();
  const binding = { coordinatorSession: "coordinator", sourceHandle: "workerA" };
  const to = encodeAgentHandle({ nodeId, endpointId: "endpoint_worker-b" });

  // Unknown parent context fails closed
  await expect(
    router.send(binding, {
      to,
      content: "reply to unknown message",
      replyTo: "msg_unknown_123",
    }),
  ).rejects.toMatchObject({
    code: "REPLY_CONTEXT_UNAVAILABLE",
  });
});

test("rejects reply when target endpoint does not support conversation (REPLY_NOT_SUPPORTED)", async () => {
  const { router } = makeRouter();
  // Register remote endpoint with conversation: false (legacy v0.1 node)
  router["deps"].registry["remoteEndpoints"].set("node_legacy", [
    {
      address: { nodeId: "node_legacy", endpointId: "ep_legacy" },
      handle: encodeAgentHandle({ nodeId: "node_legacy", endpointId: "ep_legacy" }),
      node: "node_legacy",
      agent: "codex",
      state: "idle",
      activity: { status: "idle" },
      capabilities: {
        receive: true,
        steer: false,
        queue: true,
        interrupt: false,
        conversation: false,
      },
    },
  ]);

  // Seed inbound message
  await router.deliverInbound({
    sourceNodeId: "node_legacy",
    sourceEndpointId: "ep_legacy",
    targetEndpointId: "endpoint_worker-a",
    messageId: "msg_legacy_1",
    content: "hello from legacy",
    requestedMode: "auto",
    replyable: true,
  });

  const binding = { coordinatorSession: "coordinator", sourceHandle: "workerA" };
  const to = encodeAgentHandle({ nodeId: "node_legacy", endpointId: "ep_legacy" });

  await expect(
    router.send(binding, {
      to,
      content: "replying to legacy",
      replyTo: "msg_legacy_1",
    }),
  ).rejects.toMatchObject({
    code: "REPLY_NOT_SUPPORTED",
  });
});

test("rejects reply when target peer does not match parent sender (REPLY_TARGET_MISMATCH)", async () => {
  let deliveryCount = 0;
  const { router } = makeRouter({
    deliver: async () => {
      deliveryCount += 1;
      return { status: "queued", modeUsed: "queue" };
    },
  });

  const bindingA = { coordinatorSession: "coordinator", sourceHandle: "workerA" };
  const bindingB = { coordinatorSession: "coordinator", sourceHandle: "workerB" };
  const toB = encodeAgentHandle({ nodeId, endpointId: "endpoint_worker-b" });
  const toC = encodeAgentHandle({ nodeId, endpointId: "endpoint_worker-c" });

  // A -> B : msg_1
  const r1 = await router.send(bindingA, { to: toB, content: "hello B" });
  expect(deliveryCount).toBe(1);

  // B -> C with replyTo = msg_1 -> must throw REPLY_TARGET_MISMATCH
  await expect(
    router.send(bindingB, {
      to: toC,
      content: "hijacking thread to C",
      replyTo: r1.messageId,
    }),
  ).rejects.toMatchObject({
    code: "REPLY_TARGET_MISMATCH",
  });

  // Delivery count must NOT increment for C, conversation unchanged
  expect(deliveryCount).toBe(1);
});

test("suppresses duplicate content across interleaved messages within 30s window", async () => {
  let nextId = 0;
  let deliveryCount = 0;
  const { router } = makeRouter({
    createId: () => `msg-${++nextId}`,
    deliver: async () => {
      deliveryCount += 1;
      return { status: "queued", modeUsed: "queue" };
    },
    limits: { duplicateContentWindowMs: 30_000 },
  });

  const binding = { coordinatorSession: "coordinator", sourceHandle: "workerA" };
  const to = encodeAgentHandle({ nodeId, endpointId: "endpoint_worker-b" });

  // t=0: A -> B: X (accepted)
  await router.send(binding, { to, content: "schema changed" });
  expect(deliveryCount).toBe(1);

  // t=5: A -> B: Y (accepted)
  await router.send(binding, { to, content: "check tests" });
  expect(deliveryCount).toBe(2);

  // t=10: A -> B: X (within 30s) -> DUPLICATE_MESSAGE
  await expect(
    router.send(binding, { to, content: "schema changed" }),
  ).rejects.toMatchObject({
    code: "DUPLICATE_MESSAGE",
  });

  // Delivery count must remain 2
  expect(deliveryCount).toBe(2);
});

test("rejects duplicate content within duplicate suppression window (DUPLICATE_MESSAGE)", async () => {
  let nextId = 0;
  const { router } = makeRouter({
    createId: () => `msg-${++nextId}`,
    limits: { duplicateContentWindowMs: 30_000 },
  });
  const binding = { coordinatorSession: "coordinator", sourceHandle: "workerA" };
  const to = encodeAgentHandle({ nodeId, endpointId: "endpoint_worker-b" });

  await router.send(binding, { to, content: "Exact same text" });

  await expect(
    router.send(binding, { to, content: "Exact same text" }),
  ).rejects.toMatchObject({
    code: "DUPLICATE_MESSAGE",
  });

  // Different text proceeds
  await expect(
    router.send(binding, { to, content: "Different text" }),
  ).resolves.toMatchObject({
    status: "queued",
  });
});

test("enforces conversation depth limit (CONVERSATION_LIMIT_REACHED)", async () => {
  let nextId = 0;
  const { router } = makeRouter({
    createId: () => `msg-${++nextId}`,
    limits: { maxConversationDepth: 2 },
  });
  const bindingA = { coordinatorSession: "coordinator", sourceHandle: "workerA" };
  const bindingB = { coordinatorSession: "coordinator", sourceHandle: "workerB" };
  const toB = encodeAgentHandle({ nodeId, endpointId: "endpoint_worker-b" });
  const toA = encodeAgentHandle({ nodeId, endpointId: "endpoint_worker-a" });

  // depth 0 (root)
  const r1 = await router.send(bindingA, { to: toB, content: "root" });
  expect(r1.messageId).toBe("msg_msg-1");

  // depth 1 (reply to root)
  const r2 = await router.send(bindingB, { to: toA, content: "reply 1", replyTo: "msg_msg-1" });
  expect(r2.messageId).toBe("msg_msg-2");

  // depth 2 (reply to reply 1)
  const r3 = await router.send(bindingA, { to: toB, content: "reply 2", replyTo: "msg_msg-2" });
  expect(r3.messageId).toBe("msg_msg-3");

  // depth 3 (exceeds maxConversationDepth = 2) -> rejected
  await expect(
    router.send(bindingB, { to: toA, content: "reply 3", replyTo: "msg_msg-3" }),
  ).rejects.toMatchObject({
    code: "CONVERSATION_LIMIT_REACHED",
  });
});

test("enforces conversation volume limit (CONVERSATION_LIMIT_REACHED)", async () => {
  let nextId = 0;
  const { router } = makeRouter({
    createId: () => `msg-${++nextId}`,
    limits: { maxMessagesPerConversation: 3, maxConversationDepth: 10, duplicateContentWindowMs: 0 },
  });
  const bindingA = { coordinatorSession: "coordinator", sourceHandle: "workerA" };
  const bindingB = { coordinatorSession: "coordinator", sourceHandle: "workerB" };
  const toB = encodeAgentHandle({ nodeId, endpointId: "endpoint_worker-b" });
  const toA = encodeAgentHandle({ nodeId, endpointId: "endpoint_worker-a" });

  const r1 = await router.send(bindingA, { to: toB, content: "m1" });
  const r2 = await router.send(bindingB, { to: toA, content: "m2", replyTo: r1.messageId });
  const r3 = await router.send(bindingA, { to: toB, content: "m3", replyTo: r2.messageId });

  // 4th message exceeds maxMessagesPerConversation = 3
  await expect(
    router.send(bindingB, { to: toA, content: "m4", replyTo: r3.messageId }),
  ).rejects.toMatchObject({
    code: "CONVERSATION_LIMIT_REACHED",
  });
});

test("records metadata-only trace records and caps ring buffer", async () => {
  let nextId = 0;
  const { router } = makeRouter({
    createId: () => `msg-${++nextId}`,
    limits: { traceRingBufferSize: 2, duplicateContentWindowMs: 0 },
  });
  const binding = { coordinatorSession: "coordinator", sourceHandle: "workerA" };
  const to = encodeAgentHandle({ nodeId, endpointId: "endpoint_worker-b" });

  await router.send(binding, { to, content: "secret text 1" });
  await router.send(binding, { to, content: "secret text 2" });
  await router.send(binding, { to, content: "secret text 3" });

  const traces = router.getTraceRecords();
  // Capped at traceRingBufferSize = 2
  expect(traces).toHaveLength(2);
  expect(traces[0]?.messageId).toBe("msg_msg-2");
  expect(traces[1]?.messageId).toBe("msg_msg-3");
  // Must contain contentHash and contentLength, but NEVER the raw text
  expect(traces[1]?.contentLength).toBe(13);
  expect(traces[1]?.contentHash).toHaveLength(64);
  expect(JSON.stringify(traces)).not.toContain("secret text");
});

test("sending with selector succeeds on unique match", async () => {
  let deliveredContent = "";
  let deliveredTargetId = "";
  const { router } = makeRouter({
    deliver: async (target, message) => {
      deliveredTargetId = target.endpoint.address.endpointId;
      deliveredContent = message.content;
      return { status: "queued", modeUsed: "queue" };
    },
  });
  const binding = { coordinatorSession: "coordinator", sourceHandle: "workerA" };

  const receipt = await router.send(binding, {
    selector: { agent: "gemini" },
    content: "hello worker b",
  });

  expect(receipt.status).toBe("queued");
  expect(deliveredTargetId).toBe("endpoint_worker-b");
  expect(deliveredContent).toBe("hello worker b");
});

test("sending with ambiguous selector throws TARGET_AMBIGUOUS", async () => {
  const { router, state } = makeRouter();
  // Add a second worker with the same agent
  state.orchestration.workerBindings.workerC = {
    sourceHandle: "workerC",
    agentEndpointId: "endpoint_worker-c",
    coordinatorSession: "coordinator",
    workspace: "project",
    targetAgent: "gemini",
    role: "workerC",
  };
  const binding = { coordinatorSession: "coordinator", sourceHandle: "workerA" };

  await expect(
    router.send(binding, {
      selector: { agent: "gemini" },
      content: "ambiguous hello",
    }),
  ).rejects.toMatchObject<Partial<AgentMessagingError>>({
    code: "TARGET_AMBIGUOUS",
  });
});

test("sending with neither or both 'to' and 'selector' throws DELIVERY_FAILED error", async () => {
  const { router } = makeRouter();
  const binding = { coordinatorSession: "coordinator", sourceHandle: "workerA" };
  const to = encodeAgentHandle({ nodeId, endpointId: "endpoint_worker-b" });

  // Neither 'to' nor 'selector'
  await expect(
    router.send(binding, {
      content: "no destination",
    }),
  ).rejects.toMatchObject<Partial<AgentMessagingError>>({
    code: "DELIVERY_FAILED",
  });

  // Both 'to' and 'selector'
  await expect(
    router.send(binding, {
      to,
      selector: { agent: "gemini" },
      content: "double destination",
    }),
  ).rejects.toMatchObject<Partial<AgentMessagingError>>({
    code: "DELIVERY_FAILED",
  });
});

test("emits agent-message event with direction 'sent' when outbound message succeeds", async () => {
  const events = createControlEventBus();
  const emitted: ControlEvent[] = [];
  events.subscribe((e) => emitted.push(e));

  const { router } = makeRouter({ events });
  const binding = { coordinatorSession: "coordinator", sourceHandle: "workerA" };
  const to = encodeAgentHandle({ nodeId, endpointId: "endpoint_worker-b" });

  await router.send(binding, {
    to,
    content: "Please review the auth schema.",
  });

  expect(emitted.length).toBe(2);
  const sentEvent = emitted.find((e) => e.type === "agent-message" && e.message.direction === "sent");
  expect(sentEvent).toBeDefined();
  if (sentEvent && sentEvent.type === "agent-message") {
    expect(sentEvent.sessionAlias).toBe("workerA");
    expect(sentEvent.message).toMatchObject({
      kind: "agent_message",
      direction: "sent",
      messageId: "msg_message-1",
      content: "Please review the auth schema.",
      status: "sent",
      peer: {
        handle: to,
        agent: "gemini",
        workspace: "project",
      },
    });
  }

  const receivedEvent = emitted.find((e) => e.type === "agent-message" && e.message.direction === "received");
  expect(receivedEvent).toBeDefined();
  if (receivedEvent && receivedEvent.type === "agent-message") {
    expect(receivedEvent.sessionAlias).toBe("workerB");
    expect(receivedEvent.message).toMatchObject({
      kind: "agent_message",
      direction: "received",
      messageId: "msg_message-1",
      content: "Please review the auth schema.",
      status: "delivered",
    });
  }
});

test("emits agent-message event with direction 'received' when inbound message is delivered", async () => {
  const events = createControlEventBus();
  const emitted: ControlEvent[] = [];
  events.subscribe((e) => emitted.push(e));

  const { router } = makeRouter({ events });

  await router.deliverInbound({
    sourceNodeId: "node_remote_1",
    sourceEndpointId: "remote_agent_x",
    targetEndpointId: "endpoint_worker-b",
    messageId: "msg_inbound_99",
    conversationId: "conv_123",
    content: "Schema migration is complete.",
    requestedMode: "auto",
    replyable: true,
  });

  expect(emitted.length).toBe(1);
  const event = emitted[0];
  expect(event?.type).toBe("agent-message");
  if (event && event.type === "agent-message") {
    expect(event.sessionAlias).toBe("workerB");
    expect(event.message).toMatchObject({
      kind: "agent_message",
      direction: "received",
      messageId: "msg_inbound_99",
      conversationId: "conv_123",
      content: "Schema migration is complete.",
      status: "delivered",
      peer: {
        handle: "agent:node_remote_1:remote_agent_x",
      },
    });
  }
});

test("send resolves with the admission receipt without waiting for the peer turn to complete", async () => {
  // v0.2 contract: the delivery adapter's admission result IS the ACK. The
  // peer's turn stays in flight for the entire test; if send() ever starts
  // awaiting peer completion instead of returning the admission receipt,
  // this test hangs and fails on the per-test timeout.
  const peerTurnStillRunning = createDeferred<void>();
  const { router } = makeRouter({
    deliver: async () => {
      void peerTurnStillRunning.promise;
      return { status: "injected" as const, modeUsed: "queue" as const };
    },
  });

  const receipt = await router.send(
    { coordinatorSession: "coordinator", sourceHandle: "workerA" },
    {
      to: encodeAgentHandle({ nodeId, endpointId: "endpoint_worker-b" }),
      content: "admission ack only",
    },
  );

  expect(receipt).toEqual({
    messageId: "msg_message-1",
    status: "injected",
    modeUsed: "queue",
    route: "local",
  });
});

test("local delivery stays one-way: the source session gets only its sent history event", async () => {
  const events = createControlEventBus();
  const emitted: ControlEvent[] = [];
  events.subscribe((e) => emitted.push(e));

  const { router } = makeRouter({ events });
  const binding = { coordinatorSession: "coordinator", sourceHandle: "workerA" };
  const to = encodeAgentHandle({ nodeId, endpointId: "endpoint_worker-b" });

  await router.send(binding, { to, content: "one-way ping" });

  // Exactly the two history events exist: the sender's outbound row and the
  // target's inbound row. No system turn, no turn lifecycle, nothing else.
  expect(emitted.map((e) => e.type)).toEqual(["agent-message", "agent-message"]);
  expect(
    emitted.filter(
      (e) =>
        e.type === "agent-message" &&
        e.sessionAlias === "workerA" &&
        e.message.direction === "sent",
    ),
  ).toHaveLength(1);
  expect(
    emitted.filter(
      (e) =>
        e.type === "agent-message" &&
        e.sessionAlias === "workerB" &&
        e.message.direction === "received",
    ),
  ).toHaveLength(1);
  expect(
    emitted.some((e) => e.type.startsWith("turn-") || e.type === "queue-updated"),
  ).toBe(false);
});

function createDeferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function waitUntil(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (predicate()) return;
    await Bun.sleep(0);
  }
  throw new Error("condition did not become true");
}
