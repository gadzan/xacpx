// tests/unit/packages/relay/gateway/instance-gateway-status.test.ts
import { expect, test } from "bun:test";
import { MSG, RELAY_PROTOCOL_VERSION, encodeEnvelope } from "../../../../../packages/relay-protocol/src/index";
import { InstanceGateway } from "../../../../../packages/relay/src/gateway/instance-gateway";

class FakeSocket {
  sent: string[] = [];
  listeners: Record<string, ((data?: unknown) => void)[]> = {};
  send(data: string) { this.sent.push(data); }
  close() { this.emit("close"); }
  on(event: string, listener: (data?: unknown) => void) { (this.listeners[event] ??= []).push(listener); return this; }
  emit(event: string, data?: unknown) { (this.listeners[event] ?? []).forEach((l) => l(data)); }
}

const stubAccounts = { resolveLoginToken: () => null };

test("onStatusChange fires online on auth and offline on close", async () => {
  const events: Array<[string, string, boolean]> = [];
  const gateway = new InstanceGateway({
    instances: {
      redeemPairingToken: () => null,
      registerInstanceForAccount: () => ({ instanceId: "i1", credential: "c", accountId: "a1", name: "" }),
      verifyCredential: () => ({ id: "i1", accountId: "a1" }),
      touch: () => {},
    } as never,
    accounts: stubAccounts,
    onStatusChange: (instanceId, accountId, online) => events.push([instanceId, accountId, online]),
  });
  const socket = new FakeSocket();
  gateway.handleConnection(socket as never);
  socket.emit("message", encodeEnvelope({
    protocolVersion: RELAY_PROTOCOL_VERSION, kind: "req", id: "h1", type: MSG.instanceAuth,
    payload: { instanceId: "i1", credential: "c" },
  }));
  expect(events).toEqual([["i1", "a1", true]]);
  socket.close();
  expect(events).toEqual([["i1", "a1", true], ["i1", "a1", false]]);
});

test("sendRequest pending requests reject with instance-offline on disconnect", async () => {
  const gateway = new InstanceGateway({
    instances: {
      redeemPairingToken: () => null,
      registerInstanceForAccount: () => ({ instanceId: "i1", credential: "c", accountId: "a1", name: "" }),
      verifyCredential: () => ({ id: "i1", accountId: "a1" }),
      touch: () => {},
    } as never,
    accounts: stubAccounts,
    // Large timeout: the test must prove the DRAIN rejects, not the timer.
    requestTimeoutMs: 60_000,
  });
  const socket = new FakeSocket();
  gateway.handleConnection(socket as never);
  socket.emit("message", encodeEnvelope({
    protocolVersion: RELAY_PROTOCOL_VERSION, kind: "req", id: "h1", type: MSG.instanceAuth,
    payload: { instanceId: "i1", credential: "c" },
  }));
  expect(gateway.isOnline("i1")).toBe(true);

  const p = gateway.sendRequest("i1", MSG.sessionsList, {});
  socket.close();
  await expect(p).rejects.toThrow("instance-offline");
});
