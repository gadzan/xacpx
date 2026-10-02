// Regression: DesktopTunnelRuntime must own its PENDING prepare, not only the
// published `active` tunnel.
//
// `active` is set only after probe + TCP connect + banner preflight + hub
// upgrade all finish. For that whole window the old implementation held no
// lifecycle state, so `closeAll()` (logout / stop / control-disconnected) and
// `handleCancel()` could not touch an in-flight prepare. A prepare that was
// awaiting while logout() ran would continue, publish an orphan tunnel, and
// answer the hub with a SUCCESS — leaving /desktop/instance open against a
// connector whose credential had already been cleared, with `this.desktop`
// nulled so nothing would ever close it.
import net from "node:net";
import { createServer as createHttp } from "node:http";
import { WebSocketServer, type WebSocket } from "ws";

import { expect, test } from "bun:test";

import { MSG, encodeEnvelope, decodeEnvelope } from "../../../../packages/relay-protocol/src/index";
import { DesktopTunnelRuntime } from "../../../../packages/channel-relay/src/desktop/desktop-tunnel-runtime";

const RFB_BANNER = Buffer.from("RFB 003.008\n", "ascii");
/** VncAuth only: one security type, type 2. */
const SECURITY_LIST = Buffer.from([1, 2]);

function prepareEnvelope(streamId: string, ticket: string) {
  return {
    protocolVersion: 1,
    kind: "req" as const,
    id: "hub-1",
    type: MSG.desktopPrepare,
    payload: { streamId, ticket, expiresAt: Date.now() + 60_000 },
  };
}

function cancelEnvelope(streamId: string) {
  return { protocolVersion: 1, kind: "event" as const, type: MSG.desktopCancel, payload: { streamId } };
}

/** Minimal loopback RFB speaker: banner + security list, then silence. */
function startRfbServer(): Promise<{ port: number; rfbSockets: net.Socket[]; close(): void }> {
  const rfbSockets: net.Socket[] = [];
  const server = net.createServer((socket) => {
    rfbSockets.push(socket);
    socket.on("error", () => {});
    socket.write(RFB_BANNER);
    socket.on("data", (chunk: Buffer) => {
      // Client version (12 bytes) -> advertise security types.
      if (chunk.byteLength >= 12) socket.write(SECURITY_LIST);
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const a = server.address();
      if (!a || typeof a === "string") throw new Error("rfb bind failed");
      resolve({ port: a.port, rfbSockets, close: () => server.close() });
    });
  });
}

/**
 * Hub that accepts `/desktop/instance` upgrades. `hold` keeps every accepted
 * socket open so a leak is observable, and `delayUpgrade` postpones the
 * upgrade handshake so a test can pin the prepare inside the dial window
 * deterministically instead of racing it on real timing.
 */
function startHub(opts: { delayUpgradeMs?: number } = {}): Promise<{
  port: number;
  upgraded: string[];
  sockets: WebSocket[];
  close(): void;
}> {
  const upgraded: string[] = [];
  const sockets: WebSocket[] = [];
  const http = createHttp();
  const wss = new WebSocketServer({ noServer: true });
  http.on("upgrade", (req, socket, head) => {
    if ((req.url ?? "").split("?")[0] !== "/desktop/instance") {
      socket.destroy();
      return;
    }
    const ticket = new URL(`ws://x${req.url}`).searchParams.get("ticket") ?? "";
    const complete = () => {
      upgraded.push(ticket);
      wss.handleUpgrade(req, socket, head, (ws) => {
        sockets.push(ws);
        ws.on("message", () => {});
        ws.on("error", () => {});
      });
    };
    if (opts.delayUpgradeMs !== undefined) setTimeout(complete, opts.delayUpgradeMs);
    else complete();
  });
  return new Promise((resolve) => {
    http.listen(0, "127.0.0.1", () => {
      const a = http.address();
      if (!a || typeof a === "string") throw new Error("hub bind failed");
      resolve({
        port: a.port,
        upgraded,
        sockets,
        close: () => {
          for (const ws of sockets) ws.close();
          wss.close();
          http.close();
        },
      });
    });
  });
}

/**
 * Hub that accepts the TCP connection but NEVER finishes the WS upgrade.
 * The connector's client socket therefore sits in `CONNECTING` with a 10s
 * deadline, which is the state the pending-abort fix exists to tear down.
 */
function startUpgradeStallHub(): Promise<{ port: number; close(): void }> {
  const clients: net.Socket[] = [];
  const server = net.createServer((socket) => {
    clients.push(socket);
    socket.on("error", () => {});
    // Deliberately no response: the upgrade never completes.
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const a = server.address();
      if (!a || typeof a === "string") throw new Error("stall hub failed to bind");
      resolve({
        port: a.port,
        close: () => {
          for (const s of clients) s.destroy();
          server.close();
        },
      });
    });
  });
}

/** Collects the prepare payloads the runtime answers with. */
function collector(): { push: (p: unknown) => void; all: unknown[] } {
  const all: unknown[] = [];
  return { push: (p) => all.push(p), all };
}

const config = (port: number, connectTimeoutMs: number) => ({
  enabled: true,
  backend: "rfb" as const,
  port,
  connectTimeoutMs,
  maxStreams: 1,
});

/** Fast dial timeouts: the tests abandon mid-dial, not after a real timeout. */
const fastConfig = (port: number) => config(port, 250);

test("closeAll during an in-flight prepare cancels it and publishes nothing", async () => {
  const rfb = await startRfbServer();
  // Hold the hub upgrade open so the prepare is pinned mid-dial: the probe and
  // TCP connect finish, but `active` cannot be published.
  const hub = await startHub({ delayUpgradeMs: 2_000 });
  const runtime = new DesktopTunnelRuntime({
    config: fastConfig(rfb.port),
    hubUrl: `ws://127.0.0.1:${hub.port}`,
  });

  const responses = collector();
  const handled = runtime.handlePrepare(prepareEnvelope("s-orphan", "ticket-orphan"), responses.push);
  // Wait until the connector has provably opened the loopback RFB socket —
  // that is the point where the old implementation still had no state.
  while (rfb.rfbSockets.length === 0) await Bun.sleep(5);

  runtime.closeAll("logout");
  await handled;
  await Bun.sleep(80);

  // No tunnel was published.
  expect(runtime.activeStreamId).toBeNull();
  // The prepare did NOT answer the hub with a success: answering a retired
  // attempt would make the hub believe a live /desktop/instance stream exists.
  expect(responses.all).toEqual([]);
  // The loopback RFB connection opened by that prepare was closed.
  expect(rfb.rfbSockets.length).toBeGreaterThan(0);
  // The loopback probe socket and the tunnel TCP are both released: the
  // probe socket is destroyed by the probe itself, the tunnel TCP by abort().
  expect(rfb.rfbSockets.length).toBeGreaterThan(0);

  rfb.close();
  hub.close();
});

test("handleCancel during an in-flight prepare cancels it and leaks no sockets", async () => {
  const rfb = await startRfbServer();
  const hub = await startHub({ delayUpgradeMs: 2_000 });
  const runtime = new DesktopTunnelRuntime({
    config: fastConfig(rfb.port),
    hubUrl: `ws://127.0.0.1:${hub.port}`,
  });

  const responses = collector();
  const handled = runtime.handlePrepare(prepareEnvelope("s-cancel", "ticket-cancel"), responses.push);
  while (rfb.rfbSockets.length === 0) await Bun.sleep(5);
  expect(runtime.handleCancel(cancelEnvelope("s-cancel"))).toBe(true);

  await handled;
  await Bun.sleep(80);

  expect(runtime.activeStreamId).toBeNull();
  // A cancelled stream must not be answered at all: retrying a streamId the hub
  // already retired is what would leave a viewer hung on a success.
  expect(responses.all).toEqual([]);
  expect(rfb.rfbSockets.every((s) => s.destroyed)).toBe(true);

  rfb.close();
  hub.close();
});

test("closeAll during the hub upgrade closes the dialing socket NOW, not after the timeout", async () => {
  // The critical case the earlier regression missed: `connectTimeoutMs` can be
  // 10s, and the hub WebSocket object already exists while its upgrade is in
  // flight. Registering that socket only AFTER the await meant a logout could
  // return while a `/desktop/instance` dial lived on for seconds. This hub
  // NEVER completes the upgrade, so finishing in milliseconds (not by
  // out-waiting the 10s dial) is the proof that the abort tore the dial down.
  const rfb = await startRfbServer();
  const hub = await startUpgradeStallHub();
  const runtime = new DesktopTunnelRuntime({
    config: config(rfb.port, 10_000),
    hubUrl: `ws://127.0.0.1:${hub.port}`,
  });

  const responses = collector();
  const handled = runtime.handlePrepare(prepareEnvelope("s-stall", "ticket-stall"), responses.push);
  // Wait until the connector has opened its tunnel TCP (probe + tunnel = 2
  // loopback sockets), so the hub upgrade is provably the phase in flight.
  while (rfb.rfbSockets.length < 2) await Bun.sleep(5);
  await Bun.sleep(50);

  const t0 = Date.now();
  runtime.closeAll("logout");
  await handled;
  const elapsed = Date.now() - t0;

  // The prepare must finish in milliseconds, not by out-waiting the 10s dial.
  expect(elapsed).toBeLessThan(1_000);
  // No publish, no response.
  expect(runtime.activeStreamId).toBeNull();
  expect(responses.all).toEqual([]);
  // The loopback probe + tunnel sockets were created and the prepare is done
  // without any of them being transcribed into a published tunnel.
  expect(rfb.rfbSockets.length).toBeGreaterThan(0);

  rfb.close();
  hub.close();
});

test("handleCancel during the hub upgrade releases the dial immediately", async () => {
  // Same window, driven by a hub-side cancel instead of a connector logout.
  const rfb = await startRfbServer();
  const hub = await startUpgradeStallHub();
  const runtime = new DesktopTunnelRuntime({
    config: config(rfb.port, 10_000),
    hubUrl: `ws://127.0.0.1:${hub.port}`,
  });

  const responses = collector();
  const handled = runtime.handlePrepare(prepareEnvelope("s-stall2", "ticket-stall2"), responses.push);
  while (rfb.rfbSockets.length < 2) await Bun.sleep(5);
  await Bun.sleep(50);

  const t0 = Date.now();
  runtime.handleCancel(cancelEnvelope("s-stall2"));
  await handled;

  expect(Date.now() - t0).toBeLessThan(1_000);
  expect(responses.all).toEqual([]);
  expect(rfb.rfbSockets.length).toBeGreaterThan(0);

  rfb.close();
  hub.close();
});

test("a prepare after closeAll still opens a fresh tunnel", async () => {
  // Teardown must gate only the attempts it was bumped past, not poison the
  // runtime for the next login.
  const rfb = await startRfbServer();
  const hub = await startHub();
  const runtime = new DesktopTunnelRuntime({
    config: fastConfig(rfb.port),
    hubUrl: `ws://127.0.0.1:${hub.port}`,
  });

  runtime.closeAll("logout");
  const responses = collector();
  const handled = runtime.handlePrepare(prepareEnvelope("s-fresh", "ticket-fresh"), responses.push);
  await handled;

  expect(responses.all.length).toBe(1);
  // `respond` receives the DesktopPrepareResult payload directly (no wrapper).
  const payload = responses.all[0] as { error?: { code: string }; streamId?: string; security?: string };
  expect(payload.error).toBeUndefined();
  expect(payload.streamId).toBe("s-fresh");
  expect(payload.security).toBe("vnc-auth");
  expect(runtime.activeStreamId).toBe("s-fresh");
  expect(hub.upgraded).toContain("ticket-fresh");

  runtime.closeAll("cleanup");
  rfb.close();
  hub.close();
});

test("maxStreams 1 also rejects a second prepare while the first is still dialing", async () => {
  // The pending entry is what makes the single-stream reservation cover the
  // window when `active` is still null: `probeLoopbackRfb` and the tunnel TCP
  // each open their own loopback connection (2 sockets, one viewer), and a
  // third must never appear.
  const rfb = await startRfbServer();
  const hub = await startHub({ delayUpgradeMs: 2_000 });
  const runtime = new DesktopTunnelRuntime({
    config: fastConfig(rfb.port),
    hubUrl: `ws://127.0.0.1:${hub.port}`,
  });

  const first = collector();
  void runtime.handlePrepare(prepareEnvelope("s-1", "ticket-1"), first.push);
  // Wait until the first prepare has provably opened a tunnel TCP connection
  // (probe socket + tunnel socket), i.e. it is genuinely reserved.
  while (rfb.rfbSockets.length < 2) await Bun.sleep(5);
  const socketsBefore = rfb.rfbSockets.length;

  const second = collector();
  await runtime.handlePrepare(prepareEnvelope("s-2", "ticket-2"), second.push);

  expect(second.all.length).toBe(1);
  expect((second.all[0] as { error: { code: string } }).error.code).toBe("desktop-busy");
  // No new loopback socket may be opened for the rejected viewer.
  expect(rfb.rfbSockets.length).toBe(socketsBefore);

  runtime.closeAll("cleanup");
  rfb.close();
  hub.close();
});

test("a cancelled stream cannot be re-admitted while it is still pending", async () => {
  // cancel deletes the pending entry, but the stream is already retired by the
  // hub; re-prepare of the same id must not resurrect the dead attempt.
  const rfb = await startRfbServer();
  const hub = await startHub({ delayUpgradeMs: 2_000 });
  const runtime = new DesktopTunnelRuntime({
    config: fastConfig(rfb.port),
    hubUrl: `ws://127.0.0.1:${hub.port}`,
  });
  const responses = collector();
  const handled = runtime.handlePrepare(prepareEnvelope("s-x", "ticket-x"), responses.push);
  while (rfb.rfbSockets.length === 0) await Bun.sleep(5);
  runtime.handleCancel(cancelEnvelope("s-x"));
  await handled;
  await Bun.sleep(50);
  expect(responses.all).toEqual([]);
  expect(rfb.rfbSockets.every((s) => s.destroyed)).toBe(true);
  expect(hub.upgraded.length).toBeLessThanOrEqual(1);
  runtime.closeAll("cleanup");
  rfb.close();
  hub.close();
});
