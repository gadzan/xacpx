import { expect, test } from "bun:test";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  RuntimeWorkerFence,
  dischargeRuntimeWorkerFence,
  type RuntimeWorkerFenceRecord,
} from "../../../../../src/bridge/engine/runtime/runtime-worker-fence";
import { RuntimeWorkerManager } from "../../../../../src/bridge/engine/runtime/runtime-worker-manager";

const KEY = "session-A";

function record(overrides: Partial<RuntimeWorkerFenceRecord> = {}): RuntimeWorkerFenceRecord {
  return {
    kind: "runtime-worker-owner",
    logicalSessionId: KEY,
    pid: 4242,
    creationDate: null,
    bootstrapVerified: false,
    startedAt: new Date().toISOString(),
    agent: "runtime-worker",
    ...overrides,
  };
}
/** Spawns a detached long-lived process that is its own group leader (POSIX).
 *  The 150ms settle is a real OS-process start wait — no fake timer can stand in. */
async function spawnStubborn(): Promise<ChildProcess> {
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
    detached: process.platform !== "win32",
    stdio: "ignore",
    windowsHide: true,
  });
  await new Promise((resolve) => setTimeout(resolve, 150));
  return child;
}

function exited(child: ChildProcess): Promise<void> {
  return new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) resolve();
    else child.once("exit", () => resolve());
  });
}

test("fence store: atomic write/read roundtrip and remove", async () => {
  const dir = await mkdtemp(join(tmpdir(), "rt-fence-store-"));
  try {
    const fence = new RuntimeWorkerFence(dir);
    expect(await fence.read(KEY)).toBeNull();
    await fence.write(record({ pid: 777 }));
    const read = await fence.read(KEY);
    expect(read?.pid).toBe(777);
    expect(read?.kind).toBe("runtime-worker-owner");
    await fence.remove(KEY);
    expect(await fence.read(KEY)).toBeNull();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("fence discharge (POSIX): live orphan group is killed and discharge verified", async () => {
  if (process.platform === "win32") return;
  const dir = await mkdtemp(join(tmpdir(), "rt-fence-posix-"));
  const stubborn = await spawnStubborn();
  try {
    const outcome = await dischargeRuntimeWorkerFence(record({ pid: stubborn.pid! }));
    expect(outcome).toBe("discharged");
    await exited(stubborn);
    expect(stubborn.exitCode === null ? stubborn.signalCode : stubborn.exitCode).not.toBeNull();
  } finally {
    stubborn.kill("SIGKILL");
    await rm(dir, { recursive: true, force: true });
  }
}, 15_000);

test("fence discharge (POSIX): dead group discharges without a kill", async () => {
  const outcome = await dischargeRuntimeWorkerFence(record(), {
    platform: "darwin",
    isProcessGroupAlive: () => false,
  });
  expect(outcome).toBe("discharged");
});

test("fence discharge (POSIX): EPERM group kill refuses — never a silent discharge", async () => {
  const outcome = await dischargeRuntimeWorkerFence(record(), {
    platform: "darwin",
    isProcessGroupAlive: () => true,
    killGroup: () => {
      const error = new Error("operation not permitted") as Error & { code?: string };
      error.code = "EPERM";
      throw error;
    },
    waitMs: async () => {},
    now: () => 0,
  });
  expect(outcome).toBe("refused");
});

test("fence discharge (Windows): never-verified worker could not have adapters — discharged", async () => {
  let probed = 0;
  const outcome = await dischargeRuntimeWorkerFence(record({ bootstrapVerified: false, creationDate: null }), {
    platform: "win32",
    probeIdentity: async () => {
      probed += 1;
      return { status: "missing" };
    },
  });
  expect(outcome).toBe("discharged");
  expect(probed).toBe(0);
});

test("fence discharge (Windows): reused pid REFUSES — parentPid edges are ambiguous", async () => {
  let terminated = 0;
  const outcome = await dischargeRuntimeWorkerFence(record({ bootstrapVerified: true, creationDate: "133800000000000000" }), {
    platform: "win32",
    probeIdentity: async () => ({ status: "found", identity: { pid: 4242, creationDate: "133800000000999999", executablePath: "C:\\other.exe" } }),
    terminateDescendants: async () => {
      terminated += 1;
      return { verified: true, outcomes: [], leftover: [] };
    },
  });
  expect(outcome).toBe("refused");
  expect(terminated).toBe(0);
});

test("fence discharge (Windows): same-identity orphaned worker tree converges via descendants-of", async () => {
  const outcome = await dischargeRuntimeWorkerFence(record({ bootstrapVerified: true, creationDate: "133800000000000000" }), {
    platform: "win32",
    probeIdentity: async () => ({ status: "found", identity: { pid: 4242, creationDate: "133800000000000000", executablePath: "C:\\worker.exe" } }),
    terminateDescendants: async () => ({ verified: true, outcomes: [], leftover: [] }),
  });
  expect(outcome).toBe("discharged");
});

async function withFakeWorker(entry: string): Promise<void> {
  await writeFile(
    entry,
    [
      "let buffer='';",
      "process.stdin.on('data', (d) => {",
      "  buffer += d.toString();",
      "  let idx;",
      "  while ((idx = buffer.indexOf('\\n')) >= 0) {",
      "    const line = buffer.slice(0, idx); buffer = buffer.slice(idx + 1);",
      "    if (!line) continue;",
      "    try { const msg = JSON.parse(line);",
      "      process.stdout.write(JSON.stringify({ id: msg.id, ok: true, result: {} }) + '\\n');",
      "      if (msg.method === 'shutdown') process.exit(0);",
      "    } catch {}",
      "  }",
      "});",
    ].join("\n"),
  );
}

test("host restart: undischarged fence over a live orphan is discharged BEFORE the second owner spawns", async () => {
  if (process.platform === "win32") return;
  const dir = await mkdtemp(join(tmpdir(), "rt-fence-restart-"));
  const fenceDir = join(dir, "worker-fences");
  // "Previous host": a stubborn orphan process group (simulated worker+adapter tree)
  // plus its durable fence record — the state a crashed host leaves behind.
  const orphan = await spawnStubborn();
  const fence = new RuntimeWorkerFence(fenceDir);
  await fence.write(record({ pid: orphan.pid!, bootstrapVerified: true }));
  try {
    const entry = join(dir, "fake-worker.mjs");
    await withFakeWorker(entry);
    // "New host": a fresh manager (no in-memory state) over the same fence dir.
    const manager = new RuntimeWorkerManager({ entryPath: entry, fenceDir });
    const worker = await manager.acquire(KEY);
    // The orphan was physically converged by the discharge, and the new owner
    // is fenced under its OWN pid.
    await exited(orphan);
    expect(orphan.exitCode === null ? orphan.signalCode : orphan.exitCode).not.toBeNull();
    const refenced = await fence.read(KEY);
    expect(refenced?.pid).toBe(worker.ref.pid);
    expect(worker.ref.pid).not.toBe(orphan.pid);
    // Verified release removes the fence.
    worker.lifecycle = "stopped";
    await manager.release(KEY, worker);
    expect(await fence.read(KEY)).toBeNull();
    await manager.shutdownAll().catch(() => {});
  } finally {
    orphan.kill("SIGKILL");
    await rm(dir, { recursive: true, force: true });
  }
}, 20_000);

test("host restart: an undischargeable Windows fence refuses the second owner spawn (fail closed)", async () => {
  const dir = await mkdtemp(join(tmpdir(), "rt-fence-refuse-"));
  const fenceDir = join(dir, "worker-fences");
  const fence = new RuntimeWorkerFence(fenceDir);
  // PID-reused record: discharge must refuse, so acquire must not spawn.
  await fence.write(record({ pid: 4242, creationDate: "133800000000000000", bootstrapVerified: true }));
  try {
    const entry = join(dir, "fake-worker.mjs");
    await withFakeWorker(entry);
    const manager = new RuntimeWorkerManager({
      entryPath: entry,
      fenceDir,
      clientDeps: {
        platform: "win32",
        probeWindowsIdentity: async () => ({ status: "found", identity: { pid: 4242, creationDate: "133899999999999999", executablePath: "C:\\reused.exe" } }),
      },
    });
    await expect(manager.acquire(KEY)).rejects.toThrow(/durable ownership fence/);
    expect(manager.get(KEY)).toBeUndefined();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}, 15_000);

test("unfenceable spawn fails closed: fence write failure kills the fresh worker", async () => {
  const dir = await mkdtemp(join(tmpdir(), "rt-fence-fail-"));
  try {
    const entry = join(dir, "fake-worker.mjs");
    await withFakeWorker(entry);
    // A FILE where the fence directory must be: mkdir/write fails.
    const fenceBlocker = join(dir, "not-a-dir");
    await writeFile(fenceBlocker, "blocked");
    const manager = new RuntimeWorkerManager({ entryPath: entry, fenceDir: join(fenceBlocker, "worker-fences") });
    await expect(manager.acquire(KEY)).rejects.toThrow(/durable ownership fence/);
    expect(manager.get(KEY)).toBeUndefined();
    await manager.shutdownAll().catch(() => {});
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}, 15_000);
