export interface WebRuntimeCapabilities {
  multiInstance: boolean;
  pairing: boolean;
  invites: boolean;
  webPush: boolean;
  relayUpdate: boolean;
  agentDirectory: boolean;
  terminal: boolean;
  desktop: boolean;
}

export interface WebRuntimeConfig {
  hostMode: "relay" | "local";
  auth: { required: boolean; mode: "token" | "none" };
  capabilities: WebRuntimeCapabilities;
  defaultInstanceId?: string;
  historyRetention: { mode: "client-side" | "server"; days: number; maxPerSession: number };
}

const RELAY_CAPABILITIES: WebRuntimeCapabilities = {
  multiInstance: true,
  pairing: true,
  invites: true,
  webPush: true,
  relayUpdate: true,
  agentDirectory: true,
  terminal: true,
  desktop: true,
};

const LOCAL_CAPABILITIES: WebRuntimeCapabilities = {
  multiInstance: false,
  pairing: false,
  invites: false,
  webPush: false,
  relayUpdate: false,
  agentDirectory: false,
  terminal: false,
  desktop: false,
};

/** What an older hub (no hostMode) and a failed config request both mean. */
export const LEGACY_RELAY_RUNTIME: WebRuntimeConfig = {
  hostMode: "relay",
  auth: { required: true, mode: "token" },
  capabilities: { ...RELAY_CAPABILITIES },
  historyRetention: { mode: "client-side", days: 30, maxPerSession: 2000 },
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object";
}

function flag(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function capabilitiesFrom(raw: unknown, defaults: WebRuntimeCapabilities): WebRuntimeCapabilities {
  const body = isRecord(raw) ? raw : {};
  return {
    multiInstance: flag(body.multiInstance, defaults.multiInstance),
    pairing: flag(body.pairing, defaults.pairing),
    invites: flag(body.invites, defaults.invites),
    webPush: flag(body.webPush, defaults.webPush),
    relayUpdate: flag(body.relayUpdate, defaults.relayUpdate),
    agentDirectory: flag(body.agentDirectory, defaults.agentDirectory),
    terminal: flag(body.terminal, defaults.terminal),
    desktop: flag(body.desktop, defaults.desktop),
  };
}

function retentionFrom(raw: unknown): WebRuntimeConfig["historyRetention"] {
  const body = isRecord(raw) ? raw : {};
  const days = typeof body.days === "number" ? body.days : 30;
  const maxPerSession = typeof body.maxPerSession === "number" ? body.maxPerSession : 2000;
  return { mode: body.mode === "server" ? "server" : "client-side", days, maxPerSession };
}

/** Accept a current host, an older hub, or garbage. Never throws. */
export function normalizeRuntimeConfig(raw: unknown): WebRuntimeConfig {
  const body = isRecord(raw) ? raw : {};
  if (body.hostMode !== "relay" && body.hostMode !== "local") {
    return {
      ...LEGACY_RELAY_RUNTIME,
      capabilities: { ...RELAY_CAPABILITIES },
      historyRetention: retentionFrom(body.historyRetention),
    };
  }
  const local = body.hostMode === "local";
  const auth = isRecord(body.auth) ? body.auth : {};
  const defaultInstanceId = typeof body.defaultInstanceId === "string" ? body.defaultInstanceId : undefined;
  return {
    hostMode: body.hostMode,
    auth: {
      required: flag(auth.required, !local),
      mode: auth.mode === "none" ? "none" : "token",
    },
    capabilities: capabilitiesFrom(body.capabilities, local ? LOCAL_CAPABILITIES : RELAY_CAPABILITIES),
    ...(defaultInstanceId ? { defaultInstanceId } : {}),
    historyRetention: retentionFrom(body.historyRetention),
  };
}
