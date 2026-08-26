import { statSync } from "node:fs";
import { join } from "node:path";

import { resolveAcpxHomeDir } from "../../transport/acpx-session-files";
import type {
  AgentSessionListResult,
  SessionEffortState,
} from "../../transport/types";
import type { NonInteractivePermissions, PermissionMode } from "../../config/types";
import type { BridgeEngine, EngineInjectInput, EngineListInput, EnginePromptInput, EnginePromptStreamEvent, EngineSessionInput } from "./bridge-engine";
import { mapRuntimeError, type XacpxRuntimeEvent, type XacpxTurnResult, type RuntimeBridgeErrorCode } from "./runtime/runtime-contract";
import type { RuntimeWorkerClient } from "./runtime/runtime-worker-client";
import { RuntimeWorkerManager } from "./runtime/runtime-worker-manager";
import { WorkerRpcError, WorkerCrashError } from "./runtime/runtime-worker-client";
import { resolve as resolvePath, dirname } from "node:path";
import { fileURLToPath } from "node:url";

export interface RuntimeEngineOptions {
  /** Resolved worker entry; defaults to the bundled dist output. */
  workerEntryPath?: string;
  permissionMode: PermissionMode;
  nonInteractivePermissions?: NonInteractivePermissions;
  permissionPolicy?: string;
}

const WORKER_ENTRY_CANDIDATES = [
  // Bundled layout: dist/bridge/engine/ → ../../../runtime-worker-main.js
  resolvePath(dirname(fileURLToPath(import.meta.url)), "../../../../runtime-worker-main.js"),
];

function defaultWorkerEntry(): string {
  for (const candidate of WORKER_ENTRY_CANDIDATES) {
    try {
      if (statSync(candidate).isFile()) return candidate;
    } catch {
      /* keep looking */
    }
  }
  return WORKER_ENTRY_CANDIDATES[0]!;
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

  constructor(private readonly options: RuntimeEngineOptions) {
    const entry = options.workerEntryPath ?? defaultWorkerEntry();
    try {
      this.manager = new RuntimeWorkerManager({ entryPath: entry });
    } catch {
      // Entry missing (dev/test without build): engine stays constructible but
      // every session-scoped call fails closed with RUNTIME_ENGINE_UNSUPPORTED.
      this.manager = undefined;
    }
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
    const key = this.workerKey(input);
    let client: RuntimeWorkerClient;
    try {
      client = this.ensureWorker(input);
    } catch (error) {
      throw new WorkerUnavailableError(error instanceof Error ? error.message : String(error));
    }
    try {
      return await run(client);
    } catch (error) {
      if (error instanceof WorkerRpcError && error.code === "RUNTIME_WORKER_CRASHED") throw error;
      throw error;
    }
  }

  private buildEnsureParams(input: EngineSessionInput) {
    return {
      sessionKey: input.name,
      agent: input.agentCommand ?? input.agent,
      cwd: input.cwd,
      stateDir: join(resolveAcpxHomeDir(), ".acpx", "sessions"),
      permissionMode: this.options.permissionMode,
      ...(this.options.nonInteractivePermissions ? { nonInteractivePermissions: this.options.nonInteractivePermissions } : {}),
    };
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
      await client.request("ensure", this.buildEnsureParams(input));
      return {};
    });
    return {};
  }

  async resumeAgentSession(input: EngineSessionInput & { agentSessionId: string }): Promise<Record<string, never>> {
    // Resume equals ensure against the same persistent identity; the agent
    // session id rides in the record the runtime reconnects to.
    await this.withWorker(input, async (client) => {
      await client.request("ensure", this.buildEnsureParams(input));
      return {};
    });
    return {};
  }

  async prompt(
    input: EnginePromptInput,
    onEvent?: (event: EnginePromptStreamEvent) => void,
  ): Promise<{ text: string }> {
    const key = this.workerKey(input);
    return await this.withWorker(input, async (client) => {
      await client.request("ensure", this.buildEnsureParams(input));
      client.lifecycle = "busy";
      this.activeTurns.add(key);
      try {
        const outcome = await client.request<{
          events: XacpxRuntimeEvent[];
          result: XacpxTurnResult;
          finalText: string;
        }>("prompt", { text: input.text });
        emitPromptEvents(outcome.events, onEvent);
        if (outcome.result.status === "failed") {
          const mapped = mapRuntimeError(new Error(outcome.result.error.message));
          throw new RuntimeError(mapped.code, mapped.message);
        }
        return { text: outcome.finalText };
      } finally {
        this.activeTurns.delete(key);
        client.lifecycle = "idle";
        if (this.coolPending.has(key)) {
          this.coolPending.delete(key);
          await client.terminate();
          client.lifecycle = "stopped";
        }
      }
    });
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
      await client.request("ensure", this.buildEnsureParams(input));
      await client.request("setMode", { mode: input.modeId });
      return {};
    });
    return {};
  }

  async setModel(input: EngineSessionInput & { modelId: string }) {
    await this.withWorker(input, async (client) => {
      await client.request("ensure", this.buildEnsureParams(input));
      await client.request("setConfigOption", { key: "model", value: input.modelId });
      return {};
    });
    return {};
  }

  async getSessionModel(input: EngineSessionInput): Promise<{ current?: string; available: string[] }> {
    return await this.withWorker(input, async (client) => {
      await client.request("ensure", this.buildEnsureParams(input));
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
      await client.request("ensure", this.buildEnsureParams(input));
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
    return await this.withWorker(input, async (client) => {
      const result = await client.request<{ cancelled: boolean }>("cancel");
      return { cancelled: result.cancelled === true, message: "cancel delivered to runtime worker" };
    });
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
    const client = this.manager?.get(key);
    if (client && client.alive) {
      await client.request("close").catch(() => {});
      await client.terminate();
    }
    this.activeTurns.delete(key);
    this.coolPending.delete(key);
    return {};
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
      await client.request("ensure", this.buildEnsureParams(input));
      const status = (await client.request<{ acpxRecordId?: string; agentSessionId?: string }>("status")) ?? {};
      return { agentSessionId: status.agentSessionId };
    });
  }

  async updatePermissionPolicy(policy: {
    permissionMode: PermissionMode;
    nonInteractivePermissions: NonInteractivePermissions;
    permissionPolicy?: string;
  }): Promise<Record<string, never>> {
    this.options.permissionMode = policy.permissionMode;
    this.options.nonInteractivePermissions = policy.nonInteractivePermissions;
    this.options.permissionPolicy = policy.permissionPolicy;
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

function emitPromptEvents(events: XacpxRuntimeEvent[], onEvent?: (event: EnginePromptStreamEvent) => void): void {
  if (!onEvent) return;
  for (const event of events) {
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
}
