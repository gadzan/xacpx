import { createRequire } from "node:module";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdir, open, type FileHandle } from "node:fs/promises";
import { basename, dirname } from "node:path";

import { acquireIpcGuard, buildIpcGuardPipeName, IpcGuardBusyError, type IpcGuard, type IpcGuardKey } from "./ipc-guard";

const require = createRequire(import.meta.url);
const expectedHelperExits = new WeakSet<ChildProcessWithoutNullStreams>();
const LOCK_HELPER_RELEASE_TIMEOUT_MS = 5_000;

interface FsExt {
  flock(
    fd: number,
    operation: "exnb" | "un",
    callback: (error?: NodeJS.ErrnoException | null) => void,
  ): void;
}

export interface FileLock {
  release(): Promise<void>;
}

export interface AcquireFileLockOptions {
  platform?: NodeJS.Platform;
  acquireGuard?: typeof acquireIpcGuard;
  ipcGuardKey?: IpcGuardKey;
  loadFsExt?: () => FsExt;
  helperAcquireTimeoutMs?: number;
  helperHandshakeDelayMs?: number;
  onDiagnostic?: (
    event: string,
    context: Record<string, string | number | boolean | undefined>,
  ) => void | Promise<void>;
}

export class FileLockBusyError extends Error {
  readonly code = "FILE_LOCK_BUSY";

  constructor(readonly lockFilePath: string, options?: ErrorOptions) {
    super(`File lock is already held: ${lockFilePath}`, options);
    this.name = "FileLockBusyError";
  }
}

/** Holds a stable file's OS lock until release or process exit; never removes the file. */
export async function acquireFileLock(
  lockFilePath: string,
  options: AcquireFileLockOptions = {},
): Promise<FileLock> {
  const platform = options.platform ?? process.platform;
  await mkdir(dirname(lockFilePath), { recursive: true, mode: 0o700 });
  if (platform === "win32") {
    const key = options.ipcGuardKey ?? {
      role: "file-lock",
      configRoot: dirname(lockFilePath),
      resourceId: basename(lockFilePath).toLowerCase(),
    };
    const useHelper = isBunRuntime() && !options.acquireGuard;
    const pipeName = useHelper ? await buildIpcGuardPipeName(key, { platform }) : undefined;
    let guard: IpcGuard;
    try {
      if (useHelper) {
        const helper = await acquireLockHelper(
          lockFilePath,
          options.helperAcquireTimeoutMs,
          options.helperHandshakeDelayMs,
          options.onDiagnostic,
          pipeName,
        );
        guard = { release: () => releaseFileLock(options, undefined, helper) };
        await emitDiagnostic(options.onDiagnostic, "lock_helper_started", {
          lockFilePath,
          helperPid: helper.pid,
        });
      } else {
        guard = await (options.acquireGuard ?? acquireIpcGuard)(key, { platform });
      }
    } catch (error) {
      if (error instanceof IpcGuardBusyError || (useHelper && isBusy(error))) {
        throw new FileLockBusyError(lockFilePath, { cause: error });
      }
      throw error;
    }
    try {
      const handle = await open(lockFilePath, "a+", 0o600);
      try {
        await handle.chmod(0o600);
      } finally {
        await handle.close();
      }
    } catch (error) {
      await guard.release().catch(() => {});
      throw error;
    }
    let releasePromise: Promise<void> | undefined;
    return {
      release() {
        releasePromise ??= guard.release();
        return releasePromise;
      },
    };
  }

  // fs-ext is optional only for Windows installs. POSIX acquisition fails closed.
  const handle = await open(lockFilePath, "a+", 0o600);
  let posixHandle: FileHandle | undefined;
  let posixHelper: ChildProcessWithoutNullStreams | undefined;
  try {
    await handle.chmod(0o600);
    try {
      if (isBunRuntime() && !options.loadFsExt) {
        // Bun cannot load the Node ABI addon; Node holds flock for stdin's lifetime.
        await handle.close();
        posixHelper = await acquireLockHelper(
          lockFilePath,
          options.helperAcquireTimeoutMs,
          options.helperHandshakeDelayMs,
          options.onDiagnostic,
        );
        await emitDiagnostic(options.onDiagnostic, "lock_helper_started", {
          lockFilePath,
          helperPid: posixHelper.pid,
        });
      } else {
        const fsExt = options.loadFsExt?.() ?? require("fs-ext") as FsExt;
        await flock(fsExt, handle.fd, "exnb");
        posixHandle = handle;
      }
    } catch (error) {
      if (isBusy(error)) throw new FileLockBusyError(lockFilePath, { cause: error });
      throw error;
    }
  } catch (error) {
    await handle.close().catch(() => {});
    throw error;
  }

  let releasePromise: Promise<void> | undefined;
  return {
    release() {
      releasePromise ??= releaseFileLock(options, posixHandle, posixHelper);
      return releasePromise;
    },
  };
}

async function emitDiagnostic(
  callback: AcquireFileLockOptions["onDiagnostic"],
  event: string,
  context: Record<string, string | number | boolean | undefined>,
): Promise<void> {
  try {
    await callback?.(event, context);
  } catch {
    // Diagnostics must never acquire, lose, or mask ownership.
  }
}

async function releaseFileLock(
  options: AcquireFileLockOptions,
  handle: FileHandle | undefined,
  helper: ChildProcessWithoutNullStreams | undefined,
): Promise<void> {
  if (helper) {
    expectedHelperExits.add(helper);
    if (helper.exitCode !== null || helper.signalCode !== null) return;
    const closePromise = new Promise<void>((resolve, reject) => {
      let settled = false;
      let timedOut = false;
      let killWaitTimer: NodeJS.Timeout | undefined;
      const finish = (callback: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        clearTimeout(killWaitTimer);
        callback();
      };
      const timer = setTimeout(() => {
        timedOut = true;
        helper.kill("SIGKILL");
        killWaitTimer = setTimeout(() => {
          process.kill(process.pid, "SIGKILL");
        }, LOCK_HELPER_RELEASE_TIMEOUT_MS);
      }, LOCK_HELPER_RELEASE_TIMEOUT_MS);
      helper.once("error", (error) => {
        if (!timedOut) finish(() => reject(error));
      });
      helper.once("close", (code) => finish(() => timedOut
        ? reject(new Error("runtime lock helper did not release within 5000ms"))
        : code === 0
          ? resolve()
          : reject(new Error(`runtime lock helper exited with code ${code}`))));
    });
    helper.stdin.end();
    await closePromise;
    return;
  }
  if (!handle) return;
  const fsExt = options.loadFsExt?.() ?? require("fs-ext") as FsExt;
  try {
    await flock(fsExt, handle.fd, "un");
  } finally {
    await handle.close();
  }
}

function isBunRuntime(): boolean {
  return Boolean((globalThis as { Bun?: unknown }).Bun);
}

const LOCK_HELPER_SOURCE = String.raw`
const fs = require("node:fs");
const path = process.argv[2];
const handshakeDelayMs = Number(process.argv[3] || 0);
const pipeName = process.argv[4];
const reportError = (error, busy) => {
  process.stdout.write(busy ? "BUSY\n" : "ERROR:" + Buffer.from(String(error.stack || error)).toString("base64") + "\n");
  process.exitCode = busy ? 2 : 1;
};
const acquired = (releaseLock) => {
  // The daemon controller signals the whole POSIX process group during a
  // graceful stop. Once ownership is acquired, only the parent stdin lifetime
  // may release this helper's lock; group SIGTERM/SIGINT must not unlock it
  // before the parent finishes dispose/reap/status cleanup.
  process.on("SIGTERM", () => {});
  process.on("SIGINT", () => {});
  process.stdin.resume();
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    releaseLock();
  };
  process.stdin.once("end", release);
  process.stdin.once("error", release);
  const reportAcquired = () => process.stdout.write("ACQUIRED\n");
  if (handshakeDelayMs > 0) setTimeout(reportAcquired, handshakeDelayMs);
  else reportAcquired();
};
if (pipeName) {
  const server = require("node:net").createServer();
  const onError = (error) => {
    server.close();
    reportError(error, error.code === "EADDRINUSE" || error.code === "EACCES");
  };
  server.once("error", onError);
  try {
    server.listen(pipeName, () => {
      server.removeListener("error", onError);
      acquired(() => server.close(() => process.exit(0)));
    });
  } catch (error) {
    server.removeListener("error", onError);
    onError(error);
  }
} else {
  const fsExt = require(process.argv[1]);
  const fd = fs.openSync(path, "a+", 0o600);
  fsExt.flock(fd, "exnb", (error) => {
    if (error) {
      reportError(error, error.code === "EAGAIN" || error.code === "EWOULDBLOCK");
      fs.closeSync(fd);
      return;
    }
    acquired(() => fsExt.flock(fd, "un", () => {
      fs.closeSync(fd);
      process.exit(0);
    }));
  });
}
`;

async function acquireLockHelper(
  lockFilePath: string,
  timeoutMs = 10_000,
  handshakeDelayMs = 0,
  onDiagnostic?: AcquireFileLockOptions["onDiagnostic"],
  pipeName?: string,
): Promise<ChildProcessWithoutNullStreams> {
  const fsExtPath = pipeName ? "" : require.resolve("fs-ext");
  const child = spawn("node", ["-e", LOCK_HELPER_SOURCE, fsExtPath, lockFilePath, String(handshakeDelayMs), pipeName ?? ""], {
    stdio: ["pipe", "pipe", "pipe"],
  });
  if (child.pid) {
    await emitDiagnostic(onDiagnostic, "lock_helper_spawned", {
      lockFilePath,
      helperPid: child.pid,
    });
  }
  const line = await new Promise<string>((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let killWaitTimer: NodeJS.Timeout | undefined;
    const timer = setTimeout(() => {
      // The helper may already hold the flock and therefore ignore graceful
      // group-stop signals. Before ownership has been handed to the caller,
      // timeout cleanup must be unconditional or it can orphan the lock.
      timedOut = true;
      child.kill("SIGKILL");
      killWaitTimer = setTimeout(() => {
        // Returning while this child might still own the kernel lock would
        // abandon an untracked owner. If even SIGKILL cannot produce close,
        // the parent must not continue through a catch handler without proof
        // that acquisition cleanup completed.
        process.kill(process.pid, "SIGKILL");
      }, 5_000);
    }, timeoutMs);
    const finish = (callback: () => void) => {
      clearTimeout(timer);
      clearTimeout(killWaitTimer);
      callback();
    };
    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
      const newline = stdout.indexOf("\n");
      if (newline >= 0 && !timedOut) finish(() => resolve(stdout.slice(0, newline)));
    });
    child.stderr.on("data", (chunk) => { stderr += String(chunk); });
    child.once("error", (error) => {
      // Once timeout cleanup starts, only close proves the helper can no
      // longer own flock. Keep waiting (or fail closed above) instead of
      // losing the child reference through an early error rejection.
      if (!timedOut) finish(() => reject(error));
    });
    child.once("close", (code) => {
      if (timedOut) {
        finish(() => reject(new Error(`runtime lock helper timed out${stderr ? `: ${stderr}` : ""}`)));
      } else if (!stdout.includes("\n")) {
        finish(() => reject(new Error(`runtime lock helper exited with code ${code}${stderr ? `: ${stderr}` : ""}`)));
      }
    });
  });
  if (line === "ACQUIRED") {
    child.once("close", () => {
      if (!expectedHelperExits.has(child)) {
        // Running without the helper's kernel lock would violate the runtime
        // ownership invariant. End the Bun parent so its normal cleanup path
        // cannot keep serving or mutating shared state without ownership.
        process.kill(process.pid, "SIGKILL");
      }
    });
    return child;
  }

  child.stdin.end();
  if (line === "BUSY") {
    const error = new Error("runtime lock is busy") as NodeJS.ErrnoException;
    error.code = "EWOULDBLOCK";
    throw error;
  }
  if (line.startsWith("ERROR:")) {
    throw new Error(Buffer.from(line.slice("ERROR:".length), "base64").toString("utf8"));
  }
  throw new Error(`unexpected runtime lock helper response: ${line}`);
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
