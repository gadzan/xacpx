import { join } from "node:path";

import type { ConsumerLock, ConsumerLockMetadata } from "../channels/types";
import { createWeixinConsumerLock } from "../weixin/monitor/consumer-lock";

interface CreateRuntimeConsumerLockOptions {
  runtimeDir: string;
  channelLock?: ConsumerLock;
  onDiagnostic?: (
    event: string,
    context: Record<string, string | number | boolean | undefined>,
  ) => void | Promise<void>;
  createCoreLock?: () => ConsumerLock;
}

/**
 * Every console instance owns this core lock regardless of configured channels.
 * A channel lock is acquired as a second, compatibility fence so a new runtime
 * also conflicts with daemons started before the core lock existed.
 */
export function createRuntimeConsumerLock(options: CreateRuntimeConsumerLockOptions): ConsumerLock {
  const coreLock = (options.createCoreLock ?? (() => createWeixinConsumerLock({
    lockFilePath: join(options.runtimeDir, "runtime-consumer.lock.json"),
    windowsGuardRole: "runtime-owner",
    activeLockError: (_lockFilePath, existing) => new Error(
      [
        "xacpx runtime is already running.",
        `pid: ${existing.pid}`,
        `mode: ${existing.mode}`,
        `config: ${existing.configPath}`,
        `state: ${existing.statePath}`,
      ].join("\n"),
    ),
    onDiagnostic: options.onDiagnostic,
  })))();
  let coreAcquired = false;
  let channelAcquired = false;

  return {
    async acquire(metadata: ConsumerLockMetadata): Promise<void> {
      await coreLock.acquire(metadata);
      coreAcquired = true;
      try {
        if (options.channelLock) {
          await options.channelLock.acquire(metadata);
          channelAcquired = true;
        }
      } catch (error) {
        await coreLock.release().catch(() => {});
        coreAcquired = false;
        throw error;
      }
    },

    async release(): Promise<void> {
      let releaseError: unknown;
      if (channelAcquired) {
        try { await options.channelLock!.release(); }
        catch (error) { releaseError = error; }
        channelAcquired = false;
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
