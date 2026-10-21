import { open, readFile } from "node:fs/promises";
import { dirname } from "node:path";

import {
  ActiveConsumerLockError,
  type ConsumerLock,
  type ConsumerLockMetadata,
} from "../channels/types";
import {
  acquireFileLock,
  FileLockBusyError,
  type AcquireFileLockOptions,
  type FileLock,
} from "../process/file-lock";

interface CreateRuntimeConsumerLockOptions extends AcquireFileLockOptions {
  lockFilePath: string;
  /** Compatibility fences for every channel that owns an external consumer. */
  channelLocks?: ConsumerLock[];
  createCoreLock?: () => ConsumerLock;
}

export class ActiveRuntimeConsumerLockError extends ActiveConsumerLockError {
  constructor(lockFilePath: string, existing: ConsumerLockMetadata) {
    super(
      [
        "xacpx runtime is already running.",
        `pid: ${existing.pid}`,
        `mode: ${existing.mode}`,
        `config: ${existing.configPath}`,
        `state: ${existing.statePath}`,
      ].join("\n"),
      lockFilePath,
      existing,
    );
    this.name = "ActiveRuntimeConsumerLockError";
  }
}

/**
 * Every console instance owns this core lock regardless of configured channels.
 * POSIX uses a kernel-held flock that is released by process exit; Windows uses
 * the existing named-pipe guard. The JSON file is stable diagnostic metadata,
 * never an existence/PID mutex and never removed as stale state.
 *
 * A channel lock is acquired second as a compatibility fence so a new runtime
 * also conflicts with daemons started before the core lock existed. Every
 * lock-capable channel contributes one fence, acquired sequentially in the
 * order the caller supplied: a deterministic order is what makes a partial
 * failure rollbackable, and `Promise.all` would lose which fences were taken.
 */
export function createRuntimeConsumerLock(options: CreateRuntimeConsumerLockOptions): ConsumerLock {
  const coreLock = (options.createCoreLock ?? (() => createCoreRuntimeLock(options)))();
  const channelLocks = options.channelLocks ?? [];
  let coreAcquired = false;
  let acquiredChannelLocks: ConsumerLock[] = [];

  return {
    async acquire(metadata: ConsumerLockMetadata): Promise<void> {
      await coreLock.acquire(metadata);
      coreAcquired = true;
      try {
        for (const lock of channelLocks) {
          await lock.acquire(metadata);
          acquiredChannelLocks.push(lock);
        }
      } catch (error) {
        const held = acquiredChannelLocks;
        acquiredChannelLocks = [];
        for (const lock of held.reverse()) {
          await lock.release().catch(() => {});
        }
        await coreLock.release().catch(() => {});
        coreAcquired = false;
        throw error;
      }
    },

    async release(): Promise<void> {
      let releaseError: unknown;
      const held = acquiredChannelLocks;
      acquiredChannelLocks = [];
      for (const lock of held.reverse()) {
        try { await lock.release(); }
        catch (error) { releaseError ??= error; }
      }
      if (coreAcquired) {
        try { await coreLock.release(); }
        catch (error) { releaseError ??= error; }
        coreAcquired = false;
      }
      if (releaseError) throw releaseError;
    },
  };
}

function createCoreRuntimeLock(options: CreateRuntimeConsumerLockOptions): ConsumerLock {
  const onDiagnostic = options.onDiagnostic;
  let fileLock: FileLock | undefined;

  return {
    async acquire(metadata): Promise<void> {
      try {
        fileLock = await acquireFileLock(options.lockFilePath, {
          ...options,
          ipcGuardKey: { role: "runtime-owner", configRoot: dirname(metadata.configPath) },
        });
      } catch (error) {
        if (!(error instanceof FileLockBusyError)) throw error;
        const existing = await loadMetadata(options.lockFilePath) ?? metadata;
        await emitDiagnostic(onDiagnostic, "lock_active_conflict", conflictContext(options.lockFilePath, metadata, existing));
        throw new ActiveRuntimeConsumerLockError(options.lockFilePath, existing);
      }

      try {
        const metadataHandle = await open(options.lockFilePath, "r+");
        try {
          await metadataHandle.truncate(0);
          await metadataHandle.writeFile(`${JSON.stringify(metadata, null, 2)}\n`, "utf8");
          await metadataHandle.sync();
        } finally {
          await metadataHandle.close();
        }
      } catch (error) {
        await fileLock.release().catch(() => {});
        fileLock = undefined;
        throw error;
      }
      await emitDiagnostic(onDiagnostic, "lock_acquired", acquiredContext(options.lockFilePath, metadata));
    },

    async release(): Promise<void> {
      const held = fileLock;
      fileLock = undefined;
      await held?.release();
      await emitDiagnostic(onDiagnostic, "lock_released", { lockFilePath: options.lockFilePath });
    },
  };
}

async function emitDiagnostic(
  callback: CreateRuntimeConsumerLockOptions["onDiagnostic"],
  event: string,
  context: Record<string, string | number | boolean | undefined>,
): Promise<void> {
  try {
    await callback?.(event, context);
  } catch {
    // Diagnostics must never acquire, lose, or mask runtime ownership.
  }
}

async function loadMetadata(path: string): Promise<ConsumerLockMetadata | null> {
  try {
    const parsed = JSON.parse(await readFile(path, "utf8")) as Partial<ConsumerLockMetadata>;
    if (!Number.isSafeInteger(parsed.pid) || Number(parsed.pid) <= 0
      || (parsed.mode !== "foreground" && parsed.mode !== "daemon")
      || typeof parsed.startedAt !== "string"
      || typeof parsed.configPath !== "string"
      || typeof parsed.statePath !== "string") return null;
    return parsed as ConsumerLockMetadata;
  } catch {
    return null;
  }
}

function acquiredContext(lockFilePath: string, metadata: ConsumerLockMetadata) {
  return {
    lockFilePath,
    pid: metadata.pid,
    mode: metadata.mode,
    configPath: metadata.configPath,
    statePath: metadata.statePath,
    hostname: metadata.hostname,
  };
}

function conflictContext(
  lockFilePath: string,
  requested: ConsumerLockMetadata,
  existing: ConsumerLockMetadata,
) {
  return {
    lockFilePath,
    activePid: existing.pid,
    activeMode: existing.mode,
    activeConfigPath: existing.configPath,
    activeStatePath: existing.statePath,
    requestedPid: requested.pid,
    requestedMode: requested.mode,
  };
}
