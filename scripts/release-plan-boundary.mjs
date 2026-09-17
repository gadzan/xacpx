/**
 * Release-boundary test: the published xacpx tarball must surface structured
 * plan entries as prompt.plan end to end. This script runs `bun run build`
 * itself (self-contained: never depends on another step's dist/), packs the
 * repo with `npm pack` (like the release workflow; files:
 * ["dist","README.md","config.example.json"]), installs the tarball into an
 * empty directory with production npm (like a consumer), then drives a real
 * prompt through the PACKED bridge: it spawns
 * dist/bridge/bridge-main.js over stdio JSON-RPC by hand (the transport and
 * client modules are bundled inside it, not importable) with a fixture ACP
 * agent that emits populated and explicitly-empty plan notifications.
 *
 * This covers the full production path: packed acpx dependency (structured
 * entries must survive shipping) → adapter normalize → worker protocol →
 * RuntimeEngine → prompt.plan wire events (replace semantics, including the
 * empty clearing snapshot). A stale acpx pin, or a regression that drops the
 * prompt.plan mapping, fails here with missing prompt.plan events.
 *
 * Lifecycle: the generated driver owns its bridge subprocess explicitly —
 * bounded shutdown RPC → stdin.end → bounded exit wait → SIGKILL only when
 * still alive → bounded reap. Timer ownership rule: bounded timers are
 * ref'd (they must hold the loop for their budget) and ALWAYS cleared on
 * early settle (response / exit / close), so teardown never holds the gate
 * past the actual exit. The fixture watchdog is unref'd with EOF/SIGTERM
 * exits, so a failure can never hang the gate on a 120s timer.
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

console.log("building dist/ from current checkout (bun run build)...");
sh("bun", ["run", "build"], { cwd: REPO });
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
import { mkdirSync } from "node:fs";
import { join } from "node:path";
// Drive the PACKED bridge over stdio JSON-RPC. dist/bridge/bridge-main.js is
// the only bridge surface the tarball ships (transport/client modules are
// bundled inside it, not importable). This still exercises the full
// production chain: packed acpx → adapter → worker → RuntimeEngine →
// prompt.plan wire events.
const here = process.cwd();
// Keep the isolated HOME under the outer release stage so the parent's exit
// cleanup owns every filesystem artifact from this boundary test. --keep-stage
// intentionally preserves it together with the rest of the stage for debugging.
const home = join(here, ".boundary-home");
mkdirSync(home, { recursive: true });
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
function rejectAllPending(error) {
  if (pending.size === 0) return;
  for (const handlers of pending.values()) {
    if (handlers.timer !== undefined) clearTimeout(handlers.timer);
    handlers.reject(error);
  }
  pending.clear();
}
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
    if (handlers.timer !== undefined) clearTimeout(handlers.timer);
    if (msg.ok) handlers.resolve(msg.result);
    else handlers.reject(new Error("bridge error: " + JSON.stringify(msg).slice(0, 4000)));
    return;
  }
  seenLines.push(line.slice(0, 300));
  if (seenLines.length <= 5) process.stderr.write("unrouted bridge line: " + line.slice(0, 300) + "\\n");
});
// A crashed/exited bridge never fires "error" — reject everything on
// exit/close so no request() hangs past the process lifetime.
let bridgeExited = null;
function onBridgeGone(reason) {
  if (bridgeExited === null) bridgeExited = reason;
  rejectAllPending(new Error("bridge " + reason + " before responding"));
}
bridge.on("error", (error) => onBridgeGone("error: " + String(error?.message ?? error)));
bridge.on("exit", (code, signal) => onBridgeGone("exited (code=" + code + ", signal=" + signal + ")"));
bridge.on("close", (code, signal) => onBridgeGone("closed (code=" + code + ", signal=" + signal + ")"));
// Every RPC is bounded: a wedged-but-alive bridge cannot stall the gate.
// Shutdown uses the shortest budget (it must never block the reap below).
const REQUEST_TIMEOUT_MS = 120000;
const SHUTDOWN_TIMEOUT_MS = 30000;
function request(method, params, timeoutMs) {
  const budget = timeoutMs ?? REQUEST_TIMEOUT_MS;
  if (bridgeExited !== null) return Promise.reject(new Error("bridge already " + bridgeExited));
  const id = String(nextId++);
  return new Promise((resolve, reject) => {
    // Ref'd on purpose (see above): bounded budgets only, cleared on settle.
    const timer = setTimeout(() => {
      if (pending.delete(id)) reject(new Error('bridge request "' + method + '" timed out after ' + budget + 'ms'));
    }, budget);
    pending.set(id, { resolve, reject, timer });
    bridge.stdin.write(JSON.stringify({ id, method, params }) + "\\n", (error) => {
      if (error) {
        if (pending.delete(id)) clearTimeout(timer);
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
  // Owned lifecycle, every step bounded: a wedged bridge can delay but
  // never hang the gate. Order: timed shutdown RPC → end stdin → bounded
  // exit wait → SIGKILL only when still alive → bounded reap.
  // waitForBridgeExit never leaks: whichever of exit/close/timeout wins
  // first clears the timer, unregisters both listeners, and reports
  // whether the bridge actually exited — so teardown never holds the gate
  // past the real exit, and never SIGKILLs an already-dead process.
  async function waitForBridgeExit(timeoutMs) {
    if (bridgeExited !== null) return true;
    return new Promise((resolve) => {
      let done = false;
      const timer = setTimeout(() => {
        cleanup();
        resolve(false);
      }, timeoutMs);
      function cleanup() {
        if (done) return;
        done = true;
        clearTimeout(timer);
        bridge.off("exit", onGone);
        bridge.off("close", onGone);
      }
      function onGone() {
        cleanup();
        resolve(true);
      }
      bridge.once("exit", onGone);
      bridge.once("close", onGone);
    });
  }
  try { await request("shutdown", {}, SHUTDOWN_TIMEOUT_MS); } catch {}
  try { bridge.stdin.end(); } catch {}
  // NOTE: the bridge does NOT exit on shutdown/stdin.end by design (it
  // owns acpx queue-owner/agent children that outlive the RPC). Teardown is
  // therefore kill-based: SIGTERM for grace, then SIGKILL. waitForBridgeExit
  // still reports whether the process actually went away at each stage.
  let exited = await waitForBridgeExit(10000);
  if (!exited) {
    try { bridge.kill("SIGTERM"); } catch {}
    exited = await waitForBridgeExit(10000);
  }
  if (!exited) {
    try { bridge.kill("SIGKILL"); } catch {}
    await waitForBridgeExit(5000);
  }
  rejectAllPending(new Error("driver teardown complete"));
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