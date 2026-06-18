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
import { InstanceGateway } from "../../../../packages/relay/src/gateway/instance-gateway";
import { createRelayRuntime } from "../../../../packages/relay/src/server";

async function makeGateway(requestTimeoutMs?: number) {
  const db = await createSqlDriver(":memory:");
  initSchema(db);
  const accounts = new AccountStore(db);
  const instances = new InstanceStore(db);
  const account = accounts.createAccount("alice");
  const gateway = new InstanceGateway({ instances, accounts, requestTimeoutMs });
  const wss = new WebSocketServer({ port: 0 });
  await new Promise<void>((resolve) => wss.on("listening", () => resolve()));
  wss.on("connection", (socket) => gateway.handleConnection(socket));
  const port = (wss.address() as { port: number }).port;
  return { gateway, instances, accounts, account, wss, url: `ws://127.0.0.1:${port}` };
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

// Guards the timeout path specifically: an authed-but-never-responding instance.
// An unknown instance rejects immediately with "instance-offline" (not the timeout),
// so we must inject a connected socket that ignores requests — mirroring gateway.test.ts.
test("InstanceGateway honors a configured requestTimeoutMs via the timeout path", async () => {
  const { gateway, instances, account, wss, url } = await makeGateway(50);
  const redeemed = instances.redeemPairingToken(
    instances.issuePairingToken(account.id, "pc", 600_000).token,
  )!;

  const socket = await connect(url);
  socket.send(encodeEnvelope({
    protocolVersion: RELAY_PROTOCOL_VERSION, kind: "req", id: "hs-1",
    type: MSG.instanceAuth, payload: { instanceId: redeemed.instanceId, credential: redeemed.credential },
  }));
  await nextMessage(socket); // auth res
  // Deliberately never respond to forwarded requests -> sendRequest must hit the timeout.

  const start = Date.now();
  await expect(gateway.sendRequest(redeemed.instanceId, MSG.prompt, {})).rejects.toThrow("timeout");
  expect(Date.now() - start).toBeLessThan(5000);

  socket.close();
  wss.close();
});

// Default-path regression guard: with no requestTimeoutMs configured, the timeout still
// fires but uses the (larger) default, so it must NOT fire within a short window.
test("InstanceGateway default timeout is far larger than a configured short one", async () => {
  const { gateway, instances, account, wss, url } = await makeGateway(); // no override
  const redeemed = instances.redeemPairingToken(
    instances.issuePairingToken(account.id, "pc", 600_000).token,
  )!;
  const socket = await connect(url);
  socket.send(encodeEnvelope({
    protocolVersion: RELAY_PROTOCOL_VERSION, kind: "req", id: "hs-1",
    type: MSG.instanceAuth, payload: { instanceId: redeemed.instanceId, credential: redeemed.credential },
  }));
  await nextMessage(socket);

  const pending = gateway.sendRequest(redeemed.instanceId, MSG.prompt, {});
  let settled = false;
  pending.then(() => { settled = true; }, () => { settled = true; });
  await new Promise((resolve) => setTimeout(resolve, 200));
  expect(settled).toBe(false); // default is way more than 200ms, so still pending

  socket.close(); // close rejects pending with instance-offline; swallow it
  await pending.catch(() => {});
  wss.close();
});

// Server-wiring guard: createRelayRuntime must thread requestTimeoutMs into the gateway,
// and default to 120_000 when not supplied.
test("createRelayRuntime threads requestTimeoutMs into the gateway, default 120_000", async () => {
  const configured = await createRelayRuntime(":memory:", { requestTimeoutMs: 99_000 });
  expect(configured.gateway["deps"].requestTimeoutMs).toBe(99_000);
  configured.close();

  const defaulted = await createRelayRuntime(":memory:");
  expect(defaulted.gateway["deps"].requestTimeoutMs).toBe(120_000);
  defaulted.close();
});
