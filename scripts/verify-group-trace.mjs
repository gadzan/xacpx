#!/usr/bin/env node
/**
 * Acceptance verifier for the Group MemberTurn trace feature on the real surface.
 *
 * Boots an isolated Relay hub + Core daemon (scripts/verify-stack.mjs conventions,
 * unique temp root; never the operator's home). Everything is driven through the
 * public web RPC on port 18788 — no in-process calls, no direct DB seed, no fake
 * fixture emission. Plans, tool steps, reasoning and finals pass through the real
 * SessionTurnRunner via a deterministic local ACP adapter:
 * tests/fixtures/group-trace-acp-agent.mjs (argv-pinned per bot in the isolated
 * daemon config).
 *
 * Scenarios (Group topic survey from design §3.4 / frozen plan):
 *   1. Both members execute and complete. The verifier asserts per-member
 *      pages with reasoning (agent_thought_chunk), tool progress
 *      (tool_call pending/in_progress/completed), replace-latest plan and the
 *      final agent_message_chunk, observed from the adapter-own audit file
 *      (real provider launches, not the verifier's own model).
 *   2. Members hold explicitly ("TRACE_HOLD"), their trace stays open
 *      (`recording`), and the daemon is force-killed (not a graceful stop). A
 *      forced kill leaves every live Runtime worker fence undischarged, and
 *      Windows dead-root recovery is intentionally disabled, so those sessions
 *      are never re-adopted; the interrupted trace is therefore the durable
 *      proof of the crash. After the restart the reconnected real daemon
 *      reports the open attempt explicitly interrupted with the exact
 *      pre-crash prefix.
 *   3. A fresh post-restart Run on fresh agents records complete per-member
 *      pages again.
 *   4. A member whose turn is cancelled before its provider turn starts has
 *      no trace; the read path reports explicit unavailable/not-recorded.
 *   5. Legacy: `--legacy-core <rel|abs path>` points a pre-feature dist/cli.js
 *      build, which is started against the same durable state. Without it the
 *      report explicitly labels the legacy check unavailable instead of
 *      silently skipping it.
 *
 * Usage (parent runs; requires the Core and Relay builds to exist):
 *   node ./scripts/verify-group-trace.mjs
 *   node ./scripts/verify-group-trace.mjs --legacy-core ../prefeature/dist/cli.js
 *   node ./scripts/verify-group-trace.mjs --keep   (keep the state dir on failure)
 *
 * NOTE: opt-in developer tooling; never runs build/check commands; never
 * leaves a temp dir unless --keep; kills only its own verifier-owned PIDs.
 */

import { spawn, spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  openSync,
  closeSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PORT = 18788;
const STARTUP_TIMEOUT_MS = 60_000;
const TURN_TIMEOUT_MS = 120_000;
const RETRY_TIMEOUT_MS = 30_000;
const CANCEL_TIMEOUT_MS = 60_000;
const PLUGIN_SKIP = [/^@ganglion\/xacpx-rmux-bridge-/];

const label = (message) => process.stdout.write(`[verify-group-trace] ${message}\n`);
const fail = (message) => {
  process.stderr.write(`[verify-group-trace][error] ${message}\n`);
  process.exit(1);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ---- assertions ---------------------------------------------------------- */

function assert(condition, message) {
  if (!condition) throw new Error(`assertion failed: ${message}`);
}
function assertEqual(actual, expected, message) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`assertion failed: ${message}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

/* ---- verify-stack.mjs conventions --------------------------------------- */

function fixtureScript() {
  return join(repoRoot, "tests", "fixtures", "group-trace-acp-agent.mjs");
}

function statePaths() {
  const root = mkdtempSync(join(tmpdir(), "xacpx-verify-group-trace-"));
  return {
    root,
    config: join(root, "config.json"),
    state: join(root, "state.json"),
    plugins: join(root, "plugins"),
    relayDb: join(root, "relay.db"),
    home: join(root, "home"),
    hubLog: join(root, "hub.log"),
    daemonLog: join(root, "daemon.log"),
    sessions: join(root, "sessions"),
    audit: join(root, "sessions", "audit.jsonl"),
    recoveryGate: join(root, "sessions", "recovery-gate.jsonl"),
    workdir: join(root, "ws"),
    port: PORT,
  };
}

/** Dependency closure of the connector plugin, same rule as verify-stack.mjs. */
function planPluginHome(paths) {
  const nodeModules = join(repoRoot, "node_modules");
  const plan = [];
  const missing = [];
  const seen = new Set();
  const queue = ["@ganglion/xacpx-channel-relay"];
  while (queue.length > 0) {
    const name = queue.shift();
    if (seen.has(name)) continue;
    seen.add(name);
    const source = join(nodeModules, name);
    const manifestFile = join(source, "package.json");
    if (!existsSync(manifestFile)) {
      if (name === "xacpx") continue; // the daemon writes this shim itself
      missing.push(name);
      continue;
    }
    for (const dep of Object.keys(JSON.parse(readFileSync(manifestFile, "utf8")).dependencies ?? {})) {
      if (!PLUGIN_SKIP.some((pattern) => pattern.test(dep))) queue.push(dep);
    }
    plan.push({ name, source, target: join(paths.plugins, "node_modules", name) });
  }
  return { plan, missing };
}

function buildIsolatedConfig(input) {
  const { port, token, audit, recoveryGate, workspaceCwd, adapter } = input;
  return {
    transport: {
      // Production default. Its runtime engine ensures the physical agent
      // session on first prompt; the CLI transport does not do that for a
      // product-owned member session, so the verifier would test a different
      // (broken) surface than the shipped daemon.
      type: "acpx-bridge",
      // `auto` binds new sessions to the Runtime engine when eligible and
      // honestly falls back to the CLI engine otherwise (a recorded reason),
      // matching what a default-configured daemon does.
      permissionMode: "approve-all",
      nonInteractivePermissions: "deny",
    },
    logging: { level: "info" },
    plugins: [{ name: "@ganglion/xacpx-channel-relay", enabled: true }],
    channels: [
      {
        id: "relay",
        type: "relay",
        enabled: true,
        options: { url: `ws://127.0.0.1:${port}`, pairingToken: token },
      },
    ],
    // A forced daemon kill leaves the Runtime worker fence in `admitted` for
    // every session that was live; Windows dead-root recovery is intentionally
    // disabled (see runtime-worker-fence.ts), so those sessions can never be
    // re-adopted by a successor host. Post-restart scenarios therefore use
    // fresh agents rather than pretending a fenced session can respawn.
    agents: Object.fromEntries(["A", "B", "C", "D", "E", "F"].map((letter) => [
      `trace-agent-${letter.toLowerCase()}`,
      { driver: "codex", argv: [process.execPath, adapter, "--member", letter, "--audit", audit, "--recovery-gate", recoveryGate] },
    ])),
    workspaces: { verify: { cwd: workspaceCwd } },
    orchestration: {},
  };
}

function daemonEnv(paths) {
  return {
    ...process.env,
    WEACPX_CONFIG: paths.config,
    WEACPX_STATE: paths.state,
    XACPX_PLUGIN_HOME: paths.plugins,
    HOME: paths.home,
    USERPROFILE: paths.home,
  };
}

/* ---- process helpers ------------------------------------------------------ */

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Re-identify the process by command line before signalling a reused PID. */
function processMatches(pid, needle) {
  if (!pid || !Number.isInteger(pid) || pid <= 0 || !isAlive(pid)) return false;
  if (process.platform === "win32") {
    const result = spawnSync(
      "powershell",
      ["-NoProfile", "-Command", `Get-CimInstance Win32_Process -Filter "ProcessId=${pid}" | Select-Object -ExpandProperty CommandLine`],
      { encoding: "utf8" },
    );
    if (result.error || result.status !== 0) return false;
    return (result.stdout ?? "").includes(needle);
  }
  try {
    return readFileSync(`/proc/${pid}/cmdline`, "utf8").includes(needle);
  } catch {
    return false;
  }
}

function portOwner(port) {
  if (process.platform !== "win32") return null;
  const result = spawnSync(
    "powershell",
    ["-NoProfile", "-Command", `(Get-NetTCPConnection -LocalPort ${port} -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1 -ExpandProperty OwningProcess)`],
    { encoding: "utf8" },
  );
  const pid = Number((result.stdout ?? "").trim());
  return Number.isInteger(pid) && pid > 0 ? pid : null;
}

function sweepProcesses(needles) {
  if (process.platform !== "win32") return [];
  const filter = needles.map((n) => `$_.CommandLine -like '*${n}*'`).join(" -or ");
  const result = spawnSync(
    "powershell",
    ["-NoProfile", "-Command", `Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { ${filter} } | Select-Object -ExpandProperty ProcessId`],
    { encoding: "utf8" },
  );
  if (result.error || result.status !== 0) return [];
  return (result.stdout ?? "")
    .split(/\s+/)
    .filter(Boolean)
    .map(Number)
    .filter((pid) => Number.isInteger(pid) && pid > 0 && pid !== process.pid);
}

function spawnDetached(command, args, options) {
  mkdirSync(dirname(options.logPath), { recursive: true });
  const fd = openSync(options.logPath, "a");
  const child = spawn(command, args, {
    cwd: options.cwd,
    env: options.env,
    stdio: ["ignore", fd, fd],
    detached: true,
    windowsHide: true,
  });
  closeSync(fd);
  child.unref();
  return child.pid;
}

async function waitFor(labelText, predicate, timeoutMs = STARTUP_TIMEOUT_MS) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const value = await predicate();
      if (value) return value;
    } catch {
      // Transient reconnect windows are expected during startup.
    }
    if (Date.now() > deadline) return null;
    await sleep(500);
  }
}

/** Count "instance connected" lines in the hub log; a restart must add one. */
function instanceConnectCount(logPath) {
  try {
    return readFileSync(logPath, "utf8").split("instance connected").length - 1;
  } catch {
    return 0;
  }
}

/** Kill a verifier-owned PID tree, re-identifying it first. */
function killPidTree(pid, needle) {
  if (!processMatches(pid, needle)) return;
  if (process.platform === "win32") {
    spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"]);
  } else {
    process.kill(pid, "SIGKILL");
  }
}

/* ---- isolated stack ------------------------------------------------------ */

async function upStack(paths) {
  label(`stack root ${paths.root}`);
  const occupied = portOwner(PORT);
  if (occupied) fail(`port ${PORT} is held by pid ${occupied}, which this verifier did not start`);
  const leftovers = sweepProcesses([paths.root, "group-trace-acp-agent"]);
  if (leftovers.length > 0) fail(`leftover processes from an earlier run: ${leftovers.join(", ")}`);

  for (const dir of [paths.root, paths.plugins, paths.home, paths.workdir, paths.sessions]) {
    mkdirSync(dir, { recursive: true });
  }
  // The adapter's recovery gate is created later, right before the forced
  // kill: a shipped hold prompt must reach the provider and stay open while
  // the gate file is absent, and only a post-restart recovery re-dispatch is
  // rejected cleanly by the gate.
  const { plan, missing } = planPluginHome(paths);
  if (missing.length > 0) {
    fail(`plugin home dependency closure is incomplete in node_modules: ${missing.join(", ")}. Run bun install.`);
  }
  for (const entry of plan) {
    mkdirSync(dirname(entry.target), { recursive: true });
    cpSync(entry.source, entry.target, { recursive: true, dereference: true });
  }
  label(`plugin home ready: ${plan.map((p) => p.name).join(", ")}`);

  if (!existsSync(join(repoRoot, "dist", "cli.js"))) {
    fail(`daemon build dist/cli.js is missing; run bun run build before this verifier`);
  }
  if (!existsSync(join(repoRoot, "packages", "relay", "dist", "cli.js"))) {
    fail(`relay build packages/relay/dist/cli.js is missing; run bun run build:relay before this verifier`);
  }

  // Access token is minted on the CLI, on its own labelled line.
  const minted = spawnSync(
    process.execPath,
    [join(repoRoot, "packages", "relay", "dist", "cli.js"), "add", "token", "--db", paths.relayDb, "--label", "verify-group-trace"],
    { cwd: repoRoot, encoding: "utf8" },
  );
  if (minted.status !== 0) fail(`could not mint a hub token: ${minted.stderr ?? minted.stdout}`);
  const token = /access token:\s*(\S+)/.exec(minted.stdout ?? "")?.[1];
  if (!token) fail(`could not parse the access token from: ${minted.stdout}`);

  const config = buildIsolatedConfig({
    port: PORT,
    token,
    audit: paths.audit,
    recoveryGate: paths.recoveryGate,
    workspaceCwd: paths.workdir,
    adapter: fixtureScript(),
  });
  writeFileSync(paths.config, `${JSON.stringify(config, null, 2)}\n`);

  const hubPid = spawnDetached(
    process.execPath,
    [join(repoRoot, "packages", "relay", "dist", "cli.js"), "start", "--db", paths.relayDb, "--http-port", String(PORT), "--host", "127.0.0.1", "--web-root", join(repoRoot, "packages", "relay", "dist", "relay-web")],
    { cwd: repoRoot, env: process.env, logPath: paths.hubLog },
  );
  label(`hub pid ${hubPid} on http://127.0.0.1:${PORT}`);
  if (!(await waitFor("hub", () => fetch(`http://127.0.0.1:${PORT}/`, { signal: AbortSignal.timeout(2000) }).then((r) => r.ok).catch(() => false)))) {
    fail(`hub did not come up; check ${paths.hubLog}`);
  }

  const daemonPid = spawnDetached(process.execPath, [join(repoRoot, "dist", "cli.js"), "start"], {
    cwd: repoRoot,
    env: daemonEnv(paths),
    logPath: paths.daemonLog,
  });
  label("daemon start requested");
  const startedPid = await waitForDaemonPid(paths, "daemon");
  if (!(await waitFor("instance connect", () => instanceConnectCount(paths.hubLog) > 0))) {
    fail(`daemon did not connect to the hub; check ${paths.hubLog}`);
  }
  label(`daemon pid ${startedPid}, instance connected to the hub`);
  return { hubPid, daemonPid: startedPid, token };
}

async function waitForDaemonPid(paths, labelPrefix) {
  const pidFile = join(paths.root, "runtime", "daemon.pid");
  const started = await waitFor(`${labelPrefix} pid file`, () => {
    try {
      const pid = Number(readFileSync(pidFile, "utf8").trim());
      return Number.isInteger(pid) && pid > 0 ? pid : null;
    } catch {
      return null;
    }
  });
  assert(started, `daemon pid file did not appear; check ${paths.daemonLog}`);
  return started;
}

/* ---- public web RPC ------------------------------------------------------ */

function relayBase() {
  return `http://127.0.0.1:${PORT}`;
}

async function loginRelay(token) {
  const res = await fetch(`${relayBase()}/api/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ token }),
  });
  assert(res.ok, `relay login failed: ${res.status}`);
  const cookie = res.headers.get("set-cookie")?.split(";")[0];
  assert(cookie, "relay login did not return a session cookie");
  return cookie;
}

async function requireInstance(cookie) {
  const res = await fetch(`${relayBase()}/api/instances`, { headers: { cookie } });
  assert(res.ok, "could not list relay instances");
  const { instances } = await res.json();
  assert(instances?.length > 0, "no relay instance recorded");
  return instances[0].id;
}

async function rpc(cookie, instance, type, payload = {}) {
  const res = await fetch(`${relayBase()}/api/instances/${instance}/rpc`, {
    method: "POST",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ type, payload }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || body.error) throw new Error(`rpc ${type} failed: ${JSON.stringify(body)}`);
  return body.result;
}

/* ---- deterministic scenario --------------------------------------------- */

async function toRun(cookie, inst, group, botIds, text) {
  const requestId = `trace-proof-${Date.now()}-${Math.floor(Math.random() * 10_000)}`;
  return await rpc(cookie, inst, "control.conversation.prompt", {
    conversationId: group.groupId,
    topicId: group.topicId,
    requestId,
    text,
    target: { mode: "members", botIds },
  });
}

async function pollRunTerminal(cookie, inst, runId, timeoutMs = TURN_TIMEOUT_MS) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const { run } = await rpc(cookie, inst, "control.runs.get", { runId });
    if (["completed", "cancelled", "failed"].includes(run?.state)) {
      // The terminal probe returns the Run summary; callers that need durable
      // member rows must read the full record from the same public surface.
      return (await rpc(cookie, inst, "control.runs.get", { runId })).run;
    }
    if (Date.now() > deadline) throw new Error(`run ${runId} did not finish within ${timeoutMs}ms`);
    await sleep(500);
  }
}

/** adapter-observed provider-start counts (real provider launches only). */
function readProviderAudit(path) {
  let raw = "";
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return {};
  }
  const counts = {};
  const memberOf = (name) => (counts[name] ??= { starts: 0, prompts: 0, finals: 0, gateRejects: 0 });
  for (const line of raw.split("\n")) {
    if (!line) continue;
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    const member = memberOf(event.member);
    if (event.kind === "process-start") member.starts += 1;
    else if (event.kind === "prompt") member.prompts += 1;
    else if (event.kind === "final") member.finals += 1;
    else if (event.kind === "gate-reject") member.gateRejects += 1;
  }
  return counts;
}

/* ---- trace page helpers ------------------------------------------------- */

async function tracePage(cookie, inst, conversationId, topicId, runId, memberTurnId, attempt, afterSeq = 0) {
  return await rpc(cookie, inst, "control.runs.trace.get", {
    conversationId,
    topicId,
    runId,
    memberTurnId,
    attempt,
    ...(afterSeq > 0 ? { afterSeq } : {}),
    limit: 100,
  });
}

/** Collect a whole trace page, respecting the public page cap. */
async function fullTrace(cookie, inst, conversationId, topicId, runId, memberTurnId, attempt) {
  const events = [];
  let cursor = 0;
  for (;;) {
    const page = await tracePage(cookie, inst, conversationId, topicId, runId, memberTurnId, attempt, cursor);
    assertEqual(page?.memberTurnId, memberTurnId, `trace member id must round-trip for ${memberTurnId}/${attempt}`);
    assertEqual(page?.attempt, attempt, `trace attempt must round-trip for ${memberTurnId}/${attempt}`);
    events.push(...(page?.events ?? []));
    if (page?.hasMore !== true) return { ...page, events };
    assert(page?.nextSeq !== undefined && page.nextSeq > cursor, "trace page cursor must strictly advance");
    cursor = page.nextSeq;
  }
}

function assertCompleteTraceEvents(trace, memberPrefix) {
  assert(trace?.recordingState === "complete", `expected recordingState complete, got ${trace?.recordingState}`);
  assert(trace?.completenessReason === undefined, `expected complete recording without a completenessReason, got ${trace?.completenessReason}`);
  assert((trace?.events ?? []).length > 0, "complete trace must contain events");
  assert(trace.events.every((event, index, all) => index === 0 || all[index - 1].seq < event.seq), "trace events must be strictly monotonic in seq");
  assert(trace.events.some((event) => event.kind === "reasoning" && typeof event.payload?.text === "string"
    && event.payload.text.includes(`${memberPrefix}:public-thought`)), "expected reasoning (agent_thought_chunk) recorded");
  const tools = trace.events.filter((event) => event.kind === "tool" && event.payload?.step);
  assert(tools.length >= 2, `expected at least two tool events, got ${tools.length}`);
  assert(tools.every((event) => typeof event.payload.step.toolCallId === "string" && event.payload.step.toolCallId.length > 0), "tool events must carry toolCallId");
  // The persisted payload is the public ToolStepDto, whose status union is
  // running | success | error. ACP's pending/in_progress/completed wire states
  // are normalized by the shared presenter before the durable write.
  assert(tools.some((event) => event.payload.step.status === "running"), "expected a running tool step frame");
  assert(tools.some((event) => event.payload.step.status === "success"), "expected a successful tool update");
  assert(trace.events.some((event) => event.kind === "plan" && Array.isArray(event.payload?.entries)), "expected a plan event");
  assert(trace.events.some((event) => event.kind === "text" && typeof event.payload?.text === "string"
    && event.payload.text.includes(`${memberPrefix}:final-answer`)), "expected final agent_message_chunk text recorded");
  const terminals = trace.events.filter((event) => event.kind === "terminal");
  assertEqual(terminals.length, 1, "expected exactly one terminal event");
  assertEqual(terminals[0].payload ?? {}, { ok: true }, "expected a successful terminal event");
}

function assertNonEmptyTraceEvents(trace) {
  assert(trace?.recordingState !== undefined, "expected at least a trace record");
  assert((trace?.events ?? []).length > 0, "expected some trace events for the executing member");
}

/* ---- restart / kill / teardown ------------------------------------------ */

/** Forceful daemon kill (not a graceful stop): the open attempt must be
 *  observable afterwards as `interrupted` from the reconnected real daemon. */
function killDaemon(paths, pid, needle) {
  assert(processMatches(pid, needle), "daemon pid does not match the verifier's own daemon");
  killPidTree(pid, needle);
  rmSync(join(paths.root, "runtime", "daemon.pid"), { force: true });
}

async function startDaemon(paths, needle) {
  const connectBaseline = instanceConnectCount(paths.hubLog);
  spawnDetached(process.execPath, [needle, "start"], {
    cwd: repoRoot,
    env: daemonEnv(paths),
    logPath: paths.daemonLog,
  });
  label("daemon start requested");
  // `xacpx start` spawns the real daemon detached and exits, so the pid file —
  // not the short-lived launcher — is the authoritative daemon identity.
  const started = await waitForDaemonPid(paths, "daemon");
  assert(processMatches(started, needle), "the pid file must hold a process launched from this build");
  assert(
    await waitFor("instance reconnect", () => instanceConnectCount(paths.hubLog) > connectBaseline),
    "daemon did not connect to the hub",
  );
  return started;
}

/* ---- scenario mixins ----------------------------------------------------- */

/**
 * One Group Conversation + Topic whose members are the given adapter
 * letters: A/B before the forced restart, fresh letters afterwards (a
 * fenced Runtime worker session can never be re-adopted, so a fresh
 * post-restart Run needs fresh agents).
 */
async function groupSetup(cookie, inst, letters = ["a", "b"], title = "Restart Trace Proof") {
  const bots = [];
  for (const letter of letters) {
    bots.push((await rpc(cookie, inst, "control.bots.create", {
      name: `Trace ${letter.toUpperCase()}`,
      agent: `trace-agent-${letter}`,
      workspace: "verify",
    })).bot);
  }
  const group = (await rpc(cookie, inst, "control.groups.create", {
    title,
    botIds: bots.map((bot) => bot.id),
    leadBotId: bots[0].id,
  })).group;
  const topic = (await rpc(cookie, inst, "control.group.topics.create", {
    conversationId: group.id,
    title: "Main",
    target: { workspace: "verify", isolation: "shared" },
    maxConcurrentMemberTurns: 2,
  })).topic;
  return {
    groupId: group.id,
    topicId: topic.id,
    botAId: bots[0].id,
    botBId: bots[1].id,
    botNames: Object.fromEntries(bots.map((bot, index) => [bot.id, letters[index].toUpperCase()])),
  };
}

/**
 * Snapshot every started member of one Run into {memberTurnId, attempt, events}.
 *
 * With `requireRecording` the snapshot is only returned once the recorded page
 * is byte-stable across two reads: Core flushes trace batches asynchronously,
 * so a single read can catch a prefix that is still growing. Comparing a
 * mid-flush prefix against the post-restart page would be a false failure.
 */
async function snapshotsOfRun(cookie, inst, group, runId, conversationId, topicId, requireRecording) {
  const detail = await rpc(cookie, inst, "control.runs.get", { runId });
  const run = detail?.run;
  if (requireRecording && run?.state !== "running") return null;
  const pages = {};
  for (const member of run?.memberTurns ?? []) {
    const letter = group.botNames[member.botId];
    assert(letter, `unexpected member bot ${member.botId} in run ${runId}`);
    // A member that has not started a provider turn has no trace to snapshot:
    // it is queued behind the topic's concurrency policy, not recording.
    if (requireRecording && member.state !== "running") continue;
    const page = await tracePage(cookie, inst, conversationId, topicId, runId, member.id, member.attempt).catch(() => null);
    if (requireRecording) {
      // A held adapter emits the public thought, the plan and the tool step,
      // then stops. A stable prefix is therefore not empty and includes at
      // least one reasoning event and one tool step.
      const hasThought = (page?.events ?? []).some((event) =>
        event.kind === "reasoning" && typeof event.payload?.text === "string");
      const hasTool = (page?.events ?? []).some((event) =>
        event.kind === "tool" && event.payload?.step?.toolCallId);
      if (page?.recordingState !== "recording" || !hasThought || !hasTool) return null;
    }
    pages[letter] = { memberTurnId: member.id, attempt: member.attempt, events: page?.events ?? [] };
  }
  if (Object.keys(pages).length === 0) return null;
  if (!requireRecording) return pages;
  // Second read after the flush window: discard the snapshot if it still moves.
  await sleep(400);
  for (const [letter, snapshot] of Object.entries(pages)) {
    const again = await tracePage(cookie, inst, conversationId, topicId, runId, snapshot.memberTurnId, snapshot.attempt).catch(() => null);
    if (again?.recordingState !== "recording") return null;
    if (JSON.stringify(again.events ?? []) !== JSON.stringify(snapshot.events)) return null;
  }
  return pages;
}

async function createTopic(cookie, inst, conversationId, title, cap) {
  return (await rpc(cookie, inst, "control.group.topics.create", {
    conversationId,
    title,
    target: { workspace: "verify", isolation: "shared" },
    ...(cap !== undefined ? { maxConcurrentMemberTurns: cap } : {}),
  })).topic;
}

async function membersByLetter(cookie, inst, runId, botNames) {
  const { run } = await rpc(cookie, inst, "control.runs.get", { runId });
  const result = {};
  for (const member of run?.memberTurns ?? []) {
    const letter = botNames[member.botId];
    assert(letter, `unexpected member bot ${member.botId} in run ${runId}`);
    result[letter] = member;
  }
  return result;
}

/* ---- main ---------------------------------------------------------------- */

async function main() {
  const argv = process.argv.slice(2);
  const keep = argv.includes("--keep");
  const legacyIndex = argv.indexOf("--legacy-core");
  const legacyCore = legacyIndex >= 0 ? resolve(argv[legacyIndex + 1] ?? "") : undefined;

  const paths = statePaths();
  const report = {
    interrupted: { checked: false, members: [] },
    missingNoProviderStart: { checked: false, members: [] },
    legacy: { status: "unavailable", reason: "no --legacy-core pre-feature build supplied" },
    summary: [],
  };
  let stack;
  try {
    stack = await upStack(paths);
    const cookie = await loginRelay(stack.token);
    const inst = await requireInstance(cookie);
    label(`instance ${inst}`);

    const group = await groupSetup(cookie, inst);
    label(`group ${group.groupId} created with members A and B`);

    label("run 1 (Main): both members execute and complete");
    const run1 = (await toRun(cookie, inst, group, [group.botAId, group.botBId], "trace-proof-clean")).run;
    const run1Detail = await pollRunTerminal(cookie, inst, run1.id);
    assertEqual(run1Detail.state, "completed", "run 1 must complete");
    assertEqual((run1Detail.memberTurns ?? []).length, 2, "run 1 must have two member turns");
    const run1Members = await membersByLetter(cookie, inst, run1.id, group.botNames);
    assert(run1Members.A && run1Members.B, "expected member turns for A and B in run 1");
    assert(Number.isSafeInteger(run1Members.A.attempt) && run1Members.A.attempt >= 1
      && run1Members.A.attempt === run1Members.B.attempt, "run 1 member attempts must be the same non-zero attempt");
    assert(run1Members.A.state === "completed" && run1Members.B.state === "completed", "run 1 members must be completed");

    const countsAfterRun1 = readProviderAudit(paths.audit);
    assert(countsAfterRun1.A && countsAfterRun1.A.starts >= 1 && countsAfterRun1.A.finals >= 1,
      `member A must have reached provider start and answered for run 1 (${JSON.stringify(countsAfterRun1.A)})`);
    assert(countsAfterRun1.B && countsAfterRun1.B.starts >= 1 && countsAfterRun1.B.finals >= 1,
      `member B must have reached provider start and answered for run 1 (${JSON.stringify(countsAfterRun1.B)})`);
    label(`provider audit after run 1: ${JSON.stringify(countsAfterRun1)}`);

    const trace1A = await fullTrace(cookie, inst, group.groupId, group.topicId, run1.id, run1Members.A.id, run1Members.A.attempt);
    const trace1B = await fullTrace(cookie, inst, group.groupId, group.topicId, run1.id, run1Members.B.id, run1Members.B.attempt);
    assertCompleteTraceEvents(trace1A, "trace-A");
    assertCompleteTraceEvents(trace1B, "trace-B");
    label("before-restart per-member pages complete with progress + success + plan + final");

    // details.batch sanity: the batch cap and the whole page within it.
    const batch = await rpc(cookie, inst, "control.runs.details.batch", {
      conversationId: group.groupId,
      topicId: group.topicId,
      runIds: [run1.id],
    });
    assertEqual((batch?.runs ?? []).length, 1, "details.batch must return exactly one requested run");
    assert(batch?.runs?.[0]?.memberTurns?.length === 2, "details.batch must carry both member turns");

    label("run 2 (Main): members hold explicitly, trace open, then forced daemon restart");
    const run2 = (await toRun(cookie, inst, group, [group.botAId, group.botBId], "trace-proof-TRACE_HOLD")).run;
    assert(run2?.id && run2.id !== run1.id, "run 2 must be its own Run");
    const held2Snapshot = await waitFor("held members recording",
      async () => await snapshotsOfRun(cookie, inst, group, run2.id, group.groupId, group.topicId, true),
      TURN_TIMEOUT_MS);
    assert(held2Snapshot?.A?.memberTurnId, "held run must reach running with a recorded trace before the restart");
    const heldCounts = readProviderAudit(paths.audit);
    assert((heldCounts.A?.starts ?? 0) >= 1, "the held member must have reached provider start");
    const held2Members = {
      A: { id: held2Snapshot.A.memberTurnId, attempt: held2Snapshot.A.attempt },
    };
    // The second member is queued behind the held member (Group Topics
    // serialize work in one physical workspace), so it has NOT started a
    // provider turn and must never claim a fabricated trace.
    const queued2 = (await membersByLetter(cookie, inst, run2.id, group.botNames)).B;
    assert(queued2 && queued2.state !== "running" && queued2.state !== "completed"
      && queued2.state !== "failed", "the queued member must not be executing alongside the hold");
    const queuedBeforeKill = await tracePage(cookie, inst, group.groupId, group.topicId, run2.id, queued2.id, queued2.attempt);
    assertEqual(queuedBeforeKill.recordingState, "unavailable", "a queued member must report unavailable before it starts");
    assertEqual(queuedBeforeKill.completenessReason, "not-recorded", "a queued member must report not-recorded");
    assertEqual((queuedBeforeKill.events ?? []).length, 0, "a queued member must not fabricate events");
    label("held member has an open recording trace; the queued member has not started; arming the recovery gate");
    // Arm the recovery gate now that the hold is recording: the forced kill
    // below loses the pending adapter frames, and any post-restart recovery
    // re-dispatch of this turn is rejected cleanly instead of hanging.
    writeFileSync(paths.recoveryGate, "{}\n");
    const daemonNeedle = join(repoRoot, "dist", "cli.js");
    killDaemon(paths, stack.daemonPid, daemonNeedle);
    label("daemon killed; hub stays up");

    const restartedPid = await startDaemon(paths, daemonNeedle);
    label(`daemon restarted, pid ${restartedPid}; re-querying the established RPC`);

    const interrupted2A = await waitFor("interrupted trace A", async () => {
      const page = await fullTrace(cookie, inst, group.groupId, group.topicId, run2.id, held2Members.A.id, held2Members.A.attempt).catch(() => null);
      return page?.recordingState === "interrupted" ? page : null;
    }, RETRY_TIMEOUT_MS);
    assert(interrupted2A, "held member A must become explicitly interrupted after restart");
    assertNonEmptyTraceEvents(interrupted2A);
    assertEqual(interrupted2A.events, held2Snapshot.A.events, "member A interrupted trace must keep its exact pre-restart event sequence");
    const notStarted2B = await tracePage(cookie, inst, group.groupId, group.topicId, run2.id, queued2.id, queued2.attempt);
    assertEqual(notStarted2B.recordingState, "unavailable", "a member that never started must report unavailable");
    assertEqual(notStarted2B.completenessReason, "not-recorded", "a never-started member must report not-recorded");
    assertEqual((notStarted2B.events ?? []).length, 0, "a never-started member must not fabricate events");
    report.interrupted.checked = true;
    report.interrupted.members = [
      { memberTurnId: held2Members.A.id, attempt: held2Members.A.attempt, recordingState: interrupted2A.recordingState, events: (interrupted2A.events ?? []).length },
      { memberTurnId: queued2.id, attempt: queued2.attempt, recordingState: notStarted2B.recordingState, completenessReason: notStarted2B.completenessReason, events: 0 },
    ];
    report.summary.push("a queued member that never started reports unavailable/not-recorded with zero events");
    label("after-restart: explicitly interrupted held attempts, exact pre-restart event sequence preserved");

    const afterTrace1A = await fullTrace(cookie, inst, group.groupId, group.topicId, run1.id, run1Members.A.id, run1Members.A.attempt);
    const afterTrace1B = await fullTrace(cookie, inst, group.groupId, group.topicId, run1.id, run1Members.B.id, run1Members.B.attempt);
    assertEqual(afterTrace1A, trace1A, "member A page must be unchanged after restart");
    assertEqual(afterTrace1B, trace1B, "member B page must be unchanged after restart");
    assertEqual(afterTrace1A.memberTurnId, run1Members.A.id, "member A page identity must be stable");
    assertEqual(afterTrace1B.memberTurnId, run1Members.B.id, "member B page identity must be stable");
    report.summary.push("same per-member pages before and after the forced daemon restart (run 1)");
    label("after-restart per-member pages compare equal for the same attempt and seq order");

    label("run 3 (fresh Group): post-restart fresh members record complete per-member trace");
    const freshGroup = await groupSetup(cookie, inst, ["c", "d"], "Post-Restart Trace Proof");
    const run3 = (await toRun(cookie, inst, freshGroup, [freshGroup.botAId, freshGroup.botBId], "trace-proof-post-restart")).run;
    const run3Detail = await pollRunTerminal(cookie, inst, run3.id);
    assertEqual(run3Detail.state, "completed", "run 3 must complete after restart");
    const run3Members = await membersByLetter(cookie, inst, run3.id, freshGroup.botNames);
    const countsAfterRun3 = readProviderAudit(paths.audit);
    assert(countsAfterRun3.C && countsAfterRun3.C.finals > 0,
      "run 3 member C must answer through the real provider after the restart");
    assert(countsAfterRun3.D && countsAfterRun3.D.finals > 0,
      "run 3 member D must answer through the real provider after the restart");
    const trace3C = await fullTrace(cookie, inst, freshGroup.groupId, freshGroup.topicId, run3.id, run3Members.C.id, run3Members.C.attempt);
    const trace3D = await fullTrace(cookie, inst, freshGroup.groupId, freshGroup.topicId, run3.id, run3Members.D.id, run3Members.D.attempt);
    assertCompleteTraceEvents(trace3C, "trace-C");
    assertCompleteTraceEvents(trace3D, "trace-D");
    report.summary.push("post-restart fresh run records complete per-member trace (run 3)");
    label("post-restart fresh per-member traces complete with progress + success + plan + final");

    // The recovery seals the held rows (indeterminate/unknown); it must never
    // re-dispatch them into a new provider turn. `heldCounts` is the audit
    // snapshot taken after the held run started and before the kill, so any
    // growth here means the restarted daemon spawned a provider for a sealed
    // attempt. Run 3 uses fresh agents, so it cannot mask that.
    await sleep(3_000);
    const gateCounts = readProviderAudit(paths.audit);
    assertEqual(gateCounts.A?.starts ?? 0, heldCounts.A?.starts ?? 0, "member A provider process count must not grow from the post-restart recovery");
    assertEqual(gateCounts.B?.starts ?? 0, heldCounts.B?.starts ?? 0, "member B provider process count must not grow from the post-restart recovery");

    label("run 4 (Queued): B queued behind held A, then cancelled before provider start");
    const queuedGroup = await groupSetup(cookie, inst, ["e", "f"], "Queued Trace Proof");
    const queuedTopicId = (await createTopic(cookie, inst, queuedGroup.groupId, "Queued", 1)).id;
    const run4Hold = (await toRun(cookie, inst, { ...queuedGroup, topicId: queuedTopicId }, [queuedGroup.botAId], "trace-proof-TRACE_HOLD_QUEUED")).run;
    let hold4Seen = "no poll completed";
    const held4 = await waitFor("run 4 hold recording", async () => {
      const detail = await rpc(cookie, inst, "control.runs.get", { runId: run4Hold.id }).catch((error) => {
        hold4Seen = `runs.get error: ${error.message}`;
        return null;
      });
      const heldRun = detail.run;
      if (!heldRun) return null;
      if (heldRun.state !== "running") {
        hold4Seen = `run state ${heldRun.state}`;
        return null;
      }
      const member = heldRun.memberTurns?.[0];
      if (!member) {
        hold4Seen = "run running without a member turn";
        return null;
      }
      const page = await tracePage(cookie, inst, queuedGroup.groupId, queuedTopicId, run4Hold.id, member.id, member.attempt).catch((error) => {
        hold4Seen = `trace.get error: ${error.message}`;
        return null;
      });
      hold4Seen = `member ${member.id}/${member.attempt} state ${member.state} page ${page?.recordingState ?? "null"} events ${(page?.events ?? []).length}${page?.completenessReason ? ` reason ${page.completenessReason}` : ""}`;
      return page?.recordingState === "recording" && (page.events ?? []).length > 0 ? detail : null;
    }, TURN_TIMEOUT_MS);
    assert(held4, `run 4 hold must actually record at least one event before the queued run is cancelled (last seen: ${hold4Seen})`);
    const run4 = (await toRun(cookie, inst, { ...queuedGroup, topicId: queuedTopicId }, [queuedGroup.botBId], "trace-proof-queued")).run;
    const queuedDetail = (await rpc(cookie, inst, "control.runs.get", { runId: run4.id })).run;
    assertEqual(queuedDetail.state, "queued", "run 4 must be queued behind the cap");
    await rpc(cookie, inst, "control.runs.cancel", { runId: run4.id });
    const cancelledRun4 = await pollRunTerminal(cookie, inst, run4.id, CANCEL_TIMEOUT_MS);
    assertEqual(cancelledRun4.state, "cancelled", "run 4 must be cancelled");
    const cancelledMember = (await membersByLetter(cookie, inst, run4.id, queuedGroup.botNames)).F;
    assert(cancelledMember, "run 4 must have a member turn for F");
    assertEqual(cancelledMember.state, "cancelled", "run 4 member F must be cancelled");
    const countsAfterRun4 = readProviderAudit(paths.audit);
    assertEqual(countsAfterRun4.F?.starts ?? 0, 0, "cancelled run 4 member F must not have started the provider (process count)");
    assertEqual(countsAfterRun4.F?.prompts ?? 0, 0, "cancelled run 4 member F must not have reached provider prompt start (prompt count)");
    assertEqual(countsAfterRun4.F?.finals ?? 0, 0, "cancelled run 4 member F must not have answered through the provider (final count)");
    // Explicit baseline for a missing record: the read right after the cancel
    // and the waited read must agree on the same unavailable page.
    const baselineUnavailable = await rpc(cookie, inst, "control.runs.trace.get", {
      conversationId: queuedGroup.groupId,
      topicId: queuedTopicId,
      runId: run4.id,
      memberTurnId: cancelledMember.id,
      attempt: cancelledMember.attempt,
    });
    const unavailable4F = await waitFor("unavailable trace F", async () => {
      const page = await tracePage(cookie, inst, queuedGroup.groupId, queuedTopicId, run4.id, cancelledMember.id, cancelledMember.attempt).catch(() => null);
      return page?.recordingState === "unavailable" ? page : null;
    }, RETRY_TIMEOUT_MS);
    assert(unavailable4F, "cancelled-before-provider member must be explicitly unavailable");
    assertEqual(baselineUnavailable.recordingState, "unavailable", "missing-record baseline must be unavailable immediately after the cancel");
    assertEqual(unavailable4F.events, baselineUnavailable.events ?? [], "unavailable missing-record read must be stable after the cancel");
    assertEqual(unavailable4F.completenessReason, "not-recorded", "cancelled-before-provider member must say not-recorded");
    assertEqual(unavailable4F.events ?? [], [], "cancelled-before-provider member must have no fabricated trace events");
    assertEqual(unavailable4F.hasMore, false, "cancelled-before-provider member must have no more pages");
    report.missingNoProviderStart.members = [
      { memberTurnId: cancelledMember.id, attempt: cancelledMember.attempt, recordingState: unavailable4F.recordingState, completenessReason: unavailable4F.completenessReason },
    ];
    report.summary.push("explicit unavailable/not-recorded for a member cancelled before its provider turn starts (run 4)");
    label("explicit unavailable/not-recorded for a member cancelled before its provider turn starts");

    // Clean the still-held run 4 hold member so no provider turn lingers.
    await rpc(cookie, inst, "control.runs.cancel", { runId: run4Hold.id });
    const held4Run = await pollRunTerminal(cookie, inst, run4Hold.id, CANCEL_TIMEOUT_MS);
    assertEqual(held4Run.state, "cancelled", "run 4 hold must be cancelled");
    label("run 4 hold cancelled");

    await legacyScenario(paths, cookie, inst, group, legacyCore, report, { current: { pid: restartedPid, needle: daemonNeedle } });
    label("legacy scenario finished");
    await teardown(paths, { keep });
    printReport(report);
    label("acceptable: real daemon restart trace persisted");
  } catch (error) {
    // A failed scenario must not leave the isolated hub/daemon or their
    // providers running: the next run would fail on its own leftovers.
    if (stack) await teardown(paths, { keep }).catch(() => {});
    const message = error instanceof Error ? error.message : String(error);
    if (error instanceof Error && error.stack && !message.startsWith("assertion failed")) {
      process.stderr.write(`[verify-group-trace][stack] ${error.stack}\n`);
    }
    fail(message);
  }
}

/* ---- legacy -------------------------------------------------------------- */

/**
 * `--legacy-core <rel|abs path>` points an OPTIONAL pre-feature build. The
 * current feature build cannot produce a genuine pre-feature trace through
 * its public APIs, so when it is absent the report explicitly labels the
 * legacy check unavailable instead of silently skipping it.
 *
 * The pre-feature build's exact behavior against a current-built Group trace
 * is the durable store's own truth: the trace RPC either returns explicit
 * `unavailable`/`not-recorded` or an unsupported-RPC error; either way the
 * report names what happened.
 */
async function legacyScenario(paths, cookie, inst, group, legacyCore, report, options = {}) {
  if (!legacyCore) {
    label(`legacy trace check unavailable: ${report.legacy.reason}`);
    return;
  }
  report.legacy.status = "checked";
  report.legacy.reason = "pre-feature build supplied";
  assert(existsSync(legacyCore), `pre-feature core does not exist: ${legacyCore}`);
  const current = options.current;
  if (current?.pid) {
    killPidTree(current.pid, current.needle);
    rmSync(join(paths.root, "runtime", "daemon.pid"), { force: true });
  }
  let legacyPid = null;
  try {
    legacyPid = await startDaemon(paths, legacyCore);
    label(`pre-feature daemon pid ${legacyPid}`);
    let run;
    try {
      run = (await toRun(cookie, inst, group, [group.botAId, group.botBId], "trace-proof-legacy")).run;
    } catch (error) {
      // A pre-feature build may not implement the Group prompt RPC at all;
      // that is exactly the honest unavailability this scenario reports.
      label(`legacy prompt dispatch rejected (${error.message}): pre-feature build predates the required RPC`);
      report.summary.push(`legacy build rejected the Group prompt RPC: ${error.message}`);
      return;
    }
    const detail = await pollRunTerminal(cookie, inst, run.id);
    assertEqual(detail.state, "completed", "legacy run must complete");
    const legacyMembers = await membersByLetter(cookie, inst, run.id, group.botNames);
    for (const member of [legacyMembers.A, legacyMembers.B]) {
      const read = await tracePage(cookie, inst, group.groupId, group.topicId, run.id, member.id, member.attempt)
        .then((page) => ({ page }))
        .catch((error) => ({ error: error.message }));
      const page = read.page;
      if (!page || page.recordingState === undefined) {
        label(`legacy trace read stays unavailable (${read.error ?? "no trace returned"}): pre-feature build has no recorded trace`);
        continue;
      }
      assertEqual(page.recordingState, "unavailable", `legacy run must be unavailable, got ${page.recordingState}`);
      assertEqual(page.completenessReason, "not-recorded", "legacy member must say not-recorded");
      assertEqual(page.events ?? [], [], "legacy member must have no fabricated trace events");
    }
    report.summary.push("pre-feature run answered with explicit unavailable/not-recorded through the real trace RPC");
    label("legacy run returned explicit unavailable/not-recorded through the real pre-feature build");
  } finally {
    // POSIX sweepProcesses is a no-op, so kill the tracked pid directly and
    // keep the sweep as belt-and-braces for Windows stragglers.
    if (legacyPid) killPidTree(legacyPid, legacyCore);
    killDaemonLegacy(paths, legacyCore);
  }
}

function killDaemonLegacy(paths, legacyCore) {
  const survivors = sweepProcesses([legacyCore]);
  for (const pid of survivors) {
    killPidTree(pid, legacyCore);
  }
  rmSync(join(paths.root, "runtime", "daemon.pid"), { force: true });
}

/* ---- teardown ------------------------------------------------------------ */

async function teardown(paths, options = {}) {
  const { keep } = options;
  for (const needle of [join(repoRoot, "packages", "relay", "dist", "cli.js"), join(repoRoot, "dist", "cli.js")]) {
    for (const pid of sweepProcesses([needle])) {
      killPidTree(pid, needle);
    }
  }
  for (const pid of sweepProcesses(["group-trace-acp-agent"])) {
    killPidTree(pid, "group-trace-acp-agent");
  }
  const survivors = sweepProcesses([paths.root, "group-trace-acp-agent"]);
  if (survivors.length > 0) {
    label(`warning: leftover processes ${survivors.join(", ")}`);
    process.exitCode = 1;
  }
  if (keep) {
    label(`state kept for inspection under ${paths.root}`);
    return;
  }
  for (let attempt = 0; attempt < 15; attempt += 1) {
    try {
      rmSync(paths.root, { recursive: true, force: true });
      label("teardown complete");
      return;
    } catch (error) {
      // Windows releases process handles lazily after taskkill; retry briefly.
      if (attempt === 14) label(`could not remove state dir: ${error.message}`);
    }
    await sleep(200);
  }
}

function printReport(report) {
  process.stdout.write(`[verify-group-trace][report] ${JSON.stringify(report, null, 2)}\n`);
}

/* ---- entry -------------------------------------------------------------- */

await main();
