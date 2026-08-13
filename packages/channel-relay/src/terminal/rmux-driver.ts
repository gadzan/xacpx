// RMUX driver seam — process-owned terminal backend.
//
// Internal contract between `RelayTerminalRuntime` and an RMUX backend.
// Process-owned mode (no rmux source patches) exposes only:
//   create / list / kill / input / resize / recover / diagnostics
//
// Cross-process adopt / stopRenewing / fencing are intentionally absent:
// shutdown kills sessions; hard crash relies on daemon KillOnOwnerExit TTL.
//
// Implementations:
//   - `InMemoryRmuxDriver` — fake for unit/E2E tests
//   - Rust sidecar driver — real adapter over rmux-sdk 0.10.0
//
// DTOs keep RMUX stable identifiers (`sessionId`, `paneId`), opaque `tags`
// (best-effort; public OwnedSession create may not persist tags), and raw
// `Uint8Array` recovery bytes. Input is UTF-8 text at the bridge boundary.

/** Input to `create()`. `tags` are advisory metadata (registry + best-effort
 *  RMUX labeling). `ownerLeaseTtlSeconds` is the crash-cleanup TTL for
 *  KillOnOwnerExit, not a restart-adoption window. */
export interface RmuxCreateSessionInput {
  /** Globally unique RMUX session name — never reused (naming scheme in runtime). */
  name: string;
  cwd: string;
  cols: number;
  rows: number;
  /** RMUX `history-limit` — scrollback line cap for the work pane. */
  historyLimit: number;
  tags: readonly string[];
  /** Daemon-side owner lease TTL for hard-crash cleanup. */
  ownerLeaseTtlSeconds: number;
}

/** Handle returned by `create()` — the only stable identity the rest of the
 *  runtime persists or compares against within this process. */
export interface RmuxSessionHandle {
  sessionId: string;
  paneId: string;
  name: string;
  tags: readonly string[];
}

/** One entry from `list()` — raw daemon inventory. */
export interface RmuxInventoryEntry {
  sessionId: string;
  paneId: string;
  name: string;
  tags: readonly string[];
}

/** Recovery events yielded by `recover()`, in strict order.
 *
 * The FIRST event for any subscription must be a `rebase`. A later `rebase`
 * invalidates the previous epoch. Process-owned mode does not emit
 * `lease-lost` (no cross-owner adopt fencing). */
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
  | { type: "exit"; code?: number }
  | { type: "error"; code: string; message: string };

/** Version/capability stub — real driver reports bridge + RMUX wire version. */
export interface RmuxDiagnostics {
  bridgeVersion: string;
  rmuxWireVersion: string;
  capabilities: readonly string[];
}

/** The only surface `RelayTerminalRuntime` may call. */
export interface RmuxTerminalDriver {
  /** Create a new detached process-owned session. Rejects if `input.name`
   *  already exists — names are never reused. */
  create(input: RmuxCreateSessionInput): Promise<RmuxSessionHandle>;

  /** Raw daemon-side inventory for reconciliation / orphan kill. */
  list(): Promise<RmuxInventoryEntry[]>;

  /** Idempotent: killing an already-gone/unknown session resolves without error.
   *  Prefer killing by the registry's unique session name when available; the
   *  `sessionId` argument remains the driver-key used within this process. */
  kill(sessionId: string): Promise<void>;

  /** Send UTF-8 text bytes to a pane. Non-UTF-8 is rejected at the real
   *  sidecar; the fake accepts any bytes for test injectability. */
  input(paneId: string, bytes: Uint8Array): Promise<void>;

  resize(paneId: string, cols: number, rows: number): Promise<void>;

  /** Recovery stream for a pane. Consumers must stop iterating to release.
   *  Pass `signal` so abort unblocks `next()` instead of deadlocking against
   *  `iterator.return()`. */
  recover(paneId: string, signal?: AbortSignal): AsyncIterable<RmuxRecoveryEvent>;

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

/** Thrown when input bytes are not valid UTF-8 (process-owned bridge contract). */
export class RmuxInvalidUtf8InputError extends Error {
  constructor() {
    super("rmux input must be valid UTF-8");
    this.name = "RmuxInvalidUtf8InputError";
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
