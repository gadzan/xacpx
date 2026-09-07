import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { RuntimeEngine, RuntimeError } from "../../../../../src/bridge/engine/runtime-engine";
import { EngineRouter } from "../../../../../src/bridge/engine/engine-router";
import { SessionEngineBinding } from "../../../../../src/bridge/engine/session-engine-binding";
import type { BridgeRuntime } from "../../../../../src/bridge/bridge-runtime";
import { BridgeServer } from "../../../../../src/bridge/bridge-server";
import type { BridgeEngine, EngineSessionInput } from "../../../../../src/bridge/engine/bridge-engine";

const sessionInput: EngineSessionInput = {
  agent: "codex",
  cwd: "/repo",
  name: "demo",
  logicalSessionId: "logical-eb-1",
};

/** Worker that answers ensure fine but rejects a method with a stable RPC error code. */
async function withRpcErrorWorker(entry: string): Promise<void> {
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
      "        process.stdout.write(JSON.stringify({ id: msg.id, ok: false, error: { code: 'RUNTIME_PERMISSION_DENIED', message: 'agent denied' } }) + '\\n');",
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

/** Worker that dies mid-prompt (unexpected crash). */
async function withCrashWorker(entry: string): Promise<void> {
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
      "      if (msg.method === 'prompt') process.exit(1);",
      "      process.stdout.write(JSON.stringify({ id: msg.id, ok: true, result: {} }) + '\\n');",
      "      if (msg.method === 'shutdown') process.exit(0);",
      "    } catch {}",
      "  }",
      "});",
    ].join("\n"),
  );
}

function stubCli(log: string[]): BridgeEngine {
  return {
    kind: "cli",
    async hasSession() {
      log.push("cli:hasSession");
      return { exists: false };
    },
    async tailSessionHistory() {
      throw new Error("not implemented");
    },
    async listAgentSessions() {
      return undefined;
    },
    async ensureSession() {
      throw new Error("not implemented");
    },
    async resumeAgentSession() {
      throw new Error("not implemented");
    },
    async prompt() {
      throw new Error("not implemented");
    },
    async injectMessage() {
      throw new Error("not implemented");
    },
    async setMode() {
      throw new Error("not implemented");
    },
    async setModel() {
      throw new Error("not implemented");
    },
    async getSessionModel() {
      throw new Error("not implemented");
    },
    async setSessionEffort() {
      throw new Error("not implemented");
    },
    async getSessionEffort() {
      throw new Error("not implemented");
    },
    async cancel() {
      throw new Error("not implemented");
    },
    async removeSession() {
      throw new Error("not implemented");
    },
    async deleteSession() {
      throw new Error("not implemented");
    },
    async freeWarmProcess() {
      throw new Error("not implemented");
    },
    async isSessionWarm() {
      throw new Error("not implemented");
    },
    async getAgentSessionId() {
      throw new Error("not implemented");
    },
    async updatePermissionPolicy() {
      return {};
    },
    async shutdown() {
      return {};
    },
  } as unknown as BridgeEngine;
}

test("engine boundary: WorkerRpcError keeps its stable contract code (RUNTIME_PERMISSION_DENIED)", async () => {
  const dir = await mkdtemp(join(tmpdir(), "rt-eb-rpc-"));
  try {
    const entry = join(dir, "worker.mjs");
    await withRpcErrorWorker(entry);
    const engine = new RuntimeEngine({ workerEntryPath: entry, permissionMode: "approve-all", fenceDir: join(dir, "wf") });
    const error = await engine.ensureSession(sessionInput).catch((e) => e);
    expect(error).toBeInstanceOf(RuntimeError);
    expect(error.code).toBe("RUNTIME_PERMISSION_DENIED");
    await engine.shutdown().catch(() => {});
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}, 15_000);

test("engine boundary: unexpected worker crash maps to RUNTIME_WORKER_CRASHED, never BRIDGE_INTERNAL_ERROR", async () => {
  const dir = await mkdtemp(join(tmpdir(), "rt-eb-crash-"));
  try {
    const entry = join(dir, "worker.mjs");
    await withCrashWorker(entry);
    const engine = new RuntimeEngine({ workerEntryPath: entry, permissionMode: "approve-all", fenceDir: join(dir, "wf") });
    const error = await engine.prompt({ ...sessionInput, text: "hello" }).catch((e) => e);
    expect(error.code).toBe("RUNTIME_WORKER_CRASHED");
    await engine.shutdown().catch(() => {});
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}, 15_000);

test("engine boundary: teardown failure maps to RUNTIME_WORKER_TEARDOWN_PENDING", async () => {
  const dir = await mkdtemp(join(tmpdir(), "rt-eb-teardown-"));
  try {
    const entry = join(dir, "worker.mjs");
    await withRpcErrorWorker(entry);
    const engine = new RuntimeEngine({
      workerEntryPath: entry,
      permissionMode: "approve-all",
      fenceDir: join(dir, "wf"),
      workerClientDeps: {
        terminateProcessTree: async () => {
          throw new Error("tree terminator exploded");
        },
      },
    });
    // Warm-up: acquire registers the worker (ensure itself is denied by this
    // fake — the rejection is expected and irrelevant to the teardown path).
    await engine.ensureSession(sessionInput).catch(() => {});
    const error = await engine.freeWarmProcess(sessionInput).catch((e) => e);
    expect(error.code).toBe("RUNTIME_WORKER_TEARDOWN_PENDING");
    expect(error.message).toContain("tree terminator exploded");
    await engine.shutdown().catch(() => {});
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}, 15_000);

test("bridge-server end-to-end: runtime worker crash surfaces as stable RUNTIME_WORKER_CRASHED code", async () => {
  const dir = await mkdtemp(join(tmpdir(), "rt-eb-bridge-"));
  try {
    const entry = join(dir, "worker.mjs");
    await withCrashWorker(entry);
    const runtime = new RuntimeEngine({ workerEntryPath: entry, permissionMode: "approve-all", fenceDir: join(dir, "wf") });
    const binding = new SessionEngineBinding();
    binding.setBinding("rt", "runtime");
    const router = new EngineRouter(binding, stubCli([]), runtime);
    const server = new BridgeServer(router as unknown as BridgeRuntime);

    const response = await server.handleLine(
      JSON.stringify({
        id: "eb-1",
        method: "prompt",
        params: { agent: "codex", cwd: "/repo", name: "demo", sessionKey: "rt", text: "hello" },
      }),
    );
    expect(response).not.toBeNull();
    const parsed = JSON.parse(response!) as { ok: boolean; error?: { code: string } };
    expect(parsed.ok).toBe(false);
    expect(parsed.error?.code).toBe("RUNTIME_WORKER_CRASHED");
    await runtime.shutdown().catch(() => {});
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}, 15_000);
