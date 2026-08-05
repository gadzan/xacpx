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
  } catch {
    return;
  }

  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (!isProcessRunning(targetPid)) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  try {
    killProcess(targetPid, "SIGKILL");
  } catch {
    // Process already exited.
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

async function defaultRunProcessCommand(command: string, args: string[]): Promise<number> {
  return await new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: "ignore" });

    child.on("error", reject);
    child.on("close", (code) => resolve(code ?? 1));
  });
}
