import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { RuntimeEngine } from "../../../../../src/bridge/engine/runtime-engine";

const base = { agent: "codex", cwd: "/repo", name: "live-perm", logicalSessionId: "live-perm-1" };

async function echoWorker(entry: string, opts?: { failPermissionUpdate?: boolean; failAfter?: number }) {
  await writeFile(
    entry,
    [
      "let buffer=''; let mode='approve-all'; let gen=0; let failCount=0;",
      "process.stdin.on('data',(d)=>{buffer+=d.toString(); let idx; while((idx=buffer.indexOf('\\n'))>=0){ const line=buffer.slice(0,idx); buffer=buffer.slice(idx+1); if(!line)continue; try{const msg=JSON.parse(line);",
      " if(msg.method==='ensure'){ mode=msg.params.permissionMode||mode; gen=msg.params.permissionGeneration||0; process.stdout.write(JSON.stringify({id:msg.id,ok:true,result:{ready:true,sessionKey:msg.params.sessionKey,acpxRecordId:'rec'}})+'\\n'); }",
      " else if(msg.method==='prompt'){ process.stdout.write(JSON.stringify({id:msg.id,ok:true,result:{result:{status:'completed'},finalText:mode}})+'\\n'); }",
      ` else if(msg.method==='permission.update'){ if(${opts?.failPermissionUpdate ? "true" : "false"} && failCount++ < ${opts?.failAfter ?? 1}){ process.stdout.write(JSON.stringify({id:msg.id,ok:false,error:{code:'RUNTIME_INIT_FAILED',message:'injected fail'}})+'\\n'); } else if(typeof msg.params.generation==='number' && msg.params.generation<=gen){ process.stdout.write(JSON.stringify({id:msg.id,ok:false,error:{code:'RUNTIME_INIT_FAILED',message:'stale generation '+msg.params.generation+' current '+gen}})+'\\n'); } else { gen=msg.params.generation; mode=msg.params.permissionMode||mode; process.stdout.write(JSON.stringify({id:msg.id,ok:true,result:{generation:msg.params.generation,accepted:true}})+'\\n'); } }`,
      " else { process.stdout.write(JSON.stringify({id:msg.id,ok:true,result:{}})+'\\n'); if(msg.method==='shutdown')process.exit(0); }",
      "}catch{}}});",
    ].join("\n"),
  );
}
test("generation ordering: live update increments and duplicate stale rejected", async () => {
  const dir = await mkdtemp(join(tmpdir(), "live-gen-"));
  try {
    const entry = join(dir, "w.mjs");
    await echoWorker(entry);
    const engine = new RuntimeEngine({ workerEntryPath: entry, permissionMode: "approve-all", nonInteractivePermissions: "deny", fenceDir: join(dir, "fences"), queueDir: join(dir, "queue") });
    await engine.prompt({ ...base, text: "t1" });
    await engine.updatePermissionPolicy({ permissionMode: "deny-all", nonInteractivePermissions: "deny" });
    const reply = await engine.prompt({ ...base, text: "t2" });
    expect(reply.text).toBe("deny-all");
    const client = (engine as unknown as { manager: { get: (k:string)=>{ request:(m:string,p:unknown)=>Promise<unknown>} } }).manager.get("live-perm-1");
    await expect(client.request("permission.update", { generation: 5, permissionMode: "approve-all" })).resolves.toMatchObject({ generation: 5, accepted: true });
    await expect(client.request("permission.update", { generation: 6, permissionMode: "approve-all" })).resolves.toMatchObject({ generation: 6, accepted: true });
  } finally { await rm(dir, { recursive: true, force: true }); await new Promise(r => setTimeout(r, 2000)); }
}, 20_000);

test("new worker after update bootstraps with current generation", async () => {
  const dir = await mkdtemp(join(tmpdir(), "live-new-"));
  try {
    const entry = join(dir, "w.mjs");
    await echoWorker(entry);
    const engine = new RuntimeEngine({ workerEntryPath: entry, permissionMode: "approve-all", nonInteractivePermissions: "deny", fenceDir: join(dir, "fences"), queueDir: join(dir, "queue") });
    console.log("new worker test: prompt t1 start");
    await engine.prompt({ ...base, text: "t1" });
    console.log("new worker test: prompt t1 done");
    console.log("new worker test: update start");
    await engine.updatePermissionPolicy({ permissionMode: "deny-all", nonInteractivePermissions: "deny" });
    console.log("new worker test: update done");
    expect((await engine.isSessionWarm(base)).warm).toBe(true);
    console.log("new worker test: isWarm done");
    const reply = await Promise.race([
      engine.prompt({ ...base, text: "t2" }).then(r => { console.log("new worker test: prompt t2 done", r.text); return r; }),
      new Promise<never>((_, rej) => setTimeout(() => { console.log("new worker test: prompt t2 timeout"); rej(new Error("prompt t2 timeout")); }, 5000)),
    ]);
    expect(reply.text).toBe("deny-all");
    await engine.shutdown();
    await new Promise(r => setTimeout(r, 500));
  } finally { await rm(dir, { recursive: true, force: true }); await new Promise(r => setTimeout(r, 2000)); }
}, 20_000);

test("partial update: worker A accepts, B fails -> B terminated, no live worker on old generation", async () => {
  const dir = await mkdtemp(join(tmpdir(), "live-partial-"));
  try {
    const entry = join(dir, "w.mjs");
    await echoWorker(entry);
    const engine = new RuntimeEngine({ workerEntryPath: entry, permissionMode: "approve-all", nonInteractivePermissions: "deny", fenceDir: join(dir, "fences"), queueDir: join(dir, "queue") });
    const sessA = { ...base, logicalSessionId: "sessA", name: "sessA" };
    const sessB = { ...base, logicalSessionId: "sessB", name: "sessB" };
    await engine.prompt({ ...sessA, text: "tA" });
    await engine.prompt({ ...sessB, text: "tB" });
    const mgr = (engine as unknown as { manager: { get: (k:string)=>unknown; workers: ()=>Array<{ ref:{ logicalSessionId:string }; request: (m:string,p:unknown)=>Promise<unknown>; terminate: ()=>Promise<void>; lifecycle:string; ref:{pid?:number} }> } }).manager;
    const workerB = mgr.get("sessB") as unknown as { request: (m:string,p:unknown)=>Promise<unknown>; terminate: ()=>Promise<void> };
    const origReq = workerB.request.bind(workerB);
    workerB.request = async (m: string, p: unknown) => {
      if (m === "permission.update") throw new Error("injected B fail");
      return origReq(m, p);
    };
    await engine.updatePermissionPolicy({ permissionMode: "deny-all", nonInteractivePermissions: "deny" });
    expect((await engine.isSessionWarm(sessA)).warm).toBe(true);
    expect((await engine.isSessionWarm(sessB)).warm).toBe(false);
    await engine.shutdown().catch(() => {});
    await new Promise(r => setTimeout(r, 2000));
  } finally { await rm(dir, { recursive: true, force: true }); await new Promise(r => setTimeout(r, 2000)); }
}, 20_000);

test("busy transition fails closed", async () => {
  const dir = await mkdtemp(join(tmpdir(), "live-busy-"));
  try {
    const entry = join(dir, "slow.mjs");
    await writeFile(entry, [
      "let b=''; process.stdin.on('data',d=>{b+=d.toString(); let i; while((i=b.indexOf('\\n'))>=0){const l=b.slice(0,i); b=b.slice(i+1); if(!l)continue; try{const m=JSON.parse(l); if(m.method==='ensure'){process.stdout.write(JSON.stringify({id:m.id,ok:true,result:{ready:true,sessionKey:m.params.sessionKey,acpxRecordId:'rec'}})+'\\n');} else if(m.method==='prompt'){ setTimeout(()=>{process.stdout.write(JSON.stringify({id:m.id,ok:true,result:{result:{status:'completed'},finalText:'done'}})+'\\n');},500);} else {process.stdout.write(JSON.stringify({id:m.id,ok:true,result:{}})+'\\n');}}catch{}}});"
    ].join("\n"));
    const engine = new RuntimeEngine({ workerEntryPath: entry, permissionMode: "approve-all", nonInteractivePermissions: "deny", fenceDir: join(dir, "fences"), queueDir: join(dir, "queue") });
    const p = engine.prompt({ ...base, text: "long" });
    await new Promise(r=>setTimeout(r,50));
    await expect(engine.updatePermissionPolicy({ permissionMode: "deny-all", nonInteractivePermissions: "deny" })).rejects.toMatchObject({ code: "RUNTIME_PERMISSION_BUSY" });
    await p;
    await engine.shutdown();
    await new Promise(r => setTimeout(r, 500));
  } finally { await rm(dir, { recursive: true, force: true }); await new Promise(r => setTimeout(r, 2000)); }
}, 20_000);

test("no worker rotation on successful ordinary policy update", async () => {
  const dir = await mkdtemp(join(tmpdir(), "live-no-rot-"));
  try {
    const entry = join(dir, "w.mjs");
    await echoWorker(entry);
    const engine = new RuntimeEngine({ workerEntryPath: entry, permissionMode: "approve-all", nonInteractivePermissions: "deny", fenceDir: join(dir, "fences"), queueDir: join(dir, "queue") });
    await engine.prompt({ ...base, text: "t1" });
    const pid1 = (engine as unknown as { manager: { get:(k:string)=>{ ref:{ pid:number } } } }).manager.get("live-perm-1")?.ref.pid;
    await engine.updatePermissionPolicy({ permissionMode: "deny-all", nonInteractivePermissions: "deny" });
    const pid2 = (engine as unknown as { manager: { get:(k:string)=>{ ref:{ pid:number } } } }).manager.get("live-perm-1")?.ref.pid;
    expect(pid2).toBe(pid1);
    expect((await engine.isSessionWarm(base)).warm).toBe(true);
    await engine.shutdown();
    await new Promise(r => setTimeout(r, 500));
  } finally { await rm(dir, { recursive: true, force: true }); await new Promise(r => setTimeout(r, 2000)); }
}, 20_000);
