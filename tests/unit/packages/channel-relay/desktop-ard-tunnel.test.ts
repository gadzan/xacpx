// ARD prepare: the probe stays a separate socket, the tunnel terminates type 30,
// and the hub sees a fixed None greeting followed by the Mac's ServerInit.
import { expect, test } from "bun:test";
import { createDiffieHellman } from "node:crypto";
import { EventEmitter } from "node:events";
import net from "node:net";

import { MSG } from "../../../../packages/relay-protocol/src/index";
import { ARD_BROWSER_GREETING } from "../../../../packages/channel-relay/src/desktop/ard-auth";
import { DesktopTunnelRuntime } from "../../../../packages/channel-relay/src/desktop/desktop-tunnel-runtime";

const USERNAME = "dana";
const PASSWORD = "secret";

function leftPad(value: Buffer, length: number): Buffer {
  let src = value;
  while (src.length > length && src[0] === 0) src = src.subarray(1);
  if (src.length > length) throw new Error("value longer than key length");
  if (src.length === length) return Buffer.from(src);
  const out = Buffer.alloc(length);
  src.copy(out, length - src.length);
  return out;
}

function makeServerInit(): Buffer {
  const name = Buffer.from("Main", "utf8");
  const head = Buffer.alloc(24);
  head.writeUInt16BE(80, 0);
  head.writeUInt16BE(24, 2);
  head[4] = 32;
  head[5] = 24;
  head[7] = 1;
  head.writeUInt16BE(255, 8);
  head.writeUInt16BE(255, 10);
  head.writeUInt16BE(255, 12);
  head[14] = 16;
  head[15] = 8;
  head.writeUInt32BE(name.length, 20);
  return Buffer.concat([head, name]);
}

class HubSocket extends EventEmitter {
  readyState = 1;
  bufferedAmount = 0;
  sent: Buffer[] = [];
  constructor(public url: string) { super(); }
  send(data: unknown): void {
    this.sent.push(Buffer.isBuffer(data) ? data : Buffer.from(data as Uint8Array));
  }
  close(): void { this.readyState = 3; }
  pause(): void {}
  resume(): void {}
}

function byteReader(socket: net.Socket): { take(n: number): Promise<Buffer> } {
  let buf = Buffer.alloc(0);
  let waiter: { n: number; resolve: (chunk: Buffer) => void; reject: (err: Error) => void } | null = null;
  const fail = (err: Error) => {
    const pending = waiter;
    waiter = null;
    pending?.reject(err);
  };
  const pump = () => {
    if (!waiter || buf.length < waiter.n) return;
    const pending = waiter;
    waiter = null;
    const out = buf.subarray(0, pending.n);
    buf = buf.subarray(pending.n);
    pending.resolve(Buffer.from(out));
  };
  socket.on("data", (chunk: Buffer) => {
    buf = buf.length === 0 ? chunk : Buffer.concat([buf, chunk]);
    pump();
  });
  socket.on("close", () => fail(new Error("closed")));
  socket.on("error", () => fail(new Error("error")));
  return {
    take(n: number) {
      if (buf.length >= n) {
        const out = buf.subarray(0, n);
        buf = buf.subarray(n);
        return Promise.resolve(Buffer.from(out));
      }
      return new Promise((resolve, reject) => {
        waiter = { n, resolve, reject };
        pump();
      });
    },
  };
}

async function startMac(): Promise<{
  port: number;
  serverInit: Buffer;
  sessions: Array<{ socket: net.Socket; fromClient: Buffer[] }>;
  close: () => Promise<void>;
}> {
  const serverInit = makeServerInit();
  const sessions: Array<{ socket: net.Socket; fromClient: Buffer[] }> = [];
  const server = net.createServer((socket) => {
    socket.on("error", () => {});
    const fromClient: Buffer[] = [];
    sessions.push({ socket, fromClient });
    socket.on("data", (chunk: Buffer) => fromClient.push(Buffer.from(chunk)));
    void (async () => {
      const dh = createDiffieHellman(256);
      dh.generateKeys();
      const prime = leftPad(dh.getPrime(), dh.getPrime().length);
      socket.write(Buffer.from("RFB 003.889\n", "ascii"));
      const reader = byteReader(socket);
      await reader.take(12);
      socket.write(Buffer.from([2, 30, 19]));
      const chosen = await reader.take(1);
      if (chosen[0] !== 30) return;
      const generator = Buffer.alloc(2);
      const rawGen = dh.getGenerator();
      rawGen.copy(generator, 2 - rawGen.length);
      const keyLen = Buffer.alloc(2);
      keyLen.writeUInt16BE(prime.length, 0);
      socket.write(Buffer.concat([
        generator,
        keyLen,
        prime,
        leftPad(dh.getPublicKey(), prime.length),
      ]));
      await reader.take(128 + prime.length);
      socket.write(Buffer.alloc(4));
      const init = await reader.take(1);
      if (init[0] !== 1) return;
      socket.write(serverInit);
    })().catch(() => {});
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("mac bind failed");
  return {
    port: address.port,
    serverInit,
    sessions,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

function prepare(streamId: string, credential?: { kind: "ard"; username: string; password: string }) {
  return {
    protocolVersion: 1,
    kind: "req" as const,
    id: "hub-1",
    type: MSG.desktopPrepare,
    payload: {
      streamId,
      ticket: "t-ard",
      expiresAt: Date.now() + 60_000,
      ...(credential ? { credential } : {}),
    },
  };
}

test("ARD prepare challenges with no tunnel, then greets the browser with ServerInit", async () => {
  // Another desktop test replaces node:net.createConnection for the process.
  // Call the real Socket so this Mac is the peer the connector dials.
  const previousConnect = net.createConnection;
  net.createConnection = ((options: { host?: string; port?: number }) => {
    const socket = new net.Socket();
    socket.connect({ host: options.host ?? "127.0.0.1", port: options.port ?? 0 });
    return socket;
  }) as typeof net.createConnection;
  const mac = await startMac();
  const calls: unknown[][] = [];
  const logger = {
    info: (...args: unknown[]) => { calls.push(args); },
    warn: (...args: unknown[]) => { calls.push(args); },
    error: (...args: unknown[]) => { calls.push(args); },
  };
  const hubs: HubSocket[] = [];
  const runtime = new DesktopTunnelRuntime({
    config: { enabled: true, backend: "rfb", port: mac.port, connectTimeoutMs: 2000, maxStreams: 1 },
    hubUrl: "ws://127.0.0.1:9",
    platform: "darwin",
    logger,
    createSocket: (url) => {
      const hub = new HubSocket(url);
      hubs.push(hub);
      setImmediate(() => hub.emit("open"));
      return hub as unknown as WebSocket;
    },
  });
  try {
    let challenged: unknown;
    await runtime.handlePrepare(prepare("s-ard"), (payload) => { challenged = payload; });
    expect(challenged).toMatchObject({ error: { code: "desktop-credentials-required" } });
    expect(hubs).toHaveLength(0);
    expect(runtime.activeStreamId).toBeNull();

    let opened: unknown;
    await runtime.handlePrepare(
      prepare("s-ard", { kind: "ard", username: USERNAME, password: PASSWORD }),
      (payload) => { opened = payload; },
    );
    expect(opened).toEqual({ streamId: "s-ard", security: "ard" });
    expect(hubs).toHaveLength(1);
    const hub = hubs[0];
    if (!hub) throw new Error("missing hub socket");
    const want = ARD_BROWSER_GREETING.length + mac.serverInit.length;
    const deadline = Date.now() + 1000;
    while (Buffer.concat(hub.sent).length < want && Date.now() < deadline) {
      await new Promise((resolve) => setImmediate(resolve));
    }
    expect(hub.sent[0]?.equals(ARD_BROWSER_GREETING)).toBe(true);
    expect(Buffer.concat(hub.sent.slice(1)).equals(mac.serverInit)).toBe(true);

    const liveSessions = mac.sessions.filter((session) =>
      !session.socket.destroyed && Buffer.concat(session.fromClient).length > 12);
    expect(liveSessions).toHaveLength(1);
    const live = liveSessions[0];
    if (!live) throw new Error("tunnel socket closed");
    const before = Buffer.concat(live.fromClient);
    const reply = Buffer.concat([
      Buffer.from("RFB 003.008\n", "ascii"),
      Buffer.from([1]),
    ]);
    hub.emit("message", reply, true);
    await new Promise((resolve) => setImmediate(resolve));
    expect(Buffer.concat(live.fromClient).equals(before)).toBe(true);
    hub.emit("message", Buffer.from([1, 0xab]), true);
    const byteDeadline = Date.now() + 1000;
    let added = Buffer.alloc(0);
    while (Date.now() < byteDeadline) {
      added = Buffer.concat(live.fromClient).subarray(before.length);
      if (added.length >= 1) break;
      await new Promise((resolve) => setImmediate(resolve));
    }
    expect(added.equals(Buffer.from([0xab]))).toBe(true);

    const dumped = JSON.stringify(calls);
    expect(dumped).not.toContain(USERNAME);
    expect(dumped).not.toContain(PASSWORD);
  } finally {
    net.createConnection = previousConnect;
    runtime.closeAll();
    await mac.close();
  }
});
