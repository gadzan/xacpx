import { createHash } from "node:crypto";

/**
 * Direct-agent launch lease/evidence layer (plan B2, acpx 0.15
 * processLifecycle). Awaited admission at the real spawn boundary:
 * onBeforeSpawn/onSpawned persist (bounded, fail-closed — a slow or failed
 * write REJECTS admission, and upstream terminates a spawned-but-rejected
 * child itself), while onSpawnFailed/onExit are best-effort observations.
 *
 * Scope is deliberately narrow:
 * - ACP agent ROOTS only (client / runtime-session / runtime-probe scopes).
 *   TerminalManager children and deeper descendants are NOT covered here —
 *   crash-safe descendant recovery stays in the worker fence, worker-eof
 *   convergence and the residual orphan registry. Never delete those because
 *   this file exists.
 * - Live evidence + admission, not crash-safe ownership: the store is
 *   in-memory per worker. Host restarts reconcile through the durable
 *   RuntimeWorkerFence, never through this file.
 * - No env values, no full paths: argv is hashed, cwd is hashed.
 */

export type RuntimeAgentLeaseScope = "client" | "runtime-session" | "runtime-probe";
export type RuntimeAgentLeasePhase = "pending" | "running" | "exited" | "spawn-failed";

/** Structural subset of the upstream launch event (no acpx import here). */
export interface AgentLaunchInfo {
  launchId: string;
  scope: { kind: "client" } | { kind: "runtime-session"; sessionKey: string } | { kind: "runtime-probe"; agent: string };
  command: string;
  args: readonly string[];
  cwd: string;
}

export interface AgentStartedInfo extends AgentLaunchInfo {
  pid: number;
  startedAt: string;
}

export interface AgentSpawnFailureInfo extends AgentLaunchInfo {
  failedAt: string;
}

export interface AgentExitInfo extends AgentStartedInfo {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  exitedAt: string;
}

export interface RuntimeAgentLeaseRecord {
  kind: "runtime-agent-launch";
  workerGeneration: string;
  launchId: string;
  scope: RuntimeAgentLeaseScope;
  sessionKey?: string;
  agent?: string;
  argvHash: string;
  cwdHash: string;
  phase: RuntimeAgentLeasePhase;
  pid?: number;
  startedAt?: string;
  exitedAt?: string;
}

export function hashAgentArgv(command: string, args: readonly string[]): string {
  return createHash("sha256").update(JSON.stringify([command, [...args]])).digest("hex");
}

function hashCwd(cwd: string): string {
  return createHash("sha256").update(cwd).digest("hex").slice(0, 16);
}

/**
 * Generation-bound in-memory lease registry. Bound once at construction to
 * the worker generation that owns this process; writes carrying any other
 * generation are rejected so a stale generation can never overwrite (or
 * fabricate) a successor's evidence.
 */
export class RuntimeAgentLeaseStore {
  private readonly records = new Map<string, RuntimeAgentLeaseRecord>();

  constructor(private readonly workerGeneration: string) {}

  private assertGeneration(generation: string): void {
    if (generation !== this.workerGeneration) {
      throw new Error(
        `stale worker generation "${generation}" cannot write agent lease bound to "${this.workerGeneration}"`,
      );
    }
  }

  markPending(generation: string, launch: AgentLaunchInfo): RuntimeAgentLeaseRecord {
    this.assertGeneration(generation);
    const record: RuntimeAgentLeaseRecord = {
      kind: "runtime-agent-launch",
      workerGeneration: generation,
      launchId: launch.launchId,
      scope: launch.scope.kind,
      ...(launch.scope.kind === "runtime-session" ? { sessionKey: launch.scope.sessionKey } : {}),
      ...(launch.scope.kind === "runtime-probe" ? { agent: launch.scope.agent } : {}),
      argvHash: hashAgentArgv(launch.command, launch.args),
      cwdHash: hashCwd(launch.cwd),
      phase: "pending",
    };
    this.records.set(launch.launchId, record);
    return record;
  }

  /**
   * CAS pending → running. Returns false (no write) when there is no pending
   * record — notably when onExit already terminalized the launch during the
   * awaited admission window: a late running write must never cover an exit.
   */
  markRunning(generation: string, started: AgentStartedInfo): boolean {
    this.assertGeneration(generation);
    const current = this.records.get(started.launchId);
    if (!current || current.phase !== "pending") return false;
    current.phase = "running";
    current.pid = started.pid;
    current.startedAt = started.startedAt;
    return true;
  }

  /** Best-effort terminal mark. Unknown launchIds (e.g. terminal children the
   *  lifecycle hooks never admitted) fabricate nothing — returns false. */
  markExited(generation: string, exit: AgentExitInfo): boolean {
    this.assertGeneration(generation);
    const current = this.records.get(exit.launchId);
    if (!current || current.phase === "exited" || current.phase === "spawn-failed") return false;
    current.phase = "exited";
    if (current.pid === undefined) current.pid = exit.pid;
    if (current.startedAt === undefined) current.startedAt = exit.startedAt;
    current.exitedAt = exit.exitedAt;
    return true;
  }

  /** Best-effort terminal mark for a launch that never produced a child. */
  markSpawnFailed(generation: string, failure: AgentSpawnFailureInfo): boolean {
    this.assertGeneration(generation);
    const current = this.records.get(failure.launchId);
    if (!current || current.phase === "exited" || current.phase === "spawn-failed") return false;
    current.phase = "spawn-failed";
    current.exitedAt = failure.failedAt;
    return true;
  }

  get(launchId: string): RuntimeAgentLeaseRecord | undefined {
    return this.records.get(launchId);
  }

  list(): RuntimeAgentLeaseRecord[] {
    return [...this.records.values()];
  }
}

/** Durable-write seam. Default is the in-memory store write (sync). A future
 *  durable sidecar can plug a file/fence write here without touching hook
 *  logic; a rejecting sink fails admission closed (upstream kills the child
 *  for onSpawned rejections and never spawns for onBeforeSpawn rejections). */
export type AgentLeasePersist = (record: RuntimeAgentLeaseRecord) => Promise<void> | void;

export interface AgentLifecycleHookOptions {
  /** Owning worker generation (supplier: read current at event time). */
  generation: () => string;
  store: RuntimeAgentLeaseStore;
  persist?: AgentLeasePersist;
  /** Admission bound: upstream hangs startup forever on an unsettled hook. */
  admissionTimeoutMs?: number;
}

export interface AgentLifecycleHooks {
  onBeforeSpawn?: (launch: AgentLaunchInfo) => Promise<void>;
  onSpawned?: (process: AgentStartedInfo) => Promise<void>;
  onSpawnFailed?: (failure: AgentSpawnFailureInfo) => Promise<void>;
  onExit?: (exit: AgentExitInfo) => Promise<void>;
}

const DEFAULT_ADMISSION_TIMEOUT_MS = 2000;

function withAdmissionTimeout<T>(work: Promise<T> | T, timeoutMs: number, what: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`agent lease admission "${what}" timed out after ${timeoutMs}ms; refusing launch`)),
      timeoutMs,
    );
    if (typeof timer.unref === "function") timer.unref();
    Promise.resolve(work).then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

/**
 * Build the lifecycle hooks for one worker. Structurally compatible with the
 * upstream processLifecycle option (verified at the adapter handoff — this
 * module stays acpx-import-free on purpose).
 */
export function createAgentLifecycleHooks(options: AgentLifecycleHookOptions): AgentLifecycleHooks {
  const timeoutMs = options.admissionTimeoutMs ?? DEFAULT_ADMISSION_TIMEOUT_MS;
  const persist: AgentLeasePersist = options.persist ?? (() => {});
  return {
    async onBeforeSpawn(launch) {
      const generation = options.generation();
      await withAdmissionTimeout(
        (async () => {
          const record = options.store.markPending(generation, launch);
          await persist(record);
        })(),
        timeoutMs,
        `beforeSpawn:${launch.launchId}`,
      );
    },
    async onSpawned(started) {
      const generation = options.generation();
      await withAdmissionTimeout(
        (async () => {
          // markRunning is a CAS: an exit observed during the admission
          // window already terminalized the record, and the late running
          // write must not cover it — but admission itself still settles
          // (the child exists; its exit is recorded).
          options.store.markRunning(generation, started);
          const record = options.store.get(started.launchId);
          if (record) await persist(record);
        })(),
        timeoutMs,
        `spawned:${started.launchId}`,
      );
    },
    async onSpawnFailed(failure) {
      try {
        if (options.store.markSpawnFailed(options.generation(), failure)) {
          const record = options.store.get(failure.launchId);
          if (record) await persist(record);
        }
      } catch {
        // Best-effort observation: never alters the launch outcome.
      }
    },
    async onExit(exit) {
      try {
        if (options.store.markExited(options.generation(), exit)) {
          const record = options.store.get(exit.launchId);
          if (record) await persist(record);
        }
      } catch {
        // Best-effort observation: never alters the turn/exit outcome.
      }
    },
  };
}
