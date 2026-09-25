import { expect, test } from "bun:test";
import { createServer, connect as netConnect, type Server } from "node:net";
import { WebSocket } from "ws";

import {
  MSG,
  encodeEnvelope,
  webClientEnvelope,
} from "../../packages/relay-protocol/src/index";
import { startRelayServer } from "../../packages/relay/src/server";
import { DesktopTunnelRuntime } from "../../packages/channel-relay/src/desktop/desktop-tunnel-runtime";

/**
 * Spec-compliant fake RFB server: writes the banner, WAITS for the 12-byte
 * client ProtocolVersion, then sends the SecurityTypes. The old helper wrote
 * banner+security eagerly, which masked the probe's missing client-version
 * write (both sides would deadlock against a real TigerVNC/TightVNC).
 */
function fakeRfbServer(banner: Uint8Array, security: Uint8Array): Promise<{ server: Server; port: number }> {
  const { promise, resolve } = Promise.withResolvers<{ server: Server; port: number }>();
  const server = createServer((socket) => {
    socket.write(Buffer.from(banner));
    let buffered = Buffer.alloc(0);
    socket.on("data", (chunk: Buffer) => {
      buffered = Buffer.concat([buffered, chunk]);
      if (buffered.length >= 12) {
        socket.write(Buffer.from(security));
      }
    });
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
  // A hub-side 4403 (unknown/reused/cross-account ticket) arrives as an
  // upgrade failure: surface it as a rejection, never an unhandled error.
  // `close` alone is not wired here: the caller's `sockets` cleanup closes
  // every opened socket, and a failed upgrade never opens.
  ws.on("open", () => { clearTimeout(timer); resolve(ws); });
  ws.on("unexpected-response", (_req, res) => {
    clearTimeout(timer);
    reject(new Error(`unexpected upgrade response ${res.statusCode} for ${url}`));
  });
  ws.on("error", (err) => { clearTimeout(timer); reject(err); });
  return promise;
}

function nextBinary(ws: WebSocket): Promise<Buffer> {
  const { promise, resolve, reject } = Promise.withResolvers<Buffer>();
  const timer = setTimeout(() => reject(new Error("binary frame timeout")), 5000);
  // A persistent 'error' swallow: without ANY error listener a socket-level
  // error becomes an unhandled 'error' event that fails the whole bun file.
  // (Bun attributes it to the file, not to the awaiting promise.)
  ws.on("error", () => {});
  ws.on("message", (data) => { clearTimeout(timer); resolve(Buffer.from(data as Uint8Array)); });
  return promise;
}
// Every constructed socket gets a persistent error swallow at construction
// time, so late hub-side closes (4403 rejects, stream shutdowns) can never
// surface as unhandled 'error' events, no matter which await has settled.
function trackSocket(sockets: WebSocket[], ws: WebSocket): WebSocket {
  ws.on("error", () => {});
  sockets.push(ws);
  return ws;
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
    const banner = Uint8Array.from([82, 70, 66, 32, 48, 48, 51, 46, 48, 48, 56, 10]);
    const security = Uint8Array.from([1, 2]);
    ({ server: rfb } = await fakeRfbServer(banner, security));
    const port = (rfb.address() as { port: number }).port;
    const tunnel = new DesktopTunnelRuntime({
      config: { enabled: true, backend: "rfb", port, connectTimeoutMs: 2000, maxStreams: 1 },
      hubUrl: `ws://127.0.0.1:${relay.httpPort}`,
    });
    // Unknown hub ticket: prepare must FAIL (no false-success) because the
    // connector data plane can never attach — the hub socket open is awaited
    // inside openTunnel before respond().
    let prepared: unknown;
    await tunnel.handlePrepare({
      protocolVersion: 1,
      kind: "req",
      id: "hub-1",
      type: MSG.desktopPrepare,
      payload: { streamId: "hardgate-1", ticket: "unused-here", expiresAt: Date.now() + 60_000 },
    }, (p) => { prepared = p; });
    expect(prepared).toMatchObject({ error: { code: "desktop-stream-timeout" } });
    expect(tunnel.activeStreamId).toBeNull();
    tunnel.closeAll();

    // Success path THROUGH the real tunnel: mint a hub-accepted connector
    // ticket, run handlePrepare, and assert the browser's FIRST binary frame
    // is the RFB banner the tunnel replayed — without the replay both sides
    // deadlock (server waits for client version, noVNC waits for banner).
    const live = relay.runtime.desktop.reserve({ accountId: account.id, instanceId: "i-live", ttlMs: 60_000 });
    expect(live.ok).toBe(true);
    if (!live.ok) return;
    const liveBrowserTicket = relay.runtime.desktop.ticketStore.mintTicket({
      streamId: live.record.streamId, accountId: account.id, instanceId: "i-live", side: "browser",
    });
    const liveConnectorTicket = relay.runtime.desktop.ticketStore.mintTicket({
      streamId: live.record.streamId, accountId: account.id, instanceId: "i-live", side: "connector",
    });
    const liveTunnel = new DesktopTunnelRuntime({
      config: { enabled: true, backend: "rfb", port, connectTimeoutMs: 5000, maxStreams: 1 },
      hubUrl: `ws://127.0.0.1:${relay.httpPort}`,
    });
    let livePrepared: unknown;
    await liveTunnel.handlePrepare({
      protocolVersion: 1,
      kind: "req",
      id: "hub-live",
      type: MSG.desktopPrepare,
      payload: { streamId: live.record.streamId, ticket: liveConnectorTicket.ticket, expiresAt: Date.now() + 60_000 },
    }, (x) => { livePrepared = x; });
    expect(livePrepared).toMatchObject({ streamId: live.record.streamId, security: "vnc-auth" });
    expect(liveTunnel.activeStreamId).toBe(live.record.streamId);
    expect(relay.runtime.desktop.reportConnectorReady(live.record.streamId, "vnc-auth")).toBe(true);
    const liveBrowserWs = await openSocket(
      `ws://127.0.0.1:${relay.httpPort}/desktop/observe?ticket=${liveBrowserTicket.ticket}`,
      { cookie },
    );
    trackSocket(sockets, liveBrowserWs);
    // reportConnectorReady ran before the browser attached, so the stream is
    // still waiting-browser; the browser attach alone does not flip it (only
    // the gateway's pair() does once browser+connector+security coincide).
    // Re-mark ready now that both binary sides are paired.
    expect(relay.runtime.desktop.reportConnectorReady(live.record.streamId, "vnc-auth")).toBe(true);
    expect(relay.runtime.desktop.streamRegistry.get(live.record.streamId)?.state).toBe("active");
    const firstFrame = await nextBinary(liveBrowserWs);
    expect(firstFrame.subarray(0, 12)).toEqual(Buffer.from("RFB 003.008\n", "ascii"));
    // The live stream still holds its instance + account slots: close it (and
    // its tunnel) before the cap-filling section below needs 8 free slots.
    liveTunnel.closeAll();
    relay.runtime.desktop.closeStream(live.record.streamId, "test-done");
    // End-to-end through the real hub broker: reserve + tickets + binary pipe.
    // Account cap path shares the same atomic reservation: fill 8 sibling
    // streams first, then the 9th reserve (this instance's slot is free, the
    // account is not) must fail with scope "account".
    for (let i = 0; i < 8; i++) {
      const sibling = relay.runtime.desktop.reserve({ accountId: account.id, instanceId: `i-sibling-${i}`, ttlMs: 60_000 });
      expect(sibling.ok).toBe(true);
    }
    const capped = relay.runtime.desktop.reserve({ accountId: account.id, instanceId: "i-hardgate", ttlMs: 60_000 });
    expect(capped).toEqual({ ok: false, code: "desktop-busy", scope: "account" });
    // Free TWO sibling slots: one for the main stream, one for the
    // cross-account victim stream below (account cap is 8 total).
    relay.runtime.desktop.closeForInstance("i-sibling-0");
    relay.runtime.desktop.closeForInstance("i-sibling-1");
    const reserved = relay.runtime.desktop.reserve({ accountId: account.id, instanceId: "i-hardgate", ttlMs: 60_000 });
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

    trackSocket(sockets, connectorWs);
    const browserWs = await openSocket(
      `ws://127.0.0.1:${relay.httpPort}/desktop/observe?ticket=${browserTicket.ticket}`,
      { cookie },
    );
    trackSocket(sockets, browserWs);

    // Control plane stays usable while the binary pair is up (separate connection).
    const controlWs = await openSocket(`ws://127.0.0.1:${relay.httpPort}/ws`, { cookie });
    trackSocket(sockets, controlWs);
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
    trackSocket(sockets, reuse);
    const reuseCode = await new Promise<number>((resolve) => {
      reuse.on("close", (code: number) => resolve(code));
      reuse.on("error", () => {});
    });
    expect(reuseCode).toBe(4403);

    // Pre-upgrade consume is covered at unit level
    // (desktop-stream-gateway.test.ts): precheck consumes at upgrade-request
    // time, before any handshake bytes flow. Inline here it would exceed the
    // account cap filled above (8 siblings), so it lives there, not here.

    // Cross-account ticket theft: B's valid session cookie + A's unconsumed
    // ticket must NOT attach — the probe burns the ticket and B gets 4403,
    // then A's legitimate retry with the same ticket also fails.
    const victim = relay.runtime.desktop.reserve({ accountId: account.id, instanceId: "i-victim", ttlMs: 60_000 });
    expect(victim.ok).toBe(true);
    if (!victim.ok) return;
    const victimTicket = relay.runtime.desktop.ticketStore.mintTicket({
      streamId: victim.record.streamId, accountId: account.id, instanceId: "i-victim", side: "browser",
    });
    const attackerAccount = relay.runtime.accounts.createAccount("attacker");
    const { token: attackerLogin } = relay.runtime.accounts.createLoginToken(attackerAccount.id);
    const attackerLoginRes = await fetch(`${base}/api/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token: attackerLogin }),
    });
    const attackerCookie = attackerLoginRes.headers.get("set-cookie")?.split(";")[0] ?? "";
    expect(attackerCookie.length).toBeGreaterThan(0);
    const theft = new WebSocket(`ws://127.0.0.1:${relay.httpPort}/desktop/observe?ticket=${victimTicket.ticket}`, { headers: { cookie: attackerCookie } });
    trackSocket(sockets, theft);
    const theftCode = await new Promise<number>((resolve) => {
      theft.on("close", (code: number) => resolve(code));
      theft.on("error", () => {});
    });
    expect(theftCode).toBe(4403);
    const ownerRetry = new WebSocket(`ws://127.0.0.1:${relay.httpPort}/desktop/observe?ticket=${victimTicket.ticket}`, { headers: { cookie } });
    trackSocket(sockets, ownerRetry);
    const ownerRetryCode = await new Promise<number>((resolve) => {
      ownerRetry.on("close", (code: number) => resolve(code));
      ownerRetry.on("error", () => {});
    });
    expect(ownerRetryCode).toBe(4403);

    // Malformed percent-encoding must fail closed without throwing: the
    // connector plane is reachable without authentication, so `?ticket=%`
    // must reject as missing-ticket and leave the hub serving later requests.
    const { desktopTicketFromUrl } = await import("../../packages/relay/src/server");
    expect(() => desktopTicketFromUrl("/desktop/instance?ticket=%")).not.toThrow();
    expect(desktopTicketFromUrl("/desktop/instance?ticket=%")).toBeNull();
    expect(desktopTicketFromUrl(`/desktop/instance?ticket=${"x".repeat(129)}`)).toBeNull();
    const malformedRaw = await new Promise<{ status: number; alive: boolean }>((resolve) => {
      const sock = netConnect(relay.httpPort, "127.0.0.1", () => {
        // Raw HTTP upgrade with an undecodable ticket: no ws client would send
        // this (it would encode first), so hand-roll the bytes.
        sock.write(
          "GET /desktop/instance?ticket=% HTTP/1.1\r\n" +
          `Host: 127.0.0.1:${relay.httpPort}\r\n` +
          "Upgrade: websocket\r\n" +
          "Connection: Upgrade\r\n" +
          "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n" +
          "Sec-WebSocket-Version: 13\r\n\r\n",
        );
      });
      let buf = "";
      sock.on("close", async () => {
        // Hub must still serve afterwards: failed upgrade leaves no residue.
        // /api/version is auth-gated; any HTTP response (here 401) proves the
        // event loop survived the malformed upgrade (a throw would kill it).
        const res = await fetch(`${base}/api/version`).catch(() => null);
        resolve({ status: buf.includes("101") ? 101 : 0, alive: res !== null && res.status === 401 });
        sock.destroy();
      });
      setTimeout(() => { sock.destroy(); }, 5000).unref?.();
    });
    expect(malformedRaw.status).toBe(0);
    expect(malformedRaw.alive).toBe(true);
  } finally {
    for (const ws of sockets) {
      try { ws.close(); } catch { /* gone */ }
    }
    await new Promise((r) => setTimeout(r, 250));
    rfb?.close();
    await relay.close();
  }
}, 30000);
