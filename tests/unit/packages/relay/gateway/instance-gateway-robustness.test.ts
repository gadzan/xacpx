// tests/unit/packages/relay/gateway/instance-gateway-robustness.test.ts
import { expect, test } from "bun:test";
import { MSG, RELAY_PROTOCOL_VERSION, decodeEnvelope, encodeEnvelope } from "../../../../../packages/relay-protocol/src/index";
import { InstanceGateway } from "../../../../../packages/relay/src/gateway/instance-gateway";

class FakeSocket {
  sent: string[] = [];
  closedWith: Array<{ code?: number; reason?: string }> = [];
  listeners: Record<string, ((data?: unknown) => void)[]> = {};
  send(data: string) { this.sent.push(data); }
  close(code?: number, reason?: string) { this.closedWith.push({ code, reason }); this.emit("close"); }
  on(event: string, listener: (data?: unknown) => void) { (this.listeners[event] ??= []).push(listener); return this; }
  emit(event: string, data?: unknown) { (this.listeners[event] ?? []).forEach((l) => l(data)); }
}

const stubAccounts = { resolveLoginToken: () => null };
const stubInstances = {
  redeemPairingToken: () => null,
  registerInstanceForAccount: () => ({ instanceId: "i1", credential: "c", accountId: "a1", name: "" }),
  verifyCredential: () => ({ id: "i1", accountId: "a1" }),
  touch: () => {},
} as never;

const auth = (socket: FakeSocket) => socket.emit("message", encodeEnvelope({
  protocolVersion: RELAY_PROTOCOL_VERSION, kind: "req", id: "h1", type: MSG.instanceAuth,
  payload: { instanceId: "i1", credential: "c" },
}));

test("a reconnect supersedes the old socket; its late close does not evict the new connection", async () => {
  const events: Array<[string, boolean]> = [];
  const gateway = new InstanceGateway({
    instances: stubInstances,
    accounts: stubAccounts,
    requestTimeoutMs: 60_000,
    onStatusChange: (instanceId, _accountId, online) => events.push([instanceId, online]),
  });

  const oldSocket = new FakeSocket();
  gateway.handleConnection(oldSocket as never);
  auth(oldSocket);
  expect(gateway.isOnline("i1")).toBe(true);

  // Same instance reconnects while the old (half-open) socket is still around.
  const newSocket = new FakeSocket();
  gateway.handleConnection(newSocket as never);
  auth(newSocket);

  // The hub explicitly closed the superseded socket...
  expect(oldSocket.closedWith).toEqual([{ code: 4409, reason: "superseded" }]);
  // ...and its (re-entrant) close did NOT take the instance offline.
  expect(gateway.isOnline("i1")).toBe(true);
  expect(events).toEqual([["i1", true], ["i1", true]]);

  // In-flight requests on the new connection survive a stray late close of the old socket.
  const pending = gateway.sendRequest("i1", MSG.sessionsList, {});
  oldSocket.emit("close"); // duplicate/late close event from the dead socket
  expect(gateway.isOnline("i1")).toBe(true);

  // Requests route to the NEW socket and resolve through it.
  const req = decodeEnvelope(newSocket.sent[newSocket.sent.length - 1]!);
  expect(req.ok && req.envelope.kind === "req" && req.envelope.type === MSG.sessionsList).toBe(true);
  const reqId = req.ok ? req.envelope.id : undefined;
  newSocket.emit("message", encodeEnvelope({
    protocolVersion: RELAY_PROTOCOL_VERSION, kind: "res", id: reqId, type: MSG.sessionsList, payload: { sessions: [] },
  }));
  await expect(pending).resolves.toEqual({ sessions: [] });

  // Closing the CURRENT socket still takes the instance offline.
  newSocket.emit("close");
  expect(gateway.isOnline("i1")).toBe(false);
  expect(events).toEqual([["i1", true], ["i1", true], ["i1", false]]);
});

test("a throwing onEvent consumer does not kill the connection or later events", () => {
  const logs: Array<[string, string]> = [];
  let calls = 0;
  const gateway = new InstanceGateway({
    instances: stubInstances,
    accounts: stubAccounts,
    logger: { debug: () => {}, info: () => {}, error: (e, m) => logs.push([e, m]) },
    onEvent: () => {
      calls += 1;
      if (calls === 1) throw new Error("db write boom");
    },
  });
  const socket = new FakeSocket();
  gateway.handleConnection(socket as never);
  auth(socket);

  const event = encodeEnvelope({
    protocolVersion: RELAY_PROTOCOL_VERSION, kind: "event", type: MSG.instanceEvent,
    payload: { event: { type: "sessions-changed" } },
  });
  expect(() => socket.emit("message", event)).not.toThrow();
  // Connection survives and subsequent events still reach the consumer.
  expect(gateway.isOnline("i1")).toBe(true);
  socket.emit("message", event);
  expect(calls).toBe(2);
  expect(logs.some(([e]) => e === "relay.instance.message_failed")).toBe(true);
});
