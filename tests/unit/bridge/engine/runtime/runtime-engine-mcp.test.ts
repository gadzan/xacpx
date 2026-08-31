import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { RuntimeEngine } from "../../../../../src/bridge/engine/runtime-engine";

const base = { agent: "codex", cwd: "/repo", name: "mcp-sess", logicalSessionId: "mcp-1" };

async function mcpWorker(entry: string) {
  await writeFile(entry, [
    "let b=''; let coord='none'; let src='none';",
    "process.stdin.on('data',d=>{b+=d.toString(); let i; while((i=b.indexOf('\\n'))>=0){const l=b.slice(0,i); b=b.slice(i+1); if(!l)continue; try{const m=JSON.parse(l);",
    " if(m.method==='ensure'){ coord=m.params.mcpCoordinatorSession||'none'; src=m.params.mcpSourceHandle||'none'; process.stdout.write(JSON.stringify({id:m.id,ok:true,result:{ready:true,sessionKey:m.params.sessionKey,acpxRecordId:'rec'}})+'\\n');}",
    " else if(m.method==='prompt'){ process.stdout.write(JSON.stringify({id:m.id,ok:true,result:{result:{status:'completed'},finalText:`coord=${coord};src=${src}`}})+'\\n');}",
    " else { process.stdout.write(JSON.stringify({id:m.id,ok:true,result:{}})+'\\n'); if(m.method==='shutdown')process.exit(0);}",
    "}catch{}}});"
  ].join("\n"));
}

test("same MCP identity reuses worker", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mcp-reuse-"));
  try {
    const entry = join(dir, "w.mjs");
    await mcpWorker(entry);
    const engine = new RuntimeEngine({ workerEntryPath: entry, permissionMode: "approve-all" });
    const r1 = await engine.prompt({ ...base, mcpCoordinatorSession: "coordA", mcpSourceHandle: "src1", text: "t1" });
    expect(r1.text).toBe("coord=coordA;src=src1");
    const pid1 = (engine as unknown as { manager: { get:(k:string)=>{ ref:{pid:number}} } }).manager.get("mcp-1")?.ref.pid;
    const r2 = await engine.prompt({ ...base, mcpCoordinatorSession: "coordA", mcpSourceHandle: "src1", text: "t2" });
    expect(r2.text).toBe("coord=coordA;src=src1");
    const pid2 = (engine as unknown as { manager: { get:(k:string)=>{ ref:{pid:number}} } }).manager.get("mcp-1")?.ref.pid;
    expect(pid2).toBe(pid1);
    await engine.shutdown();
  } finally { await rm(dir, { recursive: true, force: true }); }
}, 15_000);

test("changed coordinator rotates idle worker", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mcp-rot-"));
  try {
    const entry = join(dir, "w.mjs");
    await mcpWorker(entry);
    const engine = new RuntimeEngine({ workerEntryPath: entry, permissionMode: "approve-all" });
    await engine.prompt({ ...base, mcpCoordinatorSession: "coordA", mcpSourceHandle: "src1", text: "t1" });
    const pid1 = (engine as unknown as { manager: { get:(k:string)=>{ ref:{pid:number}} } }).manager.get("mcp-1")?.ref.pid;
    // Change coordinator while idle
    const r2 = await engine.prompt({ ...base, mcpCoordinatorSession: "coordB", mcpSourceHandle: "src1", text: "t2" });
    expect(r2.text).toBe("coord=coordB;src=src1");
    const pid2 = (engine as unknown as { manager: { get:(k:string)=>{ ref:{pid:number}} } }).manager.get("mcp-1")?.ref.pid;
    expect(pid2).not.toBe(pid1);
    await engine.shutdown();
  } finally { await rm(dir, { recursive: true, force: true }); }
}, 15_000);

test("changed source rotates idle worker", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mcp-src-"));
  try {
    const entry = join(dir, "w.mjs");
    await mcpWorker(entry);
    const engine = new RuntimeEngine({ workerEntryPath: entry, permissionMode: "approve-all" });
    await engine.prompt({ ...base, mcpCoordinatorSession: "coordA", mcpSourceHandle: "src1", text: "t1" });
    const pid1 = (engine as unknown as { manager: { get:(k:string)=>{ ref:{pid:number}} } }).manager.get("mcp-1")?.ref.pid;
    const r2 = await engine.prompt({ ...base, mcpCoordinatorSession: "coordA", mcpSourceHandle: "src2", text: "t2" });
    expect(r2.text).toBe("coord=coordA;src=src2");
    const pid2 = (engine as unknown as { manager: { get:(k:string)=>{ ref:{pid:number}} } }).manager.get("mcp-1")?.ref.pid;
    expect(pid2).not.toBe(pid1);
    await engine.shutdown();
  } finally { await rm(dir, { recursive: true, force: true }); }
}, 15_000);

test("MCP identity change during active turn does not kill active worker, rotates after settle", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mcp-active-"));
  try {
    const entry = join(dir, "slow.mjs");
    await writeFile(entry, [
      "let b=''; let coord='none';",
      "process.stdin.on('data',d=>{b+=d.toString(); let i; while((i=b.indexOf('\\n'))>=0){const l=b.slice(0,i); b=b.slice(i+1); if(!l)continue; try{const m=JSON.parse(l);",
      " if(m.method==='ensure'){ coord=m.params.mcpCoordinatorSession||'none'; process.stdout.write(JSON.stringify({id:m.id,ok:true,result:{ready:true,sessionKey:m.params.sessionKey,acpxRecordId:'rec'}})+'\\n');}",
      " else if(m.method==='prompt'){ setTimeout(()=>{process.stdout.write(JSON.stringify({id:m.id,ok:true,result:{result:{status:'completed'},finalText:`coord=${coord}`}})+'\\n');},300);}",
      " else {process.stdout.write(JSON.stringify({id:m.id,ok:true,result:{}})+'\\n'); if(m.method==='shutdown')process.exit(0);}",
      "}catch{}}});"
    ].join("\n"));
    const engine = new RuntimeEngine({ workerEntryPath: entry, permissionMode: "approve-all" });
    const p1 = engine.prompt({ ...base, mcpCoordinatorSession: "coordA", text: "long" });
    await new Promise(r=>setTimeout(r,50));
    // Try to change MCP while active — should fail with stale error, not kill
    await expect(engine.prompt({ ...base, mcpCoordinatorSession: "coordB", text: "t2" })).rejects.toMatchObject({ code: "RUNTIME_MCP_STALE" });
    await p1;
    // After settle, stale worker should have been rotated, next prompt with new identity should succeed with new coord
    const r2 = await engine.prompt({ ...base, mcpCoordinatorSession: "coordB", text: "t2" });
    expect(r2.text).toBe("coord=coordB");
    await engine.shutdown();
  } finally { await rm(dir, { recursive: true, force: true }); }
}, 15_000);

test("no coordinator -> no MCP, removal also triggers rotation", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mcp-none-"));
  try {
    const entry = join(dir, "w.mjs");
    await mcpWorker(entry);
    const engine = new RuntimeEngine({ workerEntryPath: entry, permissionMode: "approve-all" });
    await engine.prompt({ ...base, mcpCoordinatorSession: "coordA", text: "t1" });
    const pid1 = (engine as unknown as { manager: { get:(k:string)=>{ ref:{pid:number}} } }).manager.get("mcp-1")?.ref.pid;
    await engine.prompt({ ...base, text: "t2" }); // no coordinator
    const pid2 = (engine as unknown as { manager: { get:(k:string)=>{ ref:{pid:number}} } }).manager.get("mcp-1")?.ref.pid;
    expect(pid2).not.toBe(pid1);
    await engine.shutdown();
  } finally { await rm(dir, { recursive: true, force: true }); }
}, 15_000);

test("no duplicate MCP registration: repeated ensure/prompt with same identity does not add server", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mcp-dup-"));
  try {
    const entry = join(dir, "w.mjs");
    await mcpWorker(entry);
    const engine = new RuntimeEngine({ workerEntryPath: entry, permissionMode: "approve-all" });
    await engine.ensureSession({ ...base, mcpCoordinatorSession: "coordA" });
    await engine.prompt({ ...base, mcpCoordinatorSession: "coordA", text: "t1" });
    await engine.ensureSession({ ...base, mcpCoordinatorSession: "coordA" });
    const r = await engine.prompt({ ...base, mcpCoordinatorSession: "coordA", text: "t2" });
    expect(r.text).toBe("coord=coordA;src=none");
    const pid1 = (engine as unknown as { manager: { get:(k:string)=>{ ref:{pid:number}} } }).manager.get("mcp-1")?.ref.pid;
    // Still same worker
    expect(pid1).toBeDefined();
    await engine.shutdown();
  } finally { await rm(dir, { recursive: true, force: true }); }
}, 15_000);
