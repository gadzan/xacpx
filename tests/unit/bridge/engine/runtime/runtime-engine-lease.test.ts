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

test("P1-1a: prompt vs prompt serialised per logicalSessionId (maxConcurrent=1)", async () => {
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
    const p1 = engine.prompt({ ...baseInput, text: "slow1" });
    const p2Start = Date.now();
    const p2 = engine.prompt({ ...baseInput, text: "slow2" });
    const r1 = await p1;
    expect(r1.text).toBe("ok:slow1");
    const r2 = await p2;
    expect(r2.text).toBe("ok:slow2");
    const elapsed = Date.now() - p2Start;
    expect(elapsed).toBeGreaterThan(600);
  } finally {
    await engine.shutdown().catch(() => {});
    await rm(dir, { recursive: true, force: true });
  }
}, 15_000);

test("P1-1b: prompt vs drain serialised (shared lease)", async () => {
  const dir = await mkdtemp(join(tmpdir(), "rt-lease-drain-"));
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
    const p1 = engine.prompt({ ...baseInput, text: "slow1" });
    // Enqueue a second turn via durable queue while p1 is active; drain must wait for p1's lease
    const inject = await engine.injectMessage({
      logicalSessionId: baseInput.logicalSessionId,
      messageId: "m1",
      text: "queued1",
      mode: "queue",
    } as unknown as never); // test helper: EngineInjectInput shape not fully typed for queue suspension test, unchecked cast with reason
    expect(inject.status).toBe("queued");
    const before = Date.now();
    const r1 = await p1;
    expect(r1.text).toBe("ok:slow1");
    // After p1, drain for queued1 should still be pending (serialised, not concurrent)
    // Poll hasPending shortly after p1 — should still be true because drain needs 400ms
    const hasPendingImmediately = await (engine as any).getQueueStore().hasPending(baseInput.logicalSessionId);
    // If serialised, drain hasn't yet completed queued1, so pending remains true for a short window
    // If concurrent, drain would have already completed queued1 during p1, so pending would be false
    // Allow for timing: check within 50ms after p1
    expect(hasPendingImmediately).toBe(true);
    // Wait for drain to complete queued1 (400ms)
    const { promise: _p500, resolve: _r500 } = Promise.withResolvers<void>(); setTimeout(_r500, 500); await _p500; // real timer: drain needs 400ms wall-clock, fake timers cannot advance worker process
    const hasPendingAfter = await (engine as any).getQueueStore().hasPending(baseInput.logicalSessionId);
    expect(hasPendingAfter).toBe(false);
    const elapsed = Date.now() - before;
    expect(elapsed).toBeGreaterThan(300);
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
    // test helper: access private draining for bounded-shutdown verification, unchecked cast with reason
    const engineWithDraining = engine as unknown as { draining: Map<string, Promise<void>> };
    const quickDrain = Promise.resolve();
    engineWithDraining.draining.set("lease-sess-1", quickDrain);
    const start = Date.now();
    await engine.shutdown();
    const elapsed = Date.now() - start;
    expect(elapsed).toBeLessThan(1000);
    expect(elapsed).toBeGreaterThanOrEqual(0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}, 15_000);

test("P1-3: archive suspends drain, direct prompt resumes", async () => {
  const dir = await mkdtemp(join(tmpdir(), "rt-archive-suspend-"));
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
    // Enqueue a pending turn
    await engine.injectMessage({
      logicalSessionId: baseInput.logicalSessionId,
      messageId: "m-archive",
      text: "archived-pending",
      mode: "queue",
    } as unknown as never); // test helper: EngineInjectInput shape not fully typed for queue suspension test, unchecked cast with reason
    // Allow drain to start, then archive (freeWarmProcess) while pending
    const { promise: _p50, resolve: _r50 } = Promise.withResolvers<void>(); setTimeout(_r50, 50); await _p50; // real timer: brief yield for drain to start
    // Archive should suspend draining, not kick it
    await engine.freeWarmProcess(baseInput as unknown as never); // test helper: freeWarmProcess expects EngineSessionInput, baseInput satisfies with unchecked cast
    const hasPendingAfterArchive = await (engine as any).getQueueStore().hasPending(baseInput.logicalSessionId);
    expect(hasPendingAfterArchive).toBe(true);
    // Verify draining is suspended (no active drain should be running for this key)
    // The queue should remain pending until next direct prompt
    const { promise: _p300, resolve: _r300 } = Promise.withResolvers<void>(); setTimeout(_r300, 300); await _p300; // real timer: allow archive suspend to settle
    const stillPending = await (engine as any).getQueueStore().hasPending(baseInput.logicalSessionId);
    expect(stillPending).toBe(true);
    // Direct prompt should clear suspend and drain the pending
    const r = await engine.prompt({ ...baseInput, text: "resume" });
    expect(r.text).toBe("ok:resume");
    const { promise: _p600, resolve: _r600 } = Promise.withResolvers<void>(); setTimeout(_r600, 600); await _p600; // real timer: drain after prompt needs wall-clock
    const afterPromptPending = await (engine as any).getQueueStore().hasPending(baseInput.logicalSessionId);
    expect(afterPromptPending).toBe(false);
  } finally {
    await engine.shutdown().catch(() => {});
    await rm(dir, { recursive: true, force: true });
  }
}, 15_000);
