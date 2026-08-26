import { expect, test } from "bun:test";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { RuntimeEngine, WorkerUnavailableError } from "../../../../../src/bridge/engine/runtime-engine";

const sessionInput = {
  agent: "codex",
  cwd: "/repo",
  name: "demo",
  logicalSessionId: "logical-engine-1",
};

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
      "      if (msg.method === 'prompt') {",
      "        process.stdout.write(JSON.stringify({ id: msg.id, ok: true, result: { events: [{ type: 'text_delta', text: 'hi' }], result: { status: 'completed' }, finalText: 'hi' } }) + '\\n');",
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

test("engine without a built worker entry fails closed with RUNTIME_ENGINE_UNSUPPORTED", async () => {
  const engine = new RuntimeEngine({
    workerEntryPath: "/nonexistent/worker.js",
    permissionMode: "approve-all",
  });
  await expect(engine.ensureSession(sessionInput)).rejects.toMatchObject({ code: "RUNTIME_ENGINE_UNSUPPORTED" });
});

test("freeWarmProcess on a cold session is a no-op success", async () => {
  const dir = await mkdtemp(join(tmpdir(), "rt-engine-"));
  try {
    const entry = join(dir, "fake-worker.mjs");
    await withFakeWorker(entry);
    const engine = new RuntimeEngine({ workerEntryPath: entry, permissionMode: "approve-all" });
    await expect(engine.freeWarmProcess(sessionInput)).resolves.toEqual({});
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}, 15_000);

test("prompt runs through the worker and returns final text; warm flips after use", async () => {
  const dir = await mkdtemp(join(tmpdir(), "rt-engine-"));
  try {
    const entry = join(dir, "fake-worker.mjs");
    await withFakeWorker(entry);
    const engine = new RuntimeEngine({ workerEntryPath: entry, permissionMode: "approve-all" });
    // Cold before first prompt
    expect((await engine.isSessionWarm(sessionInput)).warm).toBe(false);
    const reply = await engine.prompt({ ...sessionInput, text: "hello" }, () => {});
    expect(reply.text).toBe("hi");
    // Worker stays warm after the turn (normal TTL behavior)
    expect((await engine.isSessionWarm(sessionInput)).warm).toBe(true);
    await engine.shutdown();
    expect((await engine.isSessionWarm(sessionInput)).warm).toBe(false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}, 15_000);

test("removeSession is unsupported until close-parity is proven", async () => {
  const dir = await mkdtemp(join(tmpdir(), "rt-engine-"));
  try {
    const entry = join(dir, "fake-worker.mjs");
    await withFakeWorker(entry);
    const engine = new RuntimeEngine({ workerEntryPath: entry, permissionMode: "approve-all" });
    await expect(engine.removeSession(sessionInput)).rejects.toThrow(/close-parity/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}, 15_000);

test("injectMessage is rejected for every mode until the durable queue lands", async () => {
  const dir = await mkdtemp(join(tmpdir(), "rt-engine-"));
  try {
    const entry = join(dir, "fake-worker.mjs");
    await withFakeWorker(entry);
    const engine = new RuntimeEngine({ workerEntryPath: entry, permissionMode: "approve-all" });
    for (const mode of ["queue", "steer", "auto", "interrupt"] as const) {
      await expect(engine.injectMessage({ ...sessionInput, text: "x", mode, messageId: "m1" })).rejects.toMatchObject({
        code: "RUNTIME_ENGINE_UNSUPPORTED",
      });
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}, 15_000);

test("WorkerUnavailableError carries the unsupported code", () => {
  expect(new WorkerUnavailableError("nope").code).toBe("RUNTIME_ENGINE_UNSUPPORTED");
});
