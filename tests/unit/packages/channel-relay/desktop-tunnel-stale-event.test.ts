// Regression: a stale transport event from a CLOSED tunnel must not tear down the
// tunnel that replaced it.
//
// Sequence: A is active. Something closes A (hub cancel, control-socket drop, or a
// transport error), which clears `this.active` and starts tearing A's sockets
// down. The user reconnects and B publishes as the new `this.active`. Only THEN
// does one of A's transport listeners fire — `close`/`error` handshakes are
// asynchronous and on a loaded machine A's can land after B is already active.
//
// A's listeners were registered against `closeActive()`, which takes no argument
// and reads whatever `this.active` is at call time. They carried no identity, so
// the late event resolved to B and tore down a healthy replacement. The
// pending-stage generation fencing cannot cover this: these listeners attach
// after publish, on the tunnel itself.
//
// The hub sockets here are REAL (`ws` clients against a real upgrade server) so
// publication happens through the production path. Only the late-event delivery
// is arranged: the listeners A registered are captured off A's socket and fired
// once B is already active.

import net from "node:net";
import { createServer as createHttp } from "node:http";
import { WebSocket, WebSocketServer } from "ws";

import { expect, test } from "bun:test";

import { MSG } from "../../../../packages/relay-protocol/src/index";
import { DesktopTunnelRuntime } from "../../../../packages/channel-relay/src/desktop/desktop-tunnel-runtime";

const RFB = Buffer.from("RFB 003.008\n", "ascii");
const SEC = Buffer.from([1, 2]);

function preparePayload(streamId: string, ticket: string) {
  return { protocolVersion: 1, kind: "req", id: "h", type: MSG.desktopPrepare, payload: { streamId, ticket, expiresAt: Date.now() + 60_000 } };
}

function cancelPayload(streamId: string) {
  return { protocolVersion: 1, kind: "event", type: MSG.desktopCancel, payload: { streamId } };
}

interface Servers { rfbPort: number; hubPort: number; close(): void; rfbSockets: net.Socket[] }

async function startServers(): Promise<Servers> {
  const rfbSockets: net.Socket[] = [];
  const rfb = net.createServer((s) => {
    rfbSockets.push(s);
    s.on("error", () => {});
    s.write(RFB);
    s.on("data", (c) => { if (c.byteLength >= 12) s.write(SEC); });
  });
  await new Promise<void>((r) => rfb.listen(0, "127.0.0.1", () => r()));
  const rfbPort = (rfb.address() as { port: number }).port;

  const http = createHttp();
  const wss = new WebSocketServer({ noServer: true });
  http.on("upgrade", (req, socket, head) => {
    wss.handleUpgrade(req, socket, head, (ws) => {
      ws.on("message", () => {});
      ws.on("error", () => {});
    });
  });
  await new Promise<void>((r) => http.listen(0, "127.0.0.1", () => r()));
  const hubPort = (http.address() as { port: number }).port;
  return {
    rfbPort,
    hubPort,
    rfbSockets,
    close() { for (const s of rfbSockets) s.destroy(); wss.close(); http.close(); rfb.close(); },
  };
}

const cfg = (port: number, hubPort: number) => ({
  enabled: true,
  backend: "rfb" as const,
  port,
  connectTimeoutMs: 800,
  maxStreams: 1,
});

/** Every hub socket the runtime creates, in order. A is [0], B is [1]. */
function solver(servers: Servers) {
  const opened: WebSocket[] = [];
  const runtime = new DesktopTunnelRuntime({
    config: cfg(servers.rfbPort, servers.hubPort),
    hubUrl: `ws://127.0.0.1:${servers.hubPort}`,
    createSocket: (url, options) => {
      const socket = new WebSocket(url, options);
      opened.push(socket);
      return socket;
    },
  });
  return { runtime, opened };
}

async function publish(runtime: DesktopTunnelRuntime, streamId: string, ticket: string): Promise<unknown[]> {
  const replies: unknown[] = [];
  await runtime.handlePrepare(preparePayload(streamId, ticket) as never, (p) => replies.push(p));
  const deadline = Date.now() + 2000;
  while (runtime.activeStreamId !== streamId && Date.now() < deadline) await Bun.sleep(5);
  expect(runtime.activeStreamId).toBe(streamId);
  return replies;
}

test("a stale close from a closed tunnel cannot close its replacement", async () => {
  const servers = await startServers();
  const { runtime, opened } = solver(servers);

  expect(await publish(runtime, "s-A", "ticket-A")).toEqual([{ streamId: "s-A", security: "vnc-auth" }]);
  const aSocket = opened[0];
  const liveTcp = servers.rfbSockets.filter((s) => !s.destroyed).length;

  // Capture the close listeners A registered on its OWN socket before it closes.
  const aCloseListeners = aSocket.listeners("close");
  expect(aCloseListeners.length).toBeGreaterThan(0);

  // A is closed for a reason about A alone.
  expect(runtime.handleCancel(cancelPayload("s-A") as never)).toBe(true);
  expect(runtime.activeStreamId).toBeNull();

  // B publishes before A's event is delivered.
  expect(await publish(runtime, "s-B", "ticket-B")).toEqual([{ streamId: "s-B", security: "vnc-auth" }]);
  const bSocket = opened[1];
  expect(bSocket).not.toBe(aSocket);

  // A's late close lands. Before the fix this resolved to B and closed it.
  for (const l of aCloseListeners) l();

  expect(runtime.activeStreamId).toBe("s-B");
  expect(bSocket.readyState).toBe(WebSocket.OPEN);
  expect(servers.rfbSockets.filter((s) => !s.destroyed).length).toBe(liveTcp);

  servers.close();
  runtime.closeAll("test-done");
});

test("the same listener still tears down the tunnel that is still active", async () => {
  // The guard must not be a blanket no-op: a close from the CURRENT tunnel has
  // to work, or a dead peer holds the single-viewer slot forever.
  const servers = await startServers();
  const { runtime, opened } = solver(servers);
  await publish(runtime, "s-1", "ticket-1");
  const socket = opened[0];
  // The tunnel is still active, so its listener must still perform the close.
  socket.close();
  await Bun.sleep(20);
  expect(runtime.activeStreamId).toBeNull();

  servers.close();
  runtime.closeAll("test-done");
});
