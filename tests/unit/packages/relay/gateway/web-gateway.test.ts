// tests/unit/packages/relay/gateway/web-gateway.test.ts
import { expect, test } from "bun:test";
import { decodeEnvelope, parseWebServerEvent, type WebServerEvent } from "../../../../../packages/relay-protocol/src/index";
import { WebGateway } from "../../../../../packages/relay/src/gateway/web-gateway";

class FakeSocket {
  sent: string[] = [];
  closeListeners: (() => void)[] = [];
  send(data: string) { this.sent.push(data); }
  on(event: string, listener: () => void) { if (event === "close") this.closeListeners.push(listener); return this; }
  close() { this.closeListeners.forEach((l) => l()); }
}

const evt = (online: boolean): WebServerEvent => ({ kind: "instance-status", instanceId: "i1", online });

test("broadcast reaches only that account's sockets", () => {
  const gw = new WebGateway();
  const a = new FakeSocket(); const b = new FakeSocket(); const other = new FakeSocket();
  gw.register("a1", a as never); gw.register("a1", b as never); gw.register("a2", other as never);
  gw.broadcast("a1", evt(true));
  expect(a.sent.length).toBe(1);
  expect(b.sent.length).toBe(1);
  expect(other.sent.length).toBe(0);
  const decoded = decodeEnvelope(a.sent[0]!);
  expect(decoded.ok && parseWebServerEvent(decoded.envelope)).toEqual(evt(true));
});

test("closed sockets are dropped from the account set", () => {
  const gw = new WebGateway();
  const a = new FakeSocket();
  gw.register("a1", a as never);
  a.close();
  gw.broadcast("a1", evt(false));
  expect(a.sent.length).toBe(0);
});

test("a throwing socket does not prevent delivery to the remaining sockets", () => {
  const logs: Array<[string, string]> = [];
  const gw = new WebGateway({ logger: { debug: () => {}, info: () => {}, error: (e, m) => logs.push([e, m]) } });
  const bad = new FakeSocket();
  bad.send = () => { throw new Error("send boom"); };
  const good = new FakeSocket();
  // Insertion order matters: the throwing socket comes first.
  gw.register("a1", bad as never);
  gw.register("a1", good as never);
  expect(() => gw.broadcast("a1", evt(true))).not.toThrow();
  expect(good.sent.length).toBe(1);
  expect(logs.some(([e]) => e === "relay.web.broadcast_failed")).toBe(true);
});

test("non-open sockets are skipped; sockets without readyState still receive", () => {
  const gw = new WebGateway();
  const closing = new FakeSocket() as FakeSocket & { readyState: number };
  closing.readyState = 3; // CLOSED, but close event has not fired yet
  const open = new FakeSocket() as FakeSocket & { readyState: number };
  open.readyState = 1; // OPEN
  const bare = new FakeSocket(); // no readyState (test fakes / non-ws transports)
  gw.register("a1", closing as never);
  gw.register("a1", open as never);
  gw.register("a1", bare as never);
  gw.broadcast("a1", evt(true));
  expect(closing.sent.length).toBe(0);
  expect(open.sent.length).toBe(1);
  expect(bare.sent.length).toBe(1);
});
