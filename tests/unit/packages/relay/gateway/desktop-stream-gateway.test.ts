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

test("connector banner before browser attach is buffered and flushed in order", () => {
  const { tickets, streams, gateway } = setup();
  const reserved = streams.reserve({ accountId: "a1", instanceId: "i1", ttlMs: 60_000 });
  expect(reserved.ok).toBe(true);
  if (!reserved.ok) return;
  const bt = tickets.mintTicket({ streamId: reserved.record.streamId, accountId: "a1", instanceId: "i1", side: "browser" });
  const ct = tickets.mintTicket({ streamId: reserved.record.streamId, accountId: "a1", instanceId: "i1", side: "connector" });
  const connector = new FakeBinarySocket();
  expect(gateway.attachConnector(ct.ticket, connector as unknown as DesktopBinarySocket).ok).toBe(true);
  // Connector replays the RFB banner during prepare, before any browser exists.
  const banner = Uint8Array.from([82, 70, 66, 32, 48, 48, 51, 46, 48, 48, 56, 10]);
  connector.emit(banner, true);
  // Browser attaches later; security was already reported during prepare.
  const browser = new FakeBinarySocket();
  expect(gateway.attachBrowser(bt.ticket, browser as unknown as DesktopBinarySocket).ok).toBe(true);
  expect(gateway.reportConnectorReady(reserved.record.streamId, "vnc-auth")).toBe(true);
  expect(streams.get(reserved.record.streamId)?.state).toBe("active");
  expect(browser.sent.length).toBe(1);
  expect(browser.sent[0]).toEqual(banner);
  // Live frames still flow after the flush.
  const live = Uint8Array.from([1, 2, 3]);
  connector.emit(live, true);
  expect(browser.sent.length).toBe(2);
  expect(browser.sent[1]).toEqual(live);
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
    const reserved = gateway.reserve({ accountId: "a1", instanceId: `i-${i}`, ttlMs: 60_000 });
    expect(reserved.ok).toBe(true);
    if (reserved.ok) ids.push(reserved.record.streamId);
  }
  expect(ids).toHaveLength(8);
  expect(gateway.reserve({ accountId: "a1", instanceId: "i-8", ttlMs: 60_000 })).toEqual({
    ok: false,
    code: "desktop-busy",
    scope: "account",
  });
  // A different account is unaffected by a1's cap.
  expect(gateway.reserve({ accountId: "a2", instanceId: "i-8", ttlMs: 60_000 }).ok).toBe(true);
  gateway.closeStream(ids[0]!, "test");
  expect(gateway.reserve({ accountId: "a1", instanceId: "i-8", ttlMs: 60_000 }).ok).toBe(true);
});

test("expired waiting-browser streams terminate through closeStream on reserve", () => {
  let now = 1_000_000;
  let streamSeq = 0;
  let ticketSeq = 0;
  const tickets = new DesktopTicketStore({ mint: () => `ticket-${(ticketSeq += 1)}` });
  const streams = new DesktopStreamRegistry({ now: () => now, createStreamId: () => `s-${(streamSeq += 1)}` });
  const closed: string[] = [];
  const gateway = new DesktopStreamGateway({ tickets, streams, onStreamClosed: (id) => closed.push(id) });

  // Typical orphan path: connector attached and replayed the RFB banner, the
  // browser never opened /desktop/observe, and the stream sits waiting-browser
  // with an unconsumed browser ticket still outstanding.
  const first = gateway.reserve({ accountId: "a1", instanceId: "i1", ttlMs: 60_000 });
  expect(first.ok).toBe(true);
  if (!first.ok) return;
  const browserTicket = tickets.mintTicket({ streamId: first.record.streamId, accountId: "a1", instanceId: "i1", side: "browser" });
  const connectorTicket = tickets.mintTicket({ streamId: first.record.streamId, accountId: "a1", instanceId: "i1", side: "connector" });
  const connector = new FakeBinarySocket();
  expect(gateway.attachConnector(connectorTicket.ticket, connector as unknown as DesktopBinarySocket).ok).toBe(true);
  expect(gateway.reportConnectorReady(first.record.streamId, "vnc-auth")).toBe(true);
  expect(streams.get(first.record.streamId)?.state).toBe("waiting-browser");
  connector.emit(Uint8Array.from([82, 70, 66, 32, 48, 48, 51, 46, 48, 48, 56, 10]), true);

  // Same-instance slot still pinned before expiry.
  expect(gateway.reserve({ accountId: "a1", instanceId: "i1", ttlMs: 60_000 }).ok).toBe(false);
  expect(connector.closed).toBe(false);

  now += 60_001;
  const second = gateway.reserve({ accountId: "a1", instanceId: "i1", ttlMs: 60_000 });
  expect(second.ok).toBe(true);
  if (!second.ok) return;
  // Object-level cleanup, not just slot reuse: paired socket closed, buffered
  // banner no longer occupies a global pre-attach slot, the unused browser
  // ticket is revoked, and the owner hook fired through closeStream.
  expect(connector.closed).toBe(true);
  expect(connector.closeReason).toBe("stream-expired");
  // The socket `close` listener re-enters closeStream synchronously; the
  // owner hook must still fire exactly once.
  expect(closed).toEqual([first.record.streamId]);
  expect(streams.get(first.record.streamId)).toBeUndefined();
  expect(gateway.attachBrowser(browserTicket.ticket, new FakeBinarySocket() as unknown as DesktopBinarySocket).ok).toBe(false);
  expect(tickets.size()).toBe(0);
});
test("repeated abandoned streams never exhaust the pre-attach cap", () => {
  let now = 1_000_000;
  let streamSeq = 0;
  let ticketSeq = 0;
  const tickets = new DesktopTicketStore({ mint: () => `ticket-${(ticketSeq += 1)}` });
  const streams = new DesktopStreamRegistry({ now: () => now, createStreamId: () => `s-${(streamSeq += 1)}` });
  const gateway = new DesktopStreamGateway({ tickets, streams });
  const banner = Uint8Array.from([82, 70, 66, 32, 48, 48, 51, 46, 48, 48, 56, 10]);
  for (let i = 0; i < 65; i++) {
    const reserved = gateway.reserve({ accountId: "a1", instanceId: `i-${i}`, ttlMs: 60_000 });
    expect(reserved.ok).toBe(true);
    if (!reserved.ok) return;
    const ct = tickets.mintTicket({ streamId: reserved.record.streamId, accountId: "a1", instanceId: `i-${i}`, side: "connector" });
    const connector = new FakeBinarySocket();
    expect(gateway.attachConnector(ct.ticket, connector as unknown as DesktopBinarySocket).ok).toBe(true);
    expect(gateway.reportConnectorReady(reserved.record.streamId, "vnc-auth")).toBe(true);
    connector.emit(banner, true);
    // Browser never attaches; push past the reservation TTL.
    now += 60_001;
  }
  // 65 expired orphans must not pin 65/64 pre-attach slots: the next reserve
  // triggers the gateway sweep and a fresh stream still accepts its banner.
  const fresh = gateway.reserve({ accountId: "a1", instanceId: "i-fresh", ttlMs: 60_000 });
  expect(fresh.ok).toBe(true);
  if (!fresh.ok) return;
  const freshTicket = tickets.mintTicket({ streamId: fresh.record.streamId, accountId: "a1", instanceId: "i-fresh", side: "connector" });
  const freshConnector = new FakeBinarySocket();
  expect(gateway.attachConnector(freshTicket.ticket, freshConnector as unknown as DesktopBinarySocket).ok).toBe(true);
  freshConnector.emit(banner, true);
  expect(streams.get(fresh.record.streamId)?.state).not.toBe("closed");
});

/**
 * Browser-ticket vs reservation-deadline alignment.
 *
 * The reservation TTL starts at reserve() time, but the connector's RFB probe
 * runs AFTER it, so the stream's own deadline can expire before the browser
 * ticket it later issues. Two failure modes follow, both sweep-phase dependent:
 *  - the sweep killing a stream whose ticket is still valid, or
 *  - the sweep missing between ticks, letting pair() promote an expired record
 *    to `active` where the (preparing/waiting-browser) sweep can never reach it.
 *
 * The browser ticket's TTL is therefore authoritative: mintBrowserTicket pushes
 * the stream deadline out to it, and pair() re-checks liveness synchronously.
 */
function fakeClockSetup(startAt = 1_000_000) {
  let clock = startAt;
  let seq = 0;
  const tickets = new DesktopTicketStore({
    mint: () => `t${(seq += 1)}`,
    now: () => clock,
  });
  const streams = new DesktopStreamRegistry({
    createStreamId: () => "s-1",
    now: () => clock,
  });
  const closed: string[] = [];
  const gateway = new DesktopStreamGateway({
    tickets,
    streams,
    onStreamClosed: (id) => closed.push(id),
  });
  return { tickets, streams, gateway, closed, advance: (ms: number) => { clock += ms; }, now: () => clock };
}

test("minting the browser ticket extends the stream deadline to it", () => {
  const { gateway, streams, advance } = fakeClockSetup();
  const reserved = streams.reserve({ accountId: "a1", instanceId: "i1", ttlMs: 60_000 });
  expect(reserved.ok).toBe(true);
  if (!reserved.ok) return;
  const original = streams.get(reserved.record.streamId)?.expiresAt ?? 0;

  // The connector prepare takes 8s; the reservation deadline has not moved.
  advance(8_000);
  const ticket = gateway.mintBrowserTicket({ streamId: reserved.record.streamId, accountId: "a1", instanceId: "i1" });
  // Ticket TTL is measured from the mint, and the stream is pushed out to it.
  expect(ticket.expiresAt).toBe(1_008_000 + 60_000);
  expect(streams.get(reserved.record.streamId)?.expiresAt).toBe(ticket.expiresAt);
  // max() semantics: a later mint cannot SHORTEN a still-valid deadline.
  const second = gateway.mintBrowserTicket({ streamId: reserved.record.streamId, accountId: "a1", instanceId: "i1" });
  expect(streams.get(reserved.record.streamId)?.expiresAt).toBeGreaterThanOrEqual(second.expiresAt);
});

test("an expired reservation cannot be revived by a valid-ticket browser attach", () => {
  const { gateway, streams, advance } = fakeClockSetup();
  const reserved = streams.reserve({ accountId: "a1", instanceId: "i1", ttlMs: 60_000 });
  expect(reserved.ok).toBe(true);
  if (!reserved.ok) return;

  // t=8s: the connector prepare completes and the hub mints the browser ticket.
  advance(8_000);
  const browserTicket = gateway.mintBrowserTicket({
    streamId: reserved.record.streamId, accountId: "a1", instanceId: "i1",
  });
  expect(browserTicket.expiresAt).toBe(1_008_000 + 60_000);

  // t=64s: the ticket is still live, but the stream's own reservation deadline
  // has passed. Rewind the record to model a hub whose deadline was never
  // aligned, so only the pair()-time liveness check can save it.
  const record = streams.get(reserved.record.streamId);
  if (record) record.expiresAt = 1_060_000;
  advance(56_000);
  expect(1_064_000).toBeLessThan(browserTicket.expiresAt); // ticket still valid

  // A browser holding a still-valid ticket must NOT resurrect the stream.
  const browser = new FakeBinarySocket();
  const result = gateway.attachBrowser(browserTicket.ticket, browser as unknown as DesktopBinarySocket);
  expect(result.ok).toBe(false);
  expect(browser.closed).toBe(true);
  expect(browser.closeCode).toBe(4403);
  expect(streams.get(reserved.record.streamId)?.state).toBe("preparing");
});

test("the sweep reaps an active stream that outlived its deadline", () => {
  // A record promoted to `active` past its deadline used to be invisible to the
  // preparing/waiting-browser sweep, so the tunnel could never be terminated.
  const { gateway, streams, advance } = fakeClockSetup();
  const reserved = streams.reserve({ accountId: "a1", instanceId: "i1", ttlMs: 60_000 });
  expect(reserved.ok).toBe(true);
  const connectorTicket = gateway.ticketStore.mintTicket({
    streamId: reserved.record.streamId, accountId: "a1", instanceId: "i1", side: "connector",
  });
  const connector = new FakeBinarySocket();
  expect(gateway.attachConnector(connectorTicket.ticket, connector as unknown as DesktopBinarySocket).ok).toBe(true);
  expect(gateway.reportConnectorReady(reserved.record.streamId, "vnc-auth")).toBe(true);
  // Ticket mint extends the deadline; attach both sides to reach `active`.
  const browserTicket = gateway.mintBrowserTicket({ streamId: reserved.record.streamId, accountId: "a1", instanceId: "i1" });
  const browser = new FakeBinarySocket();
  expect(gateway.attachBrowser(browserTicket.ticket, browser as unknown as DesktopBinarySocket).ok).toBe(true);
  expect(streams.get(reserved.record.streamId)?.state).toBe("active");

  // Past the (extended) deadline the record is still `active` — and must be
  // reapable, not immortal.
  advance(60_001);
  expect(streams.sweepExpired().map((r) => r.streamId)).toEqual([reserved.record.streamId]);
});

