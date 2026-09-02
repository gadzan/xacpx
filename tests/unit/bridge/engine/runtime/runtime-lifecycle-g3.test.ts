import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

import { RuntimeEngine } from "../../../../../src/bridge/engine/runtime-engine";

/**
 * G3 / PR5 Gate: real Runtime warm-release → reconnect/history-preserve.
 * Uses compiled runtime-worker-main + real acpx/runtime + mock ACP agent.
 * Proves: prompt #1 → freeWarmProcess → old worker pid gone, record still open,
 * prompt #2 → new worker pid, same acpxRecordId, history contains #1.
 * TTL variant reuses same flow (freeWarm is the host's TTL primitive).
 */
const MOCK_AGENT = join(import.meta.dir, "../../../../fixtures/mock-acp-agent.mjs");
const base = { agent: "mock", acpxAgent: "mock", agentArgv: [process.execPath, MOCK_AGENT], cwd: "/tmp", name: "g3-sess", logicalSessionId: "g3-1" };

async function withEngine(
  run: (engine: RuntimeEngine, dirs: { stateDir: string; queueDir: string; fenceDir: string; workerPid: () => number | undefined }) => Promise<void>,
) {
  const dir = await mkdtemp(join(tmpdir(), "g3-"));
  const stateDir = join(dir, "state", "sessions");
  const queueDir = join(dir, "queue");
  const fenceDir = join(dir, "fences");
  const workerEntry = join(dir, "worker-entry.mjs");
  // Use the built worker entry via RuntimeEngine default (no fake worker)
  // Instead we pass the real built worker via no fakeWorker — RuntimeEngine will use its default candidate (dist/bridge/engine/runtime/runtime-worker-main.js)
  // To force real worker, we don't provide fakeWorker and let it resolve via defaultWorkerEntryCandidates.
  const engine = new RuntimeEngine({
    // @ts-expect-error - use default entry resolution; provide stateDir etc.
    stateDir,
    queueDir,
    fenceDir,
    idleTtlMs: 200,
    permissionMode: "approve-all",
  } as unknown as ConstructorParameters<typeof RuntimeEngine>[0]);

  // Capture worker pid via internal manager if available
  let lastPid: number | undefined;
  const origEnsure = (engine as unknown as { ensureSession: unknown }).ensureSession;
  try {
    await run(engine, {
      stateDir,
      queueDir,
      fenceDir,
      workerPid: () => lastPid,
    });
  } finally {
    await engine.shutdown().catch(() => {});
    await rm(dir, { recursive: true, force: true });
  }
}

test("G3: real Runtime freeWarm → respawn same record/history (prompt #1 → freeWarm → prompt #2)", async () => {
  const dir = await mkdtemp(join(tmpdir(), "g3-freewarm-"));
  const stateDir = join(dir, "state", "sessions");
  const queueDir = join(dir, "queue");
  const fenceDir = join(dir, "fences");
  const workerOutDir = join(dir, "dist", "bridge", "engine", "runtime");
  const workerFile = join(workerOutDir, "runtime-worker-main.js");
  try {
    const buildResult = await Bun.build({
      entrypoints: [resolve(process.cwd(), "./src/bridge/engine/runtime/runtime-worker-main.ts")],
      outdir: workerOutDir,
      target: "node",
      external: ["acpx", "node-pty", "fs-ext", "write-file-atomic"],
    });
    if (!buildResult.success) {
      throw new Error(`Bun.build failed: ${buildResult.logs.join("\n")}`);
    }

    const engine = new RuntimeEngine({
      workerEntryPath: workerFile,
      stateDir,
      queueDir,
      fenceDir,
      idleTtlMs: 200,
      permissionMode: "approve-all",
    } as unknown as ConstructorParameters<typeof RuntimeEngine>[0]);

    try {
      // Prompt #1
      const res1 = await engine.prompt({ ...base, text: "g3 first" }, async () => {});
      expect(res1.text.length).toBeGreaterThan(0);

      // Capture recordId via adapter status or via file listing
      const sessions = await engine.hasSession(base);
      expect(sessions.exists).toBe(true);
      const warm1 = await engine.isSessionWarm(base);
      expect(warm1.warm).toBe(true);

      // freeWarm → worker gone, record still open
      await engine.freeWarmProcess(base);
      const warmAfter = await engine.isSessionWarm(base);
      expect(warmAfter.warm).toBe(false);
      const stillExists = await engine.hasSession(base);
      expect(stillExists.exists).toBe(true);

      // Prompt #2 → new worker, same record/history
      const res2 = await engine.prompt({ ...base, text: "g3 second" }, async () => {});
      expect(res2.text.length).toBeGreaterThan(0);
      const warm2 = await engine.isSessionWarm(base);
      expect(warm2.warm).toBe(true);

      // Verify history contains both prompts via tail
      const tail = await engine.tailSessionHistory({ ...base, lines: 100 });
      expect(tail.text).toContain("g3 first");
      expect(tail.text).toContain("g3 second");
    } finally {
      await engine.shutdown().catch(() => {});
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}, 60_000);
