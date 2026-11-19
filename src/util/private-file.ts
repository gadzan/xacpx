import { chmod, mkdir, writeFile } from "node:fs/promises";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import * as lockfile from "proper-lockfile";
import writeFileAtomic from "write-file-atomic";

const PRIVATE_FILE_MODE = 0o600;
const WRITE_RETRY_MAX_ATTEMPTS = 20;
const WRITE_RETRY_BASE_DELAY_MS = 50;
const WRITE_RETRY_MAX_DELAY_MS = 500;
const LOCKFILE_STALE_MS = 10_000;

/**
 * Runs `fn` while holding the file's proper-lockfile lock, so a caller can make
 * a whole read→modify→write span atomic with respect to other xacpx-aware
 * processes (writePrivateFileAtomic alone only serializes the write).
 *
 * proper-lockfile is NOT reentrant: inside `fn`, write through the provided
 * `writeLocked` (same atomic semantics, no re-lock) — never call
 * writePrivateFileAtomic on the same path or it will deadlock until the lock
 * goes stale. `realpath: false` keeps locking working for a not-yet-existing
 * target file (the lock lives at `<path>.lock`).
 */
export async function withPrivateFileLock<T>(
  path: string,
  fn: (writeLocked: (content: string) => Promise<void>) => Promise<T>,
): Promise<T> {
  await mkdir(dirname(path), { recursive: true });

  const release = await lockfile.lock(path, {
    realpath: false,
    stale: LOCKFILE_STALE_MS,
    retries: {
      retries: WRITE_RETRY_MAX_ATTEMPTS,
      factor: 1.5,
      minTimeout: WRITE_RETRY_BASE_DELAY_MS,
      maxTimeout: WRITE_RETRY_MAX_DELAY_MS,
      randomize: true,
    },
  });

  try {
    return await fn((content) => writePrivateFileAtomicUnlocked(path, content));
  } finally {
    await release();
  }
}

export async function writePrivateFileAtomic(path: string, content: string): Promise<void> {
  await withPrivateFileLock(path, async (writeLocked) => {
    await writeLocked(content);
  });
}

async function writePrivateFileAtomicUnlocked(path: string, content: string): Promise<void> {
  try {
    await retryTransientFileErrors(
      async () =>
        writeFileAtomic(path, content, {
          mode: PRIVATE_FILE_MODE,
          encoding: "utf8",
          fsync: true,
        }),
    );
  } catch (error) {
    if (!isTransientWriteError(error, process.platform)) {
      throw error;
    }
    // Last-ditch Windows fallback: rename is exhausted (e.g. AV holds the
    // target without FILE_SHARE_DELETE). Direct overwrite sacrifices
    // atomicity but stays within FILE_SHARE_WRITE-friendly territory and
    // is preferable to losing the write entirely. We still hold the
    // proper-lockfile, so xacpx-aware processes are excluded.
    await writeFile(path, content, { encoding: "utf8", mode: PRIVATE_FILE_MODE });
    await chmod(path, PRIVATE_FILE_MODE).catch(() => {});
  }
}

/**
 * Synchronous private-file write for hot-path callers that cannot await
 * (e.g. per-message weixin credential/sync-buf/context-token persistence).
 * Atomic via write-file-atomic's temp+rename, created at 0600 so the secret is
 * never momentarily world-readable. No cross-process lock: weixin's per-account
 * consumer lock already serializes the single writing daemon.
 */
interface WritePrivateFileSyncDeps {
  platform?: NodeJS.Platform;
  atomicWrite?: (path: string, content: string) => void;
  directWrite?: (path: string, content: string) => void;
}

export function writePrivateFileSync(
  path: string,
  content: string,
  deps: WritePrivateFileSyncDeps = {},
): void {
  mkdirSync(dirname(path), { recursive: true });
  const platform = deps.platform ?? process.platform;
  const atomicWrite =
    deps.atomicWrite ??
    ((p, c) => writeFileAtomic.sync(p, c, { mode: PRIVATE_FILE_MODE, encoding: "utf8", fsync: true }));

  try {
    atomicWrite(path, content);
  } catch (error) {
    if (!isTransientWriteError(error, platform)) {
      throw error;
    }
    // Windows last-ditch: AV/locking can hold the temp file and break the
    // rename. Direct overwrite sacrifices atomicity but preserves the write,
    // mirroring writePrivateFileAtomic's async fallback.
    const directWrite =
      deps.directWrite ??
      ((p, c) => {
        writeFileSync(p, c, { encoding: "utf8", mode: PRIVATE_FILE_MODE });
        try {
          chmodSync(p, PRIVATE_FILE_MODE);
        } catch {
          /* best-effort */
        }
      });
    directWrite(path, content);
  }
}

interface RetryTransientWriteOptions {
  platform?: NodeJS.Platform;
  maxAttempts?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  delay?: (ms: number) => Promise<void>;
}

export async function retryTransientFileErrors<T>(
  run: () => Promise<T>,
  options: RetryTransientWriteOptions = {},
): Promise<T> {
  const platform = options.platform ?? process.platform;
  const maxAttempts = options.maxAttempts ?? WRITE_RETRY_MAX_ATTEMPTS;
  const baseDelayMs = options.baseDelayMs ?? WRITE_RETRY_BASE_DELAY_MS;
  const maxDelayMs = options.maxDelayMs ?? WRITE_RETRY_MAX_DELAY_MS;
  const wait = options.delay ?? defaultDelay;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await run();
    } catch (error) {
      if (!isTransientWriteError(error, platform) || attempt === maxAttempts) {
        throw error;
      }
      await wait(Math.min(baseDelayMs * attempt, maxDelayMs));
    }
  }
  // Unreachable.
  throw new Error("retryTransientFileErrors exhausted without result");
}

function isTransientWriteError(error: unknown, platform: NodeJS.Platform): boolean {
  if (platform !== "win32") return false;
  if (!error || typeof error !== "object") return false;
  const code = (error as { code?: unknown }).code;
  if (typeof code !== "string") return false;
  return code === "EPERM" || code === "EBUSY" || code === "EACCES";
}

async function defaultDelay(ms: number): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, ms));
}

export const __privateFileForTests = {
  retryTransientFileErrors,
};
