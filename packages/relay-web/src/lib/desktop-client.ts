// Thin noVNC lifecycle wrapper: the RFB client owns keyboard/mouse/framebuffer
// against an already-open binary WebSocket. noVNC is lazy-loaded so the main
// bundle never pays for VNC until the user opens a Desktop tab.
import { DESKTOP_INNER_RFB_SCHEME, type DesktopSecurityKind } from "@ganglion/xacpx-relay-protocol";
import {
  DesktopEncodingProbe,
  desktopDiagnosticsEnabled,
} from "./desktop-encoding-diagnostics";

export type DesktopSecurity = DesktopSecurityKind;

/**
 * Smooth-first encoding preferences. noVNC's own defaults are quality 6 and
 * compression 2; smooth-first asks for lower quality / higher compression via
 * the public properties (they re-send SetEncodings while connected).
 *
 * These are REQUESTS only: whether the RFB server honours the pseudo-encodings
 * is untested (未实测). macOS in particular is not known to negotiate
 * Tight/JPEG. See docs/desktop-rfb-setup.md for how to observe what the server
 * actually used.
 */
const SMOOTH_QUALITY_LEVEL = 3;
const SMOOTH_COMPRESSION_LEVEL = 7;
/** noVNC 1.7.0 defaults, restored when smooth-first is switched OFF. */
const DEFAULT_QUALITY_LEVEL = 6;
const DEFAULT_COMPRESSION_LEVEL = 2;

/**
 * Console report for the opt-in encoding probe: which encodings the server
 * actually used, plus the requested smooth-first state. Counts only — no pixel
 * bytes, no credentials, no URL/ticket.
 */
function reportEncodingSummary(probe: DesktopEncodingProbe, smoothFirst: boolean): void {
  const summary = probe.summary(smoothFirst);
  if (!summary.available) {
    console.info("xacpx desktop encoding diagnostics unavailable:", summary.unavailableReason);
    return;
  }
  console.info("xacpx desktop encoding diagnostics", {
    smoothFirstRequested: summary.smoothFirst,
    qualityLevel: summary.qualityLevel,
    compressionLevel: summary.compressionLevel,
    rects: summary.rects,
    encodings: summary.encodings,
  });
}

export interface DesktopSecurityFailure {
  /** noVNC's SecurityResult status, when it supplied one. */
  status?: number;
  /** Server-provided text; optional and language-unspecified by noVNC's API. */
  reason?: string;
  /**
   * True once a VncAuth password was actually submitted. Distinguishes a
   * rejected PASSWORD (after submission) from the server refusing at the
   * security-scheme stage before any credentials existed — noVNC emits the same
   * event and sets the same `status` for both.
   */
  credentialsSubmitted?: boolean;
}

export interface DesktopRfbHooks {
  onConnect?: () => void;
  onDisconnect?: (detail: { clean: boolean; reason: string }) => void;
  onCredentialsRequired?: () => void;
  onSecurityFailure?: (failure: DesktopSecurityFailure) => void;
}

export interface DesktopRfbConnection {
  sendCredentials(password: string): void;
  setScaleViewport(fit: boolean): void;
  /**
   * Request smooth-first encoding preferences. ON writes the public
   * `qualityLevel` / `compressionLevel` properties (which re-sends SetEncodings
   * while connected); OFF restores noVNC's own defaults. Both are REQUESTS:
   * whether the RFB server honours them is untested (未实测).
   */
  setSmoothFirst(smooth: boolean): void;
  dispose(): void;
}

/**
 * noVNC 1.7.0's public `sendCredentials` contract takes a credentials OBJECT —
 * `RFB.sendCredentials(creds)` assigns `this._rfbCredentials = creds`, and every
 * security handler reads named fields off it (`_rfbCredentials.password` for
 * standard VncAuth DES, `.username` for Plain/MSLogonII/ARD). Passing a bare
 * string leaves `.password === undefined`, so noVNC re-fires
 * `credentialsrequired` forever and the auth challenge never completes.
 */
export interface NoVncCredentials {
  password?: string;
  username?: string;
}

export interface NoVncRfb {
  addEventListener(type: string, listener: (event: Record<string, unknown>) => void): void;
  removeEventListener(type: string, listener: (event: Record<string, unknown>) => void): void;
  sendCredentials(credentials: NoVncCredentials): void;
  disconnect(): void;
  /** Writable post-construction property (noVNC defaults it to `false`). */
  scaleViewport: boolean;
  /** Writable post-construction properties (noVNC defaults: 6 and 2). Assigning
   *  re-sends SetEncodings while connected, which is how smooth-first is
   *  applied to a live session. */
  qualityLevel: number;
  compressionLevel: number;
}

export type NoVncModule = {
  default?: new (target: HTMLElement, url: string, options: Record<string, unknown>) => NoVncRfb;
  RFB?: new (target: HTMLElement, url: string, options: Record<string, unknown>) => NoVncRfb;
};
export interface DesktopRfbConnectInput {
  url: string;
  security: DesktopSecurity;
  target?: HTMLElement | null;
  /** Apply `scaleViewport = true` once the RFB object exists (default: false). */
  fit?: boolean;
  /** Request smooth-first encoding preferences (default: false = noVNC defaults). */
  smooth?: boolean;
  hooks?: DesktopRfbHooks;
  loadNoVnc?: () => Promise<NoVncModule>;
}
async function defaultLoadNoVnc(): Promise<NoVncModule> {
  const mod = (await import("@novnc/novnc")) as unknown as NoVncModule;
  return mod;
}

export function connectDesktopRfb(input: DesktopRfbConnectInput): DesktopRfbConnection {
  const hooks = input.hooks ?? {};
  let rfb: NoVncRfb | null = null;
  let disposed = false;
  let connected = false;
  // Desired fit state. Seeded from the initial request so an RFB object created
  // later reflects it, and updated by setScaleViewport() BEFORE the module
  // resolves so a click that lands during the import is not overwritten by the
  // stale construction-time snapshot.
  let desiredFit = input.fit ?? false;
  // Desired smooth-first state, seeded exactly like `desiredFit` so a toggle
  // that lands during the module import is not overwritten by the
  // construction-time snapshot.
  let desiredSmooth = input.smooth ?? false;
  // Opt-in encoding diagnostic. Installed only when the localStorage flag is
  // set, and only after the internals check passes — never on the connection
  // path, never able to break the session.
  let probe: DesktopEncodingProbe | null = null;

  const target = input.target ?? document.createElement("div");
  if (!input.target) {
    target.style.position = "absolute";
    target.style.inset = "0";
    target.style.width = "100%";
    target.style.height = "100%";
  }

  const listeners: Array<[string, (event: Record<string, unknown>) => void]> = [];
  const on = (type: string, listener: (event: Record<string, unknown>) => void) => {
    listeners.push([type, listener]);
    rfb?.addEventListener(type, listener);
  };

  // Whether the user actually submitted a VncAuth password. A `securityfailure`
  // BEFORE this point is the server refusing at the SCHEME stage (RFB 3.3
  // security type 0, or a 3.7+ security-types failure) and says nothing about
  // credentials — noVNC sets the same `status` on both, so the phase, not the
  // presence of a status, is what distinguishes them.
  let credentialsSubmitted = false;
  void (input.loadNoVnc ?? defaultLoadNoVnc)().then((mod) => {
    if (disposed) return;
    const Ctor = mod.default ?? mod.RFB;
    if (!Ctor) {
      hooks.onSecurityFailure?.({ reason: "noVNC failed to load" });
      return;
    }
    // Tight (16) sub-auth can select STDVNOAUTH__ (no auth): the probe
    // fail-closes Tight-only servers, but a server offering BOTH 2 and 16
    // would still let stock noVNC pick 16 first (server order) and walk into
    // sub-auth. Constrain the tunneled session to outer VncAuth (2) so the
    // probe verdict binds the real connection: patch the instance's
    // _isSupportedSecurityType before the handshake runs (the RFB object is
    // already constructed; the option bag is not consulted during Security).
    const inner = DESKTOP_INNER_RFB_SCHEME[input.security];
    const rfbInstance = new Ctor(target, input.url, {
      credentials: {},
      repeaterID: "",
      shared: true,
      wsProtocols: ["binary"],
    });
    // Fit is a post-construction writable property on noVNC 1.7.0 — the option
    // bag does not accept it, and the property default is `false`. Apply the
    // CURRENT desired value only: `input.fit` is the construction-time snapshot
    // and must not override a toggle that landed while we were importing.
    try { rfbInstance.scaleViewport = desiredFit; } catch { /* older build: leave as-is */ }
    // Smooth-first is requested through the public properties only when it is
    // ON. OFF writes nothing at all, so the noVNC defaults stay untouched.
    if (desiredSmooth) {
      try { rfbInstance.qualityLevel = SMOOTH_QUALITY_LEVEL; } catch { /* older build: leave as-is */ }
      try { rfbInstance.compressionLevel = SMOOTH_COMPRESSION_LEVEL; } catch { /* older build: leave as-is */ }
    }
    if (desktopDiagnosticsEnabled()) {
      // Opt-in encoding probe. Feature-detected inside: a drift in noVNC's
      // internals leaves the connection untouched and the summary says
      // "unavailable".
      probe = new DesktopEncodingProbe(rfbInstance);
      if (typeof window !== "undefined") {
        const active = probe;
        window.__xacpxDesktopDiag = () => active.summary(desiredSmooth);
      }
    }
    const narrow = rfbInstance as unknown as {
      _isSupportedSecurityType?: (type: number) => boolean;
      _negotiateAuthentication?: () => boolean;
      _fail?: (details: string) => boolean;
      _rfbAuthScheme?: number;
    };
    // Hard dependency on noVNC 1.7.0 internals: if a future upgrade renames
    // or removes these hooks, continuing would silently drop the auth
    // allowlist. Fail closed instead — surface securityfailure now rather
    // than connecting with an unconstrained handshake later.
    if (
      typeof narrow._isSupportedSecurityType !== "function" ||
      typeof narrow._negotiateAuthentication !== "function" ||
      typeof narrow._fail !== "function"
    ) {
      try { rfbInstance.disconnect(); } catch { /* never connected */ }
      hooks.onSecurityFailure?.({ reason: "desktop auth guard unavailable (noVNC internals changed)" });
      return;
    }
    const base = narrow._isSupportedSecurityType.bind(rfbInstance);
    narrow._isSupportedSecurityType = (type: number) => type === inner && base(type);
    // RFB 3.3 never calls _isSupportedSecurityType: the server dictates the
    // u32 scheme and noVNC jumps straight to Authentication. Fail closed on
    // the scheme this stream was opened with, which is None for ARD.
    const baseAuth = narrow._negotiateAuthentication.bind(rfbInstance);
    narrow._negotiateAuthentication = () => {
      if (narrow._rfbAuthScheme !== inner) {
        return narrow._fail?.(`Refusing desktop auth scheme ${String(narrow._rfbAuthScheme)}`) ?? false;
      }
      return baseAuth();
    };
    rfb = rfbInstance;
    on("connect", () => {
      connected = true;
      hooks.onConnect?.();
    });
    on("disconnect", (event) => {
      const clean = connected && event instanceof Object && (event as { detail?: { clean?: boolean } }).detail?.clean !== false;
      const reason = typeof (event as { detail?: unknown }).detail === "string"
        ? String((event as { detail?: unknown }).detail)
        : "disconnected";
      // Opt-in only: the encoding probe is installed solely when the
      // diagnostics flag is set, so a default session logs nothing here.
      if (probe) reportEncodingSummary(probe, desiredSmooth);
      hooks.onDisconnect?.({ clean, reason });
    });
    on("credentialsrequired", () => {
      credentialsSubmitted = true;
      hooks.onCredentialsRequired?.();
    });
    on("securityfailure", (event) => {
      // Structured, not free text. noVNC's `detail` carries the SecurityResult
      // `status` plus a server-supplied `reason` that is optional and whose
      // language is explicitly unspecified, so classifying the reason with a
      // regex over English phrases misreports a rejected password as an
      // unsupported auth scheme as soon as the server localises its message.
      const detail = (event as { detail?: { status?: unknown; reason?: unknown } }).detail;
      const status = typeof detail?.status === "number" ? detail.status : undefined;
      const reason = typeof detail?.reason === "string" && detail.reason.length > 0
        ? detail.reason
        : undefined;
      hooks.onSecurityFailure?.({ status, reason, credentialsSubmitted });
    });
  }).catch((err: unknown) => {
    hooks.onSecurityFailure?.({ reason: err instanceof Error ? err.message : "noVNC failed to load" });
  });

  return {
    sendCredentials(password: string): void {
      // noVNC requires the credentials OBJECT, not a bare string: VncAuth reads
      // `_rfbCredentials.password` to build the DES response.
      credentialsSubmitted = true;
      try { rfb?.sendCredentials({ password }); } catch { /* gone */ }
    },
    setScaleViewport(fit: boolean): void {
      desiredFit = fit;
      if (rfb) {
        try { rfb.scaleViewport = fit; } catch { /* gone */ }
      }
    },
    setSmoothFirst(smooth: boolean): void {
      desiredSmooth = smooth;
      if (!rfb) return;
      // Public writable properties: noVNC re-sends SetEncodings while connected.
      // OFF restores noVNC's own defaults so the toggle is reversible; the
      // setter is a no-op when the value already matches.
      try { rfb.qualityLevel = smooth ? SMOOTH_QUALITY_LEVEL : DEFAULT_QUALITY_LEVEL; } catch { /* gone */ }
      try { rfb.compressionLevel = smooth ? SMOOTH_COMPRESSION_LEVEL : DEFAULT_COMPRESSION_LEVEL; } catch { /* gone */ }
    },
    dispose(): void {
      disposed = true;
      for (const [type, listener] of listeners) {
        try { rfb?.removeEventListener(type, listener); } catch { /* gone */ }
      }
      listeners.length = 0;
      try { rfb?.disconnect(); } catch { /* gone */ }
      rfb = null;
      // Drop the on-demand hook with the connection that installed it, so a
      // later session's probe is never shadowed by a dead one.
      probe = null;
      if (typeof window !== "undefined" && window.__xacpxDesktopDiag) {
        delete window.__xacpxDesktopDiag;
      }
    },
  };
}
