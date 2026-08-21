import { expect, test } from "bun:test";
import { WebSocket, WebSocketServer } from "ws";
import { join } from "node:path";
import { tmpdir } from "node:os";

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
import { PendingCompletionRouteStore } from "../../../../../packages/relay/src/stores/pending-completion-routes";

async function makeGateway(requestTimeoutMs = 1000, dbPath?: string) {
  const db = await createSqlDriver(dbPath ?? ":memory:");
  initSchema(db);
  const accounts = new AccountStore(db);
  const instances = new InstanceStore(db);
  // Restart runs reuse the same DB — "alice" already exists there.
  const account =
    accounts.listAccounts().find((a) => a.username === "alice") ??
    accounts.createAccount("alice");
  const accountBob =
    accounts.listAccounts().find((a) => a.username === "bob") ??
    accounts.createAccount("bob");
  const events: unknown[] = [];
  const pendingCompletionRouteStore = new PendingCompletionRouteStore(db);
  const gateway = new InstanceGateway({
    instances,
    accounts,
    requestTimeoutMs,
    pendingCompletionRoutes: pendingCompletionRouteStore,
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

/** Re-authenticate an already-paired instance using its stored credential —
 *  the production reconnect path after a Hub restart. */
async function authWithCredential(
  url: string,
  instanceId: string,
  credential: string,
): Promise<WebSocket> {
  const socket = new WebSocket(url);
  await new Promise<void>((resolve, reject) => {
    socket.on("open", () => resolve());
    socket.on("error", reject);
  });
  socket.send(
    encodeEnvelope({
      protocolVersion: RELAY_PROTOCOL_VERSION,
      kind: "req",
      id: `auth-${instanceId}`,
      type: MSG.instanceAuth,
      payload: { instanceId, credential },
    }),
  );
  const res = await nextMessage(socket);
  // The gateway answers credential auth with { ok: true } — the instance id
  // was resolved from the stored credential server-side, and THIS socket is
  // now the authenticated connection for the instance.
  if ((res.payload as { ok?: boolean }).ok !== true) {
    throw new Error(`credential auth failed for ${instanceId}`);
  }
  return socket;
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


/** v0.3: establish a Hub-side completion ROUTE grant through a real
 *  completion-bearing agentMessageRoute exchange (the only way grants are
 *  created). Returns once the target's deliver ACK has been processed. */
async function establishCompletionRoute(opts: {
  socketA: WebSocket;
  socketB: WebSocket;
  routeId: string;
  messageId: string;
  sourceEndpoint?: { nodeId: string; endpointId: string };
  targetEndpoint?: { nodeId: string; endpointId: string };
  mode?: "notify" | "result";
}): Promise<void> {
  const source = opts.sourceEndpoint ?? { nodeId: "node_a_999", endpointId: "worker_a_sender" };
  const target = opts.targetEndpoint ?? { nodeId: "node_b_123", endpointId: "worker_b" };
  let deliverSeen = false;
  const onMessage = (data: unknown) => {
    const decoded = decodeEnvelope(String(data));
    if (
      decoded.ok &&
      decoded.envelope.kind === "req" &&
      decoded.envelope.type === MSG.agentMessageDeliver
    ) {
      deliverSeen = true;
      opts.socketB.send(
        encodeEnvelope({
          protocolVersion: RELAY_PROTOCOL_VERSION,
          kind: "res",
          id: decoded.envelope.id,
          type: decoded.envelope.type,
          payload: {
            messageId: (decoded.envelope.payload as { messageId: string }).messageId,
            status: "queued",
            modeUsed: "queue",
          },
        }),
      );
    }
  };
  opts.socketB.on("message", onMessage);
  opts.socketA.send(
    encodeEnvelope({
      protocolVersion: RELAY_PROTOCOL_VERSION,
      kind: "req",
      id: opts.routeId,
      type: MSG.agentMessageRoute,
      payload: {
        sourceNodeId: source.nodeId,
        sourceEndpointId: source.endpointId,
        targetNodeId: target.nodeId,
        targetEndpointId: target.endpointId,
        messageId: opts.messageId,
        content: "completion-bearing request",
        requestedMode: "auto",
        ...(opts.mode ? { completion: opts.mode } : {}),
      },
    }),
  );
  const res = await nextResponse(opts.socketA);
  expect((res.payload as { status: string }).status).toBe("queued");
  const deadline = Date.now() + 2000;
  while (!deliverSeen && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 10));
  }
  expect(deliverSeen).toBe(true);
}

test("Relay Hub routes agent.message.completion via the ROUTE GRANT to source instance and preserves identities", async () => {
  const { instances, account, wss, url } = await makeGateway();

  const tokenA = instances.issuePairingToken(account.id, "nodeA", 600_000).token;
  const socketA = await connect(url);
  await authInstance(socketA, tokenA);

  const tokenB = instances.issuePairingToken(account.id, "nodeB", 600_000).token;
  const socketB = await connect(url);
  await authInstance(socketB, tokenB);

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

  // The grant is established by the REAL completion-bearing route exchange.
  await establishCompletionRoute({
    socketA,
    socketB,
    routeId: "route-grant-1",
    messageId: "msg_req_100",
    mode: "result",
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
  expect(receivedCompletion!.target.endpointId).toBe("worker_b");
  expect(receivedCompletion!.result).toBe("Analysis complete: all tests passed");

  socketA.close();
  socketB.close();
  wss.close();
});

test("Relay Hub routes completions via the route grant even when BOTH endpoints left the live directory (post-request archive decoupling)", async () => {
  const { instances, account, wss, url } = await makeGateway();

  const tokenA = instances.issuePairingToken(account.id, "nodeA", 600_000).token;
  const socketA = await connect(url);
  await authInstance(socketA, tokenA);

  const tokenB = instances.issuePairingToken(account.id, "nodeB", 600_000).token;
  const socketB = await connect(url);
  await authInstance(socketB, tokenB);

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

  await establishCompletionRoute({
    socketA,
    socketB,
    routeId: "route-grant-archive",
    messageId: "msg_archive_race",
    mode: "result",
  });

  // BOTH sides now archive: A (source) and B (completing target) vanish from
  // the published directory via the production empty-presence sync. The
  // established completion contract must survive.
  publishEndpoints(socketA, []);
  publishEndpoints(socketB, []);
  await new Promise((r) => setTimeout(r, 50));

  socketB.send(
    encodeEnvelope({
      protocolVersion: RELAY_PROTOCOL_VERSION,
      kind: "req",
      id: "comp-after-archive",
      type: MSG.agentMessageCompletion,
      payload: {
        requestMessageId: "msg_archive_race",
        source: { nodeId: "node_a_999", endpointId: "worker_a_sender" },
        target: { nodeId: "node_b_123", endpointId: "worker_b" },
        status: "completed",
        result: "finished while offline",
        completedAt: 1700000000001,
      },
    }),
  );

  const resB = await nextResponse(socketB);
  expect((resB.payload as { ok: boolean }).ok).toBe(true);
  expect(receivedCompletion).toBeDefined();
  expect(receivedCompletion!.result).toBe("finished while offline");

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

test("Relay Hub denies completions with no route grant, regardless of directory state", async () => {
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
  // Authorization is grant-based: an unknown request is denied no matter what
  // the directory looks like.
  expect(error.code).toBe("DELIVERY_DENIED");

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
  // Cross-account forgery: no grant exists for Bob's request id.
  expect(error.code).toBe("DELIVERY_DENIED");

  socketAlice.close();
  socketBob.close();
  wss.close();
}, { timeout: 60_000 });



test("Relay Hub retains the route grant when the source returns an APPLICATION error — the target's retry then succeeds (B1)", async () => {
  const { instances, account, wss, url } = await makeGateway();

  const tokenA = instances.issuePairingToken(account.id, "nodeA", 600_000).token;
  const socketA = await connect(url);
  await authInstance(socketA, tokenA);
  const tokenB = instances.issuePairingToken(account.id, "nodeB", 600_000).token;
  const socketB = await connect(url);
  await authInstance(socketB, tokenB);

  publishEndpoints(socketA, [publishedEndpoint("node_a_999", "worker_a_sender")]);
  publishEndpoints(socketB, [publishedEndpoint("node_b_123", "worker_b")]);
  await new Promise((r) => setTimeout(r, 50));

  // A's completion admission fails on the FIRST delivery (transient) and
  // succeeds on the retry.
  let completionAttempts = 0;
  socketA.on("message", (data) => {
    const decoded = decodeEnvelope(String(data));
    if (
      decoded.ok &&
      decoded.envelope.kind === "req" &&
      decoded.envelope.type === MSG.agentMessageCompletion
    ) {
      completionAttempts += 1;
      if (completionAttempts === 1) {
        // Application-level rejection (e.g. source session queue-full):
        // a NORMAL errorPayload response, not a transport failure.
        socketA.send(
          encodeEnvelope({
            protocolVersion: RELAY_PROTOCOL_VERSION,
            kind: "res",
            id: decoded.envelope.id,
            type: decoded.envelope.type,
            payload: {
              error: { code: "DELIVERY_FAILED", message: "source busy" },
            },
          }),
        );
      } else {
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
    }
  });

  await establishCompletionRoute({
    socketA,
    socketB,
    routeId: "route-b1",
    messageId: "msg_b1_retry",
    mode: "result",
  });

  const sendCompletion = (id: string) => {
    socketB.send(
      encodeEnvelope({
        protocolVersion: RELAY_PROTOCOL_VERSION,
        kind: "req",
        id,
        type: MSG.agentMessageCompletion,
        payload: {
          requestMessageId: "msg_b1_retry",
          source: { nodeId: "node_a_999", endpointId: "worker_a_sender" },
          target: { nodeId: "node_b_123", endpointId: "worker_b" },
          status: "completed",
          result: "the answer",
          completedAt: Date.now(),
        },
      }),
    );
  };

  // First attempt: source returns an application error.
  sendCompletion("comp-attempt-1");
  const res1 = await nextResponse(socketB);
  // The error payload is FORWARDED to B (hub stays a pass-through), and…
  expect((res1.payload as { error?: { code: string } }).error?.code).toBe(
    "DELIVERY_FAILED",
  );
  // …the route grant is RETAINED — B's retry is still authorized.

  // Second attempt: source accepts.
  sendCompletion("comp-attempt-2");
  const res2 = await nextResponse(socketB);
  expect((res2.payload as { ok?: boolean }).ok).toBe(true);
  expect(completionAttempts).toBe(2);

  // Grant retired after explicit acceptance: a third replay is denied.
  sendCompletion("comp-attempt-3");
  const res3 = await nextResponse(socketB);
  expect(
    (res3.payload as { error?: { code: string } }).error?.code,
  ).toBe("DELIVERY_DENIED");
  expect(completionAttempts).toBe(2);

  socketA.close();
  socketB.close();
  wss.close();
});

test("Relay Hub pending completion ROUTE grants SURVIVE a full gateway restart on the same SQLite database", async () => {
  const dbPath = join(tmpdir(), `xacpx-hub-grants-${Date.now()}.db`);

  // ---- Process 1: establish the route grant through a real exchange. ----
  let credA = "";
  let credB = "";
  let instA = "";
  let instB = "";
  {
    const { instances, account, wss, url } = await makeGateway(1000, dbPath);
    const tokenA = instances.issuePairingToken(account.id, "nodeA", 600_000).token;
    const socketA = await connect(url);
    const regA = await authInstance(socketA, tokenA);
    credA = regA.credential;
    instA = regA.instanceId;
    const tokenB = instances.issuePairingToken(account.id, "nodeB", 600_000).token;
    const socketB = await connect(url);
    const regB = await authInstance(socketB, tokenB);
    credB = regB.credential;
    instB = regB.instanceId;

    publishEndpoints(socketA, [publishedEndpoint("node_a_999", "worker_a_sender")]);
    publishEndpoints(socketB, [publishedEndpoint("node_b_123", "worker_b")]);
    await new Promise((r) => setTimeout(r, 50));

    await establishCompletionRoute({
      socketA,
      socketB,
      routeId: "route-restart",
      messageId: "msg_restart_persist",
      mode: "result",
    });

    socketA.close();
    socketB.close();
    wss.close();

  }

  // ---- Process 2: FRESH gateway on the same SQLite file (Hub restart). ----
  {
    const { account, wss, url } = await makeGateway(1000, dbPath);
    void account;

    const socketA = await authWithCredential(url, instA, credA);
    const socketB = await authWithCredential(url, instB, credB);

    // Production reconnect path: re-auth with the STORED credential → same
    // instance ids as before the restart. No re-publishing needed for the
    // completion to route — authorization comes from the persisted grant.
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

    socketB.send(
      encodeEnvelope({
        protocolVersion: RELAY_PROTOCOL_VERSION,
        kind: "req",
        id: "comp-after-restart",
        type: MSG.agentMessageCompletion,
        payload: {
          requestMessageId: "msg_restart_persist",
          source: { nodeId: "node_a_999", endpointId: "worker_a_sender" },
          target: { nodeId: "node_b_123", endpointId: "worker_b" },
          status: "completed",
          result: "survived the restart",
          completedAt: Date.now(),
        },
      }),
    );

    console.log("SENDING COMPLETION after restart");
    const resB = await nextResponse(socketB);
    console.log("RES B:", resB.kind, JSON.stringify(resB.payload));
    expect(resB.kind).toBe("res");
    expect((resB.payload as { ok?: boolean }).ok).toBe(true);
    expect(receivedCompletion).toBeDefined();
    expect(receivedCompletion!.result).toBe("survived the restart");

    socketA.close();
    socketB.close();
    wss.close();
  }
}, { timeout: 60_000 });
