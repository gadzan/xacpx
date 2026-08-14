import { resolveConfiguredAgentLaunch } from "../config/resolve-agent-command";
import type { AgentConfig, TransportConfig } from "../config/types";
import type { WorkerBindingRecord } from "./orchestration-types";

/**
 * A missing binding means this is a first launch and should opt into the new
 * guard. A persisted binding without the marker predates the rollout and must
 * keep its old unguarded identity so upgrades do not rebind an existing acpx
 * record. New bindings persist `guardAcpOutput: true` below.
 */
export function shouldGuardWorkerAcpOutput(
  binding: Pick<WorkerBindingRecord, "guardAcpOutput"> | undefined,
): boolean {
  return binding === undefined || binding.guardAcpOutput === true;
}

/** Persist the rollout choice when a task replaces or reuses a binding. */
export function workerBindingGuardFields(
  previousBinding: Pick<WorkerBindingRecord, "guardAcpOutput"> | undefined,
): { guardAcpOutput?: true } {
  return previousBinding && previousBinding.guardAcpOutput !== true
    ? {}
    : { guardAcpOutput: true };
}

export function resolveWorkerAgentLaunch(
  agent: Pick<AgentConfig, "driver" | "command" | "argv">,
  transport: Pick<TransportConfig, "preferLocalAgents" | "adapterVersions" | "adapterRegistry"> | undefined,
  binding: Pick<WorkerBindingRecord, "guardAcpOutput"> | undefined,
) {
  return resolveConfiguredAgentLaunch(agent, transport, {
    guardAcpOutput: shouldGuardWorkerAcpOutput(binding),
  });
}
