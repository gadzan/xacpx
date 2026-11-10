import { createHash } from "node:crypto";
import { inspectAgentModels } from "acpx/runtime";
import type { AcpRuntimeSessionModels, InspectAgentModelsOptions } from "acpx/runtime";
import type { AgentCommandRegistry } from "../config/agent-catalog";
import { resolveModelProbeLaunch } from "../config/resolve-agent-command";
import type { AgentCapabilityProbeRequest, AgentCapabilityProbeResult } from "./types";

/**
 * Sole wrapper around acpx/runtime `inspectAgentModels` (design §4.3). xacpx
 * resolves the agent argv upstream; this module only hands that argv to acpx
 * and maps the snapshot onto `AgentCapabilityProbeResult`. No cache, no
 * session, no transport wiring.
 */
export const ACPX_MODEL_INSPECT_TIMEOUT_MS = 75_000;

export interface AcpxModelInspectorInput {
  agentCommand: string[];
  cwd: string;
  agentProcessEnv?: Record<string, string>;
  signal?: AbortSignal;
  timeoutMs?: number;
}

export type AcpxModelInspectFn = (
  options: InspectAgentModelsOptions,
) => Promise<AcpRuntimeSessionModels | undefined>;

export interface AcpxModelInspectorDeps {
  inspectAgentModels?: AcpxModelInspectFn;
  log?: (message: string) => void;
}

export async function inspectAcpxModels(
  input: AcpxModelInspectorInput,
  deps: AcpxModelInspectorDeps = {},
): Promise<AgentCapabilityProbeResult> {
  const inspect = deps.inspectAgentModels ?? inspectAgentModels;
  const digest = createHash("sha256")
    .update(JSON.stringify({ argv: input.agentCommand, cwd: input.cwd }))
    .digest("hex")
    .slice(0, 8);
  let result: AgentCapabilityProbeResult;
  let status: string;
  try {
    // Awaited, never raced: the upstream finally closes its own transport, so
    // racing here would orphan cleanup.
    const snapshot = await inspect({
      agentCommand: input.agentCommand,
      cwd: input.cwd,
      signal: input.signal,
      timeoutMs: input.timeoutMs ?? ACPX_MODEL_INSPECT_TIMEOUT_MS,
      agentProcessEnv: input.agentProcessEnv,
    });
    if (snapshot === undefined) {
      status = "unsupported";
      result = {
        ok: false,
        failure: "unsupported",
        message: "the adapter started but did not advertise any models",
      };
    } else {
      const advertised = snapshot.availableModels
        ?? snapshot.availableModelIds.map((modelId) => ({ modelId, name: modelId }));
      const models: Array<{ modelId: string; name: string }> = [];
      for (const entry of advertised) {
        const modelId = typeof entry?.modelId === "string" ? entry.modelId.trim() : "";
        if (!modelId) continue;
        const name = typeof entry?.name === "string" && entry.name.trim() ? entry.name.trim() : modelId;
        models.push({ modelId, name });
      }
      if (models.length === 0 && advertised.length > 0) {
        status = "transport";
        result = {
          ok: false,
          failure: "transport",
          message: "the adapter advertised models the probe could not parse",
        };
      } else if (models.length === 0) {
        // Explicit empty stays distinct from unsupported: the adapter answered
        // with an empty directory. Efforts stay [] (unknown, not known-empty;
        // effort scope is Lane E).
        status = "empty";
        result = { ok: true, models: [], efforts: [] };
      } else {
        const currentModelId = typeof snapshot.currentModelId === "string" && snapshot.currentModelId.trim()
          ? snapshot.currentModelId.trim()
          : undefined;
        status = "ready";
        result = {
          ok: true,
          models,
          ...(currentModelId ? { currentModelId } : {}),
          efforts: [],
        };
      }
    }
  } catch (error) {
    const failure = classifyInspectorError(error, input.signal);
    status = failure;
    result = { ok: false, failure, message: inspectorMessage(error, failure) };
  }
  // Digest prefix only: argv and env must never reach logs.
  deps.log?.(`acpx-model-inspector ${digest} ${status}`);
  return result;
}

/**
 * Transport probe entry: resolve the request's launch to the exact argv a
 * normal session would spawn (registry-backed for bare drivers, fail-closed
 * for raw commands on every platform), then inspect it. No reserved session
 * name, no record writes, no prompt dispatch. A request that already carries
 * `agentProcessEnv` keeps it; otherwise the Claude overlay resolves here, at
 * probe time. An unprovable launch is `unsupported`, never a guessed spawn.
 */
export interface InspectorProbeDeps {
  loadAgentRegistry?: () => AgentCommandRegistry | null;
  inspectAgentModels?: AcpxModelInspectFn;
  log?: (message: string) => void;
}

export async function probeAgentCapabilitiesViaInspector(
  input: AgentCapabilityProbeRequest,
  options: { timeoutMs?: number } & InspectorProbeDeps = {},
): Promise<AgentCapabilityProbeResult> {
  const context = {
    cwd: input.cwd,
    driver: input.driver ?? input.agent,
    ...(input.settingsPolicy ? { settingsPolicy: input.settingsPolicy } : {}),
    launch: {
      ...(input.agentCommand ? { agentCommand: input.agentCommand } : {}),
      ...(input.acpxAgent ? { acpxAgent: input.acpxAgent } : {}),
      ...(input.rawCommand ? { rawCommand: input.rawCommand } : {}),
      ...(input.agentArgv ? { agentArgv: input.agentArgv } : {}),
    },
  };
  const launch = resolveModelProbeLaunch(input.agent, context, {
    ...(options.loadAgentRegistry ? { loadAgentRegistry: options.loadAgentRegistry } : {}),
    ...(input.agentProcessEnv === undefined ? { includeEnv: true as const } : {}),
  });
  if (!launch.ok) {
    return { ok: false, failure: "unsupported", message: launch.message };
  }
  const agentProcessEnv = input.agentProcessEnv ?? launch.agentProcessEnv;
  return inspectAcpxModels(
    {
      agentCommand: launch.agentCommand,
      cwd: launch.cwd,
      ...(agentProcessEnv ? { agentProcessEnv } : {}),
      ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
    },
    {
      ...(options.inspectAgentModels ? { inspectAgentModels: options.inspectAgentModels } : {}),
      ...(options.log ? { log: options.log } : {}),
    },
  );
}

function classifyInspectorError(
  error: unknown,
  signal?: AbortSignal,
): "unauthenticated" | "timeout" | "transport" | "unsupported" {
  const message = error instanceof Error ? error.message : String(error);
  if (error instanceof Error && error.name === "TimeoutError") return "timeout";
  if (/timed out/i.test(message)) return "timeout";
  if (signal?.aborted || (error instanceof Error && error.name === "AbortError")) return "transport";
  if (/AUTH_REQUIRED|auth required|authentication required|not authenticated|login required/i.test(message)) {
    return "unauthenticated";
  }
  if (/did not advertise model support|no models|cannot enumerate/i.test(message)) return "unsupported";
  return "transport";
}

function inspectorMessage(
  error: unknown,
  failure: "unauthenticated" | "timeout" | "transport" | "unsupported",
): string {
  if (failure === "timeout") return "the model inspection timed out before the adapter advertised models";
  if (failure === "unauthenticated") return "the adapter requires authentication before it can list models";
  if (failure === "unsupported") return "the adapter cannot enumerate models";
  const raw = error instanceof Error ? error.message : String(error);
  if (/abort/i.test(raw)) return "the model inspection was aborted before the adapter advertised models";
  const detail = raw.trim().slice(0, 400);
  return detail || "model inspection failed";
}
