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
import { probeWindowsProcessIdentity } from "../../../process/windows-process-tree";

export interface RuntimeWorkerRef {
  pid: number;
  /** Stable ownership identity (plan §44). */
  logicalSessionId: string;
  startedAt: string;
  generation: string;
  /** Windows creation date for verified tree termination (prevent PID reuse). */
  creationDate?: string | null;
}

export type WorkerLifecycle = "starting" | "ready" | "busy" | "idle" | "cooling" | "stopped" | "failed";

interface PendingCall {
  resolve: (value: unknown) => void;
  reject: (error: unknown) => void;
  /** Live event sink for request-scoped pushes (prompt streaming). */
  onEvent?: (payload: unknown) => void;
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
  /** True only when the host deliberately requested cooling, shutdown, or delete. */
  private deliberateShutdown = false;

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
    if (process.platform === "win32" && this.ref.pid > 0) {
      void probeWindowsProcessIdentity(this.ref.pid).then((res) => {
        if (res.status === "found") this.ref.creationDate = res.identity.creationDate;
      });
    }
    this.child.on("exit", (code) => {
      // Plan §43: deliberate stop vs unexpected crash is classified by INTENT,
      // not raw exit code. Signal exits and clean-exit crashes are both caught.
      const unexpected = !this.deliberateShutdown;
      this.lifecycle = unexpected ? "failed" : "stopped";
      for (const pending of this.pending.values()) {
        pending.reject(
          unexpected
            ? new WorkerCrashError(`runtime worker (pid ${this.ref.pid}) crashed unexpectedly (code ${code ?? "signal"})`)
            : new Error("runtime worker was terminated deliberately"),
        );
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
    const parsed = parseWorkerLine(line);
    if (!parsed) return;
    if (parsed.kind === "event") {
      // Real-time push: forward to the still-pending request's sink while the
      // RPC itself stays open — this is what keeps prompt streaming live.
      const id = typeof parsed.message.id === "string" ? parsed.message.id : null;
      const pending = id ? this.pending.get(id) : undefined;
      pending?.onEvent?.(parsed.message.payload);
      return;
    }
    if (parsed.kind !== "response") return;
    const response = parsed.message as unknown as RuntimeWorkerResponse;
    const pending = this.pending.get(response.id);
    if (!pending) return;
    this.pending.delete(response.id);
    if (response.ok) pending.resolve(response.result);
    else pending.reject(new WorkerRpcError(response.error.code, response.error.message));
  }

  request<T>(method: RuntimeWorkerRequestMethod, params?: unknown, options?: { onEvent?: (payload: unknown) => void }): Promise<T> {
    if (!this.alive) {
      this.spawn();
    }
    const id = `w${this.nextRequestId++}`;
    const payload: RuntimeWorkerRequest = { id, method, ...(params !== undefined ? { params } : {}) };
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (value: unknown) => void, reject, ...(options?.onEvent ? { onEvent: options.onEvent } : {}) });
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
    this.deliberateShutdown = true;
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
    this.deliberateShutdown = true;
    this.lifecycle = "cooling";
    try {
      this.child.stdin?.end();
    } catch {
      /* already closed */
    }
    // Verified tree termination (plan §44): pass creation date on Windows
    // to prevent accidental kill if the PID was recycled by the OS.
    await terminateProcessTree({
      pid: this.ref.pid,
      creationDate: this.ref.creationDate ?? null,
    });
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

