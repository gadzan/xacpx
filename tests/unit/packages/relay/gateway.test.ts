import { expect, test } from "bun:test";
import { WebSocket, WebSocketServer } from "ws";

import {
  MSG,
  RELAY_PROTOCOL_VERSION,
  decodeEnvelope,
  encodeEnvelope,
  type RelayEnvelope,
} from "../../../../packages/relay-protocol/src/index";
import { createSqlDriver, initSchema } from "../../../../packages/relay/src/db";
import { AccountStore } from "../../../../packages/relay/src/stores/accounts";
import { InstanceStore } from "../../../../packages/relay/src/stores/instances";
import {
  InstanceGateway,
  TERMINAL_REQUEST_TIMEOUT_MS,
} from "../../../../packages/relay/src/gateway/instance-gateway";

async function makeGateway(requestTimeoutMs = 500) {
  const db = await createSqlDriver(":memory:");
  initSchema(db);
  const accounts = new AccountStore(db);
  const instances = new InstanceStore(db);
  const account = accounts.createAccount("alice");
  const events: unknown[] = [];
  const gateway = new InstanceGateway({
    instances,
    accounts,
    requestTimeoutMs,
    onEvent: (instanceId, accountId, envelope) => events.push({ instanceId, accountId, type: envelope.type }),
  });
  const wss = new WebSocketServer({ port: 0 });
  await new Promise<void>((resolve) => wss.on("listening", () => resolve()));
  wss.on("connection", (socket) => gateway.handleConnection(socket));
  const port = (wss.address() as { port: number }).port;
  return { gateway, instances, accounts, account, events, wss, url: `ws://127.0.0.1:${port}` };
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

test("register handshake redeems pairing token and marks instance online", async () => {
  const { gateway, instances, account, wss, url } = await makeGateway();
  const issued = instances.issuePairingToken(account.id, "pc", 600_000);
  const socket = await connect(url);
  socket.send(encodeEnvelope({
    protocolVersion: RELAY_PROTOCOL_VERSION, kind: "req", id: "hs-1",
    type: MSG.instanceRegister, payload: { pairingToken: issued.token, coreVersion: "0.11.0" },
  }));
  const res = await nextMessage(socket);
  expect(res.kind).toBe("res");
  expect(res.id).toBe("hs-1");
  const payload = res.payload as { instanceId: string; credential: string };
  expect(typeof payload.credential).toBe("string");
  expect(gateway.isOnline(payload.instanceId)).toBe(true);
  socket.close();
  await new Promise((resolve) => setTimeout(resolve, 50));
  expect(gateway.isOnline(payload.instanceId)).toBe(false);
  wss.close();
});

test("sendRequest round-trips through an authed instance; offline and timeout reject", async () => {
  const { gateway, instances, account, wss, url } = await makeGateway();
  const redeemed = instances.redeemPairingToken(
    instances.issuePairingToken(account.id, "pc", 600_000).token,
  )!;
  await expect(gateway.sendRequest(redeemed.instanceId, MSG.sessionsList, {})).rejects.toThrow("instance-offline");

  const socket = await connect(url);
  socket.send(encodeEnvelope({
    protocolVersion: RELAY_PROTOCOL_VERSION, kind: "req", id: "hs-1",
    type: MSG.instanceAuth, payload: { instanceId: redeemed.instanceId, credential: redeemed.credential },
  }));
  await nextMessage(socket); // auth res
  let forwardedRequest: RelayEnvelope | undefined;
  socket.on("message", (data) => {
    const decoded = decodeEnvelope(String(data));
    if (decoded.ok && decoded.envelope.kind === "req" && decoded.envelope.type === MSG.sessionsList) {
      forwardedRequest = decoded.envelope;
      socket.send(encodeEnvelope({
        protocolVersion: RELAY_PROTOCOL_VERSION, kind: "res", id: decoded.envelope.id,
        type: decoded.envelope.type, payload: { sessions: [] },
      }));
    }
    // requests of other types are ignored -> sendRequest times out
  });
  const requestStartedAt = Date.now();
  const result = await gateway.sendRequest(redeemed.instanceId, MSG.sessionsList, {});
  expect(result).toEqual({ sessions: [] });
  expect(forwardedRequest?.requestBudgetMs).toBe(1);
  expect(forwardedRequest?.requestDeadlineAt).toBeGreaterThanOrEqual(requestStartedAt);
  expect(forwardedRequest?.requestDeadlineAt).toBeLessThan(requestStartedAt + 100);
  await expect(gateway.sendRequest(redeemed.instanceId, MSG.prompt, {})).rejects.toThrow("timeout");
  socket.close();
  wss.close();
});

test("sendRequest publishes an absolute work deadline that preserves the response reserve", async () => {
  const { gateway, instances, account, wss, url } = await makeGateway(45_000);
  const redeemed = instances.redeemPairingToken(
    instances.issuePairingToken(account.id, "pc", 600_000).token,
  )!;
  const socket = await connect(url);
  socket.send(encodeEnvelope({
    protocolVersion: RELAY_PROTOCOL_VERSION, kind: "req", id: "hs-1",
    type: MSG.instanceAuth, payload: { instanceId: redeemed.instanceId, credential: redeemed.credential },
  }));
  await nextMessage(socket);
  let forwardedRequest: RelayEnvelope | undefined;
  socket.on("message", (data) => {
    const decoded = decodeEnvelope(String(data));
    if (!decoded.ok || decoded.envelope.kind !== "req") return;
    forwardedRequest = decoded.envelope;
    socket.send(encodeEnvelope({
      protocolVersion: RELAY_PROTOCOL_VERSION, kind: "res", id: decoded.envelope.id,
      type: decoded.envelope.type, payload: { sessions: [] },
    }));
  });

  const requestStartedAt = Date.now();
  await gateway.sendRequest(redeemed.instanceId, MSG.sessionsList, {});

  expect(forwardedRequest?.requestBudgetMs).toBe(30_000);
  expect(forwardedRequest?.requestDeadlineAt).toBeGreaterThanOrEqual(requestStartedAt + 30_000);
  expect(forwardedRequest?.requestDeadlineAt).toBeLessThan(requestStartedAt + 31_000);
  socket.close();
  wss.close();
});

test("terminal open publishes a request budget large enough for RMUX create", async () => {
  const { gateway, instances, account, wss, url } = await makeGateway();
  const redeemed = instances.redeemPairingToken(
    instances.issuePairingToken(account.id, "pc", 600_000).token,
  )!;
  const socket = await connect(url);
  socket.send(encodeEnvelope({
    protocolVersion: RELAY_PROTOCOL_VERSION, kind: "req", id: "hs-1",
    type: MSG.instanceAuth, payload: { instanceId: redeemed.instanceId, credential: redeemed.credential },
  }));
  await nextMessage(socket);
  let forwardedRequest: RelayEnvelope | undefined;
  socket.on("message", (data) => {
    const decoded = decodeEnvelope(String(data));
    if (!decoded.ok || decoded.envelope.kind !== "req") return;
    forwardedRequest = decoded.envelope;
    socket.send(encodeEnvelope({
      protocolVersion: RELAY_PROTOCOL_VERSION, kind: "res", id: decoded.envelope.id,
      type: decoded.envelope.type, payload: { terminalId: "t1", generation: "g1" },
    }));
  });

  const requestStartedAt = Date.now();
  await gateway.sendRequest(redeemed.instanceId, MSG.terminalOpen, {
    chatKey: "relay:u1",
    sessionAlias: "demo",
    viewerId: "v1",
    cols: 80,
    rows: 24,
  }, { timeoutMs: TERMINAL_REQUEST_TIMEOUT_MS });

  // Hub timeout − 15s response reserve ⇒ work budget large enough for RMUX create.
  const expectedBudget = TERMINAL_REQUEST_TIMEOUT_MS - 15_000;
  expect(forwardedRequest?.type).toBe(MSG.terminalOpen);
  expect(forwardedRequest?.requestBudgetMs).toBe(expectedBudget);
  expect(forwardedRequest?.requestDeadlineAt).toBeGreaterThanOrEqual(requestStartedAt + expectedBudget);
  expect(forwardedRequest?.requestDeadlineAt).toBeLessThan(requestStartedAt + expectedBudget + 1_000);
  socket.close();
  wss.close();
});

test("register handshake via login token creates instance and marks it online", async () => {
  const { gateway, accounts, account, wss, url } = await makeGateway();
  const { token: loginToken } = accounts.createLoginToken(account.id, "test-key");
  const socket = await connect(url);
  socket.send(encodeEnvelope({
    protocolVersion: RELAY_PROTOCOL_VERSION, kind: "req", id: "hs-login",
    type: MSG.instanceRegister, payload: { pairingToken: loginToken, name: "my-box", coreVersion: "0.11.0" },
  }));
  const res = await nextMessage(socket);
  expect(res.kind).toBe("res");
  expect(res.id).toBe("hs-login");
  const payload = res.payload as { instanceId: string; credential: string };
  expect(typeof payload.instanceId).toBe("string");
  expect(typeof payload.credential).toBe("string");
  expect(gateway.isOnline(payload.instanceId)).toBe(true);
  socket.close();
  await new Promise((resolve) => setTimeout(resolve, 50));
  expect(gateway.isOnline(payload.instanceId)).toBe(false);
  wss.close();
});

test("unauthenticated non-handshake message closes the socket; bad pairing token gets error res", async () => {
  const { instances, account, wss, url, events, gateway } = await makeGateway();
  const bad = await connect(url);
  const closed = new Promise<void>((resolve) => bad.on("close", () => resolve()));
  bad.send(encodeEnvelope({ protocolVersion: RELAY_PROTOCOL_VERSION, kind: "event", type: MSG.instanceEvent, payload: {} }));
  await closed;

  const socket = await connect(url);
  socket.send(encodeEnvelope({
    protocolVersion: RELAY_PROTOCOL_VERSION, kind: "req", id: "hs-1",
    type: MSG.instanceRegister, payload: { pairingToken: "expired-or-bogus" },
  }));
  const res = await nextMessage(socket);
  expect((res.payload as { error: { code: string } }).error.code).toBe("pairing-failed");

  // authed instance events reach onEvent
  const redeemed = instances.redeemPairingToken(instances.issuePairingToken(account.id, "pc", 600_000).token)!;
  const authed = await connect(url);
  authed.send(encodeEnvelope({
    protocolVersion: RELAY_PROTOCOL_VERSION, kind: "req", id: "hs-1",
    type: MSG.instanceAuth, payload: { instanceId: redeemed.instanceId, credential: redeemed.credential },
  }));
  await nextMessage(authed);
  authed.send(encodeEnvelope({
    protocolVersion: RELAY_PROTOCOL_VERSION, kind: "event",
    type: MSG.instanceEvent, payload: { event: { type: "sessions-changed" } },
  }));
  await new Promise((resolve) => setTimeout(resolve, 50));
  expect(events).toContainEqual({ instanceId: redeemed.instanceId, accountId: redeemed.accountId, type: MSG.instanceEvent });
  expect(gateway.isOnline(redeemed.instanceId)).toBe(true);
  socket.close();
  authed.close();
  wss.close();
});
