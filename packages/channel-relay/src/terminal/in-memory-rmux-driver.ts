// Fake `RmuxTerminalDriver` for tests — spec §22.2 requires exercising
// `RelayTerminalRuntime` only through observable driver behavior, never by
// reaching into a real RMUX daemon. This driver models exactly the surface in
// `rmux-driver.ts`, plus a set of test-only control methods
// (`injectOutput`/`loseLease`/`exitSession`/`triggerRebase`/`setInventory`/
// `configureFailure`/`configureDelay`/`crashDriver`) that let tests simulate
// every fault this design must survive without touching a real RMUX process.
import { randomUUID } from "node:crypto";

import {
  RmuxDriverCrashedError,
  RmuxLeaseLostError,
  RmuxPaneNotFoundError,
  RmuxSessionNameConflictError,
  RmuxSessionNotFoundError,
  type RmuxCreateSessionInput,
  type RmuxDiagnostics,
  type RmuxInventoryEntry,
  type RmuxRecoveryEvent,
  type RmuxSessionHandle,
  type RmuxSessionIdentity,
  type RmuxTerminalDriver,
} from "./rmux-driver.js";

type RmuxDriverOp =
  | "create"
  | "adopt"
  | "list"
  | "kill"
  | "input"
  | "resize"
  | "recover"
  | "stopRenewing"
  | "diagnostics";

interface InternalSession {
  sessionId: string;
  paneId: string;
  name: string;
  tags: string[];
  cols: number;
  rows: number;
  alternate: boolean;
  alive: boolean;
  leaseLost: boolean;
  renewingStopped: boolean;
  epoch: number;
  /** Next sequence number to assign to the next `bytes` event within `epoch`. */
  nextSequence: number;
  /** Bounded accumulation of output used to build the next rebase keyframe. */
  keyframe: Uint8Array;
  historyLimitBytes: number;
  subscribers: Set<AsyncEventQueue<RmuxRecoveryEvent>>;
}

interface FailureConfig {
  error: Error;
  remaining: number;
}

export interface InMemoryRmuxDriverDeps {
  randomUUID?: () => string;
  /** Injectable so `configureDelay` tests never perform a real sleep. */
  sleep?: (ms: number) => Promise<void>;
}

/** Minimal controllable async pull-queue used to model each `recover()`
 *  subscription. `close(err)` ends the stream; iterating with `for await`
 *  naturally releases the subscription via the generator's `finally`. */
class AsyncEventQueue<T> implements AsyncIterable<T> {
  private buffer: T[] = [];
  private waiters: Array<(result: IteratorResult<T>) => void> = [];
  private rejecters: Array<(err: unknown) => void> = [];
  private closed = false;
  private closeError: unknown = undefined;

  push(item: T): void {
    if (this.closed) return;
    const waiter = this.waiters.shift();
    this.rejecters.shift();
    if (waiter) {
      waiter({ value: item, done: false });
    } else {
      this.buffer.push(item);
    }
  }

  close(err?: unknown): void {
    if (this.closed) return;
    this.closed = true;
    this.closeError = err;
    while (this.waiters.length > 0) {
      const waiter = this.waiters.shift()!;
      const reject = this.rejecters.shift();
      if (err !== undefined && reject) {
        reject(err);
      } else {
        waiter({ value: undefined as never, done: true });
      }
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: (): Promise<IteratorResult<T>> => {
        if (this.buffer.length > 0) {
          return Promise.resolve({ value: this.buffer.shift() as T, done: false });
        }
        if (this.closed) {
          if (this.closeError !== undefined) return Promise.reject(this.closeError);
          return Promise.resolve({ value: undefined as never, done: true });
        }
        return new Promise((resolve, reject) => {
          this.waiters.push(resolve);
          this.rejecters.push(reject);
        });
      },
      return: async (): Promise<IteratorResult<T>> => {
        this.closed = true;
        return { value: undefined as never, done: true };
      },
    };
  }
}

const DEFAULT_KEYFRAME_CAP_BYTES = 256 * 1024;

function concatCapped(existing: Uint8Array, addition: Uint8Array, capBytes: number): Uint8Array {
  const total = existing.length + addition.length;
  if (total <= capBytes) {
    const out = new Uint8Array(total);
    out.set(existing, 0);
    out.set(addition, existing.length);
    return out;
  }
  // Keep only the most recent `capBytes` — mirrors RMUX scrollback eviction
  // (oldest content dropped first), not a correctness requirement of the fake.
  const keepFromAddition = Math.min(addition.length, capBytes);
  const keepFromExisting = capBytes - keepFromAddition;
  const out = new Uint8Array(capBytes);
  out.set(existing.subarray(existing.length - keepFromExisting), 0);
  out.set(addition.subarray(addition.length - keepFromAddition), keepFromExisting);
  return out;
}

export class InMemoryRmuxDriver implements RmuxTerminalDriver {
  private readonly deps: Required<InMemoryRmuxDriverDeps>;
  private readonly sessionsById = new Map<string, InternalSession>();
  private readonly sessionsByPane = new Map<string, string>();
  private readonly sessionsByName = new Map<string, string>();
  private inventoryOverride: RmuxInventoryEntry[] | null = null;
  private readonly failures = new Map<RmuxDriverOp, FailureConfig>();
  private readonly delays = new Map<RmuxDriverOp, number>();
  private crashed = false;
  private crashError: Error = new RmuxDriverCrashedError();
  private diagnosticsValue: RmuxDiagnostics = {
    bridgeVersion: "in-memory-fake-0.0.0",
    rmuxWireVersion: "0.10.0-fake",
    capabilities: ["terminal.rmux.recovery.v1", "terminal.multi-view.v1"],
  };

  constructor(deps: InMemoryRmuxDriverDeps = {}) {
    this.deps = {
      randomUUID: deps.randomUUID ?? (() => randomUUID()),
      sleep: deps.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms))),
    };
  }

  // --- RmuxTerminalDriver -----------------------------------------------

  async create(input: RmuxCreateSessionInput): Promise<RmuxSessionHandle> {
    await this.gate("create");
    if (this.sessionsByName.has(input.name)) {
      throw new RmuxSessionNameConflictError(input.name);
    }
    const sessionId = this.deps.randomUUID();
    const paneId = this.deps.randomUUID();
    const session: InternalSession = {
      sessionId,
      paneId,
      name: input.name,
      tags: [...input.tags],
      cols: input.cols,
      rows: input.rows,
      alternate: false,
      alive: true,
      leaseLost: false,
      renewingStopped: false,
      epoch: 1,
      nextSequence: 0,
      keyframe: new Uint8Array(0),
      historyLimitBytes: DEFAULT_KEYFRAME_CAP_BYTES,
      subscribers: new Set(),
    };
    this.sessionsById.set(sessionId, session);
    this.sessionsByPane.set(paneId, sessionId);
    this.sessionsByName.set(input.name, sessionId);
    return this.toHandle(session);
  }

  async adopt(identity: RmuxSessionIdentity): Promise<RmuxSessionHandle> {
    await this.gate("adopt");
    const existing = this.findSession(identity);
    if (existing) {
      // A successful adopt fences the previous owner and restores mutability.
      existing.leaseLost = false;
      existing.renewingStopped = false;
      return this.toHandle(existing);
    }

    // Reconciliation may need to adopt a session this driver instance never
    // `create()`d (e.g. after a simulated restart where only `list()`/
    // inventory evidence survives). Materialize it from the override entry so
    // subsequent input/resize/recover calls behave consistently.
    const fromInventory = this.inventoryOverride?.find((entry) => this.matchesIdentity(entry, identity));
    if (fromInventory) {
      const session: InternalSession = {
        sessionId: fromInventory.sessionId,
        paneId: fromInventory.paneId,
        name: fromInventory.name,
        tags: [...fromInventory.tags],
        cols: 80,
        rows: 24,
        alternate: false,
        alive: true,
        leaseLost: false,
        renewingStopped: false,
        epoch: 1,
        nextSequence: 0,
        keyframe: new Uint8Array(0),
        historyLimitBytes: DEFAULT_KEYFRAME_CAP_BYTES,
        subscribers: new Set(),
      };
      this.sessionsById.set(session.sessionId, session);
      this.sessionsByPane.set(session.paneId, session.sessionId);
      this.sessionsByName.set(session.name, session.sessionId);
      return this.toHandle(session);
    }

    throw new RmuxSessionNotFoundError(identityLabel(identity));
  }

  async list(): Promise<RmuxInventoryEntry[]> {
    await this.gate("list");
    if (this.inventoryOverride) {
      return this.inventoryOverride.map((entry) => ({ ...entry, tags: [...entry.tags] }));
    }
    return [...this.sessionsById.values()]
      .filter((session) => session.alive)
      .map((session) => ({
        sessionId: session.sessionId,
        paneId: session.paneId,
        name: session.name,
        tags: [...session.tags],
      }));
  }

  async kill(sessionId: string): Promise<void> {
    await this.gate("kill");
    const session = this.sessionsById.get(sessionId);
    if (session) {
      session.alive = false;
      for (const queue of session.subscribers) queue.close();
      session.subscribers.clear();
      this.sessionsById.delete(sessionId);
      this.sessionsByPane.delete(session.paneId);
      this.sessionsByName.delete(session.name);
    }
    if (this.inventoryOverride) {
      this.inventoryOverride = this.inventoryOverride.filter((entry) => entry.sessionId !== sessionId);
    }
    // Idempotent: unknown sessionId is not an error.
  }

  async input(paneId: string, _bytes: Uint8Array): Promise<void> {
    await this.gate("input");
    const session = this.requireSessionByPane(paneId);
    this.assertMutable(session);
  }

  async resize(paneId: string, cols: number, rows: number): Promise<void> {
    await this.gate("resize");
    const session = this.requireSessionByPane(paneId);
    this.assertMutable(session);
    session.cols = cols;
    session.rows = rows;
  }

  async *recover(paneId: string): AsyncGenerator<RmuxRecoveryEvent> {
    await this.gate("recover");
    const session = this.requireSessionByPane(paneId);

    const queue = new AsyncEventQueue<RmuxRecoveryEvent>();
    session.subscribers.add(queue);
    queue.push(this.buildRebaseEvent(session));
    if (session.leaseLost) queue.push({ type: "lease-lost" });
    if (!session.alive) queue.push({ type: "exit" });

    try {
      for await (const event of queue) {
        yield event;
      }
    } finally {
      session.subscribers.delete(queue);
    }
  }

  async stopRenewing(sessionId: string): Promise<void> {
    await this.gate("stopRenewing");
    const session = this.sessionsById.get(sessionId);
    if (session) session.renewingStopped = true;
    // Idempotent on unknown session, matching `kill()`.
  }

  async diagnostics(): Promise<RmuxDiagnostics> {
    await this.gate("diagnostics");
    return { ...this.diagnosticsValue, capabilities: [...this.diagnosticsValue.capabilities] };
  }

  // --- Test-only controls --------------------------------------------------

  /** Push raw output bytes to a live pane's active recovery subscribers, with
   *  strictly increasing `sequence` within the current `epoch`. */
  injectOutput(paneId: string, bytes: Uint8Array): void {
    const session = this.requireSessionByPane(paneId);
    session.keyframe = concatCapped(session.keyframe, bytes, session.historyLimitBytes);
    const sequence = session.nextSequence;
    session.nextSequence += 1;
    const event: RmuxRecoveryEvent = { type: "bytes", epoch: session.epoch, sequence, data: bytes };
    for (const queue of session.subscribers) queue.push(event);
  }

  /** Force a new rebase (resize/clear-history/lag/process-generation-change
   *  analogue). Bumps `epoch`, resets sequence numbering, and invalidates any
   *  bytes events from the previous epoch. */
  triggerRebase(
    sessionId: string,
    overrides: { cols?: number; rows?: number; alternate?: boolean; keyframe?: Uint8Array; reason?: string } = {},
  ): void {
    const session = this.requireSessionById(sessionId);
    session.epoch += 1;
    session.nextSequence = 0;
    if (overrides.cols !== undefined) session.cols = overrides.cols;
    if (overrides.rows !== undefined) session.rows = overrides.rows;
    if (overrides.alternate !== undefined) session.alternate = overrides.alternate;
    if (overrides.keyframe !== undefined) session.keyframe = overrides.keyframe;
    const event = this.buildRebaseEvent(session, overrides.reason);
    for (const queue of session.subscribers) queue.push(event);
  }

  /** Simulate the daemon fencing this owner's lease (a competing owner adopted
   *  the same stable session). Subsequent `input`/`resize` reject with
   *  `RmuxLeaseLostError`; `kill`/`list` are unaffected. */
  loseLease(sessionId: string): void {
    const session = this.requireSessionById(sessionId);
    session.leaseLost = true;
    for (const queue of session.subscribers) queue.push({ type: "lease-lost" });
  }

  /** Simulate the shell process exiting on its own (not an explicit kill). */
  exitSession(sessionId: string, code?: number): void {
    const session = this.requireSessionById(sessionId);
    session.alive = false;
    for (const queue of session.subscribers) {
      queue.push({ type: "exit", code });
      queue.close();
    }
    session.subscribers.clear();
  }

  /** Override `list()` output entirely, independent of internally tracked
   *  sessions. Pass `null` to revert to reflecting real internal state. Used
   *  to simulate orphaned/untracked daemon inventory for reconciler tests. */
  setInventory(entries: RmuxInventoryEntry[] | null): void {
    this.inventoryOverride = entries ? entries.map((entry) => ({ ...entry, tags: [...entry.tags] })) : null;
  }

  setDiagnostics(value: Partial<RmuxDiagnostics>): void {
    this.diagnosticsValue = { ...this.diagnosticsValue, ...value };
  }

  /** Make the given operation fail `times` times (default: forever) with
   *  `error`. Each failing call consumes one occurrence. */
  configureFailure(op: RmuxDriverOp, error: Error, times = Number.POSITIVE_INFINITY): void {
    this.failures.set(op, { error, remaining: times });
  }

  clearFailure(op: RmuxDriverOp): void {
    this.failures.delete(op);
  }

  /** Add an artificial delay (via the injectable `sleep` dep) before the given
   *  operation resolves/rejects. */
  configureDelay(op: RmuxDriverOp, ms: number): void {
    this.delays.set(op, ms);
  }

  clearDelay(op: RmuxDriverOp): void {
    this.delays.delete(op);
  }

  /** Simulate the whole driver/sidecar process crashing: every future call
   *  rejects, and every active recovery subscription is torn down with the
   *  same error. */
  crashDriver(error?: Error): void {
    this.crashed = true;
    if (error) this.crashError = error;
    for (const session of this.sessionsById.values()) {
      for (const queue of session.subscribers) queue.close(this.crashError);
      session.subscribers.clear();
    }
  }

  isRenewingStopped(sessionId: string): boolean {
    return this.requireSessionById(sessionId).renewingStopped;
  }

  isLeaseLost(sessionId: string): boolean {
    return this.requireSessionById(sessionId).leaseLost;
  }

  // --- internals -------------------------------------------------------

  private async gate(op: RmuxDriverOp): Promise<void> {
    const delay = this.delays.get(op);
    if (delay !== undefined) await this.deps.sleep(delay);
    if (this.crashed) throw this.crashError;
    const failure = this.failures.get(op);
    if (failure && failure.remaining > 0) {
      failure.remaining -= 1;
      if (failure.remaining <= 0) this.failures.delete(op);
      throw failure.error;
    }
  }

  private toHandle(session: InternalSession): RmuxSessionHandle {
    return { sessionId: session.sessionId, paneId: session.paneId, name: session.name, tags: [...session.tags] };
  }

  private findSession(identity: RmuxSessionIdentity): InternalSession | undefined {
    if ("sessionId" in identity) return this.sessionsById.get(identity.sessionId);
    const id = this.sessionsByName.get(identity.name);
    return id ? this.sessionsById.get(id) : undefined;
  }

  private matchesIdentity(entry: RmuxInventoryEntry, identity: RmuxSessionIdentity): boolean {
    if ("sessionId" in identity) return entry.sessionId === identity.sessionId;
    return entry.name === identity.name;
  }

  private requireSessionByPane(paneId: string): InternalSession {
    const sessionId = this.sessionsByPane.get(paneId);
    const session = sessionId ? this.sessionsById.get(sessionId) : undefined;
    if (!session) throw new RmuxPaneNotFoundError(paneId);
    return session;
  }

  private requireSessionById(sessionId: string): InternalSession {
    const session = this.sessionsById.get(sessionId);
    if (!session) throw new RmuxSessionNotFoundError(sessionId);
    return session;
  }

  private assertMutable(session: InternalSession): void {
    if (session.leaseLost) throw new RmuxLeaseLostError(session.sessionId);
    if (!session.alive) throw new RmuxPaneNotFoundError(session.paneId);
  }

  private buildRebaseEvent(session: InternalSession, reason?: string): RmuxRecoveryEvent {
    return {
      type: "rebase",
      epoch: session.epoch,
      nextSequence: session.nextSequence,
      cols: session.cols,
      rows: session.rows,
      alternate: session.alternate,
      keyframe: session.keyframe,
      ...(reason !== undefined ? { reason } : {}),
    };
  }
}

function identityLabel(identity: RmuxSessionIdentity): string {
  return "sessionId" in identity ? identity.sessionId : identity.name;
}
