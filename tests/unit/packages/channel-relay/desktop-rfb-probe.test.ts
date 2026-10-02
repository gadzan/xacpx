import { expect, test } from "bun:test";

import {
  clientVersionForBanner,
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

test("outer VncAuth is accepted; servers also offering Tight use the VncAuth leg", () => {
  expect(evaluateRfbHandshake(handshake37(2))).toEqual({ ok: true, version: "RFB 003.008", security: "vnc-auth" });
  expect(evaluateRfbHandshake(handshake37(16, 2))).toEqual({ ok: true, version: "RFB 003.008", security: "vnc-auth" });
  expect(evaluateRfbHandshake(handshake33(2))).toEqual({ ok: true, version: "RFB 003.003", security: "vnc-auth" });
});

test("Tight-only endpoints fail closed: outer 16 cannot prove password auth", () => {
  // Tight (16) is a sub-auth container: the server may select STDVNOAUTH__
  // (or an empty sub-auth list, also no auth), and noVNC completes either.
  // A "vnc-auth" verdict here could not constrain the real tunnel.
  for (const verdict of [evaluateRfbHandshake(handshake37(16)), evaluateRfbHandshake(handshake33(16))]) {
    expect(verdict?.ok).toBe(false);
    if (verdict && !verdict.ok) {
      expect(verdict.code).toBe("desktop-auth-unsupported");
      expect(verdict.detail).toMatch(/Tight-only/);
    }
  }
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

test("a long server-refusal reason survives the live dial", async () => {
  // evaluateSecurityTypes permits up to 1024 bytes of reason after count=0, and
  // the evaluator still returns that reason: the only place it could be lost was
  // the live dial cutting the security block at 256 bytes, after which the caller
  // re-evaluated a handshake that no longer parsed and reported "not an RFB
  // server" instead of the server's own refusal.
  const reason = "refused: " + "x".repeat(300);
  expect(reason.length).toBeGreaterThan(256);
  const banner = Buffer.from("RFB 003.008\n", "ascii");
  const server = net.createServer((socket) => {
    socket.on("error", () => {});
    socket.write(banner);
    socket.on("data", () => {
      // u8 count = 0, then u32 reason length, then the reason itself.
      const len = Buffer.alloc(4);
      len.writeUInt32BE(Buffer.byteLength(reason, "ascii"), 0);
      socket.write(Buffer.concat([Buffer.from([0]), len, Buffer.from(reason, "ascii")]));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  try {
    const port = (server.address() as { port: number }).port;
    const verdict = await probeLoopbackRfb({ port, connectTimeoutMs: 1000 });
    expect(verdict).toMatchObject({ ok: false, code: "desktop-rfb-unavailable" });
    // The reason actually arrived, not a truncated-handshake verdict.
    expect((verdict as { detail?: string }).detail).toBe(reason.slice(0, 128));
  } finally {
    server.close();
  }
});

test("an RFB 3.3 refusal reason is surfaced, not reported as an invalid type", async () => {
  // RFC 6143: for RFB 3.3 a security-type value of 0 means the connection failed
  // and the server then sends u32 reason-length + reason. Reporting type 0 as an
  // \"invalid security type\" threw away the only diagnostic text a 3.3 server gives.
  // 3.7/3.8 already parsed its zero-count reason; this covers the 3.3 leg.
  const banner = Buffer.from("RFB 003.003\n", "ascii");
  const reason = "Too many connections";
  const server = net.createServer((socket) => {
    socket.on("error", () => {});
    socket.write(banner);
    socket.on("data", () => {
      const block = Buffer.alloc(8);
      block.writeUInt32BE(0, 0); // security type 0 = failure
      block.writeUInt32BE(Buffer.byteLength(reason, "ascii"), 4);
      socket.write(Buffer.concat([block, Buffer.from(reason, "ascii")]));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  try {
    const port = (server.address() as { port: number }).port;
    const verdict = await probeLoopbackRfb({ port, connectTimeoutMs: 1000 });
    expect(verdict).toMatchObject({ ok: false, code: "desktop-rfb-unavailable", detail: reason });
  } finally {
    server.close();
  }
});

test("a live non-RFB service reports desktop-not-rfb, not rfb-unavailable", async () => {
  // The evaluator is pure and therefore already correct for a non-RFB greeting,
  // which is why the direct unit test above passes while production did not:
  // `dialLoopbackTcp` rejects with a generic Error on an unparseable banner and
  // `probeLoopbackRfb` folded every non-abort rejection into
  // `desktop-rfb-unavailable`. Pointing desktop.port at a real HTTP listener was
  // then reported as \"nothing is listening\", which sends an operator chasing a
  // dead server instead of the wrong port. End to end through the real dial:
  const httpServer = net.createServer((socket) => {
    socket.on("error", () => {});
    socket.write("HTTP/1.1 200 OK\\r\\nContent-Length: 2\\r\\n\\r\\nok");
  });
  await new Promise<void>((resolve) => httpServer.listen(0, "127.0.0.1", () => resolve()));
  try {
    const port = (httpServer.address() as { port: number }).port;
    const verdict = await probeLoopbackRfb({ port, connectTimeoutMs: 1000 });
    expect(verdict.ok).toBe(false);
    expect(verdict).toMatchObject({ ok: false, code: "desktop-not-rfb" });
    // And the operator-facing guidance for that code is the wrong-port message.
    expect(desktopSetupGuidance("linux", "desktop-not-rfb")).toMatch(/not an RFB|VNC/);
  } finally {
    httpServer.close();
  }
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

test("client version negotiates down per server banner", () => {
  expect(clientVersionForBanner({ major: 3, minor: 8 }).toString("ascii")).toBe("RFB 003.008\n");
  expect(clientVersionForBanner({ major: 3, minor: 7 }).toString("ascii")).toBe("RFB 003.007\n");
  expect(clientVersionForBanner({ major: 3, minor: 3 }).toString("ascii")).toBe("RFB 003.003\n");
  expect(clientVersionForBanner({ major: 3, minor: 5 }).toString("ascii")).toBe("RFB 003.003\n");
});

test("probe negotiates 3.3 against a 3.3 server that waits for the client version", async () => {
  const serverBanner = Buffer.from("RFB 003.003\n", "ascii");
  // RFB 3.3 form: u32 security type directly after the banner.
  const security = Buffer.from([0, 0, 0, 2]);
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
    expect(verdict).toEqual({ ok: true, version: "RFB 003.003", security: "vnc-auth" });
    expect(Buffer.concat(seen).toString("ascii")).toBe("RFB 003.003\n");
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
  // The runtime guidance reaches the user inside a real failed-open message, so
  // it must not re-assert a bind-loopback requirement the docs never made: the
  // constraint is one-way (the connector dials loopback), and the accepted
  // Windows deployment is 0.0.0.0 + LoopbackOnly + firewall.
  const win = desktopSetupGuidance("win32", "desktop-rfb-unavailable");
  expect(win).not.toMatch(/on 127\.0\.0\.1:5900/);
  expect(win.toLowerCase()).toContain("loopback");
  expect(win).toContain("LoopbackOnly");
  expect(desktopSetupGuidance("linux", "desktop-rfb-unavailable")).toContain("TigerVNC");
  expect(desktopSetupGuidance("linux", "desktop-rfb-unavailable")).toContain("relax_encryption");
  expect(desktopSetupGuidance("darwin", "desktop-auth-unsupported")).toContain("Phase B");
  expect(desktopSetupGuidance("win32", "desktop-not-rfb")).toContain("options.desktop.port");
});

test("platform guidance names the CONFIGURED port, not a hardcoded 5900", () => {
  // The banner an operator sees is built from this function plus the probe's
  // verdict, and the probe dials config.port. If guidance kept saying 5900,
  // a deployment on 5901 got "start 5900" while 5901 is what actually refused.
  for (const platform of ["win32", "linux", "darwin"] as const) {
    const win = desktopSetupGuidance(platform, "desktop-rfb-unavailable", 5901);
    expect(win).toContain("5901");
    expect(win).not.toContain("5900");
  }
  // The 5900-shaped text must still hold when 5900 really is configured.
  expect(desktopSetupGuidance("linux", "desktop-rfb-unavailable", 5900)).toContain("127.0.0.1:5900");
  // The diagnostic that tells you how to repoint the config must name the port
  // actually in effect.
  const wrongServer = desktopSetupGuidance("linux", "desktop-not-rfb", 5901);
  expect(wrongServer).toContain("5901");
});
