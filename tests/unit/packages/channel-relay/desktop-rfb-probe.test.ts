import { expect, test } from "bun:test";

import {
  evaluateRfbHandshake,
  parseBanner,
  probeLoopbackRfb,
  RFB_CLIENT_VERSION_BYTES,
} from "../../../../packages/channel-relay/src/desktop/rfb-probe";
import net from "node:net";
import { desktopSetupGuidance } from "../../../../packages/channel-relay/src/desktop/platform-guidance";

function bytes(s: string): Uint8Array {
  return Uint8Array.from(s.split("").map((c) => c.charCodeAt(0)));
}

function handshake37(...types: number[]): Uint8Array {
  return Uint8Array.from([82, 70, 66, 32, 48, 48, 51, 46, 48, 48, 56, 10, types.length, ...types]);
}

function handshake33(type: number): Uint8Array {
  return Uint8Array.from([
    82, 70, 66, 32, 48, 48, 51, 46, 48, 48, 51, 10,
    (type >>> 24) & 0xff, (type >>> 16) & 0xff, (type >>> 8) & 0xff, type & 0xff,
  ]);
}

test("VncAuth and Tight offers are accepted", () => {
  expect(evaluateRfbHandshake(handshake37(2))).toEqual({ ok: true, version: "RFB 003.008", security: "vnc-auth" });
  expect(evaluateRfbHandshake(handshake37(16, 2))).toEqual({ ok: true, version: "RFB 003.008", security: "vnc-auth" });
  expect(evaluateRfbHandshake(handshake33(2))).toEqual({ ok: true, version: "RFB 003.003", security: "vnc-auth" });
});

test("None-only servers are rejected (unauthenticated VNC never served)", () => {
  expect(evaluateRfbHandshake(handshake37(1))).toEqual({
    ok: false,
    code: "desktop-auth-unsupported",
    detail: expect.stringContaining("unauthenticated"),
  });
  expect(evaluateRfbHandshake(handshake33(1))).toEqual({
    ok: false,
    code: "desktop-auth-unsupported",
    detail: expect.stringContaining("unauthenticated"),
  });
});

test("VeNCrypt/TLS/ARD/proprietary offers fail with desktop-auth-unsupported", () => {
  for (const type of [19, 18, 30, 5, 6, 17]) {
    const verdict = evaluateRfbHandshake(handshake37(type));
    expect(verdict?.ok).toBe(false);
    if (verdict && !verdict.ok) expect(verdict.code).toBe("desktop-auth-unsupported");
  }
  // ARD mention stays explicit for the Phase B follow-up.
  expect(evaluateRfbHandshake(handshake37(30))).toEqual({
    ok: false,
    code: "desktop-auth-unsupported",
    detail: expect.stringContaining("Phase B"),
  });
});

test("non-RFB greetings and invalid security fail closed", () => {
  expect(evaluateRfbHandshake(bytes("HTTP/1.1 400 \r\n"))?.ok).toBe(false);
  expect(evaluateRfbHandshake(bytes("HTTP/1.1 400 \r\n"))).toMatchObject({ code: "desktop-not-rfb" });
  expect(evaluateRfbHandshake(bytes("SSH-2.0-OpenS"))?.ok).toBe(false);
  expect(evaluateRfbHandshake(handshake37(0, 0, 0, 5, 78, 111, 32, 97, 117, 116, 104))).toMatchObject({
    ok: false,
    code: "desktop-rfb-unavailable",
  });
  expect(evaluateRfbHandshake(handshake37(0))).toMatchObject({ ok: false, code: "desktop-rfb-unavailable" });
});

test("truncated handshakes wait for more bytes, truncated banners fail via probe", async () => {
  expect(evaluateRfbHandshake(bytes("RFB 003.0"))).toBeNull();
  expect(evaluateRfbHandshake(handshake37(2).subarray(0, 13))).toBeNull();
  const verdict = await probeLoopbackRfb({ port: 5900, connectTimeoutMs: 500, dial: async () => bytes("RFB 00") });
  expect(verdict).toMatchObject({ ok: false, code: "desktop-not-rfb" });
});

test("probe performs the RFB version exchange against a real server", async () => {
  // A standards-compliant fake: banner first, then WAIT for the client
  // version before sending SecurityTypes. The old read-only probe deadlocked
  // here (both sides waiting); the fixed probe writes the client banner.
  const serverBanner = Buffer.from("RFB 003.008\n", "ascii");
  const security = Buffer.from([1, 2]);
  const seen: Buffer[] = [];
  const server = net.createServer((socket) => {
    socket.write(serverBanner);
    socket.on("data", (chunk: Buffer) => {
      seen.push(chunk);
      socket.write(security);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  try {
    const port = (server.address() as { port: number }).port;
    const verdict = await probeLoopbackRfb({ port, connectTimeoutMs: 2000 });
    expect(verdict).toEqual({ ok: true, version: "RFB 003.008", security: "vnc-auth" });
    expect(Buffer.concat(seen).equals(RFB_CLIENT_VERSION_BYTES)).toBe(true);
  } finally {
    server.close();
  }
});

test("live security bytes evaluate after the banner form", () => {
  const banner = parseBanner(Uint8Array.from(Buffer.from("RFB 003.008\n", "ascii")))!;
  expect(banner.version).toBe("RFB 003.008");
  expect(evaluateRfbHandshake(banner, Uint8Array.from([1, 2]))).toEqual({ ok: true, version: "RFB 003.008", security: "vnc-auth" });
  expect(evaluateRfbHandshake(banner, Uint8Array.from([]))).toBeNull();
});

test("dial failures map to desktop-rfb-unavailable", async () => {
  const verdict = await probeLoopbackRfb({
    port: 5900,
    connectTimeoutMs: 500,
    dial: async () => { throw new Error("connect ECONNREFUSED 127.0.0.1:5900"); },
  });
  expect(verdict).toMatchObject({ ok: false, code: "desktop-rfb-unavailable" });
});

test("platform guidance names the right server per OS", () => {
  expect(desktopSetupGuidance("win32", "desktop-rfb-unavailable")).toContain("TightVNC");
  expect(desktopSetupGuidance("linux", "desktop-rfb-unavailable")).toContain("TigerVNC");
  expect(desktopSetupGuidance("linux", "desktop-rfb-unavailable")).toContain("relax_encryption");
  expect(desktopSetupGuidance("darwin", "desktop-auth-unsupported")).toContain("Phase B");
  expect(desktopSetupGuidance("win32", "desktop-not-rfb")).toContain("options.desktop.port");
});
