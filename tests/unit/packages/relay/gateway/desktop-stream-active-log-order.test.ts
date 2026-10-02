// The `stream_active` log must fire on the PRODUCTION order, not on the
// double-reportConnectorReady that the earlier hardgate tests happened to use.
//
// Live traffic: connector attaches -> reportConnectorReady => `waiting-browser`
// -> hub sends `desktop-opened` -> browser attaches inside `pair()` => active.
// When the log lived only in the `reportConnectorReady` already-paired branch,
// a real session never emitted it.

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
  /** Swap in a throwing implementation to exercise the flush-failure path. */
  sendImpl?: (data: Uint8Array) => void;
  send(data: Uint8Array) {
    if (this.sendImpl) { this.sendImpl(data); return; }
    this.sent.push(data);
  }
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

test("backpressure eviction closes with 1013, not a normal closure", () => {
  // Design §15: "destination bufferedAmount over hard cap => close both sides
  // with 1013/reason". A 1000 there reads as an orderly stop to noVNC, which
  // invites an immediate reconnect loop against a peer that is still saturated.
  let ticketSeq = 0;
  const tickets = new DesktopTicketStore({ mint: () => `ticket-${(ticketSeq += 1)}` });
  const streams = new DesktopStreamRegistry({ createStreamId: () => "s-1" });
  const gateway = new DesktopStreamGateway({ tickets, streams });

  const reserved = streams.reserve({ accountId: "a1", instanceId: "i1", ttlMs: 60_000 });
  expect(reserved.ok).toBe(true);
  if (!reserved.ok) return;
  const browserTicket = tickets.mintTicket({ streamId: "s-1", accountId: "a1", instanceId: "i1", side: "browser" });
  const connectorTicket = tickets.mintTicket({ streamId: "s-1", accountId: "a1", instanceId: "i1", side: "connector" });

  const browser = new FakeBinarySocket();
  const connector = new FakeBinarySocket();
  expect(gateway.attachConnector(connectorTicket.ticket, connector as unknown as DesktopBinarySocket).ok).toBe(true);
  expect(gateway.attachBrowser(browserTicket.ticket, browser as unknown as DesktopBinarySocket).ok).toBe(true);

  gateway.closeStream("s-1", "backpressure");

  expect(browser.closed).toBe(true);
  expect(browser.closeCode).toBe(1013);
  expect(connector.closed).toBe(true);
  expect(connector.closeCode).toBe(1013);
  // A normal close keeps 1000: the code is the signal, not just the reason.
  const browser2 = new FakeBinarySocket();
  const connector2 = new FakeBinarySocket();
  expect(gateway.attachConnector(connectorTicket.ticket, connector2 as unknown as DesktopBinarySocket).ok).toBe(false);
  expect(browser2.closeCode).toBeUndefined();
});

test("a pre-attach flush failure closes the stream and never logs it active", () => {
  let ticketSeq = 0;
  const tickets = new DesktopTicketStore({ mint: () => `ticket-${(ticketSeq += 1)}` });
  const streams = new DesktopStreamRegistry({ createStreamId: () => "s-1" });
  const logged: string[] = [];
  const closed: string[] = [];
  const gateway = new DesktopStreamGateway({
    tickets,
    streams,
    onStreamClosed: (id) => closed.push(id),
    logger: { info: (event) => { logged.push(event); }, error: () => {}, warn: () => {} },
  });

  const reserved = streams.reserve({ accountId: "a1", instanceId: "i1", ttlMs: 60_000 });
  expect(reserved.ok).toBe(true);
  if (!reserved.ok) return;
  const browserTicket = tickets.mintTicket({ streamId: "s-1", accountId: "a1", instanceId: "i1", side: "browser" });
  const connectorTicket = tickets.mintTicket({ streamId: "s-1", accountId: "a1", instanceId: "i1", side: "connector" });

  // The connector attaches first and sends RFB bytes, which the hub buffers
  // because the browser is not attached yet.
  const connector = new FakeBinarySocket();
  expect(gateway.attachConnector(connectorTicket.ticket, connector as unknown as DesktopBinarySocket).ok).toBe(true);
  connector.emit(Uint8Array.from([82, 70, 66, 32]), true);

  // The browser attaches and its send THROWS on the buffered bytes, which is the
  // only way flushPreAttach fails.
  const browser = new FakeBinarySocket();
  browser.sendImpl = () => { throw new Error("socket gone"); };
  expect(gateway.reportConnectorReady("s-1", "vnc-auth")).toBe(true);
  expect(gateway.attachBrowser(browserTicket.ticket, browser as unknown as DesktopBinarySocket).ok).toBe(true);

  expect(closed).toEqual(["s-1"]);
  expect(gateway.streamState("s-1")).toBe("closed");
  // The ordering bug: flush failure must not be followed by an "active" log.
  expect(logged).not.toContain("relay.desktop.stream_active");
});

test("stream_active is logged when the browser attaches second, as production does", () => {
  let ticketSeq = 0;
  const tickets = new DesktopTicketStore({ mint: () => `ticket-${(ticketSeq += 1)}` });
  const streams = new DesktopStreamRegistry({ createStreamId: () => "s-1" });
  const logged: Array<{ event: string; context?: Record<string, unknown> }> = [];
  const gateway = new DesktopStreamGateway({
    tickets,
    streams,
    logger: {
      info: (event, message, context) => { logged.push({ event, context }); },
      error: (event, message, context) => { logged.push({ event, context }); },
      warn: () => {},
    },
  });

  const reserved = streams.reserve({ accountId: "a1", instanceId: "i1", ttlMs: 60_000 });
  expect(reserved.ok).toBe(true);
  if (!reserved.ok) return;
  const browserTicket = tickets.mintTicket({ streamId: "s-1", accountId: "a1", instanceId: "i1", side: "browser" });
  const connectorTicket = tickets.mintTicket({ streamId: "s-1", accountId: "a1", instanceId: "i1", side: "connector" });

  const connector = new FakeBinarySocket();
  const browser = new FakeBinarySocket();
  expect(gateway.attachConnector(connectorTicket.ticket, connector as unknown as DesktopBinarySocket).ok).toBe(true);
  // The connector reports its probe verdict: production reaches waiting-browser here.
  expect(gateway.reportConnectorReady("s-1", "vnc-auth")).toBe(true);
  expect(gateway.streamState("s-1")).toBe("waiting-browser");
  // Not active yet, so nothing should have been logged as active.
  expect(logged.filter((l) => l.event === "relay.desktop.stream_active")).toEqual([]);

  // The browser's own binary upgrade arrives later and completes the pair.
  expect(gateway.attachBrowser(browserTicket.ticket, browser as unknown as DesktopBinarySocket).ok).toBe(true);
  expect(gateway.streamState("s-1")).toBe("active");

  const active = logged.filter((l) => l.event === "relay.desktop.stream_active");
  expect(active).toHaveLength(1);
  expect(active[0]?.context).toMatchObject({ streamId: "s-1", security: "vnc-auth" });
});
