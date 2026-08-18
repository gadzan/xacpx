import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocket, WebSocketServer } from "ws";

import {
  RELAY_PROTOCOL_VERSION,
  type PublishedAgentEndpointDto,
} from "@ganglion/xacpx-relay-protocol";
import { createSqlDriver, initSchema } from "../../packages/relay/src/db";
import { AccountStore } from "../../packages/relay/src/stores/accounts";
import { InstanceStore } from "../../packages/relay/src/stores/instances";
import { InstanceGateway } from "../../packages/relay/src/gateway/instance-gateway";
import { RelayClient } from "../../packages/channel-relay/src/relay-client";
import { RelayChannel } from "../../packages/channel-relay/src/channel";
import { CredentialStore } from "../../packages/channel-relay/src/credential-store";
import { AgentEndpointRegistry } from "../../src/orchestration/agent-endpoint-registry";
import { createControlEventBus } from "../../src/control/control-event-bus";
import {
  AgentMessageRouter,
  type LocalAgentMessageDelivery,
} from "../../src/orchestration/agent-message-router";
import { RelayAgentMessageRoute } from "../../src/orchestration/relay-agent-message-route";
import { encodeAgentHandle } from "../../src/orchestration/agent-handle";
import { createEmptyState } from "../../src/state/types";
import type { AgentEndpointView } from "../../src/orchestration/agent-messaging-types";
import type { SessionMessageReceipt } from "../../src/transport/types";

interface TestDaemonNode {
  nodeId: string;
  home: string;
  ws: string;
  channel: RelayChannel;
  registry: AgentEndpointRegistry;
  router: AgentMessageRouter;
  stateRef: {
    state: ReturnType<typeof createEmptyState>;
  };
  controlEvents: ReturnType<typeof createControlEventBus>;
  injectedPrompts: Array<{ session: string; text: string }>;
  deliveriesCount: number;
  dispose: () => Promise<void>;
}

async function setupHub() {
  const db = await createSqlDriver(":memory:");
  initSchema(db);
  const accounts = new AccountStore(db);
  const instances = new InstanceStore(db);
  const account = accounts.createAccount("alice");

  const gateway = new InstanceGateway({
    instances,
    accounts,
    requestTimeoutMs: 5000,
  });

  const wss = new WebSocketServer({ port: 0 });
  await new Promise<void>((resolve) => wss.on("listening", () => resolve()));
  wss.on("connection", (socket) => gateway.handleConnection(socket));

  const port = (wss.address() as { port: number }).port;
  const hubUrl = `ws://127.0.0.1:${port}`;

  return {
    gateway,
    instances,
    account,
    wss,
    hubUrl,
    close: async () => {
      wss.close();
    },
  };
}

async function setupDaemonNode(
  nodeId: string,
  hubUrl: string,
  pairingToken: string,
  limits?: ConstructorParameters<typeof AgentMessageRouter>[0]["limits"],
): Promise<TestDaemonNode> {
  const home = await mkdtemp(join(tmpdir(), `xacpx-collab-home-${nodeId}-`));
  const ws = await mkdtemp(join(tmpdir(), `xacpx-collab-ws-${nodeId}-`));
  const injectedPrompts: Array<{ session: string; text: string }> = [];
  const nodeState = { deliveriesCount: 0 };

  const stateRef = { state: createEmptyState() };
  stateRef.state.sessions.main = {
    alias: "main",
    display_name: "Coordinator Main",
    agent: "codex",
    workspace: "project",
    transport_session: "coordinator",
    logical_session_id: `logical_${nodeId}`,
    created_at: "2026-08-18T00:00:00.000Z",
    last_used_at: "2026-08-18T00:00:00.000Z",
  };
  stateRef.state.orchestration.workerBindings.worker1 = {
    sourceHandle: "worker1",
    agentEndpointId: `worker_ep_${nodeId}`,
    coordinatorSession: "coordinator",
    workspace: "backend",
    role: "schema-author",
    targetAgent: "codex",
  };

  const registry = new AgentEndpointRegistry({
    nodeId,
    loadState: async () => structuredClone(stateRef.state),
  });

  const localDelivery: LocalAgentMessageDelivery = {
    deliver: async (
      target,
      message,
      renderedText,
    ): Promise<SessionMessageReceipt> => {
      nodeState.deliveriesCount += 1;
      injectedPrompts.push({
        session: target.endpoint.address.endpointId,
        text: renderedText,
      });
      return {
        status: "queued",
        modeUsed: "queue",
        targetState: "idle",
      };
    },
  };

  let channel!: RelayChannel;

  const relayRoute = new RelayAgentMessageRoute({
    sendAgentMessageRoute: async (payload) => {
      return await channel.sendAgentMessageRoute(payload);
    },
  });

  const router = new AgentMessageRouter({
    registry,
    delivery: localDelivery,
    remoteRoute: relayRoute,
    limits,
  });

  const controlEvents = createControlEventBus();
  const fakeControl = {
    deliverAgentMessage: async (
      input: Parameters<typeof router.deliverInbound>[0],
    ) => {
      return await router.deliverInbound(input);
    },
    getPublishedAgentEndpoints: async () => {
      return await registry.getPublishedEndpoints();
    },
    updateRemoteAgentEndpoints: (
      remoteNodeId: string,
      endpoints: AgentEndpointView[],
    ) => {
      registry.updateRemoteEndpoints(remoteNodeId, endpoints);
    },
    syncRemoteAgentDirectory: (endpoints: PublishedAgentEndpointDto[]) => {
      registry.syncRemoteDirectorySnapshot(endpoints);
    },
    listSessions: () => [],
    events: controlEvents,
  };
  const abortController = new AbortController();
  channel = new RelayChannel(
    {
      url: hubUrl,
      pairingToken,
      name: `daemon-${nodeId}`,
      terminal: { enabled: false } as never,
    },
    {
      credentialStore: new CredentialStore(join(home, "credential.json")),
      terminalRegistryDir: home,
      endpointSyncDebounceMs: 20,
    },
  );

  void channel.start({
    abortSignal: abortController.signal,
    control: fakeControl as never,
  });
  return {
    nodeId,
    home,
    ws,
    channel,
    registry,
    router,
    stateRef,
    controlEvents,
    injectedPrompts,
    get deliveriesCount() {
      return nodeState.deliveriesCount;
    },
    dispose: async () => {
      abortController.abort();
      await channel.stop();
      await rm(home, { recursive: true, force: true });
      await rm(ws, { recursive: true, force: true });
    },
  };
}
async function waitUntil(
  predicate: () => boolean | Promise<boolean>,
  timeoutMs = 4000,
): Promise<void> {
  const start = Date.now();
  while (!(await predicate())) {
    if (Date.now() - start > timeoutMs) {
      throw new Error(`waitUntil timed out after ${timeoutMs}ms`);
    }
    await Bun.sleep(20);
  }
}

// --------------------------------------------------------------------------
// Scenario A: High-Value Notification (Zero-ACK Verification)
// --------------------------------------------------------------------------
test("Scenario A: Worker A sends high-value notification to Worker B, B consumes without ACK", async () => {
  const hub = await setupHub();
  const tokenA = hub.instances.issuePairingToken(
    hub.account.id,
    "nodeA",
    600_000,
  ).token;
  const tokenB = hub.instances.issuePairingToken(
    hub.account.id,
    "nodeB",
    600_000,
  ).token;
  const nodeA = await setupDaemonNode("node_A", hub.hubUrl, tokenA);
  const nodeB = await setupDaemonNode("node_B", hub.hubUrl, tokenB);

  try {
    // Worker A is working on schema refactoring
    nodeA.stateRef.state.orchestration.tasks.taskA = {
      taskId: "task_A",
      sourceHandle: "worker1",
      sourceKind: "coordinator",
      coordinatorSession: "coordinator",
      workerSession: "worker1",
      workspace: "backend",
      targetAgent: "codex",
      role: "schema-author",
      task: "Refactor User schema",
      summary: "User schema migration to v2",
      status: "running",
      resultText: "",
      createdAt: "2026-08-18T00:00:00Z",
      updatedAt: "2026-08-18T00:00:00Z",
    };
    nodeA.channel.syncAgentEndpointsNow();
    // Worker B is working on API consumer
    nodeB.stateRef.state.orchestration.workerBindings.worker1.role =
      "api-client";
    nodeB.stateRef.state.orchestration.workerBindings.worker1.workspace =
      "frontend";
    nodeB.stateRef.state.orchestration.tasks.taskB = {
      taskId: "task_B",
      sourceHandle: "worker1",
      sourceKind: "coordinator",
      coordinatorSession: "coordinator",
      workerSession: "worker1",
      workspace: "frontend",
      targetAgent: "codex",
      role: "api-client",
      task: "Implement frontend user client",
      summary: "Consuming User API",
      status: "running",
      resultText: "",
      createdAt: "2026-08-18T00:00:00Z",
      updatedAt: "2026-08-18T00:00:00Z",
    };
    nodeB.channel.syncAgentEndpointsNow();

    let endpointsA!: AgentEndpointView[];
    await waitUntil(async () => {
      endpointsA = await nodeA.router.listReachable({
        coordinatorSession: "coordinator",
        sourceHandle: "worker1",
      });
      const bEp = endpointsA.find(
        (e) =>
          e.address.nodeId === "node_B" &&
          e.address.endpointId === "worker_ep_node_B",
      );
      return Boolean(bEp && bEp.activity?.status === "working");
    });

    const targetB = endpointsA.find(
      (e) =>
        e.address.nodeId === "node_B" &&
        e.address.endpointId === "worker_ep_node_B",
    )!;
    expect(targetB.workspace).toBe("frontend");
    expect(targetB.activity.status).toBe("working");
    expect(targetB.activity.summary).toBe("Consuming User API");
    expect(targetB.capabilities.conversation).toBe(true);

    // Worker A sends high-value notification to Worker B
    const receipt = await nodeA.router.send(
      { coordinatorSession: "coordinator", sourceHandle: "worker1" },
      {
        to: targetB.handle,
        content: "User.token renamed to bearer_token",
      },
    );

    expect(receipt.status).toBe("queued");
    expect(receipt.route).toBe("relay");

    // Worker B receives the formatted envelope
    await waitUntil(() => nodeB.injectedPrompts.length === 1);
    expect(nodeB.deliveriesCount).toBe(1);
    const injected = nodeB.injectedPrompts[0]!;
    expect(injected.text).toContain(`id="${receipt.messageId}"`);
    expect(injected.text).toContain(`conversation-id="${receipt.messageId}"`);
    expect(injected.text).toContain('replyable="true"');
    expect(injected.text).toContain("User.token renamed to bearer_token");

    // Trace records on both nodes
    const tracesA = nodeA.router.getTraceRecords();
    expect(tracesA.length).toBeGreaterThanOrEqual(1);
    const traceA = tracesA.find((t) => t.messageId === receipt.messageId)!;
    expect(traceA.conversationId).toBe(receipt.messageId);
    expect(traceA.depth).toBe(0);
    expect(traceA.contentHash).toHaveLength(64);
  } finally {
    await nodeA.dispose();
    await nodeB.dispose();
    await hub.close();
  }
});

// --------------------------------------------------------------------------
// Scenario B: Meaningful Reply Thread with Shared Conversation ID
// --------------------------------------------------------------------------
test("Scenario B: Multi-step reply thread shares conversationId and increments depth", async () => {
  const hub = await setupHub();
  const tokenA = hub.instances.issuePairingToken(
    hub.account.id,
    "nodeA",
    600_000,
  ).token;
  const tokenB = hub.instances.issuePairingToken(
    hub.account.id,
    "nodeB",
    600_000,
  ).token;
  const nodeA = await setupDaemonNode("node_A", hub.hubUrl, tokenA);
  const nodeB = await setupDaemonNode("node_B", hub.hubUrl, tokenB);

  try {
    nodeA.channel.syncAgentEndpointsNow();
    nodeB.channel.syncAgentEndpointsNow();

    let endpointsA!: AgentEndpointView[];
    await waitUntil(async () => {
      endpointsA = await nodeA.router.listReachable({
        coordinatorSession: "coordinator",
        sourceHandle: "worker1",
      });
      return endpointsA.some((e) => e.address.nodeId === "node_B");
    });

    const targetB = endpointsA.find((e) => e.address.nodeId === "node_B")!;
    const bindingA = {
      coordinatorSession: "coordinator",
      sourceHandle: "worker1",
    };
    const bindingB = {
      coordinatorSession: "coordinator",
      sourceHandle: "worker1",
    };

    // Step 1: A sends root notification msg_1
    const r1 = await nodeA.router.send(bindingA, {
      to: targetB.handle,
      content: "Breaking change: v2 schema deployed",
    });

    await waitUntil(() => nodeB.injectedPrompts.length === 1);

    // Step 2: B sends genuine blocking question reply msg_2 (replyTo = msg_1)
    let endpointsB = await nodeB.router.listReachable(bindingB);
    const targetA = endpointsB.find((e) => e.address.nodeId === "node_A")!;

    const r2 = await nodeB.router.send(bindingB, {
      to: targetA.handle,
      content: "Do we still keep legacy_id for backward compatibility?",
      replyTo: r1.messageId,
    });

    expect(r2.status).toBe("queued");
    await waitUntil(() => nodeA.injectedPrompts.length === 1);

    // Step 3: A replies msg_3 (replyTo = msg_2)
    const r3 = await nodeA.router.send(bindingA, {
      to: targetB.handle,
      content: "No, legacy_id is deprecated. Use uuid.",
      replyTo: r2.messageId,
    });

    await waitUntil(() => nodeB.injectedPrompts.length === 2);

    // All 3 messages share the root conversationId
    const tracesA = nodeA.router.getTraceRecords();
    const tracesB = nodeB.router.getTraceRecords();

    const t1 = tracesA.find((t) => t.messageId === r1.messageId)!;
    const t2 = tracesB.find((t) => t.messageId === r2.messageId)!;
    const t3 = tracesA.find((t) => t.messageId === r3.messageId)!;

    expect(t1.conversationId).toBe(r1.messageId);
    expect(t1.depth).toBe(0);

    expect(t2.conversationId).toBe(r1.messageId);
    expect(t2.depth).toBe(1);

    expect(t3.conversationId).toBe(r1.messageId);
    expect(t3.depth).toBe(2);

    // Verified: no raw message text in trace
    expect(JSON.stringify(tracesA)).not.toContain("Breaking change");
    expect(JSON.stringify(tracesB)).not.toContain("legacy_id");
  } finally {
    await nodeA.dispose();
    await nodeB.dispose();
    await hub.close();
  }
});

// --------------------------------------------------------------------------
// Scenario C: Missing / Expired Reply Context Fail-Closed
// --------------------------------------------------------------------------
test("Scenario C: Replying with missing/expired replyTo fails closed with REPLY_CONTEXT_UNAVAILABLE", async () => {
  const hub = await setupHub();
  const tokenA = hub.instances.issuePairingToken(
    hub.account.id,
    "nodeA",
    600_000,
  ).token;
  const nodeA = await setupDaemonNode("node_A", hub.hubUrl, tokenA);

  try {
    const endpoints = await nodeA.router.listReachable({
      coordinatorSession: "coordinator",
      sourceHandle: "worker1",
    });
    const targetCoord = endpoints.find((e) =>
      e.displayName?.includes("Coordinator"),
    )!;

    // Reply to non-existent ID fails closed without guessing
    await expect(
      nodeA.router.send(
        { coordinatorSession: "coordinator", sourceHandle: "worker1" },
        {
          to: targetCoord.handle,
          content: "attempting reply to phantom message",
          replyTo: "msg_phantom_999",
        },
      ),
    ).rejects.toMatchObject({
      code: "REPLY_CONTEXT_UNAVAILABLE",
    });
  } finally {
    await nodeA.dispose();
    await hub.close();
  }
});

// --------------------------------------------------------------------------
// Scenario D: Conversation Depth & Volume Limit Enforcement
// --------------------------------------------------------------------------
test("Scenario D: Hard limit on conversation depth and volume stops runaway loops", async () => {
  const hub = await setupHub();
  const tokenA = hub.instances.issuePairingToken(
    hub.account.id,
    "nodeA",
    600_000,
  ).token;
  const nodeA = await setupDaemonNode("node_A", hub.hubUrl, tokenA, {
    maxConversationDepth: 3,
    maxMessagesPerConversation: 4,
    duplicateContentWindowMs: 0,
  });

  try {
    const endpoints = await nodeA.router.listReachable({
      coordinatorSession: "coordinator",
      sourceHandle: "worker1",
    });
    const target = endpoints[0]!;
    const binding = {
      coordinatorSession: "coordinator",
      sourceHandle: "worker1",
    };

    // depth 0
    const m1 = await nodeA.router.send(binding, {
      to: target.handle,
      content: "step 1",
    });
    // depth 1
    const m2 = await nodeA.router.send(binding, {
      to: target.handle,
      content: "step 2",
      replyTo: m1.messageId,
    });
    // depth 2
    const m3 = await nodeA.router.send(binding, {
      to: target.handle,
      content: "step 3",
      replyTo: m2.messageId,
    });
    // depth 3
    const m4 = await nodeA.router.send(binding, {
      to: target.handle,
      content: "step 4",
      replyTo: m3.messageId,
    });

    // depth 4 -> Exceeds maxConversationDepth (3)
    await expect(
      nodeA.router.send(binding, {
        to: target.handle,
        content: "step 5",
        replyTo: m4.messageId,
      }),
    ).rejects.toMatchObject({
      code: "CONVERSATION_LIMIT_REACHED",
    });
  } finally {
    await nodeA.dispose();
    await hub.close();
  }
});

// --------------------------------------------------------------------------
// Scenario E: Duplicate Content Window Guard across Relay
// --------------------------------------------------------------------------
test("Scenario E: Duplicate content guard suppresses rapid duplicate spam to peer", async () => {
  const hub = await setupHub();
  const tokenA = hub.instances.issuePairingToken(
    hub.account.id,
    "nodeA",
    600_000,
  ).token;
  const tokenB = hub.instances.issuePairingToken(
    hub.account.id,
    "nodeB",
    600_000,
  ).token;
  const nodeA = await setupDaemonNode("node_A", hub.hubUrl, tokenA, {
    duplicateContentWindowMs: 30_000,
  });
  const nodeB = await setupDaemonNode("node_B", hub.hubUrl, tokenB);

  try {
    nodeA.channel.syncAgentEndpointsNow();
    nodeB.channel.syncAgentEndpointsNow();

    let endpointsA!: AgentEndpointView[];
    await waitUntil(async () => {
      endpointsA = await nodeA.router.listReachable({
        coordinatorSession: "coordinator",
        sourceHandle: "worker1",
      });
      return endpointsA.some((e) => e.address.nodeId === "node_B");
    });

    const targetB = endpointsA.find((e) => e.address.nodeId === "node_B")!;
    const bindingA = {
      coordinatorSession: "coordinator",
      sourceHandle: "worker1",
    };

    // First send succeeds
    await nodeA.router.send(bindingA, {
      to: targetB.handle,
      content: "Automated status update",
    });

    // Immediate second send with same content is rejected
    await expect(
      nodeA.router.send(bindingA, {
        to: targetB.handle,
        content: "Automated status update",
      }),
    ).rejects.toMatchObject({
      code: "DUPLICATE_MESSAGE",
    });
  } finally {
    await nodeA.dispose();
    await nodeB.dispose();
    await hub.close();
  }
});
