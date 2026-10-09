import { expect, test } from "bun:test";
import {
  createDecipheriv,
  createDiffieHellman,
  createHash,
} from "node:crypto";
import net from "node:net";
import { inspect } from "node:util";

import {
  ARD_BROWSER_GREETING,
  ARD_PREAUTH_MAX_MS,
  ArdSecret,
  createArdBrowserReplyFilter,
  preauthArd,
} from "../../../../packages/channel-relay/src/desktop/ard-auth";

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

function serverInit(name = "Main"): Buffer {
  const nameBytes = Buffer.from(name, "utf8");
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
  head.writeUInt32BE(nameBytes.length, 20);
  return Buffer.concat([head, nameBytes]);
}

type MacScript = "ok" | "reject" | "close-after-init" | "stall-init" | "types-2-30" | "abort-wait";

function bufferReader(socket: net.Socket): { take(n: number): Promise<Buffer> } {
  let buf = Buffer.alloc(0);
  let waiter: { n: number; resolve: (chunk: Buffer) => void } | null = null;
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
  return {
    take(n: number) {
      if (buf.length >= n) {
        const out = buf.subarray(0, n);
        buf = buf.subarray(n);
        return Promise.resolve(Buffer.from(out));
      }
      return new Promise((resolve) => {
        waiter = { n, resolve };
        pump();
      });
    },
  };
}

async function startFakeMac(script: MacScript): Promise<{
  port: number;
  serverInit: Buffer;
  plaintext: Promise<Buffer>;
  typeSeen: Promise<void>;
  close: () => Promise<void>;
}> {
  const init = serverInit();
  let resolvePlain: (plain: Buffer) => void = () => {};
  let rejectPlain: (err: Error) => void = () => {};
  const plaintext = new Promise<Buffer>((resolve, reject) => {
    resolvePlain = resolve;
    rejectPlain = reject;
  });
  let resolveType: () => void = () => {};
  const typeSeen = new Promise<void>((resolve) => {
    resolveType = resolve;
  });
  const dh = createDiffieHellman(256);
  dh.generateKeys();
  const prime = leftPad(dh.getPrime(), dh.getPrime().length);
  const server = net.createServer((socket) => {
    socket.on("error", () => {});
    void (async () => {
      socket.write(Buffer.from("RFB 003.889\n", "ascii"));
      const reader = bufferReader(socket);
      await reader.take(12);
      const types = script === "types-2-30" ? [2, 30] : [30, 19];
      socket.write(Buffer.from([types.length, ...types]));
      if (script === "types-2-30") return;
      const chosen = await reader.take(1);
      if (chosen[0] !== 30) throw new Error(`client chose ${chosen[0]}`);
      resolveType();
      if (script === "abort-wait") return;
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
      const payload = await reader.take(128 + prime.length);
      if (script === "ok") {
        try {
          const shared = leftPad(dh.computeSecret(leftPad(payload.subarray(128), prime.length)), prime.length);
          const key = createHash("md5").update(shared).digest();
          const decipher = createDecipheriv("aes-128-ecb", key, null);
          decipher.setAutoPadding(false);
          resolvePlain(Buffer.concat([decipher.update(payload.subarray(0, 128)), decipher.final()]));
        } catch (err) {
          rejectPlain(err instanceof Error ? err : new Error(String(err)));
          return;
        }
      }
      if (script === "reject") {
        const reason = Buffer.from("nope", "ascii");
        const status = Buffer.alloc(4);
        status.writeUInt32BE(1, 0);
        const len = Buffer.alloc(4);
        len.writeUInt32BE(reason.length, 0);
        socket.write(Buffer.concat([status, len, reason]));
        return;
      }
      socket.write(Buffer.alloc(4));
      await reader.take(1);
      if (script === "close-after-init") {
        socket.end();
        return;
      }
      if (script === "stall-init") return;
      socket.write(init);
    })().catch((err: unknown) => {
      if (script === "ok") rejectPlain(err instanceof Error ? err : new Error(String(err)));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("fake mac bind failed");
  return {
    port: address.port,
    serverInit: init,
    plaintext,
    typeSeen,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

function connectClient(port: number): Promise<net.Socket> {
  const socket = net.connect({ host: "127.0.0.1", port });
  socket.on("error", () => {});
  return new Promise((resolve, reject) => {
    socket.once("connect", () => resolve(socket));
    socket.once("error", reject);
  });
}

function nextBytes(socket: net.Socket, n: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let got = 0;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.off("data", onData);
      reject(new Error(`short read ${got}/${n}`));
    }, 1000);
    const onData = (chunk: Buffer) => {
      chunks.push(chunk);
      got += chunk.length;
      if (got >= n) {
        clearTimeout(timer);
        socket.off("data", onData);
        resolve(Buffer.concat(chunks).subarray(0, n));
      }
    };
    socket.on("data", onData);
    socket.resume();
  });
}

function credential(): ArdSecret {
  return new ArdSecret({ kind: "ard", username: USERNAME, password: PASSWORD });
}

test("ARD_BROWSER_GREETING is the 18-byte RFB 3.8 None script", () => {
  expect(ARD_PREAUTH_MAX_MS).toBe(5000);
  expect(ARD_BROWSER_GREETING.length).toBe(18);
  expect(ARD_BROWSER_GREETING.subarray(0, 12).toString("ascii")).toBe("RFB 003.008\n");
  expect([...ARD_BROWSER_GREETING.subarray(12)]).toEqual([1, 1, 0, 0, 0, 0]);
});

test("ArdSecret redacts JSON and inspect and wipe does not throw", () => {
  const secret = credential();
  expect(secret.toJSON()).toBe("[redacted]");
  expect(inspect(secret)).toBe("[redacted]");
  expect(JSON.stringify(secret)).toBe('"[redacted]"');
  expect(JSON.stringify({ auth: secret })).not.toContain(USERNAME);
  expect(JSON.stringify({ auth: secret })).not.toContain(PASSWORD);
  secret.wipe();
  expect(secret.toJSON()).toBe("[redacted]");
  expect(inspect(secret)).toBe("[redacted]");
  expect(JSON.stringify(secret)).not.toContain(PASSWORD);
});

test("preauthArd encrypts the account and puts ServerInit back on the socket", async () => {
  const mac = await startFakeMac("ok");
  const client = await connectClient(mac.port);
  try {
    const outcome = await preauthArd(client, credential(), { signal: new AbortController().signal });
    expect(outcome).toEqual({ ok: true });
    const plain = await mac.plaintext;
    expect(plain.subarray(0, USERNAME.length + 1).equals(Buffer.from(`${USERNAME}\0`))).toBe(true);
    expect(plain.subarray(64, 64 + PASSWORD.length + 1).equals(Buffer.from(`${PASSWORD}\0`))).toBe(true);
    const next = await nextBytes(client, mac.serverInit.length);
    expect(next.equals(mac.serverInit)).toBe(true);
    expect(client.listenerCount("data")).toBe(0);
  } finally {
    client.destroy();
    await mac.close();
  }
});

test("SecurityResult 1 is desktop-credentials-rejected", async () => {
  const mac = await startFakeMac("reject");
  const client = await connectClient(mac.port);
  try {
    const outcome = await preauthArd(client, credential(), { signal: new AbortController().signal });
    expect(outcome).toEqual({
      ok: false,
      code: "desktop-credentials-rejected",
      phase: "security-result",
      detail: "nope",
    });
  } finally {
    client.destroy();
    await mac.close();
  }
});

test("a close after ClientInit is desktop-permission-denied", async () => {
  const mac = await startFakeMac("close-after-init");
  const client = await connectClient(mac.port);
  try {
    const outcome = await preauthArd(client, credential(), { signal: new AbortController().signal });
    expect(outcome).toEqual({
      ok: false,
      code: "desktop-permission-denied",
      phase: "server-init",
      detail: "server closed during server-init",
    });
  } finally {
    client.destroy();
    await mac.close();
  }
});

test("a stall at server-init is desktop-stream-timeout", async () => {
  const mac = await startFakeMac("stall-init");
  const client = await connectClient(mac.port);
  try {
    const outcome = await preauthArd(client, credential(), { signal: new AbortController().signal });
    expect(outcome).toEqual({
      ok: false,
      code: "desktop-stream-timeout",
      phase: "server-init",
      detail: "timed out during server-init",
    });
  } finally {
    client.destroy();
    await mac.close();
  }
}, { timeout: 15_000 });

test("abort mid-challenge rejects and leaves no reader on the socket", async () => {
  const mac = await startFakeMac("abort-wait");
  const client = await connectClient(mac.port);
  const controller = new AbortController();
  try {
    const pending = preauthArd(client, credential(), { signal: controller.signal });
    await mac.typeSeen;
    controller.abort();
    await expect(pending).rejects.toThrow(/aborted/);
    expect(client.listenerCount("data")).toBe(0);
    expect(client.listenerCount("close")).toBe(0);
  } finally {
    client.destroy();
    await mac.close();
  }
});

test("a tunnel that now offers VncAuth is refused before the challenge", async () => {
  const mac = await startFakeMac("types-2-30");
  const client = await connectClient(mac.port);
  try {
    const outcome = await preauthArd(client, credential(), { signal: new AbortController().signal });
    expect(outcome).toMatchObject({
      ok: false,
      code: "desktop-protocol-error",
      phase: "security-types",
    });
  } finally {
    client.destroy();
    await mac.close();
  }
});

test("the browser reply filter swallows the 14-byte noVNC answer and checks the first 13", () => {
  const reply = Buffer.concat([
    Buffer.from("RFB 003.008\n", "ascii"),
    Buffer.from([1, 1]),
  ]);
  expect(reply.length).toBe(14);

  const byteAtATime = createArdBrowserReplyFilter();
  const gathered: Buffer[] = [];
  for (const byte of reply) {
    const out = byteAtATime(Buffer.from([byte]));
    expect(out).not.toBe("mismatch");
    if (out !== "mismatch") gathered.push(out);
  }
  expect(Buffer.concat(gathered).length).toBe(0);
  const after = byteAtATime(Buffer.from([0x42, 0x43]));
  expect(after).toEqual(Buffer.from([0x42, 0x43]));

  const oneFrame = createArdBrowserReplyFilter();
  expect(oneFrame(Buffer.concat([reply, Buffer.from([0x42])]))).toEqual(Buffer.from([0x42]));

  const split = createArdBrowserReplyFilter();
  expect(split(reply.subarray(0, 7))).toEqual(Buffer.alloc(0));
  expect(split(Buffer.concat([reply.subarray(7), Buffer.from([0x07])]))).toEqual(Buffer.from([0x07]));

  const sharedUnchecked = createArdBrowserReplyFilter();
  const sharedZero = Buffer.concat([
    Buffer.from("RFB 003.008\n", "ascii"),
    Buffer.from([1, 0, 9]),
  ]);
  expect(sharedUnchecked(sharedZero)).toEqual(Buffer.from([9]));

  const mismatch = createArdBrowserReplyFilter();
  expect(mismatch(Buffer.from("RFB 003.007\n\x01\x01", "ascii"))).toBe("mismatch");
});
