import { createRequire } from "node:module";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdir, open, readFile, writeFile, type FileHandle } from "node:fs/promises";
import { dirname } from "node:path";

import {
  ActiveConsumerLockError,
  type ConsumerLock,
  type ConsumerLockMetadata,
} from "../channels/types";
import { acquireIpcGuard, IpcGuardBusyError } from "../process/ipc-guard";

const require = createRequire(import.meta.url);
const expectedHelperExits = new WeakSet<ChildProcessWithoutNullStreams>();
const FLOCK_HELPER_RELEASE_TIMEOUT_MS = 5_000;

interface FsExt {
  flock(
    fd: number,
    operation: "exnb" | "un",
    callback: (error?: NodeJS.ErrnoException | null) => void,
  ): void;
}

interface CreateRuntimeConsumerLockOptions {
  lockFilePath: string;
  channelLock?: ConsumerLock;
  onDiagnostic?: (
    event: string,
    context: Record<string, string | number | boolean | undefined>,
  ) => void | Promise<void>;
  createCoreLock?: () => ConsumerLock;
  platform?: NodeJS.Platform;
  acquireGuard?: typeof acquireIpcGuard;
  loadFsExt?: () => FsExt;
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
 * also conflicts with daemons started before the core lock existed.
 */
export function createRuntimeConsumerLock(options: CreateRuntimeConsumerLockOptions): ConsumerLock {
  const coreLock = (options.createCoreLock ?? (() => createCoreRuntimeLock(options)))();
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

function createCoreRuntimeLock(options: CreateRuntimeConsumerLockOptions): ConsumerLock {
  const platform = options.platform ?? process.platform;
  const onDiagnostic = options.onDiagnostic;
  let windowsGuard: Awaited<ReturnType<typeof acquireIpcGuard>> | undefined;
  let posixHandle: FileHandle | undefined;
  let posixHelper: ChildProcessWithoutNullStreams | undefined;

  return {
    async acquire(metadata): Promise<void> {
      await mkdir(dirname(options.lockFilePath), { recursive: true, mode: 0o700 });
      if (platform === "win32") {
        try {
          windowsGuard = await (options.acquireGuard ?? acquireIpcGuard)(
            { role: "runtime-owner", configRoot: dirname(metadata.configPath) },
            { platform },
          );
        } catch (error) {
          if (!(error instanceof IpcGuardBusyError)) throw error;
          const existing = await loadMetadata(options.lockFilePath) ?? metadata;
          await emitDiagnostic(onDiagnostic, "lock_active_conflict", conflictContext(options.lockFilePath, metadata, existing));
          throw new ActiveRuntimeConsumerLockError(options.lockFilePath, existing);
        }

        try {
          await writeFile(
            options.lockFilePath,
            `${JSON.stringify(metadata, null, 2)}\n`,
            { encoding: "utf8", mode: 0o600 },
          );
        } catch (error) {
          await windowsGuard.release().catch(() => {});
          windowsGuard = undefined;
          throw error;
        }
        await emitDiagnostic(onDiagnostic, "lock_acquired", acquiredContext(options.lockFilePath, metadata));
        return;
      }

      // fs-ext is optional only so Windows installs do not load a Unix native
      // module. On POSIX it is mandatory: failure to load or flock fails closed.
      const handle = await open(options.lockFilePath, "a+", 0o600);
      try {
        await handle.chmod(0o600);
        try {
          if (isBunRuntime() && !options.loadFsExt) {
            // fs-ext is a Node native addon. Bun cannot safely dlopen the
            // installed Node ABI binary, so a tiny Node child holds the same
            // kernel flock and ties its lifetime to this process via stdin.
            await handle.close();
            posixHelper = await acquireFlockHelper(options.lockFilePath);
            await emitDiagnostic(onDiagnostic, "lock_helper_started", {
              lockFilePath: options.lockFilePath,
              helperPid: posixHelper.pid,
            });
          } else {
            const fsExt = options.loadFsExt?.() ?? require("fs-ext") as FsExt;
            await flock(fsExt, handle.fd, "exnb");
            posixHandle = handle;
          }
        } catch (error) {
          if (!isBusy(error)) throw error;
          const existing = await loadMetadata(options.lockFilePath) ?? metadata;
          await emitDiagnostic(onDiagnostic, "lock_active_conflict", conflictContext(options.lockFilePath, metadata, existing));
          throw new ActiveRuntimeConsumerLockError(options.lockFilePath, existing);
        }
        try {
          const metadataHandle = posixHandle ?? await open(options.lockFilePath, "r+");
          try {
            await metadataHandle.truncate(0);
            await metadataHandle.writeFile(`${JSON.stringify(metadata, null, 2)}\n`, "utf8");
            await metadataHandle.sync();
          } finally {
            if (!posixHandle) await metadataHandle.close();
          }
        } catch (error) {
          await releasePosixLock(options, posixHandle, posixHelper).catch(() => {});
          posixHandle = undefined;
          posixHelper = undefined;
          throw error;
        }
        await emitDiagnostic(onDiagnostic, "lock_acquired", acquiredContext(options.lockFilePath, metadata));
      } catch (error) {
        if (handle !== posixHandle) await handle.close().catch(() => {});
        throw error;
      }
    },

    async release(): Promise<void> {
      if (platform === "win32") {
        await windowsGuard?.release();
        windowsGuard = undefined;
      } else if (posixHandle || posixHelper) {
        const handle = posixHandle;
        const helper = posixHelper;
        posixHandle = undefined;
        posixHelper = undefined;
        await releasePosixLock(options, handle, helper);
      }
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

async function releasePosixLock(
  options: CreateRuntimeConsumerLockOptions,
  handle: FileHandle | undefined,
  helper: ChildProcessWithoutNullStreams | undefined,
): Promise<void> {
  if (helper) {
    expectedHelperExits.add(helper);
    if (helper.exitCode !== null || helper.signalCode !== null) return;
    const closePromise = new Promise<void>((resolve, reject) => {
      let settled = false;
      const finish = (callback: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        callback();
      };
      const timer = setTimeout(() => {
        helper.kill("SIGKILL");
        finish(() => reject(new Error("runtime lock helper did not release within 5000ms")));
      }, FLOCK_HELPER_RELEASE_TIMEOUT_MS);
      helper.once("error", (error) => finish(() => reject(error)));
      helper.once("close", (code) => finish(() => code === 0
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

const FLOCK_HELPER_SOURCE = String.raw`
const fs = require("node:fs");
const fsExt = require(process.argv[1]);
const path = process.argv[2];
const fd = fs.openSync(path, "a+", 0o600);
fsExt.flock(fd, "exnb", (error) => {
  if (error) {
    const busy = error.code === "EAGAIN" || error.code === "EWOULDBLOCK";
    process.stdout.write(busy ? "BUSY\n" : "ERROR:" + Buffer.from(String(error.stack || error)).toString("base64") + "\n");
    fs.closeSync(fd);
    process.exitCode = busy ? 2 : 1;
    return;
  }
  // The daemon controller signals the whole POSIX process group during a
  // graceful stop. Once ownership is acquired, only the parent stdin lifetime
  // may release this helper's flock; group SIGTERM/SIGINT must not unlock it
  // before the parent finishes dispose/reap/status cleanup.
  process.on("SIGTERM", () => {});
  process.on("SIGINT", () => {});
  process.stdout.write("ACQUIRED\n");
  process.stdin.resume();
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    fsExt.flock(fd, "un", () => {
      fs.closeSync(fd);
      process.exit(0);
    });
  };
  process.stdin.once("end", release);
  process.stdin.once("error", release);
});
`;

async function acquireFlockHelper(lockFilePath: string): Promise<ChildProcessWithoutNullStreams> {
  const fsExtPath = require.resolve("fs-ext");
  const child = spawn("node", ["-e", FLOCK_HELPER_SOURCE, fsExtPath, lockFilePath], {
    stdio: ["pipe", "pipe", "pipe"],
  });
  const line = await new Promise<string>((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`runtime lock helper timed out${stderr ? `: ${stderr}` : ""}`));
    }, 10_000);
    const finish = (callback: () => void) => {
      clearTimeout(timer);
      callback();
    };
    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
      const newline = stdout.indexOf("\n");
      if (newline >= 0) finish(() => resolve(stdout.slice(0, newline)));
    });
    child.stderr.on("data", (chunk) => { stderr += String(chunk); });
    child.once("error", (error) => finish(() => reject(error)));
    child.once("close", (code) => {
      if (!stdout.includes("\n")) {
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
