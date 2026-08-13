/**
 * Spec §19 structured terminal log events — IDs, sizes, counts, error class only.
 * Never log terminal bytes, keyframes, credentials, env, or full sensitive paths.
 */
import type { AppLogger } from "xacpx/plugin-api";

export const TERMINAL_LOG_EVENTS = [
  "relay.terminal.runtime_ready",
  "relay.terminal.runtime_unavailable",
  "relay.terminal.created",
  "relay.terminal.resumed",
  "relay.terminal.viewer_attached",
  "relay.terminal.viewer_detached",
  "relay.terminal.control_transferred",
  "relay.terminal.rebase",
  "relay.terminal.resync_requested",
  "relay.terminal.terminated",
  "relay.terminal.cleanup_pending",
  "relay.terminal.idle_reaped",
  "relay.terminal.session_reaped",
  "relay.terminal.orphan_quarantined",
  "relay.terminal.orphan_reaped",
  "relay.terminal.lease_lost",
  "relay.terminal.sidecar_restarted",
  "relay.terminal.protocol_violation",
] as const;

export type TerminalLogEvent = (typeof TERMINAL_LOG_EVENTS)[number];

const BLOCKED_FIELD_KEYS = new Set([
  "bytes",
  "data",
  "dataBase64",
  "keyframe",
  "input",
  "payload",
  "credential",
  "pairingToken",
  "token",
  "password",
  "secret",
  "env",
  "cwd",
  "command",
  "bridgeCommand",
  "rmuxCommand",
  "path",
  "filePath",
  "text",
  "content",
]);

const CANARY_PATTERNS: RegExp[] = [
  /credential/i,
  /pairingToken/i,
  /\/\/[^\s"']+:[^\s"']+@/, // user:pass@ in URLs
];

export type TerminalLogFields = Record<string, string | number | boolean | null | undefined>;

/** Drop blocked keys and string values that look like secrets/paths with canaries. */
export function sanitizeTerminalLogFields(
  fields: TerminalLogFields,
  canaries: string[] = [],
): Record<string, string | number | boolean | null> {
  const out: Record<string, string | number | boolean | null> = {};
  for (const [key, value] of Object.entries(fields)) {
    if (BLOCKED_FIELD_KEYS.has(key)) continue;
    if (value === undefined) continue;
    if (typeof value === "string") {
      if (canaries.some((c) => c.length > 0 && value.includes(c))) continue;
      if (CANARY_PATTERNS.some((re) => re.test(value))) continue;
      // Never pass through long opaque blobs (possible base64 terminal bytes).
      if (value.length > 256) {
        out[`${key}Length`] = value.length;
        continue;
      }
    }
    out[key] = value;
  }
  return out;
}

export async function logTerminalEvent(
  logger: AppLogger | undefined,
  event: TerminalLogEvent,
  fields: TerminalLogFields = {},
  canaries: string[] = [],
): Promise<void> {
  if (!logger) return;
  const safe = sanitizeTerminalLogFields(fields, canaries);
  const summary = Object.entries(safe)
    .map(([k, v]) => `${k}=${v}`)
    .join(" ");
  await logger.info(event, summary || event, safe);
}
