/**
 * Shared OMP native model-restore recovery (Phase 3c of the CLI/Bridge driver unification).
 *
 * Before: only `AcpxCliTransport.setModel` knew how to recover the
 * `Could not restore model <id>` failure: an ordinary `set` that fails with
 * that exact error on a recognized OMP launch runs the bounded native helper
 * under an exclusive physical gate, then retries the ordinary setter for
 * acpx-side sync. `BridgeRuntime.setModel` had no such path — an OMP model
 * change that hit the restore failure on the runtime lane was a dead end.
 *
 * The full mechanism now lives here and both lanes delegate to it:
 * - `runSetModelWithNativeRestore` — ordinary setter, restore-error gating,
 *   bounded helper under an exclusive physical lease, acpx-side sync retry.
 * - `assertNoActiveNativeRestore` — refuses turns while a native restore holds
 *   the physical session (a turn admitted mid-recovery would race the native
 *   writer). Both lanes call it from prompt / inject / set-mode / set-effort /
 *   set-model paths, like the CLI always did.
 *
 * The lease maps are module-scoped, so two transports (even across lanes) that
 * resolve to the same physical OMP session contend for one recovery — same as
 * the old per-class statics, which were process-global anyway.
 *
 * Retry-forward semantics are unchanged: a helper success followed by a setter
 * failure reports the partial sync, and a rerun of setModel is always safe
 * (the helper is idempotent; no JSONL rollback). Timeouts never enter
 * recovery: a timed-out acpx side is wedged, not mis-persisted.
 */

import { nativeCatalogIdentityForLaunch } from "../sessions/native-session-guard";
import { assertAcpxQueueOwnerAbsent } from "./acpx-queue-owner-launcher";
import { CommandTimeoutError, isCommandTimeoutError } from "./command-timeouts";
import { modelRestoreFailure, recoverOmpSessionModel } from "./omp-model-recovery";
import { resolveOmpRecoveryLaunch } from "./omp-recovery-launch";

/** Session identity for physical-lease keying. Both lanes adapt into this. */
export interface NativeModelRestoreSession {
  /** Display name for errors (CLI: transportSession; bridge: name). */
  transportSession: string;
  cwd: string;
  agent: string;
  driver?: string;
  agentCommand?: string;
  acpxAgent?: string;
  rawCommand?: string;
  agentArgv?: string[];
}

/** The acpx record fields recovery needs; both lanes read the same shape. */
export interface NativeModelRestoreRecord {
  acpxRecordId: string;
  agentSessionId?: string;
  acpSessionId?: string;
}

export interface NativeModelRestoreDeps {
  /** Bounded record read; throws when the record is unreadable. */
  readSessionRecord(timeoutMs: number): Promise<NativeModelRestoreRecord>;
  /** Ordinary `set ... model <id>`; throws (control-command text) on failure. */
  runSetModel(
    modelId: string,
    opts: { timeoutMs: number; env?: NodeJS.ProcessEnv; deadlineAt: number },
  ): Promise<unknown>;
  /**
   * Lane's effective spawn env. Bare for the helper spawn (session as-is);
   * with-model for the acpx setter (the global --model must agree with the
   * `set model` value). The distinction is observable through per-agent env
   * seams, so it is preserved, not collapsed.
   */
  envForModel(modelId?: string): NodeJS.ProcessEnv | undefined;
  managementTimeoutMs: number;
  now?: () => number;
  /** Test seams for the OMP native recovery path. */
  ompModelRecovery?: { recoverOmpSessionModel: typeof recoverOmpSessionModel };
  queueOwnerAbsence?: { assertAcpxQueueOwnerAbsent: typeof assertAcpxQueueOwnerAbsent };
}

/**
 * Exclusive native-recovery lease, module-scoped so two transports (logical
 * aliases, even across lanes) that resolve to the same physical OMP session
 * contend for one recovery.
 */
const recoveries = new Map<string, { nativeId?: string }>();
/** setModel-vs-setModel serialization; plain turns use the recovery guard. */
const setModelLocks = new Set<string>();
/** Native ids learned per physical identity, so sibling aliases resolve every
 *  in-flight native key. A per-identity SET (never a single value). */
const knownNativeIds = new Map<string, Set<string>>();

function recoveryIdentityKey(session: NativeModelRestoreSession): string {
  return JSON.stringify(nativeCatalogIdentityForLaunch({
    cwd: session.cwd,
    ...(session.agentCommand ? { agentCommand: session.agentCommand } : {}),
    ...(session.acpxAgent ? { acpxAgent: session.acpxAgent } : {}),
    ...(session.rawCommand ? { rawCommand: session.rawCommand } : {}),
    ...(session.agentArgv ? { agentArgv: session.agentArgv } : {}),
  }));
}

function recoverySessionKey(session: NativeModelRestoreSession): string {
  return `${recoveryIdentityKey(session)}|session:${session.transportSession}`;
}

function recoveryNativeKey(identity: string, nativeId: string): string {
  return `${identity}|native:${nativeId}`;
}

/**
 * Throws while a native model restore holds the physical session. Called by
 * prompt/injection/setter paths so no turn is admitted into the recovery window.
 */
export function assertNoActiveNativeRestore(session: NativeModelRestoreSession): void {
  const identity = recoveryIdentityKey(session);
  const keys = [recoverySessionKey(session)];
  const inFlightNative = recoveries.get(keys[0]!)?.nativeId;
  if (inFlightNative) keys.push(recoveryNativeKey(identity, inFlightNative));
  const known = knownNativeIds.get(identity);
  if (known) for (const id of known) keys.push(recoveryNativeKey(identity, id));
  for (const key of keys) {
    if (recoveries.has(key)) {
      throw new Error(
        `a native model restore is in progress for session "${session.transportSession}"; retry once it finishes`,
      );
    }
  }
}

/**
 * Ordinary setter with OMP native-restore recovery. See the module header for
 * the accepted UX and retry-forward semantics.
 */
export async function runSetModelWithNativeRestore(
  session: NativeModelRestoreSession,
  modelId: string,
  deps: NativeModelRestoreDeps,
): Promise<void> {
  // Serialize concurrent setModel calls for the same physical session
  // BEFORE the ordinary setter: without this, two callers both pass the
  // guard, both run the acpx-side `set` mutation, and only then does the
  // loser hit the recovery lease — after it already changed acpx state.
  // This lock covers setModel-vs-setModel only (prompt/inject keep using the
  // recovery guard, so a plain set never blocks a turn).
  const setLockKey = recoverySessionKey(session);
  if (setModelLocks.has(setLockKey)) {
    throw new Error(
      `a native model restore is already in progress for session "${session.transportSession}"; retry once it finishes`,
    );
  }
  setModelLocks.add(setLockKey);
  try {
    assertNoActiveNativeRestore(session);
    const managementTimeoutMs = deps.managementTimeoutMs;
    const now = deps.now ?? Date.now;
    const deadlineAt = now() + managementTimeoutMs;
    const remainingTimeoutMs = () => {
      const remaining = deadlineAt - now();
      if (remaining <= 0) {
        throw new CommandTimeoutError(managementTimeoutMs, "set model", { stage: "set-model" });
      }
      return remaining;
    };
    try {
      await deps.runSetModel(modelId, {
        timeoutMs: remainingTimeoutMs(),
        env: deps.envForModel(modelId),
        deadlineAt,
      });
      return;
    } catch (error) {
      // A management timeout carries raw subprocess output in its message,
      // which can coincidentally contain the restore-failure text. Timeouts
      // never enter recovery: the acpx side is wedged, not mis-persisted.
      if (isCommandTimeoutError(error)) throw error;
      const restore = modelRestoreFailure(error);
      const launch = restore && resolveOmpRecoveryLaunch({
        agent: session.agent,
        ...(session.driver ? { driver: session.driver } : {}),
        ...(session.agentArgv ? { agentArgv: session.agentArgv } : {}),
        ...(session.agentCommand ? { agentCommand: session.agentCommand } : {}),
        ...(session.rawCommand ? { rawCommand: session.rawCommand } : {}),
      });
      if (!restore || !launch) throw error;
      await recoverNativeModel(session, modelId, restore.modelId, launch, deps, deadlineAt, remainingTimeoutMs);
    }
  } finally {
    setModelLocks.delete(setLockKey);
  }
}

/**
 * One bounded native writer per physical session. Holds an exclusive lease
 * across the helper AND the acpx-side sync, refuses while any acpx queue owner
 * lease exists (verified absence only — never kills or unlinks), resolves the
 * full native session id from the persisted acpx record, and runs the helper
 * (which persists the model through OMP's own switch_session RPC). Never
 * replays a prompt and never touches the session JSONL.
 */
async function recoverNativeModel(
  session: NativeModelRestoreSession,
  modelId: string,
  restoreModelId: string,
  launch: { command: string; args: string[] },
  deps: NativeModelRestoreDeps,
  deadlineAt: number,
  remainingTimeoutMs: () => number,
): Promise<void> {
  let record: NativeModelRestoreRecord;
  const identity = recoveryIdentityKey(session);
  const sessionKey = recoverySessionKey(session);
  // Session-key acquire is synchronous (check+set with no await between), so
  // two concurrent setModel calls for the same physical session cannot both
  // pass. Native-key acquire happens after the record read; its check+set is
  // likewise synchronous. Every path releases via finally, including helper
  // and sync failures.
  if (recoveries.has(sessionKey)) {
    throw new Error(
      `a native model restore is already in progress for session "${session.transportSession}"; retry once it finishes`,
    );
  }
  recoveries.set(sessionKey, {});
  try {
    try {
      record = await deps.readSessionRecord(remainingTimeoutMs());
    } catch (error) {
      throw new Error(
        `cannot restore model "${restoreModelId}" for session "${session.transportSession}": the acpx session record is unreadable (${error instanceof Error ? error.message : String(error)})`,
        { cause: error },
      );
    }
    // The native session id is the ACP session id (OMP publishes its own
    // session id there); the provider id is the fallback.
    const nativeId = record.acpSessionId ?? record.agentSessionId;
    if (!nativeId) {
      throw new Error(
        `cannot restore model "${restoreModelId}" for session "${session.transportSession}": the acpx session record carries no native session id`,
      );
    }
    const nativeKey = recoveryNativeKey(identity, nativeId);
    // Atomic check+set for the cross-alias native key (no await between).
    if (recoveries.has(nativeKey)) {
      throw new Error(
        `a native model restore is already in progress for session "${session.transportSession}"; retry once it finishes`,
      );
    }
    recoveries.set(nativeKey, { nativeId });
    let known = knownNativeIds.get(identity);
    if (!known) {
      known = new Set();
      knownNativeIds.set(identity, known);
    }
    known.add(nativeId);
    try {
      const assertAbsent = deps.queueOwnerAbsence?.assertAcpxQueueOwnerAbsent ?? assertAcpxQueueOwnerAbsent;
      try {
        await assertAbsent(record.acpxRecordId);
      } catch (error) {
        throw new Error(
          `cannot restore model "${restoreModelId}" for session "${session.transportSession}": ${error instanceof Error ? error.message : String(error)}; free the queue owner (or let it idle out) and retry the model change`,
          { cause: error },
        );
      }
      const recover = deps.ompModelRecovery?.recoverOmpSessionModel ?? recoverOmpSessionModel;
      try {
        await recover({
          command: launch.command,
          args: launch.args,
          cwd: session.cwd,
          agentSessionId: nativeId,
          modelId,
          env: deps.envForModel(),
          timeoutMs: remainingTimeoutMs(),
        });
      } catch (nativeError) {
        throw new Error(
          `native model restore for session "${session.transportSession}" (model "${modelId}") did not finish: ${nativeError instanceof Error ? nativeError.message : String(nativeError)}; retry the model change to reconcile the saved selection`,
          { cause: nativeError },
        );
      }
      // Sync: the ordinary setter under the chosen model (same wire as before).
      try {
        await deps.runSetModel(modelId, {
          timeoutMs: remainingTimeoutMs(),
          env: deps.envForModel(modelId),
          deadlineAt,
        });
      } catch (syncError) {
        throw new Error(
          `native model "${modelId}" was restored for session "${session.transportSession}" but acpx synchronization failed: ${syncError instanceof Error ? syncError.message : String(syncError)}; retry the model change to re-sync`,
          { cause: syncError },
        );
      }
    } finally {
      recoveries.delete(nativeKey);
    }
  } finally {
    recoveries.delete(sessionKey);
  }
}
