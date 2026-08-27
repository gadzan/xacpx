import { access, readdir, readFile, unlink } from "node:fs/promises";
import { statSync } from "node:fs";
import { join } from "node:path";

import { deleteAcpxSessionFiles, resolveAcpxHomeDir } from "../../transport/acpx-session-files";
import type {
  AgentSessionListResult,
  SessionEffortState,
} from "../../transport/types";
import type { NonInteractivePermissions, PermissionMode } from "../../config/types";
import type { BridgeEngine, EngineInjectInput, EngineListInput, EnginePromptInput, EnginePromptStreamEvent, EngineSessionInput } from "./bridge-engine";
import { mapRuntimeError, type XacpxRuntimeEvent, type XacpxTurnResult, type RuntimeBridgeErrorCode } from "./runtime/runtime-contract";
import type { RuntimeWorkerClient, RuntimeWorkerClientDeps } from "./runtime/runtime-worker-client";
import { WorkerCrashError } from "./runtime/runtime-worker-client";
import { RuntimeWorkerManager, WorkerTeardownPendingError } from "./runtime/runtime-worker-manager";
import { resolve as resolvePath, dirname } from "node:path";
import { fileURLToPath } from "node:url";

function sleep(ms: number): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, ms);
  return promise;
}
export async function findAcpxRecordIdFromDisk(
  name: string,
  sessionsDir = join(resolveAcpxHomeDir(), ".acpx", "sessions"),
): Promise<string | undefined> {
  let entries: string[];
  try {
    entries = await readdir(sessionsDir);
  } catch {
    return undefined;
  }
  for (const file of entries) {
    if (!file.endsWith(".json") || file === "index.json") continue;
    try {
      const content = await readFile(join(sessionsDir, file), "utf8");
      const parsed = JSON.parse(content) as Record<string, unknown>;
      if (parsed.name === name && typeof parsed.acpx_record_id === "string") {
        return parsed.acpx_record_id;
      }
    } catch {
      // skip unreadable/corrupt files
    }
  }
  return undefined;
}


export interface RuntimeEngineOptions {
  /** Resolved worker entry; defaults to the bundled dist output. */
  workerEntryPath?: string;
  /** Override for the acpx sessions directory (tests / isolated daemons). */
  stateDir?: string;
  permissionMode: PermissionMode;
  nonInteractivePermissions?: NonInteractivePermissions;
  permissionPolicy?: string;
  /** Optional dependency overrides for tests (e.g. Windows termination / identity mocks). */
  workerClientDeps?: RuntimeWorkerClientDeps;
}

export function defaultWorkerEntryCandidates(fromUrl = import.meta.url): string[] {
  const here = dirname(fileURLToPath(fromUrl));
  return [
    // 1. When bundled into dist/bridge/bridge-main.js -> dist/bridge/engine/runtime/runtime-worker-main.js
    resolvePath(here, "./engine/runtime/runtime-worker-main.js"),
    // 2. When evaluated from dist/bridge/engine/ -> dist/bridge/engine/runtime/runtime-worker-main.js
    resolvePath(here, "./runtime/runtime-worker-main.js"),
    // 3. When evaluated directly from source at src/bridge/engine/runtime-engine.ts
    resolvePath(here, "../../../dist/bridge/engine/runtime/runtime-worker-main.js"),
    // 4. When evaluated from root / testing directory
    resolvePath(process.cwd(), "dist/bridge/engine/runtime/runtime-worker-main.js"),
  ];
}

export function defaultWorkerEntry(fromUrl?: string): string {
  const candidates = defaultWorkerEntryCandidates(fromUrl);
  for (const candidate of candidates) {
    try {
      if (statSync(candidate).isFile()) return candidate;
    } catch {
      /* keep looking */
    }
  }
  return candidates[0]!;
}


/**
 * Executes Runtime-bound sessions through per-session workers (plan §9+).
 * The worker process IS the release primitive: cooling/TTL kill it without
 * touching the persistent acpx record.
 */
export class RuntimeEngine implements BridgeEngine {
  readonly kind = "runtime" as const;

  private readonly manager: RuntimeWorkerManager | undefined;
  private readonly coolPending = new Set<string>();
  private readonly activeTurns = new Set<string>();
  private permissionGeneration = 0;
  /** worker key → real acpxRecordId from the runtime handle (delete identity). */
  private readonly recordIds = new Map<string, string>();
  private policyTransitionLock: Promise<void> | null = null;
  private policyLockRelease?: () => void;

  constructor(private readonly options: RuntimeEngineOptions) {
    const entry = options.workerEntryPath ?? defaultWorkerEntry();
    try {
      this.manager = new RuntimeWorkerManager({
        entryPath: entry,
        clientDeps: options.workerClientDeps,
      });
    } catch {
      // Entry missing (dev/test without build): engine stays constructible but
      // every session-scoped call fails closed with RUNTIME_ENGINE_UNSUPPORTED.
      this.manager = undefined;
    }
  }

  private sessionsDir(): string {
    return this.options.stateDir ?? join(resolveAcpxHomeDir(), ".acpx", "sessions");
  }

  private workerKey(input: EngineSessionInput): string {
    return input.logicalSessionId ?? input.sessionKey ?? `${input.cwd}:${input.name}`;
  }

  private ensureWorker(input: EngineSessionInput): RuntimeWorkerClient {
    if (!this.manager) {
      throw new WorkerUnavailableError("RuntimeEngine has no worker manager (worker entry not built)");
    }
    return this.manager.ensureWorker(this.workerKey(input));
  }

  private async withWorker<T>(input: EngineSessionInput, run: (client: RuntimeWorkerClient) => Promise<T>): Promise<T> {
    // Await in-flight policy transition so prompts don't cross transition boundary
    if (this.policyTransitionLock) {
      await this.policyTransitionLock;
    }
    const key = this.workerKey(input);
    let client: RuntimeWorkerClient;
    try {
      client = this.ensureWorker(input);
    } catch (error) {
      if (error instanceof WorkerTeardownPendingError) {
        throw new RuntimeError(error.code, error.message);
      }
      throw new WorkerUnavailableError(error instanceof Error ? error.message : String(error));
    }
    try {
      // A successful RPC proves bootstrap completed → §15 warm (ready/idle).
      client.lifecycle = "ready";
      return await run(client);
    } catch (error) {
      // Worker death mid-call: normalize to the §43 crash code so the daemon
      // sees RUNTIME_WORKER_CRASHED (bridge-server maps it 1:1).
      if (error instanceof WorkerCrashError) {
        this.activeTurns.delete(key);
        client.lifecycle = "failed";
      }
      throw error;
    }
  }

  private buildEnsureParams(input: EngineSessionInput) {
    // Exact structured argv (plan §35): when xacpx resolved an explicit argv,
    // it IS the launch identity — passed verbatim as a registry override so
    // Windows path/space/quote boundaries survive to the adapter process.
    // Never re-split from the agentCommand string.
    const agentName = input.agent;
    return {
      sessionKey: input.name,
      agent: input.agentCommand ?? input.agent,
      cwd: input.cwd,
      stateDir: this.sessionsDir(),
      permissionMode: this.options.permissionMode,
      ...(this.options.permissionPolicy !== undefined ? { permissionPolicy: this.options.permissionPolicy } : {}),
      ...(input.agentArgv && input.agentArgv.length > 0 ? { agentOverrides: { [agentName]: [...input.agentArgv] } } : {}),
      ...(this.options.nonInteractivePermissions ? { nonInteractivePermissions: this.options.nonInteractivePermissions } : {}),
    };
  }

  /**
   * Ensures the session and caches the REAL acpx record id resolved by the
   * runtime (plan §9.1). This binding metadata is the ONLY acceptable identity
   * for hard-delete — the logical session id is never a record id.
   */
  private async ensureSessionHandle(
    input: EngineSessionInput,
    client: RuntimeWorkerClient,
  ): Promise<{ acpxRecordId?: string }> {
    const handle = await client.request<{ sessionKey: string; acpxRecordId?: string; agentSessionId?: string }>(
      "ensure",
      this.buildEnsureParams(input),
    );
    if (handle.acpxRecordId) {
      this.recordIds.set(this.workerKey(input), handle.acpxRecordId);
    }
    return handle;
  }

  async hasSession(input: EngineSessionInput): Promise<{ exists: boolean }> {
    // Record lookup must NOT heat a cold session (plan §39). Until a
    // record-read helper lands in the adapter contract, report not-exists
    // rather than spawning a worker just to answer a poll.
    void input;
    return { exists: false };
  }

  async tailSessionHistory(_input: EngineSessionInput & { lines: number }): Promise<{ text: string }> {
    throw new Error("tailSessionHistory is served by the shared history helper before routing");
  }

  async listAgentSessions(_input: EngineListInput): Promise<AgentSessionListResult | undefined> {
    // Agent-level discovery stays on the CLI utility (plan §38); router never routes it here.
    throw new Error("listAgentSessions must be served by the CLI utility");
  }

  async ensureSession(input: EngineSessionInput): Promise<Record<string, never>> {
    await this.withWorker(input, async (client) => {
      await this.ensureSessionHandle(input, client);
      return {};
    });
    return {};
  }

  async resumeAgentSession(input: EngineSessionInput & { agentSessionId: string }): Promise<Record<string, never>> {
    // Resume equals ensure against the same persistent identity; the agent
    // session id rides in the record the runtime reconnects to.
    await this.withWorker(input, async (client) => {
      await this.ensureSessionHandle(input, client);
      return {};
    });
    return {};
  }

  async prompt(
    input: EnginePromptInput,
    onEvent?: (event: EnginePromptStreamEvent) => void,
  ): Promise<{ text: string }> {
    if (this.policyTransitionLock) {
      await this.policyTransitionLock;
    }
    const key = this.workerKey(input);
    // Mark the turn active IMMEDIATELY so preflight on concurrent policy
    // updates detects the in-flight turn and fails closed (plan §32).
    this.activeTurns.add(key);
    try {
      return await this.withWorker(input, async (client) => {
        client.lifecycle = "busy";
        await this.ensureSessionHandle(input, client);
        try {
          const outcome = await client.request<{ result: XacpxTurnResult; finalText: string }>(
            "prompt",
            { text: input.text },
            // Real-time streaming (plan §41): each worker event frame is
            // forwarded to the bridge sink the moment it arrives — never
            // batched after turn completion.
            { onEvent: (payload) => emitPromptEvent(payload as XacpxRuntimeEvent, onEvent) },
          );
          if (outcome.result.status === "failed") {
            const mapped = mapRuntimeError(new Error(outcome.result.error.message));
            throw new RuntimeError(mapped.code, mapped.message);
          }
          return { text: outcome.finalText };
        } finally {
          client.lifecycle = "idle";
        }
      });
    } finally {
      this.activeTurns.delete(key);
      const client = this.manager?.get(key);
      if (client && this.coolPending.has(key)) {
        this.coolPending.delete(key);
        await client.terminate();
        client.lifecycle = "stopped";
      }
    }
  }

  async injectMessage(input: EngineInjectInput): Promise<never> {
    // Queue mode arrives with the durable queue PR (plan PR6); steer stays off
    // until same-turn behavior is proven (plan §25).
    throw new RuntimeError(
      "RUNTIME_ENGINE_UNSUPPORTED",
      `injectMessage mode "${input.mode}" is not supported by the runtime engine yet`,
    );
  }

  async setMode(input: EngineSessionInput & { modeId: string }) {
    await this.withWorker(input, async (client) => {
      await this.ensureSessionHandle(input, client);
      await client.request("setMode", { mode: input.modeId });
      return {};
    });
    return {};
  }

  async setModel(input: EngineSessionInput & { modelId: string }) {
    await this.withWorker(input, async (client) => {
      await this.ensureSessionHandle(input, client);
      await client.request("setConfigOption", { key: "model", value: input.modelId });
      return {};
    });
    return {};
  }

  async getSessionModel(input: EngineSessionInput): Promise<{ current?: string; available: string[] }> {
    return await this.withWorker(input, async (client) => {
      await this.ensureSessionHandle(input, client);
      const status = (await client.request<{ models?: { currentModelId?: string; availableModelIds: string[] } }>("status")) ?? {};
      return {
        current: status.models?.currentModelId,
        available: status.models?.availableModelIds ?? [],
      };
    });
  }

  async setSessionEffort(input: EngineSessionInput & { effort: string }): Promise<Record<string, never>> {
    return await this.applyConfigOption(input, "effort", input.effort);
  }

  private async applyConfigOption(input: EngineSessionInput, key: string, value: string): Promise<Record<string, never>> {
    await this.withWorker(input, async (client) => {
      await this.ensureSessionHandle(input, client);
      await client.request("setConfigOption", { key, value });
      return {};
    });
    return {};
  }

  async getSessionEffort(input: EngineSessionInput): Promise<SessionEffortState> {
    void input;
    return { current: undefined, available: [] };
  }

  async cancel(input: EngineSessionInput): Promise<{ cancelled: boolean; message: string }> {
    const key = this.workerKey(input);
    const client = this.manager?.get(key);
    if (!client || !client.alive) {
      // Cold session: do NOT spawn a worker just to cancel an idle state (plan §24).
      return { cancelled: false, message: "no active runtime worker for session" };
    }
    const result = await client.request<{ cancelled: boolean }>("cancel");
    return { cancelled: result.cancelled === true, message: "cancel delivered to runtime worker" };
  }

  async removeSession(input: EngineSessionInput): Promise<Record<string, never>> {
    // Plan §20: close() semantics differ between engines. Until parity is proven,
    // fail loudly instead of silently diverging from CLI `sessions close`.
    throw new RuntimeError(
      "RUNTIME_ENGINE_UNSUPPORTED",
      "removeSession on a runtime-bound session requires close-parity validation; use deleteSession for a hard delete",
    );
  }

  async deleteSession(input: EngineSessionInput): Promise<Record<string, never>> {
    const key = this.workerKey(input);
    // 1. Resolve REAL record id (plan §19 order). Never fallback to logicalSessionId.
    const client = this.manager?.get(key);
    const recordId = await this.resolveRecordId(input, client);

    // 2. Terminate live worker (cancel active turn first).
    if (client && client.alive) {
      if (this.activeTurns.has(key)) {
        await client.request("cancel").catch(() => {});
      }
      await client.request("close").catch(() => {});
      await client.terminate();
    }
    this.activeTurns.delete(key);
    this.coolPending.delete(key);
    this.recordIds.delete(key);

    // 3. If no record exists on disk or memory, idempotent success (G4).
    if (!recordId) {
      return {};
    }

    // 4. Strict deletion with post-verification and retry.
    await this.deleteRecordFilesStrict(recordId);
    return {};
  }

  /** Obtains the real acpx record id without creating phantom records on cold delete. */
  private async resolveRecordId(input: EngineSessionInput, client?: RuntimeWorkerClient): Promise<string | undefined> {
    const key = this.workerKey(input);
    const cached = this.recordIds.get(key);
    if (cached) return cached;

    // Live worker: ask status directly.
    if (client && client.alive) {
      try {
        const status = (await client.request<{ acpxRecordId?: string }>("status")) ?? {};
        if (status.acpxRecordId) {
          this.recordIds.set(key, status.acpxRecordId);
          return status.acpxRecordId;
        }
      } catch {
        // ignore, fall through to disk lookup
      }
    }

    // Cold worker / post-restart: scan on-disk sessions without spawning a worker.
    const diskRecordId = await findAcpxRecordIdFromDisk(input.name, this.sessionsDir());
    if (diskRecordId) {
      this.recordIds.set(key, diskRecordId);
      return diskRecordId;
    }

    return undefined;
  }
  /**
   * Strict delete (G4): best-effort unlink helper is NOT trusted as the oracle.
   * After unlinking, VERIFY the record json is actually gone from disk;
   * transient failures (Windows file locks) retry until a bounded deadline,
   * and a still-present file at deadline is a hard error — never silent success.
   */
  private async deleteRecordFilesStrict(recordId: string): Promise<void> {
    const dir = this.sessionsDir();
    const safeId = encodeURIComponent(recordId);
    const recordPath = join(dir, `${safeId}.json`);
    const deadline = Date.now() + 5_000;
    for (;;) {
      await deleteAcpxSessionFiles({ acpxRecordId: recordId, sessionsDir: dir }).catch(() => {});
      await unlink(recordPath).catch(() => {});
      try {
        const entries = await readdir(dir);
        for (const file of entries.filter((name) => name.startsWith(`${safeId}.stream.`))) {
          await unlink(join(dir, file)).catch(() => {});
        }
      } catch {
        // directory already gone
      }
      try {
        await access(recordPath);
        // Still present → deletion did not take (locked or raced). Retry.
      } catch {
        return; // ENOENT: the record is genuinely gone.
      }
      if (Date.now() >= deadline) {
        throw new RuntimeError(
          "RUNTIME_INIT_FAILED",
          `acpx session record "${recordId}" still exists after delete deadline`,
        );
      }
      await sleep(100);
    }
  }

  async freeWarmProcess(input: EngineSessionInput): Promise<Record<string, never>> {
    const key = this.workerKey(input);
    const client = this.manager?.get(key);
    if (!client || !client.alive) return {};
    if (this.activeTurns.has(key)) {
      // Active turn: mark and settle later — never kill mid-turn (plan §14).
      this.coolPending.add(key);
      return {};
    }
    await client.terminate();
    return {};
  }

  async isSessionWarm(input: EngineSessionInput): Promise<{ warm: boolean }> {
    const client = this.manager?.get(this.workerKey(input));
    return { warm: client !== undefined && client.alive && client.lifecycle !== "starting" && client.lifecycle !== "cooling" };
  }

  async getAgentSessionId(input: EngineSessionInput): Promise<{ agentSessionId: string | undefined }> {
    return await this.withWorker(input, async (client) => {
      await this.ensureSessionHandle(input, client);
      const status = (await client.request<{ acpxRecordId?: string; agentSessionId?: string }>("status")) ?? {};
      return { agentSessionId: status.agentSessionId };
    });
  }

  private async acquirePolicyLock(): Promise<void> {
    while (this.policyTransitionLock) {
      await this.policyTransitionLock;
    }
    const { promise, resolve } = Promise.withResolvers<void>();
    this.policyTransitionLock = promise;
    this.policyLockRelease = resolve;
  }

  private releasePolicyLock(): void {
    this.policyLockRelease?.();
    this.policyTransitionLock = null;
    this.policyLockRelease = undefined;
  }

  /**
   * Transactional prepare (plan §32):
   * 1. Acquire transition lock to serialize updates and block new prompts.
   * 2. Preflight: if ANY session is active/busy, fail closed immediately.
   * 3. Rotation: terminate all idle warm workers so no worker running the old
   *    policy survives. (Workers exit cleanly without closing the session record).
   */
  async preparePolicyTransition(): Promise<void> {
    await this.acquirePolicyLock();
    try {
      const live = this.manager?.workers() ?? [];
      for (const worker of live) {
        if (this.activeTurns.has(worker.ref.logicalSessionId) || worker.lifecycle === "busy") {
          throw new RuntimeError(
            "RUNTIME_PERMISSION_BUSY",
            `cannot update permission policy while session "${worker.ref.logicalSessionId}" has an active turn (fail closed)`,
          );
        }
      }
      // Deliberate termination: rotation does NOT consume crash budget (plan §43)
      await Promise.all(live.map((w) => w.terminate()));
    } catch (error) {
      this.releasePolicyLock();
      throw error;
    }
  }

  /** Transactional commit: snapshot new policy into RuntimeEngine; next spawns use it. */
  async commitPolicyTransition(policy: {
    permissionMode: PermissionMode;
    nonInteractivePermissions: NonInteractivePermissions;
    permissionPolicy?: string;
  }): Promise<void> {
    try {
      this.options.permissionMode = policy.permissionMode;
      this.options.nonInteractivePermissions = policy.nonInteractivePermissions;
      this.options.permissionPolicy = policy.permissionPolicy;
      this.permissionGeneration++;
    } finally {
      this.releasePolicyLock();
    }
  }

  /** Transactional rollback: release lock without committing when CLI update fails. */
  async rollbackPolicyTransition(): Promise<void> {
    this.releasePolicyLock();
  }

  async updatePermissionPolicy(policy: {
    permissionMode: PermissionMode;
    nonInteractivePermissions: NonInteractivePermissions;
    permissionPolicy?: string;
  }): Promise<Record<string, never>> {
    await this.preparePolicyTransition();
    await this.commitPolicyTransition(policy);
    return {};
  }
  async shutdown(): Promise<Record<string, never>> {
    await this.manager?.shutdownAll();
    return {};
  }
}

export class RuntimeError extends Error {
  constructor(readonly code: RuntimeBridgeErrorCode | string, message: string) {
    super(message);
  }
}

export class WorkerUnavailableError extends RuntimeError {
  constructor(message: string) {
    super("RUNTIME_ENGINE_UNSUPPORTED", message);
  }
}

// Re-exported so callers can instanceof without importing two modules.
export { WorkerCrashError };

function emitPromptEvent(event: XacpxRuntimeEvent, onEvent?: (event: EnginePromptStreamEvent) => void): void {
  if (!onEvent) return;
  if (event.type === "text_delta") {
    onEvent(event.stream === "thought"
      ? { type: "prompt.thought", text: event.text }
      : { type: "prompt.segment", text: event.text });
  } else if (event.type === "tool_call") {
    onEvent({ type: "prompt.tool_event", event: { toolCallId: event.toolCallId, title: event.title, status: event.status } as never });
  } else if (event.type === "status") {
    if (event.used !== undefined || event.size !== undefined) {
      onEvent({
        type: "prompt.usage",
        used: event.used ?? 0,
        size: event.size ?? 0,
        ...(event.cost ? { cost: event.cost as never } : {}),
        ...(event.breakdown ? { breakdown: event.breakdown as never } : {}),
      });
    }
    if (event.availableCommands && event.availableCommands.length > 0) {
      onEvent({ type: "prompt.commands", commands: event.availableCommands.map((command) => ({ name: command.name, description: command.description })) as never });
    }
  }
}
