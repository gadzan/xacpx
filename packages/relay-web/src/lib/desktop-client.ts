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

export interface NoVncRfb {
  addEventListener(type: string, listener: (event: Record<string, unknown>) => void): void;
  removeEventListener(type: string, listener: (event: Record<string, unknown>) => void): void;
  sendCredentials(password: string): void;
  disconnect(): void;
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
      scaleViewport: true,
      resizeSession: false,
      viewOnly: false,
      showDotCursor: false,
      background: "rgb(40,40,40)",
      wsProtocols: ["binary"],
    });
    if (input.security === "vnc-auth") {
      const narrow = rfbInstance as unknown as { _isSupportedSecurityType?: (type: number) => boolean };
      const base = narrow._isSupportedSecurityType?.bind(rfbInstance);
      narrow._isSupportedSecurityType = (type: number) =>
        type === 2 && (base ? base(type) : true);
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
      rfb?.sendCredentials(password);
    },
    setScaleViewport(fit: boolean): void {
      if (rfb) rfb.scaleViewport = fit;
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
