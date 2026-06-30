import { test, expect } from "bun:test";
import { InstanceGateway } from "../../../../packages/relay/src/gateway/instance-gateway";
import { decodeEnvelope, MSG, RELAY_PROTOCOL_VERSION } from "@ganglion/xacpx-relay-protocol";

function fakeSocket() {
  const sent: string[] = [];
  let msg: ((d: unknown) => void) | null = null;
  return {
    sent,
    fire: (d: unknown) => msg?.(d),
    send: (d: string) => sent.push(d),
    close: () => {},
    on(ev: string, cb: never) { if (ev === "message") msg = cb as unknown as (d: unknown) => void; return undefined; },
  };
}

function authedGateway() {
  const gw = new InstanceGateway({
    instances: { redeemPairingToken: () => null as never, registerInstanceForAccount: () => ({ instanceId: "i1", accountId: "a1", credential: "c" }) as never, verifyCredential: () => ({ id: "i1", accountId: "a1" }) as never, touch: () => {} },
    accounts: { resolveLoginToken: () => null },
  });
  const socket = fakeSocket();
  gw.handleConnection(socket as never);
  socket.fire(JSON.stringify({ protocolVersion: RELAY_PROTOCOL_VERSION, kind: "req", id: "h", type: MSG.instanceAuth, payload: { instanceId: "i1", credential: "c" } }));
  socket.sent.length = 0; // drop handshake res
  return { gw, socket };
}

test("sendEvent pushes a kind=event frame with no pending request/timeout", () => {
  const { gw, socket } = authedGateway();
  const ok = gw.sendEvent("i1", MSG.terminalInput, { terminalId: "t1", data: "ls\n" });
  expect(ok).toBe(true);
  const env = decodeEnvelope(socket.sent[0]);
  expect(env.ok && env.envelope.kind).toBe("event");
  expect(env.ok && env.envelope.type).toBe(MSG.terminalInput);
  expect(env.ok && env.envelope.id).toBeUndefined();
  expect(env.ok && env.envelope.payload).toEqual({ terminalId: "t1", data: "ls\n" });
});

test("sendEvent to an offline instance returns false", () => {
  const { gw } = authedGateway();
  expect(gw.sendEvent("nope", MSG.terminalInput, {})).toBe(false);
});
