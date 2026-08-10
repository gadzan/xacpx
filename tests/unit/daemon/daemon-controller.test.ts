import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { DaemonController } from "../../../src/daemon/daemon-controller";
import { type DaemonPaths } from "../../../src/daemon/daemon-files";
import { DaemonStatusStore } from "../../../src/daemon/daemon-status";
import { OrphanRegistry } from "../../../src/transport/orphan-registry";

test("reports stopped when no pid or status files exist", async () => {
  const dir = await mkdtemp(join(tmpdir(), "weacpx-daemon-controller-"));
  const controller = createController(dir);

  await expect(controller.getStatus()).resolves.toEqual({
    state: "stopped",
  });

  await rm(dir, { recursive: true, force: true });
});

test("Windows stop uses four-state identity fencing and never kills a reused pid", async () => {
  const dir = await mkdtemp(join(tmpdir(), "weacpx-daemon-stop-win-"));
  const registry = new OrphanRegistry(dir);
  await registry.initialize();
  await registry.writeGeneration({
    generationId: "33333333-3333-4333-8333-333333333333",
    daemonPid: 12345,
    daemonCreationDate: "133801632000000000",
    configRoot: dir,
  });
  await writeFile(join(dir, "daemon.pid"), "12345\n");
  let killed = false;
  let released = false;
  const controller = new DaemonController(pathsFor(dir), {
    platform: "win32",
    configRoot: dir,
    isProcessRunning: () => true,
    spawnDetached: async () => 1,
    terminateProcess: async () => {},
    acquireLifecycleGuard: async () => ({ release: async () => { released = true; } }),
    orphanRegistry: registry,
    probeWindowsIdentity: async () => ({ status: "found", identity: {
      pid: 12345,
      creationDate: "133801632000000001",
      executablePath: "C:\\unrelated.exe",
    } }),
    terminateWindowsTree: async () => { killed = true; throw new Error("must not kill reused pid"); },
    sweepWindows: async () => emptySweep(),
  });
  await expect(controller.stop()).resolves.toEqual({ state: "stopped", detail: "stopped" });
  expect(killed).toBe(false);
  expect(released).toBe(true);
  expect(await registry.readGeneration()).toBeNull();
});

test("Windows stop adopts a verified daemon started before durable identities were introduced", async () => {
  const fixture = await createLegacyWindowsStopFixture();

  await expect(fixture.controller.stop()).resolves.toEqual({ state: "stopped", detail: "stopped" });
  expect(fixture.terminationRoots).toEqual([{
    pid: fixture.pid,
    creationDate: "133801632000000000",
    executablePath: "C:\\Program Files\\nodejs\\node.exe",
  }]);
  expect(await fixture.registry.readGeneration()).toBeNull();

  await rm(fixture.dir, { recursive: true, force: true });
});

test("Windows stop refuses legacy adoption when the handle-bound executable does not match the daemon command", async () => {
  const fixture = await createLegacyWindowsStopFixture({
    identityExecutablePath: "C:\\Windows\\System32\\not-node.exe",
  });

  await expect(fixture.controller.stop()).rejects.toThrow("durable daemon identity is missing or inconsistent");
  expect(fixture.terminationRoots).toEqual([]);
  expect(await fixture.registry.readGeneration()).toBeNull();

  await rm(fixture.dir, { recursive: true, force: true });
});

test("Windows stop refuses to adopt a legacy generation recorded for a different pid", async () => {
  const fixture = await createLegacyWindowsStopFixture({ generationDaemonPid: 11111 });

  await expect(fixture.controller.stop()).rejects.toThrow("durable daemon identity is missing or inconsistent");
  expect(fixture.terminationRoots).toEqual([]);
  expect(await fixture.registry.readGeneration()).toMatchObject({ daemonPid: 11111, daemonCreationDate: null });

  await rm(fixture.dir, { recursive: true, force: true });
});

test("Windows stop refuses to adopt a legacy generation recorded for a different config root", async () => {
  const fixture = await createLegacyWindowsStopFixture({
    generationConfigRoot: "C:\\Users\\other\\.xacpx",
  });

  await expect(fixture.controller.stop()).rejects.toThrow("durable daemon identity is missing or inconsistent");
  expect(fixture.terminationRoots).toEqual([]);
  expect(await fixture.registry.readGeneration()).toMatchObject({
    daemonPid: fixture.pid,
    daemonCreationDate: null,
    configRoot: "C:\\Users\\other\\.xacpx",
  });

  await rm(fixture.dir, { recursive: true, force: true });
});

test("Windows stop retains frozen evidence when identity or tree termination is unconfirmed", async () => {
  for (const mode of ["identity", "termination"] as const) {
    const dir = await mkdtemp(join(tmpdir(), "weacpx-daemon-stop-win-"));
    const registry = new OrphanRegistry(dir);
    await registry.initialize();
    await registry.writeGeneration({
      generationId: "33333333-3333-4333-8333-333333333333",
      daemonPid: 12345,
      daemonCreationDate: "133801632000000000",
      configRoot: dir,
    });
    await writeFile(join(dir, "daemon.pid"), "12345\n");
    const controller = new DaemonController(pathsFor(dir), {
      platform: "win32",
      configRoot: dir,
      isProcessRunning: () => true,
      spawnDetached: async () => 1,
      terminateProcess: async () => {},
      acquireLifecycleGuard: async () => ({ release: async () => {} }),
      orphanRegistry: registry,
      probeWindowsIdentity: async () => mode === "identity" ? { status: "unavailable" } : {
        status: "found",
        identity: { pid: 12345, creationDate: "133801632000000000", executablePath: "C:\\node.exe" },
      },
      terminateWindowsTree: async () => ({
        rootOutcome: "kill-requested-unconfirmed",
        outcomes: [{ target: { pid: 12345, creationDate: "133801632000000000" }, outcome: "kill-requested-unconfirmed" }],
      }),
      sweepWindows: async () => emptySweep(),
    });
    await expect(controller.stop()).rejects.toThrow(mode === "identity" ? "identity is unavailable" : "not fully confirmed");
    expect((await registry.readGeneration())?.terminating).toBe(true);
    expect(await readFile(join(dir, "daemon.pid"), "utf8")).toBe("12345\n");
  }
});

test("reports running when pid is alive and status exists", async () => {
  const dir = await mkdtemp(join(tmpdir(), "weacpx-daemon-controller-"));
  const controller = createController(dir, {
    isProcessRunning: (pid) => pid === 12345,
  });
  await writeFile(join(dir, "daemon.pid"), "12345\n");
  await new DaemonStatusStore(join(dir, "status.json")).save({
    pid: 12345,
    started_at: "2026-03-26T00:00:00.000Z",
    heartbeat_at: "2026-03-26T00:01:00.000Z",
    config_path: "/cfg",
    state_path: "/state",
    app_log: "/app",
    stdout_log: "/out",
    stderr_log: "/err",
  });

  await expect(controller.getStatus()).resolves.toMatchObject({
    state: "running",
    pid: 12345,
    status: {
      config_path: "/cfg",
    },
  });

  await rm(dir, { recursive: true, force: true });
});


test("reports indeterminate when pid is alive but status metadata is missing", async () => {
  const dir = await mkdtemp(join(tmpdir(), "weacpx-daemon-controller-"));
  const controller = createController(dir, {
    isProcessRunning: (pid) => pid === 12345,
  });
  await writeFile(join(dir, "daemon.pid"), "12345\n");

  await expect(controller.getStatus()).resolves.toEqual({
    state: "indeterminate",
    pid: 12345,
    reason: "missing-status",
  });

  await rm(dir, { recursive: true, force: true });
});

test("pid/status disagreement stays indeterminate and cannot spawn or terminate", async () => {
  const dir = await mkdtemp(join(tmpdir(), "weacpx-daemon-controller-"));
  let spawned = false;
  let terminated = false;
  const controller = createController(dir, {
    isProcessRunning: (pid) => pid === 12345 || pid === 54321,
    spawnDetached: async () => { spawned = true; return 99999; },
    terminateProcess: async () => { terminated = true; },
  });
  await writeFile(join(dir, "daemon.pid"), "12345\n");
  await new DaemonStatusStore(join(dir, "status.json")).save({
    pid: 54321,
    started_at: "2026-03-26T00:00:00.000Z",
    heartbeat_at: "2026-03-26T00:01:00.000Z",
    config_path: join(dir, "config.json"),
    state_path: join(dir, "state.json"),
    app_log: "/app",
    stdout_log: "/out",
    stderr_log: "/err",
  });

  await expect(controller.getStatus()).resolves.toEqual({
    state: "indeterminate",
    pid: 12345,
    reason: "pid-mismatch",
  });
  await expect(controller.start()).rejects.toThrow("daemon metadata is incomplete or inconsistent");
  await expect(controller.stop()).rejects.toThrow("daemon metadata is incomplete or inconsistent");
  expect(spawned).toBe(false);
  expect(terminated).toBe(false);

  await rm(dir, { recursive: true, force: true });
});

test("reports a fresh status-only live daemon without mutating runtime metadata", async () => {
  const dir = await mkdtemp(join(tmpdir(), "weacpx-daemon-controller-"));
  const controller = createController(dir, {
    isProcessRunning: (pid) => pid === 12345,
    now: () => Date.parse("2026-03-26T00:01:30.000Z"),
  });
  await new DaemonStatusStore(join(dir, "status.json")).save({
    pid: 12345,
    started_at: "2026-03-26T00:00:00.000Z",
    heartbeat_at: "2026-03-26T00:01:00.000Z",
    config_path: join(dir, "config.json"),
    state_path: join(dir, "state.json"),
    app_log: "/app",
    stdout_log: "/out",
    stderr_log: "/err",
  });

  await expect(controller.getStatus()).resolves.toEqual({
    state: "indeterminate",
    pid: 12345,
    reason: "missing-pid",
  });
  await expect(Bun.file(join(dir, "daemon.pid")).exists()).resolves.toBe(false);

  await rm(dir, { recursive: true, force: true });
});

test("keeps a status-only daemon indeterminate when its heartbeat is stale", async () => {
  const dir = await mkdtemp(join(tmpdir(), "weacpx-daemon-controller-"));
  const controller = createController(dir, {
    isProcessRunning: (pid) => pid === 12345,
    now: () => Date.parse("2026-03-26T00:03:00.001Z"),
  });
  await new DaemonStatusStore(join(dir, "status.json")).save({
    pid: 12345,
    started_at: "2026-03-26T00:00:00.000Z",
    heartbeat_at: "2026-03-26T00:01:00.000Z",
    config_path: join(dir, "config.json"),
    state_path: join(dir, "state.json"),
    app_log: "/app",
    stdout_log: "/out",
    stderr_log: "/err",
  });

  await expect(controller.getStatus()).resolves.toEqual({
    state: "indeterminate",
    pid: 12345,
    reason: "missing-pid",
  });
  await expect(Bun.file(join(dir, "daemon.pid")).exists()).resolves.toBe(false);

  await rm(dir, { recursive: true, force: true });
});

test("treats dead pid files as stale and clears runtime files", async () => {
  const dir = await mkdtemp(join(tmpdir(), "weacpx-daemon-controller-"));
  const controller = createController(dir, {
    isProcessRunning: () => false,
  });
  await writeFile(join(dir, "daemon.pid"), "12345\n");
  await new DaemonStatusStore(join(dir, "status.json")).save({
    pid: 12345,
    started_at: "2026-03-26T00:00:00.000Z",
    heartbeat_at: "2026-03-26T00:01:00.000Z",
    config_path: "/cfg",
    state_path: "/state",
    app_log: "/app",
    stdout_log: "/out",
    stderr_log: "/err",
  });

  await expect(controller.getStatus()).resolves.toEqual({
    state: "stopped",
    stale: true,
  });

  await expect(Bun.file(join(dir, "daemon.pid")).exists()).resolves.toBe(false);
  await expect(Bun.file(join(dir, "status.json")).exists()).resolves.toBe(false);

  await rm(dir, { recursive: true, force: true });
});

test("start reports already running without spawning again", async () => {
  const dir = await mkdtemp(join(tmpdir(), "weacpx-daemon-controller-"));
  let spawned = false;
  const controller = createController(dir, {
    isProcessRunning: (pid) => pid === 22222,
    spawnDetached: async () => {
      spawned = true;
      return 33333;
    },
  });
  await writeFile(join(dir, "daemon.pid"), "22222\n");
  await new DaemonStatusStore(join(dir, "status.json")).save({
    pid: 22222,
    started_at: "2026-03-26T00:00:00.000Z",
    heartbeat_at: "2026-03-26T00:01:00.000Z",
    config_path: "/cfg",
    state_path: "/state",
    app_log: "/app",
    stdout_log: "/out",
    stderr_log: "/err",
  });

  await expect(controller.start()).resolves.toEqual({
    state: "already-running",
    pid: 22222,
  });
  expect(spawned).toBe(false);

  await rm(dir, { recursive: true, force: true });
});


test("start refuses to spawn a second daemon when pid is alive but status metadata is missing", async () => {
  const dir = await mkdtemp(join(tmpdir(), "weacpx-daemon-controller-"));
  let spawned = false;
  const controller = createController(dir, {
    isProcessRunning: (pid) => pid === 22222,
    spawnDetached: async () => {
      spawned = true;
      return 33333;
    },
  });
  await writeFile(join(dir, "daemon.pid"), "22222\n");

  await expect(controller.start()).rejects.toThrow("daemon metadata is incomplete or inconsistent");
  expect(spawned).toBe(false);

  await rm(dir, { recursive: true, force: true });
});

test("start refuses a fresh status-only live daemon without spawning or repairing metadata", async () => {
  const dir = await mkdtemp(join(tmpdir(), "weacpx-daemon-controller-"));
  let spawned = false;
  const controller = createController(dir, {
    isProcessRunning: (pid) => pid === 22222,
    now: () => Date.parse("2026-03-26T00:01:30.000Z"),
    spawnDetached: async () => {
      spawned = true;
      return 33333;
    },
  });
  await new DaemonStatusStore(join(dir, "status.json")).save({
    pid: 22222,
    started_at: "2026-03-26T00:00:00.000Z",
    heartbeat_at: "2026-03-26T00:01:00.000Z",
    config_path: join(dir, "config.json"),
    state_path: join(dir, "state.json"),
    app_log: "/app",
    stdout_log: "/out",
    stderr_log: "/err",
  });

  await expect(controller.start()).rejects.toThrow("daemon metadata is incomplete or inconsistent");
  expect(spawned).toBe(false);
  await expect(Bun.file(join(dir, "daemon.pid")).exists()).resolves.toBe(false);

  await rm(dir, { recursive: true, force: true });
});

test("start waits for daemon status metadata before returning", async () => {
  const dir = await mkdtemp(join(tmpdir(), "weacpx-daemon-controller-"));
  const statusStore = new DaemonStatusStore(join(dir, "status.json"));
  let checks = 0;
  // Deterministic status write: fire it after the 3rd poll rather than on a
  // wall-clock timer. The production loop (waitForStartupMetadata) checks
  // status BEFORE calling onStartupPoll, so the 4th poll sees the saved
  // status and start() resolves. This removes the 20ms setTimeout + 200ms
  // timeout race that flaked under parallel CI load.
  let releaseStatus!: () => void;
  const statusReady = new Promise<void>((resolve) => {
    releaseStatus = resolve;
  });

  const controller = createController(dir, {
    isProcessRunning: (pid) => pid === 44444,
    spawnDetached: async () => {
      void statusReady.then(() =>
        statusStore.save({
          pid: 44444,
          started_at: "2026-03-26T00:00:00.000Z",
          heartbeat_at: "2026-03-26T00:01:00.000Z",
          config_path: "/cfg",
          state_path: "/state",
          app_log: "/app",
          stdout_log: "/out",
          stderr_log: "/err",
        }),
      );
      return 44444;
    },
    startupPollIntervalMs: 5,
    startupTimeoutMs: 200,
    onStartupPoll: async () => {
      checks += 1;
      if (checks === 3) releaseStatus();
    },
  });

  await expect(controller.start()).resolves.toEqual({
    state: "started",
    pid: 44444,
  });
  expect(checks).toBeGreaterThan(0);
  await expect(statusStore.load()).resolves.toMatchObject({ pid: 44444 });

  await rm(dir, { recursive: true, force: true });
});

test("start refuses to overwrite an existing pid file it did not create", async () => {
  const dir = await mkdtemp(join(tmpdir(), "weacpx-daemon-controller-"));
  let spawned = false;
  const controller = createController(dir, {
    isProcessRunning: () => false,
    spawnDetached: async () => {
      spawned = true;
      return 12321;
    },
  });
  // A pid file whose contents do not parse as a live pid: getStatus treats the
  // daemon as stopped without clearing the file, so start() must not clobber it.
  await writeFile(join(dir, "daemon.pid"), "not-a-pid\n");

  await expect(controller.start()).rejects.toThrow(/pid file already exists/);
  expect(spawned).toBe(false);

  await rm(dir, { recursive: true, force: true });
});

test("start creates the pid file with owner-only permissions", async () => {
  if (process.platform === "win32") return;
  const dir = await mkdtemp(join(tmpdir(), "weacpx-daemon-controller-"));
  const statusStore = new DaemonStatusStore(join(dir, "status.json"));
  // This test only asserts the pid-file mode; startup timing is incidental. Drive a
  // virtual clock (advanced deterministically per poll, well under the startup
  // timeout) so the real wall-clock cost of the status write below can never trip a
  // spurious "did not report ready" timeout — that was the source of a CI flake.
  let now = 0;
  const controller = createController(dir, {
    now: () => now,
    isProcessRunning: (pid) => pid === 13579,
    spawnDetached: async () => 13579,
    onStartupPoll: async () => {
      now += 1;
      await statusStore.save({
        pid: 13579,
        started_at: "2026-03-26T00:00:00.000Z",
        heartbeat_at: "2026-03-26T00:00:00.000Z",
        config_path: "/cfg",
        state_path: "/state",
        app_log: "/app",
        stdout_log: "/out",
        stderr_log: "/err",
      });
    },
  });

  await expect(controller.start()).resolves.toEqual({ state: "started", pid: 13579 });
  const { mode } = await stat(join(dir, "daemon.pid"));
  expect(mode & 0o777).toBe(0o600);
  await expect(readFile(join(dir, "daemon.pid"), "utf8")).resolves.toBe("13579\n");

  await rm(dir, { recursive: true, force: true });
});

test("stop handles missing pid file gracefully", async () => {
  const dir = await mkdtemp(join(tmpdir(), "weacpx-daemon-controller-"));
  const controller = createController(dir);

  await expect(controller.stop()).resolves.toEqual({
    state: "stopped",
    detail: "not-running",
  });

  await rm(dir, { recursive: true, force: true });
});

test("stop recovers a fresh status-only non-Windows daemon before terminating it", async () => {
  const dir = await mkdtemp(join(tmpdir(), "weacpx-daemon-controller-"));
  let running = true;
  let terminatedPid: number | null = null;
  const controller = createController(dir, {
    now: () => Date.parse("2026-03-26T00:01:30.000Z"),
    isProcessRunning: (pid) => pid === 24680 && running,
    terminateProcess: async (pid) => {
      terminatedPid = pid;
      running = false;
    },
    probePosixIdentity: async (pid) => ({
      status: "found",
      identity: { pid, startedAtMs: Date.parse("2026-03-26T00:00:00.000Z") },
    }),
  });
  await new DaemonStatusStore(join(dir, "status.json")).save({
    pid: 24680,
    started_at: "2026-03-26T00:00:00.000Z",
    heartbeat_at: "2026-03-26T00:01:00.000Z",
    config_path: join(dir, "config.json"),
    state_path: join(dir, "state.json"),
    app_log: "/app",
    stdout_log: "/out",
    stderr_log: "/err",
  });
  await writeFile(join(dir, "weixin-consumer.lock.json"), JSON.stringify({
    pid: 24680,
    mode: "daemon",
    startedAt: "2026-03-26T00:00:00.000Z",
    configPath: join(dir, "config.json"),
    statePath: join(dir, "state.json"),
  }));

  await expect(controller.stop()).resolves.toEqual({ state: "stopped", detail: "stopped" });
  expect(terminatedPid).toBe(24680);
  await expect(Bun.file(join(dir, "daemon.pid")).exists()).resolves.toBe(false);
  await expect(Bun.file(join(dir, "status.json")).exists()).resolves.toBe(false);

  await rm(dir, { recursive: true, force: true });
});

test("stop refuses a fresh status-only daemon when its pid was reused by a newer process", async () => {
  const dir = await mkdtemp(join(tmpdir(), "weacpx-daemon-controller-"));
  let terminated = false;
  const controller = createController(dir, {
    now: () => Date.parse("2026-03-26T00:01:30.000Z"),
    isProcessRunning: (pid) => pid === 24680,
    terminateProcess: async () => { terminated = true; },
    probePosixIdentity: async (pid) => ({
      status: "found",
      identity: { pid, startedAtMs: Date.parse("2026-03-26T00:01:15.000Z") },
    }),
  });
  await new DaemonStatusStore(join(dir, "status.json")).save({
    pid: 24680,
    started_at: "2026-03-26T00:00:00.000Z",
    heartbeat_at: "2026-03-26T00:01:00.000Z",
    config_path: join(dir, "config.json"),
    state_path: join(dir, "state.json"),
    app_log: "/app",
    stdout_log: "/out",
    stderr_log: "/err",
  });
  await writeFile(join(dir, "weixin-consumer.lock.json"), JSON.stringify({
    pid: 24680,
    mode: "daemon",
    startedAt: "2026-03-26T00:00:00.000Z",
    configPath: join(dir, "config.json"),
    statePath: join(dir, "state.json"),
  }));

  await expect(controller.stop()).rejects.toThrow("daemon metadata is incomplete or inconsistent");
  expect(terminated).toBe(false);
  await expect(Bun.file(join(dir, "status.json")).exists()).resolves.toBe(true);

  await rm(dir, { recursive: true, force: true });
});

test("stop refuses a status-only daemon replaced after identity verification", async () => {
  const dir = await mkdtemp(join(tmpdir(), "weacpx-daemon-controller-"));
  let probes = 0;
  let terminated = false;
  const originalStartedAt = Date.parse("2026-03-26T00:00:00.000Z");
  const controller = createController(dir, {
    now: () => Date.parse("2026-03-26T00:01:30.000Z"),
    isProcessRunning: (pid) => pid === 24680,
    terminateProcess: async () => { terminated = true; },
    probePosixIdentity: async (pid) => ({
      status: "found",
      identity: {
        pid,
        startedAtMs: probes++ === 0
          ? originalStartedAt
          : Date.parse("2026-03-26T00:01:20.000Z"),
      },
    }),
  });
  await new DaemonStatusStore(join(dir, "status.json")).save({
    pid: 24680,
    started_at: "2026-03-26T00:00:00.000Z",
    heartbeat_at: "2026-03-26T00:01:00.000Z",
    config_path: join(dir, "config.json"),
    state_path: join(dir, "state.json"),
    app_log: "/app",
    stdout_log: "/out",
    stderr_log: "/err",
  });
  await writeFile(join(dir, "weixin-consumer.lock.json"), JSON.stringify({
    pid: 24680,
    mode: "daemon",
    startedAt: "2026-03-26T00:00:00.000Z",
    configPath: join(dir, "config.json"),
    statePath: join(dir, "state.json"),
  }));

  await expect(controller.stop()).rejects.toThrow("daemon metadata is incomplete or inconsistent");
  expect(probes).toBe(2);
  expect(terminated).toBe(false);
  await expect(Bun.file(join(dir, "status.json")).exists()).resolves.toBe(true);

  await rm(dir, { recursive: true, force: true });
});

test("stop waits for the daemon process to exit before clearing runtime files", async () => {
  const dir = await mkdtemp(join(tmpdir(), "weacpx-daemon-controller-"));
  await writeFile(join(dir, "daemon.pid"), "12345\n");
  await new DaemonStatusStore(join(dir, "status.json")).save({
    pid: 12345,
    started_at: "2026-03-26T00:00:00.000Z",
    heartbeat_at: "2026-03-26T00:01:00.000Z",
    config_path: "/cfg",
    state_path: "/state",
    app_log: "/app",
    stdout_log: "/out",
    stderr_log: "/err",
  });

  let terminated = false;
  let polls = 0;
  const controller = createController(dir, {
    isProcessRunning: () => !terminated || polls < 2,
    terminateProcess: async () => {
      terminated = true;
    },
    shutdownPollIntervalMs: 5,
    shutdownTimeoutMs: 50,
    onShutdownPoll: async () => {
      polls += 1;
    },
  });

  await expect(controller.stop()).resolves.toEqual({
    state: "stopped",
    detail: "stopped",
  });
  expect(polls).toBeGreaterThan(0);
  await expect(Bun.file(join(dir, "daemon.pid")).exists()).resolves.toBe(false);
  await expect(Bun.file(join(dir, "status.json")).exists()).resolves.toBe(false);

  await rm(dir, { recursive: true, force: true });
});

test("stop preserves runtime files when the daemon does not exit", async () => {
  const dir = await mkdtemp(join(tmpdir(), "weacpx-daemon-controller-"));
  await writeFile(join(dir, "daemon.pid"), "12345\n");
  await new DaemonStatusStore(join(dir, "status.json")).save({
    pid: 12345,
    started_at: "2026-03-26T00:00:00.000Z",
    heartbeat_at: "2026-03-26T00:01:00.000Z",
    config_path: "/cfg",
    state_path: "/state",
    app_log: "/app",
    stdout_log: "/out",
    stderr_log: "/err",
  });

  let polls = 0;
  const controller = createController(dir, {
    isProcessRunning: () => true,
    terminateProcess: async () => {},
    shutdownPollIntervalMs: 5,
    shutdownTimeoutMs: 20,
    onShutdownPoll: async () => {
      polls += 1;
    },
  });

  await expect(controller.stop()).rejects.toThrow("xacpx daemon did not exit within 20ms");
  expect(polls).toBeGreaterThan(0);
  await expect(Bun.file(join(dir, "daemon.pid")).exists()).resolves.toBe(true);
  await expect(Bun.file(join(dir, "status.json")).exists()).resolves.toBe(true);

  await rm(dir, { recursive: true, force: true });
});

test("start passes onboarding payload to detached spawn", async () => {
  const dir = await mkdtemp(join(tmpdir(), "weacpx-daemon-controller-"));
  let received: unknown = null;
  let polls = 0;
  const controller = createController(dir, {
    isProcessRunning: (pid) => pid === 99999,
    spawnDetached: async (options) => {
      received = options;
      return 99999;
    },
    onStartupPoll: async () => {
      polls += 1;
      await new DaemonStatusStore(join(dir, "status.json")).save({
        pid: 99999,
        started_at: "2026-03-26T00:00:00.000Z",
        heartbeat_at: "2026-03-26T00:00:00.000Z",
        config_path: "/cfg",
        state_path: "/state",
        app_log: "/app",
        stdout_log: "/out",
        stderr_log: "/err",
      });
    },
  });

  await expect(controller.start({ firstRunOnboarding: "payload" })).resolves.toEqual({ state: "started", pid: 99999 });
  expect(received).toEqual({ firstRunOnboarding: "payload" });
  expect(polls).toBeGreaterThan(0);

  await rm(dir, { recursive: true, force: true });
});

test("start uses the onboarding startup timeout when creating the first session", async () => {
  const dir = await mkdtemp(join(tmpdir(), "weacpx-daemon-controller-"));
  let polls = 0;
  const statusStore = new DaemonStatusStore(join(dir, "status.json"));
  const controller = createController(dir, {
    isProcessRunning: (pid) => pid === 77777,
    spawnDetached: async () => 77777,
    startupTimeoutMs: 5,
    // Onboarding timeout must be far above the startup timeout (5ms) to prove
    // the right deadline is chosen, but needs slow-machine headroom: the poll
    // loop's status save + 3ms sleeps can exceed 100ms on Windows CI.
    onboardingStartupTimeoutMs: 500,
    onStartupPoll: async () => {
      polls += 1;
      if (polls === 3) {
        await statusStore.save({
          pid: 77777,
          started_at: "2026-03-26T00:00:00.000Z",
          heartbeat_at: "2026-03-26T00:00:00.000Z",
          config_path: "/cfg",
          state_path: "/state",
          app_log: "/app",
          stdout_log: "/out",
          stderr_log: "/err",
        });
      }
      await new Promise((resolve) => setTimeout(resolve, 3));
    },
  });

  await expect(controller.start({ firstRunOnboarding: "payload" })).resolves.toEqual({
    state: "started",
    pid: 77777,
  });
  expect(polls).toBe(3);

  await rm(dir, { recursive: true, force: true });
});

test("first-run onboarding waits up to five minutes by default", async () => {
  const dir = await mkdtemp(join(tmpdir(), "weacpx-daemon-controller-"));
  let now = 0;
  const controller = createController(dir, {
    now: () => now,
    isProcessRunning: (pid) => pid === 88888,
    spawnDetached: async () => 88888,
    startupTimeoutMs: 5_000,
    onStartupPoll: async () => {
      now += 60_000;
    },
  });

  await expect(controller.start({ firstRunOnboarding: "payload" })).rejects.toThrow(
    "xacpx daemon did not report ready state within 300000ms (pid 88888)",
  );

  await rm(dir, { recursive: true, force: true });
});

test("start can stop waiting for onboarding while leaving the daemon running", async () => {
  const dir = await mkdtemp(join(tmpdir(), "weacpx-daemon-controller-"));
  let polls = 0;
  const controller = createController(dir, {
    isProcessRunning: (pid) => pid === 66666,
    spawnDetached: async () => 66666,
    onboardingStartupTimeoutMs: 100,
    onStartupPoll: async () => {
      polls += 1;
    },
  });

  await expect(controller.start({
    firstRunOnboarding: "payload",
    startupWait: {
      shouldStopWaiting: () => polls >= 2,
    },
  })).resolves.toEqual({
    state: "started",
    pid: 66666,
  });
  expect(polls).toBe(2);
  await expect(readFile(join(dir, "daemon.pid"), "utf8")).resolves.toBe("66666\n");

  await rm(dir, { recursive: true, force: true });
});

function createController(
  runtimeDir: string,
  overrides: Partial<ControllerDeps> = {},
) {
  const paths: DaemonPaths = {
    runtimeDir,
    pidFile: join(runtimeDir, "daemon.pid"),
    statusFile: join(runtimeDir, "status.json"),
    appLog: join(runtimeDir, "app.log"),
    stdoutLog: join(runtimeDir, "stdout.log"),
    stderrLog: join(runtimeDir, "stderr.log"),
  };

  return new DaemonController(paths, {
    // These fixtures exercise the platform-neutral pid/status lifecycle. Keep
    // them on the non-Windows path even when the suite runs on Windows; the
    // dedicated Windows fencing cases above construct their controller
    // explicitly with `platform: "win32"` and durable generation metadata.
    platform: "linux",
    isProcessRunning: overrides.isProcessRunning ?? (() => false),
    spawnDetached: overrides.spawnDetached ?? (async () => 99999),
    terminateProcess: overrides.terminateProcess ?? (async () => {}),
    configRoot: runtimeDir,
    acquireLifecycleGuard: async () => ({ release: async () => {} }),
    startupPollIntervalMs: overrides.startupPollIntervalMs ?? 1,
    startupTimeoutMs: overrides.startupTimeoutMs ?? 50,
    ...(overrides.onboardingStartupTimeoutMs !== undefined
      ? { onboardingStartupTimeoutMs: overrides.onboardingStartupTimeoutMs }
      : {}),
    onStartupPoll: overrides.onStartupPoll ?? (async () => {}),
    shutdownPollIntervalMs: overrides.shutdownPollIntervalMs ?? 1,
    shutdownTimeoutMs: overrides.shutdownTimeoutMs ?? 50,
    onShutdownPoll: overrides.onShutdownPoll ?? (async () => {}),
    ...(overrides.now ? { now: overrides.now } : {}),
    ...(overrides.probePosixIdentity ? { probePosixIdentity: overrides.probePosixIdentity } : {}),
  });
}

interface ControllerDeps {
  isProcessRunning: (pid: number) => boolean;
  spawnDetached: (options?: { firstRunOnboarding?: string }) => Promise<number>;
  terminateProcess: (pid: number) => Promise<void>;
  startupPollIntervalMs: number;
  startupTimeoutMs: number;
  onboardingStartupTimeoutMs: number;
  onStartupPoll: () => Promise<void>;
  shutdownPollIntervalMs: number;
  shutdownTimeoutMs: number;
  onShutdownPoll: () => Promise<void>;
  now: () => number;
  probePosixIdentity: (pid: number) => Promise<
    | { status: "found"; identity: { pid: number; startedAtMs: number } }
    | { status: "missing" | "unavailable" }
  >;
}

function pathsFor(runtimeDir: string): DaemonPaths {
  return {
    runtimeDir,
    pidFile: join(runtimeDir, "daemon.pid"),
    statusFile: join(runtimeDir, "status.json"),
    appLog: join(runtimeDir, "app.log"),
    stdoutLog: join(runtimeDir, "stdout.log"),
    stderrLog: join(runtimeDir, "stderr.log"),
  };
}

async function createLegacyWindowsStopFixture(options: {
  generationDaemonPid?: number;
  generationConfigRoot?: string;
  identityExecutablePath?: string;
} = {}) {
  const dir = await mkdtemp(join(tmpdir(), "weacpx-daemon-stop-win-legacy-"));
  const registry = new OrphanRegistry(dir);
  const configRoot = "C:\\Users\\tester\\.xacpx";
  const processExecPath = "C:\\Program Files\\nodejs\\node.exe";
  const cliEntryPath = "C:\\Users\\tester\\AppData\\Roaming\\npm\\node_modules\\@ganglion\\xacpx\\dist\\cli.js";
  const pid = 75792;
  const terminationRoots: Array<{ pid: number; creationDate: string | null; executablePath?: string }> = [];

  await registry.initialize();
  if (options.generationDaemonPid !== undefined || options.generationConfigRoot !== undefined) {
    await registry.writeGeneration({
      generationId: "33333333-3333-4333-8333-333333333333",
      daemonPid: options.generationDaemonPid ?? pid,
      daemonCreationDate: null,
      configRoot: options.generationConfigRoot ?? configRoot,
    });
  }
  await writeFile(join(dir, "daemon.pid"), `${pid}\n`);
  await new DaemonStatusStore(join(dir, "status.json")).save({
    pid,
    started_at: "2025-01-01T00:00:01.000Z",
    heartbeat_at: "2025-01-01T00:00:45.000Z",
    config_path: `${configRoot}\\config.json`,
    state_path: `${configRoot}\\state.json`,
    app_log: `${configRoot}\\runtime\\app.log`,
    stdout_log: `${configRoot}\\runtime\\stdout.log`,
    stderr_log: `${configRoot}\\runtime\\stderr.log`,
  });

  const controller = new DaemonController(pathsFor(dir), {
    platform: "win32",
    configRoot,
    expectedProcessExecPath: processExecPath,
    expectedCliEntryPath: cliEntryPath,
    isProcessRunning: () => true,
    spawnDetached: async () => 1,
    terminateProcess: async () => {},
    now: () => Date.parse("2025-01-01T00:01:00.000Z"),
    acquireLifecycleGuard: async () => ({ release: async () => {} }),
    orphanRegistry: registry,
    probeWindowsIdentity: async () => ({
      status: "found",
      identity: {
        pid,
        creationDate: "133801632000000000",
        executablePath: options.identityExecutablePath ?? processExecPath,
        commandLine: `"${processExecPath}" "${cliEntryPath}" run`,
      },
    }),
    terminateWindowsTree: async (root) => {
      terminationRoots.push(root);
      return {
        rootOutcome: "killed",
        outcomes: [{ target: root, outcome: "killed" }],
      };
    },
    sweepWindows: async () => emptySweep(),
  });

  return { controller, dir, pid, registry, terminationRoots };
}

function emptySweep() {
  return {
    ownersDeleted: 0,
    ownersRetained: 0,
    residualsDeleted: 0,
    residualsRetained: 0,
    intentsDeleted: 0,
    intentsRetained: 0,
    degraded: false,
  };
}
