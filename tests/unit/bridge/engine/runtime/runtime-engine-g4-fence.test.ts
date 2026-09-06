import { expect, test, describe } from "bun:test";
import { createHash } from "node:crypto";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { RuntimeEngine, type EngineSessionInput } from "../../../../../src/bridge/engine/runtime-engine";
import { RuntimeWorkerManager, WorkerTeardownPendingError } from "../../../../../src/bridge/engine/runtime/runtime-worker-manager";
import { RuntimeWorkerFence, type RuntimeWorkerFenceRecord } from "../../../../../src/bridge/engine/runtime/runtime-worker-fence";

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
      "      if (msg.method === 'ensure') {",
      "        process.stdout.write(JSON.stringify({ id: msg.id, ok: true, result: { ready: true, sessionKey: msg.params?.sessionKey, acpxRecordId: 'real-acpx-rec-1234' } }) + '\\n');",
      "      } else if (msg.method === 'prompt') {",
      "        process.stdout.write(JSON.stringify({ id: msg.id, event: 'text_delta', payload: { type: 'text_delta', text: 'ok' } }) + '\\n');",
      "        process.stdout.write(JSON.stringify({ id: msg.id, ok: true, result: { result: { status: 'completed' }, finalText: 'ok' } }) + '\\n');",
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

function computePhysicalFenceKey(input: EngineSessionInput): string {
  const agentId = input.agentCommand ?? input.rawCommand ?? input.acpxAgent ?? input.agent ?? "";
  const sessionKey = input.name ?? "";
  const raw = `${sessionKey}\x00${input.cwd ?? ""}\x00${agentId}`;
  return createHash("sha256").update(raw).digest("hex").slice(0, 32);
}

describe("RuntimeWorkerManager assertOwnershipQuiescent & physicalFenceKeyFor", () => {
  test("assertOwnershipQuiescent succeeds when worker is absent and fence is absent", async () => {
    const dir = await mkdtemp(join(tmpdir(), "rt-mgr-fence-"));
    const fenceDir = join(dir, "fences");
    await mkdir(fenceDir, { recursive: true });
    try {
      const entry = join(dir, "fake-worker.mjs");
      await withFakeWorker(entry);
      const manager = new RuntimeWorkerManager({ entryPath: entry, fenceDir });
      await expect(manager.assertOwnershipQuiescent("logical-1", "physical-1")).resolves.toBeUndefined();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("assertOwnershipQuiescent throws WorkerTeardownPendingError when worker is active", async () => {
    const dir = await mkdtemp(join(tmpdir(), "rt-mgr-fence-"));
    const fenceDir = join(dir, "fences");
    await mkdir(fenceDir, { recursive: true });
    try {
      const entry = join(dir, "fake-worker.mjs");
      await withFakeWorker(entry);
      const manager = new RuntimeWorkerManager({ entryPath: entry, fenceDir });
      manager.ensureWorker("logical-active");
      await expect(manager.assertOwnershipQuiescent("logical-active", "physical-1")).rejects.toThrow(
        WorkerTeardownPendingError,
      );
      await manager.shutdownAll();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("assertOwnershipQuiescent throws WorkerTeardownPendingError when fence is present and not discharged", async () => {
    const dir = await mkdtemp(join(tmpdir(), "rt-mgr-fence-"));
    const fenceDir = join(dir, "fences");
    await mkdir(fenceDir, { recursive: true });
    try {
      const entry = join(dir, "fake-worker.mjs");
      await withFakeWorker(entry);
      const manager = new RuntimeWorkerManager({ entryPath: entry, fenceDir });
      const fence = new RuntimeWorkerFence(fenceDir);
      await fence.write({
        kind: "runtime-worker-owner",
        logicalSessionId: "physical-active",
        generation: "gen-1",
        pid: 12345,
        creationDate: null,
        bootstrapVerified: true,
        phase: "admitted",
        startedAt: new Date().toISOString(),
        agent: "runtime-worker",
      });

      await expect(manager.assertOwnershipQuiescent("logical-1", "physical-active")).rejects.toThrow(
        WorkerTeardownPendingError,
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("assertOwnershipQuiescent throws WorkerTeardownPendingError when fence is unreadable", async () => {
    const dir = await mkdtemp(join(tmpdir(), "rt-mgr-fence-"));
    const fenceDir = join(dir, "fences");
    await mkdir(fenceDir, { recursive: true });
    try {
      const entry = join(dir, "fake-worker.mjs");
      await withFakeWorker(entry);
      const manager = new RuntimeWorkerManager({ entryPath: entry, fenceDir });
      await writeFile(join(fenceDir, "physical-corrupt.json"), "invalid json content");

      await expect(manager.assertOwnershipQuiescent("logical-1", "physical-corrupt")).rejects.toThrow(
        WorkerTeardownPendingError,
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("assertOwnershipQuiescent retires discharged fence and resolves", async () => {
    const dir = await mkdtemp(join(tmpdir(), "rt-mgr-fence-"));
    const fenceDir = join(dir, "fences");
    await mkdir(fenceDir, { recursive: true });
    try {
      const entry = join(dir, "fake-worker.mjs");
      await withFakeWorker(entry);
      const manager = new RuntimeWorkerManager({ entryPath: entry, fenceDir });
      const fence = new RuntimeWorkerFence(fenceDir);
      await fence.write({
        kind: "runtime-worker-owner",
        logicalSessionId: "physical-discharged",
        generation: "gen-1",
        pid: 12345,
        creationDate: null,
        bootstrapVerified: true,
        phase: "discharged",
        startedAt: new Date().toISOString(),
        agent: "runtime-worker",
      });

      await expect(manager.assertOwnershipQuiescent("logical-1", "physical-discharged")).resolves.toBeUndefined();
      expect(await fence.read("physical-discharged")).toEqual({ kind: "absent" });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("physicalFenceKeyFor returns mapping when acquired and undefined after release", async () => {
    const dir = await mkdtemp(join(tmpdir(), "rt-mgr-fence-"));
    const fenceDir = join(dir, "fences");
    await mkdir(fenceDir, { recursive: true });
    try {
      const entry = join(dir, "fake-worker.mjs");
      await withFakeWorker(entry);
      const manager = new RuntimeWorkerManager({ entryPath: entry, fenceDir });
      expect(manager.physicalFenceKeyFor("logical-1")).toBeUndefined();
      const worker = await manager.acquire("logical-1", "phys-key-1");
      expect(manager.physicalFenceKeyFor("logical-1")).toBe("phys-key-1");
      await worker.shutdown();
      await manager.release("logical-1", worker);
      expect(manager.physicalFenceKeyFor("logical-1")).toBeUndefined();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("RuntimeEngine G4 physical fence delete quiescence", () => {
  test("fresh Host + physical admitted fence + no logical worker => delete rejects and record untouched", async () => {
    const dir = await mkdtemp(join(tmpdir(), "rt-g4-fence-fresh-"));
    const sessionsDir = join(dir, ".acpx", "sessions");
    const fenceDir = join(dir, ".acpx", "worker-fences");
    await mkdir(sessionsDir, { recursive: true });
    await mkdir(fenceDir, { recursive: true });

    const sessionInput: EngineSessionInput = {
      agent: "codex",
      cwd: "/repo",
      name: "fresh-host-session",
      logicalSessionId: "logical-fresh-1",
    };

    try {
      const entry = join(dir, "fake-worker.mjs");
      await withFakeWorker(entry);

      const recordFile = join(sessionsDir, "019cf-real-rec.json");
      await writeFile(
        recordFile,
        JSON.stringify({
          schema: "acpx.session.v1",
          acpx_record_id: "019cf-real-rec",
          name: sessionInput.name,
          cwd: sessionInput.cwd,
          agent_command: sessionInput.agent,
        }),
      );

      const physicalKey = computePhysicalFenceKey(sessionInput);
      const fence = new RuntimeWorkerFence(fenceDir);
      await fence.write({
        kind: "runtime-worker-owner",
        logicalSessionId: physicalKey,
        generation: "dead-host-gen",
        pid: 99999,
        creationDate: null,
        bootstrapVerified: true,
        phase: "admitted",
        startedAt: new Date().toISOString(),
        agent: "runtime-worker",
      });

      // Fresh Host instance with no in-memory worker
      const engine = new RuntimeEngine({
        workerEntryPath: entry,
        stateDir: sessionsDir,
        fenceDir,
        workerQuiescenceTimeoutMs: 100,
        permissionMode: "approve-all",
      });

      // Delete MUST reject because physical fence is undischarged
      await expect(engine.deleteSession(sessionInput)).rejects.toMatchObject({
        code: "RUNTIME_WORKER_TEARDOWN_PENDING",
      });

      // Record on disk MUST remain untouched
      const content = await readFile(recordFile, "utf-8");
      expect(JSON.parse(content).acpx_record_id).toBe("019cf-real-rec");

      await engine.shutdown();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("unreadable fence => fail-closed", async () => {
    const dir = await mkdtemp(join(tmpdir(), "rt-g4-fence-unreadable-"));
    const sessionsDir = join(dir, ".acpx", "sessions");
    const fenceDir = join(dir, ".acpx", "worker-fences");
    await mkdir(sessionsDir, { recursive: true });
    await mkdir(fenceDir, { recursive: true });

    const sessionInput: EngineSessionInput = {
      agent: "codex",
      cwd: "/repo",
      name: "corrupt-fence-session",
      logicalSessionId: "logical-corrupt-1",
    };

    try {
      const entry = join(dir, "fake-worker.mjs");
      await withFakeWorker(entry);

      const recordFile = join(sessionsDir, "corrupt-fence-rec.json");
      await writeFile(
        recordFile,
        JSON.stringify({
          schema: "acpx.session.v1",
          acpx_record_id: "corrupt-fence-rec",
          name: sessionInput.name,
          cwd: sessionInput.cwd,
          agent_command: sessionInput.agent,
        }),
      );

      const physicalKey = computePhysicalFenceKey(sessionInput);
      const corruptFenceFile = join(fenceDir, `${encodeURIComponent(physicalKey)}.json`);
      await writeFile(corruptFenceFile, "corrupted { json !!");

      const engine = new RuntimeEngine({
        workerEntryPath: entry,
        stateDir: sessionsDir,
        fenceDir,
        workerQuiescenceTimeoutMs: 100,
        permissionMode: "approve-all",
      });

      await expect(engine.deleteSession(sessionInput)).rejects.toMatchObject({
        code: "RUNTIME_WORKER_TEARDOWN_PENDING",
      });
      // Record MUST be untouched
      const content = await readFile(recordFile, "utf-8");
      expect(JSON.parse(content).acpx_record_id).toBe("corrupt-fence-rec");
      await engine.shutdown();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("discharged => retire + success", async () => {
    const dir = await mkdtemp(join(tmpdir(), "rt-g4-fence-discharged-"));
    const sessionsDir = join(dir, ".acpx", "sessions");
    const fenceDir = join(dir, ".acpx", "worker-fences");
    await mkdir(sessionsDir, { recursive: true });
    await mkdir(fenceDir, { recursive: true });

    const sessionInput: EngineSessionInput = {
      agent: "codex",
      cwd: "/repo",
      name: "discharged-session",
      logicalSessionId: "logical-discharged-1",
    };

    try {
      const entry = join(dir, "fake-worker.mjs");
      await withFakeWorker(entry);

      const recordFile = join(sessionsDir, "discharged-rec.json");
      await writeFile(
        recordFile,
        JSON.stringify({
          schema: "acpx.session.v1",
          acpx_record_id: "discharged-rec",
          name: sessionInput.name,
          cwd: sessionInput.cwd,
          agent_command: sessionInput.agent,
        }),
      );

      const physicalKey = computePhysicalFenceKey(sessionInput);
      const fence = new RuntimeWorkerFence(fenceDir);
      await fence.write({
        kind: "runtime-worker-owner",
        logicalSessionId: physicalKey,
        generation: "old-discharged-gen",
        pid: 88888,
        creationDate: null,
        bootstrapVerified: true,
        phase: "discharged",
        startedAt: new Date().toISOString(),
        agent: "runtime-worker",
      });

      const engine = new RuntimeEngine({
        workerEntryPath: entry,
        stateDir: sessionsDir,
        fenceDir,
        workerQuiescenceTimeoutMs: 100,
        permissionMode: "approve-all",
      });

      // Discharged fence is retired and deleteSession succeeds
      await expect(engine.deleteSession(sessionInput)).resolves.toEqual({});

      // Record file is deleted
      await expect(access(recordFile)).rejects.toThrow();

      // Fence file is retired (absent)
      expect(await fence.read(physicalKey)).toEqual({ kind: "absent" });

      await engine.shutdown();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("logical!=physical quiescence uses physical key", async () => {
    const dir = await mkdtemp(join(tmpdir(), "rt-g4-fence-diffkey-"));
    const sessionsDir = join(dir, ".acpx", "sessions");
    const fenceDir = join(dir, ".acpx", "worker-fences");
    await mkdir(sessionsDir, { recursive: true });
    await mkdir(fenceDir, { recursive: true });

    const sessionInput: EngineSessionInput = {
      agent: "codex",
      cwd: "/repo",
      name: "named-session-123",
      logicalSessionId: "uuid-arbitrary-logical-id-999",
    };

    try {
      const entry = join(dir, "fake-worker.mjs");
      await withFakeWorker(entry);

      const recordFile = join(sessionsDir, "named-rec.json");
      await writeFile(
        recordFile,
        JSON.stringify({
          schema: "acpx.session.v1",
          acpx_record_id: "named-rec",
          name: sessionInput.name,
          cwd: sessionInput.cwd,
          agent_command: sessionInput.agent,
        }),
      );

      const physicalKey = computePhysicalFenceKey(sessionInput);
      expect(physicalKey).not.toBe(sessionInput.logicalSessionId);

      const fence = new RuntimeWorkerFence(fenceDir);
      // Write admitted fence under PHYSICAL key
      await fence.write({
        kind: "runtime-worker-owner",
        logicalSessionId: physicalKey,
        generation: "gen-diff",
        pid: 77777,
        creationDate: null,
        bootstrapVerified: true,
        phase: "admitted",
        startedAt: new Date().toISOString(),
        agent: "runtime-worker",
      });

      const engine = new RuntimeEngine({
        workerEntryPath: entry,
        stateDir: sessionsDir,
        fenceDir,
        workerQuiescenceTimeoutMs: 100,
        permissionMode: "approve-all",
      });

      // Delete checks physical key -> rejects because physical fence is admitted
      await expect(engine.deleteSession(sessionInput)).rejects.toMatchObject({
        code: "RUNTIME_WORKER_TEARDOWN_PENDING",
      });
      // Record is untouched
      const content = await readFile(recordFile, "utf-8");
      expect(JSON.parse(content).acpx_record_id).toBe("named-rec");
      await engine.shutdown();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("two aliases same physical => sibling blocks delete", async () => {
    const dir = await mkdtemp(join(tmpdir(), "rt-g4-fence-aliases-"));
    const sessionsDir = join(dir, ".acpx", "sessions");
    const fenceDir = join(dir, ".acpx", "worker-fences");
    await mkdir(sessionsDir, { recursive: true });
    await mkdir(fenceDir, { recursive: true });

    const sibling1: EngineSessionInput = {
      agent: "codex",
      cwd: "/repo",
      name: "shared-physical-session",
      logicalSessionId: "alias-worker-1",
    };

    const sibling2: EngineSessionInput = {
      agent: "codex",
      cwd: "/repo",
      name: "shared-physical-session",
      logicalSessionId: "alias-worker-2",
    };

    try {
      const entry = join(dir, "fake-worker.mjs");
      await withFakeWorker(entry);

      const recordFile = join(sessionsDir, "shared-physical-rec.json");
      await writeFile(
        recordFile,
        JSON.stringify({
          schema: "acpx.session.v1",
          acpx_record_id: "shared-physical-rec",
          name: sibling1.name,
          cwd: sibling1.cwd,
          agent_command: sibling1.agent,
        }),
      );

      const engine = new RuntimeEngine({
        workerEntryPath: entry,
        stateDir: sessionsDir,
        fenceDir,
        workerQuiescenceTimeoutMs: 100,
        permissionMode: "approve-all",
      });

      // Sibling 1 ensures/prompts -> spawns worker, creates admitted physical fence
      const promptResult = await engine.prompt({ ...sibling1, text: "hello" });
      expect(promptResult.text).toBe("ok");

      // Physical fence is now on disk for the shared physical identity
      const physicalKey = computePhysicalFenceKey(sibling1);
      const fence = new RuntimeWorkerFence(fenceDir);
      const fenceRead = await fence.read(physicalKey);
      expect(fenceRead.kind).toBe("present");
      if (fenceRead.kind === "present") {
        expect(fenceRead.record.phase).toMatch(/owned|admitted/);
      }
      // Now Sibling 2 (which has no in-memory worker for "alias-worker-2") attempts to deleteSession
      await expect(engine.deleteSession(sibling2)).rejects.toMatchObject({
        code: "RUNTIME_WORKER_TEARDOWN_PENDING",
      });

      // Shared record file is STILL present on disk
      const content = await readFile(recordFile, "utf-8");
      expect(JSON.parse(content).acpx_record_id).toBe("shared-physical-rec");
      await engine.shutdown();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("releaseLogicalSession drops alias state but keeps the shared physical record", async () => {
      const dir = await mkdtemp(join(tmpdir(), "rt-g4-release-alias-"));
      const sessionsDir = join(dir, ".acpx", "sessions");
      const fenceDir = join(dir, ".acpx", "worker-fences");
      const queueDir = join(dir, ".acpx", "runtime-queue");
      await mkdir(sessionsDir, { recursive: true });
      await mkdir(fenceDir, { recursive: true });
      await mkdir(queueDir, { recursive: true });

      const sibling1: EngineSessionInput = {
        agent: "codex",
        cwd: "/repo",
        name: "shared-physical-session",
        logicalSessionId: "alias-worker-1",
      };
      const sibling2: EngineSessionInput = {
        agent: "codex",
        cwd: "/repo",
        name: "shared-physical-session",
        logicalSessionId: "alias-worker-2",
      };

      try {
        const entry = join(dir, "fake-worker.mjs");
        await withFakeWorker(entry);

        const recordFile = join(sessionsDir, "real-acpx-rec-1234.json");
        await writeFile(
          recordFile,
          JSON.stringify({
            schema: "acpx.session.v1",
            acpx_record_id: "real-acpx-rec-1234",
            name: sibling1.name,
            cwd: sibling1.cwd,
            agent_command: sibling1.agent,
          }),
        );

        const engine = new RuntimeEngine({
          workerEntryPath: entry,
          stateDir: sessionsDir,
          fenceDir,
          queueDir,
          workerQuiescenceTimeoutMs: 100,
          permissionMode: "approve-all",
          // TTL fully disabled: the chain must succeed without any idle reap.
          idleTtlMs: 0,
        });
        const manager: any = (engine as any).manager;
        const store = (engine as any).getQueueStore();

        // Warm A and seed A's own queue journal directly (store layer only —
        // no drain kick, so the journal is deterministically present).
        const promptResult = await engine.prompt({ ...sibling1, text: "hello" });
        expect(promptResult.text).toBe("ok");
        const oldPid: number = manager.get("alias-worker-1").ref.pid;
        await store.enqueue("alias-worker-1", {
          messageId: "m-a1",
          text: "queued-a",
          mode: "queue",
        });
        expect(await store.hasPending("alias-worker-1")).toBe(true);

        // Release A's logical alias: worker/mapping/journal gone, shared
        // physical record and history untouched, fence retired.
        await engine.releaseLogicalSession(sibling1);
        expect(manager.get("alias-worker-1")).toBeUndefined();
        expect(manager.physicalFenceKeyFor("alias-worker-1")).toBeUndefined();
        expect(await store.hasPending("alias-worker-1")).toBe(false);
        try {
          process.kill(oldPid, 0);
          expect.unreachable("old worker process must be dead after release");
        } catch {
          // ESRCH: dead as required.
        }
        expect(
          JSON.parse(await readFile(recordFile, "utf-8")).acpx_record_id,
        ).toBe("real-acpx-rec-1234");
        const physicalKey = computePhysicalFenceKey(sibling1);
        const fence = new RuntimeWorkerFence(fenceDir);
        expect((await fence.read(physicalKey)).kind).toBe("absent");

        // B remains fully usable on the same physical record.
        const promptB = await engine.prompt({ ...sibling2, text: "hello" });
        expect(promptB.text).toBe("ok");
        const newPid: number = manager.get("alias-worker-2").ref.pid;
        expect(newPid).not.toBe(oldPid);

        // Last-alias hard delete removes everything: record, fence, workers.
        await engine.deleteSession(sibling2);
        expect(manager.workers().length).toBe(0);
        await expect(access(recordFile)).rejects.toThrow();
        expect((await fence.read(physicalKey)).kind).toBe("absent");
        await engine.shutdown();
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

  test("releaseLogicalSession succeeds while a sibling still owns the shared fence", async () => {
    const dir = await mkdtemp(join(tmpdir(), "rt-g4-release-sibling-"));
    const sessionsDir = join(dir, ".acpx", "sessions");
    const fenceDir = join(dir, ".acpx", "worker-fences");
    const queueDir = join(dir, ".acpx", "runtime-queue");
    await mkdir(sessionsDir, { recursive: true });
    await mkdir(fenceDir, { recursive: true });
    await mkdir(queueDir, { recursive: true });

    const sibling1: EngineSessionInput = {
      agent: "codex",
      cwd: "/repo",
      name: "shared-physical-session",
      logicalSessionId: "alias-worker-1",
    };
    const sibling2: EngineSessionInput = {
      agent: "codex",
      cwd: "/repo",
      name: "shared-physical-session",
      logicalSessionId: "alias-worker-2",
    };

    try {
      const entry = join(dir, "fake-worker.mjs");
      await withFakeWorker(entry);

      const recordFile = join(sessionsDir, "real-acpx-rec-1234.json");
      await writeFile(
        recordFile,
        JSON.stringify({
          schema: "acpx.session.v1",
          acpx_record_id: "real-acpx-rec-1234",
          name: sibling1.name,
          cwd: sibling1.cwd,
          agent_command: sibling1.agent,
        }),
      );

      const engine = new RuntimeEngine({
        workerEntryPath: entry,
        stateDir: sessionsDir,
        fenceDir,
        queueDir,
        workerQuiescenceTimeoutMs: 100,
        permissionMode: "approve-all",
        idleTtlMs: 0,
      });
      const manager: any = (engine as any).manager;
      const store = (engine as any).getQueueStore();
      const fence = new RuntimeWorkerFence(fenceDir);
      const physicalKey = computePhysicalFenceKey(sibling1);

      // Warm the SIBLING first: it legitimately owns the shared fence.
      const promptB = await engine.prompt({ ...sibling2, text: "hello" });
      expect(promptB.text).toBe("ok");
      const siblingPid: number = manager.get("alias-worker-2").ref.pid;

      // Cold A carries a durable journal. Releasing A must succeed WITHOUT
      // requiring the sibling's fence to disappear — and must not delete
      // queued work before the release is verified (journal assertions run
      // after the verified release, not before).
      await store.enqueue("alias-worker-1", { messageId: "m-a1", text: "queued-a", mode: "queue" });
      expect(await store.hasPending("alias-worker-1")).toBe(true);
      await engine.releaseLogicalSession(sibling1);
      expect(manager.get("alias-worker-1")).toBeUndefined();
      expect(manager.physicalFenceKeyFor("alias-worker-1")).toBeUndefined();
      expect(await store.hasPending("alias-worker-1")).toBe(false);
      // Sibling untouched: still alive, still owns the admitted fence, and
      // the shared physical record is intact.
      expect(manager.get("alias-worker-2")?.ref.pid).toBe(siblingPid);
      const fenceRead = await fence.read(physicalKey);
      expect(fenceRead.kind).toBe("present");
      if (fenceRead.kind === "present") {
        expect(fenceRead.record.phase).toMatch(/owned|admitted/);
      }
      expect(JSON.parse(await readFile(recordFile, "utf-8")).acpx_record_id).toBe("real-acpx-rec-1234");
      await engine.shutdown();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
