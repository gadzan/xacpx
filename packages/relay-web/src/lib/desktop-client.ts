// Thin noVNC lifecycle wrapper: the RFB client owns keyboard/mouse/framebuffer
// against an already-open binary WebSocket. noVNC is lazy-loaded so the main
// bundle never pays for VNC until the user opens a Desktop tab.
export type DesktopSecurity = "vnc-auth" | "ard";

export interface DesktopRfbHooks {
  onConnect?: () => void;
  onDisconnect?: (detail: { clean: boolean; reason: string }) => void;
  onCredentialsRequired?: () => void;
  onSecurityFailure?: (reason: string) => void;
}

export interface DesktopRfbConnection {
  sendCredentials(password: string): void;
  setScaleViewport(fit: boolean): void;
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
  // Desired fit state, kept independent of the RFB object: the module import is
  // async, so a setScaleViewport() call that lands before noVNC loads must not
  // be dropped. noVNC's constructor options do NOT include scaleViewport (it is
  // a writable property defaulting to false), so the value cannot go in the bag.
  let desiredFit = false;

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

  void (input.loadNoVnc ?? defaultLoadNoVnc)().then((mod) => {
    if (disposed) return;
    const Ctor = mod.default ?? mod.RFB;
    if (!Ctor) {
      hooks.onSecurityFailure?.("noVNC failed to load");
      return;
    }
    // Tight (16) sub-auth can select STDVNOAUTH__ (no auth): the probe
    // fail-closes Tight-only servers, but a server offering BOTH 2 and 16
    // would still let stock noVNC pick 16 first (server order) and walk into
    // sub-auth. Constrain the tunneled session to outer VncAuth (2) so the
    // probe verdict binds the real connection: patch the instance's
    // _isSupportedSecurityType before the handshake runs (the RFB object is
    // already constructed; the option bag is not consulted during Security).
    const rfbInstance = new Ctor(target, input.url, {
      credentials: input.security === "ard" ? undefined : {},
      repeaterID: "",
      shared: true,
      wsProtocols: ["binary"],
    });
    // Fit is a post-construction writable property on noVNC 1.7.0 — the option
    // bag does not accept it, and the property default is `false`. Apply the
    // desired value (and anything requested before the import resolved) now.
    if (input.fit) {
      desiredFit = true;
      try { rfbInstance.scaleViewport = true; } catch { /* older build: leave as-is */ }
    }
    if (input.security === "vnc-auth") {
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
        hooks.onSecurityFailure?.("desktop auth guard unavailable (noVNC internals changed)");
        return;
      }
      const base = narrow._isSupportedSecurityType.bind(rfbInstance);
      narrow._isSupportedSecurityType = (type: number) =>
        type === 2 && base(type);
      // RFB 3.3 never calls _isSupportedSecurityType: the server dictates
      // the u32 scheme and noVNC jumps straight to Authentication. A second
      // connection that swaps type 2 for None/Tight after a passing probe
      // (TOCTOU) would otherwise complete with no password. Fail closed on
      // the ACTUAL scheme at Authentication entry, so 3.3 and 3.7+ share
      // one final constraint instead of trusting the probe verdict.
      const baseAuth = narrow._negotiateAuthentication.bind(rfbInstance);
      narrow._negotiateAuthentication = () => {
        if (narrow._rfbAuthScheme !== 2) {
          return narrow._fail?.(
            `Refusing desktop auth scheme ${String(narrow._rfbAuthScheme)} (only outer VncAuth is allowed)`,
          ) ?? false;
        }
        return baseAuth();
      };
    }
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
      hooks.onDisconnect?.({ clean, reason });
    });
    on("credentialsrequired", () => hooks.onCredentialsRequired?.());
    on("securityfailure", (event) => {
      const reason = typeof (event as { detail?: { reason?: string } }).detail?.reason === "string"
        ? String((event as { detail?: { reason?: string } }).detail?.reason)
        : "authentication failed";
      hooks.onSecurityFailure?.(reason);
    });
  }).catch((err: unknown) => {
    hooks.onSecurityFailure?.(err instanceof Error ? err.message : "noVNC failed to load");
  });

  return {
    sendCredentials(password: string): void {
      // noVNC requires the credentials OBJECT, not a bare string: VncAuth reads
      // `_rfbCredentials.password` to build the DES response.
      try { rfb?.sendCredentials({ password }); } catch { /* gone */ }
    },
    setScaleViewport(fit: boolean): void {
      desiredFit = fit;
      if (rfb) {
        try { rfb.scaleViewport = fit; } catch { /* gone */ }
      }
    },
    dispose(): void {
      disposed = true;
      for (const [type, listener] of listeners) {
        try { rfb?.removeEventListener(type, listener); } catch { /* gone */ }
      }
      listeners.length = 0;
      try { rfb?.disconnect(); } catch { /* gone */ }
      rfb = null;
    },
  };
}
