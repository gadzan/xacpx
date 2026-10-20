import { expect, test } from "bun:test";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { RuntimeEngine } from "../../../../../src/bridge/engine/runtime-engine";
import { buildTestRuntimeWorker } from "../../../../helpers/build-test-runtime-worker";

const MOCK_AGENT = join(import.meta.dir, "../../../../fixtures/mock-acp-agent.mjs");
const base = { agent: "mock", acpxAgent: "mock", agentArgv: [process.execPath, MOCK_AGENT], cwd: tmpdir(), name: "g3-sess", logicalSessionId: "g3-1" };

function workerKey(input: typeof base): string {
  return input.logicalSessionId ?? input.name;
}

function getWorkerPid(engine: RuntimeEngine, key: string): number | undefined {
  const mgr = (engine as unknown as { manager?: { get: (k: string) => { ref?: { pid?: number } } | undefined } }).manager;
  return mgr?.get(key)?.ref?.pid;
}

async function findRecordId(stateDir: string, name: string): Promise<string | undefined> {
  const files = await readdir(stateDir).catch(() => [] as string[]);
  for (const f of files) {
    if (!f.endsWith(".json")) continue;
    try {
      const raw = JSON.parse(await readFile(join(stateDir, f), "utf8")) as Record<string, unknown>;
      if (raw["name"] === name && typeof raw["acpx_record_id"] === "string") {
        return raw["acpx_record_id"] as string;
      }
    } catch {}
  }
  return undefined;
}

test("G3: real Runtime freeWarm → respawn same record/history (prompt #1 → freeWarm → prompt #2)", async () => {
  const dir = await mkdtemp(join(tmpdir(), "g3-freewarm-"));
  const stateDir = join(dir, "state", "sessions");
  const queueDir = join(dir, "queue");
  const fenceDir = join(dir, "fences");
  const worker = await buildTestRuntimeWorker();
  const key = workerKey(base);

  const engine = new RuntimeEngine({
    workerEntryPath: worker.entryPath,
    stateDir,
    queueDir,
    fenceDir,
    idleTtlMs: 60_000,
    permissionMode: "approve-all",
  } as unknown as ConstructorParameters<typeof RuntimeEngine>[0]);

  try {
    // Prompt #1
    const res1 = await engine.prompt({ ...base, text: "g3 first" }, async () => {});
    expect(res1.text.length).toBeGreaterThan(0);

    const warm1 = await engine.isSessionWarm(base);
    expect(warm1.warm).toBe(true);
    const pid1 = getWorkerPid(engine, key);
    expect(typeof pid1).toBe("number");
    const recordId1 = await findRecordId(stateDir, base.name);
    expect(typeof recordId1).toBe("string");

    // freeWarm → worker gone, record still open, same recordId
    await engine.freeWarmProcess(base);
    const warmAfter = await engine.isSessionWarm(base);
    expect(warmAfter.warm).toBe(false);
    const pidAfter = getWorkerPid(engine, key);
    expect(pidAfter).toBeUndefined();
    const stillExists = await engine.hasSession(base);
    expect(stillExists.exists).toBe(true);
    const recordIdAfter = await findRecordId(stateDir, base.name);
    expect(recordIdAfter).toBe(recordId1);

    // Prompt #2 → new worker, same recordId, history contains both
    const res2 = await engine.prompt({ ...base, text: "g3 second" }, async () => {});
    expect(res2.text.length).toBeGreaterThan(0);
    const pid2 = getWorkerPid(engine, key);
    expect(typeof pid2).toBe("number");
    expect(pid2).not.toBe(pid1);
    const recordId2 = await findRecordId(stateDir, base.name);
    expect(recordId2).toBe(recordId1);
    const warm2 = await engine.isSessionWarm(base);
    expect(warm2.warm).toBe(true);

    const tail = await engine.tailSessionHistory({ ...base, lines: 100 });
    expect(tail.text).toContain("g3 first");
    expect(tail.text).toContain("g3 second");
  } finally {
    await engine.shutdown().catch(() => {});
    await rm(dir, { recursive: true, force: true });
    await worker.release();
  }
}, 120_000);

test("G3 TTL: idleTtlMs expiry → new worker pid, same recordId/history", async () => {
  const dir = await mkdtemp(join(tmpdir(), "g3-ttl-"));
  const stateDir = join(dir, "state", "sessions");
  const queueDir = join(dir, "queue");
  const fenceDir = join(dir, "fences");
  const worker = await buildTestRuntimeWorker();
  const key = workerKey(base);

  const engine = new RuntimeEngine({
    workerEntryPath: worker.entryPath,
    stateDir,
    queueDir,
    fenceDir,
    idleTtlMs: 200,
    permissionMode: "approve-all",
  } as unknown as ConstructorParameters<typeof RuntimeEngine>[0]);

  try {
    const manager = engine["manager"]!;
    const res1 = await engine.prompt({ ...base, text: "g3 ttl first" }, async () => {});
    expect(res1.text.length).toBeGreaterThan(0);
    const firstClient = manager.get(key)!;
    const pid1 = firstClient.ref.pid;
    expect(pid1).toBeGreaterThan(0);
    const recordId1 = await findRecordId(stateDir, base.name);
    expect(typeof recordId1).toBe("string");
    expect((await engine.isSessionWarm(base)).warm).toBe(true);
    // Observe the engine's own idle-shutdown reaching completion, then the
    // NEXT engine prompt must replace the owner on its own (no test-driven
    // release): failing there is a genuine production bug.
    const cooled = Promise.withResolvers<void>();
    const engineCools = firstClient.shutdown.bind(firstClient);
    firstClient.shutdown = async (graceMs) => {
      try {
        await engineCools(graceMs);
        cooled.resolve();
      } catch (error) {
        cooled.reject(error);
        throw error;
      }
    };

    await cooled.promise;
    expect(firstClient.alive).toBe(false);
    expect(firstClient.lifecycle).toBe("stopped");
    expect((await engine.isSessionWarm(base)).warm).toBe(false);
    expect((await engine.hasSession(base)).exists).toBe(true);
    expect(await findRecordId(stateDir, base.name)).toBe(recordId1);
    const res2 = await engine.prompt({ ...base, text: "g3 ttl second" }, async () => {});
    expect(res2.text.length).toBeGreaterThan(0);
    const pid2 = getWorkerPid(engine, key);
    expect(typeof pid2).toBe("number");
    expect(pid2).not.toBe(pid1);
    expect(await findRecordId(stateDir, base.name)).toBe(recordId1);

    const tail = await engine.tailSessionHistory({ ...base, lines: 100 });
    expect(tail.text).toContain("g3 ttl first");
    expect(tail.text).toContain("g3 ttl second");
  } finally {
    await engine.shutdown().catch(() => {});
    await rm(dir, { recursive: true, force: true });
    await worker.release();
  }
}, 120_000);
