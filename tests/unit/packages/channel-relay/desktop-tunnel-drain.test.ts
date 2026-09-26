// Drain-listener lifecycle for the connector's hub → loopback forwarding.
//
// The tunnel must register `tcp.once("drain", …)` ONLY when write() reports
// backpressure. Attaching one per frame leaks on a healthy link (write() keeps
// returning true, so no drain ever fires to consume them) and eventually trips
// MaxListenersExceededWarning while pinning the closures.
//
// This file drives the real openTunnel() with a fake TCP socket and a fake hub
// WebSocket, so the backpressure is deterministic instead of depending on
// filling a kernel send buffer.
import { expect, test, mock, beforeEach } from "bun:test";
import { EventEmitter } from "node:events";
import { Buffer } from "node:buffer";

const tcpSeam: { current: FakeTcp | null } = { current: null };

/** Minimal net.Socket stand-in: records writes, and reports backpressure on demand. */
class FakeTcp extends EventEmitter {
  writes: Buffer[] = [];
  paused = false;
  resumedTimes = 0;
  backpressure = false;
  destroyed = false;
  /** Server-side RFB role: answers the client version with the security types. */
  private greeted = false;
  /** Banner not yet consumed by the tunnel's re-read (the probe took its own). */
  private bannerPending = true;

  constructor() {
    super();
    // A real RFB server greets with the 12-byte ProtocolVersion banner as soon
    // as the connection is accepted.
    setImmediate(() => {
      if (this.destroyed) return;
      this.emit("data", Buffer.from(RFB_BANNER));
    });
  }

  write(chunk: unknown, ...rest: unknown[]): boolean {
    this.writes.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array));
    for (const arg of rest) {
      if (typeof arg === "function") (arg as () => void)();
    }
    // The client's 12-byte ProtocolVersion is the request for security types.
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
    if (!this.greeted && buf.length === 12 && buf.subarray(0, 3).toString("latin1") === "RFB") {
      this.greeted = true;
      // u8 count + the single VncAuth(2) type.
      setImmediate(() => {
        if (this.destroyed) return;
        this.emit("data", Buffer.from(Uint8Array.from([1, 2])));
      });
    }
    return !this.backpressure;
  }

  pause(): void { this.paused = true; }
  resume(): void {
    // The tunnel pauses the socket before its banner re-read and resumes it
    // afterwards. A real server has already sent the banner by then, so deliver
    // it here (once) — before the pause it was too early for the reader.
    this.paused = false;
    this.resumedTimes += 1;
    if (this.bannerPending) {
      this.bannerPending = false;
      setImmediate(() => {
        if (this.destroyed) return;
        this.emit("data", Buffer.from(RFB_BANNER));
      });
    }
  }
  destroy(): void { this.destroyed = true; this.emit("close"); }

  drainListenerCount(): number {
    return this.listenerCount("drain");
  }
}

/** Minimal ws stand-in that exposes the message handler for direct driving. */
class FakeHubSocket extends EventEmitter {
  static OPEN = 1;
  readyState = 1;
  sent: unknown[] = [];
  paused = false;
  bufferedAmount = 0;

  constructor(public url: string) { super(); }

  send(data: unknown): void { this.sent.push(data); }
  pause(): void { this.paused = true; }
  resume(): void { this.paused = false; }
  close(): void { /* no-op */ }

  /** Simulate a hub frame arriving at the tunnel's binary socket. */
  deliverFrame(data: Uint8Array, isBinary = true): void {
    // A real ws client stops emitting 'message' once pause() is called, so a
    // backpressured tunnel is not handed another frame until it resumes.
    if (this.paused) return;
    this.emit("message", Buffer.isBuffer(data) ? data : Buffer.from(data), isBinary);
  }
  deliverOpen(): void { this.emit("open"); }
}

// Replace `net.createConnection` BEFORE the runtime module is imported, so
// openTunnel() dials our fake socket instead of a real loopback port.
mock.module("node:net", () => {
  const actual = require("node:net") as typeof import("node:net") & { default?: unknown };
  const patched = {
    ...actual,
    createConnection: (opts: { host?: string; port?: number }) => {
      const tcp = new FakeTcp();
      tcpSeam.current = tcp;
      // Let the runtime's `connect` wait settle on the next tick.
      setImmediate(() => tcp.emit("connect"));
      return tcp as unknown as import("node:net").Socket;
    },
  };
  // `import net from "node:net"` resolves the default export; a spread of the
  // namespace does not carry it, so the probe would keep using the real module.
  return { ...patched, default: patched };
});

const { DesktopTunnelRuntime } = await import(
  "../../../../packages/channel-relay/src/desktop/desktop-tunnel-runtime"
);
const { MSG } = await import("../../../../packages/relay-protocol/src/index");

const RFB_BANNER = Buffer.from(Uint8Array.from([82, 70, 66, 32, 48, 48, 51, 46, 48, 48, 56, 10]));

/** Drive the tunnel into the forwarding phase and return its fake sockets. */
async function openTunnel(streamId: string): Promise<{ tcp: FakeTcp; hub: FakeHubSocket }> {
  const hub = new FakeHubSocket("ws://hub/desktop/instance?ticket=t");
  const runtime = new DesktopTunnelRuntime({
    config: { enabled: true, backend: "rfb", port: 5900, connectTimeoutMs: 2000, maxStreams: 1 },
    hubUrl: "ws://hub:8787",
    createSocket: (url, options) => {
      // The parser-level maxPayload gate must reach the ws client.
      expect(options.maxPayload).toBe(1024 * 1024);
      setImmediate(() => hub.deliverOpen());
      return hub as unknown as WebSocket;
    },
  });
  let prepared: unknown;
  await runtime.handlePrepare(
    {
      protocolVersion: 1,
      kind: "req",
      id: "hub-1",
      type: MSG.desktopPrepare,
      payload: { streamId, ticket: "t", expiresAt: Date.now() + 60_000 },
    },
    (p) => { prepared = p; },
  );
  expect(prepared).toMatchObject({ streamId, security: "vnc-auth" });
  const tcp = tcpSeam.current;
  if (!tcp) throw new Error("no fake TCP socket was created");
  // The banner the runtime pre-read is replayed UPSTREAM to the hub socket so
  // noVNC sees it; it is never written back to the RFB server.
  expect(hub.sent.some((d) => Buffer.isBuffer(d) && d.subarray(0, 12).equals(RFB_BANNER))).toBe(true);
  return { tcp, hub };
}

beforeEach(() => {
  tcpSeam.current = null;
});

test("no drain listener is registered for frames that do not apply backpressure", async () => {
  const { tcp, hub } = await openTunnel("s-drain-healthy");
  const before = tcp.drainListenerCount();
  expect(before).toBe(0);

  // 200 healthy frames: write() returns true every time.
  for (let i = 0; i < 200; i++) hub.deliverFrame(Buffer.from([5, 1, 0, 3, i]));
  expect(tcp.writes.length).toBe(200);
  expect(tcp.drainListenerCount()).toBe(0);
  expect(tcp.paused).toBe(false);
});

test("exactly one drain listener per backpressure episode, detached on drain", async () => {
  const { tcp, hub } = await openTunnel("s-drain-bp");
  expect(tcp.drainListenerCount()).toBe(0);

  // One backpressured write: exactly one listener, and the upstream pauses.
  tcp.backpressure = true;
  hub.deliverFrame(Buffer.from([5, 1, 0, 3, 9]));
  expect(tcp.drainListenerCount()).toBe(1);
  expect(hub.paused).toBe(true);

  // Drain: the listener detaches and the upstream resumes.
  tcp.backpressure = false;
  tcp.emit("drain");
  expect(tcp.drainListenerCount()).toBe(0);
  expect(hub.paused).toBe(false);

  // A second episode gets its own single listener — no accumulation.
  tcp.backpressure = true;
  hub.deliverFrame(Buffer.from([5, 1, 0, 3, 10]));
  expect(tcp.drainListenerCount()).toBe(1);
  tcp.backpressure = false;
  tcp.emit("drain");
  expect(tcp.drainListenerCount()).toBe(0);
});

test("a listener in flight does not accumulate across a frame burst", async () => {
  const { tcp, hub } = await openTunnel("s-drain-burst");
  tcp.backpressure = true;
  // Many backpressured frames in a row: the FIRST creates the listener, and
  // subsequent ones must not stack more (the ws socket is paused, so in
  // production they would not even be read).
  for (let i = 0; i < 50; i++) hub.deliverFrame(Buffer.from([5, 1, 0, 3, i]));
  expect(tcp.drainListenerCount()).toBe(1);
  tcp.backpressure = false;
  tcp.emit("drain");
  expect(tcp.drainListenerCount()).toBe(0);
});
