// RMUX driver seam — spec §9/§15.3
// (docs/superpowers/specs/2026-08-10-relay-web-rmux-terminal-design.md).
//
// This module defines ONLY the internal contract between `RelayTerminalRuntime`
// and an RMUX backend. It intentionally exposes nothing beyond
// create/adopt/list/kill/input/resize/recover/stopRenewing/diagnostics — every
// higher-level concept (registry state machine, viewer/controller roles,
// generations bound to `terminalId`) lives in other modules and must not leak
// into this seam.
//
// Two implementations exist against this interface:
//   - `InMemoryRmuxDriver` (in-memory-rmux-driver.ts) — fully fake, used by
//     every unit test in this package.
//   - a future Rust-sidecar-backed driver (Task 17) — the real adapter.
//
// DTOs deliberately keep RMUX's own stable identifiers (`sessionId`, `paneId`),
// opaque `tags`, and raw `Uint8Array` bytes with `epoch`/`sequence` — the driver
// must never re-interpret or transcode terminal bytes.

/** Input to `create()`. `tags` are opaque strings written verbatim to the RMUX
 *  session (spec §10.3, e.g. `"xacpx:relay"`, `"owner:<installationId>"`). */
export interface RmuxCreateSessionInput {
  /** Unreusable RMUX session name (spec §10.3 naming scheme). */
  name: string;
  cwd: string;
  cols: number;
  rows: number;
  /** RMUX `history-limit` — scrollback line cap for the default pane. */
  historyLimit: number;
  tags: readonly string[];
  /** Daemon-side owner lease TTL requested at creation time. */
  ownerLeaseTtlSeconds: number;
}

/** Handle returned by `create()`/`adopt()` — the only stable identity the rest
 *  of the runtime is allowed to persist or compare against. */
export interface RmuxSessionHandle {
  sessionId: string;
  paneId: string;
  name: string;
  tags: readonly string[];
}

/** One entry from `list()` — raw daemon inventory, independent of this
 *  installation's own registry bookkeeping. */
export interface RmuxInventoryEntry {
  sessionId: string;
  paneId: string;
  name: string;
  tags: readonly string[];
}

/** Identity accepted by `adopt()`. Reconciliation may only know a name (from
 *  tags/registry) or a stable `sessionId` (from a previous registry record);
 *  both must resolve to the exact same live session, never a fuzzy match. */
export type RmuxSessionIdentity = { sessionId: string } | { name: string };

/** Recovery events yielded by `recover()`, in strict order.
 *
 * The FIRST event for any subscription must be a `rebase`: it carries a
 * keyframe capable of resetting and rebuilding a compatible terminal emulator
 * (spec §14.6), plus the `epoch`/`nextSequence` that subsequent `bytes` events
 * must continue from. A later `rebase` (resize, clear-history, lag, process
 * generation change) invalidates the previous epoch and restarts the
 * contract — never a lone `bytes` event out of an unseen epoch. */
export type RmuxRecoveryEvent =
  | {
    type: "rebase";
    epoch: number;
    nextSequence: number;
    cols: number;
    rows: number;
    alternate: boolean;
    keyframe: Uint8Array;
    reason?: string;
  }
  | { type: "bytes"; epoch: number; sequence: number; data: Uint8Array }
  | { type: "lease-lost" }
  | { type: "exit"; code?: number };

/** Version/capability stub — real driver reports bridge + RMUX wire version and
 *  negotiated capabilities (spec §15.3 handshake); fake driver returns a fixed
 *  stub so runtime capability gating can be exercised without a real sidecar. */
export interface RmuxDiagnostics {
  bridgeVersion: string;
  rmuxWireVersion: string;
  capabilities: readonly string[];
}

/** The only surface `RelayTerminalRuntime` may call. No other RMUX-shaped
 *  method may be added here — anything about registry state, viewer roles or
 *  wire DTOs belongs in a different module. */
export interface RmuxTerminalDriver {
  /** Create a new detached session with an owner lease. Rejects if a session
   *  with `input.name` already exists — names are never reused across
   *  terminals (spec §10.3). */
  create(input: RmuxCreateSessionInput): Promise<RmuxSessionHandle>;

  /** Adopt an existing live session by its exact stable identity. Never
   *  creates a new session and never resolves to a same-named-but-different
   *  session (rename/reuse safety, spec §15.2). */
  adopt(identity: RmuxSessionIdentity): Promise<RmuxSessionHandle>;

  /** Raw daemon-side inventory for this installation's owner namespace. Used
   *  by reconciliation to discover both expected and orphaned sessions. */
  list(): Promise<RmuxInventoryEntry[]>;

  /** Idempotent: killing an already-gone/unknown session resolves without
   *  error. */
  kill(sessionId: string): Promise<void>;

  /** Send raw input bytes to a pane. Rejects once the owning session's lease
   *  has been fenced (`RmuxLeaseLostError`). */
  input(paneId: string, bytes: Uint8Array): Promise<void>;

  resize(paneId: string, cols: number, rows: number): Promise<void>;

  /** Recovery stream for a pane. See `RmuxRecoveryEvent` for the ordering
   *  contract. Consumers must stop iterating (return/break) to release the
   *  underlying subscription; no separate unsubscribe call exists. */
  recover(paneId: string): AsyncIterable<RmuxRecoveryEvent>;

  /** Abandon-to-expiry (spec §12.2): stop renewing the owner lease without
   *  releasing or killing the session. A future `adopt()` (by this or another
   *  process) can still fence and take over within the daemon TTL. Idempotent
   *  on an unknown session. */
  stopRenewing(sessionId: string): Promise<void>;

  diagnostics(): Promise<RmuxDiagnostics>;
}

export class RmuxSessionNotFoundError extends Error {
  constructor(identity: string) {
    super(`rmux session not found: ${identity}`);
    this.name = "RmuxSessionNotFoundError";
  }
}

export class RmuxPaneNotFoundError extends Error {
  constructor(paneId: string) {
    super(`rmux pane not found: ${paneId}`);
    this.name = "RmuxPaneNotFoundError";
  }
}

export class RmuxSessionNameConflictError extends Error {
  constructor(name: string) {
    super(`rmux session name already in use: ${name}`);
    this.name = "RmuxSessionNameConflictError";
  }
}

/** Thrown by mutating driver calls (`input`/`resize`) once the owner lease for
 *  that session has been fenced by another owner (spec §12.2). The caller
 *  (runtime) must treat this as an immediate stop-all-mutation signal. */
export class RmuxLeaseLostError extends Error {
  constructor(sessionId: string) {
    super(`rmux owner lease lost: ${sessionId}`);
    this.name = "RmuxLeaseLostError";
  }
}

/** Thrown by every driver call once the underlying driver/sidecar process is
 *  considered crashed (fake: via `crashDriver()`; real: sidecar exit). */
export class RmuxDriverCrashedError extends Error {
  constructor() {
    super("rmux driver has crashed");
    this.name = "RmuxDriverCrashedError";
  }
}
