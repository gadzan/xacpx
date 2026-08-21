import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocket, WebSocketServer } from "ws";

import {
  MSG,
  RELAY_PROTOCOL_VERSION,
  decodeEnvelope,
  encodeEnvelope,
  type AgentDirectorySnapshotPayload,
  type AgentMessageDeliverPayload,
  type AgentMessageRoutePayload,
  type InstanceAgentEndpointsSyncPayload,
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
import type {
  ResolvedSession,
  SessionMessageInput,
  SessionMessageReceipt,
} from "../../src/transport/types";

interface DaemonNode {
  nodeId: string;
  home: string;
  ws: string;
  channel: RelayChannel;
  registry: AgentEndpointRegistry;
  router: AgentMessageRouter;
  stateRef: {
    state: ReturnType<typeof createEmptyState>;
  };
  /** Control event bus the channel subscribes to (real ControlService events in
   *  production; the fake control exposes one here so tests can fire the same
   *  sessions-changed / orchestration-changed signals). */
  controlEvents: ReturnType<typeof createControlEventBus>;
  injectedPrompts: Array<{ session: string; text: string }>;
  completionTurns: Array<{ alias: string; prompt: string; requestMessageId: string }>;
  dispose: () => Promise<void>;
}

async function setupHub(options?: {
  dropRequestResponse?: (
    instanceId: string,
    type: string,
    payload: unknown,
  ) => boolean;
}) {
  const db = await createSqlDriver(":memory:");
  initSchema(db);
  const accounts = new AccountStore(db);
  const instances = new InstanceStore(db);
  const account = accounts.createAccount("alice");

  const gateway = new InstanceGateway({
    instances,
    accounts,
    requestTimeoutMs: 2000,
    ...(options?.dropRequestResponse
      ? { dropRequestResponse: options.dropRequestResponse }
      : {}),
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
): Promise<DaemonNode> {
  const home = await mkdtemp(join(tmpdir(), `xacpx-fed-home-${nodeId}-`));
  const ws = await mkdtemp(join(tmpdir(), `xacpx-fed-ws-${nodeId}-`));
  const injectedPrompts: Array<{ session: string; text: string }> = [];
  const completionTurns: Array<{ alias: string; prompt: string; requestMessageId: string }> = [];
  const stateRef = { state: createEmptyState() };
  stateRef.state.sessions.main = {
    alias: "main",
    agent: "codex",
    workspace: "project",
    transport_session: "coordinator",
    logical_session_id: `logical_${nodeId}`,
    created_at: "2026-08-18T00:00:00.000Z",
    last_used_at: "2026-08-18T00:00:00.000Z",
  };
  stateRef.state.orchestration.workerBindings.worker1 = {
    sourceHandle: "worker1",
    agentEndpointId: `worker_endpoint_${nodeId}`,
    coordinatorSession: "coordinator",
    workspace: "project",
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
    deliverCompletion: async (alias, prompt, requestMessageId) => {
      completionTurns.push({ alias, prompt, requestMessageId });
      return { status: "injected" };
    },
  };

  let channel!: RelayChannel;

  const relayRoute = new RelayAgentMessageRoute({
    sendAgentMessageRoute: async (payload) => {
      return await channel.sendAgentMessageRoute(payload);
    },
    sendAgentMessageCompletion: async (payload) => {
      return await channel.sendAgentMessageCompletion(payload);
    },
  });

  const router = new AgentMessageRouter({
    registry,
    delivery: localDelivery,
    remoteRoute: relayRoute,
  });

  const controlEvents = createControlEventBus();
  const fakeControl = {
    deliverAgentMessage: async (
      input: Parameters<typeof router.deliverInbound>[0],
    ) => {
      return await router.deliverInbound(input);
    },
    deliverPeerCompletion: async (
      input: Parameters<typeof router.deliverInboundCompletion>[0],
    ) => {
      return await router.deliverInboundCompletion(input);
    },
    getPublishedAgentEndpoints: async () => {
      return await registry.getPublishedEndpoints();
    },
    updateRemoteAgentEndpoints: (
      remoteNodeId: string,
      endpoints: unknown[],
    ) => {
      registry.updateRemoteEndpoints(remoteNodeId, endpoints as never);
    },
    syncRemoteAgentDirectory: (endpoints: unknown[]) => {
      registry.syncRemoteDirectorySnapshot(endpoints as never);
    },
    listSessions: () => [{ alias: "main" }],
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

  const channelStartPromise = channel.start({
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
    completionTurns,
    dispose: async () => {
      abortController.abort();
      await channelStartPromise.catch(() => {});
      await rm(home, { recursive: true, force: true });
      await rm(ws, { recursive: true, force: true });
    },
  };
}

test("Agent Messaging Federation: Daemon A <-> Relay Hub <-> Daemon B full end-to-end flow", async () => {
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

  const daemonA = await setupDaemonNode("node_A", hub.hubUrl, tokenA);
  const daemonB = await setupDaemonNode("node_B", hub.hubUrl, tokenB);

  try {
    // Wait for both daemons to authenticate, sync endpoints, and receive directory broadcasts
    const deadline = Date.now() + 5000;
    let reachableA: AgentEndpointView[] = [];
    while (Date.now() < deadline) {
      reachableA = await daemonA.router.listReachable({
        coordinatorSession: "coordinator",
        sourceHandle: "worker1",
      });
      if (reachableA.some((e) => e.address.nodeId === "node_B")) {
        break;
      }
      await Bun.sleep(50);
    }

    // 1. Verify A's agent_list sees B's endpoints
    expect(
      reachableA.some(
        (e) =>
          e.address.nodeId === "node_B" &&
          e.address.endpointId === "worker_endpoint_node_B",
      ),
    ).toBe(true);
    const targetHandleB = encodeAgentHandle({
      nodeId: "node_B",
      endpointId: "worker_endpoint_node_B",
    });

    // 2. A agent_send -> B delivers into B's local injection
    const receiptFromA = await daemonA.router.send(
      { coordinatorSession: "coordinator", sourceHandle: "worker1" },
      {
        to: targetHandleB,
        content: "Hello Node B from Node A via Relay Hub Federation",
        mode: "auto",
      },
    );

    expect(receiptFromA.status).toBe("queued");
    expect(receiptFromA.route).toBe("relay");
    expect(receiptFromA.modeUsed).toBe("queue");

    expect(daemonB.injectedPrompts).toHaveLength(1);
    expect(daemonB.injectedPrompts[0]!.session).toBe("worker_endpoint_node_B");
    expect(daemonB.injectedPrompts[0]!.text).toContain(
      "Hello Node B from Node A via Relay Hub Federation",
    );
    expect(daemonB.injectedPrompts[0]!.text).toContain(
      'from="agent:node_A:worker_endpoint_node_A"',
    );
    expect(daemonB.injectedPrompts[0]!.text).toContain('replyable="true"');
    expect(daemonB.injectedPrompts[0]!.text).toContain(
      `conversation-id="${receiptFromA.messageId}"`,
    );
    // 3. Bidirectional: B replies to A using the canonical from handle
    const targetHandleA = encodeAgentHandle({
      nodeId: "node_A",
      endpointId: "worker_endpoint_node_A",
    });

    const receiptFromB = await daemonB.router.send(
      { coordinatorSession: "coordinator", sourceHandle: "worker1" },
      {
        to: targetHandleA,
        content: "Ack from Node B back to Node A",
        mode: "auto",
        replyTo: receiptFromA.messageId,
      },
    );

    expect(receiptFromB.status).toBe("queued");
    expect(receiptFromB.route).toBe("relay");

    expect(daemonA.injectedPrompts).toHaveLength(1);
    expect(daemonA.injectedPrompts[0]!.text).toContain(
      "Ack from Node B back to Node A",
    );
    expect(daemonA.injectedPrompts[0]!.text).toContain(
      'from="agent:node_B:worker_endpoint_node_B"',
    );

    // 4. Network retry idempotency: target-side deduplication
    // When A re-sends with the exact same messageId, target daemon B deduplicates without second injection
    const duplicateDelivery = await daemonB.router.deliverInbound({
      sourceNodeId: "node_A",
      sourceEndpointId: "worker_endpoint_node_A",
      targetEndpointId: "worker_endpoint_node_B",
      messageId: receiptFromA.messageId,
      conversationId: receiptFromA.messageId,
      depth: 0,
      content: "Hello Node B from Node A via Relay Hub Federation",
      requestedMode: "auto",
      replyable: true,
    });
    expect(duplicateDelivery.status).toBe("queued");
    expect(duplicateDelivery.deduplicated).toBe(true);
    // B's mock agent injection count must remain 1 (exactly-once injection effect)
    expect(daemonB.injectedPrompts).toHaveLength(1);

    // 5. Target offline handling: B disconnects → hub drops B's endpoints and
    // broadcasts the shrunken snapshot → A's remote agent_list auto-updates.
    await daemonB.dispose();
    const offlineDeadline = Date.now() + 5000;
    let bGoneFromList = false;
    while (Date.now() < offlineDeadline) {
      const list = await daemonA.router.listReachable({
        coordinatorSession: "coordinator",
        sourceHandle: "worker1",
      });
      if (!list.some((e) => e.address.nodeId === "node_B")) {
        bGoneFromList = true;
        break;
      }
      await Bun.sleep(50);
    }
    expect(bGoneFromList).toBe(true);

    await expect(
      daemonA.router.send(
        { coordinatorSession: "coordinator", sourceHandle: "worker1" },
        {
          to: targetHandleB,
          content: "Message to offline B",
          mode: "auto",
        },
      ),
    ).rejects.toMatchObject({
      code: "ROUTE_UNAVAILABLE",
    });
  } finally {
    await daemonA.dispose();
    await hub.close();
  }
});
test("Agent Messaging Federation: empty presence sync clears stale endpoints", async () => {
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

  const daemonA = await setupDaemonNode("node_A", hub.hubUrl, tokenA);
  const daemonB = await setupDaemonNode("node_B", hub.hubUrl, tokenB);

  try {
    // Wait for A to see B
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      const list = await daemonA.router.listReachable({
        coordinatorSession: "coordinator",
        sourceHandle: "worker1",
      });
      if (list.some((e) => e.address.nodeId === "node_B")) break;
      await Bun.sleep(50);
    }
    // Now daemon B sends empty presence sync
    daemonB.channel.syncAgentEndpoints([]);
    const clearDeadline = Date.now() + 5000;
    let cleared = false;
    while (Date.now() < clearDeadline) {
      const list = await daemonA.router.listReachable({
        coordinatorSession: "coordinator",
        sourceHandle: "worker1",
      });
      if (!list.some((e) => e.address.nodeId === "node_B")) {
        cleared = true;
        break;
      }
      await Bun.sleep(50);
    }

    expect(cleared).toBe(true);
  } finally {
    await daemonA.dispose();
    await daemonB.dispose();
    await hub.close();
  }
});

test("Agent Messaging Federation: endpoint create/delete auto-updates remote agent_list via debounced full sync", async () => {
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

  const daemonA = await setupDaemonNode("node_A", hub.hubUrl, tokenA);
  const daemonB = await setupDaemonNode("node_B", hub.hubUrl, tokenB);

  try {
    // A sees B's initial worker endpoint
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      const list = await daemonA.router.listReachable({
        coordinatorSession: "coordinator",
        sourceHandle: "worker1",
      });
      if (list.some((e) => e.address.endpointId === "worker_endpoint_node_B")) {
        break;
      }
      await Bun.sleep(50);
    }

    // CREATE: B gains a second worker endpoint, then fires the production
    // event worker-binding mutations emit (orchestration-changed). The channel
    // debounces, reads the FULL directory from control, and pushes it to the
    // hub, which rebroadcasts to A.
    daemonB.stateRef.state.orchestration.workerBindings.worker2 = {
      sourceHandle: "worker2",
      agentEndpointId: "worker_endpoint_2_node_B",
      coordinatorSession: "coordinator",
      workspace: "project",
      targetAgent: "codex",
    };
    daemonB.controlEvents.emit({ type: "orchestration-changed" });

    const createDeadline = Date.now() + 5000;
    let createdSeen = false;
    while (Date.now() < createDeadline) {
      const list = await daemonA.router.listReachable({
        coordinatorSession: "coordinator",
        sourceHandle: "worker1",
      });
      if (
        list.some((e) => e.address.endpointId === "worker_endpoint_2_node_B")
      ) {
        createdSeen = true;
        break;
      }
      await Bun.sleep(50);
    }
    expect(createdSeen).toBe(true);

    // DELETE: B removes the endpoint and fires orchestration-changed again; the
    // next debounced FULL sync prunes it from the hub directory and A's list.
    delete daemonB.stateRef.state.orchestration.workerBindings.worker2;
    daemonB.controlEvents.emit({ type: "orchestration-changed" });

    const deleteDeadline = Date.now() + 5000;
    let deletedSeen = false;
    while (Date.now() < deleteDeadline) {
      const list = await daemonA.router.listReachable({
        coordinatorSession: "coordinator",
        sourceHandle: "worker1",
      });
      if (
        !list.some((e) => e.address.endpointId === "worker_endpoint_2_node_B")
      ) {
        deletedSeen = true;
        break;
      }
      await Bun.sleep(50);
    }
    expect(deletedSeen).toBe(true);
  } finally {
    await daemonA.dispose();
    await daemonB.dispose();
    await hub.close();
  }
});

test(
  "Agent Messaging Federation: ACK-loss retry reuses messageId and injects exactly once",
  // The first attempt's ACK is intentionally dropped at the hub, so it waits out
  // the hub's requestTimeoutMs (2s) before the retry — the default 5s bun test
  // timeout is too tight for this real-network scenario.
  async () => {
    // Drop the FIRST agentMessageDeliver response (the ACK from B) at the hub.
    // A's route then sees an ambiguous DELIVERY_FAILED and retries with the SAME
    // messageId; B's destination-side dedupe returns the cached receipt.
    let dropped = false;
    const hub = await setupHub({
      dropRequestResponse: (instanceId, type) => {
        if (!dropped && type === MSG.agentMessageDeliver) {
          dropped = true;
          return true;
        }
        return false;
      },
    });

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

    const daemonA = await setupDaemonNode("node_A", hub.hubUrl, tokenA);
    const daemonB = await setupDaemonNode("node_B", hub.hubUrl, tokenB);

    try {
      // A sees B
      const deadline = Date.now() + 5000;
      while (Date.now() < deadline) {
        const list = await daemonA.router.listReachable({
          coordinatorSession: "coordinator",
          sourceHandle: "worker1",
        });
        if (list.some((e) => e.address.nodeId === "node_B")) break;
        await Bun.sleep(50);
      }
      const targetHandleB = encodeAgentHandle({
        nodeId: "node_B",
        endpointId: "worker_endpoint_node_B",
      });

      // The ACK for this message is swallowed once at the hub; the source route
      // retries internally with the same messageId.
      const receipt = await daemonA.router.send(
        { coordinatorSession: "coordinator", sourceHandle: "worker1" },
        {
          to: targetHandleB,
          content: "ack-loss message",
          mode: "auto",
        },
      );

      expect(dropped).toBe(true);
      expect(receipt.status).toBe("queued");
      expect(receipt.route).toBe("relay");
      // Destination dedupe surfaced on the retried delivery.
      expect(receipt.deduplicated).toBe(true);
      // Exactly-once injection: B's local agent saw the message exactly once.
      expect(daemonB.injectedPrompts).toHaveLength(1);
      expect(daemonB.injectedPrompts[0]!.text).toContain("ack-loss message");
    } finally {
      await daemonA.dispose();
      await daemonB.dispose();
      await hub.close();
    }
  },
  { timeout: 30_000 },
);
