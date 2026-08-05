import { expect, test } from "bun:test";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createWeixinConsumerLock } from "../../../src/weixin/monitor/consumer-lock";
import { IpcGuardBusyError } from "../../../src/process/ipc-guard";

test("rejects when an active consumer lock already exists", async () => {
  const dir = await mkdtemp(join(tmpdir(), "weacpx-consumer-lock-"));
  const lockFilePath = join(dir, "weixin-consumer.lock.json");
  await writeFile(lockFilePath, JSON.stringify({
    pid: 123,
    mode: "foreground",
    startedAt: "2026-04-05T00:00:00.000Z",
    configPath: "/cfg",
    statePath: "/state",
  }));

  const lock = createWeixinConsumerLock({
    lockFilePath,
    isProcessRunning: (pid) => pid === 123,
  });

  try {
    await lock.acquire({
      pid: 456,
      mode: "daemon",
      startedAt: "2026-04-05T00:01:00.000Z",
      configPath: "/cfg2",
      statePath: "/state2",
    });
    throw new Error("expected acquire to fail");
  } catch (error) {
    expect((error as Error).message).toContain("xacpx Weixin consumer is already running.");
    expect((error as Error).message).toContain("pid: 123");
    expect((error as Error).message).toContain("mode: foreground");
    expect((error as Error).message).toContain(
      "Try stopping the existing instance or close the foreground `xacpx run` process before starting a new one.",
    );
  }
});

test("replaces a stale consumer lock", async () => {
  const dir = await mkdtemp(join(tmpdir(), "weacpx-consumer-lock-"));
  const lockFilePath = join(dir, "weixin-consumer.lock.json");
  await writeFile(lockFilePath, JSON.stringify({
    pid: 123,
    mode: "foreground",
    startedAt: "2026-04-05T00:00:00.000Z",
    configPath: "/cfg",
    statePath: "/state",
  }));

  const lock = createWeixinConsumerLock({
    lockFilePath,
    isProcessRunning: () => false,
  });

  await lock.acquire({
    pid: 456,
    mode: "daemon",
    startedAt: "2026-04-05T00:01:00.000Z",
    configPath: "/cfg2",
    statePath: "/state2",
  });

  const stored = JSON.parse(await readFile(lockFilePath, "utf8")) as { pid: number; mode: string };
  expect(stored).toEqual(expect.objectContaining({ pid: 456, mode: "daemon" }));
});

test("emits diagnostics when it replaces a stale lock", async () => {
  const dir = await mkdtemp(join(tmpdir(), "weacpx-consumer-lock-"));
  const lockFilePath = join(dir, "weixin-consumer.lock.json");
  const diagnostics: string[] = [];
  await writeFile(lockFilePath, JSON.stringify({
    pid: 123,
    mode: "foreground",
    startedAt: "2026-04-05T00:00:00.000Z",
    configPath: "/cfg",
    statePath: "/state",
  }));

  const lock = createWeixinConsumerLock({
    lockFilePath,
    isProcessRunning: () => false,
    onDiagnostic: async (event, context) => {
      diagnostics.push(`${event}:${JSON.stringify(context)}`);
    },
  });

  await lock.acquire({
    pid: 456,
    mode: "daemon",
    startedAt: "2026-04-05T00:01:00.000Z",
    configPath: "/cfg2",
    statePath: "/state2",
  });

  expect(diagnostics.some((line) => line.includes("lock_exists"))).toBe(true);
  expect(diagnostics.some((line) => line.includes("lock_stale_removed"))).toBe(true);
  expect(diagnostics.some((line) => line.includes("\"reason\":\"owner_process_not_running\""))).toBe(true);
  expect(diagnostics.some((line) => line.includes("lock_acquired"))).toBe(true);
});

test("Windows guard is acquired before diagnostic metadata v2 and release is ownership checked", async () => {
  const dir = await mkdtemp(join(tmpdir(), "weacpx-consumer-lock-win-"));
  const lockFilePath = join(dir, "weixin-consumer.lock.json");
  const events: string[] = [];
  const lock = createWeixinConsumerLock({
    lockFilePath,
    platform: "win32",
    acquireGuard: async () => {
      events.push("guard");
      return { release: async () => { events.push("release"); } };
    },
  });
  await lock.acquire({
    pid: 456,
    mode: "daemon",
    startedAt: "2026-04-05T00:01:00.000Z",
    configPath: join(dir, "config.json"),
    statePath: join(dir, "state.json"),
    lockId: "33333333-3333-4333-8333-333333333333",
    processCreationDate: "133801632000000000",
  });
  const stored = JSON.parse(await readFile(lockFilePath, "utf8"));
  expect(events).toEqual(["guard"]);
  expect(stored).toMatchObject({
    schemaVersion: 2,
    lockId: "33333333-3333-4333-8333-333333333333",
    processCreationDate: "133801632000000000",
  });
  await lock.release();
  expect(events).toEqual(["guard", "release"]);
});

test("Windows duplicate consumer trusts the guard, not stale metadata liveness", async () => {
  const dir = await mkdtemp(join(tmpdir(), "weacpx-consumer-lock-win-"));
  const lockFilePath = join(dir, "weixin-consumer.lock.json");
  await writeFile(lockFilePath, JSON.stringify({
    schemaVersion: 2,
    lockId: "11111111-1111-4111-8111-111111111111",
    pid: 1,
    mode: "daemon",
    startedAt: "2026-04-05T00:00:00.000Z",
    configPath: join(dir, "config.json"),
    statePath: join(dir, "state.json"),
    processCreationDate: null,
  }));
  const lock = createWeixinConsumerLock({
    lockFilePath,
    platform: "win32",
    isProcessRunning: () => false,
    acquireGuard: async () => { throw new IpcGuardBusyError("pipe"); },
  });
  await expect(lock.acquire({
    pid: 2,
    mode: "foreground",
    startedAt: "2026-04-05T00:01:00.000Z",
    configPath: join(dir, "config.json"),
    statePath: join(dir, "state.json"),
  })).rejects.toThrow("already running");
  expect(JSON.parse(await readFile(lockFilePath, "utf8")).lockId).toBe("11111111-1111-4111-8111-111111111111");
});
