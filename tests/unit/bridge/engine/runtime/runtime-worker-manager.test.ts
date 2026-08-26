import { expect, test } from "bun:test";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { RuntimeWorkerManager } from "../../../../../src/bridge/engine/runtime/runtime-worker-manager";

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

test("crash-loop guard blocks respawn once the restart budget is exhausted", async () => {
  await withFakeEntry(async (entry) => {
    // max=1: first spawn consumes the budget, second respawn must be refused.
    const manager = new RuntimeWorkerManager({ entryPath: entry, maxRestartsPerWindow: 1, restartWindowMs: 60_000 });
    const first = manager.ensureWorker("crashy");
    await first.terminate(); // death #1 consumes the budget (respawn = restart #1)
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
