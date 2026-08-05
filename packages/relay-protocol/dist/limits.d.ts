export declare const STATE_SYNC_TEXT_CAP: number;
/** Ordered activity entries retained for one recovered running turn. */
export declare const STATE_SYNC_PARTS_CAP = 1000;
export declare const MAX_TOOL_STEPS = 200;
export declare const REASONING_CAP = 16000;
/** How long a finished turn may wait for its persistence ack. The CONNECTOR evicts
 *  `pendingFinished` entries older than this (state-mirror), and the hub's maintenance
 *  prunes recovery receipts past it + a clock-skew grace (packages/relay/maintenance.ts).
 *  The two sides MUST share this horizon: if the hub pruned a receipt while its entry
 *  could still be re-delivered, a reconnect after a long idle would re-append the same
 *  reply as a duplicate. The connector drops the entry first, so the receipt is never
 *  needed past this age (the grace absorbs delivery delay + clock skew between the two
 *  hosts). */
export declare const RECOVERY_RETENTION_MS: number;
