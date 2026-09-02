import { spawn, type ChildProcess } from "node:child_process";
import { createInterface } from "node:readline";

import {
  encodeWorkerMessage,
  parseWorkerLine,
  type RuntimeWorkerRequest,
  type RuntimeWorkerRequestMethod,
  type RuntimeWorkerResponse,
  type RuntimeWorkerPermissionRequestPayload,
  type RuntimeWorkerPermissionDecisionParams,
} from "./runtime-worker-protocol";
import { mapRuntimeError } from "./runtime-contract";
import { terminateProcessTree } from "../../../process/terminate-process-tree";
import {
  probeWindowsProcessIdentity,
  terminateWindowsDescendantsOf,
  type WindowsProbeStatus,
  type TerminateProcessTreeResult,
  type KillOutcome,
} from "../../../process/windows-process-tree";

export interface RuntimeWorkerRef {
  pid: number;
  /** Stable ownership identity (plan §44). */
  logicalSessionId: string;
  startedAt: string;
  generation: string;
  /** Windows creation date for verified tree termination (prevent PID reuse). */
  creationDate?: string | null;
}

export interface RuntimeWorkerClientDeps {
  probeWindowsIdentity?: (pid: number) => Promise<WindowsProbeStatus>;
  terminateProcessTree?: typeof terminateProcessTree;
  platform?: NodeJS.Platform;
  /**
   * Durable admission barrier (round 30 Blocking 2): invoked with the
   * verified Windows identity and awaited by bootstrap — the returned promise
   * must resolve only when the verified fence is durably on disk. Bootstrap
   * (and therefore every business RPC) stays blocked until it does; a
   * rejection fails the worker closed.
   */
  onIdentityVerified?: (client: RuntimeWorkerClient) => void | Promise<void>;
  /** Fence discharge seams (tests): verified orphan-tree terminator + POSIX group kill. */
  terminateDescendantsOf?: typeof terminateWindowsDescendantsOf;
  killProcessGroup?: (pgid: number) => void;
  /** Tri-state POSIX group probe for fence discharge (round 31 Blocking 4). */
  probeProcessGroup?: (pgid: number) => "alive" | "gone" | "unknown";
  /** Cross-host self-discharge wait for the stale-fence phase table (ms). */
  selfDischargeWaitMs?: number;
  /**
   * Round 32 Blocking 3 — spool handshake: are residuals of this fence
   * generation still pending in the orphan registry? Default scans
   * `<config runtime>/orphans/residuals`.
   */
  spooledResidualsRemaining?: (generationId: string) => Promise<boolean>;
  /** Extra env passed to the worker process (durable-fence phase marking). */
  spawnEnv?: Record<string, string>;
  /**
   * PR9-A: Host-side resolver for interactive permission requests.
   * Called when the worker emits `permission.request`. Must return an explicit
   * PermissionDecision union; any throw/timeout/malformed is mapped to `reject_once`/`cancel` fail-closed.
   */
  resolvePermissionRequest?: (payload: RuntimeWorkerPermissionRequestPayload) => Promise<RuntimeWorkerPermissionDecisionParams["decision"]>;
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
  private bootstrapPromise?: Promise<void>;
  private _bootstrapVerified = false;
  private inFlightLeases = 0;
  private exitPromise?: Promise<number | null>;
  private resolveExit?: (code: number | null) => void;
  private shutdownAckPromise?: Promise<unknown>;
  get isBootstrapVerified(): boolean {
    return this._bootstrapVerified;
  }
  get isDeliberateShutdown(): boolean {
    return this.deliberateShutdown;
  }
  get inFlightCount(): number {
    return Math.max(this.inFlightLeases, this.pending.size);
  }

  get hasInFlight(): boolean {
    return this.inFlightLeases > 0 || this.pending.size > 0 || this.lifecycle === "busy";
  }

  get hasBusinessInFlight(): boolean {
    return this.inFlightLeases > 0;
  }

  constructor(
    private readonly entryPath: string,
    private readonly logicalSessionId: string,
    private readonly generation = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    private readonly onExit?: (client: RuntimeWorkerClient, code: number | null) => void,
    private readonly deps?: RuntimeWorkerClientDeps,
  ) {
    this.ref = { pid: -1, logicalSessionId, startedAt: new Date().toISOString(), generation };
  }

  get alive(): boolean {
    return (
      this.child !== undefined &&
      this.child.exitCode === null &&
      this.child.signalCode === null &&
      this.child.pid !== undefined
  );
  }

  spawn(): void {
    if (this.child) return;
    this.exitPromise = new Promise<number | null>((resolve) => {
      this.resolveExit = resolve;
    });
    this.child = spawn(process.execPath, [this.entryPath], {
      stdio: ["pipe", "pipe", "pipe"],
      detached: process.platform !== "win32",
      windowsHide: true,
      // Durable-fence phase marking env (round 31): the worker marks its own
      // fence discharging/discharged/spooled at EOF, generation-bound.
      env: { ...process.env, ...(this.deps?.spawnEnv ?? {}) },
    });
    this.ref.pid = this.child.pid ?? -1;
    const isWindows = process.platform === "win32" || Boolean(this.deps?.probeWindowsIdentity);
    if (isWindows && this.ref.pid > 0) {
      const probeFn = this.deps?.probeWindowsIdentity ?? probeWindowsProcessIdentity;
      this.bootstrapPromise = probeFn(this.ref.pid).then(async (res) => {
        if (res.status !== "found") {
          this.lifecycle = "failed";
          try {
            this.child?.kill("SIGTERM");
          } catch {
            // best-effort cleanup on bootstrap fail
          }
          throw new WorkerBootstrapError(
            `Windows process identity probe failed for worker pid ${this.ref.pid} (status: ${res.status}); fail closed`,
          );
        }
        // Immutable identity: once captured, never mutated or re-probed
        this.ref.creationDate = res.identity.creationDate;
        // Round 30 Blocking 2 — durable admission barrier: the verified
        // fence must be ON DISK before bootstrap admissibility. In-memory
        // verification alone races the business RPC that spawns the
        // adapter: a host crash in that window leaves a fence that reads
        // "never verified" while an adapter lives.
        try {
          await this.deps?.onIdentityVerified?.(this);
        } catch (error) {
          this.lifecycle = "failed";
          try {
            this.child?.kill("SIGTERM");
          } catch {
            // already dying
          }
          throw new WorkerBootstrapError(
            `durable worker-ownership fence admission failed for worker pid ${this.ref.pid}: ` +
              `${error instanceof Error ? error.message : String(error)}; no business RPC entered, worker terminated`,
          );
        }
        this._bootstrapVerified = true;
      });
      this.bootstrapPromise.catch(() => {});
    } else {
      this._bootstrapVerified = true;
    }
    this.child.on("exit", (code) => {
      const unexpected = !this.deliberateShutdown;
      if (unexpected) {
        this.lifecycle = "failed";
      }
      for (const pending of this.pending.values()) {
        pending.reject(
          unexpected
            ? new WorkerCrashError(`runtime worker (pid ${this.ref.pid}) crashed unexpectedly (code ${code ?? "signal"})`)
            : new Error("runtime worker was terminated deliberately"),
        );
      }
      this.pending.clear();
      this.resolveExit?.(code);
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
      const raw = parsed.message;
      if (raw && typeof raw === "object" && "event" in raw && (raw as { event: unknown }).event === "permission.request") {
        const payload = (raw as { payload?: unknown }).payload as RuntimeWorkerPermissionRequestPayload | undefined;
        void this.handlePermissionRequest(payload).catch(() => {});
        return;
      }
      // Real-time push: forward to the still-pending request's sink while the
      // RPC itself stays open — this is what keeps prompt streaming live.
      const id = typeof (raw as { id?: unknown }).id === "string" ? (raw as { id: string }).id : null;
      const pending = id ? this.pending.get(id) : undefined;
      const pl = (raw as { payload?: unknown }).payload;
      pending?.onEvent?.(pl);
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

  private async handlePermissionRequest(payload: RuntimeWorkerPermissionRequestPayload | undefined): Promise<void> {
    const requestId = typeof payload?.requestId === "string" ? payload.requestId : "";
    const toolCallId = typeof payload?.toolCallId === "string" ? payload.toolCallId : requestId;
    const policyGeneration = typeof payload?.policyGeneration === "number" ? payload.policyGeneration : 0;
    if (!payload || !requestId) {
      // Malformed → fail closed: send cancel to avoid hanging turn
      try {
        await this.request("permission.decision", { requestId, toolCallId, policyGeneration, decision: { outcome: "cancel" } });
      } catch {}
      return;
    }
    let decision: RuntimeWorkerPermissionDecisionParams["decision"];
    try {
      const handler = this.deps?.resolvePermissionRequest;
      if (!handler) {
        decision = { outcome: "reject_once" };
      } else {
        const withTimeout = await Promise.race([
          handler(payload),
          new Promise<never>((_, reject) => setTimeout(() => reject(new Error("permission UI timeout")), 8_000).unref?.()),
        ]);
        const outcome = (withTimeout as { outcome?: unknown })?.outcome;
        if (outcome !== "allow_once" && outcome !== "allow_always" && outcome !== "reject_once" && outcome !== "reject_always" && outcome !== "cancel") {
          decision = { outcome: "reject_once" };
        } else {
          decision = { outcome } as RuntimeWorkerPermissionDecisionParams["decision"];
        }
      }
    } catch {
      decision = { outcome: "reject_once" };
    }
    try {
      await this.request("permission.decision", { requestId, toolCallId, policyGeneration, decision });
    } catch {}
  }

  async request<T>(method: RuntimeWorkerRequestMethod, params?: unknown, options?: { onEvent?: (payload: unknown) => void }): Promise<T> {
    // Register the in-flight lease immediately at entry (plan §32): ensures
    // quiescence tracking sees this operation even while awaiting the Windows
    // creationDate bootstrap probe.
    this.inFlightLeases++;
    try {
      if (!this.child) {
        this.spawn();
      } else if (
        !this.alive ||
        this.child.stdin?.writableEnded ||
        this.lifecycle === "cooling" ||
        this.lifecycle === "stopped" ||
        this.lifecycle === "failed" ||
        this.deliberateShutdown
      ) {
        throw new WorkerTeardownPendingError(
          `runtime worker client for session "${this.ref.logicalSessionId}" is closed or in teardown (lifecycle: ${this.lifecycle}); refusing request on terminating worker`,
        );
      }
      // Hard gate: identity capture must settle before any business RPC enters the worker
      if (this.bootstrapPromise) {
        await this.bootstrapPromise;
      }
      const id = `w${this.nextRequestId++}`;
      const payload: RuntimeWorkerRequest = { id, method, ...(params !== undefined ? { params } : {}) };
      return await new Promise<T>((resolve, reject) => {
        this.pending.set(id, { resolve: resolve as (value: unknown) => void, reject, ...(options?.onEvent ? { onEvent: options.onEvent } : {}) });
        this.child!.stdin!.write(encodeWorkerMessage(payload), (error) => {
          if (error) {
            this.pending.delete(id);
            reject(error);
          }
        });
      });
    } finally {
      this.inFlightLeases--;
    }
  }

  /**
   * Internal control RPC path (e.g. graceful shutdown): delivers the message
   * to the child process during teardown without triggering the public
   * WorkerTeardownPendingError guard meant for external business RPCs.
   */
  private sendControlMessage<T>(method: RuntimeWorkerRequestMethod, params?: unknown): Promise<T> {
    if (!this.child || !this.alive || this.child.stdin?.writableEnded) {
      return Promise.reject(new Error("cannot send control message to closed worker"));
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
  /** Graceful shutdown request, then process tree cleanup after a bounded grace (plan §16, §18). */
  async shutdown(graceMs = 2_000): Promise<void> {
    // Idempotent: a verified-stopped worker already completed tree cleanup.
    if (!this.alive && this.lifecycle === "stopped") return;
    if (!this.child || this.ref.pid <= 0) return;
    // Deliberate intent is recorded BEFORE any await so a crash race is
    // never misclassified as unexpected (plan §43).
    this.deliberateShutdown = true;
    this.lifecycle = "cooling";
    const platform = this.deps?.platform ?? process.platform;
    if (!this.child?.stdin?.writableEnded) {
      this.shutdownAckPromise ??= this.sendControlMessage("shutdown");
      try {
        await Promise.race([
          this.shutdownAckPromise,
          new Promise<never>((_, reject) => setTimeout(() => reject(new Error("quiesced timeout")), graceMs).unref()),
        ]);
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        // I4: timeout is only a hard failure when business is still in flight.
        // A fake test worker with no pending business that is simply slow to
        // ACK should still proceed to terminate (no late-child race exists).
        const stillBusy = this.hasBusinessInFlight;
        if (msg === "quiesced timeout") {
          if (stillBusy) {
            throw new WorkerTeardownPendingError(
              `runtime worker for session "${this.ref.logicalSessionId}" did not reach quiesced shutdown within ${graceMs}ms; refusing destructive tree termination while business dispatch may still be in flight`,
            );
          }
          // No business in flight — quiescence is already achieved, proceed
        } else {
          if (stillBusy) {
            throw new WorkerTeardownPendingError(
              `runtime worker for session "${this.ref.logicalSessionId}" shutdown failed: ${msg}; refusing destructive tree termination`,
            );
          }
          // No business — log and proceed to terminate anyway (worker may have
          // already exited). Fall through.
        }
      }
    } else {
      // stdin already closed — treat as quiesced
    }
    // If on Windows and creationDate was never verified, wait for child exit before terminate
    // (no business RPC could have entered, but still need clean exit proof).
    if ((platform === "win32" || Boolean(this.deps?.probeWindowsIdentity)) && !this.ref.creationDate && this.exitPromise) {
      try {
        await Promise.race([
          this.exitPromise,
          new Promise<never>((_, reject) => setTimeout(() => reject(new Error("grace elapsed")), graceMs).unref()),
        ]);
      } catch {}
    }
    await this.terminate();
  }

  async terminate(): Promise<void> {
    if (!this.alive && this.lifecycle === "stopped") return;
    if (!this.child) return;
    const wasAliveBeforeTerm = this.alive;
    const isCrashCleanup = !wasAliveBeforeTerm && !this.deliberateShutdown;
    this.deliberateShutdown = true;
    if (!isCrashCleanup) {
      this.lifecycle = "cooling";
    }
    const platform = this.deps?.platform ?? process.platform;
    const termFn = this.deps?.terminateProcessTree ?? terminateProcessTree;

    try {
      if (platform === "win32" || this.deps?.probeWindowsIdentity) {
        if (!this.ref.creationDate) {
          if (this.alive) {
            // Hard rule (plan §44): Windows terminate MUST NOT fall back to bare PID.
            // If identity was never verified on an active process, fail closed.
            throw new Error(
              `cannot terminate Windows worker (pid ${this.ref.pid}) without verified creationDate; refusing bare PID kill`,
            );
          }
          // Worker root already exited during deliberate shutdown and bootstrap was never verified
          // (no business RPC ever entered, so no adapter descendant could have been created).
          if (this.deliberateShutdown && !isCrashCleanup) {
            this.lifecycle = "stopped";
            return;
          }
          throw new Error(
            `cannot verify Windows descendant cleanup for unverified worker (pid ${this.ref.pid}); refusing unverified replacement spawn`,
          );
        }
        const result = await termFn(
          {
            pid: this.ref.pid,
            creationDate: this.ref.creationDate,
          },
          {
            // G10: this is an ownership-sensitive destructive transaction. An
            // external SIGKILL mid-traversal would kill the PowerShell worker
            // AFTER the root but BEFORE the JSON evidence — leaving survivors
            // with no returned fingerprint and forcing fail-closed retention
            // forever. The in-script 8s snapshot watchdog and per-handle 2s
            // WaitDead already bound every primitive, so the outer hard-kill
            // deadline is explicitly disabled (null), not defaulted.
            windowsWorker: { workerDeadlineMs: null },
          },
          platform,
        );

        // On Windows: if rootOutcome is "already-exited" or "skipped-replaced", the tree terminator
        // exited BEFORE taking a CIM snapshot. Because this worker completed bootstrap and could have
        // spawned child adapter descendants, neither outcome proves that descendant processes are dead.
        // We must fail closed (G10 / single-owner invariant).
        if (result && typeof result === "object") {
          if (result.rootOutcome === "already-exited" || result.rootOutcome === "skipped-replaced") {
            throw new Error(
              `cannot verify Windows descendant process tree cleanup for worker pid ${this.ref.pid} (root outcome was "${result.rootOutcome}" before CIM snapshot); refusing unverified replacement spawn`,
            );
          }
        }

        assertProcessTreeTerminated(result, { pid: this.ref.pid, creationDate: this.ref.creationDate });
      } else {
        const result = await termFn(this.ref.pid, { detachedProcessGroup: true }, platform);
        assertProcessTreeTerminated(result, { pid: this.ref.pid });
      }
    } catch (error) {
      this.lifecycle = "failed";
      throw error;
    }
    try {
      this.child.stdin?.end();
    } catch {
      /* already closed */
    }
    if (this.exitPromise && this.alive) {
      await this.exitPromise.catch(() => {});
    }
    this.lifecycle = "stopped";
  }
}

export class WorkerBootstrapError extends Error {
  readonly code = "RUNTIME_WORKER_BOOTSTRAP_FAILED";
  constructor(message: string) {
    super(message);
    this.name = "WorkerBootstrapError";
  }
}

export class WorkerCrashError extends Error {
  readonly code = "RUNTIME_WORKER_CRASHED";
  constructor(message: string) {
    super(message);
  }
}
export class WorkerTeardownPendingError extends Error {
  readonly code = "RUNTIME_WORKER_TEARDOWN_PENDING";
  constructor(message: string) {
    super(message);
    this.name = "WorkerTeardownPendingError";
  }
}
const SAFE_KILL_OUTCOMES = new Set<string>(["killed", "already-exited", "skipped-replaced"]);

/**
 * Validates process tree termination outcome (plan §44).
 * Throws if the root process or any descendant failed to terminate or had an unconfirmed kill.
 */
export function assertProcessTreeTerminated(
  result: void | TerminateProcessTreeResult,
  target: { pid: number; creationDate?: string | null },
): void {
  if (!result || typeof result !== "object" || !("rootOutcome" in result)) return; // Unix void return
  const root = result.rootOutcome;
  if (!SAFE_KILL_OUTCOMES.has(root)) {
    throw new Error(
      `Windows process tree termination failed for root worker pid ${target.pid}: root outcome was "${root}"`,
    );
  }
  const failedDescendant = result.outcomes?.find((o) => !SAFE_KILL_OUTCOMES.has(o.outcome));
  if (failedDescendant) {
    throw new Error(
      `Windows process tree termination incomplete for worker pid ${target.pid}: descendant pid ${failedDescendant.target.pid} outcome was "${failedDescendant.outcome}"`,
    );
  }
}

export class WorkerRpcError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
  }
}
