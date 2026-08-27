import { expect, test } from "bun:test";
import { statSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

import {
  RuntimeEngine,
  defaultWorkerEntry,
  defaultWorkerEntryCandidates,
} from "../../../../../src/bridge/engine/runtime-engine";

const MOCK_AGENT = resolve(import.meta.dir, "../../../../fixtures/mock-acp-agent.mjs");

test("packaged build smoke: defaultWorkerEntry resolves the built dist entry without overrides", async () => {
  const resolved = defaultWorkerEntry();
  expect(typeof resolved).toBe("string");
  // Proves the resolved entry is a real, existing compiled JS file
  expect(statSync(resolved).isFile()).toBe(true);
  expect(resolved).toContain("runtime-worker-main.js");

  const candidates = defaultWorkerEntryCandidates();
  expect(candidates.length).toBeGreaterThan(0);
});

test("packaged build smoke: RuntimeEngine runs end-to-end using real dist worker entry", async () => {
  const dir = await mkdtemp(join(tmpdir(), "rt-smoke-pkg-"));
  const sessionsDir = join(dir, ".acpx", "sessions");
  try {
    // Default constructor: NO workerEntryPath override supplied
    const engine = new RuntimeEngine({
      stateDir: sessionsDir,
      permissionMode: "approve-all",
      nonInteractivePermissions: "deny",
    });

    const sessionInput = {
      agent: "mock",
      cwd: dir,
      name: "smoke-pkg-session",
      logicalSessionId: "smoke-logical-pkg-1",
      agentArgv: [process.execPath, MOCK_AGENT],
    };

    // 1. Ensure + prompt using the real built dist/bridge/engine/runtime/runtime-worker-main.js
    const reply = await engine.prompt({ ...sessionInput, text: "smoke-ping" });
    expect(reply.text).toBeTypeOf("string");
    expect(reply.text.length).toBeGreaterThan(0);

    // 2. Verified warm
    expect((await engine.isSessionWarm(sessionInput)).warm).toBe(true);

    // 3. Clean shutdown
    await engine.shutdown();
    expect((await engine.isSessionWarm(sessionInput)).warm).toBe(false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}, 30_000);
