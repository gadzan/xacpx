import { mkdir, rm, writeFile } from "node:fs/promises";
import { mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { expect, test } from "bun:test";

import { checkDaemon } from "../../../../src/doctor/checks/daemon-check";
import { DaemonStatusStore } from "../../../../src/daemon/daemon-status";

async function createTempHome(): Promise<string> {
  return await mkdtemp(join(tmpdir(), "xacpx-daemon-check-"));
}

function lockPath(runtimeDir: string, channel = "weixin"): string {
  return join(runtimeDir, `${channel}-consumer.lock.json`);
}

async function writeLock(runtimeDir: string, pid: number, channel = "weixin"): Promise<void> {
  await mkdir(runtimeDir, { recursive: true });
  await writeFile(
    lockPath(runtimeDir, channel),
    JSON.stringify({
      pid,
      mode: "daemon",
      startedAt: "2026-06-11T00:00:00.000Z",
      configPath: "/cfg",
      statePath: "/state",
    }),
    "utf8",
  );
}

test("daemon check attaches clear-stale-lock fix when the lock pid is dead and no daemon runs", async () => {
  const home = await createTempHome();
  const runtimeDir = join(home, ".xacpx", "runtime");
  const stalePid = 99999;

  try {
    await writeLock(runtimeDir, stalePid);

    const removed: string[] = [];
    const result = await checkDaemon({
      home,
      // daemon stopped (no pid file); lock pid is not running
      isProcessRunning: () => false,
      removeConsumerLock: async (path) => {
        removed.push(path);
      },
    });

    const fix = result.fixes?.find((entry) => entry.id === "daemon.clear-stale-lock");
    expect(fix).toBeDefined();
    expect(fix?.withheld).toBeUndefined();

    const outcome = await fix!.run();
    expect(outcome.ok).toBe(true);
    expect(removed).toEqual([lockPath(runtimeDir)]);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("daemon check does not attach the lock fix when the lock pid is alive", async () => {
  const home = await createTempHome();
  const runtimeDir = join(home, ".xacpx", "runtime");
  const livePid = 4242;

  try {
    await writeLock(runtimeDir, livePid);

    const result = await checkDaemon({
      home,
      // The lock owner is alive; the daemon pid file is absent so the daemon
      // itself reads as stopped, but the lock is NOT stale.
      isProcessRunning: (pid) => pid === livePid,
    });

    expect(result.fixes?.some((entry) => entry.id === "daemon.clear-stale-lock") ?? false).toBe(false);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("daemon check does not attach the lock fix when the daemon is running", async () => {
  const home = await createTempHome();
  const runtimeDir = join(home, ".xacpx", "runtime");
  const daemonPid = 12345;
  const stalePid = 99999;

  try {
    await mkdir(runtimeDir, { recursive: true });
    await writeFile(join(runtimeDir, "daemon.pid"), `${daemonPid}\n`, "utf8");
    await new DaemonStatusStore(join(runtimeDir, "status.json")).save({
      pid: daemonPid,
      started_at: "2026-06-11T00:00:00.000Z",
      heartbeat_at: "2026-06-11T00:01:00.000Z",
      config_path: "/cfg",
      state_path: "/state",
      app_log: "/app",
      stdout_log: "/out",
      stderr_log: "/err",
    });
    await writeLock(runtimeDir, stalePid);

    const removed: string[] = [];
    const result = await checkDaemon({
      home,
      // daemon pid alive, lock pid dead
      isProcessRunning: (pid) => pid === daemonPid,
      removeConsumerLock: async (path) => {
        removed.push(path);
      },
    });

    expect(result.severity).toBe("pass");
    expect(result.fixes?.some((entry) => entry.id === "daemon.clear-stale-lock") ?? false).toBe(false);
    expect(removed).toEqual([]);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("daemon check ignores a missing consumer lock", async () => {
  const home = await createTempHome();

  try {
    const result = await checkDaemon({
      home,
      isProcessRunning: () => false,
    });

    expect(result.fixes?.some((entry) => entry.id === "daemon.clear-stale-lock") ?? false).toBe(false);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("daemon check never removes the stable metadata file for the OS-held core lock", async () => {
  const home = await createTempHome();
  const runtimeDir = join(home, ".xacpx", "runtime");
  try {
    await writeLock(runtimeDir, 99999, "runtime");
    const removed: string[] = [];
    const result = await checkDaemon({
      home,
      isProcessRunning: () => false,
      removeConsumerLock: async (path) => { removed.push(path); },
    });

    expect(result.fixes?.some((entry) => entry.id === "daemon.clear-stale-lock") ?? false).toBe(false);
    expect(removed).toEqual([]);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("daemon check detects a stale non-weixin (feishu) consumer lock", async () => {
  const home = await createTempHome();
  const runtimeDir = join(home, ".xacpx", "runtime");
  const stalePid = 99999;

  try {
    await writeLock(runtimeDir, stalePid, "feishu");

    const removed: string[] = [];
    const result = await checkDaemon({
      home,
      isProcessRunning: () => false,
      removeConsumerLock: async (path) => {
        removed.push(path);
      },
    });

    const fix = result.fixes?.find((entry) => entry.id === "daemon.clear-stale-lock");
    expect(fix).toBeDefined();

    const outcome = await fix!.run();
    expect(outcome.ok).toBe(true);
    expect(removed).toEqual([lockPath(runtimeDir, "feishu")]);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("daemon check removes only the dead-pid lock when multiple consumer locks exist", async () => {
  const home = await createTempHome();
  const runtimeDir = join(home, ".xacpx", "runtime");
  const livePid = 4242;
  const stalePid = 99999;

  try {
    await writeLock(runtimeDir, livePid, "weixin");
    await writeLock(runtimeDir, stalePid, "feishu");

    const removed: string[] = [];
    const result = await checkDaemon({
      home,
      // Only the feishu owner is dead.
      isProcessRunning: (pid) => pid === livePid,
      removeConsumerLock: async (path) => {
        removed.push(path);
      },
    });

    const fix = result.fixes?.find((entry) => entry.id === "daemon.clear-stale-lock");
    expect(fix).toBeDefined();

    const outcome = await fix!.run();
    expect(outcome.ok).toBe(true);
    // The live weixin lock is left alone; only the stale feishu lock is removed.
    expect(removed).toEqual([lockPath(runtimeDir, "feishu")]);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("daemon check attaches no lock fix when all consumer locks have live pids", async () => {
  const home = await createTempHome();
  const runtimeDir = join(home, ".xacpx", "runtime");
  const livePid = 4242;

  try {
    await writeLock(runtimeDir, livePid, "weixin");
    await writeLock(runtimeDir, livePid, "feishu");

    const result = await checkDaemon({
      home,
      isProcessRunning: (pid) => pid === livePid,
    });

    expect(result.fixes?.some((entry) => entry.id === "daemon.clear-stale-lock") ?? false).toBe(false);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("daemon check does not attach the lock fix when status is indeterminate (live daemon pid)", async () => {
  const home = await createTempHome();
  const runtimeDir = join(home, ".xacpx", "runtime");
  const daemonPid = 12345;
  const stalePid = 99999;

  try {
    // pid file present but status.json absent => getStatus() reports
    // "indeterminate" ONLY after confirming the pid is alive. That is a LIVE
    // daemon, so a stale lock must not be removed.
    await mkdir(runtimeDir, { recursive: true });
    await writeFile(join(runtimeDir, "daemon.pid"), `${daemonPid}\n`, "utf8");
    await writeLock(runtimeDir, stalePid);

    const removed: string[] = [];
    const result = await checkDaemon({
      home,
      // daemon pid alive (indeterminate), lock pid dead
      isProcessRunning: (pid) => pid === daemonPid,
      removeConsumerLock: async (path) => {
        removed.push(path);
      },
    });

    expect(result.severity).toBe("fail");
    expect(result.summary).toContain("indeterminate");
    expect(result.fixes?.some((entry) => entry.id === "daemon.clear-stale-lock") ?? false).toBe(false);
    expect(removed).toEqual([]);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("clear-stale-lock run() re-verifies and leaves a lock alone when its pid became live after detection", async () => {
  const home = await createTempHome();
  const runtimeDir = join(home, ".xacpx", "runtime");
  const pid = 4242;

  try {
    await writeLock(runtimeDir, pid);

    // Dead at detection time, alive by the time the fix runs — the TOCTOU
    // window where a daemon/channel restarted and re-owned the lock.
    let alive = false;
    const removed: string[] = [];
    const result = await checkDaemon({
      home,
      isProcessRunning: () => alive,
      removeConsumerLock: async (path) => {
        removed.push(path);
      },
    });

    const fix = result.fixes?.find((entry) => entry.id === "daemon.clear-stale-lock");
    expect(fix).toBeDefined();

    alive = true;
    const outcome = await fix!.run();
    expect(outcome.ok).toBe(true);
    expect(outcome.message).toContain("no locks removed");
    expect(removed).toEqual([]);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
