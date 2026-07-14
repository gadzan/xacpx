// tests/unit/packages/relay/gateway/web-gateway.test.ts
import { expect, test } from "bun:test";
import { decodeEnvelope, parseWebServerEvent, type WebServerEvent } from "../../../../../packages/relay-protocol/src/index";
import { WebGateway } from "../../../../../packages/relay/src/gateway/web-gateway";

class FakeSocket {
  sent: string[] = [];
  closeListeners: (() => void)[] = [];
  bufferedAmount = 0;
  terminated = false;
  send(data: string) { this.sent.push(data); }
  terminate() { this.terminated = true; this.close(); } // real ws: terminate -> close -> drop
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

test("register logs relay.web.connected; the close listener logs relay.web.disconnected, both with accountId", () => {
  const logs: Array<[string, string, Record<string, unknown> | undefined]> = [];
  const gw = new WebGateway({
    logger: { debug: (e, m, c) => logs.push([e, m, c]), info: () => {}, error: () => {} },
  });
  const a = new FakeSocket();
  gw.register("a1", a as never);

  const connected = logs.find(([e]) => e === "relay.web.connected");
  expect(connected).toBeDefined();
  expect(connected?.[2]).toEqual({ accountId: "a1" });

  a.close();
  const disconnected = logs.find(([e]) => e === "relay.web.disconnected");
  expect(disconnected).toBeDefined();
  expect(disconnected?.[2]).toEqual({ accountId: "a1" });
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

const BACKPRESSURE_MAX = 4 * 1024 * 1024;

test("a socket over the bufferedAmount threshold is terminated and skipped, not sent", () => {
  const logs: Array<[string, string, Record<string, unknown> | undefined]> = [];
  const gw = new WebGateway({ logger: { debug: () => {}, info: (e, m, c) => logs.push([e, m, c]), error: () => {} } });
  const slow = new FakeSocket();
  slow.bufferedAmount = BACKPRESSURE_MAX + 1;
  gw.register("a1", slow as never);
  gw.broadcast("a1", evt(true));
  expect(slow.sent.length).toBe(0);
  expect(slow.terminated).toBe(true);
  // the terminate-triggered close dropped it from the account set: a second broadcast is a no-op
  slow.bufferedAmount = 0;
  gw.broadcast("a1", evt(false));
  expect(slow.sent.length).toBe(0);
  expect(logs.some(([e]) => e === "relay.web.backpressure_evict")).toBe(true);
});

test("a socket at/under the threshold receives normally", () => {
  const gw = new WebGateway();
  const ok = new FakeSocket();
  ok.bufferedAmount = BACKPRESSURE_MAX; // exactly at the cap is NOT over it
  gw.register("a1", ok as never);
  gw.broadcast("a1", evt(true));
  expect(ok.sent.length).toBe(1);
  expect(ok.terminated).toBe(false);
});

test("a socket without bufferedAmount (undefined) is unaffected and receives normally", () => {
  const gw = new WebGateway();
  const noProp = new FakeSocket() as FakeSocket & { bufferedAmount?: number };
  delete noProp.bufferedAmount; // genuinely absent → typeof !== "number" → guard skipped
  gw.register("a1", noProp as never);
  gw.broadcast("a1", evt(true));
  expect(noProp.sent.length).toBe(1);
  expect(noProp.terminated).toBe(false);
});

test("one slow socket does not starve the healthy sockets in the same account", () => {
  const gw = new WebGateway();
  const slow = new FakeSocket(); slow.bufferedAmount = BACKPRESSURE_MAX + 1;
  const good = new FakeSocket();
  gw.register("a1", slow as never); // slow first, so its eviction must not skip `good`
  gw.register("a1", good as never);
  gw.broadcast("a1", evt(true));
  expect(slow.sent.length).toBe(0);
  expect(slow.terminated).toBe(true);
  expect(good.sent.length).toBe(1);
});
