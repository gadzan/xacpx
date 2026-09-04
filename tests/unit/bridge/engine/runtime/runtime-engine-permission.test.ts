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
      "let policySpec='none';",
      "process.stdin.on('data', (d) => {",
      "  buffer += d.toString();",
      "  let idx;",
      "  while ((idx = buffer.indexOf('\\n')) >= 0) {",
      "    const line = buffer.slice(0, idx); buffer = buffer.slice(idx + 1);",
      "    if (!line) continue;",
      "    try { const msg = JSON.parse(line);",
      "      if (msg.method === 'ensure') {",
      "        policyMode = msg.params?.permissionMode ?? 'unknown';",
      "        policySpec = msg.params?.permissionPolicy ?? 'none';",
      "        process.stdout.write(JSON.stringify({ id: msg.id, ok: true, result: { ready: true, sessionKey: msg.params?.sessionKey, acpxRecordId: 'rec-p1' } }) + '\\n');",
      "      } else if (msg.method === 'prompt') {",
      "        process.stdout.write(JSON.stringify({ id: msg.id, event: 'text_delta', payload: { type: 'text_delta', text: `mode=${policyMode};policy=${policySpec}` } }) + '\\n');",
      "        process.stdout.write(JSON.stringify({ id: msg.id, ok: true, result: { result: { status: 'completed' }, finalText: `mode=${policyMode};policy=${policySpec}` } }) + '\\n');",
      "      } else if (msg.method === 'permission.update') {",
      "        policyMode = msg.params?.permissionMode ?? policyMode;",
      "        policySpec = msg.params?.permissionPolicy ?? policySpec;",
      "        process.stdout.write(JSON.stringify({ id: msg.id, ok: true, result: { generation: msg.params.generation, accepted: true } }) + '\\n');",
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

test("Scenario 1: idle warm worker is live-updated on permission update without rotation", async () => {
  const dir = await mkdtemp(join(tmpdir(), "rt-perm-rot-"));
  try {
    const entry = join(dir, "echo-worker.mjs");
    await createPolicyEchoWorker(entry);
    const engine = new RuntimeEngine({
      workerEntryPath: entry,
      permissionMode: "approve-all",
      nonInteractivePermissions: "deny",
      permissionPolicy: JSON.stringify({ autoApprove: ["read-files"] }),
    });

    // 1. First turn: runs with approve-all and policy A
    const reply1 = await engine.prompt({ ...sessionInput, text: "t1" });
    expect(reply1.text).toBe(`mode=approve-all;policy=${JSON.stringify({ autoApprove: ["read-files"] })}`);
    expect((await engine.isSessionWarm(sessionInput)).warm).toBe(true);
    const oldPid = engine["manager"]?.get("logical-perm-1")?.ref.pid;
    expect(oldPid).toBeDefined();

    // 2. Permission update: live-update warm worker without rotation (PR7)
    await engine.updatePermissionPolicy({
      permissionMode: "deny-all",
      nonInteractivePermissions: "deny",
      permissionPolicy: JSON.stringify({ autoDeny: ["all-edits"] }),
    });

    // Worker stays warm on same pid after live update
    expect((await engine.isSessionWarm(sessionInput)).warm).toBe(true);

    // 3. Next prompt reuses same worker with NEW deny-all and policy B via live snapshot
    const reply2 = await engine.prompt({ ...sessionInput, text: "t2" });
    expect(reply2.text).toBe(`mode=deny-all;policy=${JSON.stringify({ autoDeny: ["all-edits"] })}`);
    const newPid = engine["manager"]?.get("logical-perm-1")?.ref.pid;
    expect(newPid).toBeDefined();
    expect(newPid).toBe(oldPid);
    await engine.shutdown().catch(() => {});
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

test("Scenario 2b: in-flight setModel RPC (non-prompt business RPC) causes updatePermissionPolicy to fail closed", async () => {
  const dir = await mkdtemp(join(tmpdir(), "rt-perm-rpc-busy-"));
  try {
    const entry = join(dir, "slow-config-worker.mjs");
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
        "        process.stdout.write(JSON.stringify({ id: msg.id, ok: true, result: { ready: true, sessionKey: msg.params?.sessionKey, acpxRecordId: 'rec-slow-cfg' } }) + '\\n');",
        "      } else if (msg.method === 'setConfigOption') {",
        "        setTimeout(() => {",
        "          process.stdout.write(JSON.stringify({ id: msg.id, ok: true, result: {} }) + '\\n');",
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

    // Start in-flight setModel (non-prompt business RPC)
    const setModelPromise = engine.setModel({ ...sessionInput, modelId: "claude-3-5-sonnet" });

    // Attempt policy update while setModel RPC is in-flight: MUST fail closed
    await expect(
      engine.updatePermissionPolicy({
        permissionMode: "deny-all",
        nonInteractivePermissions: "deny",
      }),
    ).rejects.toMatchObject({ code: "RUNTIME_PERMISSION_BUSY" });

    // In-flight setModel completes undisturbed
    await expect(setModelPromise).resolves.toEqual({});

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
    expect(reply.text).toBe("mode=approve-all;policy=none");

    await runtime.shutdown();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}, 15_000);
test("Scenario 3b: CLI failure after a successful Runtime commit aborts back to all-old", async () => {
  const dir = await mkdtemp(join(tmpdir(), "rt-perm-abort-"));
  try {
    const entry = join(dir, "echo-worker.mjs");
    await createPolicyEchoWorker(entry);
    const runtime = new RuntimeEngine({
      workerEntryPath: entry,
      permissionMode: "approve-all",
      nonInteractivePermissions: "deny",
    });
    // One live worker so the commit has a real fan-out witness to fence.
    const before = await runtime.prompt({ ...sessionInput, text: "warm" });
    expect(before.text).toBe("mode=approve-all;policy=none");
    const cliCalls: unknown[] = [];
    const failingCli = {
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
      async updatePermissionPolicy(policy: unknown) {
        cliCalls.push(policy);
        throw new Error("CLI permission update disk error (simulated)");
      },
      async shutdown() { return {}; },
    } as unknown as BridgeEngine;
    const router = new EngineRouter(new SessionEngineBinding(), failingCli, runtime);
    // Runtime commits first, then CLI throws: the abort must fence the
    // updated worker and restore all-old, while the CLI error propagates
    // so the outer layer never publishes the new config.
    await expect(
      router.updatePermissionPolicy({
        permissionMode: "deny-all",
        nonInteractivePermissions: "deny",
      }),
    ).rejects.toThrow(/CLI permission update disk error/);
    expect(cliCalls.length).toBe(1);
    const reply = await runtime.prompt({ ...sessionInput, text: "after-abort" });
    expect(reply.text).toBe("mode=approve-all;policy=none");
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
    expect(result.text).toBe("mode=deny-all;policy=none");

    await engine.shutdown();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}, 15_000);
test("Scenario 5: prompt stays blocked while staged until the CLI outcome is final; CLI reject sees only OLD", async () => {
  const dir = await mkdtemp(join(tmpdir(), "rt-perm-isolation-"));
  try {
    const entry = join(dir, "echo-worker.mjs");
    await createPolicyEchoWorker(entry);
    const engine = new RuntimeEngine({
      workerEntryPath: entry,
      permissionMode: "approve-all",
      nonInteractivePermissions: "deny",
    });
    const warm = await engine.prompt({ ...sessionInput, text: "warm" });
    expect(warm.text).toBe("mode=approve-all;policy=none");
    // Controllable CLI: stays pending until the test decides the outcome.
    const cliGate = Promise.withResolvers<Record<string, never>>();
    const cliCalls: unknown[] = [];
    const gatedCli = {
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
      async updatePermissionPolicy(policy: unknown) {
        cliCalls.push(policy);
        return await cliGate.promise;
      },
      async shutdown() { return {}; },
    } as unknown as BridgeEngine;
    const router = new EngineRouter(new SessionEngineBinding(), gatedCli, engine);
    let routerSettled = false;
    const routerUpdate = router
      .updatePermissionPolicy({ permissionMode: "deny-all", nonInteractivePermissions: "deny" })
      .then(
        () => { routerSettled = true; },
        (error) => { routerSettled = true; throw error; },
      );
    // Wait until the Runtime stage is fully done (workers ACKed NEW) and the
    // transaction is parked on the pending CLI outcome.
    for (let i = 0; i < 200 && cliCalls.length === 0; i++) {
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(cliCalls.length).toBe(1);
    // A prompt arriving now must stay blocked: the staged NEW policy has no
    // downstream verdict yet, so nothing may execute under it.
    let promptSettled = false;
    const gatedPrompt = engine
      .prompt({ ...sessionInput, text: "gated" })
      .then((res) => { promptSettled = true; return res; });
    await new Promise((r) => setTimeout(r, 400));
    expect(promptSettled).toBe(false);
    expect(routerSettled).toBe(false);
    // CLI rejects: rollback restores all-old, then the prompt proceeds —
    // and can only ever observe the OLD policy.
    cliGate.reject(new Error("CLI down (simulated)"));
    await expect(routerUpdate).rejects.toThrow(/CLI down/);
    const res = await gatedPrompt;
    expect(promptSettled).toBe(true);
    expect(res.text).toBe("mode=approve-all;policy=none");
    await engine.shutdown();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}, 20_000);
test("Scenario 6: CLI resolve releases the staged prompt under the NEW policy", async () => {
  const dir = await mkdtemp(join(tmpdir(), "rt-perm-release-"));
  try {
    const entry = join(dir, "echo-worker.mjs");
    await createPolicyEchoWorker(entry);
    const engine = new RuntimeEngine({
      workerEntryPath: entry,
      permissionMode: "approve-all",
      nonInteractivePermissions: "deny",
    });
    const warm = await engine.prompt({ ...sessionInput, text: "warm" });
    expect(warm.text).toBe("mode=approve-all;policy=none");
    const cliGate = Promise.withResolvers<Record<string, never>>();
    const cliCalls: unknown[] = [];
    const gatedCli = {
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
      async updatePermissionPolicy(policy: unknown) {
        cliCalls.push(policy);
        return await cliGate.promise;
      },
      async shutdown() { return {}; },
    } as unknown as BridgeEngine;
    const router = new EngineRouter(new SessionEngineBinding(), gatedCli, engine);
    let routerError: unknown = null;
    const routerUpdate = router
      .updatePermissionPolicy({ permissionMode: "deny-all", nonInteractivePermissions: "deny" })
      .catch((error) => { routerError = error; throw error; });
    for (let i = 0; i < 200 && cliCalls.length === 0; i++) {
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(cliCalls.length).toBe(1);
    let promptSettled = false;
    const gatedPrompt = engine
      .prompt({ ...sessionInput, text: "gated" })
      .then((res) => { promptSettled = true; return res; });
    await new Promise((r) => setTimeout(r, 400));
    expect(promptSettled).toBe(false);
    // CLI resolves: finalize admits the queued prompt under NEW.
    cliGate.resolve({});
    await routerUpdate;
    expect(routerError).toBeNull();
    const res = await gatedPrompt;
    expect(res.text).toBe("mode=deny-all;policy=none");
    await engine.shutdown();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}, 20_000);
