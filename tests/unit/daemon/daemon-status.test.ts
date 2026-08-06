import { expect, test } from "bun:test";
import { mkdtemp, readdir, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { DaemonStatusStore, type DaemonStatus } from "../../../src/daemon/daemon-status";

test("returns null when the daemon status file is missing", async () => {
  const dir = await mkdtemp(join(tmpdir(), "weacpx-daemon-status-"));
  const store = new DaemonStatusStore(join(dir, "status.json"));

  await expect(store.load()).resolves.toBeNull();

  await rm(dir, { recursive: true, force: true });
});

test("returns null for parseable status JSON with an invalid schema", async () => {
  const dir = await mkdtemp(join(tmpdir(), "weacpx-daemon-status-"));
  const store = new DaemonStatusStore(join(dir, "status.json"));
  await writeFile(join(dir, "status.json"), JSON.stringify({
    pid: "12345",
    started_at: "not-a-date",
    heartbeat_at: "2026-03-26T00:01:00.000Z",
    config_path: "/cfg",
    state_path: "/state",
    app_log: "/app",
    stdout_log: "/out",
    stderr_log: "/err",
  }));

  await expect(store.load()).resolves.toBeNull();

  await rm(dir, { recursive: true, force: true });
});

test("persists and reloads daemon status", async () => {
  const dir = await mkdtemp(join(tmpdir(), "weacpx-daemon-status-"));
  const store = new DaemonStatusStore(join(dir, "status.json"));
  const status: DaemonStatus = {
    pid: 12345,
    started_at: "2026-03-26T00:00:00.000Z",
    heartbeat_at: "2026-03-26T00:01:00.000Z",
    config_path: "/Users/tester/.weacpx/config.json",
    state_path: "/Users/tester/.weacpx/state.json",
    app_log: "/Users/tester/.weacpx/runtime/app.log",
    stdout_log: "/Users/tester/.weacpx/runtime/stdout.log",
    stderr_log: "/Users/tester/.weacpx/runtime/stderr.log",
  };

  await store.save(status);
  await expect(store.load()).resolves.toEqual(status);

  await rm(dir, { recursive: true, force: true });
});

test("clears the daemon status file", async () => {
  const dir = await mkdtemp(join(tmpdir(), "weacpx-daemon-status-"));
  const store = new DaemonStatusStore(join(dir, "status.json"));

  await store.save({
    pid: 12345,
    started_at: "2026-03-26T00:00:00.000Z",
    heartbeat_at: "2026-03-26T00:01:00.000Z",
    config_path: "/Users/tester/.weacpx/config.json",
    state_path: "/Users/tester/.weacpx/state.json",
    app_log: "/Users/tester/.weacpx/runtime/app.log",
    stdout_log: "/Users/tester/.weacpx/runtime/stdout.log",
    stderr_log: "/Users/tester/.weacpx/runtime/stderr.log",
  });

  await store.clear();
  await expect(store.load()).resolves.toBeNull();

  await rm(dir, { recursive: true, force: true });
});

test("save creates a missing runtime dir user-private (0700)", async () => {
  if (process.platform === "win32") return;
  const dir = await mkdtemp(join(tmpdir(), "weacpx-daemon-status-"));
  const runtimeDir = join(dir, "runtime");
  const store = new DaemonStatusStore(join(runtimeDir, "status.json"));

  await store.save({
    pid: 99,
    started_at: "2026-03-26T00:00:00.000Z",
    heartbeat_at: "2026-03-26T00:00:00.000Z",
    config_path: "/cfg",
    state_path: "/state",
    app_log: "/a.log",
    stdout_log: "/o.log",
    stderr_log: "/e.log",
  });

  expect(((await stat(runtimeDir)).mode & 0o777)).toBe(0o700);

  await rm(dir, { recursive: true, force: true });
});

test("leaves no stray tmp files after save", async () => {
  const dir = await mkdtemp(join(tmpdir(), "weacpx-daemon-status-"));
  const store = new DaemonStatusStore(join(dir, "status.json"));

  await store.save({
    pid: 99,
    started_at: "2026-03-26T00:00:00.000Z",
    heartbeat_at: "2026-03-26T00:00:00.000Z",
    config_path: "/cfg",
    state_path: "/state",
    app_log: "/a.log",
    stdout_log: "/o.log",
    stderr_log: "/e.log",
  });

  const entries = await readdir(dir);
  expect(entries).toEqual(["status.json"]);

  await rm(dir, { recursive: true, force: true });
});

test("overwrites existing status.json atomically", async () => {
  const dir = await mkdtemp(join(tmpdir(), "weacpx-daemon-status-"));
  const store = new DaemonStatusStore(join(dir, "status.json"));

  const first: DaemonStatus = {
    pid: 1,
    started_at: "2026-01-01T00:00:00.000Z",
    heartbeat_at: "2026-01-01T00:00:00.000Z",
    config_path: "/cfg",
    state_path: "/state",
    app_log: "/a.log",
    stdout_log: "/o.log",
    stderr_log: "/e.log",
  };
  const second: DaemonStatus = { ...first, pid: 2, heartbeat_at: "2026-01-01T00:05:00.000Z" };

  await store.save(first);
  await store.save(second);

  await expect(store.load()).resolves.toEqual(second);

  // Only status.json should be present — no stray tmp from second write
  const entries = await readdir(dir);
  expect(entries).toEqual(["status.json"]);

  await rm(dir, { recursive: true, force: true });
});
