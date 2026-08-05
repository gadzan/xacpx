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

type LogEntry = [string, string, Record<string, unknown> | undefined];

function makeFakeLogger(): { logger: RelayLogger; logs: Array<LogEntry> } {
  const logs: Array<LogEntry> = [];
  const logger: RelayLogger = {
    debug: (e, m, c) => logs.push([e, m, c]),
    info: (e, m, c) => logs.push([e, m, c]),
    warn: (e, m, c) => logs.push([e, m, c]),
    error: (e, m, c) => logs.push([e, m, c]),
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

test("a successful handshake logs relay.instance.online with instanceId and accountId", () => {
  const { logger, logs } = makeFakeLogger();
  const gateway = new InstanceGateway({ instances: stubInstances, accounts: stubAccounts, logger });
  const socket = new FakeSocket();
  gateway.handleConnection(socket as never);

  auth(socket);

  const online = logs.find(([e]) => e === "relay.instance.online");
  expect(online).toBeDefined();
  expect(online?.[2]).toEqual({ instanceId: "i1", accountId: "a1" });
});

test("a superseded reconnect logs relay.instance.superseded", () => {
  const { logger, logs } = makeFakeLogger();
  const gateway = new InstanceGateway({ instances: stubInstances, accounts: stubAccounts, logger });

  const oldSocket = new FakeSocket();
  gateway.handleConnection(oldSocket as never);
  auth(oldSocket);

  const newSocket = new FakeSocket();
  gateway.handleConnection(newSocket as never);
  auth(newSocket);

  const superseded = logs.find(([e]) => e === "relay.instance.superseded");
  expect(superseded).toBeDefined();
  expect(superseded?.[2]).toEqual({ instanceId: "i1" });
});

test("a socket close logs relay.instance.offline with instanceId and accountId", () => {
  const { logger, logs } = makeFakeLogger();
  const gateway = new InstanceGateway({ instances: stubInstances, accounts: stubAccounts, logger });
  const socket = new FakeSocket();
  gateway.handleConnection(socket as never);
  auth(socket);

  socket.emit("close");

  const offline = logs.find(([e]) => e === "relay.instance.offline");
  expect(offline).toBeDefined();
  expect(offline?.[2]).toEqual({ instanceId: "i1", accountId: "a1" });
});

test("a failed handshake logs relay.instance.handshake_failed with a reason but never a token", () => {
  const { logger, logs } = makeFakeLogger();
  const gateway = new InstanceGateway({ instances: stubInstances, accounts: stubAccounts, logger });
  const socket = new FakeSocket();
  gateway.handleConnection(socket as never);

  // Both stubAccounts.resolveLoginToken and stubInstances.redeemPairingToken return
  // null unconditionally, so any presented pairing token fails the handshake.
  const secretToken = "super-secret-pairing-token";
  socket.emit("message", encodeEnvelope({
    protocolVersion: RELAY_PROTOCOL_VERSION, kind: "req", id: "h1", type: MSG.instanceRegister,
    payload: { pairingToken: secretToken },
  }));

  const failed = logs.find(([e]) => e === "relay.instance.handshake_failed");
  expect(failed).toBeDefined();
  expect(failed?.[2]).toEqual({ reason: "pairing-failed" });
  const allLogText = JSON.stringify(logs);
  expect(allLogText).not.toContain(secretToken);
});
