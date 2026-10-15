// Connector desktop forwarding: loopback latency (setNoDelay), backpressure
// pause/resume, and the opt-in stats line.
//
// Drives the REAL openTunnel() with a fake TCP socket and a fake hub WebSocket,
// so the ws `send` callback, the `drain` listener and the fallback timer are
// deterministic instead of depending on kernel buffer sizes.
import { expect, test, mock, beforeEach } from "bun:test";
import { EventEmitter } from "node:events";
import { Buffer } from "node:buffer";

const tcpSeam: { current: FakeTcp | null } = { current: null };

/** Minimal net.Socket stand-in: records writes, noDelay, pauses and destroys. */
class FakeTcp extends EventEmitter {
  writes: Buffer[] = [];
  paused = false;
  resumedTimes = 0;
  backpressure = false;
  destroyed = false;
  noDelay: boolean | null = null;
  /** Resolvers parked by `waitForResume()`, fired by the next `resume()`. */
  private resumeWaiters: Array<() => void> = [];
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

  setNoDelay(enable?: boolean): this {
    this.noDelay = enable !== false;
    return this;
  }

  write(chunk: unknown, ...rest: unknown[]): boolean {
    this.writes.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array));
    for (const arg of rest) {
      if (typeof arg === "function") (arg as () => void)();
    }
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
    if (!this.greeted && buf.length === 12 && buf.subarray(0, 3).toString("latin1") === "RFB") {
      this.greeted = true;
      setImmediate(() => {
        if (this.destroyed) return;
        this.emit("data", Buffer.from(Uint8Array.from([1, 2])));
      });
    }
    return !this.backpressure;
  }

  pause(): void { this.paused = true; }
  resume(): void {
    this.paused = false;
    this.resumedTimes += 1;
    for (const waiter of this.resumeWaiters.splice(0)) waiter();
    if (this.bannerPending) {
      this.bannerPending = false;
      setImmediate(() => {
        if (this.destroyed) return;
        this.emit("data", Buffer.from(RFB_BANNER));
      });
    }
  }
  /** Resolves on the NEXT resume: lets a test await the real production signal. */
  waitForResume(): Promise<"resumed"> {
    return new Promise<"resumed">((resolve) => { this.resumeWaiters.push(() => resolve("resumed")); });
  }
  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.emit("close");
  }
}

/** Minimal ws stand-in: exposes the message handler and the send callbacks. */
class FakeHubSocket extends EventEmitter {
  static OPEN = 1;
  readyState = 1;
  sent: unknown[] = [];
  paused = false;
  bufferedAmount = 0;
  /** Callbacks handed to `send(data, opts, cb)` and not yet fired. */
  sendCallbacks: Array<() => void> = [];

  constructor(public url: string) { super(); }

  send(data: unknown, ...rest: unknown[]): void {
    this.sent.push(data);
    for (const arg of rest) {
      if (typeof arg === "function") this.sendCallbacks.push(arg as () => void);
    }
  }
  pause(): void { this.paused = true; }
  resume(): void { this.paused = false; }
  close(): void { this.readyState = 3; }

  /** Simulate the socket writing the queued frames out (ws `send` callbacks). */
  flushWriteCallbacks(): void {
    const pending = this.sendCallbacks;
    this.sendCallbacks = [];
    for (const cb of pending) cb();
  }

  /** Simulate a hub frame arriving at the tunnel's binary socket. */
  deliverFrame(data: Uint8Array, isBinary = true): void {
    if (this.paused) return;
    this.emit("message", Buffer.isBuffer(data) ? data : Buffer.from(data), isBinary);
  }
  deliverOpen(): void { this.emit("open"); }
}

mock.module("node:net", () => {
  const actual = require("node:net") as typeof import("node:net") & { default?: unknown };
  const patched = {
    ...actual,
    createConnection: (opts: { host?: string; port?: number }) => {
      const tcp = new FakeTcp();
      tcpSeam.current = tcp;
      setImmediate(() => tcp.emit("connect"));
      return tcp as unknown as import("node:net").Socket;
    },
  };
  return { ...patched, default: patched };
});

// Static import is impossible here: the runtime module must be loaded AFTER
// `mock.module("node:net")` patches createConnection, or openTunnel() dials a
// real loopback port instead of the fake socket above.
const { DesktopTunnelRuntime } = await import(
  "../../../../packages/channel-relay/src/desktop/desktop-tunnel-runtime"
);
// Loaded AFTER mock.module below, like the drain test does: the shared
// relay-protocol module must not be in the registry before the net mock lands.
const { DESKTOP_BUFFERED_HARD_CLOSE_BYTES, DESKTOP_BUFFERED_SOFT_PAUSE_BYTES, MSG } = await import(
  "../../../../packages/relay-protocol/src/index"
);

const RFB_BANNER = Buffer.from("RFB 003.008\n", "latin1");
/** Distinctive single-use ticket: the stats line must never echo it. */
const TEST_TICKET = "TICKET-SECRET-91c2";

interface RecordedLog { event: string; context: Record<string, unknown> }

/** The runtime's optional channel logger surface, narrowed to what it uses. */
type TunnelLogger = {
  info?(event: string, message: string, context?: Record<string, unknown>): void;
  warn?(event: string, message: string, context?: Record<string, unknown>): void;
  error(event: string, message: string, context?: Record<string, unknown>): void;
};

function recordingLogger(): { logs: RecordedLog[]; logger: TunnelLogger } {
  const logs: RecordedLog[] = [];
  return {
    logs,
    logger: {
      info: (event, _message, context) => { logs.push({ event, context: context ?? {} }); },
      warn: (event, _message, context) => { logs.push({ event, context: context ?? {} }); },
      error: (event, _message, context) => { logs.push({ event, context: context ?? {} }); },
    },
  };
}

interface OpenOptions {
  diagnostics?: boolean;
  logger?: TunnelLogger;
  /** Pre-created hub socket double; when absent a fresh one is created. */
  hub?: FakeHubSocket;
}

function makeRuntime(options: OpenOptions = {}): DesktopTunnelRuntime {
  const hub = options.hub;
  return new DesktopTunnelRuntime({
    config: {
      enabled: true,
      backend: "rfb",
      port: 5900,
      connectTimeoutMs: 2000,
      maxStreams: 1,
      diagnostics: options.diagnostics === true,
    },
    hubUrl: "ws://hub:8787",
    createSocket: (url, socketOptions) => {
      // The parser-level maxPayload gate must reach the ws client.
      expect(socketOptions.maxPayload).toBe(1024 * 1024);
      const socket = hub ?? new FakeHubSocket(url);
      setImmediate(() => socket.deliverOpen());
      return socket as unknown as WebSocket;
    },
    ...(options.logger ? { logger: options.logger } : {}),
  });
}

/** Drive the tunnel into the forwarding phase and return its fake sockets. */
async function openTunnel(
  streamId: string,
  options: OpenOptions = {},
): Promise<{ tcp: FakeTcp; hub: FakeHubSocket; runtime: DesktopTunnelRuntime; resumesBefore: number }> {
  const hub = options.hub ?? new FakeHubSocket(`ws://hub/desktop/instance?ticket=${TEST_TICKET}`);
  const runtime = makeRuntime({ ...options, hub });
  let prepared: unknown;
  await runtime.handlePrepare(
    {
      protocolVersion: 1,
      kind: "req",
      id: "hub-1",
      type: MSG.desktopPrepare,
      payload: { streamId, ticket: TEST_TICKET, expiresAt: Date.now() + 60_000 },
    },
    (p) => { prepared = p; },
  );
  expect(prepared).toMatchObject({ streamId, security: "vnc-auth" });
  const tcp = tcpSeam.current;
  if (!tcp) throw new Error("no fake TCP socket was created");
  expect(hub.sent.some((d) => Buffer.isBuffer(d) && d.subarray(0, 12).equals(RFB_BANNER))).toBe(true);
  // The banner replay already handed `send` a callback; consume it so each test
  // starts from an empty pending-callback set.
  hub.flushWriteCallbacks();
  // The banner preflight and its replay resume the socket twice; tests assert
  // on the DELTA from here.
  const resumesBefore = tcp.resumedTimes;
  return { tcp, hub, runtime, resumesBefore };
}

beforeEach(() => {
  tcpSeam.current = null;
});

test("the loopback RFB socket gets setNoDelay(true) once the tunnel is up", async () => {
  const { tcp } = await openTunnel("s-nodelay");
  // Node's net default is Nagle ON; a small key/pointer event would otherwise
  // wait for an ACK. The ws side already does this itself (ws 8 setSocket).
  expect(tcp.noDelay).toBe(true);
});

test("TCP pauses on ws backpressure and resumes from the ws send callback", async () => {
  const { tcp, hub, resumesBefore } = await openTunnel("s-bp-callback");
  hub.bufferedAmount = DESKTOP_BUFFERED_SOFT_PAUSE_BYTES + 1;

  tcp.emit("data", Buffer.from(Uint8Array.from([1, 2, 3, 4])));
  expect(tcp.paused).toBe(true);
  expect(hub.sendCallbacks.length).toBe(1);

  // The ws wrote the chunk out: bufferedAmount is back under the watermark.
  hub.bufferedAmount = 0;
  hub.flushWriteCallbacks();
  expect(tcp.paused).toBe(false);
  expect(tcp.resumedTimes).toBe(resumesBefore + 1);
});

/**
 * Let any stray timer/callback run, then report whether a resume happened.
 *
 * A genuine delay is unavoidable here: the production fallback is a real 50ms
 * unref'd `setTimeout`, and Bun's fake timers also freeze `setImmediate`, which
 * the tunnel's async open path depends on. The wait is a NEGATIVE guard (nothing
 * should happen), never the awaited condition.
 */
async function settleQuietly(signal: Promise<"resumed">, ms = 120): Promise<"resumed" | "quiet"> {
  return await Promise.race([signal, Bun.sleep(ms).then(() => "quiet" as const)]);
}

test("the fallback timer resumes a ws that drains without another send", async () => {
  const { tcp, hub, resumesBefore } = await openTunnel("s-bp-timer");
  hub.bufferedAmount = DESKTOP_BUFFERED_SOFT_PAUSE_BYTES + 1;
  tcp.emit("data", Buffer.from(Uint8Array.from([1, 2, 3, 4])));
  expect(tcp.paused).toBe(true);

  // No send callback fires (nothing else is queued); only the bounded fallback
  // check can resume, so await the real resume instead of guessing a duration.
  hub.bufferedAmount = 0;
  expect(await tcp.waitForResume()).toBe("resumed");
  expect(tcp.paused).toBe(false);
  expect(tcp.resumedTimes).toBe(resumesBefore + 1);
});

test("only one resume cycle is armed while the ws stays saturated", async () => {
  const { tcp, hub, resumesBefore } = await openTunnel("s-bp-single");
  hub.bufferedAmount = DESKTOP_BUFFERED_SOFT_PAUSE_BYTES + 1;
  tcp.emit("data", Buffer.from(Uint8Array.from([1, 2, 3, 4])));
  expect(tcp.paused).toBe(true);

  // Frames keep arriving while paused; each re-checks the watermark and must NOT
  // stack another cycle.
  for (let i = 0; i < 5; i++) {
    tcp.emit("data", Buffer.from(Uint8Array.from([9, 9, 9, 9])));
    hub.flushWriteCallbacks();
  }
  expect(hub.sendCallbacks.length).toBe(0);

  // The socket finally drains: exactly one resume, and the cycle is finished —
  // a drained socket must not re-pause on the next frame.
  hub.bufferedAmount = 0;
  tcp.emit("data", Buffer.from(Uint8Array.from([7, 7, 7, 7])));
  hub.flushWriteCallbacks();
  expect(tcp.paused).toBe(false);
  expect(tcp.resumedTimes).toBe(resumesBefore + 1);

  tcp.emit("data", Buffer.from(Uint8Array.from([8, 8, 8, 8])));
  expect(tcp.paused).toBe(false);
  expect(tcp.resumedTimes).toBe(resumesBefore + 1);
});

test("nothing resumes and no listener survives the tunnel close", async () => {
  const { tcp, hub, runtime, resumesBefore } = await openTunnel("s-bp-close");
  hub.bufferedAmount = DESKTOP_BUFFERED_SOFT_PAUSE_BYTES + 1;
  tcp.emit("data", Buffer.from(Uint8Array.from([1, 2, 3, 4])));
  expect(tcp.paused).toBe(true);
  const resumed = tcp.waitForResume();

  runtime.closeAll();
  expect(tcp.destroyed).toBe(true);

  // A late write callback and the fallback timer must not resurrect the pause
  // cycle, and the armed drain listener must be gone.
  hub.bufferedAmount = 0;
  hub.flushWriteCallbacks();
  expect(await settleQuietly(resumed)).toBe("quiet");
  expect(tcp.resumedTimes).toBe(resumesBefore);
  expect(tcp.listenerCount("drain")).toBe(0);
  expect(tcp.listenerCount("data")).toBe(0);
});

test("the hard cap still destroys the loopback socket", async () => {
  const { tcp, hub } = await openTunnel("s-hard-close");
  hub.bufferedAmount = DESKTOP_BUFFERED_HARD_CLOSE_BYTES + 1;
  tcp.emit("data", Buffer.from(Uint8Array.from([1, 2, 3, 4])));
  expect(tcp.destroyed).toBe(true);
  expect(tcp.paused).toBe(false);
});

test("ws backpressure on tcp.write arms exactly one drain listener, cleared on close", async () => {
  const { tcp, hub, runtime } = await openTunnel("s-drain-single");
  expect(tcp.listenerCount("drain")).toBe(0);

  tcp.backpressure = true;
  hub.deliverFrame(Buffer.from([5, 1, 0, 3, 9]));
  expect(tcp.listenerCount("drain")).toBe(1);
  expect(hub.paused).toBe(true);
  // A second backpressured frame while the ws is paused adds nothing.
  hub.deliverFrame(Buffer.from([5, 1, 0, 3, 10]));
  expect(tcp.listenerCount("drain")).toBe(1);

  runtime.closeAll();
  expect(tcp.listenerCount("drain")).toBe(0);
});

test("diagnostics off (default) logs no stats line", async () => {
  const { logs, logger } = recordingLogger();
  const { tcp, hub, runtime } = await openTunnel("s-stats-off", { logger });
  tcp.emit("data", Buffer.from(Uint8Array.from([1, 2, 3, 4])));
  hub.deliverFrame(Buffer.from([5, 1, 0, 3, 7]));
  runtime.closeAll();
  expect(logs.filter((l) => l.event === "relay.desktop.tunnel_stats")).toEqual([]);
});

test("diagnostics on logs one numbers-only stats line on tunnel close", async () => {
  const { logs, logger } = recordingLogger();
  const { tcp, hub, runtime } = await openTunnel("s-stats-on", { diagnostics: true, logger });
  // Distinctive payload material that must never reach the log context.
  const marker = "MARKER-SECRET-7f3a";
  tcp.emit("data", Buffer.from(`${marker}-to-hub`, "utf8"));
  hub.deliverFrame(Buffer.from(`${marker}-from-hub`, "utf8"));
  // One pause episode so the pause counters are non-zero.
  hub.bufferedAmount = DESKTOP_BUFFERED_SOFT_PAUSE_BYTES + 1;
  tcp.emit("data", Buffer.from(Uint8Array.from([1, 2, 3, 4])));
  expect(tcp.paused).toBe(true);

  runtime.closeAll();
  const stats = logs.filter((l) => l.event === "relay.desktop.tunnel_stats");
  expect(stats.length).toBe(1);
  const context = stats[0]!.context;
  expect(context.streamId).toBe("s-stats-on");
  expect(context.durationMs).toEqual(expect.any(Number));
  expect(context.bytesToHub).toBeGreaterThan(0);
  expect(context.bytesFromHub).toBeGreaterThan(0);
  expect(context.peakWsBufferedBytes).toBeGreaterThan(DESKTOP_BUFFERED_SOFT_PAUSE_BYTES);
  expect(context.tcpPauses).toBe(1);
  expect(context.tcpPausedMs).toEqual(expect.any(Number));
  // Numbers + streamId only: no payload bytes, no ticket, no credentials.
  const serialized = JSON.stringify(context);
  expect(serialized).not.toContain(marker);
  expect(serialized).not.toContain("ticket");
  expect(serialized).not.toContain("password");
  expect(serialized).not.toContain("credential");
  expect(serialized).not.toContain(TEST_TICKET);
  // Every field except streamId is a plain number: there is no slot for bytes.
  for (const [key, value] of Object.entries(context)) {
    if (key === "streamId") continue;
    expect(typeof value).toBe("number");
  }
});
