import { expect, test } from "bun:test";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

import { RuntimeEngine } from "../../../../../src/bridge/engine/runtime-engine";

const MOCK_AGENT = join(import.meta.dir, "../../../../fixtures/mock-acp-agent.mjs");
const base = { agent: "mock", acpxAgent: "mock", agentArgv: [process.execPath, MOCK_AGENT], cwd: "/tmp", name: "g3-sess", logicalSessionId: "g3-1" };

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

async function buildWorker(dir: string): Promise<string> {
  const workerOutDir = join(dir, "dist", "bridge", "engine", "runtime");
  const workerFile = join(workerOutDir, "runtime-worker-main.js");
  const result = await Bun.build({
    entrypoints: [resolve(process.cwd(), "./src/bridge/engine/runtime/runtime-worker-main.ts")],
    outdir: workerOutDir,
    target: "node",
    external: ["acpx", "node-pty", "fs-ext", "write-file-atomic"],
  });
  if (!result.success) throw new Error(`Bun.build failed: ${result.logs.join("\n")}`);
  return workerFile;
}

test("G3: real Runtime freeWarm → respawn same record/history (prompt #1 → freeWarm → prompt #2)", async () => {
  const dir = await mkdtemp(join(tmpdir(), "g3-freewarm-"));
  const stateDir = join(dir, "state", "sessions");
  const queueDir = join(dir, "queue");
  const fenceDir = join(dir, "fences");
  const workerFile = await buildWorker(dir);
  const key = workerKey(base);

  const engine = new RuntimeEngine({
    workerEntryPath: workerFile,
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
  }
}, 60_000);

test("G3 TTL: idleTtlMs expiry → new worker pid, same recordId/history", async () => {
  const dir = await mkdtemp(join(tmpdir(), "g3-ttl-"));
  const stateDir = join(dir, "state", "sessions");
  const queueDir = join(dir, "queue");
  const fenceDir = join(dir, "fences");
  const workerFile = await buildWorker(dir);
  const key = workerKey(base);

  const engine = new RuntimeEngine({
    workerEntryPath: workerFile,
    stateDir,
    queueDir,
    fenceDir,
    idleTtlMs: 200,
    permissionMode: "approve-all",
  } as unknown as ConstructorParameters<typeof RuntimeEngine>[0]);

  try {
    const res1 = await engine.prompt({ ...base, text: "g3 ttl first" }, async () => {});
    expect(res1.text.length).toBeGreaterThan(0);
    const pid1 = getWorkerPid(engine, key);
    expect(typeof pid1).toBe("number");
    const recordId1 = await findRecordId(stateDir, base.name);
    expect(typeof recordId1).toBe("string");
    expect((await engine.isSessionWarm(base)).warm).toBe(true);

    // Integration: real idle TTL requires wall-clock delay; fake timers cannot drive the worker process reaper.
    await new Promise<void>((resolve) => setTimeout(resolve, 600));
    // Poll warm until false (reap is async)
    for (let i = 0; i < 10; i++) {
      if (!(await engine.isSessionWarm(base)).warm) break;
      await new Promise<void>((r) => setTimeout(r, 100));
    }
    expect((await engine.isSessionWarm(base)).warm).toBe(false);
    // TTL reaps warm state; pid may still be cached until next ensure, so verify warm=false and record still exists
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
  }
}, 60_000);
