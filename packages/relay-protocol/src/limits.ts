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
