import { randomUUID } from "node:crypto";

import type { AppState, SessionTransportEngine } from "../state/types";

import { resolveConfiguredAgentLaunch } from "../config/resolve-agent-command";
import type { AgentConfig, TransportConfig } from "../config/types";
import type { WorkerBindingRecord } from "./orchestration-types";
import type { ResolvedSession } from "../transport/types";
import { releaseWorkerRetirement, tryClaimWorkerRetirement } from "./worker-binding-retirement";

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

/**
 * Preserve a reusable worker's last-dispatched launch snapshot across
 * whole-object binding reconstructions (reuse shells, post-ensure rebuilds).
 * Every site that rebuilds an existing binding MUST spread this alongside
 * the guard/endpoint/engine helpers: dropping the snapshot deletes the only
 * evidence the reaper and retirement convergence have for the previous
 * owner's identity after a managed-pin/config change. A crash between the
 * rebuild's saveState and the next launch snapshot would otherwise orphan
 * the old owner permanently (ttl=0).
 */
export function workerBindingLaunchFields(
  previousBinding: Pick<WorkerBindingRecord, "launchAgentCommand" | "launchAcpxAgent" | "launchRawCommand"> | undefined,
): { launchAgentCommand?: string; launchAcpxAgent?: string; launchRawCommand?: string } {
  if (!previousBinding) return {};
  return {
    ...(previousBinding.launchAgentCommand ? { launchAgentCommand: previousBinding.launchAgentCommand } : {}),
    ...(previousBinding.launchAcpxAgent ? { launchAcpxAgent: previousBinding.launchAcpxAgent } : {}),
    ...(previousBinding.launchRawCommand ? { launchRawCommand: previousBinding.launchRawCommand } : {}),
  };
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

/** A staged binding shell's durable identity, captured at stage time. */
export interface StagedWorkerIdentity {
  logicalSessionId: string;
  transportEngine: SessionTransportEngine;
}

/** Worker coordinates for a verified owner teardown (no live-state lookup). */
export interface StagedWorkerOwner {
  workerSession: string;
  targetAgent: string;
  workspace: string;
  cwd?: string;
  role?: string;
}

/**
 * Verified-converge a just-started worker owner BEFORE its staged shell may
 * be deleted (rollback-after-owner): with the shell gone, a surviving owner
 * becomes an undocumented live worker invisible to membership scans, guards,
 * recovery, and inheritance. Uses the STAGED identity captured at stage
 * time — never re-resolves from live state, whose shell may already be
 * gone or replaced. Throws when teardown cannot be verified (including a
 * missing release port); the caller must then RETAIN the shell (fail
 * closed) and surface both failures.
 *
 * Lease modes:
 * - Default (claim here): for synchronous startup rollback (human, approval,
 *   parallel drain) of a FIRST binding the caller itself staged. The staged
 *   LID is fresh, so no stale detached chain can name it; the caller's task
 *   is either unpersisted-but-reserved (ensure failure: the held start
 *   reservation bars every other admission and every reservation-checking
 *   stale claim) or persisted-running (dispatch/drain failure: the active
 *   task bars them). Drain additionally uses globally-unique ephemeral names
 *   no other delegation can resolve. The claim here only arbitrates between
 *   concurrent teardowns of the same name.
 * - `leaseAlreadyHeld`: for detached stale cleanup (RPC startup paths)
 *   that owns nothing and names a possibly-REUSED LID. Those callers MUST
 *   claim atomically with their ownerless/reservation checks inside one
 *   state-mutex mutate BEFORE the transport I/O gap (see
 *   `claimWorkerTeardownLease`), hold the lease across release + verify,
 *   and release in their own finally. A blind claim here would be TOCTOU: a
 *   new delegation admitted after their check but before this claim would
 *   still be killed. Contended claims throw (fail closed, retain) in both
 *   modes.
 */
export async function teardownStagedWorkerOwner(
  releaseWorkerSession:
    | ((request: StagedWorkerOwner & StagedWorkerIdentity) => Promise<void>)
    | undefined,
  worker: StagedWorkerOwner,
  staged: StagedWorkerIdentity,
  options: { leaseAlreadyHeld?: boolean } = {},
): Promise<void> {
  if (!releaseWorkerSession) {
    throw new Error(
      `cannot converge worker "${worker.workerSession}" after its owner started: no releaseWorkerSession port is wired`,
    );
  }
  if (!options.leaseAlreadyHeld && !tryClaimWorkerRetirement(worker.workerSession)) {
    throw new Error(
      `cannot converge worker "${worker.workerSession}": retirement already in progress for this session`,
    );
  }
  try {
    await releaseWorkerSession({ ...worker, ...staged });
  } finally {
    if (!options.leaseAlreadyHeld) releaseWorkerRetirement(worker.workerSession);
  }
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

/** Launch identity resolved for one worker dispatch (reap snapshot source). */
export interface WorkerBindingLaunchSnapshot {
  agentCommand?: string;
  acpxAgent?: string;
  rawCommand?: string;
}

/**
 * Stage a worker binding's launch snapshot onto a copy-on-write clone.
 * Unlike the immutable LID/engine identity above, the snapshot is refreshed
 * whenever the resolved launch differs, so a later restart can reap the
 * previous owner after a managed-pin/config change. Returns
 * `{ changed: false }` when the binding is missing or the snapshot already
 * matches (steady-state dispatches skip the save). The caller must
 * `saveNow(nextState)` and publish ONLY on success, same G11 contract as
 * the identity staging above. Stale keys the new launch no longer carries
 * are cleared so they cannot reap a phantom identity forever.
 */
export function stageWorkerBindingLaunch(
  state: AppState,
  input: { workerSession: string },
  launch: WorkerBindingLaunchSnapshot,
): { changed: false } | { changed: true; nextState: AppState } {
  const binding = state.orchestration.workerBindings[input.workerSession];
  if (!binding) {
    return { changed: false };
  }
  const snapshot = {
    ...(launch.agentCommand ? { launchAgentCommand: launch.agentCommand } : {}),
    ...(launch.acpxAgent ? { launchAcpxAgent: launch.acpxAgent } : {}),
    ...(launch.rawCommand ? { launchRawCommand: launch.rawCommand } : {}),
  };
  if (
    binding.launchAgentCommand === snapshot.launchAgentCommand &&
    binding.launchAcpxAgent === snapshot.launchAcpxAgent &&
    binding.launchRawCommand === snapshot.launchRawCommand
  ) {
    return { changed: false };
  }
  const nextState = structuredClone(state);
  const nextBinding = nextState.orchestration.workerBindings[input.workerSession];
  if (!nextBinding) {
    return { changed: false };
  }
  delete nextBinding.launchAgentCommand;
  delete nextBinding.launchAcpxAgent;
  delete nextBinding.launchRawCommand;
  Object.assign(nextBinding, snapshot);
  return { changed: true, nextState };
}

/**
 * The extra owner identity a worker retirement must converge besides the
 * current resolution: the last-dispatched launch snapshot when it names a
 * different acpx record. Command-only (no alias): the transport passes it as
 * `--agent`, which acpx matches verbatim against the old record. Returns
 * undefined when there is no snapshot or it already matches the current
 * resolution (same pin, sticky custom, or bare launch).
 */
export function historicalWorkerReleaseTarget(
  current: Pick<ResolvedSession, "agentCommand" | "rawCommand">,
  snapshot:
    | Pick<WorkerBindingRecord, "launchAgentCommand" | "launchAcpxAgent" | "launchRawCommand">
    | undefined,
): { agentCommand: string } | undefined {
  const historicalCommand = snapshot?.launchAgentCommand ?? snapshot?.launchRawCommand;
  if (!historicalCommand) {
    return undefined;
  }
  if (historicalCommand === current.agentCommand || historicalCommand === current.rawCommand) {
    return undefined;
  }
  return { agentCommand: historicalCommand };
}

/**
 * Converge a retiring worker's engine-side owner(s): always the current
 * resolution, then the historical snapshot target when it names a different
 * record. A throw from either step retains the binding (fail-closed retry),
 * so the old owner is never stranded by a deleted binding. Missing records
 * read as success on both steps (transport contract).
 */
export async function releaseWorkerOwnerSessions(
  removeSession: (session: ResolvedSession) => Promise<void>,
  current: ResolvedSession,
  snapshot:
    | Pick<WorkerBindingRecord, "launchAgentCommand" | "launchAcpxAgent" | "launchRawCommand">
    | undefined,
): Promise<void> {
  await removeSession(current);
  const historical = historicalWorkerReleaseTarget(current, snapshot);
  if (historical) {
    await removeSession({
      ...current,
      agentCommand: historical.agentCommand,
      acpxAgent: undefined,
      rawCommand: undefined,
      agentArgv: undefined,
    });
  }
}
/**
 * Persist a worker binding's launch snapshot as one atomic transaction on the
 * shared state mutex (stage on a clone, saveNow, then publish to live state
 * ONLY on success). Callers must run outside the non-reentrant mutex.
 */
export async function persistWorkerBindingLaunch(
  state: AppState,
  input: { workerSession: string },
  launch: WorkerBindingLaunchSnapshot,
  deps: Pick<WorkerBindingIdentityPersistence, "saveNow" | "publish" | "runExclusive">,
): Promise<void> {
  await deps.runExclusive(async () => {
    const staged = stageWorkerBindingLaunch(state, input, launch);
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
