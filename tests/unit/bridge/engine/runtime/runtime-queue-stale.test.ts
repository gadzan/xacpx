import { expect, test } from "bun:test";
import { mkdtemp, writeFile, rm, mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { RuntimeEngine } from "../../../../../src/bridge/engine/runtime-engine";

const baseA = { agent: "codex", cwd: "/repo", name: "stale-sess", logicalSessionId: "stale-1", mcpCoordinatorSession: "coord-A", mcpSourceHandle: "src-A" };
const baseB = { agent: "codex", cwd: "/repo", name: "stale-sess", logicalSessionId: "stale-1", mcpCoordinatorSession: "coord-B", mcpSourceHandle: "src-B" };
const baseC = { agent: "codex", cwd: "/repo", name: "stale-sess", logicalSessionId: "stale-1", mcpCoordinatorSession: "coord-C", mcpSourceHandle: "src-C" };
async function mcpWorker(entry: string) {
  await writeFile(entry, [
    "let b=''; let coord='none';",
    "process.stdin.on('data',d=>{b+=d.toString(); let i; while((i=b.indexOf('\\n'))>=0){const l=b.slice(0,i); b=b.slice(i+1); if(!l)continue; try{const m=JSON.parse(l);",
    " if(m.method==='ensure'){ coord=m.params.mcpCoordinatorSession||'none'; process.stdout.write(JSON.stringify({id:m.id,ok:true,result:{ready:true,sessionKey:m.params.sessionKey,acpxRecordId:'rec'}})+'\\n');}",
    " else if(m.method==='prompt'){ const txt=m.params.text; const out=`coord=${coord};text=${txt}`; process.stdout.write(JSON.stringify({id:m.id,ok:true,result:{result:{status:'completed'},finalText:out}})+'\\n');}",
    " else { process.stdout.write(JSON.stringify({id:m.id,ok:true,result:{}})+'\\n'); if(m.method==='shutdown')process.exit(0);}",
    "}catch{}}});"
  ].join("\n"));
}

test("A active -> B queue -> A settle -> B drains on new worker, not old route", async () => {
  const dir = await mkdtemp(join(tmpdir(), "stale-q-"));
  const stateDir = join(dir, "state", "sessions");
  await mkdir(stateDir, { recursive: true });
  const queueDir = join(dir, "queue");
  const fenceDir = join(dir, "fences");
  const logPath = join(dir, "prompt.log");
  const entry = join(dir, "w.mjs");
  await mcpWorker(entry);
  const engine = new RuntimeEngine({ workerEntryPath: entry, permissionMode: "approve-all", stateDir, queueDir, fenceDir, idleTtlMs: 200 });

  // Start A as a long prompt (active) — use slow worker that logs each prompt
  const slowWorkerEntry = join(dir, "slow.mjs");
  await writeFile(slowWorkerEntry, [
    `let b=''; let coord='none'; let pending=null; const fs=require('node:fs'); const logPath=${JSON.stringify(logPath)};`,
    "process.stdin.on('data',d=>{b+=d.toString(); let i; while((i=b.indexOf('\\n'))>=0){const l=b.slice(0,i); b=b.slice(i+1); if(!l)continue; try{const m=JSON.parse(l);",
    " if(m.method==='ensure'){ coord=m.params.mcpCoordinatorSession||'none'; try{fs.appendFileSync(logPath, `ensure:${coord}\\n`);}catch{}; process.stdout.write(JSON.stringify({id:m.id,ok:true,result:{ready:true,sessionKey:m.params.sessionKey,acpxRecordId:'rec'}})+'\\n');}",
    " else if(m.method==='prompt'){ pending=m; setTimeout(()=>{ const out=`coord=${coord};text=${pending.params.text}`; try{fs.appendFileSync(logPath, `prompt:${out}\\n`);}catch{}; process.stdout.write(JSON.stringify({id:pending.id,ok:true,result:{result:{status:'completed'},finalText:out}})+'\\n'); pending=null; },400);}",
    " else { process.stdout.write(JSON.stringify({id:m.id,ok:true,result:{}})+'\\n'); if(m.method==='shutdown')process.exit(0);}",
    "}catch{}}});"
  ].join("\n"));
  const slowEngine = new RuntimeEngine({ workerEntryPath: slowWorkerEntry, permissionMode: "approve-all", stateDir, queueDir, fenceDir, idleTtlMs: 200 });
  const pA = slowEngine.prompt({ ...baseA, text: "A" });
  await new Promise(r => setTimeout(r, 50));
  const pidA = (slowEngine as unknown as { manager: { get: (k: string) => { ref: { pid: number } } | undefined } }).manager.get("stale-1")?.ref.pid;
  expect(pidA).toBeDefined();
  // Inject B while A active
  const receipt = await slowEngine.injectMessage({ ...baseB, text: "B", mode: "queue", messageId: "mB" });
  expect(receipt.status).toBe("queued");
  const resA = await pA;
  expect(resA.text).toBe("coord=coord-A;text=A");
  // After A settles, B should drain on new worker with coord-B
  for (let i = 0; i < 50; i++) {
    if (!(await slowEngine.getQueueStore().hasPending(baseA.logicalSessionId))) break;
    await new Promise(r => setTimeout(r, 100));
  }
  expect(await slowEngine.getQueueStore().hasPending(baseA.logicalSessionId)).toBe(false);
  const pidB = (slowEngine as unknown as { manager: { get: (k: string) => { ref: { pid: number } } | undefined } }).manager.get("stale-1")?.ref.pid;
  expect(pidB).toBeDefined();
  expect(pidB).not.toBe(pidA);
  const log = await readFile(logPath, "utf8").catch(() => "");
  expect(log).toContain("prompt:coord=coord-B;text=B");
  await slowEngine.shutdown().catch(() => {});
  await rm(dir, { recursive: true, force: true });
}, 15_000);
test("A active -> B queue -> C queue -> settle, B in coord-B, C in coord-C", async () => {
  const dir = await mkdtemp(join(tmpdir(), "stale-q2-"));
  const stateDir = join(dir, "state", "sessions");
  await mkdir(stateDir, { recursive: true });
  const queueDir = join(dir, "queue");
  const fenceDir = join(dir, "fences");
  const logPath = join(dir, "prompt.log");
  const slowWorkerEntry = join(dir, "slow2.mjs");
  await writeFile(slowWorkerEntry, [
    `let b=''; let coord='none'; let pending=null; const fs=require('node:fs'); const logPath=${JSON.stringify(logPath)};`,
    "process.stdin.on('data',d=>{b+=d.toString(); let i; while((i=b.indexOf('\\n'))>=0){const l=b.slice(0,i); b=b.slice(i+1); if(!l)continue; try{const m=JSON.parse(l);",
    " if(m.method==='ensure'){ coord=m.params.mcpCoordinatorSession||'none'; try{fs.appendFileSync(logPath, `ensure:${coord}\\n`);}catch{}; process.stdout.write(JSON.stringify({id:m.id,ok:true,result:{ready:true,sessionKey:m.params.sessionKey,acpxRecordId:'rec'}})+'\\n');}",
    " else if(m.method==='prompt'){ pending=m; setTimeout(()=>{ const out=`coord=${coord};text=${pending.params.text}`; try{fs.appendFileSync(logPath, `prompt:${out}\\n`);}catch{}; process.stdout.write(JSON.stringify({id:pending.id,ok:true,result:{result:{status:'completed'},finalText:out}})+'\\n'); pending=null; },400);}",
    " else { process.stdout.write(JSON.stringify({id:m.id,ok:true,result:{}})+'\\n'); if(m.method==='shutdown')process.exit(0);}",
    "}catch{}}});"
  ].join("\n"));
  const slowEngine = new RuntimeEngine({ workerEntryPath: slowWorkerEntry, permissionMode: "approve-all", stateDir, queueDir, fenceDir, idleTtlMs: 200 });
  const pA = slowEngine.prompt({ ...baseA, text: "A" });
  await new Promise(r => setTimeout(r, 50));
  await slowEngine.injectMessage({ ...baseB, text: "B", mode: "queue", messageId: "mB" });
  await slowEngine.injectMessage({ ...baseC, text: "C", mode: "queue", messageId: "mC" });
  const resA = await pA;
  expect(resA.text).toBe("coord=coord-A;text=A");
  for (let i = 0; i < 80; i++) {
    if (!(await slowEngine.getQueueStore().hasPending(baseA.logicalSessionId))) break;
    await new Promise(r => setTimeout(r, 100));
  }
  expect(await slowEngine.getQueueStore().hasPending(baseA.logicalSessionId)).toBe(false);
  const log = await readFile(logPath, "utf8").catch(() => "");
  expect(log).toContain("prompt:coord=coord-B;text=B");
  expect(log).toContain("prompt:coord=coord-C;text=C");
  // Ensure B and C were on different workers (at least one rotation occurred)
  const countEnsures = (log.match(/ensure:/g) || []).length;
  expect(countEnsures).toBeGreaterThanOrEqual(3);
  await slowEngine.shutdown().catch(() => {});
  await rm(dir, { recursive: true, force: true });
}, 15_000);
test("legacy v1 queue head without per-head MCP falls back to catalog MCP (not undefined)", async () => {
  const dir = await mkdtemp(join(tmpdir(), "legacy-q-"));
  const stateDir = join(dir, "state", "sessions");
  await mkdir(stateDir, { recursive: true });
  const queueDir = join(dir, "queue");
  await mkdir(queueDir, { recursive: true });
  const fenceDir = join(dir, "fences");
  const logPath = join(dir, "prompt.log");
  const workerEntry = join(dir, "w.mjs");
  await writeFile(workerEntry, [
    `let b=''; let coord='none'; const fs=require('node:fs'); const logPath=${JSON.stringify(logPath)};`,
    "process.stdin.on('data',d=>{b+=d.toString(); let i; while((i=b.indexOf('\\n'))>=0){const l=b.slice(0,i); b=b.slice(i+1); if(!l)continue; try{const m=JSON.parse(l);",
    " if(m.method==='ensure'){ coord=m.params.mcpCoordinatorSession||'none'; try{fs.appendFileSync(logPath, `ensure:${coord}\\n`);}catch{}; process.stdout.write(JSON.stringify({id:m.id,ok:true,result:{ready:true,sessionKey:m.params.sessionKey,acpxRecordId:'rec'}})+'\\n');}",
    " else if(m.method==='prompt'){ const out=`coord=${coord};text=${m.params.text}`; try{fs.appendFileSync(logPath, `prompt:${out}\\n`);}catch{}; process.stdout.write(JSON.stringify({id:m.id,ok:true,result:{result:{status:'completed'},finalText:out}})+'\\n'); }",
    " else { process.stdout.write(JSON.stringify({id:m.id,ok:true,result:{}})+'\\n'); if(m.method==='shutdown')process.exit(0);}",
    "}catch{}}});",
  ].join("\n"));
  // Write legacy v1 journal with one head that has no MCP fields
  const logicalId = "legacy-1";
  const v1 = { schema: "xacpx.runtime-queue.v1", logicalSessionId: logicalId, items: [{ messageId: "mLegacy", text: "legacyB", acceptedAt: new Date().toISOString(), mode: "queue" }] };
  await writeFile(join(queueDir, `${encodeURIComponent(logicalId)}.json`), JSON.stringify(v1, null, 2), "utf8");
  const engine = new RuntimeEngine({ workerEntryPath: workerEntry, permissionMode: "approve-all", stateDir, queueDir, fenceDir, idleTtlMs: 200 });
  // Seed catalog with the desired MCP identity (as if session was created with coord-C)
  const catalogInput = { agent: "codex", cwd: "/repo", name: "legacy-sess", logicalSessionId: logicalId, mcpCoordinatorSession: "coord-C", mcpSourceHandle: "src-C" };
  // Trigger drain — legacy head should fallback to catalog's coord-C, not 'none'
  await (engine as unknown as { kickDrain: (i: unknown) => Promise<void> }).kickDrain(catalogInput);
  // Wait for drain to complete
  for (let i = 0; i < 30; i++) {
    if (!(await engine.getQueueStore().hasPending(logicalId))) break;
    await new Promise(r => setTimeout(r, 100));
  }
  expect(await engine.getQueueStore().hasPending(logicalId)).toBe(false);
  const log = await readFile(logPath, "utf8").catch(() => "");
  // Legacy head without per-head identity should have executed with catalog's coord-C
  expect(log).toContain("prompt:coord=coord-C;text=legacyB");
  expect(log).not.toContain("prompt:coord=none;text=legacyB");
  await engine.shutdown().catch(() => {});
  await rm(dir, { recursive: true, force: true });
}, 15_000);
test("queue-only A->B->C leaves no staleAfterTurn; next direct prompt with C identity reuses worker", async () => {
  const dir = await mkdtemp(join(tmpdir(), "stale-leak-"));
  const stateDir = join(dir, "state", "sessions");
  await mkdir(stateDir, { recursive: true });
  const queueDir = join(dir, "queue");
  const fenceDir = join(dir, "fences");
  const logPath = join(dir, "prompt.log");
  const workerEntry = join(dir, "w.mjs");
  await writeFile(workerEntry, [
    `let b=''; let coord='none'; const fs=require('node:fs'); const logPath=${JSON.stringify(logPath)};`,
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
  for (let i = 0; i < 80; i++) {
    if (!(await engine.getQueueStore().hasPending("leak-1"))) break;
    await new Promise(r => setTimeout(r, 100));
  }
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
}, 20_000);
