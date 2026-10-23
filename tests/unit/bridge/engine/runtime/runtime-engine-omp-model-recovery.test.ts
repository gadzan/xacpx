import { expect, test, spyOn } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { RuntimeEngine } from "../../../../../src/bridge/engine/runtime-engine";
import { physicalFenceKeyForSession } from "../../../../../src/bridge/engine/runtime/physical-session-identity";
import * as launcher from "../../../../../src/transport/acpx-queue-owner-launcher";
import type { RuntimeWorkerClientDeps } from "../../../../../src/bridge/engine/runtime/runtime-worker-client";

const fakeWorkerClientDeps: RuntimeWorkerClientDeps = {
  platform: "win32",
  probeWindowsIdentity: async (pid) => ({ status: "found", identity: { pid, creationDate: "133500000000000000" } }),
  terminateProcessTree: async (target) => {
    try { process.kill(typeof target === "number" ? target : target.pid, "SIGKILL"); } catch {}
    return { rootOutcome: "killed", outcomes: [] };
  },
};

const ompInput = {
  agent: "omp",
  driver: "omp",
  cwd: "/repo",
  name: "omp-demo",
  logicalSessionId: "logical-omp-1",
  agentArgv: ["omp", "acp"],
};

const RESTORE_ERROR_MESSAGE = "agent error: Could not restore model anthropic/claude-opus-4-8: not allowed";

/** Fake worker whose ensure/setConfigOption can be made to fail with the exact
 * omp restore error, exercising the narrow recovery gate end to end. */
async function withOmpWorker(entry: string, options: { failSetConfigOption?: boolean } = {}): Promise<void> {
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
      "        process.stdout.write(JSON.stringify({ id: msg.id, ok: true, result: { ready: true, sessionKey: msg.params.sessionKey, acpxRecordId: 'rec-omp-1', agentSessionId: 'native-full-id-1' } }) + '\\n');",
      "      } else if (msg.method === 'setConfigOption') {",
      `        ${options.failSetConfigOption ? `process.stdout.write(JSON.stringify({ id: msg.id, ok: false, error: { code: 'RUNTIME_TURN_FAILED', message: ${JSON.stringify(RESTORE_ERROR_MESSAGE)} } }) + '\\n');` : "process.stdout.write(JSON.stringify({ id: msg.id, ok: true, result: {} }) + '\\n');"}`,
      "      } else if (msg.method === 'status') {",
      "        process.stdout.write(JSON.stringify({ id: msg.id, ok: true, result: { acpxRecordId: 'rec-omp-1', agentSessionId: 'native-full-id-1' } }) + '\\n');",
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

async function seedOmpRecord(sessionsDir: string): Promise<void> {
  const recordId = "rec-omp-1";
  await writeFile(
    join(sessionsDir, `${encodeURIComponent(recordId)}.json`),
    JSON.stringify({
      schema: "acpx.session.v1",
      acpx_record_id: recordId,
      acp_session_id: "native-full-id-1",
      agent_session_id: "native-full-id-1",
      agent_command: "omp acp",
      cwd: ompInput.cwd,
      name: ompInput.name,
      created_at: new Date().toISOString(),
      last_used_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      last_seq: 0,
      messages: [],
    }),
    "utf8",
  );
}

async function makeEngine(dir: string, entry: string, options: { failSetConfigOption?: boolean } = {}): Promise<RuntimeEngine> {
  const sessionsDir = join(dir, "state", "sessions");
  await mkdir(sessionsDir, { recursive: true });
  await seedOmpRecord(sessionsDir);
  await withOmpWorker(entry, options);
  return new RuntimeEngine({
    workerClientDeps: fakeWorkerClientDeps,
    workerEntryPath: entry,
    permissionMode: "approve-all",
    stateDir: sessionsDir,
    queueDir: join(dir, "queue"),
    fenceDir: join(dir, "fences"),
  });
}

test("setModel without omp recovery gate surfaces the original worker error unchanged", async () => {
  const dir = await mkdtemp(join(tmpdir(), "omp-rec-"));
  let engine: RuntimeEngine | undefined;
  try {
    const entry = join(dir, "fake-worker.mjs");
    engine = await makeEngine(dir, entry, { failSetConfigOption: true });
    // agent "omp" resolves the launch gate, but the failure marker inside the
    // worker is the exact restore error -> recovery path runs and reports the
    // native relaunch failure (no real omp binary in the test environment).
    await expect(engine.setModel({ ...ompInput, modelId: "anthropic/claude-opus-4-9" })).rejects.toMatchObject({
      code: "RUNTIME_INIT_FAILED",
    });
    // Non-omp agent: launch gate fails -> original error surfaces untouched.
    await expect(
      engine.setModel({ ...ompInput, agent: "codex", driver: undefined, agentArgv: undefined, modelId: "gpt-5.2" }),
    ).rejects.toMatchObject({ code: "RUNTIME_TURN_FAILED", message: RESTORE_ERROR_MESSAGE });
  } finally {
    await engine?.shutdown().catch(() => {});
    await rm(dir, { recursive: true, force: true });
  }
}, 20_000);

test("omp restore recovery stops worker, retains fence, suspends queue, and leaves no auto drain", async () => {
  const dir = await mkdtemp(join(tmpdir(), "omp-rec-"));
  let engine: RuntimeEngine | undefined;
  const absentCalls: string[] = [];
  const absentSpy = spyOn(launcher, "assertAcpxQueueOwnerAbsent").mockImplementation(async (sessionId: string) => {
    absentCalls.push(sessionId);
  });
  try {
    const entry = join(dir, "fake-worker.mjs");
    engine = await makeEngine(dir, entry, { failSetConfigOption: true });
    const physicalKey = physicalFenceKeyForSession(ompInput);
    // No omp binary on PATH: the native helper fails, which still exercises the
    // full pre-helper lifecycle (suspend -> stop -> fence retained -> absence).
    await expect(engine.setModel({ ...ompInput, modelId: "anthropic/claude-opus-4-9" })).rejects.toMatchObject({
      code: "RUNTIME_INIT_FAILED",
    });
    expect(absentCalls).toEqual(["rec-omp-1"]);
    const fencePath = join(dir, "fences", `${encodeURIComponent(physicalKey)}.json`);
    const fenceRecord = JSON.parse(await readFile(fencePath, "utf8")) as { phase: string };
    expect(fenceRecord.phase).toBe("admitted");
    const engineAny = engine as unknown as { queueSuspended: Set<string> };
    expect(engineAny.queueSuspended.has(ompInput.logicalSessionId)).toBe(true);
  } finally {
    absentSpy.mockRestore();
    await engine?.shutdown().catch(() => {});
    await rm(dir, { recursive: true, force: true });
  }
}, 20_000);

test("recovery refuses while an active turn holds the session", async () => {
  const dir = await mkdtemp(join(tmpdir(), "omp-rec-"));
  let engine: RuntimeEngine | undefined;
  try {
    const entry = join(dir, "fake-worker.mjs");
    engine = await makeEngine(dir, entry);
    const engineAny = engine as unknown as {
      activeTurns: Map<string, number>;
      recoverNativeModelRestore: (input: typeof ompInput & { modelId: string }, cause: unknown, env?: Record<string, string>) => Promise<void>;
    };
    engineAny.activeTurns.set(ompInput.logicalSessionId, 1);
    await expect(
      engineAny.recoverNativeModelRestore({ ...ompInput, modelId: "m" }, new Error("x")),
    ).rejects.toMatchObject({ code: "RUNTIME_WORKER_TEARDOWN_PENDING" });
    engineAny.activeTurns.delete(ompInput.logicalSessionId);
  } finally {
    await engine?.shutdown().catch(() => {});
    await rm(dir, { recursive: true, force: true });
  }
}, 15_000);
