import type { EnsureSessionProgress } from "../../../transport/acpx-bridge/acpx-bridge-protocol";
import type { AgentSessionListResult, SessionEffortState } from "../../../transport/types";
import type { NonInteractivePermissions, PermissionMode } from "../../../config/types";
import { BridgeRuntime } from "../../bridge-runtime";
import type {
  BridgeEngine,
  EngineInjectInput,
  EngineListInput,
  EnginePromptInput,
  EnginePromptStreamEvent,
  EngineSessionInput,
} from "../bridge-engine";

/**
 * Thin delegation wrapper around the existing BridgeRuntime CLI implementation
 * (plan PR1 / §8). Pure refactoring: zero behavior change — every call forwards
 * verbatim to the runtime it wraps.
 */
export class CliEngine implements BridgeEngine {
  readonly kind = "cli" as const;

  constructor(private readonly runtime: BridgeRuntime) {}

  hasSession(input: EngineSessionInput): Promise<{ exists: boolean }> {
    return this.runtime.hasSession(input);
  }

  tailSessionHistory(input: EngineSessionInput & { lines: number }): Promise<{ text: string }> {
    return this.runtime.tailSessionHistory(input);
  }

  listAgentSessions(input: EngineListInput): Promise<AgentSessionListResult | undefined> {
    return this.runtime.listAgentSessions(input);
  }

  ensureSession(
    input: EngineSessionInput,
    onProgress?: (progress: EnsureSessionProgress) => void,
  ): Promise<Record<string, never>> {
    return this.runtime.ensureSession(input, onProgress);
  }

  resumeAgentSession(input: EngineSessionInput & { agentSessionId: string }): Promise<Record<string, never>> {
    return this.runtime.resumeAgentSession(input);
  }

  prompt(
    input: EnginePromptInput,
    onEvent?: (event: EnginePromptStreamEvent) => void,
  ): Promise<{ text: string }> {
    return this.runtime.prompt(input, onEvent);
  }

  injectMessage(input: EngineInjectInput) {
    return this.runtime.injectMessage(input);
  }

  setMode(input: EngineSessionInput & { modeId: string }): Promise<Record<string, never>> {
    return this.runtime.setMode(input);
  }

  setModel(input: EngineSessionInput & { modelId: string }): Promise<Record<string, never>> {
    return this.runtime.setModel(input);
  }

  getSessionModel(input: EngineSessionInput): Promise<{ current?: string; available: string[] }> {
    return this.runtime.getSessionModel(input);
  }

  setSessionEffort(input: EngineSessionInput & { effort: string }): Promise<Record<string, never>> {
    return this.runtime.setSessionEffort(input);
  }

  getSessionEffort(input: EngineSessionInput): Promise<SessionEffortState> {
    return this.runtime.getSessionEffort(input);
  }

  cancel(input: EngineSessionInput): Promise<{ cancelled: boolean; message: string }> {
    return this.runtime.cancel(input);
  }

  removeSession(input: EngineSessionInput): Promise<Record<string, never>> {
    return this.runtime.removeSession(input);
  }

  deleteSession(input: EngineSessionInput): Promise<Record<string, never>> {
    return this.runtime.deleteSession(input);
  }

  releaseLogicalSession(_input: EngineSessionInput): Promise<Record<string, never>> {
    // CLI runtime keeps no per-logical worker/queue/catalog state: a
    // non-last shared-alias remove correctly calls nothing today.
    return Promise.resolve({});
  }

  freeWarmProcess(input: EngineSessionInput): Promise<Record<string, never>> {
    return this.runtime.freeWarmProcess(input);
  }

  isSessionWarm(input: EngineSessionInput): Promise<{ warm: boolean }> {
    return this.runtime.isSessionWarm(input);
  }

  getAgentSessionId(input: EngineSessionInput): Promise<{ agentSessionId: string | undefined }> {
    return this.runtime.getAgentSessionId(input);
  }

  updatePermissionPolicy(policy: {
    permissionMode: PermissionMode;
    nonInteractivePermissions: NonInteractivePermissions;
    permissionPolicy?: string;
  }) {
    return this.runtime.updatePermissionPolicy(policy);
  }

  shutdown(): Promise<Record<string, never>> {
    return this.runtime.shutdown();
  }
}
