import { open } from "node:fs/promises";
import { spawn } from "node:child_process";

import { DaemonController } from "./daemon-controller";
import type { DaemonPaths } from "./daemon-files";
import { ensurePrivateRuntimeDir } from "./private-runtime-dir";
import { terminateProcessTree } from "../process/terminate-process-tree";
import { dirname } from "node:path";
import type { IpcGuard } from "../process/ipc-guard";

interface SpawnRequest {
  mode: "direct" | "windows-hidden";
  command: string;
  args: string[];
  options: {
    cwd: string;
    env: NodeJS.ProcessEnv;
    detached?: boolean;
    stdio: ["ignore", number | "pipe", number | "ignore"];
    windowsHide?: boolean;
  };
}

interface CreateDaemonControllerOptions {
  processExecPath: string;
  cliEntryPath: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  spawnProcess?: (request: SpawnRequest) => Promise<number>;
  isProcessRunning?: (pid: number) => boolean;
  terminateProcess?: (pid: number) => Promise<void>;
  acquireLifecycleGuard?: () => Promise<IpcGuard>;
}

export function createDaemonController(
  paths: DaemonPaths,
  options: CreateDaemonControllerOptions,
): DaemonController {
  return new DaemonController(paths, {
    platform: options.platform ?? process.platform,
    configRoot: dirname(paths.runtimeDir),
    ...(options.acquireLifecycleGuard ? { acquireLifecycleGuard: options.acquireLifecycleGuard } : {}),
    isProcessRunning: options.isProcessRunning ?? defaultIsProcessRunning,
    spawnDetached: async (spawnOptions) => {
      // User-private (0700): the runtime dir holds the orchestration socket,
      // whose only access control is filesystem permissions.
      await ensurePrivateRuntimeDir(paths.runtimeDir, {
        ...(options.platform ? { platform: options.platform } : {}),
      });
      const stdoutHandle = await open(paths.stdoutLog, "a", 0o600);
      const stderrHandle = await open(paths.stderrLog, "a", 0o600);
      // open's mode only applies on creation; harden pre-existing logs too.
      await stdoutHandle.chmod(0o600).catch(() => {});
      await stderrHandle.chmod(0o600).catch(() => {});

      try {
        return await (options.spawnProcess ?? defaultSpawnProcess)(
          buildSpawnRequest(paths, options, stdoutHandle.fd, stderrHandle.fd, spawnOptions),
        );
      } finally {
        await stdoutHandle.close();
        await stderrHandle.close();
      }
    },
    terminateProcess: options.terminateProcess ?? defaultTerminateProcess,
  });
}

function defaultIsProcessRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function buildSpawnRequest(
  paths: DaemonPaths,
  options: CreateDaemonControllerOptions,
  stdoutFd: number,
  stderrFd: number,
  spawnOptions: { firstRunOnboarding?: string } = {},
): SpawnRequest {
  const platform = options.platform ?? process.platform;
  if (platform === "win32") {
    return {
      mode: "windows-hidden",
      command: "powershell.exe",
      args: [
        "-NoProfile",
        "-NonInteractive",
        "-EncodedCommand",
        buildWindowsLauncherScript(),
      ],
      options: {
        cwd: options.cwd,
        env: {
          ...options.env,
          XACPX_DAEMON_COMMAND: options.processExecPath,
          XACPX_DAEMON_ARG0: options.cliEntryPath,
          XACPX_DAEMON_ARG1: "run",
          XACPX_DAEMON_CWD: options.cwd,
          XACPX_DAEMON_RUN: "1",
          XACPX_DAEMON_STDOUT: paths.stdoutLog,
          XACPX_DAEMON_STDERR: paths.stderrLog,
          ...(spawnOptions.firstRunOnboarding ? { XACPX_FIRST_RUN_ONBOARDING: spawnOptions.firstRunOnboarding } : {}),
        },
        stdio: ["ignore", "pipe", "ignore"],
        windowsHide: true,
      },
    };
  }

  return {
    mode: "direct",
    command: options.processExecPath,
    args: [options.cliEntryPath, "run"],
    options: {
      cwd: options.cwd,
      detached: true,
      env: {
        ...options.env,
        XACPX_DAEMON_RUN: "1",
        ...(spawnOptions.firstRunOnboarding ? { XACPX_FIRST_RUN_ONBOARDING: spawnOptions.firstRunOnboarding } : {}),
      },
      stdio: ["ignore", stdoutFd, stderrFd],
    },
  };
}

function buildWindowsLauncherScript(): string {
  // Invariant: each -ArgumentList element must reach the child process as ONE
  // argv entry even when it contains spaces. Windows PowerShell 5.1 builds the
  // child command line by joining -ArgumentList elements with spaces WITHOUT
  // quoting them, so a cli.js path like `C:\Users\John Doe\...\cli.js` would
  // split into multiple argv entries (node then exits MODULE_NOT_FOUND).
  // Wrap each element in explicit double quotes here, in PowerShell, where no
  // further escaping layer applies (the script travels via -EncodedCommand and
  // the values via env vars). Windows paths cannot contain `"`, and neither
  // value ends with a trailing backslash (arg0 ends in cli.js, arg1 is "run"),
  // so plain surrounding quotes are sufficient. -FilePath, -WorkingDirectory
  // and -RedirectStandard* bind their variable as a single parameter value and
  // need no quoting.
  const script = [
    "$env:XACPX_DAEMON_RUN = '1'",
    `$arg0 = '"' + $env:XACPX_DAEMON_ARG0 + '"'`,
    `$arg1 = '"' + $env:XACPX_DAEMON_ARG1 + '"'`,
    "$process = Start-Process -FilePath $env:XACPX_DAEMON_COMMAND `",
    "  -ArgumentList @($arg0, $arg1) `",
    "  -WorkingDirectory $env:XACPX_DAEMON_CWD `",
    "  -RedirectStandardOutput $env:XACPX_DAEMON_STDOUT `",
    "  -RedirectStandardError $env:XACPX_DAEMON_STDERR `",
    "  -WindowStyle Hidden `",
    "  -PassThru",
    "[Console]::Out.WriteLine($process.Id)",
  ].join("\n");

  return Buffer.from(script, "utf16le").toString("base64");
}

async function defaultSpawnProcess(request: SpawnRequest): Promise<number> {
  if (request.mode === "windows-hidden") {
    return await spawnWindowsHiddenProcess(request);
  }

  const child = spawn(request.command, request.args, request.options);
  child.unref();
  return child.pid ?? 0;
}

async function spawnWindowsHiddenProcess(request: SpawnRequest): Promise<number> {
  return await new Promise((resolve, reject) => {
    const child = spawn(request.command, request.args, request.options);
    let stdout = "";
    let settled = false;

    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk) => {
      stdout += chunk;
      if (settled) {
        return;
      }

      const pid = Number.parseInt(stdout.trim(), 10);
      if (!Number.isFinite(pid) || pid <= 0) {
        return;
      }

      settled = true;
      child.stdout?.destroy();
      child.unref();
      resolve(pid);
    });

    child.on("error", (error) => {
      if (settled) {
        return;
      }
      settled = true;
      reject(error);
    });
    child.on("close", (code) => {
      if (settled) {
        return;
      }

      if (code !== 0) {
        settled = true;
        reject(new Error(`Failed to launch hidden Windows daemon process (exit ${code ?? 1})`));
        return;
      }

      const pid = Number.parseInt(stdout.trim(), 10);
      if (!Number.isFinite(pid) || pid <= 0) {
        settled = true;
        reject(new Error("Failed to read daemon pid from hidden Windows launcher"));
        return;
      }

      settled = true;
      resolve(pid);
    });
  });
}

async function defaultTerminateProcess(pid: number): Promise<void> {
  await terminateProcessTree(pid, { detachedProcessGroup: true });
}
