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
export declare const MAX_TERMINAL_REQUEST_ID_LENGTH = 128;
export declare const MAX_TERMINAL_ID_LENGTH = 128;
export declare const MAX_TERMINAL_ATTACHMENT_ID_LENGTH = 128;
export declare const MAX_TERMINAL_GENERATION_LENGTH = 128;
export declare const MAX_TERMINAL_SESSION_ALIAS_LENGTH = 256;
export declare const MAX_TERMINAL_VIEWER_ID_LENGTH = 128;
export declare const MAX_TERMINAL_ERROR_MESSAGE_LENGTH = 512;
export declare const MIN_TERMINAL_COLS = 1;
export declare const MAX_TERMINAL_COLS = 500;
export declare const MIN_TERMINAL_ROWS = 1;
export declare const MAX_TERMINAL_ROWS = 300;
/** Decoded input frame cap. */
export declare const MAX_TERMINAL_INPUT_BYTES: number;
/** Fixed decoded rebase chunk size. */
export declare const TERMINAL_REBASE_CHUNK_BYTES: number;
/** Single rebase keyframe cap. */
export declare const MAX_TERMINAL_REBASE_TOTAL_BYTES: number;
/** Per-attachment outbound queue cap before the recovery stream is closed. */
export declare const MAX_TERMINAL_ATTACHMENT_QUEUE_BYTES: number;
/** open / take-control / resync / terminate request deadline. */
export declare const TERMINAL_RPC_TIMEOUT_MS = 10000;
/** RMUX kill confirmation wait inside terminate. */
export declare const TERMINAL_KILL_CONFIRM_TIMEOUT_MS = 5000;
/** Max capability strings accepted on instance register/auth. */
export declare const MAX_CAPABILITIES = 32;
/** Max length of a single capability string. */
export declare const MAX_CAPABILITY_LENGTH = 128;
/** Max base64 wire length that can decode to `maxDecodedBytes` (with padding). */
export declare function maxBase64EncodedLength(maxDecodedBytes: number): number;
