// packages/channel-relay/src/desktop/desktop-tunnel-runtime.ts
// Connector-side desktop tunnel: answers `instance.desktop.prepare` by probing
// the loopback RFB server, then bridges 127.0.0.1:<port> to the hub's binary
// `/desktop/instance` WebSocket. One stream at a time (v1 single-viewer);
// closing the stream only drops the TCP/tunnel, never the system VNC server.

import net from "node:net";
import WebSocket from "ws";

import {
  DESKTOP_BUFFERED_HARD_CLOSE_BYTES,
  DESKTOP_BUFFERED_SOFT_PAUSE_BYTES,
  DESKTOP_TCP_CHUNK_BYTES,
  DESKTOP_WS_MAX_PAYLOAD_BYTES,
  MSG,
  errorPayload,
  parseControlPayload,
  parseDesktopEventPayload,
  type DesktopPrepareResult,
  type RelayEnvelope,
} from "@ganglion/xacpx-relay-protocol";

import type { RelayDesktopConfig } from "../config.js";
import { desktopSetupGuidance } from "./platform-guidance.js";
import { parseBanner, probeLoopbackRfb, RFB_LOOPBACK_HOST } from "./rfb-probe.js";

export interface DesktopTunnelDeps {
  config: RelayDesktopConfig;
  /** Hub base URL (ws:// or wss://), reused to dial `/desktop/instance`. */
  hubUrl: string;
  createSocket?: (url: string, options: WebSocketConnectOptions) => WebSocket;
  /**
   * Channel logger. `info`/`warn` are opt-in here: the caller (ChannelStartInput)
   * always provides them, but a caller that only implements `error` — as test
   * doubles do — must still typecheck. Call sites guard on the method, so a
   * partial logger cannot crash the runtime.
   */
  logger?: {
    info?(event: string, message: string, context?: Record<string, unknown>): void;
    warn?(event: string, message: string, context?: Record<string, unknown>): void;
    error(event: string, message: string, context?: Record<string, unknown>): void;
  };
  platform?: NodeJS.Platform;
}

/**
 * Client-side options for the hub binary socket. `maxPayload` is the PARSER
 * gate: without it `ws`'s client default allows a 100 MiB message, so the
 * in-`message` size check below only runs after the oversized frame is already
 * fully buffered. Passing the same limit the hub enforces (see the hub's
 * DESKTOP_WS_MAX_PAYLOAD_BYTES server options) makes an errant/compromised hub
 * close the socket at the parser instead of forcing the allocation.
 */
export interface WebSocketConnectOptions {
  maxPayload: number;
}

interface ActiveTunnel {
  streamId: string;
  ticket: string;
  socket: WebSocket;
  tcp: net.Socket;
  closed: boolean;
}

/**
 * A prepare that has been admitted but has not yet published `active`.
 *
 * Between the hub's `desktopPrepare` and the moment `active` is set, this
 * runtime awaits an unbounded sequence of I/O: loopback probe, TCP connect,
 * banner preflight, hub upgrade. During that window the descriptor holds NO
 * lifecycle state at all, so `closeAll()` (logout / stop / disconnect) and
 * `handleCancel()` could not touch it — the prepare kept running and published
 * an orphan tunnel after the connector had already cleared its runtime. The
 * generation is bumped on every lifecycle transition so a stale prepare can
 * detect it and drop out instead of publishing.
 *
 * The controller matters as much as the generation: the generation can only
 * stop the *next step*, while every socket already in flight needs its I/O
 * torn down now. Without it a `closeAll()` during the hub upgrade returns
 * while a `/desktop/instance` dial lives on for up to connectTimeoutMs
 * (10s), which is exactly the "connector already logged out but still holds a
 * hub socket" window.
 */
interface PendingTunnel {
  streamId: string;
  ticket: string;
  generation: number;
  /** Set once the tunnel publishes `active`, so teardown can find its sockets. */
  tunnel: ActiveTunnel | null;
  /** Closes every socket already opened for this attempt, in reverse order. */
  abort(): void;
  /** Signals the in-flight probe/dial to stop as soon as it next checks. */
  signal: AbortSignal;
  /** Set by abort(); observed by probe + dial to cut their I/O immediately. */
  readonly retired: boolean;
}

/** A socket owned by an in-flight prepare, tagged so teardown closes it right. */
type OpenedSocket = { kind: "tcp"; sock: net.Socket } | { kind: "ws"; sock: WebSocket };

function toBinaryWsUrl(hubUrl: string, ticket: string): string {
  const url = new URL(hubUrl);
  url.protocol = url.protocol === "wss:" ? "wss:" : "ws:";
  url.pathname = "/desktop/instance";
  url.search = `?ticket=${encodeURIComponent(ticket)}`;
  url.hash = "";
  return url.toString();
}

export class DesktopTunnelRuntime {
  private active: ActiveTunnel | null = null;
  /**
   * Prepares admitted but not yet published to `active`. Keyed by streamId so
   * `handleCancel()` can target one, and iterated wholesale by `closeAll()`.
   */
  private pending = new Map<string, PendingTunnel>();
  /**
   * Monotonic lifecycle epoch. `closeAll()` bumps it, which instantly
   * invalidates every in-flight prepare (each records the value it started
   * with and re-checks after every await). A plain AbortController would not
   * cover the synchronous run between the last await and `active = tunnel`.
   */
  private generation = 0;

  constructor(private readonly deps: DesktopTunnelDeps) {}

  get activeStreamId(): string | null {
    return this.active?.streamId ?? null;
  }

  /** Connector dispatch arm for `instance.desktop.prepare` (hub → connector req). */
  async handlePrepare(envelope: RelayEnvelope, respond: (payload: unknown) => void): Promise<boolean> {
    if (envelope.type !== MSG.desktopPrepare) return false;
    const input = parseControlPayload(MSG.desktopPrepare, envelope.payload);
    if (!input) {
      respond(errorPayload("desktop-protocol-error", "malformed desktop prepare payload"));
      return true;
    }
    const config = this.deps.config;
    if (!config.enabled) {
      respond(errorPayload("desktop-disabled", "desktop is not enabled on this instance"));
      return true;
    }
    // `maxStreams: 1` must gate the WHOLE prepare, not only the published
    // tunnel: without this, a second viewer could slip its own probe/tunnel in
    // while the first is still dialing (`active` is still null), and both would
    // fight over the slot at publish time.
    if (this.active && !this.active.closed) {
      respond(errorPayload("desktop-busy", "another desktop viewer is active"));
      return true;
    }
    if (this.pending.size > 0) {
      respond(errorPayload("desktop-busy", "another desktop viewer is being prepared"));
      return true;
    }
    const generation = this.generation;
    // One controller per attempt. It drives three things that the generation
    // alone cannot: the loopback probe's own dial, the banner preflight read,
    // and the hub upgrade's in-flight socket.
    const controller = new AbortController();
    // Sockets opened by this attempt, in the order they are opened. Typed as a
    // tagged pair so teardown can call the right method per kind: net.Socket
    // has destroy(), ws.WebSocket has close() (and only an optional destroy()).
    const opened: OpenedSocket[] = [];
    let retired = false;
    const pending: PendingTunnel = {
      streamId: input.streamId,
      ticket: input.ticket,
      generation,
      tunnel: null,
      get signal() { return controller.signal; },
      get retired() { return retired; },
      abort() {
        retired = true;
        controller.abort();
        // Close in reverse order of opening: the hub plane first (the ticket the
        // hub considers consumed is the one that matters most), then the
        // loopback TCP. `splice` empties the array so a second abort is inert.
        for (const entry of opened.splice(0).reverse()) {
          try {
            if (entry.kind === "tcp") entry.sock.destroy();
            else entry.sock.close();
          } catch { /* gone */ }
        }
      },
    };
    this.pending.set(input.streamId, pending);
    // `retired` is the ONLY flag that may suppress `respond`: after a lifecycle
    // event has bumped the generation, or the hub cancelled this streamId,
    // answering is pointless — the hub's state no longer matches this attempt
    // and a success there would look like a live tunnel.
    const isRetired = (): boolean =>
      this.generation !== generation || !this.pending.get(input.streamId) ||
      this.pending.get(input.streamId)?.generation !== generation;
    let security: DesktopPrepareResult["security"] | null = null;
    try {
      const verdict = await probeLoopbackRfb({
        port: config.port,
        connectTimeoutMs: config.connectTimeoutMs,
        signal: pending.signal,
      });
      // A lifecycle event (logout / stop / disconnect / cancel) landed during
      // the probe: drop out instead of opening sockets nobody owns.
      if (isRetired()) return true;
      if (!verdict.ok) {
        const guidance = desktopSetupGuidance(this.deps.platform ?? process.platform, verdict.code, config.port);
        // The server's own words matter here: an operator reading the log needs
        // to see what the RFB server said, not just that the connector refused it.
        this.deps.logger?.error("relay.desktop.probe_rejected", "loopback RFB probe failed", {
          streamId: input.streamId,
          code: verdict.code,
          detail: verdict.detail,
        });
        respond(errorPayload(verdict.code, `${verdict.detail}. ${guidance}`));
        return true;
      }
      // `info` is optional in the dep type (see DesktopTunnelDeps.logger), so a
      // test double that only implements `error` still typechecks and just omits
      // this. The channel always supplies it.
      this.deps.logger?.info?.("relay.desktop.probe_ok", "loopback RFB probe accepted", {
        streamId: input.streamId,
        security: verdict.security,
      });
      security = verdict.security;
      await this.openTunnel(input.streamId, input.ticket, generation, pending, opened);
      if (isRetired()) return true;
    } catch (err) {
      if (!isRetired()) {
        this.deps.logger?.error("relay.desktop.tunnel_failed", "desktop tunnel failed", {
          streamId: input.streamId,
          detail: err instanceof Error ? err.message : String(err),
        });
        respond(errorPayload("desktop-stream-timeout", err instanceof Error ? err.message : "desktop tunnel failed"));
      }
      return true;
    } finally {
      if (this.pending.get(input.streamId) === pending) this.pending.delete(input.streamId);
    }
    if (!security) {
      respond(errorPayload("desktop-protocol-error", "desktop probe returned no security verdict"));
      return true;
    }
    const result: DesktopPrepareResult = { streamId: input.streamId, security };
    respond(result);
    return true;
  }

  /** Connector dispatch arm for `instance.desktop.cancel` (hub → connector event). */
  handleCancel(envelope: RelayEnvelope): boolean {
    if (envelope.type !== MSG.desktopCancel) return false;
    const input = parseDesktopEventPayload(MSG.desktopCancel, envelope.payload);
    if (!input) return true;
    // A cancelled stream can still be mid-dial: `active` is only set after the
    // whole probe + connect + upgrade chain. Dropping it from `pending` is what
    // makes the in-flight prepare observe the cancel (via `retired()`), so the
    // hub must not receive a success for a stream it already cancelled.
    const pendingTunnel = this.pending.get(input.streamId);
    if (pendingTunnel) {
      this.pending.delete(input.streamId);
      pendingTunnel.abort();
      return true;
    }
    if (this.active?.streamId === input.streamId) this.closeActive("cancel");
    return true;
  }

  /** Control-socket drop / stop / logout: no tunnel may survive the connector. */
  closeAll(reason = "connector-stop"): void {
    // Invalidate in-flight prepares FIRST: bumping the generation makes every
    // already-admitted prepare retire regardless of where it is awaiting, so
    // none of them can publish an orphan tunnel behind this teardown.
    this.generation += 1;
    for (const pendingTunnel of this.pending.values()) pendingTunnel.abort();
    this.pending.clear();
    this.closeActive(reason);
  }

  private async openTunnel(
    streamId: string,
    ticket: string,
    generation: number,
    pending: PendingTunnel,
    sockets: OpenedSocket[],
  ): Promise<void> {
    const config = this.deps.config;
    const tcp = net.createConnection({ host: RFB_LOOPBACK_HOST, port: config.port });
    // Publish to the pending record the instant the socket exists: an abort
    // that lands between here and the first await must still close it.
    sockets.push({ kind: "tcp", sock: tcp });
    // Any throw below must not leak the loopback socket: openHubSocket can
    // reject after the banner was already read (hub down / bad ticket).
    // closeActive only drops this.active, so destroy explicitly on failure.
    await new Promise<void>((resolve, reject) => {
      // An abort that lands mid-connect cuts the dial immediately instead of
      // leaving the socket alive until connectTimeoutMs fires.
      const timer = setTimeout(() => {
        tcp.destroy();
        reject(new Error(`RFB connect timed out after ${config.connectTimeoutMs}ms`));
      }, config.connectTimeoutMs);
      pending.signal.addEventListener("abort", () => {
        clearTimeout(timer);
        tcp.destroy();
        reject(new Error(`desktop tunnel retired before open (${streamId})`));
      }, { once: true });
      tcp.once("connect", () => {
        clearTimeout(timer);
        resolve();
      });
      tcp.once("error", (err) => {
        clearTimeout(timer);
        reject(err instanceof Error ? err : new Error(String(err)));
      });
    });
    // Re-verify ONLY the 12-byte server banner on the real tunnel socket: the
    // probe ran earlier and the port may have been rebound since. Never forward
    // non-RFB bytes — but never consume security state either: noVNC owns the
    // full handshake (client version + security negotiation) on this socket.
    // Reading past the banner here would race noVNC for the SecurityTypes.
    // Pause BEFORE reading so nothing past the banner can slip through
    // between the banner reader's removeListener and the collector below.
    tcp.pause();
    let serverBanner: Buffer;
    try {
      const banner = await readTunnelBanner(tcp, config.connectTimeoutMs, pending.signal);
      // The lifecycle can also change during the preflight: closeAll() may have
      // destroyed this very tcp, in which case readTunnelBanner resolves null
      // (or rejects on abort) and we must not go on to dial the hub plane.
      if (this.generation !== generation || this.pending.get(streamId) !== pending) {
        tcp.destroy();
        throw new Error(`desktop tunnel retired before open (${streamId})`);
      }
      if (!banner) {
        if (pending.signal.aborted) {
          throw new Error(`desktop tunnel retired before open (${streamId})`);
        }
        throw new Error("RFB server banner changed before tunnel start");
      }
      serverBanner = banner;
    } catch (err) {
      tcp.destroy();
      throw err;
    }
    // Any server bytes that arrive while the hub WS dials (starting with the
    // banner noVNC must see) are buffered in order and replayed once the
    // binary plane is up. Nothing is consumed.
    const earlyChunks: Buffer[] = serverBanner.length > 0 ? [serverBanner] : [];
    tcp.on("data", (chunk: Buffer) => {
      earlyChunks.push(chunk);
    });
    const url = toBinaryWsUrl(this.deps.hubUrl, ticket);
    // The hub socket is created and IMMEDIATELY published to the pending
    // record, before awaiting the upgrade. That ordering is the whole point:
    // while `ws`'s upgrade is in flight (up to connectTimeoutMs = 10s) the
    // object already exists, and a `closeAll()`/`handleCancel()` landing in
    // that window must close it now — not wait for the upgrade to settle or
    // time out. Registering only after the await left precisely that hole.
    const createSocket = this.deps.createSocket
      ?? ((u: string, options: WebSocketConnectOptions) => new WebSocket(u, options));
    let socket: WebSocket;
    // Temporary error swallow covering the gap before openHubSocket attaches its
    // own one-shot 'error' listener. `ws` emits 'error' on a rejected upgrade,
    // and an emitter 'error' with no listener throws — which `bun test` would
    // attribute to this file. Detached inside openHubSocket on first settle.
    const guard = () => {};
    try {
      socket = createSocket(url, { maxPayload: DESKTOP_WS_MAX_PAYLOAD_BYTES });
      socket.on("error", guard);
    } catch (err) {
      tcp.removeAllListeners("data");
      tcp.destroy();
      throw err instanceof Error ? err : new Error(String(err));
    }
    sockets.push({ kind: "ws", sock: socket });
    try {
      await openHubSocket(socket, pending.signal, config.connectTimeoutMs);
    } catch (err) {
      tcp.removeAllListeners("data");
      tcp.destroy();
      throw err;
    }
    // LAST lifecycle check before publishing. Between the await above and this
    // line nothing yields, but closeAll()/handleCancel() can have run in an
    // earlier task and left the attempt retired; publishing then would install
    // a tunnel whose owner is gone and that nobody will ever close.
    if (this.generation !== generation || this.pending.get(streamId) !== pending) {
      // The abort already destroyed these sockets (openHubSocket detaches its
      // one-shot listeners on settle), so nothing survives this teardown.
      try { socket.close(); } catch { /* gone */ }
      try { tcp.destroy(); } catch { /* gone */ }
      throw new Error(`desktop tunnel retired before open (${streamId})`);
    }
    const tunnel: ActiveTunnel = { streamId, ticket, socket, tcp, closed: false };
    this.active = tunnel;
    pending.tunnel = tunnel;
    tcp.removeAllListeners("data");
    tcp.resume();
    // Replay what the banner preflight consumed, IN ORDER, before live
    // forwarding resumes: the hub socket just opened, so forwardToWs now
    // delivers. Without this noVNC never sees "RFB 003.xxx" and both sides
    // deadlock (server waits for the client version, noVNC waits for banner).
    for (const replay of earlyChunks) {
      forwardToWs(socket, tcp, replay);
    }
    // Every transport listener below targets THIS tunnel object, never whatever
    // `this.active` happens to be when the event lands. A is registered while
    // active; a close/cancel then clears `active` and starts closing A's
    // sockets; a reconnect can publish B before A's close handshake completes.
    // A's late `close`/`error` must not find `this.active === B` and tear down a
    // healthy replacement, so the guard is object identity, not stream name.
    socket.on("message", (data, isBinary) => {
      if (tunnel.closed) return;
      if (!isBinary || !(data instanceof Buffer)) {
        this.closeTunnel(tunnel, "text-frame");
        return;
      }
      if (data.byteLength === 0 || data.byteLength > DESKTOP_WS_MAX_PAYLOAD_BYTES) {
        this.closeTunnel(tunnel, "oversize-frame");
        return;
      }
      const ok = tcp.write(data);
      // Only wait for drain when the socket actually applied backpressure.
      // Registering a one-shot listener on every frame leaks: with a healthy
      // loopback RFB server write() keeps returning true, no drain ever fires,
      // and a long session trips MaxListenersExceededWarning while holding the
      // references alive.
      if (!ok) {
        socket.pause?.();
        tcp.once("drain", () => {
          try { (socket as { resume?: () => void }).resume?.(); } catch { /* gone */ }
        });
      }
    });
    // A persistent error swallow MUST exist alongside the close handler: the
    // `ws` client emits 'error' (with a bare ErrorEvent) before 'close' on
    // every abnormal shutdown, and an 'error' with no listener throws — which
    // under `bun test` fails the entire file even when the close is handled.
    socket.on("error", () => {});
    socket.on("close", () => this.closeTunnel(tunnel, "hub-close"));
    socket.on("error", () => this.closeTunnel(tunnel, "hub-error"));
    tcp.on("data", (chunk: Buffer) => {
      if (tunnel.closed) return;
      forwardToWs(socket, tcp, chunk);
    });
    tcp.on("error", () => this.closeTunnel(tunnel, "rfb-error"));
    tcp.on("close", () => this.closeTunnel(tunnel, "rfb-close"));
  }

  /**
   * Close a specific tunnel if it is still THE active one and has not already
   * been torn down. Callers must pass the tunnel they hold a reference to —
   * taking no argument would read `this.active`, which by the time a late
   * event arrives may be a different, healthy tunnel.
   */
  private closeTunnel(tunnel: ActiveTunnel, reason: string): void {
    if (this.active !== tunnel || tunnel.closed) return;
    this.closeActive(reason);
  }

  private closeActive(reason: string): void {
    const tunnel = this.active;
    if (!tunnel || tunnel.closed) return;
    tunnel.closed = true;
    this.active = null;
    void reason;
    try { tunnel.tcp.destroy(); } catch { /* gone */ }
    try { tunnel.socket.close(); } catch { /* gone */ }
  }
}

function forwardToWs(socket: WebSocket, tcp: net.Socket, chunk: Buffer): void {
  if (socket.readyState !== WebSocket.OPEN) return;
  if (socket.bufferedAmount > DESKTOP_BUFFERED_HARD_CLOSE_BYTES) {
    tcp.destroy();
    try { socket.close(); } catch { /* gone */ }
    return;
  }
  // Slice into protocol chunks so one TCP burst cannot exceed the frame gate.
  for (let offset = 0; offset < chunk.byteLength; offset += DESKTOP_TCP_CHUNK_BYTES) {
    const piece = chunk.subarray(offset, Math.min(offset + DESKTOP_TCP_CHUNK_BYTES, chunk.byteLength));
    try {
      socket.send(piece, { binary: true });
    } catch {
      tcp.destroy();
      return;
    }
  }
  if (socket.bufferedAmount > DESKTOP_BUFFERED_SOFT_PAUSE_BYTES) {
    tcp.pause();
    const resume = () => {
      if (socket.readyState !== WebSocket.OPEN) return;
      if (socket.bufferedAmount <= DESKTOP_BUFFERED_SOFT_PAUSE_BYTES) tcp.resume();
      else setTimeout(resume, 50).unref?.();
    };
    setTimeout(resume, 50).unref?.();
  }
}

/**
 * Read exactly the 12-byte RFB server banner off a connected tunnel socket.
 * Returns the banner bytes (kept for verbatim replay to noVNC) or null when
 * the peer is not speaking RFB. Never reads past byte 12: security-type bytes
 * belong to noVNC's handshake, not to this preflight.
 *
 * The 2s cap is an independent hard bound, not the configured timeout: a
 * loopback server that has accepted the TCP connection has no reason to sit on
 * 12 banner bytes, and a stalled one must not hold the whole prepare open for
 * the full connectTimeoutMs. So a configured 5000ms buys the probe a full 5s but
 * buys this read 2s at most — that asymmetry is part of the documented contract.
 */
async function readTunnelBanner(
  tcp: net.Socket,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<Buffer | null> {
  return new Promise<Buffer | null>((resolve) => {
    const chunks: Buffer[] = [];
    let done = false;
    const finish = (value: Buffer | null) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      tcp.removeListener("data", onData);
      tcp.pause();
      resolve(value);
    };
    const timer = setTimeout(() => finish(null), Math.min(timeoutMs, 2000));
    const onData = (chunk: Buffer) => {
      chunks.push(chunk);
      const buffered = Buffer.concat(chunks);
      if (buffered.length < 12) return;
      finish(parseBanner(new Uint8Array(buffered.subarray(0, 12))) ? buffered.subarray(0, 12) : null);
    };
    // Abort resolves null (not reject) so the caller's single catch path handles
    // both "server never spoke" and "we gave up"; the caller checks the signal
    // to tell them apart.
    const onAbort = () => finish(null);
    if (signal) {
      if (signal.aborted) {
        finish(null);
        return;
      }
      signal.addEventListener("abort", onAbort, { once: true });
    }
    // The socket is paused by the caller, but 'data' was attached while
    // flowing semantics still apply to already-buffered kernel data: resume
    // once so the banner arrives, then finish() re-pauses immediately.
    tcp.on("data", onData);
    tcp.resume();
    // Safety: if the banner never arrives, finish(null) via the timer above.
  });
}

/**
 * Await the upgrade of an ALREADY-CREATED hub socket.
 *
 * The socket is owned by the caller's pending record from the moment it is
 * constructed, so abort closes the socket directly; this helper only has to
 * stop waiting and detach its one-shot listeners. That split is what lets a
 * `closeAll()` during the dial tear the hub plane down immediately instead of
 * leaving it alive for up to `timeoutMs`.
 */
async function openHubSocket(
  socket: WebSocket,
  signal: AbortSignal,
  timeoutMs: number,
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    let settled = false;
    // A temporary swallow covers the gap before the once-listeners below; it is
    // detached on first settle so the tunnel's own persistent handler is the
    // only 'error' listener afterwards.
    const guard = () => {};
    socket.on("error", guard);
    const detach = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      socket.removeListener("error", guard);
      socket.removeListener("error", onError as (...args: unknown[]) => void);
      socket.removeListener("close", onClose);
    };
    // One-shot listeners MUST all detach on first settle: `ws` emits BOTH error
    // and close for an upgrade rejection, so without detach the second event
    // re-rejects an already-settled promise (unhandled).
    const onError = (err: unknown) => {
      if (settled) return;
      settled = true;
      detach();
      reject(err instanceof Error ? err : new Error(describeHubSocketError(err)));
    };
    const onClose = () => {
      if (settled) return;
      settled = true;
      detach();
      reject(new Error("desktop hub socket closed before open"));
    };
    const onAbort = () => {
      if (settled) return;
      settled = true;
      detach();
      // The pending abort already closed this socket; this only stops the wait.
      try { socket.close(); } catch { /* gone */ }
      reject(new Error("desktop hub socket retired before open"));
    };
    const timer = setTimeout(() => {
      try { socket.close(); } catch { /* gone */ }
      reject(new Error(`desktop hub socket timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    signal.addEventListener("abort", onAbort, { once: true });
    socket.once("open", () => {
      if (settled) return;
      settled = true;
      detach();
      resolve();
    });
    socket.once("error", onError);
    socket.once("close", onClose);
  });
}

/**
 * Best-effort human rendering of a ws failure: the `ws` package reports
 * upgrade rejections (e.g. hub-side 4403 for a bad ticket) as a bare
 * ErrorEvent with no message, which otherwise surfaces as
 * `[object ErrorEvent]` in prepare results.
 */
function describeHubSocketError(err: unknown): string {
  if (!err || typeof err !== "object") return String(err);
  const record = err as Record<string, unknown>;
  const message = typeof record.message === "string" && record.message ? record.message : "";
  const type = typeof record.type === "string" ? record.type : "error";
  // The failed socket's URL carries the single-use connector ticket. Never echo
  // it: this string lands in the prepare result the browser displays and in
  // hub logs, and an unconsumed ticket must not travel along the control path.
  // Origin + path is enough to diagnose which listener/route refused.
  const target = (record.target as Record<string, unknown> | undefined)?.url;
  const location = typeof target === "string" ? safeSocketLocation(target) : "";
  const code = location ? ` (${location})` : "";
  return message ? `${type}: ${message}${code}` : `hub websocket ${type} during upgrade${code}`;
}

/** Origin+path only: drops the `?ticket=…` query of a ws URL. */
function safeSocketLocation(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.origin}${parsed.pathname}`;
  } catch {
    return "";
  }
}

/** Test-only surface for the ticket scrub (module-private otherwise). */
export function describeHubSocketErrorForTests(err: unknown): string {
  return describeHubSocketError(err);
}
