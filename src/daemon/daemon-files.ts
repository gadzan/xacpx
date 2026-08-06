import { dirname, join } from "node:path";

import { coreHomeDir } from "../runtime/core-home";
import { resolveOrchestrationEndpoint } from "../orchestration/orchestration-ipc";

export const RUNTIME_CONSUMER_LOCK_FILE = "runtime-consumer.lock.json";

export interface DaemonPaths {
  runtimeDir: string;
  pidFile: string;
  statusFile: string;
  stdoutLog: string;
  stderrLog: string;
  appLog: string;
}

interface ResolveDaemonPathsOptions {
  home: string;
  runtimeDir?: string;
  configPath?: string;
}

export function resolveDaemonPaths(options: ResolveDaemonPathsOptions): DaemonPaths {
  const runtimeDir = options.runtimeDir ?? (options.configPath ? resolveRuntimeDirFromConfigPath(options.configPath) : join(coreHomeDir(options.home), "runtime"));

  return {
    runtimeDir,
    pidFile: join(runtimeDir, "daemon.pid"),
    statusFile: join(runtimeDir, "status.json"),
    stdoutLog: join(runtimeDir, "stdout.log"),
    stderrLog: join(runtimeDir, "stderr.log"),
    appLog: join(runtimeDir, "app.log"),
  };
}

export function resolveRuntimeDirFromConfigPath(configPath: string): string {
  return join(dirname(configPath), "runtime");
}

/** Stable metadata path for the OS-held, channel-independent runtime lock. */
export function resolveRuntimeConsumerLockPath(runtimeDir: string): string {
  return join(runtimeDir, RUNTIME_CONSUMER_LOCK_FILE);
}

export function resolveDaemonOrchestrationSocketPath(
  runtimeDir: string,
  platform: NodeJS.Platform = process.platform,
): string {
  return resolveOrchestrationEndpoint(runtimeDir, platform).path;
}

/**
 * Liveness probe via signal 0: returns true when the pid can be signalled.
 * EPERM also reads as ALIVE — it means the signal was denied but the process
 * exists (typically owned by another user). Doctor uses this to gate
 * state-mutating repairs, where the unsafe direction is reporting a live
 * process as dead; only a definitive "no such process" (ESRCH) reads as dead.
 */
export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}
