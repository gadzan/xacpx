// Connector-side Apple Remote Desktop (RFB security type 30), and the fixed
// RFB 3.8 None greeting the browser's noVNC reads instead. Every ARD byte lives here.
import { createCipheriv, createDiffieHellman, createHash, randomBytes } from "node:crypto";
import type net from "node:net";
import { inspect, type InspectOptionsStylized } from "node:util";

import {
  DESKTOP_INNER_RFB_SCHEME,
  type DesktopCredential,
  type DesktopErrorCode,
} from "@ganglion/xacpx-relay-protocol";

import {
  clientVersionForBanner,
  parseBanner,
  RFB_SECURITY_ARD,
  RFB_SECURITY_INVALID,
  RFB_SECURITY_TIGHT,
  RFB_SECURITY_VNC_AUTH,
} from "./rfb-probe.js";

/**
 * Whole ARD exchange, independent of `connectTimeoutMs` (default 1500). A stall
 * while macOS builds ServerInit has to stay a timeout, not a permission refusal,
 * and 1500ms is shorter than a cold Screen Sharing session.
 */
export const ARD_PREAUTH_MAX_MS = 5_000;

export type ArdPhase = "banner" | "security-types" | "challenge" | "security-result" | "server-init";

export type ArdRefusalCode = Extract<DesktopErrorCode,
  | "desktop-not-rfb"
  | "desktop-rfb-unavailable"
  | "desktop-protocol-error"
  | "desktop-stream-timeout"
  | "desktop-credentials-rejected"
  | "desktop-permission-denied">;

/**
 * Phase picks the code. macOS reason text is optional and may be localised, so
 * it never decides credentials-rejected versus permission-denied.
 * `failed`: the server said no or closed. `stalled`: ARD_PREAUTH_MAX_MS ran out.
 * A close after a good SecurityResult is permission-denied; a stall there is a timeout.
 */
const REFUSAL: Record<ArdPhase, { failed: ArdRefusalCode; stalled: ArdRefusalCode }> = {
  banner: { failed: "desktop-not-rfb", stalled: "desktop-stream-timeout" },
  "security-types": { failed: "desktop-protocol-error", stalled: "desktop-stream-timeout" },
  challenge: { failed: "desktop-protocol-error", stalled: "desktop-stream-timeout" },
  "security-result": { failed: "desktop-credentials-rejected", stalled: "desktop-stream-timeout" },
  "server-init": { failed: "desktop-permission-denied", stalled: "desktop-stream-timeout" },
};

export type ArdPreauthOutcome =
  | { ok: true }
  | { ok: false; code: ArdRefusalCode; phase: ArdPhase; detail: string };

const secretFields = new WeakMap<ArdSecret, { username: Buffer; password: Buffer }>();

/**
 * Connector-side holder for one macOS account. `toJSON` and `util.inspect` print
 * a fixed placeholder so a log of the tunnel auth cannot spill the password.
 * `wipe()` zeroes the copies. `answerArdChallenge` is the only reader.
 */
export class ArdSecret {
  constructor(credential: DesktopCredential) {
    secretFields.set(this, {
      username: Buffer.from(credential.username, "utf8"),
      password: Buffer.from(credential.password, "utf8"),
    });
  }

  wipe(): void {
    const held = secretFields.get(this);
    if (!held) return;
    held.username.fill(0);
    held.password.fill(0);
    secretFields.delete(this);
  }

  toJSON(): string {
    return "[redacted]";
  }

  [inspect.custom](_depth: number, _options: InspectOptionsStylized, _inspect: typeof inspect): string {
    return "[redacted]";
  }
}

function readSecret(secret: ArdSecret): { username: Buffer; password: Buffer } | null {
  const held = secretFields.get(secret);
  if (!held || held.username.length === 0 || held.password.length === 0) return null;
  return {
    username: Buffer.from(held.username),
    password: Buffer.from(held.password),
  };
}

/**
 * Run the client half of ARD on a connected tunnel socket that nothing else is reading.
 * On success the socket is paused, this function's listeners are gone, and the next
 * readable bytes are ServerInit. On abort, rejects; the caller destroys `tcp`.
 */
export async function preauthArd(
  tcp: net.Socket,
  secret: ArdSecret,
  options: { signal: AbortSignal },
): Promise<ArdPreauthOutcome> {
  const reader = new RfbReader(tcp, options.signal, Date.now() + ARD_PREAUTH_MAX_MS);
  let phase: ArdPhase = "banner";
  const refuse = (slot: "failed" | "stalled", detail: string): ArdPreauthOutcome => {
    reader.detach();
    return { ok: false, code: REFUSAL[phase][slot], phase, detail };
  };
  try {
    const bannerBytes = await reader.take(12);
    const banner = parseBanner(bannerBytes);
    if (!banner) return refuse("failed", "not an RFB server banner");
    if (banner.minor < 7) return refuse("failed", "ARD needs RFB 3.7 or newer");
    tcp.write(clientVersionForBanner(banner));

    phase = "security-types";
    const count = (await reader.take(1))[0] ?? 0;
    if (count === 0) {
      const reason = await readReason(reader);
      reader.detach();
      return {
        ok: false,
        code: "desktop-rfb-unavailable",
        phase,
        detail: reason || "RFB server refused the connection",
      };
    }
    const types = [...await reader.take(count)];
    if (!securityListIsArd(types)) return refuse("failed", "RFB security changed since the probe");
    tcp.write(Uint8Array.of(RFB_SECURITY_ARD));

    phase = "challenge";
    const head = await reader.take(4);
    const generator = head.subarray(0, 2);
    const keyLength = head.readUInt16BE(2);
    if (keyLength < 16 || keyLength > 1024) return refuse("failed", "ARD key length out of range");
    const prime = await reader.take(keyLength);
    const serverPublicKey = await reader.take(keyLength);
    tcp.write(answerArdChallenge({ generator, keyLength, prime, serverPublicKey }, secret));

    phase = "security-result";
    const status = (await reader.take(4)).readUInt32BE(0);
    if (status !== 0) {
      const reason = banner.minor >= 8 ? await readReason(reader) : "";
      return refuse("failed", reason || "ARD authentication failed");
    }
    tcp.write(Uint8Array.of(1));

    phase = "server-init";
    const initHead = await reader.take(24);
    const nameLength = initHead.readUInt32BE(20);
    if (nameLength > 64 * 1024) return refuse("failed", "ServerInit name too long");
    const name = await reader.take(nameLength);
    reader.release([initHead, name]);
    return { ok: true };
  } catch (err) {
    reader.detach();
    if (err instanceof ArdStopped) {
      if (err.kind === "aborted") throw err;
      const slot = err.kind === "timeout" ? "stalled" : "failed";
      const detail = err.kind === "timeout"
        ? `timed out during ${phase}`
        : `server closed during ${phase}`;
      return { ok: false, code: REFUSAL[phase][slot], phase, detail };
    }
    if (err instanceof ArdFramingError) {
      return { ok: false, code: "desktop-protocol-error", phase, detail: err.message };
    }
    throw err;
  }
}

/** Type 30 present, and neither VncAuth nor Tight won the same list the probe uses. */
function securityListIsArd(types: readonly number[]): boolean {
  if (types.includes(RFB_SECURITY_INVALID)) return false;
  if (types.includes(RFB_SECURITY_VNC_AUTH)) return false;
  if (types.includes(RFB_SECURITY_TIGHT)) return false;
  return types.includes(RFB_SECURITY_ARD);
}

interface ArdChallenge {
  generator: Uint8Array;
  keyLength: number;
  prime: Uint8Array;
  serverPublicKey: Uint8Array;
}

/**
 * 128-byte AES-128-ECB ciphertext, then the client DH public key.
 * noVNC 1.7.0 `_negotiateARDAuthAsync` sends that order; the reverse derives
 * the wrong secret on a real Mac. The key is MD5 of the shared secret left-padded
 * to `keyLength`. Each credential half is 64 bytes: UTF-8, a NUL, random fill.
 */
function answerArdChallenge(challenge: ArdChallenge, secret: ArdSecret): Buffer {
  const fields = readSecret(secret);
  if (!fields) throw new ArdFramingError("ARD secret is gone");
  const { username, password } = fields;
  try {
    if (username.length > 63 || password.length > 63 || username.includes(0) || password.includes(0)) {
      throw new ArdFramingError("ARD credential field does not fit a 64-byte half");
    }
    const dh = createDiffieHellman(challenge.prime, challenge.generator);
    dh.generateKeys();
    const shared = leftPad(dh.computeSecret(challenge.serverPublicKey), challenge.keyLength);
    const key = createHash("md5").update(shared).digest();
    const block = randomBytes(128);
    block.set(username, 0);
    block[username.length] = 0;
    block.set(password, 64);
    block[64 + password.length] = 0;
    const cipher = createCipheriv("aes-128-ecb", key, null);
    cipher.setAutoPadding(false);
    const encrypted = Buffer.concat([cipher.update(block), cipher.final()]);
    const clientPublicKey = leftPad(dh.getPublicKey(), challenge.keyLength);
    block.fill(0);
    shared.fill(0);
    key.fill(0);
    return Buffer.concat([encrypted, clientPublicKey]);
  } finally {
    username.fill(0);
    password.fill(0);
  }
}

function leftPad(value: Buffer, length: number): Buffer {
  let src = value;
  while (src.length > length && src[0] === 0) src = src.subarray(1);
  if (src.length > length) throw new ArdFramingError("ARD value longer than key length");
  if (src.length === length) return Buffer.from(src);
  const out = Buffer.alloc(length);
  src.copy(out, length - src.length);
  return out;
}

class ArdStopped extends Error {
  constructor(readonly kind: "closed" | "timeout" | "aborted") {
    super(kind);
    this.name = "ArdStopped";
  }
}

class ArdFramingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ArdFramingError";
  }
}

/**
 * Exact-length reads. `release` puts bytes back, detaches listeners, and leaves
 * the socket paused. Unshift happens only after the listener is gone: a flowing
 * socket with no listener drops what you push.
 */
class RfbReader {
  private buf = Buffer.alloc(0);
  private waiter: { n: number; resolve: (chunk: Buffer) => void; reject: (err: Error) => void } | null = null;
  private stopped: ArdStopped | null = null;
  private detached = false;
  private readonly timer: ReturnType<typeof setTimeout>;
  private readonly onData: (chunk: Buffer) => void;
  private readonly onClose: () => void;
  private readonly onError: () => void;
  private readonly onAbort: () => void;

  constructor(
    private readonly tcp: net.Socket,
    private readonly signal: AbortSignal,
    deadline: number,
  ) {
    this.timer = setTimeout(() => this.stop("timeout"), Math.max(0, deadline - Date.now()));
    this.timer.unref?.();
    this.onData = (chunk: Buffer) => {
      const merged = Buffer.alloc(this.buf.length + chunk.length);
      merged.set(this.buf, 0);
      merged.set(chunk, this.buf.length);
      this.buf = merged;
      this.pump();
    };
    this.onClose = () => this.stop("closed");
    this.onError = () => this.stop("closed");
    this.onAbort = () => this.stop("aborted");
    this.tcp.on("data", this.onData);
    this.tcp.on("close", this.onClose);
    this.tcp.on("error", this.onError);
    if (this.signal.aborted) this.stop("aborted");
    else this.signal.addEventListener("abort", this.onAbort, { once: true });
  }

  take(n: number): Promise<Buffer> {
    if (n === 0) return Promise.resolve(Buffer.alloc(0));
    if (this.stopped) return Promise.reject(this.stopped);
    if (this.buf.length >= n) {
      const out = this.buf.subarray(0, n);
      this.buf = this.buf.subarray(n);
      return Promise.resolve(Buffer.from(out));
    }
    return new Promise((resolve, reject) => {
      this.waiter = { n, resolve, reject };
    });
  }

  release(putBack: readonly Buffer[]): void {
    if (this.detached) return;
    const extra = Buffer.concat([...putBack, this.buf]);
    this.buf = Buffer.alloc(0);
    this.detach();
    this.tcp.pause();
    if (extra.length > 0) this.tcp.unshift(extra);
  }

  detach(): void {
    if (this.detached) return;
    this.detached = true;
    clearTimeout(this.timer);
    this.signal.removeEventListener("abort", this.onAbort);
    this.tcp.removeListener("data", this.onData);
    this.tcp.removeListener("close", this.onClose);
    this.tcp.removeListener("error", this.onError);
    if (this.waiter) {
      const waiter = this.waiter;
      this.waiter = null;
      waiter.reject(this.stopped ?? new ArdStopped("closed"));
    }
  }

  private stop(kind: ArdStopped["kind"]): void {
    if (this.stopped) return;
    this.stopped = new ArdStopped(kind);
    const waiter = this.waiter;
    this.waiter = null;
    waiter?.reject(this.stopped);
  }

  private pump(): void {
    if (!this.waiter || this.buf.length < this.waiter.n) return;
    const { n, resolve } = this.waiter;
    this.waiter = null;
    const out = this.buf.subarray(0, n);
    this.buf = this.buf.subarray(n);
    resolve(Buffer.from(out));
  }
}

async function readReason(reader: RfbReader): Promise<string> {
  const len = (await reader.take(4)).readUInt32BE(0);
  if (len > 1024) throw new ArdFramingError("RFB security failure reason too long");
  if (len === 0) return "";
  return (await reader.take(len)).toString("latin1").slice(0, 128);
}

/** RFB 3.8 server, one security type (None), SecurityResult OK. 18 bytes, constant. */
export const ARD_BROWSER_GREETING: Buffer = Buffer.concat([
  Buffer.from("RFB 003.008\n", "ascii"),
  Buffer.from([1, DESKTOP_INNER_RFB_SCHEME.ard]),
  Buffer.from([0, 0, 0, 0]),
]);

const ARD_BROWSER_REPLY_PREFIX = Buffer.concat([
  Buffer.from("RFB 003.008\n", "ascii"),
  Buffer.from([DESKTOP_INNER_RFB_SCHEME.ard]),
]);

/**
 * noVNC answers the greeting with 14 bytes: version, its None choice, and ClientInit.
 * The first 13 are checked. All 14 are dropped — the Mac already has ClientInit
 * from this connector — and every later byte is returned unchanged.
 */
export function createArdBrowserReplyFilter(): (chunk: Buffer) => Buffer | "mismatch" {
  let seen = 0;
  return (chunk) => {
    let i = 0;
    while (seen < 14 && i < chunk.length) {
      if (seen < ARD_BROWSER_REPLY_PREFIX.length && chunk[i] !== ARD_BROWSER_REPLY_PREFIX[seen]) {
        return "mismatch";
      }
      seen += 1;
      i += 1;
    }
    return chunk.subarray(i);
  };
}
