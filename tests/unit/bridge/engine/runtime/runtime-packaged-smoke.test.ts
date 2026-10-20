import { expect, test } from "bun:test";
import { statSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join, resolve, resolve as resolvePath } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";

import {
  RuntimeEngine,
  defaultWorkerEntryCandidates,
} from "../../../../../src/bridge/engine/runtime-engine";
import { physicalFenceKeyForSession } from "../../../../../src/bridge/engine/runtime/physical-session-identity";
import { buildTestRuntimeWorker } from "../../../../helpers/build-test-runtime-worker";

const MOCK_AGENT = resolve(import.meta.dir, "../../../../fixtures/mock-acp-agent.mjs");

test("defaultWorkerEntryCandidates calculates bundled candidate #1 relative to bridge-main URL", () => {
  // Pure unit test: zero disk dependency. Verifies candidate #1 calculation from
  // the bundled dist/bridge/bridge-main.js context.
  const bridgeUrl = pathToFileURL(resolvePath("/opt/xacpx/dist/bridge/bridge-main.js")).href;
  const candidates = defaultWorkerEntryCandidates(bridgeUrl);
  expect(candidates[0]).toBe(resolvePath("/opt/xacpx/dist/bridge/engine/runtime/runtime-worker-main.js"));

  // Also verifies source module resolution (candidate #3)
  const sourceUrl = pathToFileURL(resolvePath("/opt/xacpx/src/bridge/engine/runtime-engine.ts")).href;
  const sourceCandidates = defaultWorkerEntryCandidates(sourceUrl);
  expect(sourceCandidates[2]).toBe(resolvePath("/opt/xacpx/dist/bridge/engine/runtime/runtime-worker-main.js"));
});

test("packaged build smoke: RuntimeEngine compiles and runs worker entry on-demand", async () => {
  const dir = await mkdtemp(join(tmpdir(), "rt-smoke-pkg-"));
  const worker = await buildTestRuntimeWorker();
  const sessionsDir = join(dir, ".acpx", "sessions");
  const engine = new RuntimeEngine({
    workerEntryPath: worker.entryPath,
    stateDir: sessionsDir,
    permissionMode: "approve-all",
    nonInteractivePermissions: "deny",
    durableRootDir: join(dir, "durable"),
  });
  try {
    expect(statSync(worker.entryPath).isFile()).toBe(true);

    const sessionInput = {
      agent: "mock",
      cwd: dir,
      name: "smoke-pkg-session",
      logicalSessionId: "smoke-logical-pkg-1",
      agentArgv: [process.execPath, MOCK_AGENT],
    };

    // 1. Ensure + prompt using the freshly compiled worker bundle
    const reply = await engine.prompt({ ...sessionInput, text: "smoke-ping" });
    expect(reply.text).toBeTypeOf("string");
    expect(reply.text.length).toBeGreaterThan(0);

    // 2. Verified warm
    expect((await engine.isSessionWarm(sessionInput)).warm).toBe(true);

    // 3. Clean shutdown
    await engine.shutdown();
    expect((await engine.isSessionWarm(sessionInput)).warm).toBe(false);
  } finally {
    await engine.shutdown().catch(() => {});
    await rm(dir, { recursive: true, force: true });
    await worker.release();
  }
}, 60_000);

test("WorkerTeardownPendingError surfaces exact error code through withWorker", async () => {
  const dir = await mkdtemp(join(tmpdir(), "rt-teardown-code-"));
  try {
    const entry = join(dir, "worker.mjs");
    await writeFile(
      entry,
      [
        "import { createInterface } from 'node:readline';",
        "createInterface({ input: process.stdin }).on('line', (line) => { const msg = JSON.parse(line); process.stdout.write(JSON.stringify({ id: msg.id, ok: true, result: {} }) + '\\n'); });",
      ].join("\n"),
    );
    const engine = new RuntimeEngine({
      workerClientDeps: {
        platform: "win32",
        windowsJobContainment: false,
        probeWindowsIdentity: async (pid) => ({ status: "found", identity: { pid, creationDate: "133500000000000000" } }),
        terminateProcessTree: async (target) => {
          try { process.kill(typeof target === "number" ? target : target.pid, "SIGKILL"); } catch {}
          return { rootOutcome: "killed", outcomes: [] };
        },
      },
      workerEntryPath: entry,
      permissionMode: "approve-all",
      durableRootDir: join(dir, "durable"),
    });

    const sessionInput = {
      agent: "codex",
      cwd: "/repo",
      name: "teardown-code-session",
      logicalSessionId: "teardown-code-1",
    };

    // Ensure worker
    const worker = await engine["manager"]!.acquire(sessionInput.logicalSessionId, physicalFenceKeyForSession(sessionInput));
    await worker.request("ensure", {});
    expect(worker).toBeDefined();

    // Put into cooling state while still alive
    worker.lifecycle = "cooling";

    // Calling ensureSession now must fail closed with RUNTIME_WORKER_TEARDOWN_PENDING
    await expect(engine.ensureSession(sessionInput)).rejects.toMatchObject({
      code: "RUNTIME_WORKER_TEARDOWN_PENDING",
    });

    await worker.terminate();
    await engine.shutdown();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}, 30_000);
