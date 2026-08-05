import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { expect, mock, test } from "bun:test";

import { checkBridge } from "../../../src/doctor/checks/bridge-check";
import { main as doctorMain } from "../../../src/doctor/index";
import { runDoctor } from "../../../src/doctor/doctor";
import type { DoctorCheckResult } from "../../../src/doctor/doctor-types";
import { checkConfig } from "../../../src/doctor/checks/config-check";
import { checkDaemon } from "../../../src/doctor/checks/daemon-check";
import { checkRuntime } from "../../../src/doctor/checks/runtime-check";
import { checkWechat } from "../../../src/doctor/checks/wechat-check";
import { DaemonStatusStore } from "../../../src/daemon/daemon-status";

async function createTempHome(): Promise<string> {
  return await mkdtemp(join(tmpdir(), "weacpx-doctor-"));
}

async function writeConfig(home: string, contents: string): Promise<string> {
  const configDir = join(home, ".weacpx");
  await mkdir(configDir, { recursive: true });
  const configPath = join(configDir, "config.json");
  await writeFile(configPath, contents, "utf8");
  return configPath;
}

test("config check passes for a valid config file", async () => {
  const home = await createTempHome();

  try {
    await writeConfig(
      home,
      JSON.stringify(
        {
          transport: {
            type: "acpx-bridge",
          },
          agents: {
            codex: {
              driver: "codex",
            },
          },
          workspaces: {
            backend: {
              cwd: "/tmp",
            },
          },
        },
        null,
        2,
      ),
    );

    const result = await checkConfig({
      resolveRuntimePaths: () => ({
        configPath: join(home, ".weacpx", "config.json"),
        statePath: join(home, ".weacpx", "state.json"),
      }),
    });

    expect(result.severity).toBe("pass");
    expect(result.metadata?.configPath).toContain(join(home, ".weacpx", "config.json"));
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("config check fails with config path detail when parsing fails", async () => {
  const home = await createTempHome();

  try {
    await writeConfig(home, "{");

    const result = await checkConfig({
      resolveRuntimePaths: () => ({
        configPath: join(home, ".weacpx", "config.json"),
        statePath: join(home, ".weacpx", "state.json"),
      }),
    });

    expect(result.severity).toBe("fail");
    expect(result.details).toContain(`config path: ${join(home, ".weacpx", "config.json")}`);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("runtime check passes on a fresh install when runtime paths are creatable", async () => {
  const home = await createTempHome();

  try {
    const probe = createRuntimeProbe({
      directories: [home],
    });

    const result = await checkRuntime({
      home,
      probe: probe.probe,
      platform: "win32",
    });

    expect(result.severity).toBe("pass");
    expect(result.details?.join("\n") ?? "").toContain(`runtimeDir: ${join(home, ".xacpx", "runtime")}`);
    expect(probe.accessModesByPath.get(home)?.length ?? 0).toBeGreaterThan(0);
    expect(probe.accessModesByPath.get(home)?.every((mode) => mode === constants.W_OK)).toBe(true);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("runtime check fails when a critical daemon path parent is not writable", async () => {
  const home = await createTempHome();

  try {
    const protectedParent = join(home, ".xacpx");
    const probe = createRuntimeProbe({
      directories: [home, protectedParent],
      deniedAccess: [protectedParent],
    });

    const result = await checkRuntime({
      home,
      probe: probe.probe,
    });

    expect(result.severity).toBe("fail");
    expect(result.details?.join("\n") ?? "").toContain(protectedParent);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("daemon check passes when daemon status is running", async () => {
  const home = await createTempHome();
  const runtimeDir = join(home, ".weacpx", "runtime");
  const pid = 12345;

  try {
    await mkdir(runtimeDir, { recursive: true });
    await writeFile(join(runtimeDir, "daemon.pid"), `${pid}\n`, "utf8");
    await new DaemonStatusStore(join(runtimeDir, "status.json")).save({
      pid,
      started_at: "2026-04-07T00:00:00.000Z",
      heartbeat_at: "2026-04-07T00:01:00.000Z",
      config_path: "/cfg",
      state_path: "/state",
      app_log: "/app",
      stdout_log: "/out",
      stderr_log: "/err",
    });

    const result = await checkDaemon({
      home,
      isProcessRunning: (currentPid) => currentPid === pid,
    });

    expect(result.severity).toBe("pass");
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("daemon check warns when daemon is stopped", async () => {
  const home = await createTempHome();

  try {
    const result = await checkDaemon({ home });

    expect(result.severity).toBe("warn");
    expect(result.suggestions ?? []).toContain("run: xacpx start");
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("daemon check fails when daemon status is indeterminate", async () => {
  const home = await createTempHome();
  const runtimeDir = join(home, ".weacpx", "runtime");
  const pid = 12345;

  try {
    await mkdir(runtimeDir, { recursive: true });
    await writeFile(join(runtimeDir, "daemon.pid"), `${pid}\n`, "utf8");

    const result = await checkDaemon({
      home,
      isProcessRunning: (currentPid) => currentPid === pid,
    });

    expect(result.severity).toBe("fail");
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("daemon check fails gracefully when status files are broken", async () => {
  const home = await createTempHome();
  const runtimeDir = join(home, ".weacpx", "runtime");

  try {
    await mkdir(runtimeDir, { recursive: true });
    await writeFile(join(runtimeDir, "daemon.pid"), "12345\n", "utf8");
    await writeFile(join(runtimeDir, "status.json"), "{", "utf8");

    const result = await checkDaemon({
      home,
      isProcessRunning: () => true,
    });

    // A corrupt status.json no longer throws: DaemonStatusStore.load() returns
    // null on a JSON parse error, so a running pid with an unreadable status
    // surfaces as a graceful "indeterminate" fail (reason: missing-status)
    // rather than the old read-error path. Still severity "fail", still no crash.
    expect(result.severity).toBe("fail");
    expect(result.summary).toContain("indeterminate");
    expect(result.details?.join("\n") ?? "").toContain("missing-status");
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("wechat check passes when at least one account is logged in", async () => {
  const stateDir = await createTempHome();
  const accountId = "wx-test";
  const accountsDir = join(stateDir, "openclaw-weixin");
  const accountStoreDir = join(accountsDir, "accounts");

  try {
    await mkdir(accountStoreDir, { recursive: true });
    await writeFile(join(accountsDir, "accounts.json"), JSON.stringify([accountId], null, 2), "utf8");
    await writeFile(
      join(accountStoreDir, `${accountId}.json`),
      JSON.stringify({ token: "test-token", baseUrl: "https://example.com" }, null, 2),
      "utf8",
    );
    await writeFile(
      join(accountStoreDir, `${accountId}.sync.json`),
      JSON.stringify({ get_updates_buf: "not-an-account-token" }, null, 2),
      "utf8",
    );

    const previousStateDir = process.env.OPENCLAW_STATE_DIR;
    process.env.OPENCLAW_STATE_DIR = stateDir;

    try {
      const result = await checkWechat();
      expect(result.severity).toBe("pass");
    } finally {
      if (previousStateDir === undefined) {
        delete process.env.OPENCLAW_STATE_DIR;
      } else {
        process.env.OPENCLAW_STATE_DIR = previousStateDir;
      }
    }
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
});

test("wechat check passes when a later account is configured even if the first is not", async () => {
  const stateDir = await createTempHome();
  const firstAccountId = "wx-first";
  const secondAccountId = "wx-second";
  const accountsDir = join(stateDir, "openclaw-weixin");
  const accountStoreDir = join(accountsDir, "accounts");

  try {
    await mkdir(accountStoreDir, { recursive: true });
    await writeFile(
      join(accountsDir, "accounts.json"),
      JSON.stringify([firstAccountId, secondAccountId], null, 2),
      "utf8",
    );
    await writeFile(join(accountStoreDir, `${firstAccountId}.json`), JSON.stringify({}, null, 2), "utf8");
    await writeFile(
      join(accountStoreDir, `${secondAccountId}.json`),
      JSON.stringify({ token: "test-token", baseUrl: "https://example.com" }, null, 2),
      "utf8",
    );

    const previousStateDir = process.env.OPENCLAW_STATE_DIR;
    process.env.OPENCLAW_STATE_DIR = stateDir;

    try {
      const result = await checkWechat();
      expect(result.severity).toBe("pass");
    } finally {
      if (previousStateDir === undefined) {
        delete process.env.OPENCLAW_STATE_DIR;
      } else {
        process.env.OPENCLAW_STATE_DIR = previousStateDir;
      }
    }
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
});

test("wechat check falls back to account credential files when the index is empty", async () => {
  const stateDir = await createTempHome();
  const accountId = "wx-fallback";
  const accountsDir = join(stateDir, "openclaw-weixin");
  const accountStoreDir = join(accountsDir, "accounts");

  try {
    await mkdir(accountStoreDir, { recursive: true });
    await writeFile(join(accountsDir, "accounts.json"), JSON.stringify([], null, 2), "utf8");
    await writeFile(
      join(accountStoreDir, `${accountId}.json`),
      JSON.stringify({ token: "test-token", baseUrl: "https://example.com" }, null, 2),
      "utf8",
    );
    await writeFile(
      join(accountStoreDir, `${accountId}.sync.json`),
      JSON.stringify({ get_updates_buf: "not-an-account-token" }, null, 2),
      "utf8",
    );

    const previousStateDir = process.env.OPENCLAW_STATE_DIR;
    process.env.OPENCLAW_STATE_DIR = stateDir;

    try {
      const result = await checkWechat({ verbose: true });
      expect(result.severity).toBe("pass");
      expect(result.details?.join("\n") ?? "").toContain(`accountIds: ${accountId}`);
    } finally {
      if (previousStateDir === undefined) {
        delete process.env.OPENCLAW_STATE_DIR;
      } else {
        process.env.OPENCLAW_STATE_DIR = previousStateDir;
      }
    }
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
});

test("wechat check warns when no account is logged in", async () => {
  const stateDir = await createTempHome();

  try {
    const previousStateDir = process.env.OPENCLAW_STATE_DIR;
    process.env.OPENCLAW_STATE_DIR = stateDir;

    try {
      const result = await checkWechat();

      expect(result.severity).toBe("warn");
      expect(result.suggestions ?? []).toContain("xacpx login");
    } finally {
      if (previousStateDir === undefined) {
        delete process.env.OPENCLAW_STATE_DIR;
      } else {
        process.env.OPENCLAW_STATE_DIR = previousStateDir;
      }
    }
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
});

test("bridge check passes when acpx-bridge client starts and pings", async () => {
  let disposed = false;

  const result = await checkBridge({
    loadConfig: async () => ({
      transport: {
        type: "acpx-bridge",
        permissionMode: "approve-all",
        nonInteractivePermissions: "deny",
      },
    }) as any,
    resolveAcpxCommandMetadata: () => ({
      command: "/resolved/acpx",
      source: "bundled",
      explanation: "bundled acpx found",
    }),
    resolveBridgeEntryPath: () => "/resolved/bridge-main.ts",
    spawnAcpxBridgeClient: async (options) => {
      expect(options).toMatchObject({
        acpxCommand: "/resolved/acpx",
        bridgeEntryPath: "/resolved/bridge-main.ts",
        permissionMode: "approve-all",
        nonInteractivePermissions: "deny",
      });

      return {
        waitUntilReady: async () => {},
        dispose: async () => {
          disposed = true;
        },
        request: async () => ({}) as never,
        handleLine() {},
        handleExit() {},
      } as any;
    },
  });

  expect(result.severity).toBe("pass");
  expect(result.summary).toContain("responded to ping");
  expect(result.metadata).toMatchObject({
    acpxCommand: "/resolved/acpx",
    source: "bundled",
  });
  expect(disposed).toBe(true);
});

test("bridge check skips when transport type is acpx-cli", async () => {
  const result = await checkBridge({
    loadConfig: async () => ({
      transport: {
        type: "acpx-cli",
        permissionMode: "approve-all",
        nonInteractivePermissions: "deny",
      },
    }) as any,
  });

  expect(result.severity).toBe("skip");
  expect(result.summary).toContain("acpx-cli");
});

test("bridge check fails when bridge startup fails", async () => {
  const result = await checkBridge({
    loadConfig: async () => ({
      transport: {
        type: "acpx-bridge",
        permissionMode: "approve-all",
        nonInteractivePermissions: "deny",
      },
    }) as any,
    resolveAcpxCommandMetadata: () => ({
      command: "/resolved/acpx",
      source: "config",
      explanation: "configured command",
    }),
    spawnAcpxBridgeClient: async () => {
      throw new Error("spawn exploded");
    },
  });

  expect(result.severity).toBe("fail");
  expect(result.details?.join("\n") ?? "").toContain("spawn exploded");
});

function createRuntimeProbe(options: {
  directories: string[];
  deniedAccess?: string[];
}): {
  probe: {
    stat: (path: string) => Promise<{ isDirectory: () => boolean }>;
    access: (path: string, mode: number) => Promise<void>;
  };
  accessModesByPath: Map<string, number[]>;
} {
  const directories = new Set(options.directories);
  const deniedAccess = new Set(options.deniedAccess ?? []);
  const accessModesByPath = new Map<string, number[]>();

  return {
    accessModesByPath,
    probe: {
      async stat(path: string) {
        if (directories.has(path)) {
          return {
            isDirectory: () => true,
          };
        }

        throw createErrno("ENOENT", path);
      },
      async access(path: string, mode: number) {
        const calls = accessModesByPath.get(path) ?? [];
        calls.push(mode);
        accessModesByPath.set(path, calls);

        if (!directories.has(path) || deniedAccess.has(path)) {
          throw createErrno("EACCES", path);
        }
      },
    },
  };
}

function createErrno(code: string, path: string): NodeJS.ErrnoException {
  const error = new Error(`${code}: ${path}`) as NodeJS.ErrnoException;
  error.code = code;
  return error;
}


test("doctor orchestrator runs baseline checks in stable order and records smoke skip when not requested", async () => {
  const calls: string[] = [];
  const createCheck = (id: string) => async (): Promise<DoctorCheckResult> => {
    calls.push(id);
    return {
      id,
      label: id,
      severity: "pass",
      summary: `${id} ok`,
    };
  };

  const result = await runDoctor(
    {},
    {
      checkConfig: createCheck("config"),
      checkRuntime: createCheck("runtime"),
      checkLogs: createCheck("logs") as never,
      checkDaemon: createCheck("daemon"),
      checkOrphans: createCheck("orphans") as never,
      checkWechat: createCheck("wechat"),
      checkAcpx: createCheck("acpx"),
      checkBridge: createCheck("bridge"),
      checkPlugins: createCheck("plugins") as never,
      checkOrchestrationHealth: createCheck("orchestration"),
      checkOrchestrationSocket: createCheck("orchestration-socket") as never,
    },
  );

  expect(calls).toEqual([
    "config",
    "runtime",
    "logs",
    "daemon",
    "orphans",
    "wechat",
    "acpx",
    "bridge",
    "plugins",
    "orchestration",
    "orchestration-socket",
  ]);
  expect(result.report.checks.map((check) => check.id)).toEqual([
    "config",
    "runtime",
    "logs",
    "daemon",
    "orphans",
    "wechat",
    "acpx",
    "bridge",
    "plugins",
    "orchestration",
    "orchestration-socket",
    "smoke",
  ]);
  expect(result.report.checks.at(-1)).toMatchObject({
    id: "smoke",
    severity: "skip",
  });
});

test("runDoctor places the logs check after runtime and before daemon and honors the checkLogs override", async () => {
  let called = false;
  const result = await runDoctor(
    {},
    {
      checkConfig: async () => ({ id: "config", label: "Config", severity: "pass", summary: "ok" }),
      checkRuntime: async () => ({ id: "runtime", label: "Runtime", severity: "pass", summary: "ok" }),
      checkLogs: (async () => {
        called = true;
        return { id: "logs", label: "Logs", severity: "warn", summary: "log growth high" };
      }) as never,
      checkDaemon: async () => ({ id: "daemon", label: "Daemon", severity: "pass", summary: "ok" }),
      checkWechat: async () => ({ id: "wechat", label: "WeChat", severity: "pass", summary: "ok" }),
      checkAcpx: async () => ({ id: "acpx", label: "acpx", severity: "pass", summary: "ok" }),
      checkBridge: async () => ({ id: "bridge", label: "Bridge", severity: "pass", summary: "ok" }),
      checkPlugins: (async () => ({ id: "plugins", label: "Plugins", severity: "skip", summary: "skip" })) as never,
      checkOrchestrationHealth: async () => ({ id: "orchestration", label: "Orchestration", severity: "pass", summary: "ok" }),
      checkOrchestrationSocket: (async () => ({ id: "orchestration-socket", label: "Orchestration IPC", severity: "skip", summary: "skip" })) as never,
    },
  );

  expect(called).toBe(true);
  const ids = result.report.checks.map((check) => check.id);
  const runtimeIndex = ids.indexOf("runtime");
  const logsIndex = ids.indexOf("logs");
  const daemonIndex = ids.indexOf("daemon");
  expect(logsIndex).toBe(runtimeIndex + 1);
  expect(daemonIndex).toBe(logsIndex + 1);
  expect(result.report.checks.find((check) => check.id === "logs")).toMatchObject({
    severity: "warn",
    summary: "log growth high",
  });
});

test("doctor orchestrator runs the real smoke check only when --smoke is true", async () => {
  let smokeCalls = 0;

  const withoutSmoke = await runDoctor(
    {},
    {
      checkConfig: async () => ({ id: "config", label: "Config", severity: "pass", summary: "ok" }),
      checkRuntime: async () => ({ id: "runtime", label: "Runtime", severity: "pass", summary: "ok" }),
      checkDaemon: async () => ({ id: "daemon", label: "Daemon", severity: "pass", summary: "ok" }),
      checkWechat: async () => ({ id: "wechat", label: "WeChat", severity: "pass", summary: "ok" }),
      checkAcpx: async () => ({ id: "acpx", label: "acpx", severity: "pass", summary: "ok" }),
      checkBridge: async () => ({ id: "bridge", label: "Bridge", severity: "pass", summary: "ok" }),
      checkOrchestrationHealth: async () => ({ id: "orchestration", label: "Orchestration", severity: "pass", summary: "ok" }),
      checkSmoke: async () => {
        smokeCalls += 1;
        return { id: "smoke", label: "Smoke", severity: "pass", summary: "ok" };
      },
    },
  );

  const withSmoke = await runDoctor(
    { smoke: true },
    {
      checkConfig: async () => ({ id: "config", label: "Config", severity: "pass", summary: "ok" }),
      checkRuntime: async () => ({ id: "runtime", label: "Runtime", severity: "pass", summary: "ok" }),
      checkDaemon: async () => ({ id: "daemon", label: "Daemon", severity: "pass", summary: "ok" }),
      checkWechat: async () => ({ id: "wechat", label: "WeChat", severity: "pass", summary: "ok" }),
      checkAcpx: async () => ({ id: "acpx", label: "acpx", severity: "pass", summary: "ok" }),
      checkBridge: async () => ({ id: "bridge", label: "Bridge", severity: "pass", summary: "ok" }),
      checkOrchestrationHealth: async () => ({ id: "orchestration", label: "Orchestration", severity: "pass", summary: "ok" }),
      checkSmoke: async () => {
        smokeCalls += 1;
        return { id: "smoke", label: "Smoke", severity: "warn", summary: "probe ran" };
      },
    },
  );

  expect(smokeCalls).toBe(1);
  expect(withoutSmoke.report.checks.at(-1)).toMatchObject({ id: "smoke", severity: "skip" });
  expect(withSmoke.report.checks.at(-1)).toMatchObject({ id: "smoke", severity: "warn", summary: "probe ran" });
});

test("doctor orchestrator uses injected home coherently for runtime and config-based checks", async () => {
  const home = "/tmp/weacpx-alt-home";
  const seen = {
    configPath: undefined as string | undefined,
    runtimeHome: undefined as string | undefined,
    runtimeConfigPath: undefined as string | undefined,
    daemonHome: undefined as string | undefined,
    daemonConfigPath: undefined as string | undefined,
    acpxPath: undefined as string | undefined,
    bridgePath: undefined as string | undefined,
  };

  await runDoctor(
    {},
    {
      home,
      checkConfig: async (options) => {
        seen.configPath = options.resolveRuntimePaths?.().configPath;
        return { id: "config", label: "Config", severity: "pass", summary: "ok" };
      },
      checkRuntime: async (options) => {
        seen.runtimeHome = options.home;
        seen.runtimeConfigPath = options.configPath;
        return { id: "runtime", label: "Runtime", severity: "pass", summary: "ok" };
      },
      checkDaemon: async (options) => {
        seen.daemonHome = options.home;
        seen.daemonConfigPath = options.configPath;
        return { id: "daemon", label: "Daemon", severity: "pass", summary: "ok" };
      },
      checkWechat: async () => ({ id: "wechat", label: "WeChat", severity: "pass", summary: "ok" }),
      checkAcpx: async (options) => {
        seen.acpxPath = options.resolveRuntimePaths?.().configPath;
        return { id: "acpx", label: "acpx", severity: "pass", summary: "ok" };
      },
      checkBridge: async (options) => {
        seen.bridgePath = options.resolveRuntimePaths?.().configPath;
        return { id: "bridge", label: "Bridge", severity: "pass", summary: "ok" };
      },
      checkOrchestrationHealth: async () => ({ id: "orchestration", label: "Orchestration", severity: "pass", summary: "ok" }),
    },
  );

  expect(seen.runtimeHome).toBe(home);
  expect(seen.daemonHome).toBe(home);
  const expectedConfigPath = join(home, ".xacpx", "config.json");
  expect(seen.runtimeConfigPath).toBe(expectedConfigPath);
  expect(seen.daemonConfigPath).toBe(expectedConfigPath);
  expect(seen.configPath).toBe(expectedConfigPath);
  expect(seen.acpxPath).toBe(expectedConfigPath);
  expect(seen.bridgePath).toBe(expectedConfigPath);
});

test("doctor orchestrator returns exit code 1 when any check fails", async () => {
  const result = await runDoctor(
    {},
    {
      checkConfig: async () => ({ id: "config", label: "Config", severity: "pass", summary: "ok" }),
      checkRuntime: async () => ({ id: "runtime", label: "Runtime", severity: "fail", summary: "broken" }),
      checkLogs: (async () => ({ id: "logs", label: "Logs", severity: "skip", summary: "skip" })) as never,
      checkDaemon: async () => ({ id: "daemon", label: "Daemon", severity: "warn", summary: "warn" }),
      checkWechat: async () => ({ id: "wechat", label: "WeChat", severity: "pass", summary: "ok" }),
      checkAcpx: async () => ({ id: "acpx", label: "acpx", severity: "pass", summary: "ok" }),
      checkBridge: async () => ({ id: "bridge", label: "Bridge", severity: "skip", summary: "skip" }),
      checkPlugins: async () => ({ id: "plugins", label: "Plugins", severity: "skip", summary: "skip" }),
      checkOrchestrationHealth: async () => ({ id: "orchestration", label: "Orchestration", severity: "pass", summary: "ok" }),
      checkOrchestrationSocket: (async () => ({ id: "orchestration-socket", label: "Orchestration IPC", severity: "skip", summary: "skip" })) as never,
    },
  );

  expect(result.exitCode).toBe(1);
  expect(result.output).toContain("Summary: PASS 4, WARN 1, FAIL 1, SKIP 6");
});

test("doctor orchestrator returns exit code 0 when report only contains pass warn and skip", async () => {
  const result = await runDoctor(
    {},
    {
      checkConfig: async () => ({ id: "config", label: "Config", severity: "pass", summary: "ok" }),
      checkRuntime: async () => ({ id: "runtime", label: "Runtime", severity: "warn", summary: "warn" }),
      checkLogs: (async () => ({ id: "logs", label: "Logs", severity: "skip", summary: "skip" })) as never,
      checkDaemon: async () => ({ id: "daemon", label: "Daemon", severity: "pass", summary: "ok" }),
      checkWechat: async () => ({ id: "wechat", label: "WeChat", severity: "pass", summary: "ok" }),
      checkAcpx: async () => ({ id: "acpx", label: "acpx", severity: "pass", summary: "ok" }),
      checkBridge: async () => ({ id: "bridge", label: "Bridge", severity: "skip", summary: "skip" }),
      checkPlugins: async () => ({ id: "plugins", label: "Plugins", severity: "skip", summary: "skip" }),
      checkOrchestrationHealth: async () => ({ id: "orchestration", label: "Orchestration", severity: "pass", summary: "ok" }),
      checkOrchestrationSocket: (async () => ({ id: "orchestration-socket", label: "Orchestration IPC", severity: "skip", summary: "skip" })) as never,
    },
  );

  expect(result.exitCode).toBe(0);
  expect(result.output).toContain("Summary: PASS 5, WARN 1, FAIL 0, SKIP 6");
});

test("runDoctor includes the orchestration-health check result", async () => {
  let called = false;
  const result = await runDoctor(
    {},
    {
      checkConfig: async () => ({ id: "config", label: "Config", severity: "pass", summary: "ok" }),
      checkRuntime: async () => ({ id: "runtime", label: "Runtime", severity: "pass", summary: "ok" }),
      checkDaemon: async () => ({ id: "daemon", label: "Daemon", severity: "pass", summary: "ok" }),
      checkWechat: async () => ({ id: "wechat", label: "WeChat", severity: "pass", summary: "ok" }),
      checkAcpx: async () => ({ id: "acpx", label: "acpx", severity: "pass", summary: "ok" }),
      checkBridge: async () => ({ id: "bridge", label: "Bridge", severity: "pass", summary: "ok" }),
      checkOrchestrationHealth: async () => {
        called = true;
        return { id: "orchestration", label: "Orchestration", severity: "pass", summary: "orchestration state healthy" };
      },
    },
  );

  expect(called).toBe(true);
  expect(result.report.checks.some((c) => c.id === "orchestration")).toBe(true);
});

test("runDoctor places the plugins check between bridge and orchestration and honors the checkPlugins override", async () => {
  let called = false;
  const result = await runDoctor(
    {},
    {
      checkConfig: async () => ({ id: "config", label: "Config", severity: "pass", summary: "ok" }),
      checkRuntime: async () => ({ id: "runtime", label: "Runtime", severity: "pass", summary: "ok" }),
      checkDaemon: async () => ({ id: "daemon", label: "Daemon", severity: "pass", summary: "ok" }),
      checkWechat: async () => ({ id: "wechat", label: "WeChat", severity: "pass", summary: "ok" }),
      checkAcpx: async () => ({ id: "acpx", label: "acpx", severity: "pass", summary: "ok" }),
      checkBridge: async () => ({ id: "bridge", label: "Bridge", severity: "pass", summary: "ok" }),
      checkPlugins: (async () => {
        called = true;
        return { id: "plugins", label: "Plugins", severity: "warn", summary: "1 plugin issue(s)" };
      }) as never,
      checkOrchestrationHealth: async () => ({ id: "orchestration", label: "Orchestration", severity: "pass", summary: "ok" }),
    },
  );

  expect(called).toBe(true);
  const ids = result.report.checks.map((check) => check.id);
  const bridgeIndex = ids.indexOf("bridge");
  const pluginsIndex = ids.indexOf("plugins");
  const orchestrationIndex = ids.indexOf("orchestration");
  expect(pluginsIndex).toBe(bridgeIndex + 1);
  expect(orchestrationIndex).toBe(pluginsIndex + 1);
  expect(result.report.checks.find((check) => check.id === "plugins")).toMatchObject({
    severity: "warn",
    summary: "1 plugin issue(s)",
  });
});

test("runDoctor places the orchestration-socket check after orchestration and before smoke and honors the override", async () => {
  let called = false;
  const result = await runDoctor(
    {},
    {
      checkConfig: async () => ({ id: "config", label: "Config", severity: "pass", summary: "ok" }),
      checkRuntime: async () => ({ id: "runtime", label: "Runtime", severity: "pass", summary: "ok" }),
      checkDaemon: async () => ({ id: "daemon", label: "Daemon", severity: "pass", summary: "ok" }),
      checkWechat: async () => ({ id: "wechat", label: "WeChat", severity: "pass", summary: "ok" }),
      checkAcpx: async () => ({ id: "acpx", label: "acpx", severity: "pass", summary: "ok" }),
      checkBridge: async () => ({ id: "bridge", label: "Bridge", severity: "pass", summary: "ok" }),
      checkPlugins: (async () => ({ id: "plugins", label: "Plugins", severity: "skip", summary: "skip" })) as never,
      checkOrchestrationHealth: async () => ({ id: "orchestration", label: "Orchestration", severity: "pass", summary: "ok" }),
      checkOrchestrationSocket: (async () => {
        called = true;
        return { id: "orchestration-socket", label: "Orchestration IPC", severity: "fail", summary: "ipc down" };
      }) as never,
    },
  );

  expect(called).toBe(true);
  const ids = result.report.checks.map((check) => check.id);
  const orchestrationIndex = ids.indexOf("orchestration");
  const socketIndex = ids.indexOf("orchestration-socket");
  const smokeIndex = ids.indexOf("smoke");
  expect(socketIndex).toBe(orchestrationIndex + 1);
  expect(smokeIndex).toBe(socketIndex + 1);
  expect(result.report.checks.find((check) => check.id === "orchestration-socket")).toMatchObject({
    severity: "fail",
    summary: "ipc down",
  });
});

test("runDoctor skips orchestration-health instead of throwing when config cannot be loaded", async () => {
  const home = await createTempHome();
  const configPath = join(home, ".weacpx", "config.json");

  try {
    const result = await runDoctor(
      {},
      {
        home,
        loadConfig: async () => {
          throw createErrno("ENOENT", configPath);
        },
        checkRuntime: async () => ({ id: "runtime", label: "Runtime", severity: "pass", summary: "ok" }),
        checkDaemon: async () => ({ id: "daemon", label: "Daemon", severity: "pass", summary: "ok" }),
        checkWechat: async () => ({ id: "wechat", label: "WeChat", severity: "pass", summary: "ok" }),
      },
    );

    expect(result.report.checks.find((check) => check.id === "config")).toMatchObject({
      severity: "fail",
    });
    expect(result.report.checks.find((check) => check.id === "orchestration")).toMatchObject({
      severity: "skip",
      summary: "orchestration check skipped because configuration could not be loaded",
    });
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

function createStateDoctorStubs() {
  return {
    checkConfig: async () => ({ id: "config", label: "Config", severity: "pass", summary: "ok" }) as DoctorCheckResult,
    checkRuntime: async () => ({ id: "runtime", label: "Runtime", severity: "pass", summary: "ok" }) as DoctorCheckResult,
    checkLogs: (async () => ({ id: "logs", label: "Logs", severity: "skip", summary: "skip" })) as never,
    checkDaemon: async () => ({ id: "daemon", label: "Daemon", severity: "pass", summary: "ok" }) as DoctorCheckResult,
    checkWechat: async () => ({ id: "wechat", label: "WeChat", severity: "pass", summary: "ok" }) as DoctorCheckResult,
    checkAcpx: async () => ({ id: "acpx", label: "acpx", severity: "pass", summary: "ok" }) as DoctorCheckResult,
    checkBridge: async () => ({ id: "bridge", label: "Bridge", severity: "pass", summary: "ok" }) as DoctorCheckResult,
    checkPlugins: (async () => ({ id: "plugins", label: "Plugins", severity: "skip", summary: "skip" })) as never,
    checkOrchestrationSocket: (async () => ({ id: "orchestration-socket", label: "Orchestration IPC", severity: "skip", summary: "skip" })) as never,
    loadConfig: async () => ({ orchestration: { progressHeartbeatSeconds: 300 } }) as never,
  };
}

test("doctor surfaces invalid state records as a warning without mutating state.json", async () => {
  const home = await createTempHome();
  const rootDir = join(home, ".xacpx");
  const statePath = join(rootDir, "state.json");
  const original = JSON.stringify({
    sessions: { bad: { alias: "bad" } },
    chat_contexts: {},
  });

  try {
    await mkdir(rootDir, { recursive: true });
    await writeFile(statePath, original, "utf8");

    const result = await runDoctor({}, { home, ...createStateDoctorStubs() });

    const orchestration = result.report.checks.find((check) => check.id === "orchestration");
    expect(orchestration?.severity).toBe("warn");
    expect(orchestration?.summary).toContain("state.json");
    const details = orchestration?.details?.join("\n") ?? "";
    expect(details).toContain('sessions["bad"]');
    expect(details).toContain("malformed session record");
    // diagnostic command must be side-effect-free: no quarantine, no rename
    expect(await readFile(statePath, "utf8")).toBe(original);
    expect(await readdir(rootDir)).toEqual(["state.json"]);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("doctor warns on an unreadable state.json without renaming it", async () => {
  const home = await createTempHome();
  const rootDir = join(home, ".xacpx");
  const statePath = join(rootDir, "state.json");

  try {
    await mkdir(rootDir, { recursive: true });
    await writeFile(statePath, "{not-json", "utf8");

    const result = await runDoctor({}, { home, ...createStateDoctorStubs() });

    const orchestration = result.report.checks.find((check) => check.id === "orchestration");
    expect(orchestration?.severity).toBe("warn");
    expect(orchestration?.details?.join("\n") ?? "").toContain("invalid JSON");
    expect(await readFile(statePath, "utf8")).toBe("{not-json");
    expect(await readdir(rootDir)).toEqual(["state.json"]);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

function createFixDoctorStubs() {
  return {
    checkConfig: async () => ({ id: "config", label: "Config", severity: "pass", summary: "ok" }) as DoctorCheckResult,
    checkRuntime: async () => ({ id: "runtime", label: "Runtime", severity: "pass", summary: "ok" }) as DoctorCheckResult,
    checkLogs: (async () => ({ id: "logs", label: "Logs", severity: "skip", summary: "skip" })) as never,
    checkDaemon: async () => ({ id: "daemon", label: "Daemon", severity: "pass", summary: "ok" }) as DoctorCheckResult,
    checkWechat: async () => ({ id: "wechat", label: "WeChat", severity: "pass", summary: "ok" }) as DoctorCheckResult,
    checkAcpx: async () => ({ id: "acpx", label: "acpx", severity: "pass", summary: "ok" }) as DoctorCheckResult,
    checkBridge: async () => ({ id: "bridge", label: "Bridge", severity: "pass", summary: "ok" }) as DoctorCheckResult,
    checkPlugins: (async () => ({ id: "plugins", label: "Plugins", severity: "skip", summary: "skip" })) as never,
    checkOrchestrationHealth: async () => ({ id: "orchestration", label: "Orchestration", severity: "pass", summary: "ok" }) as DoctorCheckResult,
    checkOrchestrationSocket: (async () => ({ id: "orchestration-socket", label: "Orchestration IPC", severity: "skip", summary: "skip" })) as never,
  };
}

test("doctor does not run fixes unless options.fix is true", async () => {
  let ran = false;
  const result = await runDoctor(
    {},
    {
      ...createFixDoctorStubs(),
      checkRuntime: async () => ({
        id: "runtime",
        label: "Runtime",
        severity: "fail",
        summary: "broken",
        fixes: [
          {
            id: "runtime.repair",
            title: "repair runtime",
            run: async () => {
              ran = true;
              return { ok: true, message: "repaired" };
            },
          },
        ],
      }),
    },
  );

  expect(ran).toBe(false);
  expect(result.report.repairs ?? []).toEqual([]);
  expect(result.exitCode).toBe(1);
});

test("doctor records a withheld fix as skipped and never invokes run()", async () => {
  let ran = false;
  const result = await runDoctor(
    { fix: true },
    {
      ...createFixDoctorStubs(),
      checkDaemon: async () => ({
        id: "daemon",
        label: "Daemon",
        severity: "warn",
        summary: "stale",
        fixes: [
          {
            id: "daemon.clear",
            title: "clear stale runtime",
            withheld: "stop the daemon first: xacpx stop",
            run: async () => {
              ran = true;
              return { ok: true, message: "cleared" };
            },
          },
        ],
      }),
    },
  );

  expect(ran).toBe(false);
  expect(result.report.repairs).toEqual([
    {
      checkId: "daemon",
      fixId: "daemon.clear",
      title: "clear stale runtime",
      status: "skipped",
      message: "stop the daemon first: xacpx stop",
    },
  ]);
});

test("doctor applies a fix and re-runs only the affected check", async () => {
  let runtimeCalls = 0;
  let daemonCalls = 0;

  const result = await runDoctor(
    { fix: true },
    {
      ...createFixDoctorStubs(),
      checkRuntime: async () => {
        runtimeCalls += 1;
        if (runtimeCalls === 1) {
          return {
            id: "runtime",
            label: "Runtime",
            severity: "fail",
            summary: "broken",
            fixes: [
              {
                id: "runtime.repair",
                title: "repair runtime",
                run: async () => ({ ok: true, message: "repaired" }),
              },
            ],
          };
        }
        return { id: "runtime", label: "Runtime", severity: "pass", summary: "fixed" };
      },
      checkDaemon: async () => {
        daemonCalls += 1;
        return { id: "daemon", label: "Daemon", severity: "pass", summary: "ok" };
      },
    },
  );

  expect(runtimeCalls).toBe(2);
  expect(daemonCalls).toBe(1);
  const runtime = result.report.checks.find((check) => check.id === "runtime");
  expect(runtime).toMatchObject({ severity: "pass", summary: "fixed" });
  expect(result.report.repairs).toEqual([
    {
      checkId: "runtime",
      fixId: "runtime.repair",
      title: "repair runtime",
      status: "applied",
      message: "repaired",
    },
  ]);
  expect(result.exitCode).toBe(0);
});

test("doctor captures a throwing fix as failed without crashing", async () => {
  let runtimeCalls = 0;
  const result = await runDoctor(
    { fix: true },
    {
      ...createFixDoctorStubs(),
      checkRuntime: async () => {
        runtimeCalls += 1;
        return {
          id: "runtime",
          label: "Runtime",
          severity: "fail",
          summary: "broken",
          fixes: [
            {
              id: "runtime.repair",
              title: "repair runtime",
              run: async () => {
                throw new Error("boom");
              },
            },
          ],
        };
      },
    },
  );

  // a failed (not applied) fix does not trigger a re-run
  expect(runtimeCalls).toBe(1);
  expect(result.report.repairs).toEqual([
    {
      checkId: "runtime",
      fixId: "runtime.repair",
      title: "repair runtime",
      status: "failed",
      message: "boom",
    },
  ]);
  expect(result.exitCode).toBe(1);
});

test("doctor records an outcome with ok false as failed", async () => {
  const result = await runDoctor(
    { fix: true },
    {
      ...createFixDoctorStubs(),
      checkRuntime: async () => ({
        id: "runtime",
        label: "Runtime",
        severity: "fail",
        summary: "broken",
        fixes: [
          {
            id: "runtime.repair",
            title: "repair runtime",
            run: async () => ({ ok: false, message: "could not repair" }),
          },
        ],
      }),
    },
  );

  expect(result.report.repairs).toEqual([
    {
      checkId: "runtime",
      fixId: "runtime.repair",
      title: "repair runtime",
      status: "failed",
      message: "could not repair",
    },
  ]);
  expect(result.exitCode).toBe(1);
});

test("doctor handles a mixed fixes array: skips the withheld one and applies the runnable one", async () => {
  let runtimeCalls = 0;
  let withheldRan = false;

  const result = await runDoctor(
    { fix: true },
    {
      ...createFixDoctorStubs(),
      checkRuntime: async () => {
        runtimeCalls += 1;
        if (runtimeCalls === 1) {
          return {
            id: "runtime",
            label: "Runtime",
            severity: "fail",
            summary: "broken",
            fixes: [
              {
                id: "runtime.withheld",
                title: "withheld fix",
                withheld: "stop the daemon first",
                run: async () => {
                  withheldRan = true;
                  return { ok: true, message: "should not run" };
                },
              },
              {
                id: "runtime.repair",
                title: "repair runtime",
                run: async () => ({ ok: true, message: "repaired" }),
              },
            ],
          };
        }
        return { id: "runtime", label: "Runtime", severity: "pass", summary: "fixed" };
      },
    },
  );

  expect(withheldRan).toBe(false);
  // re-run exactly once despite two fixes on the check
  expect(runtimeCalls).toBe(2);
  expect(result.report.repairs).toEqual([
    {
      checkId: "runtime",
      fixId: "runtime.withheld",
      title: "withheld fix",
      status: "skipped",
      message: "stop the daemon first",
    },
    {
      checkId: "runtime",
      fixId: "runtime.repair",
      title: "repair runtime",
      status: "applied",
      message: "repaired",
    },
  ]);
  expect(result.report.checks.find((check) => check.id === "runtime")).toMatchObject({
    severity: "pass",
    summary: "fixed",
  });
  expect(result.exitCode).toBe(0);
});

test("doctor re-runs every check that applied a fix", async () => {
  let runtimeCalls = 0;
  let daemonCalls = 0;

  const result = await runDoctor(
    { fix: true },
    {
      ...createFixDoctorStubs(),
      checkRuntime: async () => {
        runtimeCalls += 1;
        if (runtimeCalls === 1) {
          return {
            id: "runtime",
            label: "Runtime",
            severity: "fail",
            summary: "broken",
            fixes: [
              {
                id: "runtime.repair",
                title: "repair runtime",
                run: async () => ({ ok: true, message: "runtime repaired" }),
              },
            ],
          };
        }
        return { id: "runtime", label: "Runtime", severity: "pass", summary: "runtime fixed" };
      },
      checkDaemon: async () => {
        daemonCalls += 1;
        if (daemonCalls === 1) {
          return {
            id: "daemon",
            label: "Daemon",
            severity: "warn",
            summary: "stale",
            fixes: [
              {
                id: "daemon.clear",
                title: "clear stale runtime",
                run: async () => ({ ok: true, message: "daemon cleared" }),
              },
            ],
          };
        }
        return { id: "daemon", label: "Daemon", severity: "pass", summary: "daemon fixed" };
      },
    },
  );

  expect(runtimeCalls).toBe(2);
  expect(daemonCalls).toBe(2);
  expect(result.report.checks.find((check) => check.id === "runtime")).toMatchObject({
    severity: "pass",
    summary: "runtime fixed",
  });
  expect(result.report.checks.find((check) => check.id === "daemon")).toMatchObject({
    severity: "pass",
    summary: "daemon fixed",
  });
  expect(result.report.repairs).toEqual([
    {
      checkId: "runtime",
      fixId: "runtime.repair",
      title: "repair runtime",
      status: "applied",
      message: "runtime repaired",
    },
    {
      checkId: "daemon",
      fixId: "daemon.clear",
      title: "clear stale runtime",
      status: "applied",
      message: "daemon cleared",
    },
  ]);
  expect(result.exitCode).toBe(0);
});

test("doctor re-runs a check exactly once even when it applies two fixes", async () => {
  let runtimeCalls = 0;

  const result = await runDoctor(
    { fix: true },
    {
      ...createFixDoctorStubs(),
      checkRuntime: async () => {
        runtimeCalls += 1;
        if (runtimeCalls === 1) {
          return {
            id: "runtime",
            label: "Runtime",
            severity: "fail",
            summary: "broken",
            fixes: [
              {
                id: "runtime.repair-a",
                title: "repair runtime a",
                run: async () => ({ ok: true, message: "repaired a" }),
              },
              {
                id: "runtime.repair-b",
                title: "repair runtime b",
                run: async () => ({ ok: true, message: "repaired b" }),
              },
            ],
          };
        }
        return { id: "runtime", label: "Runtime", severity: "pass", summary: "fixed" };
      },
    },
  );

  // both fixes applied, but the dedup keeps the re-run to a single invocation
  expect(runtimeCalls).toBe(2);
  expect(result.report.repairs).toEqual([
    {
      checkId: "runtime",
      fixId: "runtime.repair-a",
      title: "repair runtime a",
      status: "applied",
      message: "repaired a",
    },
    {
      checkId: "runtime",
      fixId: "runtime.repair-b",
      title: "repair runtime b",
      status: "applied",
      message: "repaired b",
    },
  ]);
  expect(result.exitCode).toBe(0);
});

test("doctor index main runs orchestrator and prints rendered output", async () => {
  const lines: string[] = [];
  const restore = console.log;
  const log = mock((line: string) => {
    lines.push(line);
  });
  console.log = log as typeof console.log;

  try {
    const exitCode = await doctorMain(
      {},
      {
        runDoctor: async () => ({
          report: {
            checks: [],
          },
          output: ["PASS Config: ok", "Summary: PASS 1, WARN 0, FAIL 0, SKIP 0"],
          exitCode: 0,
        }),
      },
    );

    expect(exitCode).toBe(0);
    expect(lines).toEqual(["PASS Config: ok", "Summary: PASS 1, WARN 0, FAIL 0, SKIP 0"]);
  } finally {
    console.log = restore;
  }
});

test("orchestration check attaches state.quarantine fix when daemon is stopped and a state record is invalid", async () => {
  const home = await createTempHome();
  const rootDir = join(home, ".xacpx");
  const statePath = join(rootDir, "state.json");
  const original = JSON.stringify({ sessions: { bad: { alias: "bad" } }, chat_contexts: {} });

  try {
    await mkdir(rootDir, { recursive: true });
    await writeFile(statePath, original, "utf8");

    const result = await runDoctor(
      {},
      { home, ...createStateDoctorStubs(), isDaemonRunning: async () => false },
    );

    const orchestration = result.report.checks.find((check) => check.id === "orchestration");
    const fix = orchestration?.fixes?.find((entry) => entry.id === "state.quarantine");
    expect(fix).toBeDefined();
    expect(fix?.withheld).toBeUndefined();

    // run() performs the real quarantine via StateStore.load(): records dropped,
    // original backed up, state.json rewritten on the next save cycle.
    const outcome = await fix!.run();
    expect(outcome.ok).toBe(true);
    const backups = (await readdir(rootDir)).filter((name) => name.includes("quarantine"));
    expect(backups.length).toBeGreaterThan(0);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("orchestration check withholds state.quarantine fix and does not mutate when the daemon is running", async () => {
  const home = await createTempHome();
  const rootDir = join(home, ".xacpx");
  const statePath = join(rootDir, "state.json");
  const original = JSON.stringify({ sessions: { bad: { alias: "bad" } }, chat_contexts: {} });

  try {
    await mkdir(rootDir, { recursive: true });
    await writeFile(statePath, original, "utf8");

    const result = await runDoctor(
      {},
      { home, ...createStateDoctorStubs(), isDaemonRunning: async () => true },
    );

    const orchestration = result.report.checks.find((check) => check.id === "orchestration");
    const fix = orchestration?.fixes?.find((entry) => entry.id === "state.quarantine");
    expect(fix).toBeDefined();
    expect(fix?.withheld).toBe("stop the daemon first: xacpx stop");

    // Detection alone must never mutate; the running daemon owns state.json.
    expect(await readFile(statePath, "utf8")).toBe(original);
    expect(await readdir(rootDir)).toEqual(["state.json"]);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("orchestration check attaches no state.quarantine fix when state.json is valid", async () => {
  const home = await createTempHome();
  const rootDir = join(home, ".xacpx");
  const statePath = join(rootDir, "state.json");

  try {
    await mkdir(rootDir, { recursive: true });
    await writeFile(statePath, JSON.stringify({ sessions: {}, chat_contexts: {} }), "utf8");

    const result = await runDoctor(
      {},
      { home, ...createStateDoctorStubs(), isDaemonRunning: async () => false },
    );

    const orchestration = result.report.checks.find((check) => check.id === "orchestration");
    expect(orchestration?.fixes?.some((entry) => entry.id === "state.quarantine") ?? false).toBe(false);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("default daemon-liveness mapping withholds the quarantine fix for an indeterminate (live) daemon", async () => {
  const home = await createTempHome();
  const rootDir = join(home, ".xacpx");
  const statePath = join(rootDir, "state.json");
  const original = JSON.stringify({ sessions: { bad: { alias: "bad" } }, chat_contexts: {} });

  try {
    await mkdir(rootDir, { recursive: true });
    await writeFile(statePath, original, "utf8");

    // Exercise the DEFAULT liveness mapping (not the isDaemonRunning boolean):
    // an "indeterminate" status is a LIVE daemon, so the fix must be withheld.
    const result = await runDoctor(
      {},
      { home, ...createStateDoctorStubs(), getDaemonStatus: async () => ({ state: "indeterminate" }) },
    );

    const orchestration = result.report.checks.find((check) => check.id === "orchestration");
    const fix = orchestration?.fixes?.find((entry) => entry.id === "state.quarantine");
    expect(fix).toBeDefined();
    expect(fix?.withheld).toBe("stop the daemon first: xacpx stop");

    // The check must not mutate state.json while a live daemon owns it.
    expect(await readFile(statePath, "utf8")).toBe(original);
    expect(await readdir(rootDir)).toEqual(["state.json"]);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("default daemon-liveness mapping allows the quarantine fix for a stopped daemon", async () => {
  const home = await createTempHome();
  const rootDir = join(home, ".xacpx");
  const statePath = join(rootDir, "state.json");
  const original = JSON.stringify({ sessions: { bad: { alias: "bad" } }, chat_contexts: {} });

  try {
    await mkdir(rootDir, { recursive: true });
    await writeFile(statePath, original, "utf8");

    const result = await runDoctor(
      {},
      { home, ...createStateDoctorStubs(), getDaemonStatus: async () => ({ state: "stopped" }) },
    );

    const orchestration = result.report.checks.find((check) => check.id === "orchestration");
    const fix = orchestration?.fixes?.find((entry) => entry.id === "state.quarantine");
    expect(fix).toBeDefined();
    expect(fix?.withheld).toBeUndefined();
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("state.quarantine run() re-verifies liveness and refuses when a daemon started after detection", async () => {
  const home = await createTempHome();
  const rootDir = join(home, ".xacpx");
  const statePath = join(rootDir, "state.json");
  const original = JSON.stringify({ sessions: { bad: { alias: "bad" } }, chat_contexts: {} });

  try {
    await mkdir(rootDir, { recursive: true });
    await writeFile(statePath, original, "utf8");

    // Daemon is stopped at detection time (fix attached, not withheld), but has
    // started by the time the fix is applied — the TOCTOU window.
    let liveness = false;
    const result = await runDoctor(
      {},
      { home, ...createStateDoctorStubs(), isDaemonRunning: async () => liveness },
    );

    const orchestration = result.report.checks.find((check) => check.id === "orchestration");
    const fix = orchestration?.fixes?.find((entry) => entry.id === "state.quarantine");
    expect(fix).toBeDefined();
    expect(fix?.withheld).toBeUndefined();

    liveness = true;
    const outcome = await fix!.run();
    expect(outcome.ok).toBe(false);
    expect(outcome.message).toContain("xacpx stop");

    // The refused repair must not have touched state.json.
    expect(await readFile(statePath, "utf8")).toBe(original);
    expect(await readdir(rootDir)).toEqual(["state.json"]);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
