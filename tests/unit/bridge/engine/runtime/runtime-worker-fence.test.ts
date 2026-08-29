import { expect, test } from "bun:test";
import { spawn, type ChildProcess } from "node:child_process";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
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
    expect(await fence.read(KEY)).toEqual({ kind: "absent" });
    await fence.write(record({ pid: 777 }));
    const read = await fence.read(KEY);
    expect(read.kind).toBe("present");
    if (read.kind === "present") {
      expect(read.record.pid).toBe(777);
      expect(read.record.kind).toBe("runtime-worker-owner");
    }
    await fence.remove(KEY);
    expect(await fence.read(KEY)).toEqual({ kind: "absent" });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("fence store: corrupt JSON is UNREADABLE, never absent (round 30 Blocking 1)", async () => {
  const dir = await mkdtemp(join(tmpdir(), "rt-fence-corrupt-"));
  try {
    const fence = new RuntimeWorkerFence(dir);
    await fence.write(record());
    const path = join(dir, `${encodeURIComponent(KEY)}.json`);
    await writeFile(path, "{ this is not json");
    const read = await fence.read(KEY);
    expect(read.kind).toBe("unreadable");
    if (read.kind === "unreadable") expect(read.reason).toContain("corrupt");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("fence store: foreign schema / key mismatch is UNREADABLE (round 30 Blocking 1)", async () => {
  const dir = await mkdtemp(join(tmpdir(), "rt-fence-schema-"));
  try {
    const fence = new RuntimeWorkerFence(dir);
    const path = join(dir, `${encodeURIComponent(KEY)}.json`);
    await writeFile(path, JSON.stringify({ kind: "something-else", pid: 1 }));
    expect((await fence.read(KEY)).kind).toBe("unreadable");
    await writeFile(path, JSON.stringify({ ...record(), logicalSessionId: "OTHER" }));
    expect((await fence.read(KEY)).kind).toBe("unreadable");
    await writeFile(path, JSON.stringify({ ...record(), pid: -5 }));
    expect((await fence.read(KEY)).kind).toBe("unreadable");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("fence store: unreadable I/O (EACCES) is UNREADABLE, never absent (round 30 Blocking 1)", async () => {
  if (process.platform === "win32") return; // POSIX permission model only
  const dir = await mkdtemp(join(tmpdir(), "rt-fence-eacces-"));
  try {
    const fence = new RuntimeWorkerFence(dir);
    await fence.write(record());
    await chmod(join(dir, `${encodeURIComponent(KEY)}.json`), 0o000);
    const read = await fence.read(KEY);
    // Running as root would bypass the mode bits — only assert when it bit.
    if (read.kind === "unreadable") expect(read.reason).toBeTruthy();
    else expect(process.getuid?.()).toBe(0);
  } finally {
    await chmod(join(dir, `${encodeURIComponent(KEY)}.json`), 0o644).catch(() => {});
    await rm(dir, { recursive: true, force: true });
  }
});

test("manager acquire: corrupt fence refuses the spawn with zero workers (round 30 Blocking 1)", async () => {
  const dir = await mkdtemp(join(tmpdir(), "rt-fence-corrupt-mgr-"));
  const fenceDir = join(dir, "worker-fences");
  try {
    const entry = join(dir, "fake-worker.mjs");
    await writeFile(entry, "process.stdin.on('data', () => {});");
    const fence = new RuntimeWorkerFence(fenceDir);
    await fence.write(record({ pid: 999 }));
    await writeFile(join(fenceDir, `${encodeURIComponent(KEY)}.json`), "CORRUPT-{");
    const manager = new RuntimeWorkerManager({ entryPath: entry, fenceDir });
    await expect(manager.acquire(KEY)).rejects.toThrow(/UNREADABLE/);
    expect(manager.get(KEY)).toBeUndefined();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}, 15_000);

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
  // Round 30 Blocking 2 makes this a hard invariant: the durable admission
  // barrier means a never-verified fence cannot have entered a business RPC.
  let terminated = 0;
  const outcome = await dischargeRuntimeWorkerFence(record({ bootstrapVerified: false, creationDate: null }), {
    platform: "win32",
    terminateDescendants: async () => {
      terminated += 1;
      return { verified: true, outcomes: [], leftover: [] };
    },
  });
  expect(outcome).toBe("discharged");
  expect(terminated).toBe(0);
});

test("fence discharge (Windows): verified record converges THROUGH the in-transaction parent gate (round 30 Blocking 3)", async () => {
  let seenPid = 0;
  let seenFingerprint = "";
  const outcome = await dischargeRuntimeWorkerFence(
    record({ pid: 4242, creationDate: "133800000000000000", bootstrapVerified: true }),
    {
      platform: "win32",
      terminateDescendants: async (parentPid, expectedCreationDate) => {
        seenPid = parentPid;
        seenFingerprint = expectedCreationDate;
        return { verified: true, outcomes: [], leftover: [] };
      },
    },
  );
  expect(outcome).toBe("discharged");
  expect(seenPid).toBe(4242);
  // The expected parent fingerprint MUST ride into the kill transaction —
  // a probe result is a momentary observation, not an identity capability.
  expect(seenFingerprint).toBe("133800000000000000");
});

test("fence discharge (Windows): gate failure (dead/replaced root) refuses — no bare-pid kill", async () => {
  let calls = 0;
  const outcome = await dischargeRuntimeWorkerFence(
    record({ pid: 4242, creationDate: "133800000000000000", bootstrapVerified: true }),
    {
      platform: "win32",
      terminateDescendants: async () => {
        calls += 1;
        // Simulates the in-transaction gate observing dead/replaced parent.
        return { verified: false, outcomes: [], leftover: [] };
      },
    },
  );
  expect(outcome).toBe("refused");
  expect(calls).toBe(1);
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
    expect(refenced.kind).toBe("present");
    if (refenced.kind === "present") {
      expect(refenced.record.pid).toBe(worker.ref.pid);
      expect(worker.ref.pid).not.toBe(orphan.pid);
    }
    // Verified release removes the fence.
    worker.lifecycle = "stopped";
    await manager.release(KEY, worker);
    expect((await fence.read(KEY)).kind).toBe("absent");
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
  // In-transaction gate observes a replaced/dead parent → unverified → refused.
  await fence.write(record({ pid: 4242, creationDate: "133800000000000000", bootstrapVerified: true }));
  try {
    const entry = join(dir, "fake-worker.mjs");
    await withFakeWorker(entry);
    const manager = new RuntimeWorkerManager({
      entryPath: entry,
      fenceDir,
      clientDeps: {
        platform: "win32",
        terminateDescendantsOf: async () => ({ verified: false, outcomes: [], leftover: [] }),
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
