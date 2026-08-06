import { readFile, readdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import type { DaemonStatus } from "./daemon-status";
import type { PosixProcessIdentityProbe } from "../process/posix-process-identity";

const CONSUMER_LOCK_SUFFIX = "-consumer.lock.json";
const MAX_LOCK_TO_STATUS_SKEW_MS = 5_000;

interface ConsumerLockMetadata {
  pid: number;
  mode: "foreground" | "daemon";
  startedAt: string;
  configPath: string;
  statePath: string;
}

export interface VerifiedPosixDaemonIdentity {
  pid: number;
  startedAtMs: number;
}

export async function verifyPosixStatusOnlyDaemon(input: {
  status: DaemonStatus;
  runtimeDir: string;
  configRoot: string;
  now: number;
  startupTimeoutMs: number;
  maxHeartbeatAgeMs: number;
  maxFutureHeartbeatMs: number;
  probeIdentity: (pid: number) => Promise<PosixProcessIdentityProbe>;
}): Promise<VerifiedPosixDaemonIdentity | null> {
  const { status } = input;
  if (!Number.isSafeInteger(status.pid) || status.pid <= 0) return null;
  if (!samePath(dirname(status.config_path), input.configRoot)) return null;

  const startedAt = Date.parse(status.started_at);
  const heartbeatAt = Date.parse(status.heartbeat_at);
  if (!Number.isFinite(startedAt) || !Number.isFinite(heartbeatAt)
    || startedAt > heartbeatAt
    || heartbeatAt > input.now + input.maxFutureHeartbeatMs
    || input.now - heartbeatAt > input.maxHeartbeatAgeMs) return null;

  const probe = await input.probeIdentity(status.pid);
  if (probe.status !== "found" || probe.identity.pid !== status.pid) return null;
  const processStartedAt = probe.identity.startedAtMs;
  if (!Number.isSafeInteger(processStartedAt)
    || processStartedAt > startedAt
    || startedAt - processStartedAt > input.startupTimeoutMs) return null;

  const locks = await loadConsumerLocks(input.runtimeDir);
  const matchingLock = locks.some((lock) => {
    const lockStartedAt = Date.parse(lock.startedAt);
    return lock.pid === status.pid
      && lock.mode === "daemon"
      && samePath(lock.configPath, status.config_path)
      && samePath(lock.statePath, status.state_path)
      && Number.isFinite(lockStartedAt)
      && processStartedAt <= lockStartedAt
      && lockStartedAt - processStartedAt <= input.startupTimeoutMs
      && lockStartedAt <= startedAt + MAX_LOCK_TO_STATUS_SKEW_MS
      && startedAt - lockStartedAt <= input.startupTimeoutMs;
  });
  return matchingLock ? { pid: status.pid, startedAtMs: processStartedAt } : null;
}

async function loadConsumerLocks(runtimeDir: string): Promise<ConsumerLockMetadata[]> {
  try {
    const names = (await readdir(runtimeDir)).filter((name) => name.endsWith(CONSUMER_LOCK_SUFFIX));
    const locks = await Promise.all(names.map(async (name) => {
      try {
        const value = JSON.parse(await readFile(resolve(runtimeDir, name), "utf8")) as Record<string, unknown>;
        if (!Number.isSafeInteger(value.pid) || Number(value.pid) <= 0
          || (value.mode !== "foreground" && value.mode !== "daemon")
          || typeof value.startedAt !== "string"
          || typeof value.configPath !== "string"
          || typeof value.statePath !== "string") return null;
        return value as unknown as ConsumerLockMetadata;
      } catch {
        return null;
      }
    }));
    return locks.filter((lock): lock is ConsumerLockMetadata => lock !== null);
  } catch {
    return [];
  }
}

function samePath(left: string, right: string): boolean {
  return resolve(left) === resolve(right);
}
