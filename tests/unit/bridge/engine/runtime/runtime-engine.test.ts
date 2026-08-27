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
      // Streaming shape: event frame DURING the turn, then the settled response.
      "        process.stdout.write(JSON.stringify({ id: msg.id, event: 'text_delta', payload: { type: 'text_delta', text: 'hi' } }) + '\\n');",
      "        process.stdout.write(JSON.stringify({ id: msg.id, ok: true, result: { result: { status: 'completed' }, finalText: 'hi' } }) + '\\n');",
      "      } else if (msg.method === 'ensure') {",
      "        process.stdout.write(JSON.stringify({ id: msg.id, ok: true, result: { ready: true, sessionKey: msg.params.sessionKey, acpxRecordId: 'rec-test-1' } }) + '\\n');",
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
test("streaming timing regression: onSegment fires while prompt promise is still pending", async () => {
  const dir = await mkdtemp(join(tmpdir(), "rt-timing-"));
  try {
    const entry = join(dir, "delayed-worker.mjs");
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
        // Emit event immediately, but delay the final response by 40ms so the
        // caller can observe that onSegment runs WHILE prompt() is still unresolved.
        "        process.stdout.write(JSON.stringify({ id: msg.id, event: 'text_delta', payload: { type: 'text_delta', text: 'chunk-1' } }) + '\\n');",
        "        setTimeout(() => {",
        "          process.stdout.write(JSON.stringify({ id: msg.id, ok: true, result: { result: { status: 'completed' }, finalText: 'chunk-1' } }) + '\\n');",
        "        }, 40);",
        "      } else if (msg.method === 'ensure') {",
        "        process.stdout.write(JSON.stringify({ id: msg.id, ok: true, result: { ready: true, sessionKey: msg.params?.sessionKey, acpxRecordId: 'rec-1' } }) + '\\n');",
        "      } else {",
        "        process.stdout.write(JSON.stringify({ id: msg.id, ok: true, result: {} }) + '\\n');",
        "      }",
        "      if (msg.method === 'shutdown') process.exit(0);",
        "    } catch {}",
        "  }",
        "});",
      ].join("\n"),
    );
    const engine = new RuntimeEngine({ workerEntryPath: entry, permissionMode: "approve-all" });
    let promptPromiseSettled = false;
    let onSegmentRanWhilePending = false;

    const promptPromise = engine.prompt({ ...sessionInput, text: "stream-test" }, (event) => {
      if (event.type === "prompt.segment" && event.text === "chunk-1") {
        onSegmentRanWhilePending = !promptPromiseSettled;
      }
    });
    promptPromise.finally(() => {
      promptPromiseSettled = true;
    });

    const result = await promptPromise;
    expect(result.text).toBe("chunk-1");
    // IRON LAW: onSegment must have been called BEFORE the prompt promise settled!
    expect(onSegmentRanWhilePending).toBe(true);
    await engine.shutdown();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}, 15_000);
test("G9: usage events never fabricate 0 for unknown token fields (used-only, size-only, both, neither)", async () => {
  const dir = await mkdtemp(join(tmpdir(), "rt-usage-matrix-"));
  try {
    const entry = join(dir, "usage-worker.mjs");
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
        "        if (msg.params?.text === 'used-only') {",
        "          process.stdout.write(JSON.stringify({ id: msg.id, event: 'usage', payload: { type: 'status', text: 'u', used: 100 } }) + '\\n');",
        "        } else if (msg.params?.text === 'size-only') {",
        "          process.stdout.write(JSON.stringify({ id: msg.id, event: 'usage', payload: { type: 'status', text: 's', size: 200000 } }) + '\\n');",
        "        } else if (msg.params?.text === 'both') {",
        "          process.stdout.write(JSON.stringify({ id: msg.id, event: 'usage', payload: { type: 'status', text: 'b', used: 100, size: 200000 } }) + '\\n');",
        "        } else if (msg.params?.text === 'neither') {",
        "          process.stdout.write(JSON.stringify({ id: msg.id, event: 'usage', payload: { type: 'status', text: 'status msg' } }) + '\\n');",
        "        }",
        "        process.stdout.write(JSON.stringify({ id: msg.id, ok: true, result: { result: { status: 'completed' }, finalText: 'done' } }) + '\\n');",
        "      } else if (msg.method === 'ensure') {",
        "        process.stdout.write(JSON.stringify({ id: msg.id, ok: true, result: { ready: true, sessionKey: msg.params?.sessionKey, acpxRecordId: 'rec-u' } }) + '\\n');",
        "      } else {",
        "        process.stdout.write(JSON.stringify({ id: msg.id, ok: true, result: {} }) + '\\n');",
        "      }",
        "      if (msg.method === 'shutdown') process.exit(0);",
        "    } catch {}",
        "  }",
        "});",
      ].join("\n"),
    );
    const engine = new RuntimeEngine({ workerEntryPath: entry, permissionMode: "approve-all" });

    // 1. used-only: must NOT fabricate size: 0
    const usedOnlyEvents: Array<{ type: string; used?: number; size?: number }> = [];
    await engine.prompt({ ...sessionInput, text: "used-only" }, (e) => {
      if (e.type === "prompt.usage") usedOnlyEvents.push(e);
    });
    expect(usedOnlyEvents.length).toBe(0);

    // 2. size-only: must NOT fabricate used: 0
    const sizeOnlyEvents: Array<{ type: string; used?: number; size?: number }> = [];
    await engine.prompt({ ...sessionInput, text: "size-only" }, (e) => {
      if (e.type === "prompt.usage") sizeOnlyEvents.push(e);
    });
    expect(sizeOnlyEvents.length).toBe(0);

    // 3. both: emits prompt.usage with real values
    const bothEvents: Array<{ type: string; used?: number; size?: number }> = [];
    await engine.prompt({ ...sessionInput, text: "both" }, (e) => {
      if (e.type === "prompt.usage") bothEvents.push(e);
    });
    expect(bothEvents.length).toBe(1);
    expect(bothEvents[0]!.used).toBe(100);
    expect(bothEvents[0]!.size).toBe(200000);

    // 4. neither: no prompt.usage event
    const neitherEvents: Array<{ type: string }> = [];
    await engine.prompt({ ...sessionInput, text: "neither" }, (e) => {
      if (e.type === "prompt.usage") neitherEvents.push(e);
    });
    expect(neitherEvents.length).toBe(0);

    await engine.shutdown();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("WorkerUnavailableError carries the unsupported code", () => {
  expect(new WorkerUnavailableError("nope").code).toBe("RUNTIME_ENGINE_UNSUPPORTED");
});
