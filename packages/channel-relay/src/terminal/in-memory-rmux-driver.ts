// Fake `RmuxTerminalDriver` for tests — process-owned mode (no adopt/abandon).
// Models create/list/kill/input/resize/recover/diagnostics plus test controls.
import { randomUUID } from "node:crypto";

import {
  RmuxDriverCrashedError,
  RmuxPaneNotFoundError,
  RmuxSessionNameConflictError,
  RmuxSessionNotFoundError,
  type RmuxCreateSessionInput,
  type RmuxDiagnostics,
  type RmuxInventoryEntry,
  type RmuxRecoveryEvent,
  type RmuxSessionHandle,
  type RmuxTerminalDriver,
} from "./rmux-driver.js";

type RmuxDriverOp =
  | "create"
  | "list"
  | "kill"
  | "input"
  | "resize"
  | "recover"
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
  epoch: number;
  nextSequence: number;
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
  sleep?: (ms: number) => Promise<void>;
}

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
        this.close();
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
  private recoverReturnHold: Promise<void> | null = null;
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
  }

  async input(paneId: string, _bytes: Uint8Array): Promise<void> {
    await this.gate("input");
    const session = this.requireSessionByPane(paneId);
    if (!session.alive) throw new RmuxPaneNotFoundError(paneId);
  }

  async resize(paneId: string, cols: number, rows: number): Promise<void> {
    await this.gate("resize");
    const session = this.requireSessionByPane(paneId);
    if (!session.alive) throw new RmuxPaneNotFoundError(paneId);
    session.cols = cols;
    session.rows = rows;
  }

  async *recover(paneId: string, signal?: AbortSignal): AsyncGenerator<RmuxRecoveryEvent> {
    await this.gate("recover");
    const session = this.requireSessionByPane(paneId);

    const queue = new AsyncEventQueue<RmuxRecoveryEvent>();
    const onAbort = () => queue.close();
    if (signal?.aborted) onAbort();
    else signal?.addEventListener("abort", onAbort, { once: true });
    session.subscribers.add(queue);
    queue.push(this.buildRebaseEvent(session));
    if (!session.alive) queue.push({ type: "exit" });

    try {
      for await (const event of queue) {
        yield event;
      }
    } finally {
      if (this.recoverReturnHold) {
        const hold = this.recoverReturnHold;
        this.recoverReturnHold = null;
        await hold;
      }
      signal?.removeEventListener("abort", onAbort);
      session.subscribers.delete(queue);
      queue.close();
    }
  }

  /** Stall the next `iterator.return()` / generator finally until `release()`. */
  holdNextRecoverReturn(): { release: () => void } {
    let release!: () => void;
    this.recoverReturnHold = new Promise<void>((resolve) => {
      release = resolve;
    });
    return { release };
  }

  injectError(paneId: string, code: string, message: string): void {
    const session = this.requireSessionByPane(paneId);
    const event: RmuxRecoveryEvent = { type: "error", code, message };
    for (const queue of session.subscribers) queue.push(event);
  }

  recoverySubscriberCount(paneId: string): number {
    const sessionId = this.sessionsByPane.get(paneId);
    const session = sessionId ? this.sessionsById.get(sessionId) : undefined;
    return session?.subscribers.size ?? 0;
  }

  async diagnostics(): Promise<RmuxDiagnostics> {
    await this.gate("diagnostics");
    return { ...this.diagnosticsValue, capabilities: [...this.diagnosticsValue.capabilities] };
  }

  injectOutput(paneId: string, bytes: Uint8Array): void {
    const session = this.requireSessionByPane(paneId);
    session.keyframe = concatCapped(session.keyframe, bytes, session.historyLimitBytes);
    const sequence = session.nextSequence;
    session.nextSequence += 1;
    const event: RmuxRecoveryEvent = { type: "bytes", epoch: session.epoch, sequence, data: bytes };
    for (const queue of session.subscribers) queue.push(event);
  }

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

  exitSession(sessionId: string, code?: number): void {
    const session = this.requireSessionById(sessionId);
    session.alive = false;
    for (const queue of session.subscribers) {
      queue.push({ type: "exit", code });
      queue.close();
    }
    session.subscribers.clear();
  }

  setInventory(entries: RmuxInventoryEntry[] | null): void {
    this.inventoryOverride = entries ? entries.map((entry) => ({ ...entry, tags: [...entry.tags] })) : null;
  }

  setDiagnostics(value: Partial<RmuxDiagnostics>): void {
    this.diagnosticsValue = { ...this.diagnosticsValue, ...value };
  }

  configureFailure(op: RmuxDriverOp, error: Error, times = Number.POSITIVE_INFINITY): void {
    this.failures.set(op, { error, remaining: times });
  }

  clearFailure(op: RmuxDriverOp): void {
    this.failures.delete(op);
  }

  configureDelay(op: RmuxDriverOp, ms: number): void {
    this.delays.set(op, ms);
  }

  clearDelay(op: RmuxDriverOp): void {
    this.delays.delete(op);
  }

  crashDriver(error?: Error): void {
    this.crashed = true;
    if (error) this.crashError = error;
    for (const session of [...this.sessionsById.values()]) {
      session.alive = false;
      for (const queue of session.subscribers) {
        // Prefer a clean exit event so viewers/reconciler match process-owned
        // sidecar death (recover stream ends with exit, inventory goes empty).
        queue.push({ type: "exit" });
        queue.close();
      }
      session.subscribers.clear();
      this.sessionsByPane.delete(session.paneId);
      this.sessionsByName.delete(session.name);
    }
    this.sessionsById.clear();
    this.inventoryOverride = [];
  }

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
