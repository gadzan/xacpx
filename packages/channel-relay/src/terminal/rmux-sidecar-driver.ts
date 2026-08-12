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
  /** Last rebase per pane — late multi-viewer subscribers need a keyframe. */
  private readonly lastRebase = new Map<string, RmuxRecoveryEvent>();

  constructor(child: SidecarStdio, opts: { requestTimeoutMs?: number } = {}) {
    this.child = child;
    this.requestTimeoutMs = opts.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    child.stdout.on("data", (chunk: Buffer | string) => {
      this.onStdout(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
    });
    child.on?.("exit", () => this.crash(new RmuxDriverCrashedError()));
    child.on?.("error", () => this.crash(new RmuxDriverCrashedError()));
  }

  async handshake(): Promise<RmuxDiagnostics> {
    const res = (await this.request({
      type: "handshake",
      protocol_version: 1,
    })) as {
      type: string;
      bridge_version: string;
      rmux_wire_version: string;
      capabilities: string[];
    };
    if (res.type !== "handshake-ok") {
      throw new RmuxDriverCrashedError();
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

  async *recover(paneId: string): AsyncGenerator<RmuxRecoveryEvent> {
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
    set.add(sub);
    try {
      // One sidecar recover stream per pane; fan out to all Node subscribers.
      // A second recover request would abort the first in the Rust actor.
      if (isFirst) {
        await this.request({ type: "recover", pane_id: paneId });
      } else {
        const cached = this.lastRebase.get(paneId);
        if (cached) queue.push(cached);
      }
      for await (const event of queue) {
        yield event;
        if (event.type === "exit") break;
      }
    } finally {
      set.delete(sub);
      if (set.size === 0) {
        this.recoveries.delete(paneId);
        this.lastRebase.delete(paneId);
        // Best-effort unsubscribe — never block stream teardown on a hung sidecar.
        void this.request({ type: "stop-recover", pane_id: paneId }, 1_000).catch(() => {});
      }
    }
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
    this.crash(new RmuxDriverCrashedError());
  }

  private assertReady(): void {
    if (this.crashed) throw new RmuxDriverCrashedError();
    if (!this.handshaken) throw new RmuxDriverCrashedError();
  }

  private request(payload: Record<string, unknown>, timeoutMs = this.requestTimeoutMs): Promise<unknown> {
    if (this.crashed) return Promise.reject(new RmuxDriverCrashedError());
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
      const event = mapEvent(msg.event as Record<string, unknown>);
      if (!event) return;
      if (event.type === "rebase") this.lastRebase.set(paneId, event);
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

  private crash(err: Error): void {
    if (this.crashed) return;
    this.crashed = true;
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(err instanceof RmuxDriverCrashedError ? err : new RmuxDriverCrashedError());
    }
    this.pending.clear();
    for (const set of this.recoveries.values()) {
      for (const sub of set) sub.close(err);
    }
    this.recoveries.clear();
    this.lastRebase.clear();
    this.emitter.emit("crash", err);
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
  if (raw.type === "rebase") {
    const keyframe = Buffer.from(String(raw.keyframe_base64 ?? ""), "base64");
    return {
      type: "rebase",
      epoch: Number(raw.epoch ?? 0),
      nextSequence: Number(raw.next_sequence ?? 0),
      cols: Number(raw.cols ?? 0),
      rows: Number(raw.rows ?? 0),
      alternate: Boolean(raw.alternate),
      keyframe: new Uint8Array(keyframe),
      ...(typeof raw.reason === "string" ? { reason: raw.reason } : {}),
    };
  }
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
  return null;
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
