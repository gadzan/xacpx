import { expect, test } from "bun:test";
import { WebSocket, WebSocketServer } from "ws";

import {
  MSG,
  RELAY_PROTOCOL_VERSION,
  decodeEnvelope,
  encodeEnvelope,
  type AgentMessageDeliverPayload,
  type AgentMessageRoutePayload,
  type InstanceAgentEndpointsSyncPayload,
  type RelayEnvelope,
} from "../../../../../packages/relay-protocol/src/index";
import { createSqlDriver, initSchema } from "../../../../../packages/relay/src/db";
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

test("Relay Hub routes agent.message.route to target instance via agent.message.deliver", async () => {
  const { instances, account, wss, url } = await makeGateway();

  // Instance A
  const tokenA = instances.issuePairingToken(account.id, "nodeA", 600_000).token;
  const socketA = await connect(url);
  const authA = await authInstance(socketA, tokenA);

  // Instance B
  const tokenB = instances.issuePairingToken(account.id, "nodeB", 600_000).token;
  const socketB = await connect(url);
  const authB = await authInstance(socketB, tokenB);

  // Instance B publishes its endpoints
  const syncB: InstanceAgentEndpointsSyncPayload = {
    endpoints: [
      {
        nodeId: "node_b_123",
        endpointId: "worker_b",
        displayName: "Worker B",
        agent: "codex",
        state: "idle",
        capabilities: { receive: true, steer: false, queue: true, interrupt: false },
        updatedAt: Date.now(),
      },
    ],
  };
  socketB.send(
    encodeEnvelope({
      protocolVersion: RELAY_PROTOCOL_VERSION,
      kind: "event",
      type: MSG.instanceAgentEndpointsSync,
      payload: syncB,
    }),
  );

  await new Promise((r) => setTimeout(r, 50));

  // Set up socket B handler to deliver response when it receives agentMessageDeliver
  socketB.on("message", (data) => {
    const decoded = decodeEnvelope(String(data));
    if (decoded.ok && decoded.envelope.kind === "req" && decoded.envelope.type === MSG.agentMessageDeliver) {
      const payload = decoded.envelope.payload as AgentMessageDeliverPayload;
      expect(payload.targetEndpointId).toBe("worker_b");
      expect(payload.content).toBe("hello from node A");
      socketB.send(
        encodeEnvelope({
          protocolVersion: RELAY_PROTOCOL_VERSION,
          kind: "res",
          id: decoded.envelope.id,
          type: decoded.envelope.type,
          payload: {
            messageId: payload.messageId,
            status: "queued",
            modeUsed: "queue",
          },
        }),
      );
    }
  });

  // Instance A sends message to node_b_123
  const routeReq: AgentMessageRoutePayload = {
    targetNodeId: "node_b_123",
    targetEndpointId: "worker_b",
    messageId: "msg_test_1",
    content: "hello from node A",
    requestedMode: "auto",
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

  const resA = await nextMessage(socketA);
  expect(resA.kind).toBe("res");
  expect(resA.id).toBe("route-1");
  const resPayload = resA.payload as { status: string; modeUsed: string };
  expect(resPayload.status).toBe("queued");
  expect(resPayload.modeUsed).toBe("queue");

  socketA.close();
  socketB.close();
  wss.close();
});

test("Relay Hub returns TARGET_NODE_OFFLINE when target node is not connected", async () => {
  const { instances, account, wss, url } = await makeGateway();

  const tokenA = instances.issuePairingToken(account.id, "nodeA", 600_000).token;
  const socketA = await connect(url);
  await authInstance(socketA, tokenA);

  const routeReq: AgentMessageRoutePayload = {
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

  const resA = await nextMessage(socketA);
  expect(resA.kind).toBe("res");
  expect(resA.id).toBe("route-2");
  const errPayload = resA.payload as { error: { code: string; message: string } };
  expect(errPayload.error.code).toBe("TARGET_NODE_OFFLINE");

  socketA.close();
  wss.close();
});

test("Relay Hub isolates messages across different accounts", async () => {
  const { instances, account, accountBob, wss, url } = await makeGateway();

  // Instance A under Alice
  const tokenA = instances.issuePairingToken(account.id, "nodeA", 600_000).token;
  const socketA = await connect(url);
  await authInstance(socketA, tokenA);

  // Instance B under Bob
  const tokenB = instances.issuePairingToken(accountBob.id, "nodeB", 600_000).token;
  const socketB = await connect(url);
  await authInstance(socketB, tokenB);

  socketB.send(
    encodeEnvelope({
      protocolVersion: RELAY_PROTOCOL_VERSION,
      kind: "event",
      type: MSG.instanceAgentEndpointsSync,
      payload: {
        endpoints: [
          {
            nodeId: "node_bob_1",
            endpointId: "worker_bob",
            displayName: "Worker Bob",
            agent: "codex",
            state: "idle",
            capabilities: { receive: true, steer: false, queue: true, interrupt: false },
            updatedAt: Date.now(),
          },
        ],
      },
    }),
  );

  await new Promise((r) => setTimeout(r, 50));

  // Alice tries to route to Bob's node
  socketA.send(
    encodeEnvelope({
      protocolVersion: RELAY_PROTOCOL_VERSION,
      kind: "req",
      id: "route-cross",
      type: MSG.agentMessageRoute,
      payload: {
        targetNodeId: "node_bob_1",
        targetEndpointId: "worker_bob",
        messageId: "msg_cross",
        content: "hello across account",
        requestedMode: "auto",
      },
    }),
  );

  const resA = await nextMessage(socketA);
  const errPayload = resA.payload as { error: { code: string } };
  expect(errPayload.error.code).toBe("TARGET_NODE_OFFLINE");

  socketA.close();
  socketB.close();
  wss.close();
});
