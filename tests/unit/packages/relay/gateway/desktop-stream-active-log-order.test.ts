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
  bufferedAmount = 0;
  closeListeners: Array<() => void> = [];
  close() { for (const l of [...this.closeListeners]) l(); }
  on(event: "message" | "close", _listener: never): unknown {
    if (event === "close") this.closeListeners.push(() => {});
    return this;
  }
}

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
