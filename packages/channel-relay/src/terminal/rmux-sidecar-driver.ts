// Node client for the process-owned xacpx-rmux-bridge NDJSON protocol.
import { Buffer } from "node:buffer";
import { EventEmitter } from "node:events";

import {
  RmuxDriverCrashedError,
  RmuxInvalidUtf8InputError,
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

const MAX_LINE_BYTES = 96 * 1024;
const MAX_INPUT_BYTES = 64 * 1024;
const DEFAULT_REQUEST_TIMEOUT_MS = 15_000;
const SIDECAR_PROTOCOL_VERSION = 2;
/** Must match the Rust sidecar `REBASE_CHUNK_BYTES`. */
const REBASE_CHUNK_BYTES = 48 * 1024;
const MAX_REBASE_TOTAL_BYTES = 2 * 1024 * 1024;
/** Cap for bytes buffered after the last rebase for late multi-viewer joins.
 *  Matches the recovery size budget. Overflow asks RMUX for a fresh snapshot
 *  instead of synthesizing an oversized keyframe. */
const MAX_BYTES_SINCE_REBASE = 2 * 1024 * 1024;

type RebaseEvent = Extract<RmuxRecoveryEvent, { type: "rebase" }>;
type BytesEvent = Extract<RmuxRecoveryEvent, { type: "bytes" }>;

type PaneRecoveryCache = {
  rebase: RebaseEvent;
  bytes: BytesEvent[];
  bytesTotal: number;
};

type RebaseAssembly = {
  epoch: number;
  nextSequence: number;
  cols: number;
  rows: number;
  alternate: boolean;
  reason?: string;
  totalBytes: number;
  chunkCount: number;
  chunks: Uint8Array[];
};

export interface SidecarStdio {
  stdin: NodeJS.WritableStream;
  stdout: NodeJS.ReadableStream;
  stderr?: NodeJS.ReadableStream;
  kill?: (signal?: NodeJS.Signals) => void;
  on?: (event: "exit" | "error", listener: (...args: unknown[]) => void) => void;
}

type Pending = {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

type RecoverSubscriber = {
  push: (event: RmuxRecoveryEvent) => void;
  close: (err?: Error) => void;
};

export class RmuxSidecarDriver implements RmuxTerminalDriver {
  private readonly child: SidecarStdio;
  private readonly pending = new Map<string, Pending>();
  private readonly recoveries = new Map<string, Set<RecoverSubscriber>>();
  private readonly emitter = new EventEmitter();
  private buf = Buffer.alloc(0);
  private nextId = 1;
  private crashed = false;
  private handshaken = false;
  private diagnosticsCache: RmuxDiagnostics | null = null;
  private readonly requestTimeoutMs: number;
  /** Trailing sidecar stderr (protocol stays on stdout). Surfaced on crash. */
  private stderrTail = "";
  /**
   * Per-pane recovery snapshot for late multi-viewer subscribers: last rebase
   * plus every bytes event since that rebase. A second `recover` against the
   * Rust actor would abort the first stream, so late joiners must catch up
   * from this cache before joining the live fan-out.
   */
  private readonly recoveryCache = new Map<string, PaneRecoveryCache>();
  private readonly rebaseAssembly = new Map<string, RebaseAssembly>();
  /** Panes waiting for a fresh RMUX rebase after the catch-up cache hit its budget. */
  private readonly snapshotRefresh = new Set<string>();

  constructor(child: SidecarStdio, opts: { requestTimeoutMs?: number } = {}) {
    this.child = child;
    this.requestTimeoutMs = opts.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    child.stdout.on("data", (chunk: Buffer | string) => {
      this.onStdout(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
    });
    child.stderr?.on("data", (chunk: Buffer | string) => {
      const text = typeof chunk === "string" ? chunk : chunk.toString("utf8");
      this.stderrTail = `${this.stderrTail}${text}`.slice(-4 * 1024);
    });
    child.on?.("exit", () => this.crash(this.crashError()));
    child.on?.("error", () => this.crash(this.crashError()));
  }

  async handshake(): Promise<RmuxDiagnostics> {
    const res = (await this.request({
      type: "handshake",
      protocol_version: SIDECAR_PROTOCOL_VERSION,
    })) as {
      type: string;
      bridge_version: string;
      rmux_wire_version: string;
      capabilities: string[];
    };
    if (res.type !== "handshake-ok") {
      throw this.crashError();
    }
    this.handshaken = true;
    this.diagnosticsCache = {
      bridgeVersion: res.bridge_version,
      rmuxWireVersion: res.rmux_wire_version,
      capabilities: res.capabilities ?? [],
    };
    return this.diagnosticsCache;
  }

  async create(input: RmuxCreateSessionInput): Promise<RmuxSessionHandle> {
    this.assertReady();
    try {
      const res = (await this.request({
        type: "create",
        name: input.name,
        cwd: input.cwd,
        cols: input.cols,
        rows: input.rows,
        history_limit: input.historyLimit,
        tags: [...input.tags],
        owner_lease_ttl_seconds: input.ownerLeaseTtlSeconds,
      })) as {
        type: string;
        session_id: string;
        pane_id: string;
        name: string;
        tags: string[];
        code?: string;
        message?: string;
      };
      if (res.type === "error") {
        if (res.message?.includes("already in use")) {
          throw new RmuxSessionNameConflictError(input.name);
        }
        throw new Error(res.message ?? "create failed");
      }
      return {
        sessionId: res.session_id,
        paneId: res.pane_id,
        name: res.name,
        tags: res.tags ?? [],
      };
    } catch (err) {
      if (err instanceof RmuxSessionNameConflictError) throw err;
      throw mapUnavailable(err);
    }
  }

  async list(): Promise<RmuxInventoryEntry[]> {
    this.assertReady();
    const res = (await this.request({ type: "list" })) as {
      type: string;
      entries?: Array<{ session_id: string; pane_id: string; name: string; tags: string[] }>;
    };
    return (res.entries ?? []).map((e) => ({
      sessionId: e.session_id,
      paneId: e.pane_id,
      name: e.name,
      tags: e.tags ?? [],
    }));
  }

  async kill(sessionId: string): Promise<void> {
    this.assertReady();
    await this.request({ type: "kill", session_id: sessionId });
  }

  async input(paneId: string, bytes: Uint8Array): Promise<void> {
    this.assertReady();
    if (bytes.byteLength > MAX_INPUT_BYTES) {
      throw new Error("input too large");
    }
    try {
      new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      throw new RmuxInvalidUtf8InputError();
    }
    try {
      await this.request({
        type: "input",
        pane_id: paneId,
        data_base64: Buffer.from(bytes).toString("base64"),
      });
    } catch (err) {
      throw mapPaneError(paneId, err);
    }
  }

  async resize(paneId: string, cols: number, rows: number): Promise<void> {
    this.assertReady();
    try {
      await this.request({ type: "resize", pane_id: paneId, cols, rows });
    } catch (err) {
      throw mapPaneError(paneId, err);
    }
  }

  async *recover(paneId: string, signal?: AbortSignal): AsyncGenerator<RmuxRecoveryEvent> {
    this.assertReady();
    const queue = new AsyncQueue<RmuxRecoveryEvent>();
    let set = this.recoveries.get(paneId);
    const isFirst = !set || set.size === 0;
    if (!set) {
      set = new Set();
      this.recoveries.set(paneId, set);
    }
    const sub: RecoverSubscriber = {
      push: (e) => queue.push(e),
      close: (err) => queue.close(err),
    };
    const onAbort = () => queue.close();
    if (signal?.aborted) onAbort();
    else signal?.addEventListener("abort", onAbort, { once: true });
    try {
      // One sidecar recover stream per pane; fan out to all Node subscribers.
      // A second recover request would abort the first in the Rust actor.
      if (isFirst) {
        set.add(sub);
        await this.request({ type: "recover", pane_id: paneId });
      } else {
        // Catch up BEFORE joining live fan-out so buffered bytes are not
        // interleaved after a live event that arrived during subscribe.
        this.pushCatchUp(paneId, sub);
        set.add(sub);
      }
      for await (const event of queue) {
        yield event;
        if (event.type === "exit") break;
      }
    } finally {
      signal?.removeEventListener("abort", onAbort);
      set.delete(sub);
      if (set.size === 0) {
        this.recoveries.delete(paneId);
        this.recoveryCache.delete(paneId);
        // Best-effort unsubscribe — never block stream teardown on a hung sidecar.
        void this.request({ type: "stop-recover", pane_id: paneId }, 1_000).catch(() => {});
      }
    }
  }

  /** Replay cached rebase (+ post-rebase bytes) so a late viewer starts at the
   *  same live sequence cursor as existing subscribers. */
  private pushCatchUp(paneId: string, sub: RecoverSubscriber): void {
    const cache = this.recoveryCache.get(paneId);
    if (!cache) return;
    sub.push(cloneRecoveryEvent(cache.rebase));
    for (const bytes of cache.bytes) sub.push(cloneRecoveryEvent(bytes));
  }

  async diagnostics(): Promise<RmuxDiagnostics> {
    this.assertReady();
    if (this.diagnosticsCache) {
      return {
        ...this.diagnosticsCache,
        capabilities: [...this.diagnosticsCache.capabilities],
      };
    }
    const res = (await this.request({ type: "diagnostics" })) as {
      bridge_version: string;
      rmux_wire_version: string;
      capabilities: string[];
    };
    this.diagnosticsCache = {
      bridgeVersion: res.bridge_version,
      rmuxWireVersion: res.rmux_wire_version,
      capabilities: res.capabilities ?? [],
    };
    return this.diagnosticsCache;
  }

  async shutdown(): Promise<void> {
    if (this.crashed) return;
    try {
      await this.request({ type: "shutdown" }, 5_000);
    } catch {
      // ignore
    }
    this.child.kill?.("SIGTERM");
    this.crash(this.crashError());
  }

  /** Abort pending RPCs and kill the child without waiting for a shutdown ack. */
  dispose(): void {
    this.crash(this.crashError());
  }

  private crashError(): RmuxDriverCrashedError {
    const detail = this.stderrTail.replace(/\s+/g, " ").trim();
    return new RmuxDriverCrashedError(detail || undefined);
  }

  private assertReady(): void {
    if (this.crashed) throw this.crashError();
    if (!this.handshaken) throw new RmuxDriverCrashedError();
  }

  private request(payload: Record<string, unknown>, timeoutMs = this.requestTimeoutMs): Promise<unknown> {
    if (this.crashed) return Promise.reject(this.crashError());
    const id = String(this.nextId++);
    const body = { ...payload, id };
    const line = `${JSON.stringify(body)}\n`;
    if (Buffer.byteLength(line) > MAX_LINE_BYTES) {
      return Promise.reject(new Error("request line too large"));
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error("sidecar request timeout"));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.child.stdin.write(line, (err) => {
          if (err) {
            clearTimeout(timer);
            this.pending.delete(id);
            reject(err);
          }
        });
      } catch (err) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }

  private onStdout(chunk: Buffer): void {
    this.buf = Buffer.concat([this.buf, chunk]);
    while (true) {
      const idx = this.buf.indexOf(0x0a);
      if (idx < 0) {
        if (this.buf.length > MAX_LINE_BYTES) {
          this.crash(new Error("sidecar stdout line too large"));
        }
        return;
      }
      const lineBuf = this.buf.subarray(0, idx);
      this.buf = this.buf.subarray(idx + 1);
      if (lineBuf.length > MAX_LINE_BYTES) {
        this.crash(new Error("sidecar stdout line too large"));
        return;
      }
      const line = lineBuf.toString("utf8").replace(/\r$/, "");
      if (!line) continue;
      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(line) as Record<string, unknown>;
      } catch {
        this.crash(new Error("sidecar stdout is not JSON"));
        return;
      }
      this.dispatch(msg);
    }
  }

  private dispatch(msg: Record<string, unknown>): void {
    if (msg.type === "event") {
      const paneId = String(msg.pane_id ?? "");
      const event = this.ingestSidecarEvent(paneId, msg.event as Record<string, unknown>);
      if (!event) return;
      this.rememberRecoveryEvent(paneId, event);
      const set = this.recoveries.get(paneId);
      if (!set) return;
      for (const sub of set) sub.push(event);
      return;
    }

    const id = typeof msg.id === "string" ? msg.id : undefined;
    if (!id) {
      this.crash(new Error("sidecar response missing id"));
      return;
    }
    const pending = this.pending.get(id);
    if (!pending) {
      // duplicate / late — treat as protocol violation for req/res ids we minted
      return;
    }
    clearTimeout(pending.timer);
    this.pending.delete(id);
    if (msg.type === "error") {
      pending.reject(new Error(String(msg.message ?? msg.code ?? "sidecar error")));
      return;
    }
    pending.resolve(msg);
  }

  /**
   * Reassemble sidecar rebase-start/chunk/end into one driver rebase event.
   * Incomplete frames stay buffered; protocol violations fence the child.
   */
  private ingestSidecarEvent(
    paneId: string,
    raw: Record<string, unknown> | undefined,
  ): RmuxRecoveryEvent | null {
    if (!raw || typeof raw.type !== "string") return null;
    if (raw.type === "rebase-start") {
      const totalBytes = Number(raw.total_bytes ?? 0);
      const chunkCount = Number(raw.chunk_count ?? 0);
      if (!Number.isInteger(totalBytes) || totalBytes < 0 || totalBytes > MAX_REBASE_TOTAL_BYTES) {
        this.crash(new Error("sidecar rebase-start total_bytes invalid"));
        return null;
      }
      const expectedChunks = totalBytes === 0 ? 0 : Math.ceil(totalBytes / REBASE_CHUNK_BYTES);
      if (!Number.isInteger(chunkCount) || chunkCount !== expectedChunks) {
        this.crash(new Error("sidecar rebase-start chunk_count mismatch"));
        return null;
      }
      this.rebaseAssembly.set(paneId, {
        epoch: Number(raw.epoch ?? 0),
        nextSequence: Number(raw.next_sequence ?? 0),
        cols: Number(raw.cols ?? 0),
        rows: Number(raw.rows ?? 0),
        alternate: Boolean(raw.alternate),
        ...(typeof raw.reason === "string" ? { reason: raw.reason } : {}),
        totalBytes,
        chunkCount,
        chunks: [],
      });
      return null;
    }
    if (raw.type === "rebase-chunk") {
      const assembly = this.rebaseAssembly.get(paneId);
      if (!assembly) {
        this.crash(new Error("sidecar rebase-chunk without start"));
        return null;
      }
      const index = Number(raw.index ?? -1);
      if (index !== assembly.chunks.length) {
        this.crash(new Error("sidecar rebase-chunk index mismatch"));
        return null;
      }
      const data = Buffer.from(String(raw.data_base64 ?? ""), "base64");
      if (data.byteLength > REBASE_CHUNK_BYTES) {
        this.crash(new Error("sidecar rebase-chunk too large"));
        return null;
      }
      assembly.chunks.push(new Uint8Array(data));
      return null;
    }
    if (raw.type === "rebase-end") {
      const assembly = this.rebaseAssembly.get(paneId);
      this.rebaseAssembly.delete(paneId);
      if (!assembly) {
        this.crash(new Error("sidecar rebase-end without start"));
        return null;
      }
      if (Number(raw.epoch ?? 0) !== assembly.epoch) {
        this.crash(new Error("sidecar rebase-end epoch mismatch"));
        return null;
      }
      if (assembly.chunks.length !== assembly.chunkCount) {
        this.crash(new Error("sidecar rebase-end chunk count mismatch"));
        return null;
      }
      const keyframe = new Uint8Array(assembly.totalBytes);
      let offset = 0;
      for (const chunk of assembly.chunks) {
        keyframe.set(chunk, offset);
        offset += chunk.byteLength;
      }
      if (offset !== assembly.totalBytes) {
        this.crash(new Error("sidecar rebase-end byte count mismatch"));
        return null;
      }
      return {
        type: "rebase",
        epoch: assembly.epoch,
        nextSequence: assembly.nextSequence,
        cols: assembly.cols,
        rows: assembly.rows,
        alternate: assembly.alternate,
        keyframe,
        ...(assembly.reason !== undefined ? { reason: assembly.reason } : {}),
      };
    }
    if (this.rebaseAssembly.has(paneId) && (raw.type === "bytes" || raw.type === "exit" || raw.type === "error")) {
      this.crash(new Error("sidecar event during rebase assembly"));
      return null;
    }
    return mapEvent(raw);
  }

  private rememberRecoveryEvent(paneId: string, event: RmuxRecoveryEvent): void {
    if (event.type === "rebase") {
      this.snapshotRefresh.delete(paneId);
      this.recoveryCache.set(paneId, {
        rebase: cloneRecoveryEvent(event),
        bytes: [],
        bytesTotal: 0,
      });
      return;
    }
    if (event.type !== "bytes") return;
    const cache = this.recoveryCache.get(paneId);
    if (!cache) return;
    const nextTotal = cache.bytesTotal + event.data.byteLength;
    if (nextTotal > MAX_BYTES_SINCE_REBASE) {
      // Do not fold into a synthetic keyframe — that would exceed the 2 MiB
      // rebase cap. Keep the last real snapshot and ask RMUX for a fresh one.
      if (!this.snapshotRefresh.has(paneId)) {
        this.snapshotRefresh.add(paneId);
        void this.refreshPaneSnapshot(paneId);
      }
      return;
    }
    cache.bytes.push(cloneRecoveryEvent(event));
    cache.bytesTotal = nextTotal;
  }

  private async refreshPaneSnapshot(paneId: string): Promise<void> {
    try {
      await this.request({ type: "stop-recover", pane_id: paneId }, 1_000).catch(() => {});
      if (this.crashed) return;
      await this.request({ type: "recover", pane_id: paneId });
    } catch {
      this.snapshotRefresh.delete(paneId);
    }
  }

  private crash(err: Error): void {
    if (this.crashed) return;
    this.crashed = true;
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(err instanceof RmuxDriverCrashedError ? err : this.crashError());
    }
    this.pending.clear();
    for (const set of this.recoveries.values()) {
      for (const sub of set) sub.close(err);
    }
    this.recoveries.clear();
    this.recoveryCache.clear();
    this.rebaseAssembly.clear();
    this.snapshotRefresh.clear();
    this.emitter.emit("crash", err);
    // Fatal protocol corruption: kill the child so the supervisor can restart.
    try {
      this.child.kill?.("SIGTERM");
    } catch {
      // ignore
    }
  }

  /** Test/supervisor seam: notified after pending/recovery are fenced. */
  onCrash(listener: (err: Error) => void): void {
    this.emitter.on("crash", listener);
  }
}

function mapUnavailable(err: unknown): Error {
  if (err instanceof RmuxDriverCrashedError) return err;
  return err instanceof Error ? err : new Error(String(err));
}

function mapPaneError(paneId: string, err: unknown): Error {
  const msg = err instanceof Error ? err.message : String(err);
  if (msg.includes("pane not found")) return new RmuxPaneNotFoundError(paneId);
  if (msg.includes("session not found")) return new RmuxSessionNotFoundError(msg);
  return mapUnavailable(err);
}

function mapEvent(raw: Record<string, unknown> | undefined): RmuxRecoveryEvent | null {
  if (!raw || typeof raw.type !== "string") return null;
  if (raw.type === "bytes") {
    const data = Buffer.from(String(raw.data_base64 ?? ""), "base64");
    return {
      type: "bytes",
      epoch: Number(raw.epoch ?? 0),
      sequence: Number(raw.sequence ?? 0),
      data: new Uint8Array(data),
    };
  }
  if (raw.type === "exit") {
    return {
      type: "exit",
      ...(raw.code !== undefined && raw.code !== null ? { code: Number(raw.code) } : {}),
    };
  }
  if (raw.type === "error") {
    return {
      type: "error",
      code: String(raw.code ?? "rebase-too-large"),
      message: String(raw.message ?? "rebase keyframe too large"),
    };
  }
  return null;
}

function cloneRecoveryEvent<T extends RmuxRecoveryEvent>(event: T): T {
  if (event.type === "rebase") {
    return {
      ...event,
      keyframe: event.keyframe.slice(),
    };
  }
  if (event.type === "bytes") {
    return {
      ...event,
      data: event.data.slice(),
    };
  }
  return { ...event };
}

class AsyncQueue<T> implements AsyncIterable<T> {
  private buffer: T[] = [];
  private waiters: Array<(r: IteratorResult<T>) => void> = [];
  private rejecters: Array<(e: unknown) => void> = [];
  private closed = false;
  private closeError: unknown;

  push(item: T): void {
    if (this.closed) return;
    const w = this.waiters.shift();
    this.rejecters.shift();
    if (w) w({ value: item, done: false });
    else this.buffer.push(item);
  }

  close(err?: unknown): void {
    if (this.closed) return;
    this.closed = true;
    this.closeError = err;
    while (this.waiters.length) {
      const w = this.waiters.shift()!;
      const r = this.rejecters.shift();
      if (err !== undefined && r) r(err);
      else w({ value: undefined as never, done: true });
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: () => {
        if (this.buffer.length) return Promise.resolve({ value: this.buffer.shift() as T, done: false });
        if (this.closed) {
          if (this.closeError !== undefined) return Promise.reject(this.closeError);
          return Promise.resolve({ value: undefined as never, done: true });
        }
        return new Promise((resolve, reject) => {
          this.waiters.push(resolve);
          this.rejecters.push(reject);
        });
      },
      return: async () => {
        this.close();
        return { value: undefined as never, done: true };
      },
    };
  }
}
