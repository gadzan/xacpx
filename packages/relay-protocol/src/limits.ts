// Content caps shared by the relay hub (packages/relay) and the connector's
// state mirror (packages/channel-relay). Both sides must agree on these bounds:
// the mirror caps what it accumulates, and the hub applies the same bounds when
// it rebuilds turn buffers from an `instance.state.sync` snapshot — one source
// of truth so the two sides can never drift apart.
export const STATE_SYNC_TEXT_CAP = 256 * 1024;
/** Ordered activity entries retained for one recovered running turn. */
export const STATE_SYNC_PARTS_CAP = 1_000;
export const MAX_TOOL_STEPS = 200;
export const REASONING_CAP = 16000;
/** How long a finished turn may wait for its persistence ack. The CONNECTOR evicts
 *  `pendingFinished` entries older than this (state-mirror), and the hub's maintenance
 *  prunes recovery receipts past it + a clock-skew grace (packages/relay/maintenance.ts).
 *  The two sides MUST share this horizon: if the hub pruned a receipt while its entry
 *  could still be re-delivered, a reconnect after a long idle would re-append the same
 *  reply as a duplicate. The connector drops the entry first, so the receipt is never
 *  needed past this age (the grace absorbs delivery delay + clock skew between the two
 *  hosts). */
export const RECOVERY_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

// --- recoverable RMUX terminal hard limits (browser ↔ hub ↔ connector) ---
export const MAX_TERMINAL_REQUEST_ID_LENGTH = 128;
export const MAX_TERMINAL_ID_LENGTH = 128;
export const MAX_TERMINAL_ATTACHMENT_ID_LENGTH = 128;
export const MAX_TERMINAL_GENERATION_LENGTH = 128;
export const MAX_TERMINAL_SESSION_ALIAS_LENGTH = 256;
export const MAX_TERMINAL_VIEWER_ID_LENGTH = 128;
export const MAX_TERMINAL_ERROR_MESSAGE_LENGTH = 512;
export const MIN_TERMINAL_COLS = 1;
export const MAX_TERMINAL_COLS = 500;
export const MIN_TERMINAL_ROWS = 1;
export const MAX_TERMINAL_ROWS = 300;
/** Decoded input frame cap. */
export const MAX_TERMINAL_INPUT_BYTES = 64 * 1024;
/** Fixed decoded rebase chunk size. */
export const TERMINAL_REBASE_CHUNK_BYTES = 48 * 1024;
/** Single rebase keyframe cap. */
export const MAX_TERMINAL_REBASE_TOTAL_BYTES = 2 * 1024 * 1024;
/** Per-attachment outbound queue cap before the recovery stream is closed. */
export const MAX_TERMINAL_ATTACHMENT_QUEUE_BYTES = 2 * 1024 * 1024;
/** Hub → connector terminal RPC deadline (open / take-control / resync / terminate). */
export const TERMINAL_HUB_REQUEST_TIMEOUT_MS = 45_000;
/**
 * Browser → hub terminal RPC deadline. Must be strictly longer than
 * `TERMINAL_HUB_REQUEST_TIMEOUT_MS` so a slow open cannot bind an attachment
 * after the browser has already dropped the pending request.
 */
export const TERMINAL_RPC_TIMEOUT_MS = 60_000;
/** RMUX kill confirmation wait inside terminate. */
export const TERMINAL_KILL_CONFIRM_TIMEOUT_MS = 5_000;

/** Max capability strings accepted on instance register/auth. */
export const MAX_CAPABILITIES = 32;
/** Max length of a single capability string. */
export const MAX_CAPABILITY_LENGTH = 128;

// --- instance desktop (RFB/VNC) hard limits (browser ↔ hub ↔ connector) ---
/** Browser → hub desktop-open request id. */
export const MAX_DESKTOP_REQUEST_ID_LENGTH = 128;
/** Hub-minted desktop stream identity (prepare payload, cancel payload, web DTOs). */
export const MAX_DESKTOP_STREAM_ID_LENGTH = 128;
/** Hub-minted single-use desktop ticket (prepare payload + binary wsPath query). */
export const MAX_DESKTOP_TICKET_LENGTH = 128;
/** `desktop-opened` wsPath (`/desktop/observe?ticket=…`); tickets stay opaque in the query. */
export const MAX_DESKTOP_WS_PATH_LENGTH = 512;
export const MAX_DESKTOP_ERROR_MESSAGE_LENGTH = 512;
/** Single-use desktop ticket TTL (hub ticket store + `expiresAt` stamped on prepare). */
export const DESKTOP_TICKET_TTL_MS = 60_000;
/** Hub → connector `instance.desktop.prepare` deadline. Far below the 120s generic
 *  agent RPC timeout: a hung RFB probe must fail fast, not pin a stream slot. */
export const DESKTOP_HUB_REQUEST_TIMEOUT_MS = 10_000;
/**
 * Browser → hub desktop RPC deadline. Must be strictly longer than
 * `DESKTOP_HUB_REQUEST_TIMEOUT_MS` so a slow prepare cannot bind a stream
 * after the browser has already dropped the pending request.
 */
export const DESKTOP_RPC_TIMEOUT_MS = 15_000;
/** v1 single-viewer: at most one active/preparing desktop stream per instance. */
export const DESKTOP_MAX_STREAMS_PER_INSTANCE = 1;
/** Hub-wide cap on concurrent active desktop streams per account. */
export const DESKTOP_MAX_STREAMS_PER_ACCOUNT = 8;
/** Desktop binary WebSocket max inbound frame (hub + connector). Framebuffer never enters JSON. */
export const DESKTOP_WS_MAX_PAYLOAD_BYTES = 1 * 1024 * 1024;
/** Connector single TCP read/forward chunk between loopback RFB and the binary WS. */
export const DESKTOP_TCP_CHUNK_BYTES = 64 * 1024;
/** Destination bufferedAmount that pauses the source side (TCP pause / WS backpressure). */
export const DESKTOP_BUFFERED_SOFT_PAUSE_BYTES = 2 * 1024 * 1024;
/** Destination bufferedAmount that closes both sides (hub never queues unbounded). */
export const DESKTOP_BUFFERED_HARD_CLOSE_BYTES = 4 * 1024 * 1024;

/** Max base64 wire length that can decode to `maxDecodedBytes` (with padding). */
export function maxBase64EncodedLength(maxDecodedBytes: number): number {
  return 4 * Math.ceil(Math.max(0, maxDecodedBytes) / 3);
}
