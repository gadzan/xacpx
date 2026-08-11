import path from "node:path";

export interface RelayTerminalConfig {
  enabled: boolean;
  backend: "rmux";
  bridgeCommand?: string;
  rmuxCommand?: string;
  idleTimeoutSeconds: number;
  ownerLeaseTtlSeconds: number;
  reconcileIntervalSeconds: number;
  orphanGraceSeconds: number;
  attachmentTtlSeconds: number;
  maxSessions: number;
  maxViewersPerTerminal: number;
  historyLimit: number;
}

export interface RelayChannelConfig {
  url: string;
  pairingToken?: string;
  name?: string;
  /** Always present and frozen after parse; defaults keep terminal disabled. */
  terminal: RelayTerminalConfig;
}

const TERMINAL_DEFAULTS: RelayTerminalConfig = {
  enabled: false,
  backend: "rmux",
  idleTimeoutSeconds: 900,
  ownerLeaseTtlSeconds: 90,
  reconcileIntervalSeconds: 30,
  orphanGraceSeconds: 120,
  attachmentTtlSeconds: 45,
  maxSessions: 16,
  maxViewersPerTerminal: 4,
  historyLimit: 10000,
};

/**
 * Normalize a relay URL input into a full ws(s):// URL.
 *
 * Rules:
 * - Trim. Empty → "".
 * - Already ws:// or wss:// (case-insensitive) → return as-is.
 * - http:// → ws://, https:// → wss:// (map scheme, keep the rest).
 * - No scheme → parse host[:port]:
 *   - Explicit numeric port → ws://<host>:<port>.
 *   - IPv4 literal, "localhost", or bracketed IPv6 → ws://<host>:8787.
 *   - Domain name → wss://<host> (production TLS, no port appended).
 *
 * Port 8787 is the hub's HTTP port: by default the instance gateway is merged
 * onto it (the connector reaches it at the root path). Only when the operator
 * runs a legacy dedicated gateway port do they pass an explicit `host:8788`.
 *
 * Note: bare unbracketed IPv6 (e.g. "::1") is not supported; use "[::1]" instead.
 */
const DEFAULT_GATEWAY_PORT = "8787";
export function normalizeRelayUrl(input: string): string {
  const trimmed = input.trim();
  if (!trimmed) return "";

  // Already ws:// or wss://
  if (/^wss?:\/\//i.test(trimmed)) return trimmed;

  // http:// → ws://, https:// → wss://
  if (/^http:\/\//i.test(trimmed)) return "ws://" + trimmed.slice("http://".length);
  if (/^https:\/\//i.test(trimmed)) return "wss://" + trimmed.slice("https://".length);

  // No scheme — parse host[:port]
  const s = trimmed;

  // Bracketed IPv6: [::1] or [::1]:port
  const bracketMatch = s.match(/^\[([^\]]+)\](?::(\d+))?$/);
  if (bracketMatch) {
    const ipv6 = bracketMatch[1];
    const port = bracketMatch[2];
    if (port) return `ws://[${ipv6}]:${port}`;
    return `ws://[${ipv6}]:${DEFAULT_GATEWAY_PORT}`;
  }

  // Plain host or host:port — split on last colon if followed by all digits
  let host = s;
  let port: string | undefined;
  const idx = s.lastIndexOf(":");
  if (idx > 0 && /^\d+$/.test(s.slice(idx + 1))) {
    host = s.slice(0, idx);
    port = s.slice(idx + 1);
  }

  if (port) {
    // Explicit port → plain ws
    return `ws://${host}:${port}`;
  }

  // No port — decide scheme by host type
  const isIPv4 = /^\d{1,3}(\.\d{1,3}){3}$/.test(host);
  if (isIPv4 || host === "localhost") {
    return `ws://${host}:${DEFAULT_GATEWAY_PORT}`;
  }

  // Domain → wss, port 443 implicit
  return `wss://${host}`;
}

function isIntInRange(value: unknown, min: number, max: number): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= min && value <= max;
}

function requireAbsoluteCommand(field: string, value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`relay channel options.terminal.${field} must be a non-empty absolute path`);
  }
  const trimmed = value.trim();
  // Reject shell-style concatenation / flags; accept only a single absolute path token.
  if (/\s/.test(trimmed) || !path.isAbsolute(trimmed)) {
    throw new Error(`relay channel options.terminal.${field} must be a non-empty absolute path`);
  }
  return trimmed;
}

/** Parse and normalize `options.terminal`; missing/undefined → disabled defaults. */
export function parseRelayTerminalConfig(raw: unknown): RelayTerminalConfig {
  if (raw === undefined || raw === null) {
    return Object.freeze({ ...TERMINAL_DEFAULTS });
  }
  if (typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("relay channel options.terminal must be an object");
  }
  const o = raw as Record<string, unknown>;

  const enabled = o.enabled === undefined ? TERMINAL_DEFAULTS.enabled : o.enabled === true;
  if (o.enabled !== undefined && typeof o.enabled !== "boolean") {
    throw new Error("relay channel options.terminal.enabled must be a boolean");
  }

  const backend = o.backend === undefined ? TERMINAL_DEFAULTS.backend : o.backend;
  if (backend !== "rmux") {
    throw new Error('relay channel options.terminal.backend must be "rmux"');
  }

  const idleTimeoutSeconds = o.idleTimeoutSeconds === undefined
    ? TERMINAL_DEFAULTS.idleTimeoutSeconds
    : o.idleTimeoutSeconds;
  if (!isIntInRange(idleTimeoutSeconds, 60, 86400)) {
    throw new Error("relay channel options.terminal.idleTimeoutSeconds must be an integer in 60..86400");
  }

  const ownerLeaseTtlSeconds = o.ownerLeaseTtlSeconds === undefined
    ? TERMINAL_DEFAULTS.ownerLeaseTtlSeconds
    : o.ownerLeaseTtlSeconds;
  if (!isIntInRange(ownerLeaseTtlSeconds, 15, 600)) {
    throw new Error("relay channel options.terminal.ownerLeaseTtlSeconds must be an integer in 15..600");
  }

  const reconcileIntervalSeconds = o.reconcileIntervalSeconds === undefined
    ? TERMINAL_DEFAULTS.reconcileIntervalSeconds
    : o.reconcileIntervalSeconds;
  if (!isIntInRange(reconcileIntervalSeconds, 5, 300)) {
    throw new Error("relay channel options.terminal.reconcileIntervalSeconds must be an integer in 5..300");
  }

  const orphanGraceSeconds = o.orphanGraceSeconds === undefined
    ? Math.max(TERMINAL_DEFAULTS.orphanGraceSeconds, ownerLeaseTtlSeconds)
    : o.orphanGraceSeconds;
  if (!isIntInRange(orphanGraceSeconds, ownerLeaseTtlSeconds, 3600)) {
    throw new Error(
      "relay channel options.terminal.orphanGraceSeconds must be an integer >= ownerLeaseTtlSeconds and <= 3600",
    );
  }

  const attachmentTtlSeconds = o.attachmentTtlSeconds === undefined
    ? TERMINAL_DEFAULTS.attachmentTtlSeconds
    : o.attachmentTtlSeconds;
  if (!isIntInRange(attachmentTtlSeconds, 15, 300)) {
    throw new Error("relay channel options.terminal.attachmentTtlSeconds must be an integer in 15..300");
  }

  const maxSessions = o.maxSessions === undefined ? TERMINAL_DEFAULTS.maxSessions : o.maxSessions;
  if (!isIntInRange(maxSessions, 1, 128)) {
    throw new Error("relay channel options.terminal.maxSessions must be an integer in 1..128");
  }

  const maxViewersPerTerminal = o.maxViewersPerTerminal === undefined
    ? TERMINAL_DEFAULTS.maxViewersPerTerminal
    : o.maxViewersPerTerminal;
  if (!isIntInRange(maxViewersPerTerminal, 1, 16)) {
    throw new Error("relay channel options.terminal.maxViewersPerTerminal must be an integer in 1..16");
  }

  const historyLimit = o.historyLimit === undefined ? TERMINAL_DEFAULTS.historyLimit : o.historyLimit;
  if (!isIntInRange(historyLimit, 0, 100_000)) {
    throw new Error("relay channel options.terminal.historyLimit must be an integer in 0..100000");
  }

  const bridgeCommand = requireAbsoluteCommand("bridgeCommand", o.bridgeCommand);
  const rmuxCommand = requireAbsoluteCommand("rmuxCommand", o.rmuxCommand);

  const terminal: RelayTerminalConfig = {
    enabled,
    backend: "rmux",
    idleTimeoutSeconds,
    ownerLeaseTtlSeconds,
    reconcileIntervalSeconds,
    orphanGraceSeconds,
    attachmentTtlSeconds,
    maxSessions,
    maxViewersPerTerminal,
    historyLimit,
  };
  if (bridgeCommand !== undefined) terminal.bridgeCommand = bridgeCommand;
  if (rmuxCommand !== undefined) terminal.rmuxCommand = rmuxCommand;
  return Object.freeze(terminal);
}

export function parseRelayChannelConfig(options: Record<string, unknown> | undefined): RelayChannelConfig {
  const raw = typeof options?.url === "string" ? options.url : "";
  const url = normalizeRelayUrl(raw);
  if (!url) {
    throw new Error("relay channel requires options.url (a domain, IP, or IP:port / ws(s):// address)");
  }
  if (!url.startsWith("ws://") && !url.startsWith("wss://")) {
    throw new Error(`relay channel options.url must resolve to ws:// or wss://, got: ${raw}`);
  }
  const config: RelayChannelConfig = {
    url,
    terminal: parseRelayTerminalConfig(options?.terminal),
  };
  if (typeof options?.pairingToken === "string" && options.pairingToken.trim()) {
    config.pairingToken = options.pairingToken.trim();
  }
  if (typeof options?.name === "string" && options.name.trim()) {
    config.name = options.name.trim();
  }
  return Object.freeze(config);
}
