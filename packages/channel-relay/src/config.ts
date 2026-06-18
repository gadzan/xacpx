export interface RelayChannelConfig {
  url: string;
  pairingToken?: string;
  name?: string;
}

/**
 * Normalize a relay URL input into a full ws(s):// URL.
 *
 * Rules:
 * - Trim. Empty → "".
 * - Already ws:// or wss:// (case-insensitive) → return as-is.
 * - http:// → ws://, https:// → wss:// (map scheme, keep the rest).
 * - No scheme → parse host[:port]:
 *   - Explicit numeric port → ws://<host>:<port>.
 *   - IPv4 literal, "localhost", or bracketed IPv6 → ws://<host>:8788.
 *   - Domain name → wss://<host> (production TLS, no port appended).
 *
 * Note: bare unbracketed IPv6 (e.g. "::1") is not supported; use "[::1]" instead.
 */
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
    return `ws://[${ipv6}]:8788`;
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
    return `ws://${host}:8788`;
  }

  // Domain → wss, port 443 implicit
  return `wss://${host}`;
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
  const config: RelayChannelConfig = { url };
  if (typeof options?.pairingToken === "string" && options.pairingToken.trim()) {
    config.pairingToken = options.pairingToken.trim();
  }
  if (typeof options?.name === "string" && options.name.trim()) {
    config.name = options.name.trim();
  }
  return config;
}
