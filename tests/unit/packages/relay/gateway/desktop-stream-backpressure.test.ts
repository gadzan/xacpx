// Hub desktop forwarding: soft backpressure (pause the source, resume on
// drain), the unchanged hard cap, per-stream cleanup, and the opt-in stats line.
import { expect, test } from "bun:test";

import {
  DESKTOP_BUFFERED_HARD_CLOSE_BYTES,
  DESKTOP_BUFFERED_SOFT_PAUSE_BYTES,
} from "../../../../../packages/relay-protocol/src/index";
import { DesktopStreamGateway, type DesktopBinarySocket } from "../../../../../packages/relay/src/gateway/desktop-stream-gateway";
import { DesktopStreamRegistry } from "../../../../../packages/relay/src/gateway/desktop-stream-registry";
import { DesktopTicketStore } from "../../../../../packages/relay/src/gateway/desktop-ticket-store";
import type { RelayLogger } from "../../../../../packages/relay/src/logging";

/** ws stand-in with real pause/resume and send-callback semantics. */
class FlowSocket {
  sent: Uint8Array[] = [];
  callbacks: Array<(err?: Error) => void> = [];
  closed = false;
  closeCode?: number;
  closeReason?: string;
  bufferedAmount = 0;
  paused = false;
  pauses = 0;
  resumes = 0;
  messageListeners: Array<(data: unknown, isBinary: boolean) => void> = [];
  closeListeners: Array<() => void> = [];
  send(data: Uint8Array, cb?: (err?: Error) => void) {
    this.sent.push(data);
    if (cb) this.callbacks.push(cb);
  }
  pause() { this.paused = true; this.pauses += 1; }
  resume() { this.paused = false; this.resumes += 1; }
  close(code?: number, reason?: string) {
    if (this.closed) return;
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
  emit(data: unknown, isBinary = true) {
    for (const l of [...this.messageListeners]) l(data, isBinary);
  }
  /** Simulate ws finishing the queued writes. */
  flush() {
    const pending = this.callbacks.splice(0);
    for (const cb of pending) cb();
  }
}

interface Logged { event: string; context: Record<string, unknown> }

function setup(options: { diagnostics?: boolean } = {}) {
  const logs: Logged[] = [];
  const push = (event: string, _m: string, context?: Record<string, unknown>) => { logs.push({ event, context: context ?? {} }); };
  const logger = { info: push, warn: push, error: push, debug: push } as unknown as RelayLogger;
  let streamSeq = 0;
  let ticketSeq = 0;
  const tickets = new DesktopTicketStore({ mint: () => `TICKET-SECRET-${(ticketSeq += 1)}-zz` });
  const streams = new DesktopStreamRegistry({ createStreamId: () => `s-${(streamSeq += 1)}` });
  const gateway = new DesktopStreamGateway({
    tickets,
    streams,
    logger,
    ...(options.diagnostics !== undefined ? { diagnostics: options.diagnostics } : {}),
  });
  const reserved = streams.reserve({ accountId: "a1", instanceId: "i1", ttlMs: 60_000 });
  if (!reserved.ok) throw new Error("reserve failed");
  const streamId = reserved.record.streamId;
  const bt = tickets.mintTicket({ streamId, accountId: "a1", instanceId: "i1", side: "browser" });
  const ct = tickets.mintTicket({ streamId, accountId: "a1", instanceId: "i1", side: "connector" });
  const browser = new FlowSocket();
  const connector = new FlowSocket();
  expect(gateway.attachConnector(ct.ticket, connector as unknown as DesktopBinarySocket).ok).toBe(true);
  expect(gateway.reportConnectorReady(streamId, "ard")).toBe(true);
  expect(gateway.attachBrowser(bt.ticket, browser as unknown as DesktopBinarySocket).ok).toBe(true);
  return { gateway, streams, streamId, browser, connector, logs, tickets: [bt.ticket, ct.ticket] };
}

/** Internal per-stream flow map, read only to prove nothing outlives close. */
function flowEntries(gateway: DesktopStreamGateway): number {
  return (gateway as unknown as { flow: Map<string, unknown> }).flow.size;
}

test("soft backpressure pauses the source, then resumes it from the send callback", () => {
  const { browser, connector } = setup();
  browser.bufferedAmount = DESKTOP_BUFFERED_SOFT_PAUSE_BYTES + 1;
  connector.emit(Uint8Array.from([1, 2, 3]));
  // Forwarded (not dropped, not evicted) and the source stops reading.
  expect(browser.sent.length).toBe(1);
  expect(browser.closed).toBe(false);
  expect(connector.paused).toBe(true);
  expect(connector.pauses).toBe(1);
  // A second frame already parsed while pausing must not stack another pause.
  connector.emit(Uint8Array.from([4]));
  expect(connector.pauses).toBe(1);
  // Peer drains below the watermark: the write callback resumes the source.
  browser.bufferedAmount = 0;
  browser.flush();
  expect(connector.paused).toBe(false);
  expect(connector.resumes).toBe(1);
});

test("fallback timer resumes the source when the peer drains without a callback", async () => {
  const { browser, connector } = setup();
  browser.bufferedAmount = DESKTOP_BUFFERED_SOFT_PAUSE_BYTES + 1;
  connector.emit(Uint8Array.from([1]));
  expect(connector.paused).toBe(true);
  browser.bufferedAmount = 0;
  await new Promise((r) => setTimeout(r, 120));
  expect(connector.paused).toBe(false);
  expect(connector.resumes).toBe(1);
});

test("browser → connector direction pauses the browser socket symmetrically", () => {
  const { browser, connector } = setup();
  connector.bufferedAmount = DESKTOP_BUFFERED_SOFT_PAUSE_BYTES + 1;
  browser.emit(Uint8Array.from([5, 1, 0, 3]));
  expect(connector.sent.length).toBe(1);
  expect(browser.paused).toBe(true);
  connector.bufferedAmount = 0;
  connector.flush();
  expect(browser.paused).toBe(false);
});

test("the existing hard cap still evicts with 1013 backpressure, soft pause or not", () => {
  const { browser, connector, streams, streamId, gateway } = setup();
  browser.bufferedAmount = DESKTOP_BUFFERED_SOFT_PAUSE_BYTES + 1;
  connector.emit(Uint8Array.from([1]));
  expect(connector.paused).toBe(true);
  browser.bufferedAmount = DESKTOP_BUFFERED_HARD_CLOSE_BYTES + 1;
  connector.emit(Uint8Array.from([2]));
  expect(browser.closed).toBe(true);
  expect(connector.closed).toBe(true);
  expect(browser.closeCode).toBe(1013);
  expect(browser.closeReason).toBe("backpressure");
  expect(browser.sent.length).toBe(1); // the over-cap frame was not forwarded
  expect(streams.get(streamId)?.state).toBe("closed");
  expect(flowEntries(gateway)).toBe(0);
});

test("close clears flow state and timers: nothing resumes after the stream is gone", async () => {
  const { browser, connector, gateway } = setup();
  browser.bufferedAmount = DESKTOP_BUFFERED_SOFT_PAUSE_BYTES + 1;
  connector.emit(Uint8Array.from([1]));
  expect(connector.paused).toBe(true);
  expect(flowEntries(gateway)).toBe(1);
  browser.close();
  expect(connector.closed).toBe(true);
  expect(flowEntries(gateway)).toBe(0);
  // A late write callback and the fallback timer window are both inert.
  browser.bufferedAmount = 0;
  browser.flush();
  await new Promise((r) => setTimeout(r, 120));
  expect(connector.resumes).toBe(0);
});

test("diagnostics default off: no stats line", () => {
  const { browser, connector, logs } = setup();
  connector.emit(Uint8Array.from([1, 2, 3]));
  browser.emit(Uint8Array.from([4]));
  browser.close();
  expect(logs.some((l) => l.event === "relay.desktop.stream_stats")).toBe(false);
});

test("diagnostics on: one numbers-only stats line, no ticket/credential/payload", () => {
  const { browser, connector, logs, tickets } = setup({ diagnostics: true });
  const marker = "FRAMEBUFFER-MARKER-5e1d";
  connector.emit(new TextEncoder().encode(`${marker}-down`));
  browser.emit(new TextEncoder().encode(`${marker}-up!`));
  browser.bufferedAmount = DESKTOP_BUFFERED_SOFT_PAUSE_BYTES + 1;
  connector.emit(Uint8Array.from([9]));
  browser.close();
  const stats = logs.filter((l) => l.event === "relay.desktop.stream_stats");
  expect(stats.length).toBe(1);
  const ctx = stats[0]!.context;
  expect(ctx.bytesToBrowser).toBe(marker.length + 5 + 1);
  expect(ctx.bytesToConnector).toBe(marker.length + 4);
  expect(ctx.sourcePauses).toBe(1);
  expect(ctx.peakBrowserBufferedBytes).toBe(DESKTOP_BUFFERED_SOFT_PAUSE_BYTES + 1);
  const serialized = JSON.stringify(logs);
  expect(serialized).not.toContain(marker);
  for (const ticket of tickets) expect(serialized).not.toContain(ticket);
  for (const [key, value] of Object.entries(ctx)) {
    if (key === "streamId") continue;
    expect(typeof value).toBe("number");
  }
});

test("hub diagnostics env flag is off unless explicitly enabled", async () => {
  const { desktopDiagnosticsFromEnv } = await import("../../../../../packages/relay/src/server");
  expect(desktopDiagnosticsFromEnv({})).toBe(false);
  expect(desktopDiagnosticsFromEnv({ XACPX_RELAY_DESKTOP_DIAGNOSTICS: "" })).toBe(false);
  expect(desktopDiagnosticsFromEnv({ XACPX_RELAY_DESKTOP_DIAGNOSTICS: "0" })).toBe(false);
  expect(desktopDiagnosticsFromEnv({ XACPX_RELAY_DESKTOP_DIAGNOSTICS: "1" })).toBe(true);
});
