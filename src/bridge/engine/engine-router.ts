import type { EnsureSessionProgress } from "../../transport/acpx-bridge/acpx-bridge-protocol";
import type {
  AgentSessionListResult,
  SessionEffortState,
} from "../../transport/types";
import type { NonInteractivePermissions, PermissionMode } from "../../config/types";
import type { BridgeEngine, EngineInjectInput, EngineListInput, EnginePromptInput, EnginePromptStreamEvent, EngineSessionInput } from "./bridge-engine";
import { SessionEngineBinding } from "./session-engine-binding";

/**
 * Routes every BridgeEngine call to the engine owning the session (plan §7).
 * Affinity is a session property, never a per-request decision: the first
 * session-scoped call resolves and caches the binding; a request whose params
 * declare a DIFFERENT engine than the cached binding is rejected (fail closed,
 * no method-level fallback). Runtime is absent this wave — any runtime-bound
 * session fails loudly with RUNTIME_ENGINE_UNSUPPORTED.
 */
export class EngineRouter implements BridgeEngine {
  readonly kind = "cli" as const;

  constructor(
    private readonly binding: SessionEngineBinding,
    private readonly cli: BridgeEngine,
    private readonly runtime?: BridgeEngine,
  ) {}

  private engineFor(input: { name: string; sessionKey?: string; transportEngine?: unknown }): BridgeEngine {
    const key = input.sessionKey ?? input.name;
    // Wave B sends transportEngine in bridge params; until then it is absent.
    const declared =
      input.transportEngine === "cli" || input.transportEngine === "runtime" ? input.transportEngine : undefined;
    const bound = this.binding.engineFor(key);
    if (!this.bindingHasExplicit(key)) {
      const resolved = declared ?? "cli";
      if (resolved !== "cli" && !this.runtime) {
        throw new EngineUnsupportedError(`no runtime engine available for session "${key}"`);
      }
      this.binding.setBinding(key, resolved);
      return resolved === "runtime" ? this.runtime! : this.cli;
    }
    if (declared && declared !== bound) {
      throw new EngineMismatchError(
        `session "${key}" is bound to the ${bound} engine but the request declares ${declared}`,
      );
    }
    if (bound === "runtime") {
      if (!this.runtime) {
        throw new EngineUnsupportedError(`no runtime engine available for session "${key}"`);
      }
      return this.runtime;
    }
    return this.cli;
  }

  private bindingHasExplicit(key: string): boolean {
    return this.binding.hasExplicit(key);
  }

  hasSession(input: EngineSessionInput) {
    return this.engineFor(input).hasSession(input);
  }

  tailSessionHistory(input: EngineSessionInput & { lines: number }) {
    return this.engineFor(input).tailSessionHistory(input);
  }

  listAgentSessions(input: EngineListInput): Promise<AgentSessionListResult | undefined> {
    // Agent-level discovery, not a mutation of one bound logical session —
    // always served by the CLI utility regardless of engine affinity (plan §38).
    return this.cli.listAgentSessions(input);
  }

  ensureSession(input: EngineSessionInput, onProgress?: (progress: EnsureSessionProgress) => void) {
    return this.engineFor(input).ensureSession(input, onProgress);
  }

  resumeAgentSession(input: EngineSessionInput & { agentSessionId: string }) {
    return this.engineFor(input).resumeAgentSession(input);
  }

  prompt(input: EnginePromptInput, onEvent?: (event: EnginePromptStreamEvent) => void) {
    return this.engineFor(input).prompt(input, onEvent);
  }

  injectMessage(input: EngineInjectInput) {
    return this.engineFor(input).injectMessage(input);
  }

  setMode(input: EngineSessionInput & { modeId: string }) {
    return this.engineFor(input).setMode(input);
  }

  setModel(input: EngineSessionInput & { modelId: string }) {
    return this.engineFor(input).setModel(input);
  }

  getSessionModel(input: EngineSessionInput) {
    return this.engineFor(input).getSessionModel(input);
  }

  setSessionEffort(input: EngineSessionInput & { effort: string }) {
    return this.engineFor(input).setSessionEffort(input);
  }

  getSessionEffort(input: EngineSessionInput) {
    return this.engineFor(input).getSessionEffort(input);
  }

  cancel(input: EngineSessionInput) {
    return this.engineFor(input).cancel(input);
  }

  removeSession(input: EngineSessionInput) {
    return this.engineFor(input).removeSession(input);
  }

  deleteSession(input: EngineSessionInput) {
    return this.engineFor(input).deleteSession(input);
  }

  freeWarmProcess(input: EngineSessionInput) {
    return this.engineFor(input).freeWarmProcess(input);
  }

  isSessionWarm(input: EngineSessionInput) {
    return this.engineFor(input).isSessionWarm(input);
  }

  getAgentSessionId(input: EngineSessionInput) {
    return this.engineFor(input).getAgentSessionId(input);
  }

  updatePermissionPolicy(policy: {
    permissionMode: PermissionMode;
    nonInteractivePermissions: NonInteractivePermissions;
    permissionPolicy?: string;
  }): Promise<Record<string, never>> {
    // Fan out: policy applies to whichever engines exist.
    return this.cli.updatePermissionPolicy(policy);
  }

  shutdown(): Promise<Record<string, never>> {
    return this.cli.shutdown();
  }
}

export class EngineUnsupportedError extends Error {
  readonly code = "RUNTIME_ENGINE_UNSUPPORTED";
}

export class EngineMismatchError extends Error {
  readonly code = "RUNTIME_ENGINE_MISMATCH";
}
