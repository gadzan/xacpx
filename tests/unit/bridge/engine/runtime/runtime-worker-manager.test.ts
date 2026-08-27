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
    while (manager.lifecycleFor("crashy") !== "failed" && Date.now() < deadline) {
      await new Promise<void>((r) => setTimeout(r, 5));
    }
    expect(() => manager.ensureWorker("crashy")).toThrow(/marked unhealthy|crashed/);
  });
}, 15_000);

test("ensureWorker returns a ref carrying stable identity fields", async () => {
  await withFakeEntry(async (entry) => {
    const manager = new RuntimeWorkerManager({ entryPath: entry });
    const worker = manager.ensureWorker("identity-check");
    expect(worker.ref.logicalSessionId).toBe("identity-check");
    expect(worker.ref.generation).toMatch(/^[0-9a-z]+-[0-9a-z]+$/);
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
