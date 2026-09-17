/**
 * Release-boundary test: the published xacpx tarball must surface structured
 * plan entries as prompt.plan end to end. Packs the repo (npm pack, like the
 * release workflow; dist/ is built by prepack... see note below), installs
 * the tarball into an empty directory with production npm (like a consumer),
 * then drives a real prompt through the INSTALLED bridge transport
 * (spawnAcpxBridgeClient against the packed dist/bridge/bridge-main.js) with
 * a fixture ACP agent that emits populated and explicitly-empty plan
 * notifications.
 *
 * NOTE on prepack: `npm pack` runs the root prepack script? NO — this repo
 * has no prepack hook, so dist/ must already be built in the checkout
 * (CI runs build:packages before this gate). The tarball ships dist/ as-is;
 * files: ["dist","README.md","config.example.json"].
 *
 * This covers the full production path: packed acpx dependency (structured
 * entries must survive shipping) → adapter normalize → worker protocol →
 * RuntimeEngine → prompt.plan (replace semantics, including the empty
 * clearing snapshot). A stale acpx pin, or a regression that drops the
 * prompt.plan mapping, fails here with missing prompt.plan events.
 *
 * Lifecycle: the driver owns its bridge client explicitly —
 * client.dispose() (bridge shutdown + process-tree teardown) runs in a
 * finally, and the fixture watchdog is unref'd with EOF/SIGTERM exits, so a
 * failure can never hang the gate on a 120s timer.
 *
 * Usage: node ./scripts/release-plan-boundary.mjs [--keep-stage]
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const REPO = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
const KEEP = process.argv.includes("--keep-stage");

function sh(cmd, args, options) {
  return execFileSync(cmd, args, { stdio: "pipe", encoding: "utf8", timeout: 600_000, ...options });
}

const stage = mkdtempSync(join(tmpdir(), "xacpx-release-plan-"));
const cleanup = () => {
  if (!KEEP) rmSync(stage, { recursive: true, force: true });
};
process.on("exit", cleanup);

const tarball = sh("npm", ["pack", "--pack-destination", stage], { cwd: REPO }).trim().split("\n").pop().trim();
const tarballPath = join(stage, tarball);
console.log(`packed: ${tarballPath}`);

const installDir = join(stage, "install");
mkdirSync(installDir, { recursive: true });
sh("npm", ["init", "-y"], { cwd: installDir });
sh(
  "npm",
  [
    "install",
    tarballPath,
    "--omit=dev",
    "--no-audit",
    "--no-fund",
    "--registry=https://registry.npmjs.org/",
  ],
  { cwd: installDir },
);
console.log("tarball installed (production tree)");

const acpxPkg = join(installDir, "node_modules", "acpx", "package.json");
const { version: acpxVersion } = JSON.parse(
  (await import("node:fs")).readFileSync(acpxPkg, "utf8"),
);
console.log(`installed acpx: ${acpxVersion}`);

writeFileSync(
  join(installDir, "plan-agent.mjs"),
  `import { createInterface } from "node:readline";
const write = (m) => process.stdout.write(JSON.stringify(m) + "\\n");
const respond = (id, result) => write({ jsonrpc: "2.0", id, result });
const notify = (sessionId, update) =>
  write({ jsonrpc: "2.0", method: "session/update", params: { sessionId, update } });
const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
const timer = setTimeout(() => process.exit(0), 120_000);
timer.unref?.();
rl.on("close", () => process.exit(0));
process.on("SIGTERM", () => process.exit(0));
rl.on("line", (line) => {
  timer.refresh();
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  if (!msg || typeof msg.method !== "string") return;
  const { id, method, params } = msg;
  if (method === "initialize") {
    respond(id, { protocolVersion: 1, authMethods: [], agentCapabilities: { promptCapabilities: {}, sessionCapabilities: { new: {}, load: {}, close: {}, cancel: {} } } });
  } else if (method === "session/new") {
    respond(id, { sessionId: "boundary-sid" });
  } else if (method === "session/prompt") {
    const sid = params?.sessionId ?? "boundary-sid";
    notify(sid, { sessionUpdate: "plan", entries: [
      { content: "write the file", status: "in_progress", priority: "high" },
      { content: "verify", status: "pending", priority: "low" },
    ] });
    notify(sid, { sessionUpdate: "plan", entries: [] });
    notify(sid, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "done" } });
    respond(id, { stopReason: "end_turn" });
  } else if (id !== undefined) {
    respond(id, {});
  }
});
`,
);

writeFileSync(
  join(installDir, "plan-driver.mjs"),
  `import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
// Drive the PACKED bridge over stdio JSON-RPC. dist/bridge/bridge-main.js is
// the only bridge surface the tarball ships (transport/client modules are
// bundled inside it, not importable). This still exercises the full
// production chain: packed acpx → adapter → worker → RuntimeEngine →
// prompt.plan wire events.
const here = process.cwd();
const home = mkdtempSync(join(tmpdir(), "xacpx-boundary-home-"));
process.env.HOME = home;
process.env.USERPROFILE = home;
// Isolate ALL filesystem state the bridge touches: acpx sessions (~/.acpx),
// xacpx durable root (~/.xacpx/runtime queues+fences), and the cwd record dir.
const acpxHome = join(home, ".acpx");
mkdirSync(join(acpxHome, "sessions"), { recursive: true });
// Fixture agent reachable at a stable absolute path (cwd-independent).
const agentPath = join(home, "plan-agent.mjs");
{
  const { copyFileSync } = await import("node:fs");
  copyFileSync(join(here, "plan-agent.mjs"), agentPath);
}
const agentArgv = ["node", agentPath];
const bridge = spawn(process.execPath, [join(here, "node_modules/@ganglion/xacpx/dist/bridge/bridge-main.js")], {
  stdio: ["pipe", "pipe", "inherit"],
  env: {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
    XACPX_BRIDGE_ACPX_COMMAND: "acpx",
    XACPX_BRIDGE_PERMISSION_MODE: "approve-all",
    XACPX_BRIDGE_NON_INTERACTIVE_PERMISSIONS: "deny",
    XACPX_BRIDGE_PERMISSION_INTERACTION_CAPABLE: "0",
  },
});
const rl = createInterface({ input: bridge.stdout, crlfDelay: Infinity });
let nextId = 1;
const pending = new Map();
const plans = [];
const seenLines = [];
rl.on("line", (line) => {
  let msg;
  try { msg = JSON.parse(line); } catch { process.stderr.write("non-json bridge line: " + line.slice(0, 200) + "\\n"); return; }
  if (msg && typeof msg === "object" && typeof msg.event === "string") {
    if (msg.event === "prompt.plan") plans.push(msg.entries);
    return;
  }
  if (msg && typeof msg === "object" && msg.id !== undefined && pending.has(String(msg.id))) {
    const handlers = pending.get(String(msg.id));
    pending.delete(String(msg.id));
    if (msg.ok) handlers.resolve(msg.result);
    else handlers.reject(new Error("bridge error: " + JSON.stringify(msg).slice(0, 4000)));
    return;
  }
  seenLines.push(line.slice(0, 300));
  if (seenLines.length <= 5) process.stderr.write("unrouted bridge line: " + line.slice(0, 300) + "\\n");
});
bridge.on("error", (error) => {
  for (const handlers of pending.values()) handlers.reject(error);
  pending.clear();
});
function request(method, params) {
  const id = String(nextId++);
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    bridge.stdin.write(JSON.stringify({ id, method, params }) + "\\n", (error) => {
      if (error) {
        pending.delete(id);
        reject(error);
      }
    });
  });
}
// Agent identity: custom driver + explicit argv, like the compat harness
// (tests/compat/acpx-latest.test.ts writes an ~/.acpx/config.json overlay);
// here argv rides directly on the session params (agentArgv), which the
// Runtime worker turns into agentOverrides for the proof alias.
const sessionParams = {
  agent: "proof",
  driver: "proof",
  agentCommand: "node " + agentPath,
  acpxAgent: "proof",
  agentArgv,
  cwd: home,
  name: "boundary-session",
  transportEngine: "runtime",
};
let failed = null;
try {
  await request("ensureSession", { ...sessionParams, sessionKey: "boundary" });
  await request("prompt", { ...sessionParams, sessionKey: "boundary", text: "hello", toolEventMode: "text" });
  const populated = plans.filter((e) => Array.isArray(e) && e.length === 2);
  const cleared = plans.filter((e) => Array.isArray(e) && e.length === 0);
  if (populated.length === 0) failed = "no populated prompt.plan reached the bridge client";
  else {
    const first = populated[0][0];
    if (first.content !== "write the file" || first.status !== "in_progress" || first.priority !== "high") {
      failed = "prompt.plan entries malformed: " + JSON.stringify(populated[0]);
    } else if (cleared.length === 0) {
      failed = "no explicit-empty plan replacement reached the bridge client";
    }
  }
  if (failed) {
    console.error("FAIL: " + failed);
    console.error(JSON.stringify({ plans }));
  } else {
    console.log(JSON.stringify({ plans }));
  }
} catch (error) {
  failed = String(error?.message ?? error);
  console.error("FAIL: bridge request error: " + failed);
} finally {
  // Owned lifecycle: ask the bridge to shut down, then close stdin and reap
  // the process tree. Never hangs on the fixture 120s watchdog (unref'd) —
  // and even a wedged bridge is SIGKILLed after a bounded wait.
  try { await request("shutdown", {}); } catch {}
  bridge.stdin.end();
  await new Promise((resolve) => {
    let done = false;
    const finish = () => { if (!done) { done = true; resolve(); } };
    bridge.on("exit", finish);
    setTimeout(finish, 10000);
  });
  try { bridge.kill("SIGKILL"); } catch {}
}
if (failed) process.exit(1);
`,
);

const out = sh("node", ["plan-driver.mjs"], { cwd: installDir });
const lines = out.split("\n").map((l) => l.trim()).filter(Boolean);
const summary = lines.length > 0 ? JSON.parse(lines[lines.length - 1]) : null;
if (!summary || !Array.isArray(summary.plans)) {
  console.error("FAIL: driver produced no plan summary.");
  console.error(out);
  process.exit(1);
}
console.log("PASS: release tarball surfaces structured prompt.plan end to end (populated + explicit empty).");
