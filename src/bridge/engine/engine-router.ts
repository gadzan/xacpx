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
 * no method-level fallback). When no Runtime engine is wired, any
 * runtime-bound session fails loudly with RUNTIME_ENGINE_UNSUPPORTED.
 */
export class EngineRouter implements BridgeEngine {
  readonly kind = "cli" as const;

  constructor(
    private readonly binding: SessionEngineBinding,
    private readonly cli: BridgeEngine,
    private readonly runtime?: BridgeEngine,
  ) {}

  private keyFor(input: { name: string; sessionKey?: string; logicalSessionId?: string }): string {
    // Stable ownership identity first (plan §9.1): the immutable
    // logical-session id survives alias renames; fall back to sessionKey/name.
    return input.logicalSessionId ?? input.sessionKey ?? input.name;
  }

  private engineFor(input: {
    name: string;
    sessionKey?: string;
    logicalSessionId?: string;
    transportEngine?: unknown;
  }): BridgeEngine {
    const key = this.keyFor(input);
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

  /**
   * Read-only existence probe: routes WITHOUT caching affinity. Preflight
   * attach candidates carry transient LIDs that are never persisted, so
   * caching them here would leak one Bridge-process Map entry per
   * attach/new preflight forever (the authoritative call re-resolves and
   * caches the real LID itself).
   */
  private engineForProbe(input: {
    name: string;
    sessionKey?: string;
    logicalSessionId?: string;
    transportEngine?: unknown;
  }): BridgeEngine {
    const key = this.keyFor(input);
    if (this.bindingHasExplicit(key)) return this.engineFor(input);
    const declared =
      input.transportEngine === "cli" || input.transportEngine === "runtime" ? input.transportEngine : undefined;
    const resolved = declared ?? "cli";
    if (resolved !== "cli" && !this.runtime) {
      throw new EngineUnsupportedError(`no runtime engine available for session "${key}"`);
    }
    return resolved === "runtime" ? this.runtime! : this.cli;
  }

  hasSession(input: EngineSessionInput) {
    return this.engineForProbe(input).hasSession(input);
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

  async deleteSession(input: EngineSessionInput): Promise<Record<string, never>> {
    const result = await this.engineFor(input).deleteSession(input);
    // The LID is never reused: drop the cached affinity only AFTER the
    // hard delete verifies, so retries still route and successes stop
    // leaking one Map entry per deleted session.
    this.binding.deleteBinding(this.keyFor(input));
    return result;
  }

  async releaseLogicalSession(input: EngineSessionInput): Promise<Record<string, never>> {
    return (await this.engineFor(input).releaseLogicalSession?.(input)) ?? {};
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

  async updatePermissionPolicy(policy: {
    permissionMode: PermissionMode;
    nonInteractivePermissions: NonInteractivePermissions;
    permissionPolicy?: string;
  }): Promise<Record<string, never>> {
    // Transactional fanout (plan §32), Runtime-first with isolation: the
    // admission lock is held from prepare until the CLI outcome is final,
    // so no turn can execute under a policy that later rolls back. End
    // states are only exact all-old, all-new, or the explicit Runtime
    // failed-closed latch; never a mixed plane and never an unrollbackable
    // side effect from a reported-failed transaction.
    // 1. Runtime preflight: verify all workers are idle and hold the
    //    transition lock so no new prompts sneak through. Rejects before
    //    anything commits when busy.
    const hasRuntimePrepare = typeof this.runtime?.preparePolicyTransition === "function";
    const hasRuntimeStage = typeof this.runtime?.stagePolicyTransition === "function";
    const hasRuntimeCommit = typeof this.runtime?.commitPolicyTransition === "function";
    if (hasRuntimePrepare) {
      await this.runtime!.preparePolicyTransition!();
    }
    // 2. Runtime stage: fan out to workers WITHOUT releasing the lock.
    // Throws without touching CLI on any abort (all-old or fail-closed).
    if (hasRuntimeStage) {
      try {
        await this.runtime!.stagePolicyTransition!(policy);
      } catch (error) {
        await this.runtime?.rollbackPolicyTransition?.().catch(() => {});
        throw error;
      }
    } else if (hasRuntimeCommit) {
      await this.runtime!.commitPolicyTransition!(policy);
    }
    // 3. CLI commit while the Runtime lock is still held: nothing could
    // have executed under the staged policy yet. On failure the staged
    // snapshot aborts back to exact all-old (or the fail-closed latch)
    // before this method returns, so a reported failure never authorized
    // a side effect. The CLI error still propagates so the outer layer
    // never publishes the new config.
    try {
      await this.cli.updatePermissionPolicy(policy);
    } catch (error) {
      if (hasRuntimeStage) {
        try {
          await this.runtime?.rollbackPolicyTransition?.();
        } catch (abortError) {
          throw new Error(
            `CLI permission update failed (${error instanceof Error ? error.message : String(error)}) and Runtime abort left the permission plane failed closed (${abortError instanceof Error ? abortError.message : String(abortError)})`,
          );
        }
      } else if (hasRuntimePrepare || hasRuntimeCommit) {
        await this.runtime?.rollbackPolicyTransition?.().catch(() => {});
      }
      throw error;
    }
    // 4. Finalize: clear the staged snapshot and admit queued turns under
    // the new policy. Legacy engines without a stage API update in place
    // (releasing a prepare-only lock afterwards).
    if (hasRuntimeStage && typeof this.runtime?.finalizePolicyTransition === "function") {
      this.runtime.finalizePolicyTransition();
    } else if (!hasRuntimeStage && this.runtime) {
      if (!hasRuntimeCommit) {
        try {
          await this.runtime.updatePermissionPolicy(policy);
        } catch (error) {
          if (hasRuntimePrepare) await this.runtime?.rollbackPolicyTransition?.().catch(() => {});
          throw error;
        }
      }
      if (hasRuntimePrepare) await this.runtime?.rollbackPolicyTransition?.().catch(() => {});
    }
    return {};
  }
  async primeRuntimeQueues(sessions: EngineSessionInput[]): Promise<void> {
    const rt = this.runtime as unknown as { primeQueuesFromCatalog?: (s: unknown[]) => Promise<void> } | undefined;
    if (rt?.primeQueuesFromCatalog) await rt.primeQueuesFromCatalog(sessions as unknown[]);
  }

  async shutdown(): Promise<Record<string, never>> {
    // Plan §18: attempt cleanup on both CLI and Runtime so all resources are
    // addressed; fail closed by propagating any cleanup failure.
    const results = await Promise.allSettled([
      this.cli.shutdown(),
      ...(this.runtime ? [this.runtime.shutdown()] : []),
    ]);
    const failures = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");
    if (failures.length > 0) {
      const messages = failures
        .map((f) => (f.reason instanceof Error ? f.reason.message : String(f.reason)))
        .join("; ");
      throw new Error(`engine shutdown failed (${failures.length} engine(s) reported errors): ${messages}`);
    }
    return {};
  }

}

export class EngineUnsupportedError extends Error {
  readonly code = "RUNTIME_ENGINE_UNSUPPORTED";
}

export class EngineMismatchError extends Error {
  readonly code = "RUNTIME_ENGINE_MISMATCH";
}
