import { readdir, readFile, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import { join } from "node:path";

import { createDaemonController } from "../../daemon/create-daemon-controller";
import {
  isProcessAlive,
  RUNTIME_CONSUMER_LOCK_FILE,
  resolveDaemonPaths,
  resolveRuntimeDirFromConfigPath,
  type DaemonPaths,
} from "../../daemon/daemon-files";
import type { DoctorCheckResult, DoctorFix } from "../doctor-types";

/**
 * Consumer lock files are named "<channel-id>-consumer.lock.json" (see cli.ts:
 * the first registered channel's id is the prefix). Match channel-agnostically
 * so a Feishu-first install ("feishu-consumer.lock.json") is covered, not just
 * Weixin.
 */
const CONSUMER_LOCK_SUFFIX = "-consumer.lock.json";

export interface DaemonCheckOptions {
  home?: string;
  resolveDaemonPaths?: (options: { home: string; runtimeDir?: string }) => DaemonPaths;
  configPath?: string;
  isProcessRunning?: (pid: number) => boolean;
  processExecPath?: string;
  cliEntryPath?: string;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  /** Injected so stale-lock detection never reads the real filesystem in tests. */
  listConsumerLocks?: (runtimeDir: string) => Promise<string[]>;
  /** Injected so stale-lock detection never reads the real filesystem in tests. */
  readConsumerLock?: (path: string) => Promise<{ pid: number } | null>;
  /** Injected so the attached repair never touches the real filesystem in tests. */
  removeConsumerLock?: (path: string) => Promise<void>;
}

export async function checkDaemon(options: DaemonCheckOptions = {}): Promise<DoctorCheckResult> {
  const home = options.home ?? process.env.HOME ?? homedir();
  const runtimeDir = options.configPath ? resolveRuntimeDirFromConfigPath(options.configPath) : undefined;
  const paths = (options.resolveDaemonPaths ?? resolveDaemonPaths)({
    home,
    ...(runtimeDir ? { runtimeDir } : {}),
  });
  const isProcessRunning = options.isProcessRunning ?? isProcessAlive;
  const listConsumerLocks = options.listConsumerLocks ?? defaultListConsumerLocks;
  const readConsumerLock = options.readConsumerLock ?? defaultReadConsumerLock;
  const removeConsumerLock = options.removeConsumerLock ?? defaultRemoveConsumerLock;
  const controller = createDaemonController(paths, {
    processExecPath: options.processExecPath ?? process.execPath,
    cliEntryPath: options.cliEntryPath ?? resolveCliEntryPath(),
    cwd: options.cwd ?? process.cwd(),
    env: options.env ?? process.env,
    isProcessRunning,
  });

  try {
    const status = await controller.getStatus();
    // A stale consumer lock can only be safely cleared when there is genuinely
    // no live daemon. Only "stopped" qualifies: "running" obviously owns the
    // lock, and "indeterminate" is also a LIVE pid (getStatus reports it only
    // after confirming the daemon process is alive but status.json is missing),
    // so removing the lock there would race a live daemon.
    const staleLockFix =
      status.state === "stopped"
        ? await detectStaleConsumerLockFix(paths.runtimeDir, {
            isProcessRunning,
            listConsumerLocks,
            readConsumerLock,
            removeConsumerLock,
          })
        : undefined;
    switch (status.state) {
      case "running":
        return {
          id: "daemon",
          label: "Daemon",
          severity: "pass",
          summary: "daemon is running",
          details: [`pid: ${status.pid}`],
          metadata: {
            paths,
            status,
          },
        };
      case "stopped":
        return {
          id: "daemon",
          label: "Daemon",
          severity: "warn",
          summary: status.stale ? "daemon was stopped and stale runtime files were cleared" : "daemon is not running",
          details: status.stale ? ["stale runtime files were cleared"] : undefined,
          suggestions: ["run: xacpx start"],
          ...(staleLockFix ? { fixes: [staleLockFix] } : {}),
          metadata: {
            paths,
            status,
          },
        };
      case "indeterminate":
        // indeterminate = a LIVE daemon pid (status.json missing). Never offer
        // a lock removal here; it would race the live daemon.
        return {
          id: "daemon",
          label: "Daemon",
          severity: "fail",
          summary: "daemon status is indeterminate",
          details: [`pid: ${status.pid}`, `reason: ${status.reason}`],
          metadata: {
            paths,
            status,
          },
        };
    }

    return {
      id: "daemon",
      label: "Daemon",
      severity: "fail",
      summary: "daemon status lookup returned an unknown state",
      details: [`state: ${(status as { state?: string }).state ?? "unknown"}`],
      metadata: {
        paths,
      },
    };
  } catch (error) {
    return {
      id: "daemon",
      label: "Daemon",
      severity: "fail",
      summary: "daemon status could not be read",
      details: [
        `runtime dir: ${paths.runtimeDir}`,
        `pid file: ${paths.pidFile}`,
        `status file: ${paths.statusFile}`,
        `error: ${formatError(error)}`,
      ],
      metadata: {
        paths,
      },
    };
  }
}

interface StaleConsumerLockDeps {
  isProcessRunning: (pid: number) => boolean;
  listConsumerLocks: (runtimeDir: string) => Promise<string[]>;
  readConsumerLock: (path: string) => Promise<{ pid: number } | null>;
  removeConsumerLock: (path: string) => Promise<void>;
}

/**
 * Detect STALE consumer locks: any "<channel>-consumer.lock.json" in the
 * runtime dir whose recorded pid is definitively NOT running. Conservative —
 * a missing dir, no matching files, unreadable locks, or live-pid locks all
 * yield no fix. When at least one stale lock exists, returns a repair whose
 * run() removes every stale lock found (and only those) and names them.
 * run() re-verifies each lock is still readable-and-stale before removing it:
 * a daemon may have started (rewriting a lock with a live pid) between the
 * read-only detection pass and --fix applying the repair.
 */
async function detectStaleConsumerLockFix(
  runtimeDir: string,
  deps: StaleConsumerLockDeps,
): Promise<DoctorFix | undefined> {
  const lockFiles = await deps.listConsumerLocks(runtimeDir);
  const stalePaths: string[] = [];
  for (const fileName of lockFiles) {
    // The core runtime file is stable metadata for an OS-held lock. Deleting
    // its pathname can split future flock contenders onto a different inode.
    if (fileName === RUNTIME_CONSUMER_LOCK_FILE || !fileName.endsWith(CONSUMER_LOCK_SUFFIX)) {
      continue;
    }
    const lockPath = join(runtimeDir, fileName);
    const lock = await deps.readConsumerLock(lockPath);
    if (lock && !deps.isProcessRunning(lock.pid)) {
      stalePaths.push(lockPath);
    }
  }

  if (stalePaths.length === 0) {
    return undefined;
  }

  return {
    id: "daemon.clear-stale-lock",
    title: "remove stale consumer lock(s)",
    run: async () => {
      const removed: string[] = [];
      let skipped = 0;
      for (const lockPath of stalePaths) {
        const lock = await deps.readConsumerLock(lockPath);
        if (!lock || deps.isProcessRunning(lock.pid)) {
          skipped += 1;
          continue;
        }
        await deps.removeConsumerLock(lockPath);
        removed.push(lockPath);
      }
      const skippedNote = skipped > 0 ? `; left ${skipped} no-longer-stale lock(s) alone` : "";
      return {
        ok: true,
        message:
          removed.length > 0
            ? `removed ${removed.length} stale consumer lock(s): ${removed.join(", ")}${skippedNote}`
            : `no locks removed${skippedNote}`,
      };
    },
  };
}

async function defaultListConsumerLocks(runtimeDir: string): Promise<string[]> {
  try {
    return await readdir(runtimeDir);
  } catch {
    // Missing/unreadable runtime dir => nothing to scan.
    return [];
  }
}

async function defaultReadConsumerLock(path: string): Promise<{ pid: number } | null> {
  try {
    const raw = await readFile(path, "utf8");
    const parsed = JSON.parse(raw) as { pid?: unknown };
    return typeof parsed.pid === "number" ? { pid: parsed.pid } : null;
  } catch {
    return null;
  }
}

async function defaultRemoveConsumerLock(path: string): Promise<void> {
  await rm(path, { force: true });
}

function resolveCliEntryPath(): string {
  return process.argv[1] ?? fileURLToPath(import.meta.url);
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
