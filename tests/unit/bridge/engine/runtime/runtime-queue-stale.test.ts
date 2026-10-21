import { expect, test } from "bun:test";
import { mkdtemp, writeFile, rm, mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { RuntimeEngine } from "../../../../../src/bridge/engine/runtime-engine";
import type { RuntimeWorkerClient } from "../../../../../src/bridge/engine/runtime/runtime-worker-client";

// Real Windows admission costs two PowerShell spawn-units (supervisor probe
// and Job attestation, measured 2-5s each under load); every wait below is
// event-driven, the deadline only bounds a genuine hang.
async function waitUntil(predicate: () => boolean | Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 90_000;
  while (!(await predicate())) {
    if (Date.now() >= deadline) throw new Error("queue lifecycle condition did not converge");
    const next = Promise.withResolvers<void>();
    setImmediate(next.resolve);
    await next.promise;
  }
}

const baseA = { agent: "codex", cwd: "/repo", name: "stale-sess", logicalSessionId: "stale-1", mcpCoordinatorSession: "coord-A", mcpSourceHandle: "src-A" };
const baseB = { agent: "codex", cwd: "/repo", name: "stale-sess", logicalSessionId: "stale-1", mcpCoordinatorSession: "coord-B", mcpSourceHandle: "src-B" };
const baseC = { agent: "codex", cwd: "/repo", name: "stale-sess", logicalSessionId: "stale-1", mcpCoordinatorSession: "coord-C", mcpSourceHandle: "src-C" };

test("A active -> B queue -> A settle -> B drains on new worker, not old route", async () => {
  const dir = await mkdtemp(join(tmpdir(), "stale-q-"));
  const stateDir = join(dir, "state", "sessions");
  await mkdir(stateDir, { recursive: true });
  const queueDir = join(dir, "queue");
  const fenceDir = join(dir, "fences");
  const logPath = join(dir, "prompt.log");

  // Start A as a long prompt (active) — use slow worker that logs each prompt
  const slowWorkerEntry = join(dir, "slow.mjs");
  await writeFile(slowWorkerEntry, [
    `import * as fs from 'node:fs'; let b=''; let coord='none'; let pending=null; const logPath=${JSON.stringify(logPath)};`,
    "process.stdin.on('data',d=>{b+=d.toString(); let i; while((i=b.indexOf('\\n'))>=0){const l=b.slice(0,i); b=b.slice(i+1); if(!l)continue; try{const m=JSON.parse(l);",
    " if(m.method==='ensure'){ coord=m.params.mcpCoordinatorSession||'none'; try{fs.appendFileSync(logPath, `ensure:${coord}\\n`);}catch{}; process.stdout.write(JSON.stringify({id:m.id,ok:true,result:{ready:true,sessionKey:m.params.sessionKey,acpxRecordId:'rec'}})+'\\n');}",
    " else if(m.method==='prompt'){ if(m.params.text==='A'){pending=m; fs.appendFileSync(logPath, 'active:A\\n'); continue;} const out=`coord=${coord};text=${m.params.text}`; fs.appendFileSync(logPath, `prompt:${out}\\n`); process.stdout.write(JSON.stringify({id:m.id,ok:true,result:{result:{status:'completed'},finalText:out}})+'\\n');}",
    " else if(m.method==='cancel'){ if(pending){const out=`coord=${coord};text=${pending.params.text}`; fs.appendFileSync(logPath, `prompt:${out}\\n`); process.stdout.write(JSON.stringify({id:pending.id,ok:true,result:{result:{status:'completed'},finalText:out}})+'\\n'); pending=null;} process.stdout.write(JSON.stringify({id:m.id,ok:true,result:{}})+'\\n');}",
    " else { process.stdout.write(JSON.stringify({id:m.id,ok:true,result:{}})+'\\n'); if(m.method==='shutdown')process.exit(0);}",
    "}catch{}}});"
  ].join("\n"));
  const slowEngine = new RuntimeEngine({ workerEntryPath: slowWorkerEntry, permissionMode: "approve-all", stateDir, queueDir, fenceDir, idleTtlMs: 200 });
  const pA = slowEngine.prompt({ ...baseA, text: "A" });
  const workerOf = (lid: string): RuntimeWorkerClient | undefined => slowEngine["manager"]!.get(lid);
  await waitUntil(async () => {
    const worker = workerOf("stale-1");
    const log = await readFile(logPath, "utf8").catch(() => "");
    return worker?.lifecycle === "busy" && worker.ref.pid > 0 && log.includes("active:A");
  });
  expect(workerOf("stale-1")!.lifecycle).toBe("busy");
  const pidA = workerOf("stale-1")?.ref.pid;
  // Inject B while A active
  const receipt = await slowEngine.injectMessage({ ...baseB, text: "B", mode: "queue", messageId: "mB" });
  expect(receipt.status).toBe("queued");
  await workerOf("stale-1")!.request("cancel", {});
  const resA = await pA;
  expect(resA.text).toBe("coord=coord-A;text=A");
  // After A settles, B should drain on new worker with coord-B
  await waitUntil(async () => !(await slowEngine.getQueueStore().hasPending(baseA.logicalSessionId)));
  expect(await slowEngine.getQueueStore().hasPending(baseA.logicalSessionId)).toBe(false);
  const pidB = workerOf("stale-1")?.ref.pid;
  expect(pidB).toBeGreaterThan(0);
  expect(pidB).not.toBe(pidA);
  const log = await readFile(logPath, "utf8").catch(() => "");
  expect(log).toContain("prompt:coord=coord-B;text=B");
  await slowEngine.shutdown().catch(() => {});
  await rm(dir, { recursive: true, force: true });
}, 120_000);
test("A active -> B queue -> C queue -> settle, B in coord-B, C in coord-C", async () => {
  const dir = await mkdtemp(join(tmpdir(), "stale-q2-"));
  const stateDir = join(dir, "state", "sessions");
  await mkdir(stateDir, { recursive: true });
  const queueDir = join(dir, "queue");
  const fenceDir = join(dir, "fences");
  const logPath = join(dir, "prompt.log");
  const slowWorkerEntry = join(dir, "slow2.mjs");
  await writeFile(slowWorkerEntry, [
    `import * as fs from 'node:fs'; let b=''; let coord='none'; let pending=null; const logPath=${JSON.stringify(logPath)};`,
    "process.stdin.on('data',d=>{b+=d.toString(); let i; while((i=b.indexOf('\\n'))>=0){const l=b.slice(0,i); b=b.slice(i+1); if(!l)continue; try{const m=JSON.parse(l);",
    " if(m.method==='ensure'){ coord=m.params.mcpCoordinatorSession||'none'; try{fs.appendFileSync(logPath, `ensure:${coord}\\n`);}catch{}; process.stdout.write(JSON.stringify({id:m.id,ok:true,result:{ready:true,sessionKey:m.params.sessionKey,acpxRecordId:'rec'}})+'\\n');}",
    " else if(m.method==='prompt'){ if(m.params.text==='A'){pending=m; fs.appendFileSync(logPath, 'active:A\\n'); continue;} const out=`coord=${coord};text=${m.params.text}`; fs.appendFileSync(logPath, `prompt:${out}\\n`); process.stdout.write(JSON.stringify({id:m.id,ok:true,result:{result:{status:'completed'},finalText:out}})+'\\n');}",
    " else if(m.method==='cancel'){ if(pending){const out=`coord=${coord};text=${pending.params.text}`; fs.appendFileSync(logPath, `prompt:${out}\\n`); process.stdout.write(JSON.stringify({id:pending.id,ok:true,result:{result:{status:'completed'},finalText:out}})+'\\n'); pending=null;} process.stdout.write(JSON.stringify({id:m.id,ok:true,result:{}})+'\\n');}",
    " else { process.stdout.write(JSON.stringify({id:m.id,ok:true,result:{}})+'\\n'); if(m.method==='shutdown')process.exit(0);}",
    "}catch{}}});"
  ].join("\n"));
  const slowEngine = new RuntimeEngine({ workerEntryPath: slowWorkerEntry, permissionMode: "approve-all", stateDir, queueDir, fenceDir, idleTtlMs: 200 });
  const pA = slowEngine.prompt({ ...baseA, text: "A" });
  const workerOf = (lid: string): RuntimeWorkerClient | undefined => slowEngine["manager"]!.get(lid);
  await waitUntil(async () => {
    const worker = workerOf("stale-1");
    const log = await readFile(logPath, "utf8").catch(() => "");
    return worker?.lifecycle === "busy" && worker.ref.pid > 0 && log.includes("active:A");
  });
  expect(workerOf("stale-1")!.lifecycle).toBe("busy");
  await slowEngine.injectMessage({ ...baseB, text: "B", mode: "queue", messageId: "mB" });
  await slowEngine.injectMessage({ ...baseC, text: "C", mode: "queue", messageId: "mC" });
  await workerOf("stale-1")!.request("cancel", {});
  const resA = await pA;
  expect(resA.text).toBe("coord=coord-A;text=A");
  await waitUntil(async () => !(await slowEngine.getQueueStore().hasPending(baseA.logicalSessionId)));
  expect(await slowEngine.getQueueStore().hasPending(baseA.logicalSessionId)).toBe(false);
  const log = await readFile(logPath, "utf8").catch(() => "");
  expect(log).toContain("prompt:coord=coord-B;text=B");
  expect(log).toContain("prompt:coord=coord-C;text=C");
  // Ensure B and C were on different workers (at least one rotation occurred)
  const countEnsures = (log.match(/ensure:/g) || []).length;
  expect(countEnsures).toBeGreaterThanOrEqual(3);
  await slowEngine.shutdown().catch(() => {});
  await rm(dir, { recursive: true, force: true });
}, 120_000);
test("legacy v1 queue head without per-head MCP fails closed (identity unknown, not fallback)", async () => {
  const dir = await mkdtemp(join(tmpdir(), "legacy-q-"));
  const stateDir = join(dir, "state", "sessions");
  await mkdir(stateDir, { recursive: true });
  const queueDir = join(dir, "queue");
  await mkdir(queueDir, { recursive: true });
  const fenceDir = join(dir, "fences");
  const logPath = join(dir, "prompt.log");
  const workerEntry = join(dir, "w.mjs");
  await writeFile(workerEntry, [
    `import * as fs from 'node:fs'; let b=''; let coord='none'; const logPath=${JSON.stringify(logPath)};`,
    "process.stdin.on('data',d=>{b+=d.toString(); let i; while((i=b.indexOf('\\n'))>=0){const l=b.slice(0,i); b=b.slice(i+1); if(!l)continue; try{const m=JSON.parse(l);",
    " if(m.method==='ensure'){ coord=m.params.mcpCoordinatorSession||'none'; try{fs.appendFileSync(logPath, `ensure:${coord}\\n`);}catch{}; process.stdout.write(JSON.stringify({id:m.id,ok:true,result:{ready:true,sessionKey:m.params.sessionKey,acpxRecordId:'rec'}})+'\\n');}",
    " else if(m.method==='prompt'){ const out=`coord=${coord};text=${m.params.text}`; try{fs.appendFileSync(logPath, `prompt:${out}\\n`);}catch{}; process.stdout.write(JSON.stringify({id:m.id,ok:true,result:{result:{status:'completed'},finalText:out}})+'\\n'); }",
    " else { process.stdout.write(JSON.stringify({id:m.id,ok:true,result:{}})+'\\n'); if(m.method==='shutdown')process.exit(0);}",
    "}catch{}}});",
  ].join("\n"));
  // Write legacy v1 journal with one head that has no per-head fields (identity-unknown)
  const logicalId = "legacy-1";
  const v1 = { schema: "xacpx.runtime-queue.v1", logicalSessionId: logicalId, items: [{ messageId: "mLegacy", text: "legacyB", acceptedAt: new Date().toISOString(), mode: "queue" }] };
  await writeFile(join(queueDir, `${encodeURIComponent(logicalId)}.json`), JSON.stringify(v1, null, 2), "utf8");
  const engine = new RuntimeEngine({ workerEntryPath: workerEntry, permissionMode: "approve-all", stateDir, queueDir, fenceDir, idleTtlMs: 200 });
  // Seed catalog with coordinator C — legacy must NOT fallback to it, nor execute as none
  const catalogInput = { agent: "codex", cwd: "/repo", name: "legacy-sess", logicalSessionId: logicalId, mcpCoordinatorSession: "coord-C", mcpSourceHandle: "src-C" };
  // Trigger drain — must fail closed, keep head
  await (engine as unknown as { kickDrain: (i: unknown) => Promise<void> }).kickDrain(catalogInput).catch(() => {});
  expect(await engine.getQueueStore().hasPending(logicalId)).toBe(true);
  const log = await readFile(logPath, "utf8").catch(() => "");
  expect(log).not.toContain("legacyB");
  expect(log).not.toContain("prompt:coord");
  const rec = await engine.getQueueStore().load(logicalId);
  expect(rec?.schema).toBe("xacpx.runtime-queue.v1");
  await engine.shutdown().catch(() => {});
  await rm(dir, { recursive: true, force: true });
}, 120_000);
test("upgraded v1->v2 record still fail-closes legacy first head, B not executed as none", async () => {
  const dir = await mkdtemp(join(tmpdir(), "legacy-up-"));
  const stateDir = join(dir, "state", "sessions");
  await mkdir(stateDir, { recursive: true });
  const queueDir = join(dir, "queue");
  await mkdir(queueDir, { recursive: true });
  const fenceDir = join(dir, "fences");
  const logPath = join(dir, "prompt.log");
  const workerEntry = join(dir, "w.mjs");
  await writeFile(workerEntry, [
    `import * as fs from 'node:fs'; let b=''; let coord='none'; const logPath=${JSON.stringify(logPath)};`,
    "process.stdin.on('data',d=>{b+=d.toString(); let i; while((i=b.indexOf('\\n'))>=0){const l=b.slice(0,i); b=b.slice(i+1); if(!l)continue; try{const m=JSON.parse(l);",
    " if(m.method==='ensure'){ coord=m.params.mcpCoordinatorSession||'none'; try{fs.appendFileSync(logPath, `ensure:${coord}\\n`);}catch{}; process.stdout.write(JSON.stringify({id:m.id,ok:true,result:{ready:true,sessionKey:m.params.sessionKey,acpxRecordId:'rec'}})+'\\n');}",
    " else if(m.method==='prompt'){ const out=`coord=${coord};text=${m.params.text}`; try{fs.appendFileSync(logPath, `prompt:${out}\\n`);}catch{}; process.stdout.write(JSON.stringify({id:m.id,ok:true,result:{result:{status:'completed'},finalText:out}})+'\\n'); }",
    " else { process.stdout.write(JSON.stringify({id:m.id,ok:true,result:{}})+'\\n'); if(m.method==='shutdown')process.exit(0);}",
    "}catch{}}});",
  ].join("\n"));
  const logicalId = "legacy-up-1";
  const v1 = { schema: "xacpx.runtime-queue.v1", logicalSessionId: logicalId, items: [{ messageId: "mLegacy", text: "legacyA", acceptedAt: new Date().toISOString(), mode: "queue" }] };
  await writeFile(join(queueDir, `${encodeURIComponent(logicalId)}.json`), JSON.stringify(v1, null, 2), "utf8");
  const engine = new RuntimeEngine({ workerEntryPath: workerEntry, permissionMode: "approve-all", stateDir, queueDir, fenceDir, idleTtlMs: 200 });
  // Enqueue B via engine (will bump record to v2 but keep legacy head without mcpIdentityKnown)
  await engine.injectMessage({ agent: "codex", cwd: "/repo", name: "up-sess", logicalSessionId: logicalId, mcpCoordinatorSession: "coord-B", mcpSourceHandle: "src-B", text: "B", mode: "queue", messageId: "mB" });
  const recAfterEnqueue = await engine.getQueueStore().load(logicalId);
  expect(recAfterEnqueue?.schema).toBe("xacpx.runtime-queue.v2");
  expect(recAfterEnqueue?.items.length).toBe(2);
  expect(recAfterEnqueue?.items[0].mcpIdentityKnown).toBeUndefined();
  expect(recAfterEnqueue?.items[1].mcpIdentityKnown).toBe(true);
  // Try to drain — first head is legacy unknown, must fail closed, B must NOT be executed
  const catalogInput = { agent: "codex", cwd: "/repo", name: "up-sess", logicalSessionId: logicalId, mcpCoordinatorSession: "coord-B", mcpSourceHandle: "src-B" };
  await (engine as unknown as { kickDrain: (i: unknown) => Promise<void> }).kickDrain(catalogInput).catch(() => {});
  expect(await engine.getQueueStore().hasPending(logicalId)).toBe(true);
  const recStill = await engine.getQueueStore().load(logicalId);
  expect(recStill?.items[0].messageId).toBe("mLegacy");
  const log = await readFile(logPath, "utf8").catch(() => "");
  expect(log).not.toContain("legacyA");
  expect(log).not.toContain("prompt:coord=coord-B;text=B");
  await engine.shutdown().catch(() => {});
  await rm(dir, { recursive: true, force: true });
}, 120_000);
test("queue-only A->B->C leaves no staleAfterTurn; next direct prompt with C identity reuses worker", async () => {
  const dir = await mkdtemp(join(tmpdir(), "stale-leak-"));
  const stateDir = join(dir, "state", "sessions");
  await mkdir(stateDir, { recursive: true });
  const queueDir = join(dir, "queue");
  const fenceDir = join(dir, "fences");
  const logPath = join(dir, "prompt.log");
  const workerEntry = join(dir, "w.mjs");
  await writeFile(workerEntry, [
    `import * as fs from 'node:fs'; let b=''; let coord='none'; const logPath=${JSON.stringify(logPath)};`,
    "process.stdin.on('data',d=>{b+=d.toString(); let i; while((i=b.indexOf('\\n'))>=0){const l=b.slice(0,i); b=b.slice(i+1); if(!l)continue; try{const m=JSON.parse(l);",
    " if(m.method==='ensure'){ coord=m.params.mcpCoordinatorSession||'none'; try{fs.appendFileSync(logPath, `ensure:${coord}\\n`);}catch{}; process.stdout.write(JSON.stringify({id:m.id,ok:true,result:{ready:true,sessionKey:m.params.sessionKey,acpxRecordId:'rec'}})+'\\n');}",
    " else if(m.method==='prompt'){ const out=`coord=${coord};text=${m.params.text}`; try{fs.appendFileSync(logPath, `prompt:${out}\\n`);}catch{}; process.stdout.write(JSON.stringify({id:m.id,ok:true,result:{result:{status:'completed'},finalText:out}})+'\\n'); }",
    " else { process.stdout.write(JSON.stringify({id:m.id,ok:true,result:{}})+'\\n'); if(m.method==='shutdown')process.exit(0);}",
    "}catch{}}});",
  ].join("\n"));
  const engine = new RuntimeEngine({ workerEntryPath: workerEntry, permissionMode: "approve-all", stateDir, queueDir, fenceDir, idleTtlMs: 5000 });
  // queue-only: directly enqueue A,B,C without active prompt
  await engine.injectMessage({ agent: "codex", cwd: "/repo", name: "leak-sess", logicalSessionId: "leak-1", mcpCoordinatorSession: "coord-A", mcpSourceHandle: "src-A", text: "A", mode: "queue", messageId: "mA" });
  await engine.injectMessage({ agent: "codex", cwd: "/repo", name: "leak-sess", logicalSessionId: "leak-1", mcpCoordinatorSession: "coord-B", mcpSourceHandle: "src-B", text: "B", mode: "queue", messageId: "mB" });
  await engine.injectMessage({ agent: "codex", cwd: "/repo", name: "leak-sess", logicalSessionId: "leak-1", mcpCoordinatorSession: "coord-C", mcpSourceHandle: "src-C", text: "C", mode: "queue", messageId: "mC" });
  await waitUntil(async () => !(await engine.getQueueStore().hasPending("leak-1")));
  expect(await engine.getQueueStore().hasPending("leak-1")).toBe(false);
  const logBefore = await readFile(logPath, "utf8").catch(() => "");
  expect(logBefore).toContain("prompt:coord=coord-A;text=A");
  expect(logBefore).toContain("prompt:coord=coord-B;text=B");
  expect(logBefore).toContain("prompt:coord=coord-C;text=C");
  const ensuresBefore = (logBefore.match(/ensure:/g) || []).length;
  // staleAfterTurn should have been cleared after queue drains
  const staleSet = (engine as unknown as { staleAfterTurn: Set<string> }).staleAfterTurn;
  expect(staleSet.has("leak-1")).toBe(false);
  // Next direct prompt with same identity C should reuse the worker (no extra ensure)
  const pidBefore = (engine as unknown as { manager: { get: (k: string) => { ref: { pid: number } } | undefined } }).manager.get("leak-1")?.ref.pid;
  const res = await engine.prompt({ agent: "codex", cwd: "/repo", name: "leak-sess", logicalSessionId: "leak-1", mcpCoordinatorSession: "coord-C", mcpSourceHandle: "src-C", text: "D" });
  expect(res.text).toContain("coord=coord-C;text=D");
  const pidAfter = (engine as unknown as { manager: { get: (k: string) => { ref: { pid: number } } | undefined } }).manager.get("leak-1")?.ref.pid;
  expect(pidAfter).toBe(pidBefore);
  const logAfter = await readFile(logPath, "utf8").catch(() => "");
  const ensuresAfter = (logAfter.match(/ensure:/g) || []).length;
  expect(ensuresAfter).toBe(ensuresBefore + 1);
  await engine.shutdown().catch(() => {});
  await rm(dir, { recursive: true, force: true });
}, 120_000);
test("long setMode A -> inject B with TTL=0 still drains B after setMode settles", async () => {
  const dir = await mkdtemp(join(tmpdir(), "stale-setmode-"));
  const stateDir = join(dir, "state", "sessions");
  await mkdir(stateDir, { recursive: true });
  const queueDir = join(dir, "queue");
  const fenceDir = join(dir, "fences");
  const logPath = join(dir, "prompt.log");
  const workerEntry = join(dir, "w.mjs");
  await writeFile(workerEntry, [
    `import * as fs from 'node:fs'; let b=''; let coord='none'; let pending=null; const logPath=${JSON.stringify(logPath)};`,
    "process.stdin.on('data',d=>{b+=d.toString(); let i; while((i=b.indexOf('\\n'))>=0){const l=b.slice(0,i); b=b.slice(i+1); if(!l)continue; try{const m=JSON.parse(l);",
    " if(m.method==='ensure'){ coord=m.params.mcpCoordinatorSession||'none'; try{fs.appendFileSync(logPath, `ensure:${coord}\\n`);}catch{}; process.stdout.write(JSON.stringify({id:m.id,ok:true,result:{ready:true,sessionKey:m.params.sessionKey,acpxRecordId:'rec'}})+'\\n');}",
    " else if(m.method==='setMode'){ pending=m; fs.appendFileSync(logPath, `setMode:${coord}\\n`); }",
    " else if(m.method==='cancel'){ process.stdout.write(JSON.stringify({id:pending.id,ok:true,result:{}})+'\\n'); pending=null; process.stdout.write(JSON.stringify({id:m.id,ok:true,result:{}})+'\\n');}",
    " else if(m.method==='prompt'){ const out=`coord=${coord};text=${m.params.text}`; try{fs.appendFileSync(logPath, `prompt:${out}\\n`);}catch{}; process.stdout.write(JSON.stringify({id:m.id,ok:true,result:{result:{status:'completed'},finalText:out}})+'\\n'); }",
    " else { process.stdout.write(JSON.stringify({id:m.id,ok:true,result:{}})+'\\n'); if(m.method==='shutdown')process.exit(0);}",
    "}catch{}}});",
  ].join("\n"));
  const engine = new RuntimeEngine({ workerEntryPath: workerEntry, permissionMode: "approve-all", stateDir, queueDir, fenceDir, idleTtlMs: 0 });
  const sessA = { agent: "codex", cwd: "/repo", name: "stale-setmode", logicalSessionId: "stale-setmode-1", mcpCoordinatorSession: "coord-A", mcpSourceHandle: "src-A" };
  const sessB = { agent: "codex", cwd: "/repo", name: "stale-setmode", logicalSessionId: "stale-setmode-1", mcpCoordinatorSession: "coord-B", mcpSourceHandle: "src-B" };
  const setModeP = engine.setMode({ ...sessA, modeId: "ask" });
  await waitUntil(async () => {
    const worker = engine["manager"]!.get(sessA.logicalSessionId);
    const log = await readFile(logPath, "utf8").catch(() => "");
    return worker?.hasBusinessInFlight === true && worker.ref.pid > 0 && log.includes("setMode:coord-A");
  });
  const receipt = await engine.injectMessage({ ...sessB, text: "B", mode: "queue", messageId: "mB" });
  expect(receipt.status).toBe("queued");
  await engine["manager"]!.get(sessA.logicalSessionId)!.request("cancel", {});
  await setModeP;
  await waitUntil(async () => !(await engine.getQueueStore().hasPending("stale-setmode-1")));
  expect(await engine.getQueueStore().hasPending("stale-setmode-1")).toBe(false);
  const log = await readFile(logPath, "utf8").catch(() => "");
  expect(log).toContain("prompt:coord=coord-B;text=B");
  const ensures = (log.match(/ensure:/g) || []).length;
  expect(ensures).toBeGreaterThanOrEqual(2);
  await engine.shutdown().catch(() => {});
  await rm(dir, { recursive: true, force: true });
}, 120_000);
