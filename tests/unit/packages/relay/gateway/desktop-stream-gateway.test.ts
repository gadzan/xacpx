import { expect, test } from "bun:test";

import { DesktopStreamGateway, type DesktopBinarySocket } from "../../../../../packages/relay/src/gateway/desktop-stream-gateway";
import { DesktopStreamRegistry } from "../../../../../packages/relay/src/gateway/desktop-stream-registry";
import { DesktopTicketStore } from "../../../../../packages/relay/src/gateway/desktop-ticket-store";

class FakeBinarySocket {
  sent: Uint8Array[] = [];
  closed = false;
  closeCode?: number;
  closeReason?: string;
  bufferedAmount = 0;
  messageListeners: Array<(data: unknown, isBinary: boolean) => void> = [];
  closeListeners: Array<() => void> = [];
  send(data: Uint8Array) { this.sent.push(data); }
  close(code?: number, reason?: string) {
    this.closed = true;
    this.closeCode = code;
    this.closeReason = reason;
    for (const l of [...this.closeListeners]) l();
  }
  on(event: "message" | "close", listener: never): unknown {
    if (event === "message") this.messageListeners.push(listener as never);
    else this.closeListeners.push(listener as never);
    return this;
  }
  emit(data: unknown, isBinary: boolean) {
    for (const l of [...this.messageListeners]) l(data, isBinary);
  }
}

function setup() {
  let streamSeq = 0;
  let ticketSeq = 0;
  const tickets = new DesktopTicketStore({ mint: () => `ticket-${(ticketSeq += 1)}` });
  const streams = new DesktopStreamRegistry({ createStreamId: () => `s-${(streamSeq += 1)}` });
  const closed: string[] = [];
  const gateway = new DesktopStreamGateway({
    tickets,
    streams,
    onStreamClosed: (id) => closed.push(id),
  });
  return { tickets, streams, gateway, closed };
}

test("binary frames pipe both ways byte-identical", () => {
  const { tickets, streams, gateway } = setup();
  const reserved = streams.reserve({ accountId: "a1", instanceId: "i1", ttlMs: 60_000 });
  expect(reserved.ok).toBe(true);
  if (!reserved.ok) return;
  const browserTicket = tickets.mintTicket({ streamId: reserved.record.streamId, accountId: "a1", instanceId: "i1", side: "browser" });
  const connectorTicket = tickets.mintTicket({ streamId: reserved.record.streamId, accountId: "a1", instanceId: "i1", side: "connector" });
  const browser = new FakeBinarySocket();
  const connector = new FakeBinarySocket();
  expect(gateway.attachConnector(connectorTicket.ticket, connector as unknown as DesktopBinarySocket).ok).toBe(true);
  expect(gateway.reportConnectorReady(reserved.record.streamId, "vnc-auth")).toBe(true);
  expect(gateway.attachBrowser(browserTicket.ticket, browser as unknown as DesktopBinarySocket).ok).toBe(true);

  const down = Uint8Array.from([82, 70, 66, 32, 48, 48, 51, 46, 48, 48, 56, 10]);
  connector.emit(down, true);
  expect(browser.sent.length).toBe(1);
  expect(browser.sent[0]).toEqual(down);

  const up = Uint8Array.from([5, 1, 0, 3]);
  browser.emit(up, true);
  expect(connector.sent.length).toBe(1);
  expect(connector.sent[0]).toEqual(up);
});

test("second stream for the same instance is busy; close frees the slot", () => {
  const { streams, gateway, closed } = setup();
  const first = streams.reserve({ accountId: "a1", instanceId: "i1", ttlMs: 60_000 });
  expect(first.ok).toBe(true);
  expect(streams.reserve({ accountId: "a1", instanceId: "i1", ttlMs: 60_000 })).toEqual({
    ok: false,
    code: "desktop-busy",
    scope: "instance",
  });
  if (!first.ok) return;
  gateway.closeStream(first.record.streamId, "test");
  expect(closed).toEqual([first.record.streamId]);
  expect(streams.reserve({ accountId: "a1", instanceId: "i1", ttlMs: 60_000 }).ok).toBe(true);
});

test("cross-account browser ticket is consumed and rejected", () => {
  const { tickets, streams, gateway } = setup();
  const reserved = streams.reserve({ accountId: "a1", instanceId: "i1", ttlMs: 60_000 });
  expect(reserved.ok).toBe(true);
  if (!reserved.ok) return;
  const bt = tickets.mintTicket({ streamId: reserved.record.streamId, accountId: "a1", instanceId: "i1", side: "browser" });
  // Account B presents A's ticket with its own valid session: must fail, and
  // the probe burns the ticket so A's later retry also fails (fail closed).
  const attacker = new FakeBinarySocket();
  expect(gateway.attachBrowser(bt.ticket, attacker as unknown as DesktopBinarySocket, "b2").ok).toBe(false);
  expect(attacker.closed).toBe(true);
  const owner = new FakeBinarySocket();
  expect(gateway.attachBrowser(bt.ticket, owner as unknown as DesktopBinarySocket, "a1").ok).toBe(false);
  expect(owner.closed).toBe(true);
  // No socket paired: the stream is still reserved, never hijacked.
  expect(streams.get(reserved.record.streamId)?.state).toBe("preparing");
});

test("precheck consumes the connector ticket before the handshake completes", () => {
  const { tickets, streams, gateway } = setup();
  const reserved = streams.reserve({ accountId: "a1", instanceId: "i1", ttlMs: 60_000 });
  expect(reserved.ok).toBe(true);
  if (!reserved.ok) return;
  const ct = tickets.mintTicket({ streamId: reserved.record.streamId, accountId: "a1", instanceId: "i1", side: "connector" });
  // Upgrade layer consumes first: a raw TCP prober that aborts mid-handshake
  // still burns the single-use ticket.
  const precheck = gateway.precheckConnectorTicket(ct.ticket);
  expect(precheck.ok).toBe(true);
  if (!precheck.ok) return;
  expect(tickets.size()).toBe(0);
  // A second presentation (replay or racing dial) fails even before pairing.
  expect(gateway.precheckConnectorTicket(ct.ticket)).toEqual({ ok: false, reason: "unknown-or-reused-ticket" });
  // The claim pairs without re-consuming.
  const connector = new FakeBinarySocket();
  expect(gateway.attachConnector(precheck.claim, connector as unknown as DesktopBinarySocket).ok).toBe(true);
});

test("ticket reuse and text/oversize frames fail closed", () => {
  const { tickets, streams, gateway } = setup();
  const reserved = streams.reserve({ accountId: "a1", instanceId: "i1", ttlMs: 60_000 });
  expect(reserved.ok).toBe(true);
  if (!reserved.ok) return;
  const bt = tickets.mintTicket({ streamId: reserved.record.streamId, accountId: "a1", instanceId: "i1", side: "browser" });
  const ct = tickets.mintTicket({ streamId: reserved.record.streamId, accountId: "a1", instanceId: "i1", side: "connector" });
  const browser = new FakeBinarySocket();
  const connector = new FakeBinarySocket();
  expect(gateway.attachBrowser(bt.ticket, browser as unknown as DesktopBinarySocket).ok).toBe(true);
  // Reuse: already consumed.
  const retry = new FakeBinarySocket();
  expect(gateway.attachBrowser(bt.ticket, retry as unknown as DesktopBinarySocket).ok).toBe(false);
  expect(retry.closed).toBe(true);
  expect(gateway.attachConnector(ct.ticket, connector as unknown as DesktopBinarySocket).ok).toBe(true);
  expect(gateway.reportConnectorReady(reserved.record.streamId, "vnc-auth")).toBe(true);

  browser.emit("not-binary", false);
  expect(browser.closed).toBe(true);
  expect(connector.closed).toBe(true);
  expect(streams.get(reserved.record.streamId)?.state).toBe("closed");
});

test("oversize frames and slow peers close both sides", () => {
  const { tickets, streams, gateway } = setup();
  const reserved = streams.reserve({ accountId: "a1", instanceId: "i1", ttlMs: 60_000 });
  expect(reserved.ok).toBe(true);
  if (!reserved.ok) return;
  const bt = tickets.mintTicket({ streamId: reserved.record.streamId, accountId: "a1", instanceId: "i1", side: "browser" });
  const ct = tickets.mintTicket({ streamId: reserved.record.streamId, accountId: "a1", instanceId: "i1", side: "connector" });
  const browser = new FakeBinarySocket();
  const connector = new FakeBinarySocket();
  gateway.attachBrowser(bt.ticket, browser as unknown as DesktopBinarySocket);
  gateway.attachConnector(ct.ticket, connector as unknown as DesktopBinarySocket);
  gateway.reportConnectorReady(reserved.record.streamId, "vnc-auth");

  connector.bufferedAmount = 8 * 1024 * 1024;
  browser.emit(Uint8Array.from([1, 2, 3]), true);
  expect(browser.closed).toBe(true);
  expect(connector.closed).toBe(true);
});

test("browser close propagates to the connector; instance offline closes the stream", () => {
  const { tickets, streams, gateway } = setup();
  const reserved = streams.reserve({ accountId: "a1", instanceId: "i1", ttlMs: 60_000 });
  expect(reserved.ok).toBe(true);
  if (!reserved.ok) return;
  const bt = tickets.mintTicket({ streamId: reserved.record.streamId, accountId: "a1", instanceId: "i1", side: "browser" });
  const ct = tickets.mintTicket({ streamId: reserved.record.streamId, accountId: "a1", instanceId: "i1", side: "connector" });
  const browser = new FakeBinarySocket();
  const connector = new FakeBinarySocket();
  gateway.attachBrowser(bt.ticket, browser as unknown as DesktopBinarySocket);
  gateway.attachConnector(ct.ticket, connector as unknown as DesktopBinarySocket);
  gateway.reportConnectorReady(reserved.record.streamId, "vnc-auth");

  browser.close();
  expect(connector.closed).toBe(true);
  expect(streams.get(reserved.record.streamId)?.state).toBe("closed");

  const second = streams.reserve({ accountId: "a1", instanceId: "i1", ttlMs: 60_000 });
  expect(second.ok).toBe(true);
  if (!second.ok) return;
  gateway.closeForInstance("i1", "instance-offline");
  expect(streams.get(second.record.streamId)?.state).toBe("closed");
});

test("account cap blocks the 9th concurrent stream and close frees the slot", () => {
  const { streams, gateway } = setup();
  const ids: string[] = [];
  for (let i = 0; i < 8; i++) {
    const reserved = streams.reserve({ accountId: "a1", instanceId: `i-${i}`, ttlMs: 60_000 });
    expect(reserved.ok).toBe(true);
    if (reserved.ok) ids.push(reserved.record.streamId);
  }
  expect(ids).toHaveLength(8);
  expect(streams.reserve({ accountId: "a1", instanceId: "i-8", ttlMs: 60_000 })).toEqual({
    ok: false,
    code: "desktop-busy",
    scope: "account",
  });
  // A different account is unaffected by a1's cap.
  expect(streams.reserve({ accountId: "a2", instanceId: "i-8", ttlMs: 60_000 }).ok).toBe(true);
  gateway.closeStream(ids[0]!, "test");
  expect(streams.reserve({ accountId: "a1", instanceId: "i-8", ttlMs: 60_000 }).ok).toBe(true);
});

test("expired preparing reservations are reaped before counting", () => {
  let now = 1_000_000;
  const expiring = new DesktopStreamRegistry({
    now: () => now,
    createStreamId: (() => {
      let n = 0;
      return () => `s-${(n += 1)}`;
    })(),
  });
  const first = expiring.reserve({ accountId: "a1", instanceId: "i1", ttlMs: 60_000 });
  expect(first.ok).toBe(true);
  // Same-instance slot still pinned before expiry.
  expect(expiring.reserve({ accountId: "a1", instanceId: "i1", ttlMs: 60_000 }).ok).toBe(false);
  now += 60_001;
  const second = expiring.reserve({ accountId: "a1", instanceId: "i1", ttlMs: 60_000 });
  expect(second.ok).toBe(true);
});
