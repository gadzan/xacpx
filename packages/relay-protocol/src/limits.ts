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
