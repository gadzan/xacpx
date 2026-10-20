import { expect, spyOn, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { setTimeout as delay } from "node:timers/promises";
import { RuntimeWorkerClient, type RuntimeWorkerClientDeps } from "../../../../../src/bridge/engine/runtime/runtime-worker-client";
import { RuntimeWorkerManager, WorkerTeardownPendingError } from "../../../../../src/bridge/engine/runtime/runtime-worker-manager";
import { RuntimeWorkerFence, StaleFenceGenerationError, type FencePhase, type RuntimeWorkerFenceRecord } from "../../../../../src/bridge/engine/runtime/runtime-worker-fence";
import { windowsJobNameForGeneration } from "../../../../../src/process/windows-job-query";

const probeTestIdentity: NonNullable<RuntimeWorkerClientDeps["probeWindowsIdentity"]> = async (pid) => ({
  status: "found",
  identity: { pid, creationDate: "133800000000000000", executablePath: "C:\\node.exe", commandLine: "node fake-worker.mjs" },
});

function killTestWorker(target: Parameters<NonNullable<RuntimeWorkerClientDeps["terminateProcessTree"]>>[0]): void {
  try {
    process.kill(typeof target === "number" ? target : target.pid, "SIGKILL");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
  }
}

async function waitUntil(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("worker lifecycle did not settle");
    await delay(5);
  }
}
async function withFakeEntry(run: (entryPath: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "worker-mgr-"));
  try {
    // Minimal worker: responds to shutdown then exits; enough to prove
    // spawn/registry/shutdownAll wiring without acpx.
    const entry = join(dir, "fake-worker.mjs");
    await writeFile(
      entry,
      [
        "process.stdin.on('data', () => {});",
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
    await run(entry);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("manager rejects a missing worker entry at construction", () => {
  expect(() => new RuntimeWorkerManager({ entryPath: "/nonexistent/worker-main.js" })).toThrow(/entry not found/);
});
test("one session maps to one worker; same session reuses it", async () => {
  await withFakeEntry(async (entry) => {
    const manager = new RuntimeWorkerManager({ entryPath: entry, clientDeps: { platform: "linux" } });
    const first = manager.ensureWorker("logical-1");
    const second = manager.ensureWorker("logical-1");
    expect(second).toBe(first);
    expect(manager.lifecycleFor("logical-1")).not.toBe("stopped");
    await manager.shutdownAll();
    expect(manager.lifecycleFor("logical-1")).toBe("stopped");
  });
}, 15_000);

test("different sessions never share a worker", async () => {
  await withFakeEntry(async (entry) => {
    const manager = new RuntimeWorkerManager({ entryPath: entry, clientDeps: { platform: "linux" } });
    const a = manager.ensureWorker("logical-a");
    const b = manager.ensureWorker("logical-b");
    await Promise.all([a.request("ensure", {}), b.request("ensure", {})]);
    expect(a.ref.pid).toBeGreaterThan(0);
    expect(b.ref.pid).toBeGreaterThan(0);
    expect(a).not.toBe(b);
    expect(a.ref.pid).not.toBe(b.ref.pid);
    await manager.shutdownAll();
  });
}, 15_000);

test("shutdownAll stops every registered worker", async () => {
  await withFakeEntry(async (entry) => {
    const manager = new RuntimeWorkerManager({ entryPath: entry, maxRestartsPerWindow: 1, restartWindowMs: 5_000, clientDeps: { platform: "linux" } });
    void manager.ensureWorker("s1");
    void manager.ensureWorker("s2");
    await manager.shutdownAll();
    expect(manager.get("s1")).toBeUndefined();
    expect(manager.isWarm("s1")).toBe(false);
    expect(manager.isWarm("s2")).toBe(false);
  });
}, 15_000);

test("crash-loop guard ignores clean stops and only counts real crashes", async () => {
  await withFakeEntry(async (entry) => {
    // Deliberate terminate (clean stop): budget NOT consumed — freeWarm cool
    // cycles must never brick the session (plan §43).
    const manager = new RuntimeWorkerManager({ entryPath: entry, maxRestartsPerWindow: 1, restartWindowMs: 60_000, clientDeps: { platform: "linux" } });
    const first = manager.ensureWorker("crashy");
    await first.request("ensure", {});
    await first.terminate();
    const second = manager.ensureWorker("crashy");
    await second.request("ensure", {});
    expect(second.ref.generation).not.toBe(first.ref.generation);
    process.kill(second.ref.pid, "SIGKILL");
    await waitUntil(() => second.lifecycle === "stopped");
    expect(() => manager.ensureWorker("crashy")).toThrow(/marking unhealthy/);
    await manager.shutdownAll();
  });
}, 15_000);

test("ensureWorker returns a ref carrying stable identity fields", async () => {
  await withFakeEntry(async (entry) => {
    const manager = new RuntimeWorkerManager({ entryPath: entry, clientDeps: { platform: "linux" } });
    const worker = manager.ensureWorker("identity-check");
    expect(worker.ref.logicalSessionId).toBe("identity-check");
    expect(worker.ref.generation).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    expect(worker.ref.startedAt).toBeTypeOf("string");
    await manager.shutdownAll();
  });
}, 15_000);

test("ensureWorker refuses duplicate spawn when existing worker is still alive in cooling/stopped state", async () => {
  await withFakeEntry(async (entry) => {
    const manager = new RuntimeWorkerManager({ entryPath: entry, clientDeps: { platform: "linux" } });
    const workerA = manager.ensureWorker("sess-cooldown");
    // Simulate worker undergoing teardown while still alive
    workerA.lifecycle = "cooling";
    expect(() => manager.ensureWorker("sess-cooldown")).toThrow(WorkerTeardownPendingError);

    workerA.lifecycle = "stopped";
    expect(() => manager.ensureWorker("sess-cooldown")).toThrow(WorkerTeardownPendingError);

    workerA.lifecycle = "failed";
    expect(() => manager.ensureWorker("sess-cooldown")).toThrow(WorkerTeardownPendingError);

    await workerA.terminate();
  });
}, 15_000);

test("stale exit callback from previous generation never deletes newer replacement worker", async () => {
  await withFakeEntry(async (entry) => {
    const manager = new RuntimeWorkerManager({ entryPath: entry, clientDeps: { platform: "linux" } });
    const workerA = manager.ensureWorker("sess-gen");

    // Manually register replacement worker B for the same session
    const workerB = manager["ensureWorker"]("sess-gen-other");
    manager["workersByKey"].set("sess-gen", workerB);

    // Stale exit arrives from worker A
    manager["handleExit"]("sess-gen", workerA, 0);

    // worker B is preserved in the manager (never deleted by stale exit from A)
    expect(manager.get("sess-gen")).toBe(workerB);

    await manager.shutdownAll();
  });
}, 15_000);

test("shutdownAll propagates termination failures and retains failing workers in tracking", async () => {
  await withFakeEntry(async (entry) => {
    const manager = new RuntimeWorkerManager({ entryPath: entry });
    const workerGood = manager.ensureWorker("sess-good");
    const workerBad = manager.ensureWorker("sess-bad");

    // Stub bad worker's shutdown to simulate a Windows termination / process-tree error
    workerBad.shutdown = async () => {
      throw new Error("Windows tree termination access-denied (simulated)");
    };

    // shutdownAll must reject with the error message
    await expect(manager.shutdownAll()).rejects.toThrow(/Windows tree termination access-denied/);

    // workerGood was successfully stopped and removed from tracking
    expect(manager.get("sess-good")).toBeUndefined();

    // workerBad FAILED to stop, so ownership is RETAINED (never forgotten)
    expect(manager.get("sess-bad")).toBe(workerBad);

    // Clean up bad worker
    await workerBad.terminate();
  });
}, 15_000);
test("re-acquiring an admitted live worker preserves admitted fence", async () => {
  const fenceDir = await mkdtemp(join(tmpdir(), "fence-reacquire-"));
  try {
    await withFakeEntry(async (entry) => {
      const manager = new RuntimeWorkerManager({
        entryPath: entry,
        fenceDir,
        clientDeps: {
          probeWindowsIdentity: probeTestIdentity,
          terminateProcessTree: async (target) => {
            killTestWorker(target);
            return { rootOutcome: "killed", outcomes: [] };
          },
        },
      });
      const worker1 = await manager.acquire("sess-admitted");
      await worker1.request("ensure", {});
      const { RuntimeWorkerFence } = await import("../../../../../src/bridge/engine/runtime/runtime-worker-fence");
      const fence = new RuntimeWorkerFence(fenceDir);
      const read1 = await fence.read("sess-admitted");
      expect(read1.kind).toBe("present");
      if (read1.kind !== "present") return;
      expect(read1.record.phase).toBe("admitted");
      const gen1 = read1.record.generation;
      const worker2 = await manager.acquire("sess-admitted");
      expect(worker2).toBe(worker1);
      const read2 = await fence.read("sess-admitted");
      expect(read2.kind).toBe("present");
      if (read2.kind !== "present") return;
      expect(read2.record.generation).toBe(gen1);
      expect(read2.record.phase).toBe("admitted");
      await manager.shutdownAll();
    });
  } finally {
    await rm(fenceDir, { recursive: true, force: true });
  }
}, 15_000);
test("deliberate root exit holds terminateProcessTree pending and concurrent ensureWorker rejects with WorkerTeardownPendingError", async () => {
  await withFakeEntry(async (entry) => {
    const termination = Promise.withResolvers<void>();
    const cleanupStarted = Promise.withResolvers<void>();

    const manager = new RuntimeWorkerManager({
      entryPath: entry,
      clientDeps: {
        probeWindowsIdentity: probeTestIdentity,
        terminateProcessTree: async (target) => {
          cleanupStarted.resolve();
          await termination.promise;
          killTestWorker(target);
          return { rootOutcome: "killed", outcomes: [] };
        },
      },
    });

    const client = manager.ensureWorker("sess-race-teardown");
    await client.request("ensure", {});

    // Start background shutdown (holds tree termination pending)
    const shutdownPromise = client.shutdown(2_000);

    await cleanupStarted.promise;

    // While tree cleanup is in flight, concurrent ensureWorker MUST fail closed!
    expect(() => manager.ensureWorker("sess-race-teardown")).toThrow(WorkerTeardownPendingError);

    // Release tree termination
    termination.resolve();
    await shutdownPromise;
    expect(client.lifecycle).toBe("stopped");

    // After cleanup is verified complete, replacement spawn is allowed
    const replacement = manager.ensureWorker("sess-race-teardown");
    await replacement.request("ensure", {});
    expect(replacement.ref.generation).not.toBe(client.ref.generation);

    await manager.shutdownAll();
  });
}, 15_000);

test("unexpected worker crash cleans up process tree before allowing replacement spawn", async () => {
  await withFakeEntry(async (entry) => {
    let cleanupRun = false;
    const termination = Promise.withResolvers<void>();
    const cleanupStarted = Promise.withResolvers<void>();

    const manager = new RuntimeWorkerManager({
      entryPath: entry,
      maxRestartsPerWindow: 5,
      clientDeps: {
        probeWindowsIdentity: probeTestIdentity,
        terminateProcessTree: async (target) => {
          cleanupRun = true;
          cleanupStarted.resolve();
          await termination.promise;
          killTestWorker(target);
          return { rootOutcome: "killed", outcomes: [] };
        },
      },
    });

    const client = manager.ensureWorker("sess-crash-clean");
    await client.request("ensure", {});

    // Kill worker root abruptly to simulate unexpected crash
    process.kill(client.ref.pid, "SIGKILL");

    await cleanupStarted.promise;

    // While tree cleanup is in flight, concurrent ensureWorker MUST reject
    expect(() => manager.ensureWorker("sess-crash-clean")).toThrow(WorkerTeardownPendingError);

    // Release tree termination
    termination.resolve();

    // Wait for tree cleanup to finish
    await waitUntil(() => client.lifecycle === "stopped");

    // Process tree cleanup was executed
    expect(cleanupRun).toBe(true);

    // After cleanup is verified complete, replacement spawn is allowed within budget!
    const replacement = manager.ensureWorker("sess-crash-clean");
    await replacement.request("ensure", {});
    expect(replacement.ref.generation).not.toBe(client.ref.generation);

    await manager.shutdownAll();
  });
}, 15_000);
test("spawn succeeds but owned fence write fails → verified terminate before retire, no orphan", async () => {
  const dir = await mkdtemp(join(tmpdir(), "worker-mgr-ownfail-"));
  try {
    const entry = join(dir, "fake-worker.mjs");
    await writeFile(
      entry,
      [
        "process.stdin.on('data', () => {});",
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
    const fenceDir = join(dir, "worker-fences");
    const passthrough = new RuntimeWorkerFence(fenceDir);
    const writeSpy = spyOn(RuntimeWorkerFence.prototype, "compareAndSwap").mockImplementation(
      (key: string, expected: { generation: string; from: FencePhase[] }, record: RuntimeWorkerFenceRecord) => {
        if (record.phase === "owned") {
          return Promise.reject(new Error("ENOSPC: simulated owned-write failure"));
        }
        return passthrough.compareAndSwap(key, expected, record);
      },
    );
    const origTerminate = RuntimeWorkerClient.prototype.terminate;
    let terminatedClient: RuntimeWorkerClient | null = null;
    const termSpy = spyOn(RuntimeWorkerClient.prototype, "terminate").mockImplementation(
      async function (this: RuntimeWorkerClient) {
        terminatedClient = this;
        return origTerminate.call(this);
      },
    );
    const manager = new RuntimeWorkerManager({ entryPath: entry, fenceDir });
    try {
      await expect(manager.acquire("ownfail-sess")).rejects.toThrow(/ENOSPC/);
      expect(terminatedClient).not.toBeNull();
      expect(terminatedClient!.lifecycle).toBe("stopped");
      expect(terminatedClient!.alive).toBe(false);
      expect(manager.get("ownfail-sess")).toBeUndefined();
      expect(manager.physicalFenceKeyFor("ownfail-sess")).toBeUndefined();
      expect((await passthrough.read("ownfail-sess")).kind).toBe("absent");
      writeSpy.mockRestore();
      const second = await manager.acquire("ownfail-sess");
      await second.request("ensure", {});
      expect(second.isBootstrapVerified).toBe(true);
    } finally {
      writeSpy.mockRestore();
      termSpy.mockRestore();
      await manager.shutdownAll().catch(() => {});
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}, 20_000);
test("owned fence write fails and termination is unverified → retain tracking+fence as teardown-pending", async () => {
  const dir = await mkdtemp(join(tmpdir(), "worker-mgr-termfail-"));
  try {
    const entry = join(dir, "fake-worker.mjs");
    await writeFile(
      entry,
      [
        "process.stdin.on('data', () => {});",
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
    const fenceDir = join(dir, "worker-fences");
    const passthrough = new RuntimeWorkerFence(fenceDir);
    const writeSpy = spyOn(RuntimeWorkerFence.prototype, "compareAndSwap").mockImplementation(
      (key: string, expected: { generation: string; from: FencePhase[] }, record: RuntimeWorkerFenceRecord) => {
        if (record.phase === "owned") {
          return Promise.reject(new Error("ENOSPC: simulated owned-write failure"));
        }
        return passthrough.compareAndSwap(key, expected, record);
      },
    );
    // Termination cannot be verified: the manager must retain tracking AND
    // the fence (never retire evidence under a live, untracked worker).
    const termSpy = spyOn(RuntimeWorkerClient.prototype, "terminate").mockImplementation(
      async function (this: RuntimeWorkerClient) {
        throw new Error("simulated tree-verification failure");
      },
    );
    const manager = new RuntimeWorkerManager({ entryPath: entry, fenceDir });
    try {
      await expect(manager.acquire("termfail-sess")).rejects.toThrow(/refusing replacement spawn/);
      expect(manager.get("termfail-sess")).toBeDefined();
      expect((await passthrough.read("termfail-sess")).kind).toBe("present");
    } finally {
      writeSpy.mockRestore();
      termSpy.mockRestore();
      await manager.shutdownAll().catch(() => {});
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}, 20_000);
test("owned CAS loses to a successor generation → orphan terminated, successor fence never retired", async () => {
  const dir = await mkdtemp(join(tmpdir(), "worker-mgr-stale-"));
  try {
    const entry = join(dir, "fake-worker.mjs");
    await writeFile(
      entry,
      [
        "process.stdin.on('data', () => {});",
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
    const fenceDir = join(dir, "worker-fences");
    const passthrough = new RuntimeWorkerFence(fenceDir);
    const originalCas = RuntimeWorkerFence.prototype.compareAndSwap;
    let successor: RuntimeWorkerFenceRecord | undefined;
    // A successor takes over between our claim and our owned upgrade.
    const casSpy = spyOn(RuntimeWorkerFence.prototype, "compareAndSwap").mockImplementation(
      async (key: string, expected: { generation: string; from: FencePhase[] }, record: RuntimeWorkerFenceRecord) => {
        if (record.phase === "owned") {
          successor = { ...record, generation: randomUUID(), phase: "admitted", pid: 7654, bootstrapVerified: true };
          delete successor.jobName;
          delete successor.jobAttested;
          delete successor.supervisorPid;
          delete successor.supervisorCreationDate;
          await passthrough.write(successor);
          throw new StaleFenceGenerationError(`fence CAS for "${key}" found successor generation`);
        }
        return originalCas.call(passthrough, key, expected, record);
      },
    );
    const manager = new RuntimeWorkerManager({ entryPath: entry, fenceDir });
    try {
      await expect(manager.acquire("stale-sess")).rejects.toThrow(/lost its fence to a successor generation/);
      expect(await passthrough.read("stale-sess")).toEqual({ kind: "present", record: successor });
      expect(manager.get("stale-sess")).toBeUndefined();
      expect(manager.physicalFenceKeyFor("stale-sess")).toBeUndefined();
    } finally {
      casSpy.mockRestore();
      await manager.shutdownAll().catch(() => {});
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}, 20_000);
test("acquire on a cooling-but-alive fenced worker fails fast, never burns the discharge window", async () => {
  await withFakeEntry(async (entry) => {
    const dir = await mkdtemp(join(tmpdir(), "worker-mgr-cooling-"));
    try {
      const manager = new RuntimeWorkerManager({ entryPath: entry, fenceDir: join(dir, "fences"), clientDeps: { windowsJobContainment: false } });
      try {
        const worker = await manager.acquire("cooling-1");
        await worker.request("ensure", {});
        expect(worker.alive).toBe(true);
        worker.lifecycle = "cooling";
        // Must reject with the teardown-pending contract immediately: the
        // fence is ours, so discharging it would wait out the 90s
        // self-discharge window only to refuse. (No timing assert: a
        // regression hangs past this test's timeout and fails that way.)
        await expect(manager.acquire("cooling-1")).rejects.toThrow(WorkerTeardownPendingError);
        expect(manager.get("cooling-1")).toBe(worker);
      } finally {
        await manager.shutdownAll().catch(() => {});
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
}, 15_000);

test("acquire refuses over a deleting fence without spawning or touching it", async () => {
  const dir = await mkdtemp(join(tmpdir(), "fence-deleting-"));
  try {
    await withFakeEntry(async (entry) => {
      const fenceDir = join(dir, "fences");
      const manager = new RuntimeWorkerManager({ entryPath: entry, fenceDir });
      try {
        const fence = new RuntimeWorkerFence(fenceDir);
        const physical = "physical-deleting-1";
        await fence.claim({
          kind: "runtime-worker-owner",
          logicalSessionId: physical,
          generation: "gen-deleter",
          pid: process.pid,
          bootstrapVerified: false,
          phase: "deleting",
          startedAt: new Date().toISOString(),
          agent: "runtime-worker",
        });
        // Successor admission fails fast (no 90s probe, no discharge, no spawn).
        await expect(manager.acquire("lid-successor", physical)).rejects.toThrow(WorkerTeardownPendingError);
        expect(manager.get("lid-successor")).toBeUndefined();
        const read = await fence.read(physical);
        expect(read.kind).toBe("present");
        if (read.kind !== "present") return;
        expect(read.record.phase).toBe("deleting");
        expect(read.record.generation).toBe("gen-deleter");
      } finally {
        await manager.shutdownAll().catch(() => {});
      }
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}, 15_000);

test("claimPhysicalDeletion is single-executor: fresh, re-entry, live refusal, dead takeover", async () => {
  const dir = await mkdtemp(join(tmpdir(), "fence-delclaim-"));
  try {
    await withFakeEntry(async (entry) => {
      const fenceDir = join(dir, "fences");
      const manager = new RuntimeWorkerManager({ entryPath: entry, fenceDir });
      // A second manager in THIS process shares the in-process executor mark.
      const manager2 = new RuntimeWorkerManager({ entryPath: entry, fenceDir });
      try {
        const fence = new RuntimeWorkerFence(fenceDir);
        // Fresh claim wins.
        const first = await manager.claimPhysicalDeletion("physical-del-1");
        expect(first).not.toBeNull();
        expect(first?.adopted).toBe(false);
        // A concurrent in-process deleter refuses — generations are never shared.
        await expect(manager2.claimPhysicalDeletion("physical-del-1")).rejects.toThrow(
          /already running in this process/,
        );
        // Ended attempt releases the mark: same-process re-entry takes over
        // with a NEW generation (never shares the old one).
        manager.releaseDeletionClaim("physical-del-1");
        const reentry = await manager2.claimPhysicalDeletion("physical-del-1");
        expect(reentry?.adopted).toBe(true);
        expect(reentry?.generation).not.toBe(first?.generation);
        const owner = reentry!.generation;
        // Revalidation passes for the owner generation...
        await manager2.revalidatePhysicalDeletion("physical-del-1", owner);
        // ...and strict retire refuses a wrong generation without touching the file.
        await expect(manager2.retirePhysicalDeletion("physical-del-1", "gen-wrong")).rejects.toThrow();
        expect((await fence.read("physical-del-1")).kind).toBe("present");
        // ...then retires the real barrier.
        await manager2.retirePhysicalDeletion("physical-del-1", owner);
        expect(await fence.read("physical-del-1")).toEqual({ kind: "absent" });
        // A live owner fence aborts the delete instead of unlinking over it.
        await fence.claim({
          kind: "runtime-worker-owner",
          logicalSessionId: "physical-del-2",
          generation: "gen-live",
          pid: process.pid,
          bootstrapVerified: true,
          phase: "owned",
          startedAt: new Date().toISOString(),
          agent: "runtime-worker",
        });
        await expect(manager.claimPhysicalDeletion("physical-del-2")).rejects.toThrow(WorkerTeardownPendingError);
        expect((await fence.read("physical-del-2")).kind).toBe("present");
      } finally {
        await manager.shutdownAll().catch(() => {});
        await manager2.shutdownAll().catch(() => {});
      }
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}, 15_000);

test("takeover after proven death mints a new generation; the stale executor goes impotent", async () => {
  const dir = await mkdtemp(join(tmpdir(), "fence-takeover-"));
  try {
    await withFakeEntry(async (entry) => {
      const fenceDir = join(dir, "fences");
      const manager = new RuntimeWorkerManager({ entryPath: entry, fenceDir });
      try {
        const fence = new RuntimeWorkerFence(fenceDir);
        const key = "physical-takeover-1";
        // Foreign but live deleter (the test runner itself): must refuse,
        // never share the generation.
        await fence.claim({
          kind: "runtime-worker-owner",
          logicalSessionId: key,
          generation: "gen-old",
          pid: process.ppid,
          bootstrapVerified: false,
          phase: "deleting",
          startedAt: new Date().toISOString(),
          agent: "runtime-worker",
        });
        await expect(manager.claimPhysicalDeletion(key)).rejects.toThrow(/still alive/);
        // ...while a proven-dead deleter is taken over with a NEW generation.
        await fence.retireDeletion(key, "gen-old");
        await fence.claim({
          kind: "runtime-worker-owner",
          logicalSessionId: key,
          generation: "gen-dead",
          pid: 424242,
          bootstrapVerified: false,
          phase: "deleting",
          startedAt: new Date().toISOString(),
          agent: "runtime-worker",
        });
        const take = await manager.claimPhysicalDeletion(key);
        expect(take?.adopted).toBe(true);
        expect(take?.generation).not.toBe("gen-dead");
        // The stale generation can neither revalidate nor retire: no
        // "H2 retired, successor claimed, H1 still unlinks" sequence exists.
        await expect(manager.revalidatePhysicalDeletion(key, "gen-dead")).rejects.toThrow(
          WorkerTeardownPendingError,
        );
        await expect(manager.retirePhysicalDeletion(key, "gen-dead")).rejects.toThrow();
        const live = await fence.read(key);
        expect(live.kind).toBe("present");
        if (live.kind !== "present") return;
        expect(live.record.generation).toBe(take?.generation);
        expect(live.record.phase).toBe("deleting");
        // The rightful owner completes.
        await manager.revalidatePhysicalDeletion(key, take!.generation);
        await manager.retirePhysicalDeletion(key, take!.generation);
        expect(await fence.read(key)).toEqual({ kind: "absent" });
      } finally {
        await manager.shutdownAll().catch(() => {});
      }
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}, 15_000);

test("assertOwnershipQuiescent lets a delete adopt deleting but blocks logical release", async () => {
  const dir = await mkdtemp(join(tmpdir(), "fence-delquiesce-"));
  try {
    await withFakeEntry(async (entry) => {
      const fenceDir = join(dir, "fences");
      const manager = new RuntimeWorkerManager({ entryPath: entry, fenceDir });
      try {
        const fence = new RuntimeWorkerFence(fenceDir);
        await fence.claim({
          kind: "runtime-worker-owner",
          logicalSessionId: "physical-del-3",
          generation: "gen-del",
          pid: process.pid,
          bootstrapVerified: false,
          phase: "deleting",
          startedAt: new Date().toISOString(),
          agent: "runtime-worker",
        });
        await expect(manager.assertOwnershipQuiescent("lid-x", "physical-del-3")).rejects.toThrow(
          WorkerTeardownPendingError,
        );
        await expect(
          manager.assertOwnershipQuiescent("lid-x", "physical-del-3", { allowDeleting: true }),
        ).resolves.toBeUndefined();
      } finally {
        await manager.shutdownAll().catch(() => {});
      }
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}, 15_000);

test("discharged Job fences retain ownership until worker and supervisor are gone and containment is empty", async () => {
  const dir = await mkdtemp(join(tmpdir(), "fence-job-quiescence-"));
  try {
    await withFakeEntry(async (entry) => {
      const fenceDir = join(dir, "fences");
      const fence = new RuntimeWorkerFence(fenceDir);
      const generation = randomUUID();
      const workerPid = 1234;
      const supervisorPid = 4321;
      const current: RuntimeWorkerFenceRecord = {
        kind: "runtime-worker-owner", logicalSessionId: "physical-job", generation,
        pid: workerPid, creationDate: "133800000000000000", bootstrapVerified: true,
        phase: "discharged", startedAt: new Date().toISOString(), agent: "runtime-worker",
        jobName: windowsJobNameForGeneration(generation)!, jobAttested: true,
        supervisorPid, supervisorCreationDate: "133800000000000000",
      };
      for (const worker of ["alive", "unknown", "gone"] as const) {
        for (const supervisor of ["alive", "unknown", "gone"] as const) {
          for (const containment of ["active", "unknown", "empty", "absent"] as const) {
            await fence.write(current);
            const manager = new RuntimeWorkerManager({
              entryPath: entry, fenceDir,
              clientDeps: {
                platform: "win32", selfDischargeWaitMs: 0,
                probeWindowsIdentity: async (pid) => {
                  const state = pid === workerPid ? worker : supervisor;
                  if (state === "gone") return { status: "missing" };
                  if (state === "unknown") return { status: "unavailable" };
                  return await probeTestIdentity(pid);
                },
                querySupervisorContainment: async () => containment,
              },
            });
            const quiescent = manager.assertOwnershipQuiescent("logical-job", "physical-job");
            if (worker === "gone" && supervisor === "gone" && (containment === "empty" || containment === "absent")) {
              await expect(quiescent).resolves.toBeUndefined();
              expect(await fence.read("physical-job")).toEqual({ kind: "absent" });
            } else {
              await expect(quiescent).rejects.toBeInstanceOf(WorkerTeardownPendingError);
              expect(await fence.read("physical-job")).toEqual({ kind: "present", record: current });
            }
          }
        }
      }
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}, 15_000);

test("stale owned CAS retains the local client when orphan termination cannot be verified", async () => {
  const dir = await mkdtemp(join(tmpdir(), "fence-stale-termfail-"));
  try {
    await withFakeEntry(async (entry) => {
      const fence = new RuntimeWorkerFence(dir);
      const originalCas = RuntimeWorkerFence.prototype.compareAndSwap;
      const casSpy = spyOn(RuntimeWorkerFence.prototype, "compareAndSwap").mockImplementation(async (key, expected, current) => {
        if (current.phase === "owned") throw new StaleFenceGenerationError("successor generation owns the fence");
        return await originalCas.call(fence, key, expected, current);
      });
      const termSpy = spyOn(RuntimeWorkerClient.prototype, "terminate").mockImplementation(async () => {
        throw new Error("orphan termination is unverified");
      });
      const manager = new RuntimeWorkerManager({ entryPath: entry, fenceDir: dir });
      try {
        await expect(manager.acquire("stale-retained")).rejects.toThrow(/retained for teardown/);
        expect(manager.get("stale-retained")?.alive).toBe(true);
        expect(manager.physicalFenceKeyFor("stale-retained")).toBe("stale-retained");
        const read = await fence.read("stale-retained");
        expect(read.kind).toBe("present");
        if (read.kind === "present") expect(read.record.phase).toBe("claiming");
      } finally {
        casSpy.mockRestore();
        termSpy.mockRestore();
        await manager.shutdownAll();
      }
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}, 20_000);
