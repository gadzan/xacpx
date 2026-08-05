import { expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, open, readFile, rm, stat, writeFile } from "node:fs/promises";
import { PassThrough } from "node:stream";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { createDaemonController } from "../../../src/daemon/create-daemon-controller";
import { terminateProcessTree } from "../../../src/process/terminate-process-tree";
import { type DaemonPaths } from "../../../src/daemon/daemon-files";

test("spawns a detached run command and records the child pid", async () => {
  const runtimeDir = await mkdtemp(join(tmpdir(), "weacpx-daemon-factory-"));
  const paths = createPaths(runtimeDir);
  const spawnCalls: Array<{
    command: string;
    args: string[];
    options: Record<string, unknown>;
  }> = [];

  const controller = createDaemonController(paths, {
    processExecPath: "/usr/local/bin/node",
    cliEntryPath: "/app/dist/cli.js",
    cwd: "/app",
    env: { HOME: "/home/test", PATH: "/usr/bin" },
    platform: "linux",
    spawnProcess: async ({ command, args, options }) => {
      spawnCalls.push({ command, args, options });
      setTimeout(() => { void writeReadyStatus(paths.statusFile, 43210); }, 0);
      return 43210;
    },
    isProcessRunning: (pid) => pid === 43210,
    terminateProcess: async () => {},
  });

  await expect(controller.start({ firstRunOnboarding: "payload" })).resolves.toEqual({
    state: "started",
    pid: 43210,
  });

  expect(spawnCalls).toEqual([
    {
      command: "/usr/local/bin/node",
      args: ["/app/dist/cli.js", "run"],
      options: expect.objectContaining({
        cwd: "/app",
        detached: true,
        env: { HOME: "/home/test", PATH: "/usr/bin", XACPX_DAEMON_RUN: "1", XACPX_FIRST_RUN_ONBOARDING: "payload" },
      }),
    },
  ]);
  await expect(readFile(paths.pidFile, "utf8")).resolves.toBe("43210\n");

  await rm(runtimeDir, { recursive: true, force: true });
});

test("spawn repairs a loose pre-existing runtime dir to user-private (0700)", async () => {
  if (process.platform === "win32") return;
  const base = await mkdtemp(join(tmpdir(), "weacpx-daemon-factory-"));
  const runtimeDir = join(base, "runtime");
  const paths = createPaths(runtimeDir);
  // Simulate an install whose runtime dir predates the 0700 hardening.
  await mkdir(runtimeDir, { recursive: true });
  await chmod(runtimeDir, 0o755);

  const controller = createDaemonController(paths, {
    processExecPath: "/usr/local/bin/node",
    cliEntryPath: "/app/dist/cli.js",
    cwd: "/app",
    env: {},
    platform: "linux",
    spawnProcess: async () => {
      await writeReadyStatus(paths.statusFile, 13579);
      return 13579;
    },
    isProcessRunning: (pid) => pid === 13579,
    terminateProcess: async () => {},
  });

  try {
    await controller.start();
    expect(((await stat(runtimeDir)).mode & 0o777)).toBe(0o700);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test("appends daemon stdout and stderr to runtime log files", async () => {
  const runtimeDir = await mkdtemp(join(tmpdir(), "weacpx-daemon-factory-"));
  const paths = createPaths(runtimeDir);
  let stdoutFd = -1;
  let stderrFd = -1;

  const controller = createDaemonController(paths, {
    processExecPath: "/usr/local/bin/node",
    cliEntryPath: "/app/dist/cli.js",
    cwd: "/app",
    env: {},
    platform: "linux",
    spawnProcess: async ({ options }) => {
      const stdio = options.stdio as unknown[];
      stdoutFd = Number(stdio[1]);
      stderrFd = Number(stdio[2]);
      setTimeout(() => { void writeReadyStatus(paths.statusFile, 54321); }, 0);
      return 54321;
    },
    isProcessRunning: (pid) => pid === 54321,
    terminateProcess: async () => {},
  });

  await controller.start();

  expect(stdoutFd).toBeGreaterThan(0);
  expect(stderrFd).toBeGreaterThan(0);

  const stdoutHandle = await open(paths.stdoutLog, "a");
  const stderrHandle = await open(paths.stderrLog, "a");
  await stdoutHandle.close();
  await stderrHandle.close();

  await rm(runtimeDir, { recursive: true, force: true });
});

test("uses a hidden powershell launcher when spawning the daemon on win32", async () => {
  const runtimeDir = await mkdtemp(join(tmpdir(), "weacpx-daemon-factory-"));
  const paths = createPaths(runtimeDir);
  const spawnCalls: Array<{
    command: string;
    args: string[];
    options: Record<string, unknown>;
  }> = [];

  const controller = createDaemonController(paths, {
    processExecPath: "C:\\node\\node.exe",
    cliEntryPath: "C:\\app\\dist\\cli.js",
    cwd: "C:\\app",
    env: {},
    platform: "win32",
    spawnProcess: async ({ command, args, options }) => {
      spawnCalls.push({ command, args, options });
      await writeReadyStatus(paths.statusFile, 65432);
      return 65432;
    },
    isProcessRunning: (pid) => pid === 65432,
    terminateProcess: async () => {},
  });

  await controller.start();

  expect(spawnCalls).toEqual([
    {
      command: "powershell.exe",
      args: expect.arrayContaining(["-NoProfile", "-NonInteractive", "-EncodedCommand"]),
      options: expect.objectContaining({
        windowsHide: true,
        env: expect.objectContaining({
          XACPX_DAEMON_COMMAND: "C:\\node\\node.exe",
          XACPX_DAEMON_ARG0: "C:\\app\\dist\\cli.js",
          XACPX_DAEMON_ARG1: "run",
          XACPX_DAEMON_RUN: "1",
          XACPX_DAEMON_STDOUT: paths.stdoutLog,
          XACPX_DAEMON_STDERR: paths.stderrLog,
        }),
      }),
    },
  ]);

  const encodedIndex = spawnCalls[0]!.args.indexOf("-EncodedCommand") + 1;
  const launcherScript = Buffer.from(spawnCalls[0]!.args[encodedIndex]!, "base64").toString("utf16le");
  expect(launcherScript).toContain("$env:XACPX_DAEMON_RUN = '1'");
  expect(launcherScript).toContain("Start-Process");

  await rm(runtimeDir, { recursive: true, force: true });
});

test("quotes Start-Process arguments so install paths with spaces survive on win32", async () => {
  const runtimeDir = await mkdtemp(join(tmpdir(), "weacpx-daemon-factory-"));
  const paths = createPaths(runtimeDir);
  const spawnCalls: Array<{
    command: string;
    args: string[];
    options: Record<string, unknown>;
  }> = [];

  const controller = createDaemonController(paths, {
    processExecPath: "C:\\Program Files\\nodejs\\node.exe",
    cliEntryPath: "C:\\Users\\John Doe\\AppData\\Roaming\\npm\\node_modules\\xacpx\\dist\\cli.js",
    cwd: "C:\\Users\\John Doe\\project",
    env: {},
    platform: "win32",
    spawnProcess: async ({ command, args, options }) => {
      spawnCalls.push({ command, args, options });
      await writeReadyStatus(paths.statusFile, 87654);
      return 87654;
    },
    isProcessRunning: (pid) => pid === 87654,
    terminateProcess: async () => {},
  });

  await controller.start();

  // Paths with spaces travel verbatim through env vars (never through the
  // command line of the powershell process itself).
  const env = (spawnCalls[0]!.options as { env: Record<string, string> }).env;
  expect(env.XACPX_DAEMON_COMMAND).toBe("C:\\Program Files\\nodejs\\node.exe");
  expect(env.XACPX_DAEMON_ARG0).toBe("C:\\Users\\John Doe\\AppData\\Roaming\\npm\\node_modules\\xacpx\\dist\\cli.js");
  expect(env.XACPX_DAEMON_ARG1).toBe("run");

  const encodedIndex = spawnCalls[0]!.args.indexOf("-EncodedCommand") + 1;
  const launcherScript = Buffer.from(spawnCalls[0]!.args[encodedIndex]!, "base64").toString("utf16le");
  // Windows PowerShell 5.1's Start-Process joins -ArgumentList elements with
  // spaces WITHOUT quoting them, so each element must carry its own embedded
  // double quotes to reach the child as a single argv entry. Pin the exact
  // quoting construction so it cannot regress to bare $env: references.
  expect(launcherScript).toContain(`$arg0 = '"' + $env:XACPX_DAEMON_ARG0 + '"'`);
  expect(launcherScript).toContain(`$arg1 = '"' + $env:XACPX_DAEMON_ARG1 + '"'`);
  expect(launcherScript).toContain("-ArgumentList @($arg0, $arg1)");
  expect(launcherScript).not.toContain("-ArgumentList @($env:XACPX_DAEMON_ARG0");

  await rm(runtimeDir, { recursive: true, force: true });
});

test("returns as soon as the hidden windows launcher prints a pid", async () => {
  const runtimeDir = await mkdtemp(join(tmpdir(), "weacpx-daemon-factory-"));
  const paths = createPaths(runtimeDir);
  let capturedCommand = "";

  const controller = createDaemonController(paths, {
    processExecPath: "C:\\node\\node.exe",
    cliEntryPath: "C:\\app\\dist\\cli.js",
    cwd: "C:\\app",
    env: {},
    platform: "win32",
    spawnProcess: async ({ command }) => {
      capturedCommand = command;
      await writeReadyStatus(paths.statusFile, 76543);
      return await new Promise<number>((resolve) => {
        setTimeout(() => resolve(76543), 10);
      });
    },
    isProcessRunning: (pid) => pid === 76543,
    terminateProcess: async () => {},
  });

  await expect(controller.start()).resolves.toEqual({
    state: "started",
    pid: 76543,
  });
  expect(capturedCommand).toBe("powershell.exe");

  await rm(runtimeDir, { recursive: true, force: true });
});


test("terminates a detached process group on unix", async () => {
  const signals: Array<{ pid: number; signal: NodeJS.Signals }> = [];
  const runningChecks: number[] = [];

  await terminateProcessTree(
    43210,
    { detachedProcessGroup: true },
    "linux",
    async () => 0,
    (pid, signal) => {
      signals.push({ pid, signal });
    },
    (pid) => {
      runningChecks.push(pid);
      return false;
    },
  );

  expect(signals).toEqual([
    {
      pid: -43210,
      signal: "SIGTERM",
    },
  ]);
  expect(runningChecks).toEqual([-43210]);
});


test("terminates a normal unix child by pid, not by process group", async () => {
  const signals: Array<{ pid: number; signal: NodeJS.Signals }> = [];
  const runningChecks: number[] = [];

  await terminateProcessTree(
    43210,
    { detachedProcessGroup: false },
    "linux",
    async () => 0,
    (pid, signal) => {
      signals.push({ pid, signal });
    },
    (pid) => {
      runningChecks.push(pid);
      return false;
    },
  );

  expect(signals).toEqual([
    {
      pid: 43210,
      signal: "SIGTERM",
    },
  ]);
  expect(runningChecks).toEqual([43210]);
});

test("refuses to terminate a bare PID on win32", async () => {
  const calls: Array<{ command: string; args: string[] }> = [];

  const result = await terminateProcessTree(43210, {}, "win32", async (command, args) => {
    calls.push({ command, args });
    return 0;
  });

  expect(calls).toEqual([]);
  expect(result).toEqual({
    rootOutcome: "query-failed",
    outcomes: [{ target: { pid: 43210, creationDate: null }, outcome: "query-failed" }],
  });
});

function createPaths(runtimeDir: string): DaemonPaths {
  return {
    runtimeDir,
    pidFile: join(runtimeDir, "daemon.pid"),
    statusFile: join(runtimeDir, "status.json"),
    stdoutLog: join(runtimeDir, "stdout.log"),
    stderrLog: join(runtimeDir, "stderr.log"),
  };
}

async function writeReadyStatus(statusFile: string, pid: number): Promise<void> {
  await writeFile(
    statusFile,
    JSON.stringify({
      pid,
      started_at: "2026-03-26T00:00:00.000Z",
      heartbeat_at: "2026-03-26T00:01:00.000Z",
      config_path: "/cfg",
      state_path: "/state",
      app_log: "/app",
      stdout_log: "/out",
      stderr_log: "/err",
    }),
  );
}
