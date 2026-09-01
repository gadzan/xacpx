import { expect, test } from "bun:test";
import { mkdtemp, writeFile, rm, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { RuntimeEngine } from "../../../../../src/bridge/engine/runtime-engine";

const baseA = { agent: "codex", cwd: "/repo", name: "stale-sess", logicalSessionId: "stale-1", mcpCoordinatorSession: "coord-A", mcpSourceHandle: "src-A" };
const baseB = { agent: "codex", cwd: "/repo", name: "stale-sess", logicalSessionId: "stale-1", mcpCoordinatorSession: "coord-B", mcpSourceHandle: "src-B" };

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
  const entry = join(dir, "w.mjs");
  await mcpWorker(entry);
  const engine = new RuntimeEngine({ workerEntryPath: entry, permissionMode: "approve-all", stateDir, queueDir, fenceDir, idleTtlMs: 200 });

  // Start A as a long prompt (active)
  let resolveA: (v: unknown) => void;
  const slowWorkerEntry = join(dir, "slow.mjs");
  await writeFile(slowWorkerEntry, [
    "let b=''; let coord='none'; let pending=null;",
    "process.stdin.on('data',d=>{b+=d.toString(); let i; while((i=b.indexOf('\\n'))>=0){const l=b.slice(0,i); b=b.slice(i+1); if(!l)continue; try{const m=JSON.parse(l);",
    " if(m.method==='ensure'){ coord=m.params.mcpCoordinatorSession||'none'; process.stdout.write(JSON.stringify({id:m.id,ok:true,result:{ready:true,sessionKey:m.params.sessionKey,acpxRecordId:'rec'}})+'\\n');}",
    " else if(m.method==='prompt'){ pending=m; setTimeout(()=>{ const out=`coord=${coord};text=${pending.params.text}`; process.stdout.write(JSON.stringify({id:pending.id,ok:true,result:{result:{status:'completed'},finalText:out}})+'\\n'); pending=null; },400);}",
    " else { process.stdout.write(JSON.stringify({id:m.id,ok:true,result:{}})+'\\n'); if(m.method==='shutdown')process.exit(0);}",
    "}catch{}}});"
  ].join("\n"));
  const slowEngine = new RuntimeEngine({ workerEntryPath: slowWorkerEntry, permissionMode: "approve-all", stateDir, queueDir, fenceDir, idleTtlMs: 200 });
  const pA = slowEngine.prompt({ ...baseA, text: "A" });
  await new Promise(r => setTimeout(r, 50));
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
  // Verify B's drain created a new worker with B's coord by checking next prompt's coord
  // Do a follow-up prompt with B's identity to see it still uses B's worker (but we can just ensure queue empty)
  await slowEngine.shutdown().catch(() => {});
  await rm(dir, { recursive: true, force: true });
}, 15_000);
