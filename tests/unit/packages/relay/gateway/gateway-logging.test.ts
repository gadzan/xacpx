// tests/unit/packages/relay/gateway/gateway-logging.test.ts
import { expect, test } from "bun:test";
import { MSG, RELAY_PROTOCOL_VERSION, encodeEnvelope } from "../../../../../packages/relay-protocol/src/index";
import { InstanceGateway } from "../../../../../packages/relay/src/gateway/instance-gateway";
import type { RelayLogger } from "../../../../../packages/relay/src/logging";

class FakeSocket {
  sent: string[] = [];
  listeners: Record<string, ((data?: unknown) => void)[]> = {};
  send(data: string) { this.sent.push(data); }
  close() { this.emit("close"); }
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

function makeFakeLogger(): { logger: RelayLogger; logs: Array<[string, string]> } {
  const logs: Array<[string, string]> = [];
  const logger: RelayLogger = {
    debug: (e, m) => logs.push([e, m]),
    info: (e, m) => logs.push([e, m]),
    error: (e, m) => logs.push([e, m]),
  };
  return { logger, logs };
}

test("instance gateway logs through the injected logger, not console", () => {
  const { logger, logs } = makeFakeLogger();
  const gateway = new InstanceGateway({
    instances: stubInstances,
    accounts: stubAccounts,
    logger,
    onEvent: () => { throw new Error("db write boom"); },
  });
  const socket = new FakeSocket();
  gateway.handleConnection(socket as never);
  auth(socket);

  const event = encodeEnvelope({
    protocolVersion: RELAY_PROTOCOL_VERSION, kind: "event", type: MSG.instanceEvent,
    payload: { event: { type: "sessions-changed" } },
  });
  expect(() => socket.emit("message", event)).not.toThrow();
  expect(logs.some(([e]) => e.startsWith("relay."))).toBe(true);
  expect(logs.some(([e]) => e === "relay.instance.message_failed")).toBe(true);
});

test("instance gateway logs superseded-close failures through the injected logger", () => {
  const { logger, logs } = makeFakeLogger();
  const gateway = new InstanceGateway({ instances: stubInstances, accounts: stubAccounts, logger });

  const oldSocket = new FakeSocket();
  gateway.handleConnection(oldSocket as never);
  auth(oldSocket);
  // Make the superseded socket's close() throw, like a broken/half-open real socket would.
  oldSocket.close = () => { throw new Error("close boom"); };

  const newSocket = new FakeSocket();
  gateway.handleConnection(newSocket as never);
  expect(() => auth(newSocket)).not.toThrow();

  expect(logs.some(([e]) => e === "relay.instance.superseded_close_failed")).toBe(true);
});
