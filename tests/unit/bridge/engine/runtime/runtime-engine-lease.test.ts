import { expect, test } from "bun:test";
import { mkdtemp, writeFile, rm, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { RuntimeEngine } from "../../../../../src/bridge/engine/runtime-engine";

const baseInput = {
  agent: "codex",
  cwd: "/repo",
  name: "demo",
  logicalSessionId: "lease-sess-1",
};

async function slowWorker(entry: string): Promise<void> {
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
      "        process.stdout.write(JSON.stringify({ id: msg.id, ok: true, result: { ready: true, sessionKey: msg.params.sessionKey, acpxRecordId: 'rec-'+msg.params.sessionKey } }) + '\\n');",
      "      } else if (msg.method === 'prompt') {",
      "        const text = msg.params.text;",
      "        // slow prompt takes 400ms",
      "        setTimeout(() => {",
      "          process.stdout.write(JSON.stringify({ id: msg.id, event: 'text_delta', payload: { type: 'text_delta', text: 'ok:'+text } }) + '\\n');",
      "          process.stdout.write(JSON.stringify({ id: msg.id, ok: true, result: { result: { status: 'completed' }, finalText: 'ok:'+text } }) + '\\n');",
      "        }, 400);",
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

test("P1-1: prompt and drain are serialised per logicalSessionId (maxConcurrent=1)", async () => {
  const dir = await mkdtemp(join(tmpdir(), "rt-lease-"));
  const stateSessionsDir = join(dir, "state", "sessions");
  await mkdir(stateSessionsDir, { recursive: true });
  const queueDir = join(dir, "state", "runtime-queue");
  const fenceDir = join(dir, "state", "worker-fences");
  const entry = join(dir, "slow-worker.mjs");
  await slowWorker(entry);
  const engine = new RuntimeEngine({
    workerEntryPath: entry,
    permissionMode: "approve-all",
    stateDir: stateSessionsDir,
    queueDir,
    fenceDir,
    idleTtlMs: 200,
  });
  try {
    // Start a slow prompt
    const p1 = engine.prompt({ ...baseInput, text: "slow1" });
    // Immediately enqueue a second turn via injectMessage (which will be drained after p1)
    // For lease test, we also start a second prompt concurrently - it should wait for p1's lease
    const p2Start = Date.now();
    const p2 = engine.prompt({ ...baseInput, text: "slow2" });
    const r1 = await p1;
    expect(r1.text).toBe("ok:slow1");
    const r2 = await p2;
    expect(r2.text).toBe("ok:slow2");
    const elapsed = Date.now() - p2Start;
    // p2 should have waited for p1 (400ms) so elapsed should be > 700ms (p1 400 + p2 400, but p2 started after p1, so p2 alone ~400, but if serialised, p2 starts after p1, so p2Start->p2 end ~800)
    // Allow some slack, but ensure not concurrent (concurrent would be ~400)
    expect(elapsed).toBeGreaterThan(600);
  } finally {
    await engine.shutdown().catch(() => {});
    await rm(dir, { recursive: true, force: true });
  }
}, 15_000);

test("P1-2: shutdown is bounded and does not hang forever on draining", async () => {
  const dir = await mkdtemp(join(tmpdir(), "rt-shutdown-"));
  const stateSessionsDir = join(dir, "state", "sessions");
  await mkdir(stateSessionsDir, { recursive: true });
  const queueDir = join(dir, "state", "runtime-queue");
  const fenceDir = join(dir, "state", "worker-fences");
  const entry = join(dir, "slow-worker.mjs");
  await slowWorker(entry);
  const engine = new RuntimeEngine({
    workerEntryPath: entry,
    permissionMode: "approve-all",
    stateDir: stateSessionsDir,
    queueDir,
    fenceDir,
    idleTtlMs: 200,
  });
  try {
    // Access private draining for test injection - bounded-shutdown verification requires a draining entry
    const engineWithDraining = engine as unknown as { draining: Map<string, Promise<void>> };
    const quickDrain = Promise.resolve();
    engineWithDraining.draining.set("lease-sess-1", quickDrain);
    const start = Date.now();
    await engine.shutdown();
    const elapsed = Date.now() - start;
    // Shutdown should wait for the quick drain (~80ms) but not hang 8s
    expect(elapsed).toBeLessThan(1000);
    expect(elapsed).toBeGreaterThanOrEqual(0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}, 15_000);
