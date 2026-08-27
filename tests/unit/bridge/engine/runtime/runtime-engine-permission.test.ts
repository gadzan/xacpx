import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { RuntimeEngine } from "../../../../../src/bridge/engine/runtime-engine";
import { EngineRouter } from "../../../../../src/bridge/engine/engine-router";
import { SessionEngineBinding } from "../../../../../src/bridge/engine/session-engine-binding";
import type { BridgeEngine } from "../../../../../src/bridge/engine/bridge-engine";

const sessionInput = {
  agent: "codex",
  cwd: "/repo",
  name: "perm-test-session",
  logicalSessionId: "logical-perm-1",
};

async function createPolicyEchoWorker(entry: string): Promise<void> {
  await writeFile(
    entry,
    [
      "let buffer='';",
      "let policyMode='unknown';",
      "process.stdin.on('data', (d) => {",
      "  buffer += d.toString();",
      "  let idx;",
      "  while ((idx = buffer.indexOf('\\n')) >= 0) {",
      "    const line = buffer.slice(0, idx); buffer = buffer.slice(idx + 1);",
      "    if (!line) continue;",
      "    try { const msg = JSON.parse(line);",
      "      if (msg.method === 'ensure') {",
      "        policyMode = msg.params?.permissionMode ?? 'unknown';",
      "        process.stdout.write(JSON.stringify({ id: msg.id, ok: true, result: { ready: true, sessionKey: msg.params?.sessionKey, acpxRecordId: 'rec-p1' } }) + '\\n');",
      "      } else if (msg.method === 'prompt') {",
      "        process.stdout.write(JSON.stringify({ id: msg.id, event: 'text_delta', payload: { type: 'text_delta', text: `policy=${policyMode}` } }) + '\\n');",
      "        process.stdout.write(JSON.stringify({ id: msg.id, ok: true, result: { result: { status: 'completed' }, finalText: `policy=${policyMode}` } }) + '\\n');",
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

test("Scenario 1: idle warm worker is rotated on permission update and new worker applies new policy", async () => {
  const dir = await mkdtemp(join(tmpdir(), "rt-perm-rot-"));
  try {
    const entry = join(dir, "echo-worker.mjs");
    await createPolicyEchoWorker(entry);
    const engine = new RuntimeEngine({
      workerEntryPath: entry,
      permissionMode: "approve-all",
      nonInteractivePermissions: "deny",
    });

    // 1. First turn: runs with approve-all
    const reply1 = await engine.prompt({ ...sessionInput, text: "t1" });
    expect(reply1.text).toBe("policy=approve-all");
    expect((await engine.isSessionWarm(sessionInput)).warm).toBe(true);
    const oldPid = engine["manager"]?.get("logical-perm-1")?.ref.pid;
    expect(oldPid).toBeDefined();

    // 2. Permission update: rotate warm worker
    await engine.updatePermissionPolicy({
      permissionMode: "deny-all",
      nonInteractivePermissions: "deny",
    });

    // Old worker is stopped, session is not closed
    expect((await engine.isSessionWarm(sessionInput)).warm).toBe(false);

    // 3. Next prompt creates new worker running the NEW deny-all policy
    const reply2 = await engine.prompt({ ...sessionInput, text: "t2" });
    expect(reply2.text).toBe("policy=deny-all");
    const newPid = engine["manager"]?.get("logical-perm-1")?.ref.pid;
    expect(newPid).toBeDefined();
    expect(newPid).not.toBe(oldPid);

    await engine.shutdown();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}, 15_000);

test("Scenario 2: busy worker with in-flight turn causes updatePermissionPolicy to fail closed", async () => {
  const dir = await mkdtemp(join(tmpdir(), "rt-perm-busy-"));
  try {
    const entry = join(dir, "slow-worker.mjs");
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
        "        process.stdout.write(JSON.stringify({ id: msg.id, ok: true, result: { ready: true, sessionKey: msg.params?.sessionKey, acpxRecordId: 'rec-slow' } }) + '\\n');",
        "      } else if (msg.method === 'prompt') {",
        "        setTimeout(() => {",
        "          process.stdout.write(JSON.stringify({ id: msg.id, ok: true, result: { result: { status: 'completed' }, finalText: 'slow-ok' } }) + '\\n');",
        "        }, 100);",
        "      } else {",
        "        process.stdout.write(JSON.stringify({ id: msg.id, ok: true, result: {} }) + '\\n');",
        "      }",
        "      if (msg.method === 'shutdown') process.exit(0);",
        "    } catch {}",
        "  }",
        "});",
      ].join("\n"),
    );
    const engine = new RuntimeEngine({
      workerEntryPath: entry,
      permissionMode: "approve-all",
      nonInteractivePermissions: "deny",
    });

    // Start in-flight prompt
    const promptPromise = engine.prompt({ ...sessionInput, text: "slow" });

    // Attempt policy update while turn is active
    await expect(
      engine.updatePermissionPolicy({
        permissionMode: "deny-all",
        nonInteractivePermissions: "deny",
      }),
    ).rejects.toMatchObject({ code: "RUNTIME_PERMISSION_BUSY" });

    // Active prompt completes undisturbed
    const promptResult = await promptPromise;
    expect(promptResult.text).toBe("slow-ok");

    await engine.shutdown();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}, 15_000);

test("Scenario 3: CLI update failure causes router to rollback RuntimeEngine without committing", async () => {
  const dir = await mkdtemp(join(tmpdir(), "rt-perm-rollback-"));
  try {
    const entry = join(dir, "echo-worker.mjs");
    await createPolicyEchoWorker(entry);
    const runtime = new RuntimeEngine({
      workerEntryPath: entry,
      permissionMode: "approve-all",
      nonInteractivePermissions: "deny",
    });

    // Stub CLI engine that throws on update
    const failingCli: BridgeEngine = {
      kind: "cli",
      async hasSession() { return { exists: false }; },
      async tailSessionHistory() { return { text: "" }; },
      async listAgentSessions() { return undefined; },
      async ensureSession() { return {}; },
      async resumeAgentSession() { return {}; },
      async prompt() { return { text: "" }; },
      async injectMessage() { throw new Error(); },
      async setMode() { return {}; },
      async setModel() { return {}; },
      async getSessionModel() { return { available: [] }; },
      async setSessionEffort() { return {}; },
      async getSessionEffort() { return { available: [] }; },
      async cancel() { return { cancelled: true, message: "" }; },
      async removeSession() { return {}; },
      async deleteSession() { return {}; },
      async freeWarmProcess() { return {}; },
      async isSessionWarm() { return { warm: false }; },
      async getAgentSessionId() { return { agentSessionId: undefined }; },
      async updatePermissionPolicy() {
        throw new Error("CLI permission update disk error (simulated)");
      },
      async shutdown() { return {}; },
    };

    const router = new EngineRouter(new SessionEngineBinding(), failingCli, runtime);

    // Call update through router: CLI will throw
    await expect(
      router.updatePermissionPolicy({
        permissionMode: "deny-all",
        nonInteractivePermissions: "deny",
      }),
    ).rejects.toThrow(/CLI permission update disk error/);

    // RuntimeEngine must NOT have committed deny-all: next prompt uses OLD approve-all
    const reply = await runtime.prompt({ ...sessionInput, text: "after-rollback" });
    expect(reply.text).toBe("policy=approve-all");

    await runtime.shutdown();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}, 15_000);

test("Scenario 4: concurrent prompt waits for active policy transition to complete", async () => {
  const dir = await mkdtemp(join(tmpdir(), "rt-perm-conc-"));
  try {
    const entry = join(dir, "echo-worker.mjs");
    await createPolicyEchoWorker(entry);
    const engine = new RuntimeEngine({
      workerEntryPath: entry,
      permissionMode: "approve-all",
      nonInteractivePermissions: "deny",
    });

    // Prepare transition (acquires lock, holds it)
    await engine.preparePolicyTransition();

    let promptStarted = false;
    let promptFinished = false;

    // Concurrently trigger prompt: should wait on lock
    const promptPromise = (async () => {
      promptStarted = true;
      const res = await engine.prompt({ ...sessionInput, text: "concurrent" });
      promptFinished = true;
      return res;
    })();

    // Prompt was initiated, but cannot finish until commit
    expect(promptStarted).toBe(true);
    expect(promptFinished).toBe(false);

    // Commit transition with deny-all
    await engine.commitPolicyTransition({
      permissionMode: "deny-all",
      nonInteractivePermissions: "deny",
    });

    // Prompt now completes with the newly committed deny-all policy
    const result = await promptPromise;
    expect(promptFinished).toBe(true);
    expect(result.text).toBe("policy=deny-all");

    await engine.shutdown();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}, 15_000);
