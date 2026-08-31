import { afterEach, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createRuntimeConsumerLock } from "../../../src/daemon/runtime-consumer-lock";
import type { ConsumerLock, ConsumerLockMetadata } from "../../../src/channels/types";

const roots: string[] = [];
const require = createRequire(import.meta.url);
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const metadata: ConsumerLockMetadata = {
  pid: 70002,
  mode: "daemon",
  startedAt: "2026-08-06T13:00:00.000Z",
  configPath: "/cfg/config.json",
  statePath: "/cfg/state.json",
};

test("runtime ownership composes the core lock with a single channel lock", async () => {
  const events: string[] = [];
  const core = fakeLock("core", events);
  const channel = fakeLock("channel", events);
  const lock = createRuntimeConsumerLock({
    lockFilePath: "/runtime/runtime-consumer.lock.json",
    channelLocks: [channel],
    createCoreLock: () => core,
  });

  await lock.acquire(metadata);
  await lock.release();

  expect(events).toEqual([
    "core:acquire:70002",
    "channel:acquire:70002",
    "channel:release",
    "core:release",
  ]);
});

test("every channel fence is acquired, not just the first one", async () => {
  const events: string[] = [];
  const lock = createRuntimeConsumerLock({
    lockFilePath: "/runtime/runtime-consumer.lock.json",
    // The caller owns the order; the composition must honour it exactly.
    channelLocks: [fakeLock("channel-a", events), fakeLock("channel-b", events)],
    createCoreLock: () => fakeLock("core", events),
  });

  await lock.acquire(metadata);
  await lock.release();

  expect(events).toEqual([
    "core:acquire:70002",
    "channel-a:acquire:70002",
    "channel-b:acquire:70002",
    "channel-b:release",
    "channel-a:release",
    "core:release",
  ]);
});

test("a later channel fence failure rolls back the earlier fence and the core claim", async () => {
  const events: string[] = [];
  const lock = createRuntimeConsumerLock({
    lockFilePath: "/runtime/runtime-consumer.lock.json",
    channelLocks: [
      fakeLock("channel-a", events),
      {
        acquire: async () => {
          events.push("channel-b:acquire");
          throw new Error("channel-b already owned");
        },
        release: async () => { events.push("channel-b:release"); },
      },
    ],
    createCoreLock: () => fakeLock("core", events),
  });

  await expect(lock.acquire(metadata)).rejects.toThrow("channel-b already owned");
  // channel-b never completed its acquire, so it must not be released.
  expect(events).toEqual([
    "core:acquire:70002",
    "channel-a:acquire:70002",
    "channel-b:acquire",
    "channel-a:release",
    "core:release",
  ]);
});

test("release keeps going after a throwing channel fence", async () => {
  const events: string[] = [];
  const lock = createRuntimeConsumerLock({
    lockFilePath: "/runtime/runtime-consumer.lock.json",
    channelLocks: [
      fakeLock("channel-a", events),
      fakeLock("channel-b", events),
      {
        acquire: async () => { events.push("channel-c:acquire"); },
        release: async () => { events.push("channel-c:release"); throw new Error("channel-c release boom"); },
      },
    ],
    createCoreLock: () => fakeLock("core", events),
  });

  await lock.acquire(metadata);
  await expect(lock.release()).rejects.toThrow("channel-c release boom");
  expect(events).toEqual([
    "core:acquire:70002",
    "channel-a:acquire:70002",
    "channel-b:acquire:70002",
    "channel-c:acquire",
    "channel-c:release",
    "channel-b:release",
    "channel-a:release",
    "core:release",
  ]);
});

test("channel lock failure releases the core ownership claim", async () => {
  const events: string[] = [];
  const lock = createRuntimeConsumerLock({
    lockFilePath: "/runtime/runtime-consumer.lock.json",
    createCoreLock: () => fakeLock("core", events),
    channelLocks: [{
      acquire: async () => {
        events.push("channel:acquire");
        throw new Error("channel already owned");
      },
      release: async () => { events.push("channel:release"); },
    }],
  });

  await expect(lock.acquire(metadata)).rejects.toThrow("channel already owned");
  expect(events).toEqual(["core:acquire:70002", "channel:acquire", "core:release"]);
});

test("the core runtime lock is exclusive without any channel lock", async () => {
  const root = await mkdtemp(join(tmpdir(), "xacpx-runtime-consumer-lock-"));
  roots.push(root);
  const lockFilePath = join(root, "runtime", "runtime-consumer.lock.json");
  const first = createRuntimeConsumerLock({ lockFilePath });
  const second = createRuntimeConsumerLock({ lockFilePath });
  const input: ConsumerLockMetadata = {
    ...metadata,
    pid: process.pid,
    configPath: join(root, "config.json"),
    statePath: join(root, "state.json"),
  };

  await first.acquire(input);
  await expect(second.acquire(input)).rejects.toThrow("xacpx runtime is already running");
  await first.release();
  await second.acquire(input);
  await second.release();

});

test("Bun acquisition timeout kills a helper that already holds flock before its handshake", async () => {
  if (process.platform === "win32") return;
  const root = await mkdtemp(join(tmpdir(), "xacpx-runtime-helper-acquire-timeout-"));
  roots.push(root);
  const lockFilePath = join(root, "runtime-consumer.lock.json");
  const input: ConsumerLockMetadata = {
    ...metadata,
    pid: process.pid,
    configPath: join(root, "config.json"),
    statePath: join(root, "state.json"),
  };
  let helperPid: number | undefined;
  const timedOut = createRuntimeConsumerLock({
    lockFilePath,
    helperAcquireTimeoutMs: 3_000,
    // The Node helper takes the flock before delaying its protocol response.
    helperHandshakeDelayMs: 10_000,
    onDiagnostic: (event, context) => {
      if (event === "lock_helper_spawned" && typeof context.helperPid === "number") {
        helperPid = context.helperPid;
      }
    },
  });

  const acquisition = timedOut.acquire(input).then(
    () => ({ ok: true as const }),
    (error: unknown) => ({ ok: false as const, error }),
  );
  const spawnDeadline = Date.now() + 2_000;
  while (helperPid === undefined && Date.now() < spawnDeadline) {
    await Bun.sleep(10);
  }
  expect(helperPid).toBeDefined();
  // Competing exclusive probes can take the flock themselves. If they win
  // before the helper, the helper reports BUSY and exits; later probes then
  // see FREE forever. Wait for spawn, then for the helper's flock syscall.
  await Bun.sleep(100);

  const busyDeadline = Date.now() + 1_500;
  let observedBusy = false;
  while (!observedBusy && Date.now() < busyDeadline) {
    observedBusy = await probeFlockBusy(lockFilePath);
    if (!observedBusy) await Bun.sleep(25);
  }
  expect(observedBusy).toBe(true);

  const result = await acquisition;
  expect(result.ok).toBe(false);
  if (!result.ok) expect(result.error).toEqual(expect.objectContaining({
    message: expect.stringContaining("runtime lock helper timed out"),
  }));

  // Timeout rejection waits for SIGKILL/close, so no unreferenced helper can
  // retain the kernel lock after acquire() has told the caller it failed.
  const replacement = createRuntimeConsumerLock({ lockFilePath });
  await replacement.acquire(input);
  await replacement.release();
}, 20_000);

test("Windows core ownership uses the dedicated runtime-owner guard", async () => {
  const root = await mkdtemp(join(tmpdir(), "xacpx-runtime-consumer-lock-win-"));
  roots.push(root);
  let role: string | undefined;
  const lock = createRuntimeConsumerLock({
    lockFilePath: join(root, "runtime", "runtime-consumer.lock.json"),
    platform: "win32",
    acquireGuard: async (key) => {
      role = key.role;
      return { release: async () => {} };
    },
  });

  await lock.acquire({
    ...metadata,
    configPath: join(root, "config.json"),
    statePath: join(root, "state.json"),
  });
  expect(role).toBe("runtime-owner");
  await lock.release();
});

test("POSIX core ownership is crash-released and exclusive across processes", async () => {
  if (process.platform === "win32") return;
  const root = await mkdtemp(join(tmpdir(), "xacpx-runtime-consumer-flock-"));
  roots.push(root);
  const outdir = await mkdtemp(join(process.cwd(), "node_modules", ".runtime-lock-test-"));
  roots.push(outdir);
  const result = await Bun.build({
    entrypoints: [join(process.cwd(), "tests", "helpers", "runtime-consumer-lock-child.ts")],
    outdir,
    target: "node",
    external: ["fs-ext"],
  });
  if (!result.success) throw new Error(result.logs.map(String).join("\n"));
  const helper = join(outdir, "runtime-consumer-lock-child.js");
  const start = (mode?: "hold") => spawn("node", [helper, root, ...(mode ? [mode] : [])], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  const output = (child: ReturnType<typeof start>, pattern: RegExp) => new Promise<string>((resolveOutput, reject) => {
    let value = "";
    const timer = setTimeout(() => reject(new Error(`timeout: ${value}`)), 10_000);
    child.stdout.on("data", (chunk) => {
      value += String(chunk);
      if (pattern.test(value)) {
        clearTimeout(timer);
        resolveOutput(value);
      }
    });
    child.stderr.on("data", (chunk) => { value += String(chunk); });
    child.once("error", reject);
  });

  const holder = start("hold");
  await output(holder, /ACQUIRED/);
  const contender = start();
  expect(await output(contender, /BUSY/)).toContain("BUSY");
  holder.kill("SIGKILL");
  await new Promise<void>((resolveClose) => holder.once("close", () => resolveClose()));
  const replacement = start();
  expect(await output(replacement, /ACQUIRED/)).toContain("ACQUIRED");
}, 20_000);

test("Bun exits uncatchably if its flock helper dies after ownership is acquired", async () => {
  if (process.platform === "win32") return;
  const root = await mkdtemp(join(tmpdir(), "xacpx-runtime-helper-loss-"));
  roots.push(root);
  const victim = spawn(
    "bun",
    ["run", join(process.cwd(), "tests", "helpers", "runtime-consumer-lock-child.ts"), root, "lose-helper"],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  let combined = "";
  const acquired = new Promise<number>((resolveHelper, reject) => {
    const timer = setTimeout(() => reject(new Error(`timeout: ${combined}`)), 10_000);
    const inspect = () => {
      const match = combined.match(/HELPER:(\d+)[\s\S]*ACQUIRED:/);
      if (match) {
        clearTimeout(timer);
        resolveHelper(Number(match[1]));
      }
    };
    victim.stdout.on("data", (chunk) => { combined += String(chunk); inspect(); });
    victim.stderr.on("data", (chunk) => { combined += String(chunk); inspect(); });
    victim.once("error", reject);
  });
  const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolveClose, reject) => {
    const timer = setTimeout(() => {
      victim.kill("SIGKILL");
      reject(new Error(`victim did not fail closed: ${combined}`));
    }, 10_000);
    victim.once("close", (code, signal) => {
      clearTimeout(timer);
      resolveClose({ code, signal });
    });
  });

  const helperPid = await acquired;
  process.kill(helperPid, "SIGKILL");
  expect(await closed).toEqual({ code: null, signal: "SIGKILL" });

  // The helper's kernel lock was released, so a replacement can take over
  // immediately even though the killed owner left diagnostic metadata behind.
  const replacement = createRuntimeConsumerLock({
    lockFilePath: join(root, "runtime-consumer.lock.json"),
  });
  await replacement.acquire({
    ...metadata,
    pid: process.pid,
    configPath: join(root, "config.json"),
    statePath: join(root, "state.json"),
  });
  await replacement.release();
}, 20_000);

test("Bun keeps the flock through a graceful process-group SIGTERM until parent release", async () => {
  if (process.platform === "win32") return;
  const root = await mkdtemp(join(tmpdir(), "xacpx-runtime-helper-group-stop-"));
  roots.push(root);
  const victim = spawn(
    "bun",
    ["run", join(process.cwd(), "tests", "helpers", "runtime-consumer-lock-child.ts"), root, "graceful-group"],
    { detached: true, stdio: ["ignore", "pipe", "pipe"] },
  );
  let combined = "";
  const acquired = new Promise<void>((resolveAcquired, reject) => {
    const timer = setTimeout(() => reject(new Error(`timeout: ${combined}`)), 10_000);
    const inspect = () => {
      if (/HELPER:\d+[\s\S]*ACQUIRED:/.test(combined)) {
        clearTimeout(timer);
        resolveAcquired();
      }
    };
    victim.stdout.on("data", (chunk) => { combined += String(chunk); inspect(); });
    victim.stderr.on("data", (chunk) => { combined += String(chunk); inspect(); });
    victim.once("error", reject);
  });
  const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolveClose, reject) => {
    const timer = setTimeout(() => {
      try { process.kill(-victim.pid!, "SIGKILL"); } catch {}
      reject(new Error(`graceful group stop timed out: ${combined}`));
    }, 10_000);
    victim.once("close", (code, signal) => {
      clearTimeout(timer);
      resolveClose({ code, signal });
    });
  });

  await acquired;
  process.kill(-victim.pid!, "SIGTERM");
  expect(await closed).toEqual({ code: 0, signal: null });

  const replacement = createRuntimeConsumerLock({
    lockFilePath: join(root, "runtime-consumer.lock.json"),
  });
  await replacement.acquire({
    ...metadata,
    pid: process.pid,
    configPath: join(root, "config.json"),
    statePath: join(root, "state.json"),
  });
  await replacement.release();
}, 20_000);

function fakeLock(name: string, events: string[]): ConsumerLock {
  return {
    acquire: async (input) => { events.push(`${name}:acquire:${input.pid}`); },
    release: async () => { events.push(`${name}:release`); },
  };
}

const FLOCK_PROBE_SOURCE = String.raw`
const fs = require("node:fs");
const fsExt = require(process.argv[1]);
const fd = fs.openSync(process.argv[2], "a+", 0o600);
fsExt.flock(fd, "exnb", (error) => {
  if (error) {
    const busy = error.code === "EAGAIN" || error.code === "EWOULDBLOCK";
    if (busy) {
      process.stdout.write("BUSY\n");
      fs.closeSync(fd);
      return;
    }
    process.stderr.write(String(error.stack || error));
    fs.closeSync(fd);
    process.exitCode = 1;
    return;
  }
  fsExt.flock(fd, "un", () => {
    fs.closeSync(fd);
    process.stdout.write("FREE\n");
  });
});
`;

async function probeFlockBusy(lockFilePath: string): Promise<boolean> {
  if (process.platform === "linux") {
    try {
      const [fileStat, locks] = await Promise.all([
        stat(lockFilePath),
        readFile("/proc/locks", "utf8"),
      ]);
      const inode = String(fileStat.ino);
      return locks.split("\n").some((line) => {
        const field = line.trim().split(/\s+/).find((part) => /^\d+:\d+:\d+$/.test(part));
        if (!field) return false;
        const parts = field.split(":");
        return parts[2] === inode;
      });
    } catch {
      return false;
    }
  }
  const child = spawn("node", [
    "-e",
    FLOCK_PROBE_SOURCE,
    require.resolve("fs-ext"),
    lockFilePath,
  ], { stdio: ["ignore", "pipe", "pipe"] });
  return new Promise((resolveProbe, reject) => {
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += String(chunk); });
    child.stderr.on("data", (chunk) => { stderr += String(chunk); });
    child.once("error", reject);
    child.once("close", (code) => {
      if (code !== 0) reject(new Error(`flock probe exited with code ${code}: ${stderr}`));
      else resolveProbe(stdout.trim() === "BUSY");
    });
  });
}
