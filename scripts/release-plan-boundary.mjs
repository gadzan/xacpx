/**
 * Release-boundary test: the published xacpx tarball must deliver structured
 * plan entries end to end. Packs the repo (npm pack, like the release
 * workflow), installs the tarball into an empty directory with production
 * npm (like a consumer), then drives a real createAcpRuntime/startTurn
 * against a fixture ACP agent that emits a plan notification.
 *
 * This catches dependency-shipping gaps unit tests cannot see: e.g. a
 * consumer-side acpx patch that never lands in the published dependency
 * tree would make this fail with a text-only plan event.
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
sh("npm", ["install", tarballPath, "--omit=dev", "--no-audit", "--no-fund"], { cwd: installDir });
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
  `const acpx = await import("acpx/runtime");
const dir = process.cwd();
const runtime = acpx.createAcpRuntime({
  cwd: dir,
  sessionStore: acpx.createRuntimeStore({ stateDir: dir + "/state" }),
  agentRegistry: acpx.createAgentRegistry({ overrides: { proof: ["node", dir + "/plan-agent.mjs"] } }),
  permissionMode: "approve-all",
});
const handle = await runtime.ensureSession({ sessionKey: "boundary", agent: "proof", mode: "persistent", cwd: dir });
const turn = runtime.startTurn({ handle, text: "hello" });
await turn.promptStarted;
for await (const event of turn.events) {
  if (event.type === "status" && event.tag === "plan") console.log(JSON.stringify(event));
}
await turn.result;
`,
);

const out = sh("node", ["plan-driver.mjs"], { cwd: installDir });
const plans = out
  .split("\n")
  .map((line) => line.trim())
  .filter(Boolean)
  .map((line) => JSON.parse(line));
const withEntries = plans.filter((e) => Array.isArray(e.entries) && e.entries.length === 2);
if (withEntries.length === 0) {
  console.error("FAIL: no structured plan entries in release-tree turn events.");
  console.error(out);
  process.exit(1);
}
const first = withEntries[0].entries[0];
if (first.content !== "write the file" || first.status !== "in_progress") {
  console.error("FAIL: plan entries malformed in release-tree turn events.");
  console.error(out);
  process.exit(1);
}
console.log("PASS: release tarball delivers structured plan entries.");
