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
import type { AgentMessage, AgentMessageCompletion } from "../../../src/orchestration/agent-messaging-types";
import { RelayAgentMessageRoute } from "../../../src/orchestration/relay-agent-message-route";
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
    delivery?: LocalAgentMessageDelivery;
    remoteRoute?: RelayAgentMessageRoute;
    createId?: () => string;
    limits?: AgentMessageRouterLimits;
    now?: () => number;
    logger?: Pick<AppLogger, "info">;
    events?: ControlEventBus;
    completionOutboxStore?: {
      load(): Array<{
        key: string;
        kind: "local" | "remote";
        requestMessageId: string;
        senderSessionAlias?: string;
        completion: AgentMessageCompletion;
        expiresAt: number;
      }>;
      upsert(entry: {
        key: string;
        kind: "local" | "remote";
        requestMessageId: string;
        senderSessionAlias?: string;
        completion: AgentMessageCompletion;
        expiresAt: number;
      }): void;
      delete(key: string): void;
    };
    pendingCompletionStore?: {
      load(): Array<{
        requestMessageId: string;
        source: { nodeId: string; endpointId: string };
        target: { nodeId: string; endpointId: string };
        mode: "notify" | "result";
        expiresAt: number;
        state: "pending" | "delivered";
      }>;
      save(grants: Array<{
        requestMessageId: string;
        source: { nodeId: string; endpointId: string };
        target: { nodeId: string; endpointId: string };
        mode: "notify" | "result";
        expiresAt: number;
        state: "pending" | "delivered";
      }>): void;
    };
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
    delivery: options.delivery ?? {
      deliver: async (target, message, renderedText) => {
        deliveries.push({ message, renderedText });
        return await (options.deliver?.(target, message, renderedText) ??
          Promise.resolve({
            status: "queued" as const,
            modeUsed: "queue" as const,
          }));
      },
    },
    remoteRoute: options.remoteRoute,
    createId: options.createId ?? (() => "message-1"),
    now: options.now ?? (() => 1_000),
    limits: options.limits,
    logger: options.logger,
    events: options.events,
    completionOutboxStore: options.completionOutboxStore,
    pendingCompletionStore: options.pendingCompletionStore,
  });
  return { router, deliveries, state, registry };
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
        completion: "none",
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

test("default completion = none: send without completion carries completion 'none' in history entries", async () => {
  const events = createControlEventBus();
  const emitted: ControlEvent[] = [];
  events.subscribe((e) => emitted.push(e));

  const { router } = makeRouter({ events });
  const binding = { coordinatorSession: "coordinator", sourceHandle: "workerA" };
  const to = encodeAgentHandle({ nodeId, endpointId: "endpoint_worker-b" });

  const receipt = await router.send(binding, { to, content: "default completion test" });
  expect(receipt.status).toBe("queued");

  const agentMessages = emitted.filter((e): e is Extract<ControlEvent, { type: "agent-message" }> => e.type === "agent-message");
  expect(agentMessages).toHaveLength(2);
  expect(agentMessages[0]!.message.completion).toBe("none");
  expect(agentMessages[1]!.message.completion).toBe("none");
});

test("explicit completion = none: carries completion 'none' in history entries and succeeds", async () => {
  const events = createControlEventBus();
  const emitted: ControlEvent[] = [];
  events.subscribe((e) => emitted.push(e));

  const { router } = makeRouter({ events });
  const binding = { coordinatorSession: "coordinator", sourceHandle: "workerA" };
  const to = encodeAgentHandle({ nodeId, endpointId: "endpoint_worker-b" });

  const receipt = await router.send(binding, { to, content: "explicit none test", completion: "none" });
  expect(receipt.status).toBe("queued");

  const agentMessages = emitted.filter((e): e is Extract<ControlEvent, { type: "agent-message" }> => e.type === "agent-message");
  expect(agentMessages).toHaveLength(2);
  expect(agentMessages[0]!.message.completion).toBe("none");
  expect(agentMessages[1]!.message.completion).toBe("none");
});

test("remote route completion = notify: router rejects with COMPLETION_NOT_SUPPORTED with zero side effects", async () => {
  let idAllocated = false;
  const events = createControlEventBus();
  const emitted: ControlEvent[] = [];
  events.subscribe((e) => emitted.push(e));

  const { router, registry } = makeRouter({
    events,
    createId: () => {
      idAllocated = true;
      return "should-not-allocate";
    },
  });
  registry.updateRemoteEndpoints("node_remote", [
    {
      address: { nodeId: "node_remote", endpointId: "endpoint_remote_worker" },
      handle: encodeAgentHandle({ nodeId: "node_remote", endpointId: "endpoint_remote_worker" }),
      node: "Remote Node",
      displayName: "Remote Worker",
      agent: "claude",
      state: "idle",
      activity: { status: "idle" },
      capabilities: {
        receive: true,
        steer: false,
        queue: true,
        interrupt: false,
        conversation: true,
      },
    },
  ]);
  const binding = { coordinatorSession: "coordinator", sourceHandle: "workerA" };
  const to = encodeAgentHandle({ nodeId: "node_remote", endpointId: "endpoint_remote_worker" });

  let thrown: unknown;
  try {
    await router.send(binding, { to, content: "notify message", completion: "notify" });
  } catch (err) {
    thrown = err;
  }

  expect(thrown).toBeInstanceOf(AgentMessagingError);
  expect((thrown as AgentMessagingError).code).toBe("COMPLETION_NOT_SUPPORTED");
  expect(idAllocated).toBe(false);
  expect(emitted).toHaveLength(0);
});

test("remote route completion = result: router rejects with COMPLETION_NOT_SUPPORTED with zero side effects", async () => {
  let idAllocated = false;
  const events = createControlEventBus();
  const emitted: ControlEvent[] = [];
  events.subscribe((e) => emitted.push(e));

  const { router, registry } = makeRouter({
    events,
    createId: () => {
      idAllocated = true;
      return "should-not-allocate";
    },
  });
  registry.updateRemoteEndpoints("node_remote", [
    {
      address: { nodeId: "node_remote", endpointId: "endpoint_remote_worker" },
      handle: encodeAgentHandle({ nodeId: "node_remote", endpointId: "endpoint_remote_worker" }),
      node: "Remote Node",
      displayName: "Remote Worker",
      agent: "claude",
      state: "idle",
      activity: { status: "idle" },
      capabilities: {
        receive: true,
        steer: false,
        queue: true,
        interrupt: false,
        conversation: true,
      },
    },
  ]);
  const binding = { coordinatorSession: "coordinator", sourceHandle: "workerA" };
  const to = encodeAgentHandle({ nodeId: "node_remote", endpointId: "endpoint_remote_worker" });

  let thrown: unknown;
  try {
    await router.send(binding, { to, content: "result message", completion: "result" });
  } catch (err) {
    thrown = err;
  }

  expect(thrown).toBeInstanceOf(AgentMessagingError);
  expect((thrown as AgentMessagingError).code).toBe("COMPLETION_NOT_SUPPORTED");
  expect(idAllocated).toBe(false);
  expect(emitted).toHaveLength(0);
});

/** v0.3 completion signals require logical senders AND logical targets (the
 * canonical TurnQueue path). These sessions give completion tests a logical
 * pair: main (coordinator) -> second, plus third/fourth for the Gate P pair. */
function addLogicalPeers(state: ReturnType<typeof createEmptyState>): void {
  const base = {
    agent: "codex",
    workspace: "project",
    created_at: "2026-08-18T00:00:00.000Z",
    last_used_at: "2026-08-18T00:00:00.000Z",
  };
  state.sessions.second = {
    alias: "second",
    transport_session: "coordinator-second",
    logical_session_id: "33333333-3333-4333-8333-333333333333",
    ...base,
  };
  state.sessions.third = {
    alias: "third",
    transport_session: "coordinator-third",
    logical_session_id: "44444444-4444-4444-8444-444444444444",
    ...base,
  };
  state.sessions.fourth = {
    alias: "fourth",
    transport_session: "coordinator-fourth",
    logical_session_id: "55555555-5555-4555-8555-555555555555",
    ...base,
  };
}

const LOGICAL_SENDER = { coordinatorSession: "coordinator" } as const;
const LOGICAL_TARGET_ID = "33333333-3333-4333-8333-333333333333";

test("local route accepts completion = notify from a logical sender to a logical target", async () => {
  const events = createControlEventBus();
  const emitted: ControlEvent[] = [];
  events.subscribe((e) => emitted.push(e));

  const { router, state } = makeRouter({ events });
  addLogicalPeers(state);
  const to = encodeAgentHandle({ nodeId, endpointId: LOGICAL_TARGET_ID });

  const receipt = await router.send(LOGICAL_SENDER, { to, content: "notify message", completion: "notify" });
  expect(receipt.status).toBe("queued");

  const agentMessages = emitted.filter((e): e is Extract<ControlEvent, { type: "agent-message" }> => e.type === "agent-message");
  expect(agentMessages).toHaveLength(2);
  expect(agentMessages[0]!.message.completion).toBe("notify");
  expect(agentMessages[0]!.message.completionStatus).toBe("pending");
  expect(agentMessages[1]!.message.completion).toBe("notify");
  // A pending-completion grant was recorded for this exact request.
  expect((router as any).pendingCompletions.has(receipt.messageId)).toBe(true);
});

test("local route accepts completion = result from a logical sender to a logical target", async () => {
  const events = createControlEventBus();
  const emitted: ControlEvent[] = [];
  events.subscribe((e) => emitted.push(e));

  const { router, state } = makeRouter({ events });
  addLogicalPeers(state);
  const to = encodeAgentHandle({ nodeId, endpointId: LOGICAL_TARGET_ID });

  const receipt = await router.send(LOGICAL_SENDER, { to, content: "result message", completion: "result" });
  expect(receipt.status).toBe("queued");

  const agentMessages = emitted.filter((e): e is Extract<ControlEvent, { type: "agent-message" }> => e.type === "agent-message");
  expect(agentMessages).toHaveLength(2);
  expect(agentMessages[0]!.message.completion).toBe("result");
  expect(agentMessages[0]!.message.completionStatus).toBe("pending");
  expect(agentMessages[1]!.message.completion).toBe("result");
  expect((router as any).pendingCompletions.has(receipt.messageId)).toBe(true);
});

test("completion requests from worker senders or to worker targets fail closed", async () => {
  const { router, state } = makeRouter();
  addLogicalPeers(state);
  const workerTo = encodeAgentHandle({ nodeId, endpointId: "endpoint_worker-b" });

  // Worker sender (workerA) requesting completion → rejected.
  await expect(
    router.send(
      { coordinatorSession: "coordinator", sourceHandle: "workerA" },
      { to: encodeAgentHandle({ nodeId, endpointId: LOGICAL_TARGET_ID }), content: "x", completion: "result" },
    ),
  ).rejects.toMatchObject({ code: "COMPLETION_NOT_SUPPORTED" });

  // Logical sender to worker target → rejected (worker cannot produce a
  // correlated terminal event, so it must not advertise completion).
  await expect(
    router.send(LOGICAL_SENDER, { to: workerTo, content: "x", completion: "notify" }),
  ).rejects.toMatchObject({ code: "COMPLETION_NOT_SUPPORTED" });
});
test("deliverInbound sets completion 'none' on history entry when absent or none", async () => {
  const events = createControlEventBus();
  const emitted: ControlEvent[] = [];
  events.subscribe((e) => emitted.push(e));

  const { router } = makeRouter({ events });
  const receipt = await router.deliverInbound({
    sourceNodeId: "node_other",
    sourceEndpointId: "endpoint_remote",
    targetEndpointId: "endpoint_worker-a",
    messageId: "msg_inbound_comp_1",
    content: "inbound test",
    requestedMode: "queue",
    replyable: false,
  });

  expect(receipt.status).toBe("queued");
  const agentMessages = emitted.filter((e): e is Extract<ControlEvent, { type: "agent-message" }> => e.type === "agent-message");
  expect(agentMessages).toHaveLength(1);
  expect(agentMessages[0]!.message.completion).toBe("none");
});

test("Gate H: completePeerTurn with completion = none returns null with zero side effects", async () => {
  const events = createControlEventBus();
  const emitted: ControlEvent[] = [];
  events.subscribe((e) => emitted.push(e));
  let injected = false;

  const { router } = makeRouter({
    events,
  });
  (router as any).deps.delivery.deliverCompletion = async () => {
    injected = true;
    return { status: "injected" };
  };

  const origin = {
    requestMessageId: "msg_none_1",
    completion: "none" as const,
    source: { nodeId, endpointId: "endpoint_worker-a" },
    target: { nodeId, endpointId: "endpoint_worker-b" },
  };

  const res = await router.completePeerTurn(origin, {
    ok: true,
    text: "result text",
  });

  expect(res).toBeNull();
  expect(emitted).toHaveLength(0);
  expect(injected).toBe(false);
});

test("Gate I: completePeerTurn with completion = notify emits a completion-status patch and admits one structured completion turn", async () => {
  const events = createControlEventBus();
  const emitted: ControlEvent[] = [];
  events.subscribe((e) => emitted.push(e));
  const deliveredCompletions: Array<{ sourceAlias: string; completion: AgentMessageCompletion; requestMessageId: string }> = [];

  const { router, state } = makeRouter({ events });
  addLogicalPeers(state);
  (router as unknown as { deps: { delivery: { deliverCompletion?: (alias: string, completion: AgentMessageCompletion, id: string) => Promise<{ status: "injected" | "queued" } | { status: "rejected"; reason: string }> } } }).deps.delivery.deliverCompletion = async (
    sourceAlias,
    completion,
    requestMessageId,
  ) => {
    deliveredCompletions.push({ sourceAlias, completion, requestMessageId });
    return { status: "injected" as const };
  };

  const receipt = await router.send(LOGICAL_SENDER, { to: encodeAgentHandle({ nodeId, endpointId: LOGICAL_TARGET_ID }), content: "do task", completion: "notify" });

  const origin = {
    requestMessageId: receipt.messageId,
    completion: "notify" as const,
    source: { nodeId, endpointId: "22222222-2222-4222-8222-222222222222" },
    target: { nodeId, endpointId: LOGICAL_TARGET_ID },
  };

  const completion = await router.completePeerTurn(origin, {
    ok: true,
    text: "done with task",
  });

  expect(completion).not.toBeNull();
  expect(completion?.status).toBe("completed");
  // Notify grants never carry a result body.
  expect(completion?.result).toBeUndefined();

  // Sender card status was PATCHED (not rebuilt as a full entry).
  const patches = emitted.filter((e): e is Extract<ControlEvent, { type: "agent-message-completion" }> => e.type === "agent-message-completion");
  expect(patches).toHaveLength(1);
  expect(patches[0]!.sessionAlias).toBe("main");
  expect(patches[0]!.messageId).toBe(receipt.messageId);
  expect(patches[0]!.completionStatus).toBe("completed");

  // Exactly one structured completion turn admitted into the source lane.
  expect(deliveredCompletions).toHaveLength(1);
  expect(deliveredCompletions[0]!.sourceAlias).toBe("main");
  expect(deliveredCompletions[0]!.completion.status).toBe("completed");
  expect(deliveredCompletions[0]!.completion.result).toBeUndefined();
});

test("Gate J: completePeerTurn with completion = result bounds 20KiB text to <=16KiB with marker and admits one structured result turn", async () => {
  const events = createControlEventBus();
  const deliveredCompletions: Array<{ sourceAlias: string; completion: AgentMessageCompletion; requestMessageId: string }> = [];

  const { router, state } = makeRouter({ events });
  addLogicalPeers(state);
  (router as unknown as { deps: { delivery: { deliverCompletion?: (alias: string, completion: AgentMessageCompletion, id: string) => Promise<{ status: "injected" | "queued" } | { status: "rejected"; reason: string }> } } }).deps.delivery.deliverCompletion = async (
    sourceAlias,
    completion,
    requestMessageId,
  ) => {
    deliveredCompletions.push({ sourceAlias, completion, requestMessageId });
    return { status: "injected" as const };
  };

  const receipt = await router.send(LOGICAL_SENDER, { to: encodeAgentHandle({ nodeId, endpointId: LOGICAL_TARGET_ID }), content: "compute large", completion: "result" });

  const largeResult = "答案：" + "X".repeat(20 * 1024);
  const origin = {
    requestMessageId: receipt.messageId,
    completion: "result" as const,
    source: { nodeId, endpointId: "22222222-2222-4222-8222-222222222222" },
    target: { nodeId, endpointId: LOGICAL_TARGET_ID },
  };

  const completion = await router.completePeerTurn(origin, {
    ok: true,
    text: largeResult,
  });

  expect(completion?.status).toBe("completed");
  expect(completion?.result).toBeDefined();
  expect(Buffer.byteLength(completion!.result!, "utf8")).toBeLessThanOrEqual(16 * 1024);
  expect(completion!.result!.endsWith("\n[xacpx: result truncated]")).toBe(true);

  expect(deliveredCompletions).toHaveLength(1);
  expect(deliveredCompletions[0]!.completion.result).toBe(completion?.result);
});

test("Gate M: real send → archive source → completePeerTurn marks grant delivered, patches status, does not inject turn", async () => {
  const events = createControlEventBus();
  const emitted: ControlEvent[] = [];
  events.subscribe((e) => emitted.push(e));
  let injected = false;

  const { router, registry, state } = makeRouter({ events });
  addLogicalPeers(state);
  (router as unknown as { deps: { delivery: { deliverCompletion?: () => Promise<{ status: "injected" }> } } }).deps.delivery.deliverCompletion = async () => {
    injected = true;
    return { status: "injected" as const };
  };

  // REAL send from the logical coordinator session to the logical target —
  // this creates the durable pending grant through reserve-before-dispatch.
  const receipt = await router.send(LOGICAL_SENDER, {
    to: encodeAgentHandle({ nodeId, endpointId: LOGICAL_TARGET_ID }),
    content: "long running task",
    completion: "notify",
  });
  expect(
    (
      router as unknown as { pendingCompletions: Map<string, { state: string }> }
    ).pendingCompletions.get(receipt.messageId)?.state,
  ).toBe("pending");

  // The user archives the source session while the peer is working.
  state.sessions.main!.archived = true;

  const completion = await router.completePeerTurn(
    {
      requestMessageId: receipt.messageId,
      completion: "notify",
      source: { nodeId, endpointId: "22222222-2222-4222-8222-222222222222" },
      target: { nodeId, endpointId: LOGICAL_TARGET_ID },
    },
    { ok: true, text: "done" },
  );

  expect(completion?.status).toBe("completed");

  // Status patch event emitted for the sender card.
  const patches = emitted.filter((e): e is Extract<ControlEvent, { type: "agent-message-completion" }> => e.type === "agent-message-completion");
  expect(patches).toHaveLength(1);
  expect(patches[0]!.completionStatus).toBe("completed");

  // The grant is marked DELIVERED — not deleted, NOT still pending.
  expect(
    (
      router as unknown as { pendingCompletions: Map<string, { state: string }> }
    ).pendingCompletions.get(receipt.messageId)?.state,
  ).toBe("delivered");

  // NO turn injected into the archived source.
  expect(injected).toBe(false);
});

test("Gate N: duplicate completePeerTurn (including contradictory terminal) returns first terminal with exactly one injection and one patch", async () => {
  const events = createControlEventBus();
  const emitted: ControlEvent[] = [];
  events.subscribe((e) => emitted.push(e));
  const deliveredCompletions: AgentMessageCompletion[] = [];

  const { router, state } = makeRouter({ events });
  addLogicalPeers(state);
  (router as unknown as { deps: { delivery: { deliverCompletion?: (alias: string, completion: AgentMessageCompletion, id: string) => Promise<{ status: "injected" | "queued" } | { status: "rejected"; reason: string }> } } }).deps.delivery.deliverCompletion = async (
    _alias,
    completion,
  ) => {
    deliveredCompletions.push(completion);
    return { status: "injected" as const };
  };

  const receipt = await router.send(LOGICAL_SENDER, { to: encodeAgentHandle({ nodeId, endpointId: LOGICAL_TARGET_ID }), content: "task dedup", completion: "result" });

  const origin = {
    requestMessageId: receipt.messageId,
    completion: "result" as const,
    source: { nodeId, endpointId: "22222222-2222-4222-8222-222222222222" },
    target: { nodeId, endpointId: LOGICAL_TARGET_ID },
  };

  // First terminal: ok with "first answer"
  const first = await router.completePeerTurn(origin, {
    ok: true,
    text: "first answer",
  });

  // Second terminal: contradictory failure attempt
  const second = await router.completePeerTurn(origin, {
    ok: false,
    errorMessage: "contradictory failure",
  });

  expect(first?.status).toBe("completed");
  expect(first?.result).toBe("first answer");
  // First terminal wins!
  expect(second).toBe(first);
  expect(second?.status).toBe("completed");
  expect(second?.result).toBe("first answer");

  // Exactly one completion-status patch event for the terminal.
  const patches = emitted.filter((e): e is Extract<ControlEvent, { type: "agent-message-completion" }> => e.type === "agent-message-completion");
  expect(patches).toHaveLength(1);
  expect(patches[0]!.messageId).toBe(receipt.messageId);
  expect(patches[0]!.completionStatus).toBe("completed");

  // Exactly one structured completion delivered
  expect(deliveredCompletions).toHaveLength(1);
  expect(deliveredCompletions[0]!.result).toBe("first answer");
});

test("Gate O: peer turn failure sets completionStatus=failed and carries sanitized error; cancelled sets status=cancelled", async () => {
  const events = createControlEventBus();
  const deliveredCompletions: AgentMessageCompletion[] = [];

  const { router, state } = makeRouter({ events });
  addLogicalPeers(state);
  (router as unknown as { deps: { delivery: { deliverCompletion?: (alias: string, completion: AgentMessageCompletion, id: string) => Promise<{ status: "injected" | "queued" } | { status: "rejected"; reason: string }> } } }).deps.delivery.deliverCompletion = async (
    _alias,
    completion,
  ) => {
    deliveredCompletions.push(completion);
    return { status: "injected" as const };
  };

  // 1. Failed turn
  const originFail = {
    requestMessageId: "msg_fail_cycle",
    completion: "result" as const,
    source: { nodeId, endpointId: "22222222-2222-4222-8222-222222222222" },
    target: { nodeId, endpointId: LOGICAL_TARGET_ID },
  };

  const failCompletion = await router.completePeerTurn(originFail, {
    ok: false,
    errorMessage: "Task failed: database disconnected\n    at query (/app/db.ts:12:3)",
  });

  expect(failCompletion?.status).toBe("failed");
  expect(failCompletion?.error).toBe("Task failed: database disconnected");
  expect(failCompletion?.result).toBeUndefined();
  expect(deliveredCompletions[0]).toMatchObject({
    requestMessageId: "msg_fail_cycle",
    status: "failed",
    error: "Task failed: database disconnected",
  });

  // 2. Cancelled turn
  const originCancel = {
    requestMessageId: "msg_cancel_cycle",
    completion: "notify" as const,
    source: { nodeId, endpointId: "22222222-2222-4222-8222-222222222222" },
    target: { nodeId, endpointId: LOGICAL_TARGET_ID },
  };

  const cancelCompletion = await router.completePeerTurn(originCancel, {
    ok: false,
    cancelled: true,
  });

  expect(cancelCompletion?.status).toBe("cancelled");
  expect(deliveredCompletions[1]).toMatchObject({
    requestMessageId: "msg_cancel_cycle",
    status: "cancelled",
  });
});

test("Gate P: two independent concurrent completion pairs do not cross-contaminate results or identities", async () => {
  const events = createControlEventBus();
  const emitted: ControlEvent[] = [];
  events.subscribe((e) => emitted.push(e));
  const deliveredCompletions: Array<{ alias: string; completion: AgentMessageCompletion }> = [];

  let idSeq = 0;
  const { router, state } = makeRouter({
    events,
    createId: () => `uuid-${++idSeq}`,
  });
  addLogicalPeers(state);
  (router as unknown as { deps: { delivery: { deliverCompletion?: (alias: string, completion: AgentMessageCompletion, id: string) => Promise<{ status: "injected" | "queued" } | { status: "rejected"; reason: string }> } } }).deps.delivery.deliverCompletion = async (
    alias,
    completion,
  ) => {
    deliveredCompletions.push({ alias, completion });
    return { status: "injected" as const };
  };

  // Pair 1: main -> second. Pair 2: third -> fourth.
  const receiptAB = await router.send(LOGICAL_SENDER, {
    to: encodeAgentHandle({ nodeId, endpointId: "33333333-3333-4333-8333-333333333333" }),
    content: "task for B",
    completion: "result",
  });
  const receiptCD = await router.send(
    { coordinatorSession: "coordinator-third" },
    { to: encodeAgentHandle({ nodeId, endpointId: "55555555-5555-4555-8555-555555555555" }), content: "task for D", completion: "result" },
  );
  expect(receiptAB.messageId).not.toBe(receiptCD.messageId);

  // Terminals arrive concurrently and out of order (D finishes before B).
  const [completionCD, completionAB] = await Promise.all([
    router.completePeerTurn(
      {
        requestMessageId: receiptCD.messageId,
        completion: "result",
        source: { nodeId, endpointId: "44444444-4444-4444-8444-444444444444" },
        target: { nodeId, endpointId: "55555555-5555-4555-8555-555555555555" },
      },
      { ok: true, text: "answer from D" },
    ),
    router.completePeerTurn(
      {
        requestMessageId: receiptAB.messageId,
        completion: "result",
        source: { nodeId, endpointId: "22222222-2222-4222-8222-222222222222" },
        target: { nodeId, endpointId: "33333333-3333-4333-8333-333333333333" },
      },
      { ok: true, text: "answer from B" },
    ),
  ]);

  expect(completionAB?.requestMessageId).toBe(receiptAB.messageId);
  expect(completionAB?.result).toBe("answer from B");
  // Completion travels reverse to the source: `to` = original sender, `from` = peer.
  expect(completionAB?.to.endpointId).toBe("22222222-2222-4222-8222-222222222222");
  expect(completionAB?.from.endpointId).toBe("33333333-3333-4333-8333-333333333333");
  expect(completionCD?.requestMessageId).toBe(receiptCD.messageId);
  expect(completionCD?.result).toBe("answer from D");
  expect(completionCD?.to.endpointId).toBe("44444444-4444-4444-8444-444444444444");
  expect(completionCD?.from.endpointId).toBe("55555555-5555-4555-8555-555555555555");

  // Exactly one injection per pair, each carrying only its own result.
  expect(deliveredCompletions).toHaveLength(2);
  const byResult = new Map(deliveredCompletions.map((d) => [d.completion.result, d]));
  const bDelivery = byResult.get("answer from B");
  const dDelivery = byResult.get("answer from D");
  expect(bDelivery).toBeDefined();
  expect(dDelivery).toBeDefined();
  expect(bDelivery!.alias).toBe("main");
  expect(dDelivery!.alias).toBe("third");

  // History patches carry their own requestMessageId — no identity bleed.
  const patches = emitted.filter((e): e is Extract<ControlEvent, { type: "agent-message-completion" }> => e.type === "agent-message-completion");
  expect(patches).toHaveLength(2);
  const statusById = new Map(patches.map((p) => [p.messageId, p.completionStatus]));
  expect(statusById.get(receiptAB.messageId)).toBe("completed");
  expect(statusById.get(receiptCD.messageId)).toBe("completed");
});


test("Round-3: durable reserve happens BEFORE dispatch — a store save failure fails the send closed", async () => {
  const events = createControlEventBus();
  const deliveries: unknown[] = [];
  let idSeq = 0;
  const { router, state } = makeRouter({
    events,
    createId: () => `uuid-${++idSeq}`,
    delivery: {
      deliver: async (target, message) => {
        deliveries.push(message);
        return { status: "queued" as const, modeUsed: "queue" as const };
      },
    },
  });
  addLogicalPeers(state);
  let saveCalls = 0;
  const routerWithStore = router as unknown as {
    deps: {
      delivery: LocalAgentMessageDelivery;
      pendingCompletionStore?: {
        load(): never[];
        save(grants: unknown[]): void;
      };
    };
  };
  let failSave = true;
  routerWithStore.deps.pendingCompletionStore = {
    load: () => [],
    save: (grants) => {
      saveCalls += 1;
      if (failSave) throw new Error("disk full");
      void grants;
    },
  };

  const to = encodeAgentHandle({ nodeId, endpointId: LOGICAL_TARGET_ID });

  // Persistence failure → the completion-bearing request fails CLOSED and
  // nothing is dispatched to the target.
  await expect(
    router.send(LOGICAL_SENDER, { to, content: "must not be sent", completion: "result" }),
  ).rejects.toMatchObject({ code: "DELIVERY_FAILED" });
  expect(deliveries).toHaveLength(0);

  // One-way messages are unaffected by the completion store.
  await router.send(LOGICAL_SENDER, { to, content: "one way ok" });
  expect(deliveries).toHaveLength(1);

  // Once the store recovers, the same completion request succeeds.
  failSave = false;
  await router.send(LOGICAL_SENDER, { to, content: "now it works", completion: "result" });
  expect(deliveries).toHaveLength(2);
});

test("Round-3: capacity is BACKPRESSURE — the oldest active contract is never evicted", async () => {
  const events = createControlEventBus();
  const deliveredCompletions: AgentMessageCompletion[] = [];
  let idSeq = 0;
  const { router, state } = makeRouter({
    events,
    createId: () => `uuid-${++idSeq}`,
    limits: { pendingCompletion: { maxEntries: 2, ttlMs: 60 * 60_000 } },
  });
  addLogicalPeers(state);
  (router as unknown as { deps: { delivery: { deliverCompletion?: (alias: string, c: AgentMessageCompletion, id: string) => Promise<{ status: "injected" }> } } }).deps.delivery.deliverCompletion = async (
    _alias,
    completion,
  ) => {
    deliveredCompletions.push(completion);
    return { status: "injected" as const };
  };
  const toSecond = encodeAgentHandle({ nodeId, endpointId: "33333333-3333-4333-8333-333333333333" });
  const toFourth = encodeAgentHandle({ nodeId, endpointId: "55555555-5555-4555-8555-555555555555" });

  // Fill both grant slots.
  const r1 = await router.send(LOGICAL_SENDER, { to: toSecond, content: "task B", completion: "result" });
  const r2 = await router.send(
    { coordinatorSession: "coordinator-third" },
    { to: toFourth, content: "task D", completion: "result" },
  );

  // A THIRD request must be refused rather than evicting r1/r2's contracts.
  await expect(
    router.send(LOGICAL_SENDER, { to: toSecond, content: "task overflow", completion: "notify" }),
  ).rejects.toMatchObject({ code: "MESSAGE_QUEUE_FULL" });

  // The FIRST contract is still alive: its completion is honored.
  const firstCompletion = await router.completePeerTurn(
    {
      requestMessageId: r1.messageId,
      completion: "result",
      source: { nodeId, endpointId: "22222222-2222-4222-8222-222222222222" },
      target: { nodeId, endpointId: "33333333-3333-4333-8333-333333333333" },
    },
    { ok: true, text: "answer for B" },
  );
  expect(firstCompletion?.status).toBe("completed");
  expect(deliveredCompletions).toHaveLength(1);
  // Delivered on delivery → row retained as a terminal tombstone (state
  // flips to delivered; capacity counts only pending contracts).
  expect(
    (
      router as unknown as { pendingCompletions: Map<string, { state: string }> }
    ).pendingCompletions.get(r1.messageId)?.state,
  ).toBe("delivered");

  // A duplicate of the RETIRED contract is absorbed by the terminal tombstone
  // instead of re-denying.
  const dup = await router.completePeerTurn(
    {
      requestMessageId: r1.messageId,
      completion: "result",
      source: { nodeId, endpointId: "22222222-2222-4222-8222-222222222222" },
      target: { nodeId, endpointId: "33333333-3333-4333-8333-333333333333" },
    },
    { ok: true, text: "late duplicate terminal" },
  );
  expect(dup).toBe(firstCompletion);
  expect(deliveredCompletions).toHaveLength(1);

  // r2's contract was untouched the whole time.
  expect((router as unknown as { pendingCompletions: Map<string, unknown> }).pendingCompletions.has(r2.messageId)).toBe(true);
});

test("Round-3: a DEFINITE remote rejection releases the reservation; ambiguous outcomes retain it", async () => {
  const events = createControlEventBus();
  let idSeq = 0;
  const base = {
    events,
    createId: () => `uuid-${++idSeq}`,
  };

  // Definite rejection (target node offline at route time).
  {
    const { router, state } = makeRouter({ ...base });
    addLogicalPeers(state);
    // No remoteRoute configured → ROUTE_UNAVAILABLE (definite).
    await expect(
      router.send(LOGICAL_SENDER, {
        to: encodeAgentHandle({ nodeId: "node_remote_x", endpointId: "ep_remote" }),
        content: "x",
        completion: "result",
      }),
    ).rejects.toMatchObject({ code: "ROUTE_UNAVAILABLE" });
    // Reservation released — nothing pending.
    expect((router as unknown as { pendingCompletions: Map<string, unknown> }).pendingCompletions.size).toBe(0);
  }

  // Ambiguous outcome (ACK lost → DELIVERY_TIMEOUT): reservation retained.
  {
    const remoteRoute = new RelayAgentMessageRoute({
      sendAgentMessageRoute: async () => {
        throw Object.assign(new Error("ack lost"), { code: "DELIVERY_TIMEOUT" });
      },
    });
    const { router, state, registry } = makeRouter({ ...base, remoteRoute });
    addLogicalPeers(state);
    registry.updateRemoteEndpoints("node_remote_x", [
      {
        address: { nodeId: "node_remote_x", endpointId: "ep_remote" },
        handle: encodeAgentHandle({ nodeId: "node_remote_x", endpointId: "ep_remote" }),
        node: "Remote X",
        displayName: "Remote X",
        agent: "claude",
        state: "idle",
        activity: { status: "idle" },
        capabilities: {
          receive: true,
          steer: false,
          queue: true,
          interrupt: false,
          conversation: true,
          completion: true,
        },
      },
    ]);
    await expect(
      router.send(LOGICAL_SENDER, {
        to: encodeAgentHandle({ nodeId: "node_remote_x", endpointId: "ep_remote" }),
        content: "x",
        completion: "result",
      }),
    ).rejects.toMatchObject({ code: "DELIVERY_TIMEOUT" });
    // Retained: the target may have accepted.
    expect((router as unknown as { pendingCompletions: Map<string, unknown> }).pendingCompletions.size).toBe(1);
  }
});


test("Round-4 (B2): terminal outbox never evicts — saturated obligations all deliver exactly once after recovery", async () => {
  const events = createControlEventBus();
  const deliveredCompletions: AgentMessageCompletion[] = [];
  let idSeq = 0;
  let admissionFail = true;

  const { router, state } = makeRouter({
    events,
    createId: () => `uuid-${++idSeq}`,
    limits: { pendingCompletion: { maxEntries: 3, ttlMs: 60 * 60_000 } },
  });
  addLogicalPeers(state);
  (router as unknown as { deps: { delivery: { deliverCompletion?: (alias: string, c: AgentMessageCompletion, id: string) => Promise<{ status: "injected" | "queued" } | { status: "rejected"; reason: string }> } } }).deps.delivery.deliverCompletion = async (
    _alias,
    completion,
  ) => {
    if (admissionFail) {
      // Source session busy/queue-full: admission rejected, delivery pending.
      return { status: "rejected" as const, reason: "queue-full" };
    }
    deliveredCompletions.push(completion);
    return { status: "injected" as const };
  };

  const toSecond = encodeAgentHandle({ nodeId, endpointId: "33333333-3333-4333-8333-333333333333" });

  // Three accepted completion contracts; ALL of their admissions fail while
  // the source is busy → three undelivered obligations pile up in the outbox.
  const receipts: string[] = [];
  for (const content of ["task 1", "task 2", "task 3"]) {
    const receipt = await router.send(LOGICAL_SENDER, { to: toSecond, content, completion: "result" });
    receipts.push(receipt.messageId);
    await router.completePeerTurn(
      {
        requestMessageId: receipt.messageId,
        completion: "result",
        source: { nodeId, endpointId: "22222222-2222-4222-8222-222222222222" },
        target: { nodeId, endpointId: LOGICAL_TARGET_ID },
      },
      { ok: true, text: `answer ${content}` },
    );
  }
  expect(deliveredCompletions).toHaveLength(0);

  // The outbox holds every obligation — nothing was evicted.
  const outbox = (
    router as unknown as { deliveryPending: Map<string, unknown> }
  ).deliveryPending;
  expect(outbox.size).toBe(3);

  // A FOURTH contract must be refused by backpressure rather than accepted
  // and later silently dropped.
  await expect(
    router.send(LOGICAL_SENDER, { to: toSecond, content: "task overflow", completion: "result" }),
  ).rejects.toMatchObject({ code: "MESSAGE_QUEUE_FULL" });

  // Route recovers: the sweep delivers EVERY accepted obligation exactly once.
  admissionFail = false;
  await router.sweepPendingCompletionDeliveries(true);

  expect(deliveredCompletions).toHaveLength(3);
  const results = deliveredCompletions.map((c) => c.result).sort();
  expect(results).toEqual(["answer task 1", "answer task 2", "answer task 3"]);

  // Grants retired; a second sweep delivers nothing further.
  await router.sweepPendingCompletionDeliveries();
  expect(deliveredCompletions).toHaveLength(3);
  // All three grants flipped to delivered tombstones (retained until TTL;
  // capacity counts only pending contracts).
  {
    const grants = (
      router as unknown as { pendingCompletions: Map<string, { state: string }> }
    ).pendingCompletions;
    expect(grants.size).toBe(3);
    for (const g of grants.values()) expect(g.state).toBe("delivered");
  }
});


test("Round-5 (Q2): admission failure returns ok:false so the Hub keeps its durable grant", async () => {
  const events = createControlEventBus();
  const { router, state } = makeRouter({ events });
  addLogicalPeers(state);
  (router as unknown as { deps: { delivery: { deliverCompletion?: () => Promise<{ status: "rejected"; reason: string }> } } }).deps.delivery.deliverCompletion = async () => ({
    status: "rejected" as const,
    reason: "queue-full",
  });

  // A live grant exists (as if this daemon had sent the request earlier).
  (router as unknown as { pendingCompletions: Map<string, unknown> }).pendingCompletions.set(
    "msg_q2_pending",
    {
      source: { nodeId, endpointId: "22222222-2222-4222-8222-222222222222" },
      target: { nodeId, endpointId: LOGICAL_TARGET_ID },
      mode: "result",
      expiresAt: Date.now() + 60_000,
    },
  );

  const res = await router.deliverInboundCompletion({
    requestMessageId: "msg_q2_pending",
    source: { nodeId, endpointId: "22222222-2222-4222-8222-222222222222" },
    target: { nodeId, endpointId: LOGICAL_TARGET_ID },
    status: "completed",
    result: "not yet deliverable",
    completedAt: Date.now(),
  });

  // DURABLE ACK RULE: {ok:true} would let the Hub retire its route grant while
  // the only copy of the result sits in the RAM outbox. Failure keeps the
  // target's retry chain alive.
  expect(res.ok).toBe(false);
});

test("Round-5 (Q3): the target-side terminal completion outbox is durable across router recreation", async () => {
  const events = createControlEventBus();
  const deliveredCompletions: AgentMessageCompletion[] = [];
  const outboxEntries = new Map<
    string,
    {
      key: string;
      kind: "local" | "remote";
      requestMessageId: string;
      senderSessionAlias?: string;
      completion: AgentMessageCompletion;
      expiresAt: number;
    }
  >();
  let idSeq = 0;
  // The TARGET daemon (B): its peer turn finished, but the reverse Relay
  // delivery initially fails (Relay offline / source busy). The obligation
  // lands in B's DURABLE outbox.
  let sendCompletionCalls = 0;
  const deliveredPayloadResults: string[] = [];
  const buildRouter = (relayUp: boolean) => {
    const remoteRoute = new RelayAgentMessageRoute({
      sendAgentMessageRoute: async () => ({ messageId: "x", status: "queued" }),
      sendAgentMessageCompletion: async (payload) => {
        sendCompletionCalls += 1;
        if (!relayUp) {
          throw Object.assign(new Error("relay unreachable"), {
            code: "DELIVERY_TIMEOUT",
          });
        }
        deliveredPayloadResults.push(payload.result ?? "");
        return { ok: true };
      },
    });
    const { router, state } = makeRouter({
      events,
      createId: () => `uuid-${++idSeq}`,
      remoteRoute,
      completionOutboxStore: {
        load: () => [...outboxEntries.values()],
        upsert: (entry) => void outboxEntries.set(entry.key, entry),
        delete: (key) => void outboxEntries.delete(key),
      },
    });
    addLogicalPeers(state);
    return router;
  };

  const router1 = buildRouter(false);
  const origin = {
    requestMessageId: "msg_outbox_restart",
    completion: "result" as const,
    source: { nodeId: "node_remote_source", endpointId: "worker_remote_source" },
    target: { nodeId, endpointId: LOGICAL_TARGET_ID },
  };

  // B's peer turn finishes while the Relay is DOWN: ambiguous outcome, the
  // obligation is durably persisted for retry.
  await router1.completePeerTurn(origin, { ok: true, text: "survives restart" });
  expect(outboxEntries.size).toBe(1);
  expect(deliveredCompletions).toHaveLength(0);

  // Daemon restart: a FRESH router hydrates the outbox and re-arms retries.
  const router2 = buildRouter(true);
  expect(
    (router2 as unknown as { deliveryPending: Map<string, unknown> }).deliveryPending
      .size,
  ).toBe(1);

  // Relay recovers: the sweep delivers the completion exactly once.
  await router2.sweepPendingCompletionDeliveries(true);
  expect(deliveredPayloadResults).toEqual(["survives restart"]);
  expect(outboxEntries.size).toBe(0);

  // Note: a duplicate TERMINAL replayed on the restarted router would forward
  // again at this layer (the target outcomes cache is per-process); in
  // production the SOURCE absorbs that duplicate via its completionInjections
  // tombstone — covered by the deliverInboundCompletion dedupe tests.
});

test("Round-6 (final blocker): delivered source grant survives restart — target retry is deduplicated, zero second turn", async () => {
  const events = createControlEventBus();
  const deliveredCompletions: AgentMessageCompletion[] = [];
  const grantStore = new Map<
    string,
    {
      requestMessageId: string;
      source: { nodeId: string; endpointId: string };
      target: { nodeId: string; endpointId: string };
      mode: "notify" | "result";
      expiresAt: number;
      state: "pending" | "delivered";
    }
  >();
  let admissionCalls = 0;

  const buildRouter = () => {
    const { router, state } = makeRouter({
      events,
      delivery: {
        deliver: async () => ({ status: "queued" as const, modeUsed: "queue" as const }),
        deliverCompletion: async (_alias, completion) => {
          admissionCalls += 1;
          deliveredCompletions.push(completion);
          return { status: "injected" as const };
        },
      },
      pendingCompletionStore: {
        load: () => [...grantStore.entries()].map(([requestMessageId, g]) => ({ requestMessageId, ...g })),
        save: (grants) => {
          for (const g of grants) grantStore.set(g.requestMessageId, g);
        },
      },
    });
    addLogicalPeers(state);
    return router;
  };

  // Process 1 (source daemon A): completion accepted and admitted.
  const router1 = buildRouter();
  (router1 as unknown as { pendingCompletions: Map<string, unknown> }).pendingCompletions.set(
    "msg_final_blocker",
    {
      source: { nodeId, endpointId: "22222222-2222-4222-8222-222222222222" },
      target: { nodeId, endpointId: LOGICAL_TARGET_ID },
      mode: "result",
      expiresAt: Date.now() + 60_000,
      state: "pending" as const,
    },
  );

  // First delivery attempt: admitted exactly once.
  const res1 = await router1.deliverInboundCompletion({
    requestMessageId: "msg_final_blocker",
    source: { nodeId, endpointId: "22222222-2222-4222-8222-222222222222" },
    target: { nodeId, endpointId: LOGICAL_TARGET_ID },
    status: "completed",
    result: "the answer",
    completedAt: Date.now(),
  });
  expect(res1.ok).toBe(true);
  expect(admissionCalls).toBe(1);

  // The durable store must already read state=delivered BEFORE any restart.
  expect(grantStore.get("msg_final_blocker")?.state).toBe("delivered");
  // The durable store must already read state=delivered BEFORE any restart.

  // ---- Source daemon RESTARTS (fresh router, same store). ----
  const router2 = buildRouter();

  // The target's durable retry arrives at the restarted source.
  const res2 = await router2.deliverInboundCompletion({
    requestMessageId: "msg_final_blocker",
    source: { nodeId, endpointId: "22222222-2222-4222-8222-222222222222" },
    target: { nodeId, endpointId: LOGICAL_TARGET_ID },
    status: "completed",
    result: "the answer",
    completedAt: Date.now(),
  });

  // Deduplicated — NOT re-injected, NOT DELIVERY_DENIED.
  expect(res2.ok).toBe(true);
  expect(res2.deduplicated).toBe(true);
  expect(admissionCalls).toBe(1);

  // The delivered tombstone survives further restarts until TTL.
  expect(grantStore.get("msg_final_blocker")?.state).toBe("delivered");
});


test("Round-6 (final gate): persistence failure must NEVER be published as {ok:true}", async () => {
  const events = createControlEventBus();
  const deliveredCompletions: AgentMessageCompletion[] = [];
  let admissionCalls = 0;
  const grantStore = new Map<
    string,
    {
      requestMessageId: string;
      source: { nodeId: string; endpointId: string };
      target: { nodeId: string; endpointId: string };
      mode: "notify" | "result";
      expiresAt: number;
      state: "pending" | "delivered";
    }
  >();
  let saveFails = true;

  const buildRouter = () => {
    const { router, state } = makeRouter({
      events,
      delivery: {
        deliver: async () => ({ status: "queued" as const, modeUsed: "queue" as const }),
        deliverCompletion: async (_alias, completion) => {
          admissionCalls += 1;
          deliveredCompletions.push(completion);
          return { status: "injected" as const };
        },
      },
      pendingCompletionStore: {
        load: () => [...grantStore.entries()].map(([requestMessageId, g]) => ({ requestMessageId, ...g })),
        save: (grants) => {
          for (const g of grants) {
            // Simulate the durable write failing while the failure window is
            // armed (first persist attempt only).
            if (saveFails && g.state === "delivered") throw new Error("disk full");
            grantStore.set(g.requestMessageId, g);
          }
        },
      },
    });
    addLogicalPeers(state);
    return router;
  };

  const router1 = buildRouter();
  const seededGrant = {
    requestMessageId: "msg_final_gate",
    source: { nodeId, endpointId: "22222222-2222-4222-8222-222222222222" },
    target: { nodeId, endpointId: LOGICAL_TARGET_ID },
    mode: "result" as const,
    expiresAt: Date.now() + 60_000,
    state: "pending" as const,
  };
  // The durable RESERVE already persisted this grant (production order:
  // reserve-before-dispatch), so the store starts materialized.
  grantStore.set("msg_final_gate", seededGrant);
  (router1 as unknown as { pendingCompletions: Map<string, unknown> }).pendingCompletions.set(
    "msg_final_gate",
    seededGrant,
  );

  const sendCompletion = () =>
    router1.deliverInboundCompletion({
      requestMessageId: "msg_final_gate",
      source: { nodeId, endpointId: "22222222-2222-4222-8222-222222222222" },
      target: { nodeId, endpointId: LOGICAL_TARGET_ID },
      status: "completed",
      result: "the answer",
      completedAt: Date.now(),
    });

  // Attempt 1: admission succeeds exactly once, but the durable delivered
  // transition FAILS → source MUST NOT answer ok:true.
  const res1 = await sendCompletion();
  expect(res1.ok).toBe(false);
  expect(admissionCalls).toBe(1);
  // The earlier durable RESERVE wrote the pending row to the store; the
  // failed mark-delivered left it untouched (RAM rolled back, store kept).
  expect(grantStore.get("msg_final_gate")?.state).toBe("pending");

  // Storage recovers. Retry: the TurnQueue seam absorbs the duplicate
  // admission; the durable delivered transition now persists → ok:true.
  saveFails = false;
  const res2 = await sendCompletion();
  expect(res2.ok).toBe(true);

  // Delivered state persisted.
  expect(grantStore.get("msg_final_gate")?.state).toBe("delivered");

  // ---- Source restart: fresh router on the same store. ----
  const router2 = buildRouter();
  const res3 = await router2.deliverInboundCompletion({
    requestMessageId: "msg_final_gate",
    source: { nodeId, endpointId: "22222222-2222-4222-8222-222222222222" },
    target: { nodeId, endpointId: LOGICAL_TARGET_ID },
    status: "completed",
    result: "replayed after restart",
    completedAt: Date.now(),
  });

  // Replay returns ok:true + deduplicated:true via the delivered tombstone.
  // (The raw deliverCompletion mock admits every call — cross-restart
  // admission-count guarantees are enforced one layer down by the
  // TurnQueue's promptRequestId dedupe, gated separately.)
  expect(res3.ok).toBe(true);
  expect(res3.deduplicated).toBe(true);
});


test("Round-6 follow-up 2 (target-side outbox reservation): a saturated terminal outbox refuses NEW completion-bearing requests at ACCEPTANCE time", async () => {
  const events = createControlEventBus();
  const deliveredCompletions: AgentMessageCompletion[] = [];
  let idSeq = 0;
  let relayReachable = false;

  // This daemon is the TARGET of two remote completion-bearing requests.
  const buildRouter = () => {
    const remoteRoute = new RelayAgentMessageRoute({
      sendAgentMessageRoute: async () => ({ messageId: "x", status: "queued" }),
      sendAgentMessageCompletion: async (payload) => {
        if (!relayReachable) {
          throw Object.assign(new Error("relay unreachable"), {
            code: "DELIVERY_TIMEOUT",
          });
        }
        deliveredCompletions.push({ result: payload.result ?? "" } as AgentMessageCompletion);
        return { ok: true };
      },
    });
    const { router, state } = makeRouter({
      events,
      createId: () => `uuid-${++idSeq}`,
      remoteRoute,
      limits: { pendingCompletion: { maxEntries: 1, ttlMs: 60 * 60_000 } },
    });
    addLogicalPeers(state);
    return router;
  };

  const router = buildRouter();
  const makeOrigin = (id: string) => ({
    requestMessageId: id,
    completion: "result" as const,
    source: { nodeId: "node_remote_source", endpointId: "worker_remote_source" },
    target: { nodeId, endpointId: LOGICAL_TARGET_ID },
  });

  // Obligation #1: peer turn finishes while the Relay is DOWN → durable outbox
  // entry created (target retains its retry duty).
  await router.completePeerTurn(makeOrigin("msg_obligation_1"), {
    ok: true,
    text: "answer 1",
  });
  expect(
    (router as unknown as { deliveryPending: Map<string, unknown> }).deliveryPending
      .size,
  ).toBe(1);

  // A NEW completion-bearing request accepted by THIS daemon must be refused
  // at ACCEPTANCE time — the target's own outbox budget is exhausted. It does
  // NOT depend on the remote source's grant budget.
  await expect(
    router.deliverInbound({
      sourceNodeId: nodeId,
      sourceEndpointId: "endpoint_remote_source",
      targetEndpointId: LOGICAL_TARGET_ID,
      messageId: "msg_new_completion_request",
      content: "new work",
      requestedMode: "queue",
      replyable: false,
      completion: "result",
    }),
  ).rejects.toMatchObject({ code: "MESSAGE_QUEUE_FULL" });

  // Relay recovers: the sweep delivers obligation #1 exactly once and frees
  // the slot.
  relayReachable = true;
  expect(deliveredCompletions).toHaveLength(0);
  await router.sweepPendingCompletionDeliveries(true);
  expect(deliveredCompletions).toHaveLength(1);
  expect(
    (router as unknown as { deliveryPending: Map<string, unknown> }).deliveryPending
      .size,
  ).toBe(0);

  // Capacity returned: a new completion-bearing request is admitted again.
  const recovered = await router.deliverInbound({
    sourceNodeId: nodeId,
    sourceEndpointId: "endpoint_remote_source",
    targetEndpointId: LOGICAL_TARGET_ID,
    messageId: "msg_after_recovery",
    content: "more work",
    requestedMode: "queue",
    replyable: false,
    completion: "result",
  });
  expect(recovered.status).toBe("queued");
});

test("M2: A accepted but NOT terminal yet — B is rejected at cap=1 at ACCEPTANCE time", async () => {
  let idSeq = 0;
  const { router, state } = makeRouter({
    createId: () => `uuid-${++idSeq}`,
    limits: { pendingCompletion: { maxEntries: 1, ttlMs: 60 * 60_000 } },
  });
  addLogicalPeers(state);

  const accept = (id: string) =>
    router.deliverInbound({
      sourceNodeId: nodeId,
      sourceEndpointId: "endpoint_remote_source",
      targetEndpointId: LOGICAL_TARGET_ID,
      messageId: id,
      content: "work",
      requestedMode: "queue",
      replyable: false,
      completion: "result",
    });

  // A accepted: slot reserved at acceptance — A's peer turn has NOT even
  // been submitted yet, let alone completed.
  const receiptA = await accept("msg_m2_a");
  expect(receiptA.status).toBe("queued");

  // B arrives while A is merely accepted (not terminal): refused.
  await expect(accept("msg_m2_b")).rejects.toMatchObject({
    code: "MESSAGE_QUEUE_FULL",
  });
});

test("B2: an accepted-but-stale reservation EXPIRES at its contract TTL — the slot frees without any terminal outcome", async () => {
  let idSeq = 0;
  let now = 1_000_000;
  const { router, state } = makeRouter({
    createId: () => `uuid-${++idSeq}`,
    now: () => now,
    limits: { pendingCompletion: { maxEntries: 1, ttlMs: 60 * 60_000 } },
  });
  addLogicalPeers(state);

  const accept = (id: string) =>
    router.deliverInbound({
      sourceNodeId: nodeId,
      sourceEndpointId: "endpoint_remote_source",
      targetEndpointId: LOGICAL_TARGET_ID,
      messageId: id,
      content: "work",
      requestedMode: "queue",
      replyable: false,
      completion: "result",
    });

  // A accepted (slot reserved). Ambiguous outcome: A never completes, the
  // reservation is never explicitly released.
  const receiptA = await accept("msg_b2_a");
  expect(receiptA.status).toBe("queued");
  await expect(accept("msg_b2_b")).rejects.toMatchObject({
    code: "MESSAGE_QUEUE_FULL",
  });

  // Contract TTL elapses: the expired reservation is pruned before the
  // capacity count, so B is admitted.
  now += 61 * 60_000;
  const receiptB = await accept("msg_b2_c");
  expect(receiptB.status).toBe("queued");
});


test("M1: persist-recovery preserves kind=local + senderSessionAlias — a failed local outbox upsert is retried with its exact durable shape", async () => {
  const events = createControlEventBus();
  let idSeq = 0;
  let storeHealthy = false;
  const upserts: Array<{
    key: string;
    kind: string;
    requestMessageId: string;
    senderSessionAlias?: string;
  }> = [];

  const { router, state } = makeRouter({
    events,
    createId: () => `uuid-${++idSeq}`,
    limits: { pendingCompletion: { maxEntries: 10, ttlMs: 60 * 60_000 } },
    completionOutboxStore: {
      load: () => [],
      upsert: (entry) => {
        if (!storeHealthy) throw new Error("disk full");
        upserts.push({
          key: entry.key,
          kind: entry.kind,
          requestMessageId: entry.requestMessageId,
          ...(entry.senderSessionAlias !== undefined
            ? { senderSessionAlias: entry.senderSessionAlias }
            : {}),
        });
      },
      delete: () => {},
    },
    delivery: {
      deliver: async () => ({ status: "queued" as const, modeUsed: "queue" as const }),
      // Local sender lane admission keeps failing → the local completion
      // obligation lands in the retry outbox.
      deliverCompletion: async () => ({ status: "rejected", reason: "busy-until-restart" }),
    },
  });
  addLogicalPeers(state);

  // Real send with completion=result from the local coordinator session.
  const receipt = await router.send(LOGICAL_SENDER, {
    to: encodeAgentHandle({ nodeId, endpointId: LOGICAL_TARGET_ID }),
    content: "work",
    completion: "result",
  });

  // Target turn completes; the LOCAL delivery cannot be admitted → scheduled
  // with kind:"local" + senderSessionAlias; the durable upsert FAILS (disk).
  const completion = await router.completePeerTurn(
    {
      requestMessageId: receipt.messageId,
      completion: "result",
      source: { nodeId, endpointId: "22222222-2222-4222-8222-222222222222" },
      target: { nodeId, endpointId: LOGICAL_TARGET_ID },
    },
    { ok: true, text: "answer" },
  );
  expect(completion?.status).toBe("completed");
  expect(upserts).toHaveLength(0); // persist failed

  // Storage recovers: the sweep recovery pass re-persists with the EXACT
  // durable shape — kind:"local" (not "remote") and the sender alias.
  storeHealthy = true;
  await router.sweepPendingCompletionDeliveries(true);
  expect(upserts).toHaveLength(1);
  expect(upserts[0]!.kind).toBe("local");
  expect(upserts[0]!.senderSessionAlias).toBe("main");
  expect(upserts[0]!.requestMessageId).toBe(receipt.messageId);
});


test("Medium-1: deliverInbound independently rejects completion=result for a target without completion capability, consuming no outbox slot", async () => {
  let idSeq = 0;
  const { router, state } = makeRouter({
    createId: () => `uuid-${++idSeq}`,
    limits: { pendingCompletion: { maxEntries: 1, ttlMs: 60 * 60_000 } },
  });
  // Target WITHOUT completion capability.
  addLogicalPeers(state);
  const reg = (router as unknown as { deps: { registry: { resolveLocalTargetByEndpointId: (id: string) => Promise<unknown> } } }).deps.registry;
  const origResolve = reg.resolveLocalTargetByEndpointId.bind(reg);
  (reg as { resolveLocalTargetByEndpointId: (id: string) => Promise<unknown> }).resolveLocalTargetByEndpointId =
    async (id: string) => {
      const resolved = (await origResolve(id)) as {
        endpoint: { capabilities: Record<string, unknown> };
      };
      if (resolved && id === LOGICAL_TARGET_ID) {
        resolved.endpoint.capabilities.completion = false;
      }
      return resolved;
    };

  const accept = (id: string) =>
    router.deliverInbound({
      sourceNodeId: nodeId,
      sourceEndpointId: "endpoint_remote_source",
      targetEndpointId: LOGICAL_TARGET_ID,
      messageId: id,
      content: "work",
      requestedMode: "queue",
      replyable: false,
      completion: "result",
    });

  await expect(accept("msg_cap_1")).rejects.toMatchObject({
    code: "COMPLETION_NOT_SUPPORTED",
  });

  // No terminal-outbox slot was consumed: the reservation was never made.
  const reservations = (router as unknown as { outboxReservations: Map<string, unknown> }).outboxReservations;
  expect(reservations.size).toBe(0);
});

test("Medium-2: an expired pending grant resolves the sender card with a terminal cancelled patch instead of silent deletion", async () => {
  const events = createControlEventBus();
  const emitted: ControlEvent[] = [];
  events.subscribe((e) => emitted.push(e));
  let idSeq = 0;
  let now = 1_000_000;

  const { router, state } = makeRouter({
    events,
    createId: () => `uuid-${++idSeq}`,
    now: () => now,
    limits: { pendingCompletion: { maxEntries: 5, ttlMs: 60 * 60_000 } },
  });
  addLogicalPeers(state);

  // Real completion-bearing send creates the pending grant.
  const receipt = await router.send(LOGICAL_SENDER, {
    to: encodeAgentHandle({ nodeId, endpointId: LOGICAL_TARGET_ID }),
    content: "long task",
    completion: "notify",
  });
  expect(
    (router as unknown as { pendingCompletions: Map<string, { state: string }> })
      .pendingCompletions.get(receipt.messageId)?.state,
  ).toBe("pending");

  // TTL elapses with NO terminal outcome. The next router activity (a new
  // send) runs the resolving pass.
  now += 61 * 60_000;
  await router.send(LOGICAL_SENDER, {
    to: encodeAgentHandle({ nodeId, endpointId: LOGICAL_TARGET_ID }),
    content: "another task",
    completion: "none",
  });

  // The sender card got exactly one terminal CANCELLED patch for the
  // expired contract — never left Waiting.
  const patches = emitted.filter(
    (e): e is Extract<ControlEvent, { type: "agent-message-completion" }> =>
      e.type === "agent-message-completion",
  );
  expect(patches).toHaveLength(1);
  expect(patches[0]!.messageId).toBe(receipt.messageId);
  expect(patches[0]!.completionStatus).toBe("cancelled");

  // Capacity freed: the expired grant no longer counts.
  expect(
    (router as unknown as { pendingCompletions: Map<string, { state: string }> })
      .pendingCompletions.has(receipt.messageId),
  ).toBe(false);
});

test("Medium-3: admission dedupe survives TurnQueue tombstone eviction — a duplicate completion is absorbed by the router-owned tombstone", async () => {
  const events = createControlEventBus();
  let idSeq = 0;
  let delivered = 0;

  const { router, state } = makeRouter({
    events,
    createId: () => `uuid-${++idSeq}`,
    delivery: {
      deliver: async () => ({ status: "queued" as const, modeUsed: "queue" as const }),
      deliverCompletion: async (_alias: string, completion: { result?: string }) => {
        delivered++;
        expect(completion.result).toBe("answer");
        return { status: "injected" as const };
      },
    },
  });
  addLogicalPeers(state);

  const receipt = await router.send(LOGICAL_SENDER, {
    to: encodeAgentHandle({ nodeId, endpointId: LOGICAL_TARGET_ID }),
    content: "work",
    completion: "result",
  });

  const origin = {
    requestMessageId: receipt.messageId,
    completion: "result" as const,
    source: { nodeId, endpointId: "22222222-2222-4222-8222-222222222222" },
    target: { nodeId, endpointId: LOGICAL_TARGET_ID },
  };

  // First completion: admitted + delivered once.
  const first = await router.completePeerTurn(origin, { ok: true, text: "answer" });
  expect(first?.status).toBe("completed");
  expect(delivered).toBe(1);

  // The ROUTER-owned tombstone (markGrantDelivered → completionInjections,
  // durable-first) is the dedupe under test here — it must absorb the
  // duplicate independently of the TurnQueue's bounded FIFO. (The TurnQueue
  // layer sits behind ControlService and is gated separately.)

  // Duplicate terminal delivery (at-least-once retry from the target):
  // absorbed — no second deliverCompletion.
  const dup = await router.completePeerTurn(origin, { ok: true, text: "answer" });
  expect(dup?.status).toBe("completed");
  expect(delivered).toBe(1);
});



test("#295a: stale-capability rejection compensates the SOURCE grant — target returns COMPLETION_NOT_SUPPORTED over relay", async () => {
  let idSeq = 0;
  const remoteRoute = new RelayAgentMessageRoute({
    // The hub forwards the target's definite capability rejection; the route
    // layer rethrows it as a typed AgentMessagingError.
    sendAgentMessageRoute: async () => {
      throw Object.assign(new Error("COMPLETION_NOT_SUPPORTED"), {
        code: "COMPLETION_NOT_SUPPORTED",
      });
    },
  });
  const { router, state, registry } = makeRouter({
    createId: () => `uuid-${++idSeq}`,
    remoteRoute,
  });
  addLogicalPeers(state);
  // Source snapshot: the remote endpoint STILL advertised completion.
  registry.updateRemoteEndpoints("node_remote_x", [
    {
      address: { nodeId: "node_remote_x", endpointId: "ep_remote" },
      handle: encodeAgentHandle({ nodeId: "node_remote_x", endpointId: "ep_remote" }),
      node: "Remote X",
      displayName: "Remote X",
      agent: "claude",
      state: "idle",
      activity: { status: "idle" },
      capabilities: {
        receive: true,
        steer: false,
        queue: true,
        interrupt: false,
        conversation: true,
        completion: true,
      },
    },
  ]);

  await expect(
    router.send(LOGICAL_SENDER, {
      to: encodeAgentHandle({ nodeId: "node_remote_x", endpointId: "ep_remote" }),
      content: "stale directory race",
      completion: "result",
    }),
  ).rejects.toMatchObject({ code: "COMPLETION_NOT_SUPPORTED" });

  // The stale source grant was compensated immediately — not left to TTL.
  expect(
    (router as unknown as { pendingCompletions: Map<string, unknown> })
      .pendingCompletions.size,
  ).toBe(0);
});

test("#296: grants expired DURING downtime are terminalized on the first pass after restart — sender card patched, durable row pruned", async () => {
  const events = createControlEventBus();
  const emitted: ControlEvent[] = [];
  events.subscribe((e) => emitted.push(e));
  let now = 1_000_000;

  const savedGrants: Array<{ requestMessageId: string; state?: string }> = [];
  const { router, registry } = makeRouter({
    events,
    now: () => now,
    pendingCompletionStore: {
      load: () => [
        {
          requestMessageId: "msg_expired_downtime",
          source: { nodeId, endpointId: "22222222-2222-4222-8222-222222222222" },
          target: { nodeId, endpointId: LOGICAL_TARGET_ID },
          mode: "notify" as const,
          expiresAt: 900_000, // EXPIRED while the daemon was down
          state: "pending" as const,
        },
        {
          requestMessageId: "msg_still_live",
          source: { nodeId, endpointId: "22222222-2222-4222-8222-222222222222" },
          target: { nodeId, endpointId: LOGICAL_TARGET_ID },
          mode: "notify" as const,
          expiresAt: 2_000_000, // still valid
          state: "pending" as const,
        },
      ],
      save: (grants) => {
        savedGrants.push(...grants.map((g) => ({ ...g })));
      },
    },
  });
  // Registry reverse-lookup seam (wired in production from main.ts).
  (registry as unknown as {
    findLocalSessionByEndpointId: (id: string) => Promise<{ alias: string; archived: boolean; isLogical: boolean } | null>;
  }).findLocalSessionByEndpointId = async (endpointId: string) =>
    endpointId === "22222222-2222-4222-8222-222222222222"
      ? { alias: "main", archived: false, isLogical: true }
      : null;

  // Restart hydration must NOT silently drop the expired pending row:
  // the first expirePendingCompletions pass terminalizes it.
  await (
    (
      router as unknown as {
        expirePendingCompletions: () => Promise<void>;
      }
    ).expirePendingCompletions()
  );

  const patches = emitted.filter(
    (e): e is Extract<ControlEvent, { type: "agent-message-completion" }> =>
      e.type === "agent-message-completion",
  );
  expect(patches).toHaveLength(1);
  expect(patches[0]!.messageId).toBe("msg_expired_downtime");
  expect(patches[0]!.completionStatus).toBe("cancelled");
  // The alias resolved via registry reverse lookup even without an outbound cache.
  expect(patches[0]!.sessionAlias).toBe("main");

  // The pruned set is persisted: only the live row survives on disk.
  expect(savedGrants.map((g) => g.requestMessageId)).toEqual(["msg_still_live"]);
});

test("#297: durable-mark failure after admission keeps an admitted-pending state — the retry re-marks ONLY and never re-admits through the delivery seam", async () => {
  const events = createControlEventBus();
  let idSeq = 0;
  let admissionCalls = 0;
  let failSave = false;
  const saves: Array<Array<{ requestMessageId: string; state: string }>> = [];

  const { router, state } = makeRouter({
    events,
    createId: () => `uuid-${++idSeq}`,
    pendingCompletionStore: {
      load: () => [],
      save: (grants) => {
        if (failSave) throw new Error("disk full");
        saves.push(grants.map((g) => ({ requestMessageId: g.requestMessageId, state: g.state })));
      },
    },
    delivery: {
      deliver: async () => ({ status: "queued" as const, modeUsed: "queue" as const }),
      deliverCompletion: async (_alias: string, completion: { result?: string }) => {
        admissionCalls++;
        expect(completion.result).toBe("answer");
        return { status: "injected" as const };
      },
    },
  });
  addLogicalPeers(state);

  const receipt = await router.send(LOGICAL_SENDER, {
    to: encodeAgentHandle({ nodeId, endpointId: LOGICAL_TARGET_ID }),
    content: "work",
    completion: "result",
  });
  expect(saves.length).toBeGreaterThanOrEqual(1); // reserve persisted fine

  const origin = {
    requestMessageId: receipt.messageId,
    completion: "result" as const,
    source: { nodeId, endpointId: "22222222-2222-4222-8222-222222222222" },
    target: { nodeId, endpointId: LOGICAL_TARGET_ID },
  };
  const completion = {
    requestMessageId: receipt.messageId,
    from: origin.target,
    status: "completed" as const,
    result: "answer",
    completedAt: Date.now(),
  };

  // Attempt 1: TurnQueue admission succeeds (call #1) but the durable mark
  // FAILS — the admitted turn must stay tracked as persist-pending.
  failSave = true;
  const first = await router.deliverInboundCompletion({
    requestMessageId: receipt.messageId,
    source: origin.source,
    target: origin.target,
    status: "completed",
    result: "answer",
    completedAt: Date.now(),
  });
  expect(first.ok).toBe(false); // retryable failure, Hub keeps its grant
  expect(admissionCalls).toBe(1);

  // Attempt 2 (the target's durable outbox retries): storage recovered.
  failSave = false;
  const second = await router.deliverInboundCompletion({
    requestMessageId: receipt.messageId,
    source: origin.source,
    target: origin.target,
    status: "completed",
    result: "answer",
    completedAt: Date.now(),
  });
  expect(second.ok).toBe(true);
  // The lane was NEVER touched again — only the durable mark was retried.
  expect(admissionCalls).toBe(1);
  expect(saves.at(-1)).toEqual([
    { requestMessageId: receipt.messageId, state: "delivered" },
  ]);

  // A third replay is absorbed by the delivered tombstone as before.
  const third = await router.deliverInboundCompletion({
    requestMessageId: receipt.messageId,
    source: origin.source,
    target: origin.target,
    status: "completed",
    result: "answer",
    completedAt: Date.now(),
  });
  expect(third.ok).toBe(true);
  expect(third.deduplicated).toBe(true);
  expect(admissionCalls).toBe(1);
});


test("Guards untouched: completion cycle does not consume conversation depth, volume, rate limit, or duplicate counters", async () => {
  let clock = 10_000;
  const { router, state } = makeRouter({
    now: () => clock,
  });
  addLogicalPeers(state);
  (router as unknown as { deps: { delivery: { deliverCompletion?: () => Promise<{ status: "injected" }> } } }).deps.delivery.deliverCompletion = async () => ({ status: "injected" as const });

  const to = encodeAgentHandle({ nodeId, endpointId: LOGICAL_TARGET_ID });

  // Send a message with completion = notify
  const receipt = await router.send(LOGICAL_SENDER, { to, content: "guard check message", completion: "notify" });

  // Complete the peer turn
  const origin = {
    requestMessageId: receipt.messageId,
    completion: "notify" as const,
    source: { nodeId, endpointId: "22222222-2222-4222-8222-222222222222" },
    target: { nodeId, endpointId: LOGICAL_TARGET_ID },
  };
  await router.completePeerTurn(origin, { ok: true, text: "done" });

  // Verify that conversation volume count is exactly 1 (from the single send, NOT incremented by completePeerTurn)
  expect((router as unknown as { conversationMessageCounts: Map<string, number> }).conversationMessageCounts.get(receipt.messageId)).toBe(1);

  // Verify that rate window contains only the original send
  const pairKey = `${nodeId}:22222222-2222-4222-8222-222222222222->${nodeId}:${LOGICAL_TARGET_ID}`;
  expect((router as unknown as { rateWindows: Map<string, number[]> }).rateWindows.get(pairKey)?.length).toBe(1);
});

test("remote route accepts completion = result from a logical sender when remote endpoint advertises completion capability", async () => {
  let routedPayload: { completion?: string } | null = null;
  const remoteRoute = new RelayAgentMessageRoute({
    sendAgentMessageRoute: async (payload) => {
      routedPayload = payload;
      return { messageId: payload.messageId, status: "queued" };
    },
  });
  const { router, registry, state } = makeRouter({ remoteRoute });
  addLogicalPeers(state);
  registry.updateRemoteEndpoints("node_remote", [
    {
      address: { nodeId: "node_remote", endpointId: "endpoint_remote_worker" },
      handle: encodeAgentHandle({ nodeId: "node_remote", endpointId: "endpoint_remote_worker" }),
      node: "Remote Node",
      displayName: "Remote Worker",
      agent: "claude",
      state: "idle",
      activity: { status: "idle" },
      capabilities: {
        receive: true,
        steer: false,
        queue: true,
        interrupt: false,
        conversation: true,
        completion: true,
      },
    },
  ]);
  const to = encodeAgentHandle({ nodeId: "node_remote", endpointId: "endpoint_remote_worker" });

  const receipt = await router.send(LOGICAL_SENDER, { to, content: "remote result test", completion: "result" });
  expect(receipt.status).toBe("queued");
  expect(receipt.route).toBe("relay");
  expect(routedPayload?.completion).toBe("result");
  // A grant is recorded on the source daemon so the returning completion is accepted.
  expect((router as unknown as { pendingCompletions: Map<string, unknown> }).pendingCompletions.has(receipt.messageId)).toBe(true);
});

test("completePeerTurn for remote source routes upward via remoteRoute.sendCompletion", async () => {
  let completionSent: {
    requestMessageId: string;
    source: { nodeId: string; endpointId: string };
    target: { nodeId: string; endpointId: string };
    status: string;
    result?: string;
  } | null = null;
  const remoteRoute = new RelayAgentMessageRoute({
    sendAgentMessageRoute: async () => ({ messageId: "1", status: "queued" }),
    sendAgentMessageCompletion: async (payload) => {
      completionSent = payload;
      return { ok: true };
    },
  });
  const { router } = makeRouter({ remoteRoute });

  const origin = {
    requestMessageId: "msg_remote_req_1",
    completion: "result" as const,
    source: { nodeId: "node_remote_source", endpointId: "worker_remote_source" },
    target: { nodeId, endpointId: "endpoint_worker-b" },
  };

  const completion = await router.completePeerTurn(origin, { ok: true, text: "computed answer" });
  expect(completion).not.toBeNull();
  expect(completion!.status).toBe("completed");
  expect(completion!.result).toBe("computed answer");

  expect(completionSent).toBeDefined();
  expect(completionSent!.requestMessageId).toBe("msg_remote_req_1");
  expect(completionSent!.source.nodeId).toBe("node_remote_source");
  expect(completionSent!.target.nodeId).toBe(nodeId);
  expect(completionSent!.status).toBe("completed");
  expect(completionSent!.result).toBe("computed answer");
});

test("deliverInboundCompletion performs source-side injection with idempotency and status patch — but ONLY with a valid grant", async () => {
  const events = createControlEventBus();
  const emitted: ControlEvent[] = [];
  events.subscribe((e) => emitted.push(e));

  let deliveredCount = 0;
  let deliveredCompletion: AgentMessageCompletion | null = null;
  const delivery: LocalAgentMessageDelivery = {
    deliver: async () => ({ status: "queued" as const, modeUsed: "queue" as const }),
    deliverCompletion: async (_alias, completion) => {
      deliveredCount += 1;
      deliveredCompletion = completion;
      return { status: "injected" as const };
    },
  };

  const remoteRoute = new RelayAgentMessageRoute({
    sendAgentMessageRoute: async (payload) => ({ messageId: payload.messageId, status: "queued" }),
  });
  let idSeq = 0;
  const { router, registry, state } = makeRouter({ events, delivery, remoteRoute, createId: () => `uuid-${++idSeq}` });
  addLogicalPeers(state);

  registry.updateRemoteEndpoints("node_remote", [
    {
      address: { nodeId: "node_remote", endpointId: "endpoint_remote_b" },
      handle: encodeAgentHandle({ nodeId: "node_remote", endpointId: "endpoint_remote_b" }),
      node: "Remote Node",
      displayName: "Remote Worker B",
      agent: "codex",
      state: "idle",
      activity: { status: "idle" },
      capabilities: {
        receive: true,
        steer: false,
        queue: true,
        interrupt: false,
        conversation: true,
        completion: true,
      },
    },
  ]);

  // 0. Trust boundary: a completion for an UNKNOWN request must be denied.
  await expect(
    router.deliverInboundCompletion({
      requestMessageId: "msg_forged_unknown",
      source: { nodeId, endpointId: "22222222-2222-4222-8222-222222222222" },
      target: { nodeId: "node_remote", endpointId: "endpoint_remote_b" },
      status: "completed",
      result: "forged result",
      completedAt: 1700000000000,
    }),
  ).rejects.toMatchObject({ code: "DELIVERY_DENIED" });
  expect(deliveredCount).toBe(0);

  // 1. Send outbound message from local logical session to remote endpoint
  const to = encodeAgentHandle({ nodeId: "node_remote", endpointId: "endpoint_remote_b" });
  const receipt = await router.send(LOGICAL_SENDER, { to, content: "Please compute X", completion: "result" });

  // 1b. A mismatched source/target on a REAL request id is also denied.
  await expect(
    router.deliverInboundCompletion({
      requestMessageId: receipt.messageId,
      source: { nodeId, endpointId: "endpoint_worker-a" },
      target: { nodeId: "node_remote", endpointId: "endpoint_remote_b" },
      status: "completed",
      result: "forged",
      completedAt: 1700000000000,
    }),
  ).rejects.toMatchObject({ code: "DELIVERY_DENIED" });

  // 2. Inbound completion arrives from remote node with exact identities
  const res = await router.deliverInboundCompletion({
    requestMessageId: receipt.messageId,
    source: { nodeId, endpointId: "22222222-2222-4222-8222-222222222222" },
    target: { nodeId: "node_remote", endpointId: "endpoint_remote_b" },
    status: "completed",
    result: "X = 42",
    completedAt: 1700000000000,
  });
  expect(res.ok).toBe(true);
  expect(deliveredCount).toBe(1);
  expect(deliveredCompletion!.result).toBe("X = 42");
  expect(deliveredCompletion!.to.endpointId).toBe("22222222-2222-4222-8222-222222222222");

  // Status patch event was emitted for the sender card.
  const patches = emitted.filter((e): e is Extract<ControlEvent, { type: "agent-message-completion" }> => e.type === "agent-message-completion");
  expect(patches).toHaveLength(1);
  expect(patches[0]!.messageId).toBe(receipt.messageId);
  expect(patches[0]!.completionStatus).toBe("completed");

  // 3. Duplicate inbound completion arrives (idempotency check)
  const dupRes = await router.deliverInboundCompletion({
    requestMessageId: receipt.messageId,
    source: { nodeId, endpointId: "22222222-2222-4222-8222-222222222222" },
    target: { nodeId: "node_remote", endpointId: "endpoint_remote_b" },
    status: "completed",
    result: "X = 42",
    completedAt: 1700000000000,
  });
  expect(dupRes.ok).toBe(true);
  expect(dupRes.deduplicated).toBe(true);
  expect(deliveredCount).toBe(1); // exactly one injection

  // 4. A notify grant must not be upgraded into a result-bearing completion.
  const notifyReceipt = await router.send(LOGICAL_SENDER, { to, content: "notify only", completion: "notify" });
  await expect(
    router.deliverInboundCompletion({
      requestMessageId: notifyReceipt.messageId,
      source: { nodeId, endpointId: "22222222-2222-4222-8222-222222222222" },
      target: { nodeId: "node_remote", endpointId: "endpoint_remote_b" },
      status: "completed",
      result: "smuggled result body",
      completedAt: 1700000000001,
    }),
  ).rejects.toMatchObject({ code: "DELIVERY_DENIED" });

  // 5. completion=none sends never create grants.
  const noneReceipt = await router.send(LOGICAL_SENDER, { to, content: "one way only" });
  await expect(
    router.deliverInboundCompletion({
      requestMessageId: noneReceipt.messageId,
      source: { nodeId, endpointId: "22222222-2222-4222-8222-222222222222" },
      target: { nodeId: "node_remote", endpointId: "endpoint_remote_b" },
      status: "completed",
      completedAt: 1700000000002,
    }),
  ).rejects.toMatchObject({ code: "DELIVERY_DENIED" });
});

test("deliverInboundCompletion does not wake archived source session", async () => {
  let deliveredCount = 0;
  const delivery: LocalAgentMessageDelivery = {
    deliver: async () => ({ status: "queued" as const }),
    deliverCompletion: async () => {
      deliveredCount += 1;
      return { status: "injected" as const };
    },
  };
  const { router } = makeRouter({
    delivery,
    registryOverrides: {
      findLocalSessionByEndpointId: async () => ({
        alias: "archived-session",
        archived: true,
        isLogical: true,
      }),
    },
  });

  // A valid grant must exist first — archived or not, forgeries are denied.
  (router as unknown as { pendingCompletions: Map<string, unknown> }).pendingCompletions.set("msg_archived_test", {
    source: { nodeId, endpointId: "endpoint_archived" },
    target: { nodeId: "node_remote", endpointId: "worker_remote" },
    mode: "result",
    expiresAt: Date.now() + 60_000,
  });

  const res = await router.deliverInboundCompletion({
    requestMessageId: "msg_archived_test",
    source: { nodeId, endpointId: "endpoint_archived" },
    target: { nodeId: "node_remote", endpointId: "worker_remote" },
    status: "completed",
    result: "Done",
    completedAt: Date.now(),
  });
  expect(res.ok).toBe(true);
  expect(deliveredCount).toBe(0); // No turn injected for archived session
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
