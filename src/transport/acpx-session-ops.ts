/**
 * Shared acpx session-operation logic (Phase 2a of the CLI/Bridge driver unification).
 *
 * Before: `AcpxCliTransport` (src/transport/acpx-cli/acpx-cli-transport.ts) and
 * `BridgeRuntime` (src/bridge/bridge-runtime.ts) each implemented the same
 * queue-owner / persisted-effort / overflow-cleanup orchestration against
 * their own session shapes (`ResolvedSession.transportSession/alias` vs
 * `BridgeSessionInput.name/sessionKey`). The bodies were token-identical
 * (similarity 0.74–0.82); only the field names and the I/O plumbing differed.
 *
 * After: the decision logic and orchestration live here, parameterized by a
 * normalized ref plus injected I/O. Both lanes keep their own execution
 * plumbing (run vs runControl, readSessionRecord variants, error strings) —
 * this module never spawns. Behaviour is bit-identical by construction; the
 * per-lane differences are preserved, not papered over:
 * - The MCP pre-launch reads through the owned-record path on both lanes:
 *   the CLI auto-ensures Bot-owned logical sessions, and since Phase 3c the
 *   bridge auto-ensures runtime-lane Bot sessions the same way (previously a
 *   known gap: the bridge read strictly and a never-ensured Bot session
 *   failed its first turn).
 * - CLI `terminateQueueOwner` is always the verified terminator; the bridge
 *   honors its `terminateQueueOwner` override.
 */

import { classifyPreinstalledAdapterCommandShape } from "../adapters/adapter-catalog";
import { ACPX_MODEL_INSPECT_TIMEOUT_MS } from "./acpx-model-inspector";
import type { LaunchQueueOwnerInput } from "./acpx-queue-owner-launcher";
import { terminateAcpxQueueOwnerVerified } from "./acpx-queue-owner-launcher";
import type { QueueOwnerAdapterContext } from "./acpx-queue-owner-launcher";
import { parseSessionEffortRecord, sessionEffortToReapply } from "./session-effort";
import type { AcpxQueueCleanupResult } from "./acpx-queue-overflow";
import type { ResolvedSession } from "./types";

/** Normalized view of "which session needs a queue owner". Both lanes adapt into this. */
export interface QueueOwnerRef {
  mcpCoordinatorSession?: string;
  mcpSourceHandle?: string;
  agentCommand?: string;
  model?: string;
  /** Adapter-context identity: CLI uses the logical alias, bridge `sessionKey ?? name`. */
  adapterContextSessionKey: string;
}

export function queueOwnerRefFromResolvedSession(session: ResolvedSession): QueueOwnerRef {
  return {
    ...(session.mcpCoordinatorSession ? { mcpCoordinatorSession: session.mcpCoordinatorSession } : {}),
    ...(session.mcpSourceHandle ? { mcpSourceHandle: session.mcpSourceHandle } : {}),
    ...(session.agentCommand ? { agentCommand: session.agentCommand } : {}),
    ...(session.model ? { model: session.model } : {}),
    adapterContextSessionKey: session.alias,
  };
}

/** Structural subset of BridgeSessionInput — kept local so this module never imports the bridge. */
export interface BridgeLikeSessionInput {
  agentCommand?: string;
  mcpCoordinatorSession?: string;
  mcpSourceHandle?: string;
  model?: string;
  sessionKey?: string;
  name: string;
}

export function queueOwnerRefFromBridgeInput(input: BridgeLikeSessionInput): QueueOwnerRef {
  return {
    ...(input.mcpCoordinatorSession ? { mcpCoordinatorSession: input.mcpCoordinatorSession } : {}),
    ...(input.mcpSourceHandle ? { mcpSourceHandle: input.mcpSourceHandle } : {}),
    ...(input.agentCommand ? { agentCommand: input.agentCommand } : {}),
    ...(input.model ? { model: input.model } : {}),
    adapterContextSessionKey: input.sessionKey ?? input.name,
  };
}

export interface QueueOwnerLaunchContext {
  agentEnv: NodeJS.ProcessEnv | undefined;
  hostPolicyEnv: Record<string, string>;
  permissionMode: string;
  nonInteractivePermissions: string;
  createAdapterContext?: (input: {
    id: "codex" | "claude";
    sessionKey: string;
    agentCommand: string;
  }) => QueueOwnerAdapterContext | undefined;
}

/**
 * Pure queue-owner launch-input builder. Field order is normalized (object
 * key order is not observable through toEqual or the launcher); the
 * agent-env-must-not-drop-host-ceilings guard is the same on both lanes.
 */
export function buildQueueOwnerLaunchInput(
  ref: QueueOwnerRef,
  acpxRecordId: string,
  ctx: QueueOwnerLaunchContext,
): LaunchQueueOwnerInput {
  const adapterId = classifyPreinstalledAdapterCommandShape(ref.agentCommand);
  const adapterContext = adapterId && ref.agentCommand
    ? ctx.createAdapterContext?.({
        id: adapterId,
        sessionKey: ref.adapterContextSessionKey,
        agentCommand: ref.agentCommand,
      })
    : undefined;
  return {
    acpxRecordId,
    coordinatorSession: ref.mcpCoordinatorSession!,
    ...(ref.mcpSourceHandle ? { sourceHandle: ref.mcpSourceHandle } : {}),
    permissionMode: ctx.permissionMode as LaunchQueueOwnerInput["permissionMode"],
    nonInteractivePermissions: ctx.nonInteractivePermissions as LaunchQueueOwnerInput["nonInteractivePermissions"],
    ...(adapterId && ref.agentCommand ? { agentCommand: ref.agentCommand } : {}),
    ...(adapterContext ? { adapterContext } : {}),
    ...(ref.model?.trim() ? { sessionOptions: { model: ref.model.trim() } } : {}),
    // Agent env wins the base, but an explicitly set agent env must not drop
    // the host ceilings. Agent-undefined stays omitted so warm-owner
    // fingerprinting keeps riding the construction-time baseEnv.
    ...(ctx.agentEnv ? { env: { ...ctx.agentEnv, ...ctx.hostPolicyEnv } } : {}),
  };
}

/** Minimal cooler surface: both lanes' launchers expose optional `cool`. */
export interface QueueOwnerCooler {
  cool?(acpxRecordId: string): Promise<void>;
}

/** Shared cool path: launcher fast-path, else the verified terminator. */
export async function coolQueueOwnerWith(
  launcher: QueueOwnerCooler,
  acpxRecordId: string,
): Promise<void> {
  if (launcher.cool) {
    await launcher.cool(acpxRecordId);
    return;
  }
  await terminateAcpxQueueOwnerVerified(acpxRecordId);
}

/**
 * Shared "will the coordinator launch replace the owner" predicate.
 * `wouldReuse` absent means the launcher cannot prove reuse → replaced.
 */
export async function willReplaceQueueOwner(options: {
  coordinatorSession?: string;
  acpxRecordId: string | undefined;
  wouldReuse?: (input: LaunchQueueOwnerInput) => Promise<boolean>;
  buildLaunchInput(recordId: string): LaunchQueueOwnerInput;
}): Promise<boolean> {
  if (!options.coordinatorSession || !options.acpxRecordId) return false;
  if (!options.wouldReuse) return true;
  return !(await options.wouldReuse(options.buildLaunchInput(options.acpxRecordId)));
}

/**
 * Pure persisted-effort decision: parse the record, decide whether the
 * persisted effort still applies. The cool + apply side effects stay per-lane.
 */
export function resolveEffortReapply(options: {
  persisted: string | undefined;
  record: string;
  ownerWillBeReplaced: boolean;
}): string | undefined {
  const trimmed = options.persisted?.trim();
  if (!trimmed) return undefined;
  const observed = parseSessionEffortRecord(options.record);
  return sessionEffortToReapply({
    persisted: trimmed,
    observedCurrent: observed?.current,
    advertised: observed?.available,
    ownerWillBeReplaced: options.ownerWillBeReplaced,
  }) ?? undefined;
}

export interface EffortSyncDeps {
  readRecord(): Promise<string>;
  ownerWillBeReplaced(recordId: string | undefined): Promise<boolean>;
  coolOwner(recordId: string): Promise<void>;
  applyEffort(effort: string, record: string): Promise<void>;
}

/**
 * Shared sync-persisted-effort flow. The record-id extraction differs per
 * lane (CLI parses `acpxRecordId` via parseAcpxSessionRecordId on the effort
 * record; bridge does the same) — both reduce to the same three steps, so
 * the only per-lane pieces are the injected I/O.
 */
export async function syncPersistedSessionEffortFlow(
  persisted: string | undefined,
  recordIdOf: (record: string) => string | undefined,
  deps: EffortSyncDeps,
): Promise<void> {
  const trimmed = persisted?.trim();
  if (!trimmed) return;
  const record = await deps.readRecord();
  const acpxRecordId = recordIdOf(record);
  const ownerWillBeReplaced = await deps.ownerWillBeReplaced(acpxRecordId);
  const effort = resolveEffortReapply({ persisted: trimmed, record, ownerWillBeReplaced });
  if (!effort) return;
  if (acpxRecordId) await deps.coolOwner(acpxRecordId);
  await deps.applyEffort(effort, record);
}

export interface McpOwnerDeps {
  coordinatorSession?: string;
  readRecord(): Promise<{ acpxRecordId: string }>;
  launch(input: LaunchQueueOwnerInput): Promise<{ agentCommand?: string } | undefined | void>;
  onPreparedAgentCommand(agentCommand: string): void;
  buildLaunchInput(recordId: string): LaunchQueueOwnerInput;
}

/**
 * Shared MCP coordinator owner pre-launch. The record-read differs per lane
 * (CLI auto-ensures Bot-owned logical sessions via readOwnedSessionRecord;
 * the bridge reads strictly) — injected, so the gap is preserved.
 */
export async function ensureMcpQueueOwnerLaunched(deps: McpOwnerDeps): Promise<void> {
  if (!deps.coordinatorSession) {
    return;
  }
  const record = await deps.readRecord();
  const prepared = await deps.launch(deps.buildLaunchInput(record.acpxRecordId));
  if (prepared?.agentCommand) deps.onPreparedAgentCommand(prepared.agentCommand);
}

export interface OverflowCleanupDeps {
  cancel(): Promise<void>;
  readRecordId(): Promise<string>;
  terminate(recordId: string): Promise<void>;
}

/** Shared overflow-cleanup flow: cancel first, resolve the record, terminate. Never throws. */
export async function cleanupOverflowedOwnerFlow(deps: OverflowCleanupDeps): Promise<AcpxQueueCleanupResult> {
  const diagnostics: string[] = [];
  let cancelSucceeded = false;
  try {
    await deps.cancel();
    cancelSucceeded = true;
  } catch (error) {
    diagnostics.push(`cancel failed: ${describeCleanupError(error)}`);
  }

  let recordId: string | undefined;
  try {
    recordId = await deps.readRecordId();
  } catch (error) {
    diagnostics.push(`could not resolve the queue owner record: ${describeCleanupError(error)}`);
  }

  let ownerTerminationSucceeded = false;
  if (recordId) {
    try {
      await deps.terminate(recordId);
      ownerTerminationSucceeded = true;
    } catch (error) {
      diagnostics.push(`owner termination failed: ${describeCleanupError(error)}`);
    }
  }

  return {
    cancelAttempted: true,
    cancelSucceeded,
    ownerTerminationAttempted: Boolean(recordId),
    ownerTerminationSucceeded,
    ...(diagnostics.length > 0 ? { diagnostic: diagnostics.join("; ") } : {}),
  };
}

/** Shared truncation for cleanup diagnostics (was duplicated in both lanes). */
export function describeCleanupError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.length > 512 ? `${message.slice(0, 512)}…` : message;
}

/** Shared model-inspector timeout: session-init bound capped by the inspector ceiling. */
export function probeInspectTimeout(sessionInitTimeoutMs: number): number {
  return Math.min(sessionInitTimeoutMs, ACPX_MODEL_INSPECT_TIMEOUT_MS);
}
