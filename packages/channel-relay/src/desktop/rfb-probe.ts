// packages/channel-relay/src/desktop/rfb-probe.ts
// Loopback RFB preflight: confirm the local VNC server speaks RFB and reports
// an auth scheme the hub/browser path can serve (v1: VncAuth only). The probe
// performs the version exchange (read server banner, write client banner)
// but never sends credentials; noVNC completes VncAuth end-to-end over the tunnel.
import net from "node:net";

export const RFB_LOOPBACK_HOST = "127.0.0.1";
export const RFB_SECURITY_INVALID = 0;
export const RFB_SECURITY_NONE = 1;
export const RFB_SECURITY_VNC_AUTH = 2;
/** RealVNC RA2 / RA2ne. */
export const RFB_SECURITY_RA2 = 5;
export const RFB_SECURITY_RA2NE = 6;
/** TightVNC-style tunneling / sub-auth container. */
export const RFB_SECURITY_TIGHT = 16;
export const RFB_SECURITY_ULTRA = 17;
export const RFB_SECURITY_TLS = 18;
/** VeNCrypt (0x47545448 "GTHT" extension). */
export const RFB_SECURITY_VENCRYPT = 19;
/** Apple Remote Desktop Diffie-Hellman / SecureTransport. */
export const RFB_SECURITY_ARD = 30;
export const RFB_SECURITY_MSRDH = 34;

export type RfbProbeVerdict =
  | { ok: true; version: string; security: "vnc-auth" }
  | { ok: false; code: RfbProbeErrorCode; detail: string };

export type RfbProbeErrorCode =
  | "desktop-rfb-unavailable"
  | "desktop-not-rfb"
  | "desktop-auth-unsupported";

const RFB_BANNER_RE = /^RFB (\d{3})\.(\d{3})\n$/;
/** Exact 12 bytes the probe writes back: the negotiated ProtocolVersion. */
export const RFB_CLIENT_VERSION_BYTES = Buffer.from("RFB 003.008\n", "ascii");

function asciiToString(bytes: Uint8Array, start: number, end: number): string {
  let out = "";
  for (let i = start; i < end; i++) out += String.fromCharCode(bytes[i] ?? 0);
  return out;
}

export function parseBanner(bytes: Uint8Array): { version: string; major: number; minor: number } | null {
  if (bytes.length < 12) return null;
  const text = asciiToString(bytes, 0, 12);
  const m = RFB_BANNER_RE.exec(text);
  if (!m) return null;
  const major = Number(m[1]);
  const minor = Number(m[2]);
  if (!Number.isInteger(major) || !Number.isInteger(minor)) return null;
  if (major !== 3) return null;
  return { version: `RFB ${m[1]}.${m[2]}`, major, minor };
}

/**
 * Evaluate the server SecurityTypes that follow the client's ProtocolVersion
 * reply (RFB: server banner -> client banner -> security types). Two call
 * shapes: the legacy single-buffer form (banner + security bytes together,
 * kept for unit tests), and the live form (parsed banner, then the bytes that
 * arrived AFTER the client version was written). Returns null when more bytes
 * are needed, otherwise a closed verdict. Banner parsing stays in
 * `parseBanner` so the tunnel path can verify the banner without consuming
 * security state that belongs to noVNC.
 */
export function evaluateRfbHandshake(bytes: Uint8Array): RfbProbeVerdict | null;
export function evaluateRfbHandshake(banner: { version: string; major: number; minor: number }, rest: Uint8Array): RfbProbeVerdict | null;
export function evaluateRfbHandshake(
  bannerOrBytes: Uint8Array | { version: string; major: number; minor: number },
  rest?: Uint8Array,
): RfbProbeVerdict | null {
  if (rest !== undefined) {
    return evaluateSecurityTypes(bannerOrBytes as { version: string; major: number; minor: number }, rest, 0);
  }
  const bytes = bannerOrBytes as Uint8Array;
  const banner = parseBanner(bytes);
  if (!banner) {
    // A short non-RFB greeting (e.g. HTTP/SSH on the port) fails fast; a short
    // buffer that could still become "RFB 003.xxx\n" waits for more bytes.
    if (bytes.length >= 12) {
      return { ok: false, code: "desktop-not-rfb", detail: "not an RFB server banner" };
    }
    for (let i = 0; i < bytes.length; i++) {
      const b = bytes[i] ?? 0;
      const expected = i < 4 ? "RFB ".charCodeAt(i) : null;
      if (expected !== null && b !== expected) {
        return { ok: false, code: "desktop-not-rfb", detail: "not an RFB server banner" };
      }
    }
    return null;
  }
  return evaluateSecurityTypes(banner, bytes, 12);
}

function evaluateSecurityTypes(
  banner: { version: string; major: number; minor: number },
  bytes: Uint8Array,
  offset: number,
): RfbProbeVerdict | null {
  const fail = (code: RfbProbeErrorCode, detail: string): RfbProbeVerdict => ({ ok: false, code, detail });

  if (banner.major === 3 && banner.minor >= 7) {
    // RFB 3.7+: u8 security-type count, then the list.
    if (bytes.length < offset + 1) return null;
    const count = bytes[offset] ?? 0;
    if (count === 0) {
      // Zero types + u32 reason length + reason string: conclusive failure.
      if (bytes.length < offset + 5) return null;
      const reasonLen = ((bytes[offset + 1] ?? 0) << 24) | ((bytes[offset + 2] ?? 0) << 16)
        | ((bytes[offset + 3] ?? 0) << 8) | (bytes[offset + 4] ?? 0);
      if (reasonLen > 1024) return fail("desktop-not-rfb", "RFB security failure reason too long");
      if (bytes.length < offset + 5 + reasonLen) return null;
      const reason = asciiToString(bytes, offset + 5, offset + 5 + reasonLen).slice(0, 128);
      return fail("desktop-rfb-unavailable", reason || "RFB server refused the connection");
    }
    if (bytes.length < offset + 1 + count) return null;
    const types: number[] = [];
    for (let i = 0; i < count; i++) types.push(bytes[offset + 1 + i] ?? 0);
    return classifySecurityTypes(types, banner.version);
  }

  // RFB 3.3–3.6: u32 security type directly after the banner.
  if (bytes.length < offset + 4) return null;
  const securityType = ((bytes[offset] ?? 0) << 24) | ((bytes[offset + 1] ?? 0) << 16)
    | ((bytes[offset + 2] ?? 0) << 8) | (bytes[offset + 3] ?? 0);
  return classifySecurityTypes([securityType], banner.version);
}

function classifySecurityTypes(types: readonly number[], version: string): RfbProbeVerdict {
  if (types.includes(RFB_SECURITY_INVALID)) {
    return { ok: false, code: "desktop-rfb-unavailable", detail: "RFB server reported an invalid security type" };
  }
  if (types.includes(RFB_SECURITY_VNC_AUTH) || types.includes(RFB_SECURITY_TIGHT)) {
    // Tight (16) negotiates sub-auth inside the tunnel; noVNC handles the
    // standard VncAuth challenge once the stream is up.
    return { ok: true, version, security: "vnc-auth" };
  }
  if (types.includes(RFB_SECURITY_ARD)) {
    return { ok: false, code: "desktop-auth-unsupported", detail: "Apple Remote Desktop auth needs Phase B (connector pre-auth)" };
  }
  if (types.includes(RFB_SECURITY_VENCRYPT) || types.includes(RFB_SECURITY_MSRDH) || types.includes(RFB_SECURITY_TLS)) {
    return { ok: false, code: "desktop-auth-unsupported", detail: "VeNCrypt/TLS auth is not supported in v1" };
  }
  if (types.includes(RFB_SECURITY_RA2) || types.includes(RFB_SECURITY_RA2NE) || types.includes(RFB_SECURITY_ULTRA)) {
    return { ok: false, code: "desktop-auth-unsupported", detail: "proprietary VNC auth is not supported in v1" };
  }
  if (types.length === 1 && types[0] === RFB_SECURITY_NONE) {
    return { ok: false, code: "desktop-auth-unsupported", detail: "unauthenticated VNC servers are rejected" };
  }
  return { ok: false, code: "desktop-auth-unsupported", detail: `unsupported RFB security types: ${types.join(",")}` };
}

export interface RfbProbeOptions {
  port: number;
  connectTimeoutMs: number;
  /** Test seam: dial loopback and return the server's handshake bytes. */
  dial?: (port: number, timeoutMs: number) => Promise<Uint8Array>;
}

export async function probeLoopbackRfb(options: RfbProbeOptions): Promise<RfbProbeVerdict> {
  const dial = options.dial ?? dialLoopbackTcp;
  let bytes: Uint8Array;
  try {
    bytes = await dial(options.port, options.connectTimeoutMs);
  } catch (err) {
    return {
      ok: false,
      code: "desktop-rfb-unavailable",
      detail: err instanceof Error ? err.message.slice(0, 160) : "RFB connection failed",
    };
  }
  const verdict = evaluateRfbHandshake(bytes);
  if (!verdict) {
    return { ok: false, code: "desktop-not-rfb", detail: "RFB handshake truncated" };
  }
  return verdict;
}
/**
 * Disposable probe connection with the CORRECT RFB order: read the 12-byte
 * server banner, write back our ProtocolVersion, THEN read the SecurityTypes.
 * A standards-compliant server (TigerVNC/TightVNC) waits for the client
 * version after its banner; reading-then-writing is what unblocks it. The
 * socket is always destroyed afterwards — the real tunnel opens its own
 * connection so noVNC owns the full handshake there.
 */
async function dialLoopbackTcp(port: number, timeoutMs: number): Promise<Uint8Array> {
  return new Promise<Uint8Array>((resolve, reject) => {
    const bannerChunks: Buffer[] = [];
    const securityChunks: Buffer[] = [];
    let settled = false;
    let phase: "banner" | "security" = "banner";
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      socket.destroy();
      reject(new Error(`RFB connect timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    const fail = (err: unknown) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      reject(err instanceof Error ? err : new Error(String(err)));
    };
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const banner = Buffer.concat(bannerChunks);
      const security = Buffer.concat(securityChunks).subarray(0, 256);
      socket.destroy();
      resolve(new Uint8Array(Buffer.concat([banner.subarray(0, 12), security])));
    };
    const socket = net.createConnection({ host: RFB_LOOPBACK_HOST, port });
    socket.on("data", (chunk: Buffer) => {
      if (settled) return;
      if (phase === "banner") {
        bannerChunks.push(chunk);
        const buffered = Buffer.concat(bannerChunks);
        if (buffered.length < 12) return;
        const parsed = parseBanner(new Uint8Array(buffered.subarray(0, 12)));
        if (!parsed) {
          fail(new Error("not an RFB server banner"));
          return;
        }
        phase = "security";
        try {
          socket.write(RFB_CLIENT_VERSION_BYTES);
        } catch (err) {
          fail(err);
          return;
        }
        const rest = buffered.subarray(12);
        if (rest.length > 0) securityChunks.push(rest);
        // Some servers answer synchronously; otherwise the next data event continues.
        if (securityChunks.length > 0) setImmediate(checkSecurity);
        return;
      }
      securityChunks.push(chunk);
      checkSecurity();
    });
    const checkSecurity = () => {
      if (settled || phase !== "security") return;
      const banner = Buffer.concat(bannerChunks).subarray(0, 12);
      const parsed = parseBanner(new Uint8Array(banner));
      if (!parsed) {
        fail(new Error("not an RFB server banner"));
        return;
      }
      const verdict = evaluateRfbHandshake(parsed, new Uint8Array(Buffer.concat(securityChunks)));
      if (verdict === null) return;
      finish();
    };
    socket.on("error", fail);
    socket.on("close", () => {
      if (settled) return;
      // Server closed mid-handshake: whatever arrived still feeds the verdict.
      if (phase === "banner" && bannerChunks.length === 0) {
        fail(new Error("RFB server closed the connection"));
        return;
      }
      finish();
    });
  });
}
