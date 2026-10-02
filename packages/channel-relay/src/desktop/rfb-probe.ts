// packages/channel-relay/src/desktop/rfb-probe.ts
// Loopback RFB preflight: confirm the local VNC server speaks RFB and offers
// outer VncAuth (2) at the top level (v1: outer VncAuth only). The probe
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
/**
 * Client ProtocolVersion per server banner (RFB §6.1.1: the client must not
 * request a version higher than the server announced). Servers ≥3.8 get 3.8,
 * ≥3.7 get 3.7, anything else that parses as RFB 3.x gets 3.3.
 */
export function clientVersionForBanner(banner: { major: number; minor: number }): Buffer {
  if (banner.major === 3 && banner.minor >= 8) return Buffer.from("RFB 003.008\n", "ascii");
  if (banner.major === 3 && banner.minor >= 7) return Buffer.from("RFB 003.007\n", "ascii");
  return Buffer.from("RFB 003.003\n", "ascii");
}
/** Legacy alias: exact bytes for the common 3.8 path (unit-test readability). */
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
  // Type 0 is a FAILURE, not an "unknown type": RFC 6143 says the server sent a
  // u32 reason length followed by the reason string. Treating it as an invalid
  // type discarded the server's own explanation, which is the single most useful
  // thing to log when a 3.3 server refuses the connection.
  if (securityType === RFB_SECURITY_INVALID) {
    if (bytes.length < offset + 8) return null;
    const reasonLen = ((bytes[offset + 4] ?? 0) << 24) | ((bytes[offset + 5] ?? 0) << 16)
      | ((bytes[offset + 6] ?? 0) << 8) | (bytes[offset + 7] ?? 0);
    if (reasonLen > 1024) return fail("desktop-not-rfb", "RFB security failure reason too long");
    if (bytes.length < offset + 8 + reasonLen) return null;
    const reason = asciiToString(bytes, offset + 8, offset + 8 + reasonLen).slice(0, 128);
    return fail("desktop-rfb-unavailable", reason || "RFB server refused the connection");
  }
  return classifySecurityTypes([securityType], banner.version);
}

function classifySecurityTypes(types: readonly number[], version: string): RfbProbeVerdict {
  if (types.includes(RFB_SECURITY_INVALID)) {
    return { ok: false, code: "desktop-rfb-unavailable", detail: "RFB server reported an invalid security type" };
  }
  // Tight (16) is a container, not a proof of password auth: after outer type
  // 16 the server runs a tunnel negotiation followed by a Tight sub-auth
  // capability list, which may select STDVNOAUTH__ (no auth) or an empty
  // sub-auth list (also no auth). noVNC happily completes either, so an
  // outer-16 verdict of "vnc-auth" cannot constrain what the real tunneled
  // connection will use. v1 fail-closes Tight-only here: only an explicit
  // outer VncAuth (2) proves the server offers password auth at the top
  // level. (A server offering BOTH 2 and 16 is accepted via the VncAuth leg;
  // noVNC then selects type 2 directly and never enters Tight sub-auth.)
  if (types.includes(RFB_SECURITY_VNC_AUTH)) {
    return { ok: true, version, security: "vnc-auth" };
  }
  if (types.includes(RFB_SECURITY_TIGHT)) {
    return { ok: false, code: "desktop-auth-unsupported", detail: "Tight-only endpoints are rejected in v1: sub-auth cannot prove VNC authentication before the tunnel opens" };
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
  /**
   * Abort the probe's own dial (not the caller's tunnel). A lifecycle event
   * that lands while the probe is awaiting must not have to wait for
   * connectTimeoutMs: the probe owns a real TCP socket for that whole window.
   */
  signal?: AbortSignal;
  /** Test seam: dial loopback and return the server's handshake bytes. */
  dial?: (port: number, timeoutMs: number, signal?: AbortSignal) => Promise<Uint8Array>;
}

/**
 * The port answered but was not speaking RFB. Distinct from a dial failure on
 * purpose: an operator pointing `desktop.port` at an HTTP or SSH service needs
 * "the port is listening but it is not a VNC server", not "nothing is
 * listening" — the two have completely different fixes.
 */
export class NotRfbServerError extends Error {
  constructor() {
    super("not an RFB server banner");
    this.name = "NotRfbServerError";
  }
}

export async function probeLoopbackRfb(options: RfbProbeOptions): Promise<RfbProbeVerdict> {
  const dial = options.dial ?? dialLoopbackTcp;
  let bytes: Uint8Array;
  try {
    bytes = await dial(options.port, options.connectTimeoutMs, options.signal);
  } catch (err) {
    // An aborted probe is a lifecycle outcome, never a server verdict. Rethrow
    // so the caller's abort path handles it (and suppresses any response);
    // reporting `desktop-rfb-unavailable` here would tell a viewer that no RFB
    // server exists when in fact the connector was logging out.
    if (options.signal?.aborted) throw err;
    if (err instanceof NotRfbServerError) {
      return { ok: false, code: "desktop-not-rfb", detail: err.message };
    }
    return {
      ok: false,
      code: "desktop-rfb-unavailable",
      detail: err instanceof Error ? err.message.slice(0, 160) : "RFB connection failed",
    };
  }
  if (options.signal?.aborted) {
    throw new Error("RFB probe aborted");
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
async function dialLoopbackTcp(
  port: number,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<Uint8Array> {
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
    // A lifecycle abort cuts the probe's own socket at once. Without this the
    // probe holds a real TCP connection for the whole connectTimeoutMs even
    // after the connector has logged out.
    const onAbort = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      reject(new Error("RFB probe aborted"));
    };
    if (signal) {
      if (signal.aborted) {
        clearTimeout(timer);
        settled = true;
        reject(new Error("RFB probe aborted"));
        return;
      }
      signal.addEventListener("abort", onAbort, { once: true });
    }
    const cleanup = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    };
    const fail = (err: unknown) => {
      if (settled) return;
      settled = true;
      cleanup();
      socket.destroy();
      reject(err instanceof Error ? err : new Error(String(err)));
    };
    const finish = () => {
      if (settled) return;
      settled = true;
      cleanup();
      const banner = Buffer.concat(bannerChunks);
      // Keep the WHOLE security block: `evaluateSecurityTypes` accepts up to 1024
      // bytes of server-refusal reason after the count byte, so truncating here
      // makes the caller re-evaluate a hand that no longer parses and report
      // "truncated / not an RFB server" instead of the real refusal. The evaluator
      // is the single place that decides how much is acceptable.
      const security = Buffer.concat(securityChunks).subarray(0, 1029);
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
          fail(new NotRfbServerError());
          return;
        }
        phase = "security";
        try {
          socket.write(clientVersionForBanner(parsed));
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
        fail(new NotRfbServerError());
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
