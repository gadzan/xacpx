import { randomUUID } from "node:crypto";

import type { AppState, SessionTransportEngine } from "../state/types";

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

/** Preserve a reusable worker's endpoint identity; mint one for a new binding. */
export function workerBindingEndpointIdentityFields(
  previousBinding: Pick<WorkerBindingRecord, "agentEndpointId"> | undefined,
  createId?: () => string,
): { agentEndpointId?: string } {
  if (previousBinding?.agentEndpointId) {
    return { agentEndpointId: previousBinding.agentEndpointId };
  }
  return createId ? { agentEndpointId: "endpoint_" + createId() } : {};
}

/** Preserve a reusable worker's logical session id and engine affinity. */
export function workerBindingEngineFields(
  previousBinding: Pick<WorkerBindingRecord, "logicalSessionId" | "transportEngine"> | undefined,
): { logicalSessionId?: string; transportEngine?: SessionTransportEngine } {
  return {
    ...(previousBinding?.logicalSessionId ? { logicalSessionId: previousBinding.logicalSessionId } : {}),
    ...(previousBinding?.transportEngine ? { transportEngine: previousBinding.transportEngine } : {}),
  };
}

/**
 * Immutable identity fields for a worker binding shell: keep a reusable
 * binding's LID/engine, mint both for a first binding. Unlike
 * workerBindingEngineFields (which preserves only), this always returns a
 * complete identity so a shell persisted BEFORE the first owner starts
 * already carries the durable affinity G11 requires. The engine MUST come
 * from the physical-group resolver — a config-derived engine staged here
 * could bind a CLI shell over a Runtime-owned physical session.
 */
export function workerBindingIdentityFields(
  previousBinding: Pick<WorkerBindingRecord, "logicalSessionId" | "transportEngine"> | undefined,
  resolveEngine: () => SessionTransportEngine,
  createLid: () => string = randomUUID,
): { logicalSessionId: string; transportEngine: SessionTransportEngine } {
  return {
    logicalSessionId: previousBinding?.logicalSessionId ?? createLid(),
    transportEngine: previousBinding?.transportEngine ?? resolveEngine(),
  };
}
/**
 * Stage a worker binding's immutable identity (LID + engine) onto a
 * copy-on-write clone. Returns `{ changed: false }` when the live binding is
 * missing or already complete. Otherwise returns the staged clone — the
 * caller must `saveNow(nextState)` and publish ONLY on success, so a saveNow
 * rejection leaves live state byte-for-byte unchanged and a retry re-stages
 * (G11: no owner ever launches on a never-durable affinity).
 */
export function stageWorkerBindingIdentity(
  state: AppState,
  input: { workerSession: string; targetAgent: string; workspace: string },
  resolveEngine: (input: { alias: string; agent: string; workspace: string }) => SessionTransportEngine,
): { changed: false } | { changed: true; nextState: AppState } {
  const binding = state.orchestration.workerBindings[input.workerSession];
  if (!binding) {
    return { changed: false };
  }
  if (binding.logicalSessionId && binding.transportEngine) {
    return { changed: false };
  }
  const nextState = structuredClone(state);
  const nextBinding = nextState.orchestration.workerBindings[input.workerSession];
  if (!nextBinding) {
    return { changed: false };
  }
  if (!nextBinding.logicalSessionId) {
    nextBinding.logicalSessionId = randomUUID();
  }
  if (!nextBinding.transportEngine) {
    nextBinding.transportEngine = resolveEngine({
      alias: input.workerSession,
      agent: input.targetAgent,
      workspace: input.workspace,
    });
  }
  return { changed: true, nextState };
}

export interface WorkerBindingIdentityPersistence {
  resolveEngine: (input: { alias: string; agent: string; workspace: string }) => SessionTransportEngine;
  saveNow: (nextState: AppState) => Promise<void>;
  publish: (nextState: AppState) => void;
  runExclusive: <T>(critical: () => Promise<T>) => Promise<T>;
}

/**
 * Persist a worker binding's immutable identity (LID + engine) as one atomic
 * transaction on the shared state mutex: stage on a clone, saveNow, then
 * publish to live state ONLY on success. The whole stage + save + publish
 * sequence must hold the mutex — two dispatches staging from the same live
 * snapshot would otherwise lost-update each other's durable identity (or any
 * other AppState mutation committed in between) with a stale whole-state
 * write (G11 persist-before-owner). A saveNow rejection leaves live state
 * untouched so a retry re-stages. Callers must run outside the non-reentrant
 * mutex.
 */
export async function persistWorkerBindingIdentity(
  state: AppState,
  input: { workerSession: string; targetAgent: string; workspace: string },
  deps: WorkerBindingIdentityPersistence,
): Promise<void> {
  await deps.runExclusive(async () => {
    const staged = stageWorkerBindingIdentity(state, input, deps.resolveEngine);
    if (!staged.changed) {
      return;
    }
    await deps.saveNow(staged.nextState);
    deps.publish(staged.nextState);
  });
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
