import { test, expect, mock } from "bun:test";
import { handleWebClientMessage } from "../../../../packages/relay/src/gateway/web-inbound";
import { webClientEnvelope, encodeEnvelope, MSG } from "@ganglion/xacpx-relay-protocol";

function deps(owned: boolean) {
  return {
    instances: {
      getOwned: mock((id: string, acc: string) => (owned && id === "i1" && acc === "a1" ? { id: "i1" } : undefined)),
      listByAccount: mock((acc: string) => (owned && acc === "a1" ? [{ id: "i1" }] : [])),
    },
    gateway: { sendEvent: mock(() => true) },
    webGateway: { setSubscription: mock(() => {}), send: mock(() => true) },
    stateSnapshot: mock(() => ({ turns: [], usage: [], commands: [] })),
  };
}
const sock = {} as never; // opaque socket handle; identity is all setSubscription needs

test("owned terminal-input is forwarded as a gateway event", () => {
  const d = deps(true);
  handleWebClientMessage(d as never, "a1", sock, encodeEnvelope(webClientEnvelope({ kind: "terminal-input", instanceId: "i1", terminalId: "t1", data: "ls\n" })));
  expect((d.gateway.sendEvent as ReturnType<typeof mock>).mock.calls[0]).toEqual(["i1", MSG.terminalInput, { terminalId: "t1", data: "ls\n" }]);
});

test("non-owned instance is dropped (no forward)", () => {
  const d = deps(false);
  handleWebClientMessage(d as never, "a1", sock, encodeEnvelope(webClientEnvelope({ kind: "terminal-input", instanceId: "i1", terminalId: "t1", data: "x" })));
  expect((d.gateway.sendEvent as ReturnType<typeof mock>).mock.calls.length).toBe(0);
});

test("resize/close map to their gateway event types", () => {
  const d = deps(true);
  handleWebClientMessage(d as never, "a1", sock, encodeEnvelope(webClientEnvelope({ kind: "terminal-resize", instanceId: "i1", terminalId: "t1", cols: 90, rows: 20 })));
  handleWebClientMessage(d as never, "a1", sock, encodeEnvelope(webClientEnvelope({ kind: "terminal-close", instanceId: "i1", terminalId: "t1" })));
  const calls = (d.gateway.sendEvent as ReturnType<typeof mock>).mock.calls;
  expect(calls[0]).toEqual(["i1", MSG.terminalResize, { terminalId: "t1", cols: 90, rows: 20 }]);
  expect(calls[1]).toEqual(["i1", MSG.terminalClose, { terminalId: "t1" }]);
});

test("garbage upstream frame is ignored", () => {
  const d = deps(true);
  handleWebClientMessage(d as never, "a1", sock, "not json");
  expect((d.gateway.sendEvent as ReturnType<typeof mock>).mock.calls.length).toBe(0);
});

test("a subscribe frame filters ownership, installs the subscription, and sends an ordered snapshot", () => {
  const d = deps(true);
  handleWebClientMessage(d as never, "a1", sock, encodeEnvelope(webClientEnvelope({ kind: "subscribe", instanceIds: ["i1", "i2"] })));
  expect((d.webGateway.setSubscription as ReturnType<typeof mock>).mock.calls[0]).toEqual([sock, ["i1"]]);
  expect((d.webGateway.send as ReturnType<typeof mock>).mock.calls[0]).toEqual([
    sock,
    { kind: "state-snapshot", instanceId: "i1", turns: [], usage: [], commands: [] },
  ]);
  expect((d.gateway.sendEvent as ReturnType<typeof mock>).mock.calls.length).toBe(0);
  expect((d.instances.listByAccount as ReturnType<typeof mock>).mock.calls).toEqual([["a1"]]);
  expect((d.instances.getOwned as ReturnType<typeof mock>).mock.calls.length).toBe(0);
});
