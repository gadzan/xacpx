import { spawn } from "node:child_process";

import {
  terminateWindowsProcessTree,
  type BatchTarget,
  type TerminateProcessTreeResult,
  type WindowsProcessWorkerOptions,
} from "./windows-process-tree";

type ProcessCommandRunner = (command: string, args: string[]) => Promise<number>;
type KillProcess = (pid: number, signal: NodeJS.Signals) => void;
type IsProcessRunning = (pid: number) => boolean;

export type TerminateProcessTreeOptions = {
  /** True when the child was spawned detached so its pid is also its process-group id on Unix. */
  detachedProcessGroup?: boolean;
  windowsWorker?: WindowsProcessWorkerOptions;
};

export async function terminateProcessTree(
  target: number | BatchTarget,
  options: TerminateProcessTreeOptions = {},
  platform: NodeJS.Platform = process.platform,
  runCommand: ProcessCommandRunner = defaultRunProcessCommand,
  killProcess: KillProcess = (targetPid, signal) => {
    process.kill(targetPid, signal);
  },
  isProcessRunning: IsProcessRunning = defaultIsProcessRunning,
): Promise<void | TerminateProcessTreeResult> {
  const pid = typeof target === "number" ? target : target.pid;
  if (pid <= 0) {
    return;
  }

  if (platform === "win32") {
    // A bare PID contains no independent generation identity. Preserve source
    // compatibility for Unix callers but fail closed on Windows.
    const root = typeof target === "number"
      ? { pid: target, creationDate: null }
      : target;
    return await terminateWindowsProcessTree(root, options.windowsWorker);
  }

  const targetPid = options.detachedProcessGroup ? -pid : pid;

  try {
    killProcess(targetPid, "SIGTERM");
  } catch (error) {
    const code = (error as { code?: unknown } | null)?.code;
    if (code === "ESRCH") return;
    if (code === "EPERM") {
      // macOS quirk: signalling a JUST-EXITED (zombie, not yet reaped) group
      // rejects with EPERM even though the tree is dying. Give the parent's
      // reaping a short window; a group that survives it is a REAL
      // permission failure and must fail closed (G10).
      if (await waitGone(targetPid, isProcessRunning, 2_000)) return;
    }
    // Any other error (or a surviving EPERM group) is an UNVERIFIED
    // termination: fail closed instead of letting callers treat ownership
    // as discharged.
    throw error;
  }

  if (!(await waitGone(targetPid, isProcessRunning))) {
    try {
      killProcess(targetPid, "SIGKILL");
    } catch (error) {
      if ((error as { code?: unknown } | null)?.code === "ESRCH") return;
      // fall through to final verification; a throwing SIGKILL on a live
      // group must not be reported as success either.
    }
  } else {
    return;
  }
  // Final verification: SIGKILL is only a request. Ownership is discharged
  // when the group is GONE, not when the signal was delivered.
  if (await waitGone(targetPid, isProcessRunning)) return;
  throw new Error(
    `process group ${targetPid} did not terminate after SIGKILL; refusing to report verified ownership discharge`,
  );
}

async function waitGone(targetPid: number, isProcessRunning: IsProcessRunning, timeoutMs = 5_000, pollMs = 100): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isProcessRunning(targetPid)) return true;
    const { promise, resolve } = Promise.withResolvers<void>();
    setTimeout(resolve, pollMs);
    await promise;
  }
  return false;
}

function defaultIsProcessRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function defaultRunProcessCommand(command: string, args: string[]): Promise<number> {
  return await new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: "ignore" });

    child.on("error", reject);
    child.on("close", (code) => resolve(code ?? 1));
  });
}
