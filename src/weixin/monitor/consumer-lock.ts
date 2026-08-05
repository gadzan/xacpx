import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { homedir } from "node:os";

import { coreHomeDir } from "../../runtime/core-home";
import { acquireIpcGuard, IpcGuardBusyError } from "../../process/ipc-guard";

export interface WeixinConsumerLockMetadata {
  pid: number;
  mode: "foreground" | "daemon";
  startedAt: string;
  configPath: string;
  statePath: string;
  hostname?: string;
  schemaVersion?: 2;
  lockId?: string;
  processCreationDate?: string | null;
}

export interface WeixinConsumerLock {
  acquire: (meta: WeixinConsumerLockMetadata) => Promise<void>;
  release: () => Promise<void>;
}

export class ActiveWeixinConsumerLockError extends Error {
  readonly existing: WeixinConsumerLockMetadata;
  readonly lockFilePath: string;

  constructor(lockFilePath: string, existing: WeixinConsumerLockMetadata) {
    super(
      [
        "xacpx Weixin consumer is already running.",
        `pid: ${existing.pid}`,
        `mode: ${existing.mode}`,
        `config: ${existing.configPath}`,
        `state: ${existing.statePath}`,
        "Try stopping the existing instance or close the foreground `xacpx run` process before starting a new one.",
      ].join("\n"),
    );
    this.name = "ActiveWeixinConsumerLockError";
    this.lockFilePath = lockFilePath;
    this.existing = existing;
  }
}

interface CreateWeixinConsumerLockOptions {
  lockFilePath?: string;
  isProcessRunning?: (pid: number) => boolean;
  platform?: NodeJS.Platform;
  acquireGuard?: typeof acquireIpcGuard;
  onDiagnostic?: (
    event:
      | "lock_exists"
      | "lock_invalid_removed"
      | "lock_stale_removed"
      | "lock_active_conflict"
      | "lock_acquired"
      | "lock_released",
    context: Record<string, string | number | boolean | undefined>,
  ) => void | Promise<void>;
}

export function createWeixinConsumerLock(
  options: CreateWeixinConsumerLockOptions = {},
): WeixinConsumerLock {
  const lockFilePath = options.lockFilePath ?? join(coreHomeDir(homedir()), "runtime", "weixin-consumer.lock.json");
  const isProcessRunning = options.isProcessRunning ?? defaultIsProcessRunning;
  const onDiagnostic = options.onDiagnostic;
  const platform = options.platform ?? process.platform;
  let windowsGuard: Awaited<ReturnType<typeof acquireIpcGuard>> | undefined;
  let windowsLockId: string | undefined;

  return {
    async acquire(meta) {
      await mkdir(dirname(lockFilePath), { recursive: true, mode: 0o700 });

      if (platform === "win32") {
        try {
          windowsGuard = await (options.acquireGuard ?? acquireIpcGuard)(
            { role: "consumer", configRoot: dirname(meta.configPath) },
            { platform },
          );
        } catch (error) {
          if (!(error instanceof IpcGuardBusyError)) throw error;
          const existing = await loadLockMetadata(lockFilePath) ?? meta;
          throw new ActiveWeixinConsumerLockError(lockFilePath, existing);
        }
        windowsLockId = meta.lockId ?? randomUUID();
        const metadata: WeixinConsumerLockMetadata = {
          ...meta,
          schemaVersion: 2,
          lockId: windowsLockId,
          processCreationDate: meta.processCreationDate ?? null,
        };
        try {
          await writeFile(lockFilePath, `${JSON.stringify(metadata, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
        } catch (error) {
          await windowsGuard.release().catch(() => {});
          windowsGuard = undefined;
          windowsLockId = undefined;
          throw error;
        }
        await onDiagnostic?.("lock_acquired", { lockFilePath, pid: meta.pid, mode: meta.mode });
        return;
      }

      while (true) {
        try {
          const handle = await open(lockFilePath, "wx");
          try {
            await handle.writeFile(`${JSON.stringify(meta, null, 2)}\n`, "utf8");
          } finally {
            await handle.close();
          }
          await onDiagnostic?.("lock_acquired", {
            lockFilePath,
            pid: meta.pid,
            mode: meta.mode,
            configPath: meta.configPath,
            statePath: meta.statePath,
            hostname: meta.hostname,
          });
          return;
        } catch (error) {
          const code = (error as NodeJS.ErrnoException).code;
          if (code !== "EEXIST") {
            throw error;
          }

          await onDiagnostic?.("lock_exists", {
            lockFilePath,
            pid: meta.pid,
            mode: meta.mode,
          });

          const existing = await loadLockMetadata(lockFilePath);
          if (!existing) {
            await rm(lockFilePath, { force: true });
            await onDiagnostic?.("lock_invalid_removed", {
              lockFilePath,
              reason: "invalid_or_unreadable_metadata",
            });
            continue;
          }

          if (!isProcessRunning(existing.pid)) {
            await rm(lockFilePath, { force: true });
            await onDiagnostic?.("lock_stale_removed", {
              lockFilePath,
              stalePid: existing.pid,
              staleMode: existing.mode,
              staleConfigPath: existing.configPath,
              staleStatePath: existing.statePath,
              reason: "owner_process_not_running",
            });
            continue;
          }

          await onDiagnostic?.("lock_active_conflict", {
            lockFilePath,
            activePid: existing.pid,
            activeMode: existing.mode,
            activeConfigPath: existing.configPath,
            activeStatePath: existing.statePath,
            requestedPid: meta.pid,
            requestedMode: meta.mode,
          });
          throw new ActiveWeixinConsumerLockError(lockFilePath, existing);
        }
      }
    },
    async release() {
      if (platform === "win32") {
        const metadata = await loadLockMetadata(lockFilePath);
        if (metadata?.lockId === windowsLockId) await rm(lockFilePath, { force: true });
        await windowsGuard?.release();
        windowsGuard = undefined;
        windowsLockId = undefined;
        await onDiagnostic?.("lock_released", { lockFilePath });
        return;
      }
      await rm(lockFilePath, { force: true });
      await onDiagnostic?.("lock_released", {
        lockFilePath,
      });
    },
  };
}

async function loadLockMetadata(path: string): Promise<WeixinConsumerLockMetadata | null> {
  try {
    const raw = await readFile(path, "utf8");
    const parsed = JSON.parse(raw) as Partial<WeixinConsumerLockMetadata>;
    if (!parsed || typeof parsed.pid !== "number" || !parsed.mode || !parsed.configPath || !parsed.statePath) {
      return null;
    }
    return parsed as WeixinConsumerLockMetadata;
  } catch {
    return null;
  }
}

function defaultIsProcessRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
