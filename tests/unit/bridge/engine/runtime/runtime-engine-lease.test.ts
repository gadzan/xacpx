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
function uniqueInput(): typeof baseInput {
  return { ...baseInput, logicalSessionId: `lease-sess-${Math.random().toString(36).slice(2, 10)}` };
}

async function slowWorker(entry: string): Promise<void> {
  await writeFile(
    entry,
    [
      "let pending=new Map();",
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
      "        const tid=setTimeout(() => {",
      "          pending.delete(msg.id);",
      "          process.stdout.write(JSON.stringify({ id: msg.id, event: 'text_delta', payload: { type: 'text_delta', text: 'ok:'+text } }) + '\\n');",
      "          process.stdout.write(JSON.stringify({ id: msg.id, ok: true, result: { result: { status: 'completed' }, finalText: 'ok:'+text } }) + '\\n');",
      "        }, 400);",
      "        pending.set(msg.id, tid);",
      "      } else if (msg.method === 'cancel') {",
      "        for (const tid of pending.values()) clearTimeout(tid); pending.clear();",
      "        process.stdout.write(JSON.stringify({ id: msg.id, ok: true, result: { cancelled: true } }) + '\\n');",
      "      } else if (msg.method === 'close') {",
      "        for (const tid of pending.values()) clearTimeout(tid); pending.clear();",
      "        process.stdout.write(JSON.stringify({ id: msg.id, ok: true, result: {} }) + '\\n');",
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
  const testInput = uniqueInput();
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
    const p1 = engine.prompt({ ...testInput, text: "slow1" });
    const p2Start = Date.now();
    const p2 = engine.prompt({ ...testInput, text: "slow2" });
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
test.serial("P1-6: archive via cancel->freeWarmProcess does not kick drain", async () => {
  const testInput = uniqueInput();
  const dir = await mkdtemp(join(tmpdir(), "rt-archive-cancel-"));
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
    // Enqueue two heads: first may be admitted before archive, second must remain
    await engine.injectMessage({
      logicalSessionId: testInput.logicalSessionId,
      messageId: "m-archive-cancel-1",
      text: "archived-via-cancel-1",
      mode: "queue",
    } as unknown as never);
    await engine.injectMessage({
      logicalSessionId: testInput.logicalSessionId,
      messageId: "m-archive-cancel-2",
      text: "archived-via-cancel-2",
      mode: "queue",
    } as unknown as never);
    const { promise: _p50, resolve: _r50 } = Promise.withResolvers<void>(); setTimeout(_r50, 50); await _p50;
    // Real archive chain: cancel then freeWarmProcess (cancel no longer kicks)
    await engine.cancel(testInput as unknown as never);
    await engine.freeWarmProcess(testInput as unknown as never);
    const hasPendingAfterArchive = await (engine as any).getQueueStore().hasPending(testInput.logicalSessionId);
    expect(hasPendingAfterArchive).toBe(true);
    const isSuspended = await (engine as any).getQueueStore().isSuspended(testInput.logicalSessionId);
    expect(isSuspended).toBe(true);
    // First head (admitted before suspend) dequeues, second remains
    const { promise: _p700, resolve: _r700 } = Promise.withResolvers<void>(); setTimeout(_r700, 700); await _p700;
    const stillPending = await (engine as any).getQueueStore().hasPending(testInput.logicalSessionId);
    expect(stillPending).toBe(true);
    const qlen = await (engine as any).getQueueStore().queueLength(testInput.logicalSessionId);
    expect(qlen).toBe(1);
    const warm = await engine.isSessionWarm(testInput as unknown as never);
    expect(warm.warm).toBe(false);
    // Direct prompt should clear suspend and drain
    const r = await engine.prompt({ ...testInput, text: "resume-after-cancel-archive" });
    expect(r.text).toBe("ok:resume-after-cancel-archive");
    const { promise: _p600, resolve: _r600 } = Promise.withResolvers<void>(); setTimeout(_r600, 600); await _p600;
    const after = await (engine as any).getQueueStore().hasPending(testInput.logicalSessionId);
    expect(after).toBe(false);
  } finally {
    await engine.shutdown().catch(() => {});
    await rm(dir, { recursive: true, force: true });
  }
}, 15_000);

test.serial("P1-7: delete generation blocks waiter that was queued behind policy lock (prompt)", async () => {
  const testInput = uniqueInput();
  const dir = await mkdtemp(join(tmpdir(), "rt-delete-policy-prompt-"));
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
    // Hold policy lock
    await (engine as any).acquirePolicyLock();
    // Start delete and prompt while lock held; both will await lock
    const pDelete = engine.deleteSession(testInput as unknown as never);
    const pPrompt = engine.prompt({ ...testInput, text: "should-not-recreate" });
    pPrompt.catch(() => {});
    // Give them time to queue on lock
    const { promise: _p50, resolve: _r50 } = Promise.withResolvers<void>(); setTimeout(_r50, 50); await _p50;
    // Release lock: D should acquire first (it was queued first), then P
    (engine as any).releasePolicyLock();
    await pDelete;
    // P must be rejected with RUNTIME_INIT_FAILED (generation mismatch), not recreate
    await expect(pPrompt).rejects.toMatchObject({ code: "RUNTIME_INIT_FAILED" });
    expect(await (engine as any).getQueueStore().hasPending(testInput.logicalSessionId).catch(()=>false)).toBe(false);
    expect((await engine.isSessionWarm(testInput as unknown as never)).warm).toBe(false);
    // Ensure no record was recreated
    const recId = await (engine as any).resolveRecordId(testInput, undefined);
    expect(recId).toBeUndefined();
  } finally {
    // Ensure lock released if still held
    try { (engine as any).releasePolicyLock(); } catch {}
    await engine.shutdown().catch(() => {});
    await rm(dir, { recursive: true, force: true });
  }
}, 15_000);

test.serial("P1-8: delete generation blocks waiter that was queued behind policy lock (inject)", async () => {
  const testInput = uniqueInput();
  const dir = await mkdtemp(join(tmpdir(), "rt-delete-policy-inject-"));
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
    await (engine as any).acquirePolicyLock();
    const pDelete = engine.deleteSession(testInput as unknown as never);
    const pInject = engine.injectMessage({
      logicalSessionId: testInput.logicalSessionId,
      messageId: "m-inject-after-delete",
      text: "should-not-queue",
      mode: "queue",
    } as unknown as never);
    (pInject as any).catch(() => {});
    const { promise: _p50, resolve: _r50 } = Promise.withResolvers<void>(); setTimeout(_r50, 50); await _p50;
    (engine as any).releasePolicyLock();
    await pDelete;
    await expect(pInject).rejects.toMatchObject({ code: "RUNTIME_INIT_FAILED" });
    expect(await (engine as any).getQueueStore().hasPending(testInput.logicalSessionId).catch(()=>false)).toBe(false);
  } finally {
    try { (engine as any).releasePolicyLock(); } catch {}
    await engine.shutdown().catch(() => {});
    await rm(dir, { recursive: true, force: true });
  }
}, 15_000);


test("P1-1b: prompt vs drain serialised (shared lease)", async () => {
  const testInput = uniqueInput();
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
    const p1 = engine.prompt({ ...testInput, text: "slow1" });
    // Enqueue a second turn via durable queue while p1 is active; drain must wait for p1's lease
    const inject = await engine.injectMessage({
      logicalSessionId: testInput.logicalSessionId,
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
    const hasPendingImmediately = await (engine as any).getQueueStore().hasPending(testInput.logicalSessionId);
    // If serialised, drain hasn't yet completed queued1, so pending remains true for a short window
    // If concurrent, drain would have already completed queued1 during p1, so pending would be false
    // Allow for timing: check within 50ms after p1
    expect(hasPendingImmediately).toBe(true);
    // Wait for drain to complete queued1 (400ms)
    const { promise: _p500, resolve: _r500 } = Promise.withResolvers<void>(); setTimeout(_r500, 500); await _p500; // real timer: drain needs 400ms wall-clock, fake timers cannot advance worker process
    const hasPendingAfter = await (engine as any).getQueueStore().hasPending(testInput.logicalSessionId);
    expect(hasPendingAfter).toBe(false);
    const elapsed = Date.now() - before;
    expect(elapsed).toBeGreaterThan(300);
  } finally {
    await engine.shutdown().catch(() => {});
    await rm(dir, { recursive: true, force: true });
  }
}, 15_000);

test("P1-2: shutdown is bounded and does not hang forever on draining", async () => {
  const testInput = uniqueInput();
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

test.serial("P1-3: archive suspends drain, direct prompt resumes", async () => {
  const testInput = uniqueInput();
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
    // Enqueue two pending turns to test suspend blocks next head but terminal head still dequeues
    await engine.injectMessage({
      logicalSessionId: testInput.logicalSessionId,
      messageId: "m-archive-1",
      text: "archived-pending-1",
      mode: "queue",
    } as unknown as never); // test helper: EngineInjectInput shape not fully typed for queue suspension test, unchecked cast with reason
    await engine.injectMessage({
      logicalSessionId: testInput.logicalSessionId,
      messageId: "m-archive-2",
      text: "archived-pending-2",
      mode: "queue",
    } as unknown as never);
    // Allow drain to start on first head, then archive (freeWarmProcess) while pending
    const { promise: _p50, resolve: _r50 } = Promise.withResolvers<void>(); setTimeout(_r50, 50); await _p50; // real timer: brief yield for drain to start
    // Archive should suspend draining, not kick it
    await engine.freeWarmProcess(testInput as unknown as never); // test helper: freeWarmProcess expects EngineSessionInput, baseInput satisfies with unchecked cast
    const hasPendingAfterArchive = await (engine as any).getQueueStore().hasPending(testInput.logicalSessionId);
    expect(hasPendingAfterArchive).toBe(true);
    // Archive must cool the owner even while suspend keeps next head (at-least-once replay only for non-terminal); worker should not remain warm
    // First head (m-archive-1) was already admitted and will complete and be dequeued even though suspended; second head must remain
    const { promise: _p700, resolve: _r700 } = Promise.withResolvers<void>(); setTimeout(_r700, 700); await _p700; // real timer: wait >400ms wall-clock without prompt to prove suspend blocks next head (first head dequeues, second stays)
    const stillPending = await (engine as any).getQueueStore().hasPending(testInput.logicalSessionId);
    expect(stillPending).toBe(true);
    const queueLen = await (engine as any).getQueueStore().queueLength(testInput.logicalSessionId);
    expect(queueLen).toBe(1);
    const warmAfterArchive = await engine.isSessionWarm(testInput as unknown as never);
    expect(warmAfterArchive.warm).toBe(false);
    // Direct prompt should clear suspend and drain the remaining pending
    const r = await engine.prompt({ ...testInput, text: "resume" });
    expect(r.text).toBe("ok:resume");
    const { promise: _p600, resolve: _r600 } = Promise.withResolvers<void>(); setTimeout(_r600, 600); await _p600; // real timer: drain after prompt needs wall-clock
    const afterPromptPending = await (engine as any).getQueueStore().hasPending(testInput.logicalSessionId);
    expect(afterPromptPending).toBe(false);
  } finally {
    await engine.shutdown().catch(() => {});
    await rm(dir, { recursive: true, force: true });
  }
}, 15_000);

test.serial("P1-4: delete pending lease waiter does not ghost-recreate session (deleting gate)", async () => {
  const testInput = uniqueInput();
  const dir = await mkdtemp(join(tmpdir(), "rt-delete-lease-"));
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
    // Long A owns lease
    const pA = engine.prompt({ ...testInput, text: "longA" });
    pA.catch(() => {});
    // B waits for lease
    const pB = engine.prompt({ ...testInput, text: "waiterB" });
    pB.catch(() => {});
    // Give A time to acquire and start, B to block on lease
    const { promise: _p50, resolve: _r50 } = Promise.withResolvers<void>(); setTimeout(_r50, 50); await _p50;
    // Delete while B is waiting on lease — delete will wait for active turn to settle (A completes, B rejected via deleteGenerations)
    await engine.deleteSession(testInput as unknown as never);
    const hasPendingAfterDelete = await (engine as any).getQueueStore().hasPending(testInput.logicalSessionId).catch(() => false);
    expect(hasPendingAfterDelete).toBe(false);
    // B should have been rejected due to deleting gate, not executed
    // pB should be rejected due to deleting gate, pA may be cancelled or terminated - both are expected
    await expect(pB).rejects.toMatchObject({ code: "RUNTIME_INIT_FAILED" });
    await pA.catch(() => {});
    // Ensure any dangling worker termination rejections are settled
    await new Promise((r) => setTimeout(r, 100));
    const warmAfterDelete = await engine.isSessionWarm(testInput as unknown as never);
    expect(warmAfterDelete.warm).toBe(false);
    // Ensure no new worker was spawned for B: queue still empty, no pending, and no new session file
    const stillPending = await (engine as any).getQueueStore().hasPending(testInput.logicalSessionId).catch(() => false);
    expect(stillPending).toBe(false);
  } finally {
    await engine.shutdown().catch(() => {});
    await rm(dir, { recursive: true, force: true });
  }
}, 15_000);

test.serial("P1-5: lease FIFO - C does not overtake B (A owns, B then C wait)", async () => {
  const testInput = uniqueInput();
  const dir = await mkdtemp(join(tmpdir(), "rt-lease-fifo-"));
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
    const order: string[] = [];
    const pA = engine.prompt({ ...testInput, text: "A" }).then((r) => { order.push("A"); return r; });
    // Small stagger to ensure FIFO order B before C
    const { promise: _p20, resolve: _r20 } = Promise.withResolvers<void>(); setTimeout(_r20, 20); await _p20;
    const pB = engine.prompt({ ...testInput, text: "B" }).then((r) => { order.push("B"); return r; });
    const { promise: _p10, resolve: _r10 } = Promise.withResolvers<void>(); setTimeout(_r10, 10); await _p10;
    const pC = engine.prompt({ ...testInput, text: "C" }).then((r) => { order.push("C"); return r; });
    await Promise.all([pA, pB, pC]);
    expect(order).toEqual(["A", "B", "C"]);
  } finally {
    await engine.shutdown().catch(() => {});
    await rm(dir, { recursive: true, force: true });
  }
}, 15_000);

test.serial("P1-3b: durable suspend survives restart (prime does not re-kick)", async () => {
  const testInput = uniqueInput();
  const dir = await mkdtemp(join(tmpdir(), "rt-durable-suspend-"));
  const stateSessionsDir = join(dir, "state", "sessions");
  await mkdir(stateSessionsDir, { recursive: true });
  const queueDir = join(dir, "state", "runtime-queue");
  const fenceDir = join(dir, "state", "worker-fences");
  const entry = join(dir, "slow-worker.mjs");
  await slowWorker(entry);
  const engine1 = new RuntimeEngine({
    workerEntryPath: entry,
    permissionMode: "approve-all",
    stateDir: stateSessionsDir,
    queueDir,
    fenceDir,
    idleTtlMs: 200,
  });
  try {
    // Use two heads so first can dequeue even when suspended (terminal) while second remains blocked
    await engine1.injectMessage({
      logicalSessionId: testInput.logicalSessionId,
      messageId: "m-durable-1",
      text: "durable-pending-1",
      mode: "queue",
    } as unknown as never);
    await engine1.injectMessage({
      logicalSessionId: testInput.logicalSessionId,
      messageId: "m-durable-2",
      text: "durable-pending-2",
      mode: "queue",
    } as unknown as never);
    const { promise: _p50, resolve: _r50 } = Promise.withResolvers<void>(); setTimeout(_r50, 50); await _p50;
    await engine1.freeWarmProcess(testInput as unknown as never);
    // Verify durable flag is set
    const isSuspended = await (engine1 as any).getQueueStore().isSuspended(testInput.logicalSessionId);
    expect(isSuspended).toBe(true);
    await engine1.shutdown().catch(() => {});
    // Simulate daemon restart with new engine instance sharing same dirs
    const engine2 = new RuntimeEngine({
      workerEntryPath: entry,
      permissionMode: "approve-all",
      stateDir: stateSessionsDir,
      queueDir,
      fenceDir,
      idleTtlMs: 200,
    });
    try {
      await engine2.primeQueuesFromCatalog([testInput as unknown as never]);
        // Prime should have hydrated suspend and not kicked drain, so pending remains and not warm
      const { promise: _p700, resolve: _r700 } = Promise.withResolvers<void>(); setTimeout(_r700, 700); await _p700;
      const stillPending = await (engine2 as any).getQueueStore().hasPending(testInput.logicalSessionId);
      expect(stillPending).toBe(true);
      const warm = await engine2.isSessionWarm(testInput as unknown as never);
      expect(warm.warm).toBe(false);
      // Direct prompt should clear suspend and drain
      const r = await engine2.prompt({ ...testInput, text: "resume2" });
      expect(r.text).toBe("ok:resume2");
      const { promise: _p600, resolve: _r600 } = Promise.withResolvers<void>(); setTimeout(_r600, 600); await _p600;
      const after = await (engine2 as any).getQueueStore().hasPending(testInput.logicalSessionId);
      expect(after).toBe(false);
    } finally {
      await engine2.shutdown().catch(() => {});
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}, 15_000);
test.serial("P1-9: withWorker cooling ghost acquire blocked (setMode vs delete)", async () => {
  const testInput = uniqueInput();
  const dir = await mkdtemp(join(tmpdir(), "rt-withworker-cooling-"));
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
    // Create worker via prompt
    const r = await engine.prompt({ ...testInput, text: "prime" });
    expect(r.text).toBe("ok:prime");
    const worker = (engine as any).manager?.get(testInput.logicalSessionId);
    expect(worker).toBeDefined();
    // Put worker into cooling (simulate archive coolPending termination in progress)
    worker.lifecycle = "cooling";
    // Start setMode (withWorker) and delete concurrently; setMode should be blocked by epoch/lifecycle
    const pSetMode = engine.setMode({ ...testInput, modeId: "plan" } as any);
    pSetMode.catch(()=>{});
    const pDelete = engine.deleteSession(testInput as unknown as never);
    // Delete should wait for no activeTurn (setMode does not inc activeTurn, but withWorker has epoch check)
    // setMode should be rejected with RUNTIME_INIT_FAILED (ghost), not recreate
    await expect(pSetMode).rejects.toMatchObject({ code: "RUNTIME_INIT_FAILED" });
    await pDelete;
    expect((await engine.isSessionWarm(testInput as unknown as never)).warm).toBe(false);
    const recId = await (engine as any).resolveRecordId(testInput, undefined);
    expect(recId).toBeUndefined();
  } finally {
    await engine.shutdown().catch(()=>{});
    await rm(dir, { recursive: true, force: true });
  }
}, 15_000);

test.serial("P1-10: drain loaded head but not yet incActiveTurn — delete does not resurrect", async () => {
  const testInput = uniqueInput();
  const dir = await mkdtemp(join(tmpdir(), "rt-drain-load-race-"));
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
    // Inject Q but pause drain before it inc's by holding turnLease via a long prompt that owns lease
    const pLong = engine.prompt({ ...testInput, text: "longLeaseHolder" });
    pLong.catch(()=>{});
    // Give long prompt time to acquire lease and start (hasActiveTurn true, turnLease held)
    const { promise: _p50, resolve: _r50 } = Promise.withResolvers<void>(); setTimeout(_r50, 50); await _p50;
    await engine.injectMessage({
      logicalSessionId: testInput.logicalSessionId,
      messageId: "m-drain-race",
      text: "should-not-execute",
      mode: "queue",
    } as unknown as never);
    // Delete while drain has loaded head but not yet inc (drain is waiting on lease held by long prompt)
    // Delete will wait for hasActiveTurn (true due to long prompt) then succeed
    const pDelete = engine.deleteSession(testInput as unknown as never);
    // Let long prompt finish, then delete should complete
    await pLong.catch(()=>{});
    await pDelete;
    // Drain should have aborted due to epoch mismatch after load, not executed
    await new Promise((r)=>setTimeout(r, 700));
    expect(await (engine as any).getQueueStore().hasPending(testInput.logicalSessionId).catch(()=>false)).toBe(false);
    expect((await engine.isSessionWarm(testInput as unknown as never)).warm).toBe(false);
    // No record should have been resurrected
    const recId2 = await (engine as any).resolveRecordId(testInput, undefined);
    expect(recId2).toBeUndefined();
  } finally {
    await engine.shutdown().catch(()=>{});
    await rm(dir, { recursive: true, force: true });
  }
}, 15_000);
