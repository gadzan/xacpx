import { expect, test } from "bun:test";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { RuntimeWorkerManager, WorkerTeardownPendingError } from "../../../../../src/bridge/engine/runtime/runtime-worker-manager";

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
    const manager = new RuntimeWorkerManager({ entryPath: entry });
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
    const manager = new RuntimeWorkerManager({ entryPath: entry });
    const a = manager.ensureWorker("logical-a");
    const b = manager.ensureWorker("logical-b");
    expect(a).not.toBe(b);
    expect(a.ref.pid).not.toBe(b.ref.pid);
    await manager.shutdownAll();
  });
}, 15_000);

test("shutdownAll stops every registered worker", async () => {
  await withFakeEntry(async (entry) => {
    const manager = new RuntimeWorkerManager({ entryPath: entry, maxRestartsPerWindow: 1, restartWindowMs: 5_000 });
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
    const manager = new RuntimeWorkerManager({ entryPath: entry, maxRestartsPerWindow: 1, restartWindowMs: 60_000 });
    const first = manager.ensureWorker("crashy");
    await first.terminate();
    expect(() => manager.ensureWorker("crashy")).not.toThrow();
    // A worker killed unexpectedly by a signal (kill -9) IS an untracked crash:
    // the restart budget is charged and respawn is refused.
    const second = manager.ensureWorker("crashy");
    process.kill(second.ref.pid, "SIGKILL");
    // Await exit deterministically (no arbitrary delays)
    const deadline = Date.now() + 2_000;
    while (second.alive && Date.now() < deadline) {
      await new Promise<void>((r) => setTimeout(r, 5));
    }
    await new Promise<void>((r) => setTimeout(r, 50));
    expect(() => manager.ensureWorker("crashy")).toThrow(/marked unhealthy|crashed|refusing duplicate worker spawn|failed/);
  });
}, 15_000);

test("ensureWorker returns a ref carrying stable identity fields", async () => {
  await withFakeEntry(async (entry) => {
    const manager = new RuntimeWorkerManager({ entryPath: entry });
    const worker = manager.ensureWorker("identity-check");
    expect(worker.ref.logicalSessionId).toBe("identity-check");
    expect(worker.ref.generation).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    expect(worker.ref.startedAt).toBeTypeOf("string");
    await manager.shutdownAll();
  });
}, 15_000);

test("ensureWorker refuses duplicate spawn when existing worker is still alive in cooling/stopped state", async () => {
  await withFakeEntry(async (entry) => {
    const manager = new RuntimeWorkerManager({ entryPath: entry });
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
    const manager = new RuntimeWorkerManager({ entryPath: entry });
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
          platform: "win32",
          probeWindowsIdentity: async (pid) => ({
            status: "found",
            identity: {
              pid,
              creationDate: "133800000000000000",
              executablePath: "C:\\node.exe",
              commandLine: "node worker.mjs",
            },
          }),
          terminateProcessTree: async () => ({ rootOutcome: "killed", outcomes: [] }),
        },
      });
      const worker1 = await manager.acquire("sess-admitted");
      // Wait for bootstrap barrier to complete (admitted fence)
      for (let i = 0; i < 50; i++) {
        const fence = new (await import("../../../../../src/bridge/engine/runtime/runtime-worker-fence")).RuntimeWorkerFence(fenceDir);
        const read = await fence.read("sess-admitted");
        if (read.kind === "present" && read.record.phase === "admitted") break;
        await new Promise((r) => setTimeout(r, 20));
      }
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
    let termResolve: (() => void) | undefined;
    const termPromise = new Promise<void>((r) => { termResolve = r; });

    const manager = new RuntimeWorkerManager({
      entryPath: entry,
      clientDeps: {
        terminateProcessTree: async () => {
          await termPromise;
          return { rootOutcome: "killed", outcomes: [] };
        },
      },
    });

    const client = manager.ensureWorker("sess-race-teardown");
    await client.request("ensure", {});

    // Start background shutdown (holds tree termination pending)
    const shutdownPromise = client.shutdown(2_000);

    // Give a short tick for shutdown RPC to deliver
    await new Promise((r) => setTimeout(r, 20));

    // While tree cleanup is in flight, concurrent ensureWorker MUST fail closed!
    expect(() => manager.ensureWorker("sess-race-teardown")).toThrow(WorkerTeardownPendingError);

    // Release tree termination
    termResolve?.();
    await shutdownPromise;
    expect(client.lifecycle).toBe("stopped");

    // After cleanup is verified complete, replacement spawn is allowed
    expect(() => manager.ensureWorker("sess-race-teardown")).not.toThrow();

    await manager.shutdownAll();
  });
});

test("unexpected worker crash cleans up process tree before allowing replacement spawn", async () => {
  await withFakeEntry(async (entry) => {
    let cleanupRun = false;
    let termResolve: (() => void) | undefined;
    const termPromise = new Promise<void>((r) => { termResolve = r; });

    const manager = new RuntimeWorkerManager({
      entryPath: entry,
      maxRestartsPerWindow: 5,
      clientDeps: {
        terminateProcessTree: async () => {
          cleanupRun = true;
          await termPromise;
          return { rootOutcome: "killed", outcomes: [] };
        },
      },
    });

    const client = manager.ensureWorker("sess-crash-clean");
    await client.request("ensure", {});

    // Kill worker root abruptly to simulate unexpected crash
    process.kill(client.ref.pid, "SIGKILL");

    // Give a short tick for exit event to fire and start cleanup
    await new Promise((r) => setTimeout(r, 20));

    // While tree cleanup is in flight, concurrent ensureWorker MUST reject
    expect(() => manager.ensureWorker("sess-crash-clean")).toThrow(WorkerTeardownPendingError);

    // Release tree termination
    termResolve?.();

    // Wait for tree cleanup to finish
    await new Promise((r) => setTimeout(r, 50));

    // Process tree cleanup was executed
    expect(cleanupRun).toBe(true);

    // After cleanup is verified complete, replacement spawn is allowed within budget!
    expect(() => manager.ensureWorker("sess-crash-clean")).not.toThrow();

    await manager.shutdownAll();
  });
});
