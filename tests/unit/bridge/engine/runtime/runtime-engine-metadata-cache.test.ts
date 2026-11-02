import { expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { RuntimeEngine } from "../../../../../src/bridge/engine/runtime-engine";
import type { RuntimeWorkerClientDeps } from "../../../../../src/bridge/engine/runtime/runtime-worker-client";

const fakeWorkerClientDeps: RuntimeWorkerClientDeps = {
  platform: "win32",
  probeWindowsIdentity: async (pid) => ({ status: "found", identity: { pid, creationDate: "133500000000000000" } }),
  terminateProcessTree: async (target) => {
    try { process.kill(typeof target === "number" ? target : target.pid, "SIGKILL"); } catch {}
    return { rootOutcome: "killed", outcomes: [] };
  },
};

const sessionInput = {
  agent: "codex",
  cwd: "/repo",
  name: "demo",
  logicalSessionId: "logical-metadata-1",
};

/** Fake worker that reports a fixed model/effort catalog and journals every
 *  status/setConfigOption call so tests can prove cache hits skipped the wire. */
async function withMetadataWorker(entry: string, journal: string): Promise<void> {
  await writeFile(
    entry,
    [
      "import { appendFileSync } from 'node:fs';",
      `const JOURNAL = ${JSON.stringify(journal)};`,
      "let buffer='';",
      "process.stdin.on('data', (d) => {",
      "  buffer += d.toString();",
      "  let idx;",
      "  while ((idx = buffer.indexOf('\\n')) >= 0) {",
      "    const line = buffer.slice(0, idx); buffer = buffer.slice(idx + 1);",
      "    if (!line) continue;",
      "    try { const msg = JSON.parse(line);",
      "      if (msg.method === 'status') {",
      "        appendFileSync(JOURNAL, 'status\\n');",
      "        process.stdout.write(JSON.stringify({ id: msg.id, ok: true, result: {",
      "          models: { currentModelId: 'm1', availableModelIds: ['m1', 'm2'] },",
      "          details: { configOptions: [{ id: 'effort', category: 'thought_level', currentValue: 'medium', options: [{ value: 'low' }, { value: 'medium' }, { value: 'high' }] }] },",
      "        } }) + '\\n');",
      "      } else if (msg.method === 'ensure') {",
      "        process.stdout.write(JSON.stringify({ id: msg.id, ok: true, result: { ready: true, sessionKey: msg.params.sessionKey, acpxRecordId: 'rec-test-1' } }) + '\\n');",
      "      } else if (msg.method === 'setConfigOption') {",
      "        appendFileSync(JOURNAL, `set:${msg.params.key}=${msg.params.value}\\n`);",
      "        process.stdout.write(JSON.stringify({ id: msg.id, ok: true, result: {} }) + '\\n');",
      "      } else {",
      "        process.stdout.write(JSON.stringify({ id: msg.id, ok: true, result: {} }) + '\\n');",
      "      }",
      "      if (msg.method === 'shutdown') process.exit(0);",
      "    } catch {}",
      "  }",
      "});",
    ].join("\n"),
  );
}

async function journalLines(path: string): Promise<string[]> {
  try {
    return (await readFile(path, "utf8")).split("\n").filter(Boolean);
  } catch {
    return [];
  }
}

async function waitFor<T>(read: () => Promise<T | undefined>, timeoutMs = 5_000): Promise<T> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const value = await read();
    if (value !== undefined) return value;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("timed out waiting for the metadata cache to fill");
}

async function withEngine(
  run: (engine: RuntimeEngine, journal: string) => Promise<void>,
): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "rt-metadata-"));
  try {
    const entry = join(dir, "fake-worker.mjs");
    const journal = join(dir, "journal.log");
    await withMetadataWorker(entry, journal);
    const stateDir = join(dir, "state", "sessions");
    await mkdir(stateDir, { recursive: true });
    const engine = new RuntimeEngine({
      workerClientDeps: fakeWorkerClientDeps,
      workerEntryPath: entry,
      permissionMode: "approve-all",
      stateDir,
      queueDir: join(dir, "queue"),
      fenceDir: join(dir, "fences"),
    });
    try {
      await run(engine, journal);
    } finally {
      await engine.shutdown();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("a cold metadata read is unknown and never waits for the worker", async () => {
  await withEngine(async (engine, journal) => {
    const first = await engine.getSessionModel(sessionInput);
    expect(first).toEqual({ available: [] });

    // The fire-and-forget refresh fills the cache; later reads are served from it.
    const warmed = await waitFor(async () => {
      const read = await engine.getSessionModel(sessionInput);
      return read.current === "m1" ? read : undefined;
    });
    expect(warmed).toEqual({ current: "m1", available: ["m1", "m2"] });
    expect(await engine.getSessionEffort(sessionInput)).toEqual({
      current: "medium",
      available: ["low", "medium", "high"],
    });

    // Exactly one status round-trip: the first read kicked one refresh.
    expect(await journalLines(journal)).toEqual(["status"]);
  });
}, 20_000);

test("refresh bypasses the cache and re-reads the worker", async () => {
  await withEngine(async (engine, journal) => {
    await engine.getSessionModel({ ...sessionInput, refresh: true });
    await engine.setModel({ ...sessionInput, modelId: "m2" });
    // The setter wrote m2 into the cache...
    expect(await engine.getSessionModel(sessionInput)).toEqual({
      current: "m2",
      available: ["m1", "m2"],
    });
    const before = (await journalLines(journal)).length;
    // ...but a forced refresh must describe the worker's real state, not the cache.
    expect(await engine.getSessionModel({ ...sessionInput, refresh: true })).toEqual({
      current: "m1",
      available: ["m1", "m2"],
    });
    expect((await journalLines(journal)).slice(before)).toEqual(["status"]);
  });
}, 20_000);

test("a successful setModel updates the cache without another status read", async () => {
  await withEngine(async (engine, journal) => {
    await engine.getSessionModel({ ...sessionInput, refresh: true });
    const afterRead = await journalLines(journal);
    expect(afterRead).toEqual(["status"]);

    await engine.setModel({ ...sessionInput, modelId: "m2" });
    expect(await engine.getSessionModel(sessionInput)).toEqual({
      current: "m2",
      available: ["m1", "m2"],
    });
    // No extra status request was needed to answer the cached read.
    expect(await journalLines(journal)).toEqual(["status", "set:model=m2"]);
  });
}, 20_000);

test("freeWarmProcess drops the snapshot so the next read is unknown again", async () => {
  await withEngine(async (engine, journal) => {
    await engine.getSessionModel({ ...sessionInput, refresh: true });
    expect(await engine.getSessionModel(sessionInput)).toEqual({
      current: "m1",
      available: ["m1", "m2"],
    });

    await engine.freeWarmProcess(sessionInput);
    expect(await engine.getSessionModel(sessionInput)).toEqual({ available: [] });
  });
}, 20_000);
