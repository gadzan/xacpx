import { expect, test } from "bun:test";
import { createServer, type Server } from "node:net";
import { WebSocket } from "ws";

import {
  MSG,
  encodeEnvelope,
  webClientEnvelope,
} from "../../packages/relay-protocol/src/index";
import { startRelayServer } from "../../packages/relay/src/server";
import { DesktopTunnelRuntime } from "../../packages/channel-relay/src/desktop/desktop-tunnel-runtime";

function fakeRfbServer(bytes: Uint8Array): Promise<{ server: Server; port: number }> {
  const { promise, resolve } = Promise.withResolvers<{ server: Server; port: number }>();
  const server = createServer((socket) => {
    socket.write(Buffer.from(bytes));
  });
  server.listen(0, "127.0.0.1", () => {
    resolve({ server, port: (server.address() as { port: number }).port });
  });
  return promise;
}

function openSocket(url: string, headers?: Record<string, string>): Promise<WebSocket> {
  const { promise, resolve, reject } = Promise.withResolvers<WebSocket>();
  const ws = new WebSocket(url, headers ? { headers } : undefined);
  const timer = setTimeout(() => reject(new Error(`open timeout for ${url}`)), 5000);
  ws.on("open", () => { clearTimeout(timer); resolve(ws); });
  ws.on("error", (err) => { clearTimeout(timer); reject(err); });
  return promise;
}

function nextBinary(ws: WebSocket): Promise<Buffer> {
  const { promise, resolve, reject } = Promise.withResolvers<Buffer>();
  const timer = setTimeout(() => reject(new Error("binary frame timeout")), 5000);
  ws.on("message", (data) => { clearTimeout(timer); resolve(Buffer.from(data as Uint8Array)); });
  return promise;
}

test("desktop hard-gate: probe verdict plus hub binary pipe on an independent connection", async () => {
  const relay = await startRelayServer({ dbPath: ":memory:", httpPort: 0, host: "127.0.0.1" });
  const sockets: WebSocket[] = [];
  let rfb: Server | undefined;
  try {
    const base = `http://127.0.0.1:${relay.httpPort}`;
    const account = relay.runtime.accounts.createAccount("admin");
    const { token: loginToken } = relay.runtime.accounts.createLoginToken(account.id);
    const loginRes = await fetch(`${base}/api/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token: loginToken }),
    });
    const cookie = loginRes.headers.get("set-cookie")?.split(";")[0] ?? "";
    expect(cookie.length).toBeGreaterThan(0);

    // Fake loopback RFB server speaking VncAuth; the real connector probe runs here.
    const handshake = Uint8Array.from([82, 70, 66, 32, 48, 48, 51, 46, 48, 48, 56, 10, 1, 2]);
    ({ server: rfb } = await fakeRfbServer(handshake));
    const port = (rfb.address() as { port: number }).port;
    const tunnel = new DesktopTunnelRuntime({
      config: { enabled: true, backend: "rfb", port, connectTimeoutMs: 2000, maxStreams: 1 },
      hubUrl: `ws://127.0.0.1:${relay.httpPort}`,
    });
    let prepared: unknown;
    await tunnel.handlePrepare({
      protocolVersion: 1,
      kind: "req",
      id: "hub-1",
      type: MSG.desktopPrepare,
      payload: { streamId: "hardgate-1", ticket: "unused-here", expiresAt: Date.now() + 60_000 },
    }, (p) => { prepared = p; });
    // The probe verdict gates the tunnel before any socket opens; the unknown
    // hub ticket then closes the outbound binary socket without a response.
    expect(prepared).toMatchObject({ streamId: "hardgate-1", security: "vnc-auth" });
    tunnel.closeAll();

    // End-to-end through the real hub broker: reserve + tickets + binary pipe.
    // Account cap path shares the same atomic reservation: fill 8 sibling
    // streams first, then the 9th reserve (this instance's slot is free, the
    // account is not) must fail with scope "account".
    for (let i = 0; i < 8; i++) {
      const sibling = relay.runtime.desktop.streamRegistry.reserve({ accountId: account.id, instanceId: `i-sibling-${i}`, ttlMs: 60_000 });
      expect(sibling.ok).toBe(true);
    }
    const capped = relay.runtime.desktop.streamRegistry.reserve({ accountId: account.id, instanceId: "i-hardgate", ttlMs: 60_000 });
    expect(capped).toEqual({ ok: false, code: "desktop-busy", scope: "account" });
    relay.runtime.desktop.streamRegistry.closeForInstance("i-sibling-0");
    const reserved = relay.runtime.desktop.streamRegistry.reserve({ accountId: account.id, instanceId: "i-hardgate", ttlMs: 60_000 });
    expect(reserved.ok).toBe(true);
    if (!reserved.ok) return;
    const streamId = reserved.record.streamId;
    const browserTicket = relay.runtime.desktop.ticketStore.mintTicket({
      streamId, accountId: account.id, instanceId: "i-hardgate", side: "browser",
    });
    const connectorTicket = relay.runtime.desktop.ticketStore.mintTicket({
      streamId, accountId: account.id, instanceId: "i-hardgate", side: "connector",
    });
    expect(relay.runtime.desktop.reportConnectorReady(streamId, "vnc-auth")).toBe(true);

    const connectorWs = await openSocket(`ws://127.0.0.1:${relay.httpPort}/desktop/instance?ticket=${connectorTicket.ticket}`);
    sockets.push(connectorWs);
    const browserWs = await openSocket(
      `ws://127.0.0.1:${relay.httpPort}/desktop/observe?ticket=${browserTicket.ticket}`,
      { cookie },
    );
    sockets.push(browserWs);

    // Control plane stays usable while the binary pair is up (separate connection).
    const controlWs = await openSocket(`ws://127.0.0.1:${relay.httpPort}/ws`, { cookie });
    sockets.push(controlWs);
    controlWs.send(encodeEnvelope(webClientEnvelope({ kind: "subscribe", instanceIds: [] })));

    const serverBytes = Uint8Array.from([82, 70, 66, 32, 48, 48, 51, 46, 48, 48, 56, 10, 0, 0, 0, 2]);
    const browserGot = nextBinary(browserWs);
    connectorWs.send(Buffer.from(serverBytes));
    expect(await browserGot).toEqual(Buffer.from(serverBytes));

    const clientBytes = Uint8Array.from([5, 1, 0, 3]);
    const connectorGot = nextBinary(connectorWs);
    browserWs.send(Buffer.from(clientBytes));
    expect(await connectorGot).toEqual(Buffer.from(clientBytes));

    // Single-use tickets: reuse closes with 4403 instead of pairing.
    const reuse = new WebSocket(`ws://127.0.0.1:${relay.httpPort}/desktop/observe?ticket=${browserTicket.ticket}`, { headers: { cookie } });
    const reuseCode = await new Promise<number>((resolve) => {
      reuse.on("close", (code: number) => resolve(code));
      reuse.on("error", () => {});
    });
    expect(reuseCode).toBe(4403);
  } finally {
    for (const ws of sockets) {
      try { ws.close(); } catch { /* gone */ }
    }
    rfb?.close();
    await relay.close();
  }
}, 30000);
