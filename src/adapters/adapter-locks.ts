import { createRequire } from "node:module";
import { open, mkdir } from "node:fs/promises";
import { join } from "node:path";

import { acquireIpcGuard } from "../process/ipc-guard";

const require = createRequire(import.meta.url);

interface FsExt {
  flock(fd: number, operation: "exnb" | "un", callback: (error?: NodeJS.ErrnoException | null) => void): void;
}

export interface AdapterOperationLockOptions {
  id: string;
  runtimeRoot: string;
  platform?: NodeJS.Platform;
}

export class AdapterOpLockBusyError extends Error {
  readonly code = "ADAPTER_OP_LOCK_BUSY";

  constructor(readonly id: string, options?: ErrorOptions) {
    super(`Adapter operation is already running for ${id}`, options);
    this.name = "AdapterOpLockBusyError";
  }
}

function flock(fsExt: FsExt, fd: number, operation: "exnb" | "un"): Promise<void> {
  return new Promise((resolve, reject) => {
    fsExt.flock(fd, operation, (error) => error ? reject(error) : resolve());
  });
}

function isBusy(error: unknown): boolean {
  const code = error instanceof Error ? (error as NodeJS.ErrnoException).code : undefined;
  return code === "EAGAIN" || code === "EWOULDBLOCK";
}

export async function withAdapterOperationLock<T>(
  options: AdapterOperationLockOptions,
  callback: () => Promise<T>,
): Promise<T> {
  const platform = options.platform ?? process.platform;
  if (platform === "win32") {
    const guard = await acquireIpcGuard({
      role: "adapter-op",
      resourceId: options.id,
      configRoot: options.runtimeRoot,
    });
    try {
      return await callback();
    } finally {
      await guard.release();
    }
  }

  // Loading the Unix-only native binding lazily keeps Windows installation and
  // startup independent of fs-ext. The optional dependency is mandatory here:
  // absence is a hard failure, never a fallback to an existence/PID lock.
  const fsExt = require("fs-ext") as FsExt;
  const lockDirectory = join(options.runtimeRoot, "adapters", ".locks");
  await mkdir(lockDirectory, { recursive: true });
  const lockPath = join(lockDirectory, `adapter-op-${options.id}.lock`);
  const handle = await open(lockPath, "a+", 0o644);
  try {
    try {
      await flock(fsExt, handle.fd, "exnb");
    } catch (error) {
      if (isBusy(error)) throw new AdapterOpLockBusyError(options.id, { cause: error });
      throw error;
    }
    try {
      return await callback();
    } finally {
      await flock(fsExt, handle.fd, "un");
    }
  } finally {
    await handle.close();
  }
}
