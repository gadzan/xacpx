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

interface NoVncRfb {
  addEventListener(type: string, listener: (event: Record<string, unknown>) => void): void;
  removeEventListener(type: string, listener: (event: Record<string, unknown>) => void): void;
  sendCredentials(password: string): void;
  disconnect(): void;
  scaleViewport: boolean;
}

type NoVncModule = {
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
    rfb = new Ctor(target, input.url, {
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
    for (const [type, listener] of listeners) rfb.addEventListener(type, listener);
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
