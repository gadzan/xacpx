import { spawn, type ChildProcess } from "node:child_process";
import { createInterface } from "node:readline";

import {
  encodeWorkerMessage,
  parseWorkerLine,
  type RuntimeWorkerRequest,
  type RuntimeWorkerRequestMethod,
  type RuntimeWorkerResponse,
} from "./runtime-worker-protocol";
import { mapRuntimeError } from "./runtime-contract";
import { terminateProcessTree } from "../../../process/terminate-process-tree";

export interface RuntimeWorkerRef {
  pid: number;
  /** Stable ownership identity (plan §44). */
  logicalSessionId: string;
  startedAt: string;
  generation: string;
}

export type WorkerLifecycle = "starting" | "ready" | "busy" | "idle" | "cooling" | "stopped" | "failed";

interface PendingCall {
  resolve: (value: unknown) => void;
  reject: (error: unknown) => void;
}

/**
 * One client per worker process. Speaks the §10 JSON-Lines protocol over the
 * child's stdio and tracks its lifecycle from the host's point of view.
 */
export class RuntimeWorkerClient {
  readonly ref: RuntimeWorkerRef;
  lifecycle: WorkerLifecycle = "starting";

  private child?: ChildProcess;
  private readonly pending = new Map<string, PendingCall>();
  private nextRequestId = 1;

  constructor(
    private readonly entryPath: string,
    private readonly logicalSessionId: string,
    private readonly generation = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    private readonly onExit?: (client: RuntimeWorkerClient, code: number | null) => void,
  ) {
    this.ref = { pid: -1, logicalSessionId, startedAt: new Date().toISOString(), generation };
  }

  get alive(): boolean {
    return this.child !== undefined && this.child.exitCode === null && this.child.pid !== undefined;
  }

  spawn(): void {
    if (this.child) return;
    this.child = spawn(process.execPath, [this.entryPath], { stdio: ["pipe", "pipe", "pipe"] });
    this.ref.pid = this.child.pid ?? -1;
    this.child.on("exit", (code) => {
      this.lifecycle = this.lifecycle === "failed" ? "failed" : "stopped";
      for (const pending of this.pending.values()) {
        pending.reject(new Error("runtime worker exited before responding"));
      }
      this.pending.clear();
      this.onExit?.(this, code);
    });
    const rl = createInterface({ input: this.child.stdout!, crlfDelay: Infinity });
    rl.on("line", (line) => this.handleLine(line));
    this.child.stderr?.on("data", () => {
      /* diagnostics only; protocol lives on stdout */
    });
  }

  private handleLine(line: string): void {
    const message = parseWorkerLine(line);
    if (!message || !("ok" in message)) return; // events are consumed by prompt() callers
    const pending = this.pending.get(message.id);
    if (!pending) return;
    const response = message as unknown as RuntimeWorkerResponse;
    this.pending.delete(message.id);
    if (response.ok) pending.resolve(response.result);
    else pending.reject(new WorkerRpcError(response.error.code, response.error.message));
  }

  request<T>(method: RuntimeWorkerRequestMethod, params?: unknown): Promise<T> {
    if (!this.alive) {
      this.spawn();
    }
    const id = `w${this.nextRequestId++}`;
    const payload: RuntimeWorkerRequest = { id, method, ...(params !== undefined ? { params } : {}) };
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (value: unknown) => void, reject });
      this.child!.stdin!.write(encodeWorkerMessage(payload), (error) => {
        if (error) {
          this.pending.delete(id);
          reject(error);
        }
      });
    });
  }

  /** Graceful shutdown request, then hard kill after a bounded grace (plan §16). */
  async shutdown(graceMs = 2_000): Promise<void> {
    if (!this.alive) return;
    this.lifecycle = "cooling";
    try {
      await Promise.race([
        this.request("shutdown"),
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error("grace elapsed")), graceMs).unref()),
      ]);
    } catch {
      // fall through to terminate
    }
    await this.terminate();
  }

  async terminate(): Promise<void> {
    if (!this.child || this.ref.pid <= 0) return;
    // Host-side kill is the release primitive; the child's stdin EOF handler
    // exits it cleanly, terminateProcessTree covers hung adapters.
    try {
      this.child.stdin?.end();
    } catch {
      /* already closed */
    }
    await terminateProcessTree(this.ref.pid);
    this.lifecycle = "stopped";
  }
}

export class WorkerCrashError extends Error {
  readonly code = "RUNTIME_WORKER_CRASHED";
  constructor(message: string) {
    super(message);
  }
}

export class WorkerRpcError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
  }
}

