// tests/unit/packages/relay/gateway/gateway-heartbeat.test.ts
import { expect, test } from "bun:test";
import { MSG, RELAY_PROTOCOL_VERSION, encodeEnvelope, type WebServerEvent } from "../../../../../packages/relay-protocol/src/index";
import { InstanceGateway } from "../../../../../packages/relay/src/gateway/instance-gateway";
import { WebGateway } from "../../../../../packages/relay/src/gateway/web-gateway";

/** Fake ws socket with ping/pong/terminate; terminate emits close like the real thing. */
class FakeWsSocket {
  sent: string[] = [];
  pings = 0;
  terminated = false;
  answerPongs = false;
  listeners: Record<string, ((data?: unknown) => void)[]> = {};
  send(data: string) { this.sent.push(data); }
  close() { this.emit("close"); }
  ping() { this.pings += 1; if (this.answerPongs) this.emit("pong"); }
  terminate() { this.terminated = true; this.emit("close"); }
  on(event: string, listener: (data?: unknown) => void) { (this.listeners[event] ??= []).push(listener); return this; }
  emit(event: string, data?: unknown) { (this.listeners[event] ?? []).forEach((l) => l(data)); }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const stubDeps = {
  instances: {
    redeemPairingToken: () => null,
    registerInstanceForAccount: () => ({ instanceId: "i1", credential: "c", accountId: "a1", name: "" }),
    verifyCredential: () => ({ id: "i1", accountId: "a1" }),
    touch: () => {},
  } as never,
  accounts: { resolveLoginToken: () => null },
};

const auth = (socket: FakeWsSocket) => socket.emit("message", encodeEnvelope({
  protocolVersion: RELAY_PROTOCOL_VERSION, kind: "req", id: "h1", type: MSG.instanceAuth,
  payload: { instanceId: "i1", credential: "c" },
}));

test("instance socket that never pongs is terminated and the instance goes offline", async () => {
  const events: Array<[string, boolean]> = [];
  const gateway = new InstanceGateway({
    ...stubDeps,
    heartbeatIntervalMs: 10,
    onStatusChange: (instanceId, _accountId, online) => events.push([instanceId, online]),
  });
  const socket = new FakeWsSocket();
  gateway.handleConnection(socket as never);
  auth(socket);
  expect(gateway.isOnline("i1")).toBe(true);

  await sleep(120); // > 3 intervals: ping, ping, declare dead
  expect(socket.pings).toBeGreaterThanOrEqual(2);
  expect(socket.terminated).toBe(true);
  expect(gateway.isOnline("i1")).toBe(false);
  expect(events).toEqual([["i1", true], ["i1", false]]);
});

test("instance socket that answers pongs stays alive", async () => {
  const gateway = new InstanceGateway({ ...stubDeps, heartbeatIntervalMs: 10 });
  const socket = new FakeWsSocket();
  socket.answerPongs = true;
  gateway.handleConnection(socket as never);
  auth(socket);

  await sleep(120);
  expect(socket.pings).toBeGreaterThanOrEqual(3);
  expect(socket.terminated).toBe(false);
  expect(gateway.isOnline("i1")).toBe(true);
  socket.close();
});

test("web socket that never pongs is terminated and dropped from the broadcast set", async () => {
  const gw = new WebGateway({ heartbeatIntervalMs: 10 });
  const dead = new FakeWsSocket();
  const alive = new FakeWsSocket();
  alive.answerPongs = true;
  gw.register("a1", dead as never);
  gw.register("a1", alive as never);

  await sleep(120);
  expect(dead.terminated).toBe(true);
  expect(alive.terminated).toBe(false);

  const evt: WebServerEvent = { kind: "instance-status", instanceId: "i1", online: true };
  gw.broadcast("a1", evt);
  expect(dead.sent.length).toBe(0);
  expect(alive.sent.length).toBe(1);
  alive.close();
});

test("sockets without ping support are left alone (no heartbeat, no crash)", async () => {
  const gw = new WebGateway({ heartbeatIntervalMs: 10 });
  const plain = { sent: [] as string[], send(data: string) { this.sent.push(data); }, on() { return this; } };
  gw.register("a1", plain as never);
  await sleep(50);
  gw.broadcast("a1", { kind: "instance-status", instanceId: "i1", online: true });
  expect(plain.sent.length).toBe(1);
});
