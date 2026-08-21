import { expect, test } from "bun:test";
import { WebSocket, WebSocketServer } from "ws";

import {
  MSG,
  RELAY_PROTOCOL_VERSION,
  decodeEnvelope,
  encodeEnvelope,
  type AgentMessageCompletionPayload,
  type AgentMessageDeliverPayload,
  type AgentMessageRoutePayload,
  type InstanceAgentEndpointsSyncPayload,
  type RelayEnvelope,
} from "../../../../../packages/relay-protocol/src/index";
import {
  createSqlDriver,
  initSchema,
} from "../../../../../packages/relay/src/db";
import { AccountStore } from "../../../../../packages/relay/src/stores/accounts";
import { InstanceStore } from "../../../../../packages/relay/src/stores/instances";
import { InstanceGateway } from "../../../../../packages/relay/src/gateway/instance-gateway";

async function makeGateway(requestTimeoutMs = 1000) {
  const db = await createSqlDriver(":memory:");
  initSchema(db);
  const accounts = new AccountStore(db);
  const instances = new InstanceStore(db);
  const account = accounts.createAccount("alice");
  const accountBob = accounts.createAccount("bob");
  const events: unknown[] = [];
  const gateway = new InstanceGateway({
    instances,
    accounts,
    requestTimeoutMs,
    onEvent: (instanceId, accountId, envelope) =>
      events.push({ instanceId, accountId, type: envelope.type }),
  });
  const wss = new WebSocketServer({ port: 0 });
  await new Promise<void>((resolve) => wss.on("listening", () => resolve()));
  wss.on("connection", (socket) => gateway.handleConnection(socket));
  const port = (wss.address() as { port: number }).port;
  return {
    gateway,
    instances,
    accounts,
    account,
    accountBob,
    events,
    wss,
    url: `ws://127.0.0.1:${port}`,
  };
}

function connect(url: string): Promise<WebSocket> {
  const socket = new WebSocket(url);
  return new Promise((resolve, reject) => {
    socket.on("open", () => resolve(socket));
    socket.on("error", reject);
  });
}

function nextMessage(socket: WebSocket): Promise<RelayEnvelope> {
  return new Promise((resolve, reject) => {
    socket.once("message", (data) => {
      const decoded = decodeEnvelope(String(data));
      decoded.ok ? resolve(decoded.envelope) : reject(new Error(decoded.error));
    });
  });
}

/** Wait for the next response envelope, skipping unsolicited events (directory snapshots). */
async function nextResponse(socket: WebSocket): Promise<RelayEnvelope> {
  for (;;) {
    const envelope = await nextMessage(socket);
    if (envelope.kind === "res") return envelope;
  }
}

async function authInstance(socket: WebSocket, pairingToken: string) {
  socket.send(
    encodeEnvelope({
      protocolVersion: RELAY_PROTOCOL_VERSION,
      kind: "req",
      id: "reg-1",
      type: MSG.instanceRegister,
      payload: { pairingToken, coreVersion: "0.18.0" },
    }),
  );
  const res = await nextMessage(socket);
  return res.payload as { instanceId: string; credential: string };
}

function publishedEndpoint(
  nodeId: string,
  endpointId: string,
  overrides: Partial<
    InstanceAgentEndpointsSyncPayload["endpoints"][number]
  > = {},
): InstanceAgentEndpointsSyncPayload["endpoints"][number] {
  return {
    nodeId,
    endpointId,
    agent: "codex",
    state: "idle",
    capabilities: {
      receive: true,
      steer: false,
      queue: true,
      interrupt: false,
    },
    updatedAt: Date.now(),
    ...overrides,
  };
}

function publishEndpoints(
  socket: WebSocket,
  endpoints: InstanceAgentEndpointsSyncPayload["endpoints"],
): void {
  socket.send(
    encodeEnvelope({
      protocolVersion: RELAY_PROTOCOL_VERSION,
      kind: "event",
      type: MSG.instanceAgentEndpointsSync,
      payload: { endpoints },
    }),
  );
}

test("Relay Hub routes agent.message.route to target instance via agent.message.deliver and preserves source identity", async () => {
  const { instances, account, wss, url } = await makeGateway();

  // Instance A
  const tokenA = instances.issuePairingToken(
    account.id,
    "nodeA",
    600_000,
  ).token;
  const socketA = await connect(url);
  await authInstance(socketA, tokenA);

  // Instance B
  const tokenB = instances.issuePairingToken(
    account.id,
    "nodeB",
    600_000,
  ).token;
  const socketB = await connect(url);
  await authInstance(socketB, tokenB);

  // Instance A publishes its own endpoints (required for source identity)
  publishEndpoints(socketA, [
    publishedEndpoint("node_a_999", "worker_a_sender"),
  ]);

  // Instance B publishes its endpoints
  publishEndpoints(socketB, [
    publishedEndpoint("node_b_123", "worker_b", {
      displayName: "Worker B",
    }),
  ]);

  await new Promise((r) => setTimeout(r, 50));

  let deliveredPayload: AgentMessageDeliverPayload | null = null;
  socketB.on("message", (data) => {
    const decoded = decodeEnvelope(String(data));
    if (
      decoded.ok &&
      decoded.envelope.kind === "req" &&
      decoded.envelope.type === MSG.agentMessageDeliver
    ) {
      deliveredPayload = decoded.envelope.payload as AgentMessageDeliverPayload;
      socketB.send(
        encodeEnvelope({
          protocolVersion: RELAY_PROTOCOL_VERSION,
          kind: "res",
          id: decoded.envelope.id,
          type: decoded.envelope.type,
          payload: {
            messageId: deliveredPayload.messageId,
            status: "queued",
            modeUsed: "queue",
          },
        }),
      );
    }
  });

  const routeReq: AgentMessageRoutePayload = {
    sourceNodeId: "node_a_999",
    sourceEndpointId: "worker_a_sender",
    targetNodeId: "node_b_123",
    targetEndpointId: "worker_b",
    messageId: "msg_test_1",
    content: "hello from node A",
    requestedMode: "auto",
    replyTo: "msg_orig_0",
  };
  socketA.send(
    encodeEnvelope({
      protocolVersion: RELAY_PROTOCOL_VERSION,
      kind: "req",
      id: "route-1",
      type: MSG.agentMessageRoute,
      payload: routeReq,
    }),
  );

  const resA = await nextResponse(socketA);
  expect(resA.kind).toBe("res");
  expect(resA.id).toBe("route-1");
  const resPayload = resA.payload as { status: string; modeUsed: string };
  expect(resPayload.status).toBe("queued");
  expect(resPayload.modeUsed).toBe("queue");

  expect(deliveredPayload).toBeDefined();
  expect(deliveredPayload!.sourceNodeId).toBe("node_a_999");
  expect(deliveredPayload!.sourceEndpointId).toBe("worker_a_sender");
  expect(deliveredPayload!.targetEndpointId).toBe("worker_b");
  expect(deliveredPayload!.replyTo).toBe("msg_orig_0");
  expect(deliveredPayload!.replyable).toBe(true);

  socketA.close();
  socketB.close();
  wss.close();
});

test("Relay Hub returns TARGET_NOT_FOUND when target endpoint is not in published directory", async () => {
  const { instances, account, wss, url } = await makeGateway();

  const tokenA = instances.issuePairingToken(
    account.id,
    "nodeA",
    600_000,
  ).token;
  const socketA = await connect(url);
  await authInstance(socketA, tokenA);

  const tokenB = instances.issuePairingToken(
    account.id,
    "nodeB",
    600_000,
  ).token;
  const socketB = await connect(url);
  await authInstance(socketB, tokenB);

  socketB.send(
    encodeEnvelope({
      protocolVersion: RELAY_PROTOCOL_VERSION,
      kind: "event",
      type: MSG.instanceAgentEndpointsSync,
      payload: {
        endpoints: [
          publishedEndpoint("node_b_123", "worker_other", {
            displayName: "Worker Other",
          }),
        ],
      },
    }),
  );
  // Instance A publishes its own endpoints (required for source identity)
  publishEndpoints(socketA, [publishedEndpoint("node_a", "ep_a")]);

  await new Promise((r) => setTimeout(r, 50));

  const routeReq: AgentMessageRoutePayload = {
    sourceNodeId: "node_a",
    sourceEndpointId: "ep_a",
    targetNodeId: "node_b_123",
    targetEndpointId: "non_existent_worker",
    messageId: "msg_test_not_found",
    content: "hello",
    requestedMode: "auto",
  };
  socketA.send(
    encodeEnvelope({
      protocolVersion: RELAY_PROTOCOL_VERSION,
      kind: "req",
      id: "route-nf",
      type: MSG.agentMessageRoute,
      payload: routeReq,
    }),
  );

  const resA = await nextResponse(socketA);
  const errPayload = resA.payload as { error: { code: string } };
  expect(errPayload.error.code).toBe("TARGET_NOT_FOUND");

  socketA.close();
  socketB.close();
  wss.close();
});

test("Relay Hub returns TARGET_NODE_OFFLINE when target node is not connected", async () => {
  const { instances, account, wss, url } = await makeGateway();

  const tokenA = instances.issuePairingToken(
    account.id,
    "nodeA",
    600_000,
  ).token;
  const socketA = await connect(url);
  await authInstance(socketA, tokenA);

  // Instance A publishes its own endpoints (required for source identity)
  publishEndpoints(socketA, [publishedEndpoint("node_a", "ep_a")]);

  const routeReq: AgentMessageRoutePayload = {
    sourceNodeId: "node_a",
    sourceEndpointId: "ep_a",
    targetNodeId: "node_unknown_999",
    targetEndpointId: "worker_x",
    messageId: "msg_test_2",
    content: "hello to offline",
    requestedMode: "auto",
  };
  socketA.send(
    encodeEnvelope({
      protocolVersion: RELAY_PROTOCOL_VERSION,
      kind: "req",
      id: "route-2",
      type: MSG.agentMessageRoute,
      payload: routeReq,
    }),
  );

  const resA = await nextResponse(socketA);
  expect(resA.kind).toBe("res");
  expect(resA.id).toBe("route-2");
  const errPayload = resA.payload as {
    error: { code: string; message: string };
  };
  expect(errPayload.error.code).toBe("TARGET_NODE_OFFLINE");

  socketA.close();
  wss.close();
});

test("Relay Hub isolates messages across different accounts", async () => {
  const { instances, account, accountBob, wss, url } = await makeGateway();

  // Instance A under Alice
  const tokenA = instances.issuePairingToken(
    account.id,
    "nodeA",
    600_000,
  ).token;
  const socketA = await connect(url);
  await authInstance(socketA, tokenA);

  // Instance B under Bob
  const tokenB = instances.issuePairingToken(
    accountBob.id,
    "nodeB",
    600_000,
  ).token;
  const socketB = await connect(url);
  await authInstance(socketB, tokenB);

  socketB.send(
    encodeEnvelope({
      protocolVersion: RELAY_PROTOCOL_VERSION,
      kind: "event",
      type: MSG.instanceAgentEndpointsSync,
      payload: {
        endpoints: [
          publishedEndpoint("node_bob_1", "worker_bob", {
            displayName: "Worker Bob",
          }),
        ],
      },
    }),
  );

  await new Promise((r) => setTimeout(r, 50));

  // Instance A publishes its own endpoints (required for source identity)
  publishEndpoints(socketA, [publishedEndpoint("node_a", "ep_a")]);

  // Alice tries to route to Bob's node
  socketA.send(
    encodeEnvelope({
      protocolVersion: RELAY_PROTOCOL_VERSION,
      kind: "req",
      id: "route-cross",
      type: MSG.agentMessageRoute,
      payload: {
        sourceNodeId: "node_a",
        sourceEndpointId: "ep_a",
        targetNodeId: "node_bob_1",
        targetEndpointId: "worker_bob",
        messageId: "msg_cross",
        content: "hello across account",
        requestedMode: "auto",
      },
    }),
  );

  const resA = await nextResponse(socketA);
  const errPayload = resA.payload as { error: { code: string } };
  expect(errPayload.error.code).toBe("TARGET_NODE_OFFLINE");

  socketA.close();
  socketB.close();
  wss.close();
});

test("Relay Hub rejects a spoofed source identity with DELIVERY_DENIED", async () => {
  const { instances, account, wss, url } = await makeGateway();

  const tokenA = instances.issuePairingToken(
    account.id,
    "nodeA",
    600_000,
  ).token;
  const socketA = await connect(url);
  await authInstance(socketA, tokenA);

  const tokenB = instances.issuePairingToken(
    account.id,
    "nodeB",
    600_000,
  ).token;
  const socketB = await connect(url);
  await authInstance(socketB, tokenB);

  // A publishes ONLY its own endpoint; B publishes its own.
  publishEndpoints(socketA, [publishedEndpoint("node_a", "ep_a")]);
  publishEndpoints(socketB, [publishedEndpoint("node_b_123", "worker_b")]);

  await new Promise((r) => setTimeout(r, 50));

  // Case 1: A claims B's published endpoint as its own source (identity theft).
  socketA.send(
    encodeEnvelope({
      protocolVersion: RELAY_PROTOCOL_VERSION,
      kind: "req",
      id: "spoof-1",
      type: MSG.agentMessageRoute,
      payload: {
        sourceNodeId: "node_b_123",
        sourceEndpointId: "worker_b",
        targetNodeId: "node_b_123",
        targetEndpointId: "worker_b",
        messageId: "msg_spoof_1",
        content: "hello from a stolen identity",
        requestedMode: "auto",
      },
    }),
  );
  const resSpoofB = await nextResponse(socketA);
  const errSpoofB = resSpoofB.payload as { error: { code: string } };
  expect(errSpoofB.error.code).toBe("DELIVERY_DENIED");

  // Case 2: A claims a fabricated source that was never published.
  socketA.send(
    encodeEnvelope({
      protocolVersion: RELAY_PROTOCOL_VERSION,
      kind: "req",
      id: "spoof-2",
      type: MSG.agentMessageRoute,
      payload: {
        sourceNodeId: "node_a",
        sourceEndpointId: "never_published_endpoint",
        targetNodeId: "node_b_123",
        targetEndpointId: "worker_b",
        messageId: "msg_spoof_2",
        content: "hello from an unpublished endpoint",
        requestedMode: "auto",
      },
    }),
  );
  const resSpoofFabricated = await nextResponse(socketA);
  const errSpoofFabricated = resSpoofFabricated.payload as {
    error: { code: string };
  };
  expect(errSpoofFabricated.error.code).toBe("DELIVERY_DENIED");

  socketA.close();
  socketB.close();
  wss.close();
});

test("Relay Hub derives replyable from the source endpoint receive capability", async () => {
  const { instances, account, wss, url } = await makeGateway();

  const tokenA = instances.issuePairingToken(
    account.id,
    "nodeA",
    600_000,
  ).token;
  const socketA = await connect(url);
  await authInstance(socketA, tokenA);

  const tokenB = instances.issuePairingToken(
    account.id,
    "nodeB",
    600_000,
  ).token;
  const socketB = await connect(url);
  await authInstance(socketB, tokenB);

  // A publishes a source endpoint that CANNOT receive replies.
  publishEndpoints(socketA, [
    publishedEndpoint("node_a", "ep_no_receive", {
      capabilities: {
        receive: false,
        steer: false,
        queue: true,
        interrupt: false,
      },
    }),
  ]);
  publishEndpoints(socketB, [publishedEndpoint("node_b_123", "worker_b")]);

  await new Promise((r) => setTimeout(r, 50));

  let deliveredPayload: AgentMessageDeliverPayload | null = null;
  socketB.on("message", (data) => {
    const decoded = decodeEnvelope(String(data));
    if (
      decoded.ok &&
      decoded.envelope.kind === "req" &&
      decoded.envelope.type === MSG.agentMessageDeliver
    ) {
      deliveredPayload = decoded.envelope.payload as AgentMessageDeliverPayload;
      socketB.send(
        encodeEnvelope({
          protocolVersion: RELAY_PROTOCOL_VERSION,
          kind: "res",
          id: decoded.envelope.id,
          type: decoded.envelope.type,
          payload: {
            messageId: deliveredPayload.messageId,
            status: "queued",
            modeUsed: "queue",
          },
        }),
      );
    }
  });

  socketA.send(
    encodeEnvelope({
      protocolVersion: RELAY_PROTOCOL_VERSION,
      kind: "req",
      id: "route-replyable",
      type: MSG.agentMessageRoute,
      payload: {
        sourceNodeId: "node_a",
        sourceEndpointId: "ep_no_receive",
        targetNodeId: "node_b_123",
        targetEndpointId: "worker_b",
        messageId: "msg_replyable",
        content: "hello",
        requestedMode: "auto",
      },
    }),
  );

  const resA = await nextResponse(socketA);
  expect(resA.kind).toBe("res");
  expect((resA.payload as { status: string }).status).toBe("queued");
  expect(deliveredPayload).toBeDefined();
  expect(deliveredPayload!.replyable).toBe(false);

  socketA.close();
  socketB.close();
  wss.close();
});

test("Relay Hub routes agent.message.completion from target instance to source instance and preserves identities", async () => {
  const { instances, account, wss, url } = await makeGateway();

  // Instance A (original sender)
  const tokenA = instances.issuePairingToken(account.id, "nodeA", 600_000).token;
  const socketA = await connect(url);
  await authInstance(socketA, tokenA);

  // Instance B (original target, now sending completion)
  const tokenB = instances.issuePairingToken(account.id, "nodeB", 600_000).token;
  const socketB = await connect(url);
  await authInstance(socketB, tokenB);

  // Publish endpoints
  publishEndpoints(socketA, [publishedEndpoint("node_a_999", "worker_a_sender")]);
  publishEndpoints(socketB, [publishedEndpoint("node_b_123", "worker_b")]);

  await new Promise((r) => setTimeout(r, 50));

  let receivedCompletion: AgentMessageCompletionPayload | null = null;
  socketA.on("message", (data) => {
    const decoded = decodeEnvelope(String(data));
    if (
      decoded.ok &&
      decoded.envelope.kind === "req" &&
      decoded.envelope.type === MSG.agentMessageCompletion
    ) {
      receivedCompletion = decoded.envelope.payload as AgentMessageCompletionPayload;
      socketA.send(
        encodeEnvelope({
          protocolVersion: RELAY_PROTOCOL_VERSION,
          kind: "res",
          id: decoded.envelope.id,
          type: decoded.envelope.type,
          payload: { ok: true },
        }),
      );
    }
  });

  const completionPayload: AgentMessageCompletionPayload = {
    requestMessageId: "msg_req_100",
    source: { nodeId: "node_a_999", endpointId: "worker_a_sender" },
    target: { nodeId: "node_b_123", endpointId: "worker_b" },
    status: "completed",
    result: "Analysis complete: all tests passed",
    completedAt: 1700000000000,
  };

  socketB.send(
    encodeEnvelope({
      protocolVersion: RELAY_PROTOCOL_VERSION,
      kind: "req",
      id: "comp-1",
      type: MSG.agentMessageCompletion,
      payload: completionPayload,
    }),
  );

  const resB = await nextResponse(socketB);
  expect(resB.kind).toBe("res");
  expect(resB.id).toBe("comp-1");
  const resPayload = resB.payload as { ok: boolean };
  expect(resPayload.ok).toBe(true);

  expect(receivedCompletion).toBeDefined();
  expect(receivedCompletion!.requestMessageId).toBe("msg_req_100");
  expect(receivedCompletion!.source.nodeId).toBe("node_a_999");
  expect(receivedCompletion!.source.endpointId).toBe("worker_a_sender");
  expect(receivedCompletion!.target.nodeId).toBe("node_b_123");
  expect(receivedCompletion!.target.endpointId).toBe("worker_b");
  expect(receivedCompletion!.status).toBe("completed");
  expect(receivedCompletion!.result).toBe("Analysis complete: all tests passed");

  socketA.close();
  socketB.close();
  wss.close();
});

test("Relay Hub rejects a spoofed target identity on completion with DELIVERY_DENIED", async () => {
  const { instances, account, wss, url } = await makeGateway();

  const tokenA = instances.issuePairingToken(account.id, "nodeA", 600_000).token;
  const socketA = await connect(url);
  await authInstance(socketA, tokenA);

  const tokenB = instances.issuePairingToken(account.id, "nodeB", 600_000).token;
  const socketB = await connect(url);
  await authInstance(socketB, tokenB);

  publishEndpoints(socketA, [publishedEndpoint("node_a", "worker_a")]);
  publishEndpoints(socketB, [publishedEndpoint("node_b", "worker_b")]);

  await new Promise((r) => setTimeout(r, 50));

  // B tries to claim it is worker_x (not published by B)
  socketB.send(
    encodeEnvelope({
      protocolVersion: RELAY_PROTOCOL_VERSION,
      kind: "req",
      id: "comp-spoof",
      type: MSG.agentMessageCompletion,
      payload: {
        requestMessageId: "msg_spoof",
        source: { nodeId: "node_a", endpointId: "worker_a" },
        target: { nodeId: "node_b", endpointId: "worker_x_unauthorized" },
        status: "completed",
        completedAt: Date.now(),
      },
    }),
  );

  const resB = await nextResponse(socketB);
  expect(resB.kind).toBe("res");
  expect(resB.payload).toHaveProperty("error");
  const error = (resB.payload as { error: { code: string; message: string } }).error;
  expect(error.code).toBe("DELIVERY_DENIED");

  socketA.close();
  socketB.close();
  wss.close();
});

test("Relay Hub returns TARGET_NODE_OFFLINE when source node is not connected for completion", async () => {
  const { instances, account, wss, url } = await makeGateway();

  const tokenB = instances.issuePairingToken(account.id, "nodeB", 600_000).token;
  const socketB = await connect(url);
  await authInstance(socketB, tokenB);
  publishEndpoints(socketB, [publishedEndpoint("node_b", "worker_b")]);

  await new Promise((r) => setTimeout(r, 50));

  socketB.send(
    encodeEnvelope({
      protocolVersion: RELAY_PROTOCOL_VERSION,
      kind: "req",
      id: "comp-offline",
      type: MSG.agentMessageCompletion,
      payload: {
        requestMessageId: "msg_offline",
        source: { nodeId: "node_offline_999", endpointId: "worker_missing" },
        target: { nodeId: "node_b", endpointId: "worker_b" },
        status: "failed",
        error: "Execution failed",
        completedAt: Date.now(),
      },
    }),
  );

  const resB = await nextResponse(socketB);
  expect(resB.kind).toBe("res");
  expect(resB.payload).toHaveProperty("error");
  const error = (resB.payload as { error: { code: string; message: string } }).error;
  expect(error.code).toBe("TARGET_NODE_OFFLINE");

  socketB.close();
  wss.close();
});

test("Relay Hub isolates completions across different accounts", async () => {
  const { instances, account, accountBob, wss, url } = await makeGateway();

  // Account Alice
  const tokenAlice = instances.issuePairingToken(account.id, "nodeAlice", 600_000).token;
  const socketAlice = await connect(url);
  await authInstance(socketAlice, tokenAlice);
  publishEndpoints(socketAlice, [publishedEndpoint("node_alice", "worker_alice")]);

  // Account Bob
  const tokenBob = instances.issuePairingToken(accountBob.id, "nodeBob", 600_000).token;
  const socketBob = await connect(url);
  await authInstance(socketBob, tokenBob);
  publishEndpoints(socketBob, [publishedEndpoint("node_bob", "worker_bob")]);

  await new Promise((r) => setTimeout(r, 50));

  // Bob tries to complete to Alice across account boundaries
  socketBob.send(
    encodeEnvelope({
      protocolVersion: RELAY_PROTOCOL_VERSION,
      kind: "req",
      id: "comp-cross-account",
      type: MSG.agentMessageCompletion,
      payload: {
        requestMessageId: "msg_cross",
        source: { nodeId: "node_alice", endpointId: "worker_alice" },
        target: { nodeId: "node_bob", endpointId: "worker_bob" },
        status: "completed",
        completedAt: Date.now(),
      },
    }),
  );

  const resBob = await nextResponse(socketBob);
  expect(resBob.kind).toBe("res");
  expect(resBob.payload).toHaveProperty("error");
  const error = (resBob.payload as { error: { code: string } }).error;
  expect(error.code).toBe("TARGET_NODE_OFFLINE");

  socketAlice.close();
  socketBob.close();
  wss.close();
});
