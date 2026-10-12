#!/usr/bin/env node
/**
 * Throwaway full-stack harness for verifying xacpx features on the real surface.
 *
 * Boots an isolated daemon + relay hub + bundled dashboard so a feature can be
 * driven through the actual Web UI, then tears everything down without leaving
 * processes, files, or writes in the real home directory.
 *
 * Usage:
 *   node ./scripts/verify-stack.mjs up [--port 18787] [--router-ready]
 *   node ./scripts/verify-stack.mjs status
 *   node ./scripts/verify-stack.mjs down
 *   node ./scripts/verify-stack.mjs doctor
 *
 * Flags:
 *   --port <n>       Hub HTTP port. Default 18787.
 *   --router-ready   Write a restricted router command and enable it, so the
 *                    daemon starts with automatic collaboration `ready`.
 *
 * What `up` builds, all under <tmp>/xacpx-verify-stack:
 *   - config.json / state.json for the daemon
 *   - a plugin home holding the WORKSPACE builds of channel-relay and
 *     relay-protocol (the published packages lack unreleased RPCs)
 *   - a relay hub database with one access token
 *   - the hub process and the daemon process, both detached from this shell
 *
 * Isolation rules the harness enforces (each one exists because skipping it
 * broke a real run):
 *   - HOME is redirected. The relay connector keeps its credential in
 *     `<home>/.xacpx/relay/credential.json`; without this the daemon pairs
 *     against the operator's real hub and the handshake fails with auth-failed.
 *   - XACPX_PLUGIN_HOME is redirected so the operator's installed plugins are
 *     neither read nor rewritten.
 *   - WEACPX_CONFIG / WEACPX_STATE keep every daemon write inside the state dir.
 *
 * Teardown rules:
 *   - Only PIDs recorded in the manifest are ever signalled, and each one is
 *     re-identified by command line before it is killed, so a reused PID is
 *     never shot.
 *   - `down` compares the real home against the snapshot taken at `up` and
 *     reports any file it touched.
 *   - `doctor` is the stateless check: leftover processes, a busy port, or a
 *     stray scheduled task from an older manual run.
 *
 * NOTE: Opt-in developer tooling. Not part of `npm test`.
 */

import { spawn, spawnSync } from "node:child_process";
import {
  closeSync,
  cpSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const STATE_ROOT = join(tmpdir(), "xacpx-verify-stack");
const DEFAULT_PORT = 18787;
const PLUGIN_SKIP = [/^@ganglion\/xacpx-rmux-bridge-/];
const HUB_LABEL = "verify-stack";
const STARTUP_TIMEOUT_MS = 60_000;

export const manifestPath = () => join(STATE_ROOT, "manifest.json");
export const statePaths = (port = DEFAULT_PORT) => ({
  root: STATE_ROOT,
  config: join(STATE_ROOT, "config.json"),
  state: join(STATE_ROOT, "state.json"),
  plugins: join(STATE_ROOT, "plugins"),
  relayDb: join(STATE_ROOT, "relay.db"),
  home: join(STATE_ROOT, "home"),
  hubLog: join(STATE_ROOT, "hub.log"),
  daemonLog: join(STATE_ROOT, "daemon.log"),
  router: join(STATE_ROOT, "router.mjs"),
  port,
});

function log(message) {
  process.stdout.write(`[verify-stack] ${message}\n`);
}

function fail(message) {
  process.stderr.write(`[verify-stack][error] ${message}\n`);
  process.exit(1);
}

function parseFlags(argv) {
  const flags = new Set(argv.filter((a) => a.startsWith("--")));
  const portIndex = argv.indexOf("--port");
  const port = portIndex >= 0 ? Number(argv[portIndex + 1]) : DEFAULT_PORT;
  return { flags, port, routerReady: flags.has("--router-ready") };
}

/**
 * Dependency closure of the connector plugin, resolved from the repository's
 * own node_modules so a future dependency change fails at `up` with a name
 * instead of a mid-run "Cannot find module".
 */
export function planPluginHome(repoRootDir = repoRoot) {
  const nodeModules = join(repoRootDir, "node_modules");
  const plan = [];
  const seen = new Set();
  const queue = ["@ganglion/xacpx-channel-relay"];
  const missing = [];
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
    plan.push({ name, source, target: join(STATE_ROOT, "plugins", "node_modules", name) });
    const manifest = JSON.parse(readFileSync(manifestFile, "utf8"));
    for (const dep of Object.keys(manifest.dependencies ?? {})) {
      if (PLUGIN_SKIP.some((pattern) => pattern.test(dep))) continue;
      queue.push(dep);
    }
  }
  return { plan, missing };
}

export function buildIsolatedConfig(input) {
  const { port, token, routerCommand, workdir } = input;
  return {
    transport: {
      type: "acpx-cli",
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
    agents: { codex: { driver: "codex" } },
    workspaces: { verify: { cwd: workdir } },
    orchestration: {},
    ...(routerCommand ? { conversations: { router: { enabled: true, command: routerCommand } } } : {}),
  };
}

/** `xacpx-relay add token` prints the secret once, on its own labelled line. */
export function parseAccessToken(stdout) {
  const match = /access token:\s*(\S+)/.exec(stdout);
  return match ? match[1] : null;
}

export function daemonEnv(paths) {
  return {
    ...process.env,
    WEACPX_CONFIG: paths.config,
    WEACPX_STATE: paths.state,
    XACPX_PLUGIN_HOME: paths.plugins,
    HOME: paths.home,
  };
}

export function isAlive(pid) {
  if (!pid || !Number.isInteger(pid)) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * True when the live process still looks like the one we started. Guards every
 * kill against PID reuse: a recycled PID must never be signalled.
 */
export function processMatches(pid, needle) {
  if (!isAlive(pid)) return false;
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

async function waitFor(label, predicate, timeoutMs = STARTUP_TIMEOUT_MS) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await predicate();
    if (value) return value;
    if (Date.now() > deadline) {
      log(`${label} did not come up within ${timeoutMs}ms`);
      return null;
    }
    await new Promise((r) => setTimeout(r, 500));
  }
}

function require(label, value) {
  if (!value) fail(`${label} did not come up in time. Check the logs under ${STATE_ROOT}.`);
  return value;
}

function spawnDetached(command, args, options) {
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

function readManifest() {
  const file = manifestPath();
  if (!existsSync(file)) return null;
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

function writeManifest(manifest) {
  writeFileSync(manifestPath(), `${JSON.stringify(manifest, null, 2)}\n`);
}

/** mtime fingerprint of the operator's real state, taken before and after. */
function snapshotRealHome() {
  const home = process.env.USERPROFILE ?? process.env.HOME;
  const base = join(home, ".xacpx");
  const targets = [
    join(base, "config.json"),
    join(base, "state.json"),
    join(base, "relay", "credential.json"),
    join(base, "plugins", "package.json"),
    join(base, "plugins", "node_modules", "@ganglion"),
  ];
  const snapshot = {};
  for (const target of targets) {
    try {
      snapshot[target] = statSync(target).mtimeMs;
    } catch {
      snapshot[target] = null;
    }
  }
  return snapshot;
}

function diffSnapshot(before, after) {
  const changed = [];
  for (const [path, mtime] of Object.entries(before)) {
    if (after[path] !== mtime) changed.push(path);
  }
  return changed;
}

function readHubLog(path) {
  try {
    return readFileSync(path, "utf8").includes("instance connected");
  } catch {
    return false;
  }
}

async function httpOk(url) {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(2000) });
    return response.status > 0;
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

/**
 * Every live process whose command line references `needle`. Used to prove a
 * teardown left nothing behind, and to find a stack the manifest forgot.
 */
export function sweepProcesses(needle) {
  if (process.platform !== "win32") return [];
  const result = spawnSync(
    "powershell",
    ["-NoProfile", "-Command", `Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -like '*${needle}*' } | Select-Object -ExpandProperty ProcessId`],
    { encoding: "utf8" },
  );
  if (result.error || result.status !== 0) return [];
  return (result.stdout ?? "")
    .split(/\s+/)
    .filter(Boolean)
    .map(Number)
    .filter((pid) => Number.isInteger(pid) && pid > 0 && pid !== process.pid);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const ROUTER_SOURCE = `// Restricted router for verification runs. Prints the seven
// capability flags on --capabilities and dispatches one member on --decide.
const args = process.argv.slice(2);
if (args.includes("--capabilities")) {
  process.stdout.write(JSON.stringify({
    toolsDisabled: true,
    filesystemDisabled: true,
    terminalDisabled: true,
    permissionInteractionDisabled: true,
    messagingDisabled: true,
    orchestrationDisabled: true,
    structuredOutputOnly: true,
  }));
} else if (args.includes("--decide")) {
  let raw = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => { raw += chunk; });
  process.stdin.on("end", () => {
    const input = JSON.parse(raw);
    const first = input.memberMetadata.find((member) => member.enabled);
    process.stdout.write(JSON.stringify({
      type: "dispatch",
      mode: "single",
      assignments: [{
        id: "step-1",
        botId: first.botId,
        task: "Review the patch",
        triggerMessageIds: [input.requestMessageId],
      }],
    }));
  });
}
`;

async function up(argv) {
  const { port, routerReady } = parseFlags(argv);
  const paths = statePaths(port);
  const existing = readManifest();
  if (existing && (isAlive(existing.hubPid) || isAlive(existing.daemonPid))) {
    fail(`a stack is already up (hub pid ${existing.hubPid}). Run: node ./scripts/verify-stack.mjs down`);
  }
  rmSync(paths.root, { recursive: true, force: true });
  for (const dir of [paths.root, paths.plugins, paths.home, join(paths.root, "ws")]) {
    mkdirSync(dir, { recursive: true });
  }

  const occupied = portOwner(port);
  if (occupied) {
    fail(`port ${port} is held by pid ${occupied}, which this harness did not start. Pick another --port.`);
  }
  const leftovers = sweepProcesses(STATE_ROOT);
  if (leftovers.length > 0) {
    fail(`leftover processes from an earlier run: ${leftovers.join(", ")}. Run down, or stop them, then retry.`);
  }

  const { plan, missing } = planPluginHome();
  if (missing.length > 0) {
    fail(`plugin home dependency closure is incomplete in node_modules: ${missing.join(", ")}. Run bun install.`);
  }
  for (const entry of plan) {
    mkdirSync(dirname(entry.target), { recursive: true });
    cpSync(entry.source, entry.target, { recursive: true, dereference: true });
  }
  log(`plugin home ready: ${plan.map((p) => p.name).join(", ")}`);

  const minted = spawnSync(
    process.execPath,
    [join("packages", "relay", "dist", "cli.js"), "add", "token", "--db", paths.relayDb, "--label", HUB_LABEL],
    { cwd: repoRoot, encoding: "utf8" },
  );
  if (minted.status !== 0) fail(`could not mint a hub token: ${minted.stderr ?? minted.stdout}`);
  const token = parseAccessToken(minted.stdout ?? "");
  if (!token) fail(`could not parse the access token from: ${minted.stdout}`);

  const config = buildIsolatedConfig({
    port,
    token,
    workdir: join(paths.root, "ws"),
    ...(routerReady ? { routerCommand: paths.router } : {}),
  });
  writeFileSync(paths.config, `${JSON.stringify(config, null, 2)}\n`);
  if (routerReady) writeFileSync(paths.router, ROUTER_SOURCE);

  const homeBefore = snapshotRealHome();
  writeManifest({
    createdAt: new Date().toISOString(),
    port,
    stateRoot: paths.root,
    homeBefore,
    hubPid: null,
    daemonPid: null,
    token,
  });

  const hubPid = spawnDetached(
    process.execPath,
    [join("packages", "relay", "dist", "cli.js"), "start", "--db", paths.relayDb, "--http-port", String(port), "--host", "127.0.0.1", "--web-root", join("packages", "relay", "dist", "relay-web")],
    { cwd: repoRoot, env: process.env, logPath: paths.hubLog },
  );
  log(`hub pid ${hubPid} on http://127.0.0.1:${port}`);
  require("hub", await waitFor("hub", () => httpOk(`http://127.0.0.1:${port}/api/version`)));
  log("hub is answering");

  spawnDetached(process.execPath, [join("dist", "cli.js"), "start"], {
    cwd: repoRoot,
    env: daemonEnv(paths),
    logPath: paths.daemonLog,
  });
  log("daemon start requested");
  const pidFile = join(paths.root, "runtime", "daemon.pid");
  const daemonPid = await waitFor("daemon pid file", () => {
    try {
      const pid = Number(readFileSync(pidFile, "utf8").trim());
      return Number.isInteger(pid) && pid > 0 ? pid : null;
    } catch {
      return null;
    }
  });
  require("daemon pid file", daemonPid);
  require("instance connect", await waitFor("instance connect", () => readHubLog(paths.hubLog)));
  log(`daemon pid ${daemonPid}, instance connected to the hub`);

  const manifest = readManifest();
  writeManifest({ ...manifest, hubPid, daemonPid });

  log("");
  log(`dashboard  http://127.0.0.1:${port}/`);
  log(`token      ${token}`);
  log(`state dir  ${paths.root}`);
  log(`teardown   node ./scripts/verify-stack.mjs down`);
  if (routerReady) log("router     enabled with a restricted command, so availability starts ready");
}

function stopDaemon(paths) {
  const result = spawnSync(process.execPath, [join("dist", "cli.js"), "stop"], {
    cwd: repoRoot,
    env: daemonEnv(paths),
    encoding: "utf8",
  });
  return `${(result.stdout ?? "").trim()}${(result.stderr ?? "").trim()}`.trim();
}

function killPid(pid, stateRoot) {
  if (!isAlive(pid)) return "already gone";
  if (!processMatches(pid, stateRoot)) {
    return `refused: pid ${pid} no longer matches this stack`;
  }
  try {
    process.kill(pid, "SIGKILL");
    return "killed";
  } catch (error) {
    return `failed: ${error.message}`;
  }
}

/**
 * Remove the state dir entry by entry so one locked file cannot take the whole
 * teardown down with it. The manifest is removed last, so a failed teardown
 * still leaves a manifest for the next `down` to read.
 */
export function removeStateDir(root) {
  const problems = [];
  let entries = [];
  try {
    entries = readdirSync(root);
  } catch {
    return problems;
  }
  for (const entry of entries) {
    if (entry === "manifest.json") continue;
    try {
      rmSync(join(root, entry), { recursive: true, force: true, maxRetries: 3 });
    } catch (error) {
      problems.push(`could not remove ${join(root, entry)}: ${error.message}`);
    }
  }
  for (const entry of ["manifest.json", ""]) {
    try {
      rmSync(join(root, entry), { recursive: true, force: true, maxRetries: 3 });
    } catch (error) {
      problems.push(`could not remove ${join(root, entry) || root}: ${error.message}`);
    }
  }
  return problems;
}

async function down() {
  const manifest = readManifest();
  const paths = statePaths(manifest?.port ?? DEFAULT_PORT);
  const problems = [];
  try {
    if (manifest) {
      log(`stopping daemon (pid ${manifest.daemonPid ?? "unknown"})`);
      const stopped = stopDaemon(paths);
      log(`daemon stop: ${stopped || "no output"}`);
      await sleep(1500);
      log(`killing hub (pid ${manifest.hubPid ?? "unknown"}): ${killPid(manifest.hubPid, paths.root)}`);
      log(`killing daemon (pid ${manifest.daemonPid ?? "unknown"}): ${killPid(manifest.daemonPid, paths.root)}`);
    } else {
      log("no manifest recorded; recovering from leftovers by path");
    }

    const survivors = sweepProcesses(paths.root);
    for (const pid of survivors) {
      log(`sweeping leftover pid ${pid}: ${killPid(pid, paths.root)}`);
    }
    if (survivors.length > 0) await sleep(1000);

    const remaining = sweepProcesses(paths.root);
    if (remaining.length > 0) problems.push(`processes still reference the state dir: ${remaining.join(", ")}`);
    if (portOwner(paths.port)) problems.push(`port ${paths.port} is still held after teardown`);

    if (manifest) {
      const changed = diffSnapshot(manifest.homeBefore ?? {}, snapshotRealHome());
      if (changed.length > 0) {
        problems.push(`the real home changed during this run: ${changed.join(", ")}`);
      } else {
        log("real home untouched");
      }
    }

    problems.push(...removeStateDir(paths.root));
    if (problems.length === 0) log(`removed ${paths.root}`);
  } catch (error) {
    problems.push(`teardown error: ${error.message}`);
  }

  if (problems.length > 0) {
    for (const problem of problems) log(`PROBLEM ${problem}`);
    process.exitCode = 1;
    return;
  }
  log("teardown complete: no processes, no port, no state dir");
}

async function status() {
  const manifest = readManifest();
  if (!manifest) {
    log("no stack recorded");
    return;
  }
  const paths = statePaths(manifest.port);
  const rows = [
    ["state dir", existsSync(manifest.stateRoot) ? manifest.stateRoot : "missing"],
    ["hub pid", `${manifest.hubPid ?? "-"} alive=${isAlive(manifest.hubPid)}`],
    ["daemon pid", `${manifest.daemonPid ?? "-"} alive=${isAlive(manifest.daemonPid)}`],
    ["port owner", String(portOwner(manifest.port) ?? "free")],
    ["dashboard", (await httpOk(`http://127.0.0.1:${manifest.port}/api/version`)) ? "answering" : "down"],
    ["hub log", paths.hubLog],
    ["daemon log", paths.daemonLog],
  ];
  for (const [key, value] of rows) log(`${key.padEnd(12)} ${value}`);
}

async function doctor() {
  const problems = [];
  const manifest = readManifest();
  if (manifest) {
    if (isAlive(manifest.hubPid)) problems.push(`hub pid ${manifest.hubPid} is still running`);
    if (isAlive(manifest.daemonPid)) problems.push(`daemon pid ${manifest.daemonPid} is still running`);
    if (portOwner(manifest.port)) problems.push(`port ${manifest.port} is still held`);
    problems.push(`state dir ${manifest.stateRoot} still exists; run down`);
  }
  const survivors = sweepProcesses(STATE_ROOT);
  if (survivors.length > 0) problems.push(`leftover verify-stack processes: ${survivors.join(", ")}`);
  if (process.platform === "win32") {
    const task = spawnSync("schtasks", ["/query", "/tn", "xacpx-verify-stack"], { encoding: "utf8" });
    if (task.status === 0) problems.push("stray scheduled task xacpx-verify-stack exists; delete it");
  }
  if (portOwner(DEFAULT_PORT)) problems.push(`port ${DEFAULT_PORT} is held by pid ${portOwner(DEFAULT_PORT)}`);
  if (problems.length > 0) {
    for (const problem of problems) log(`PROBLEM ${problem}`);
    process.exitCode = 1;
    return;
  }
  log("clean: no processes, no port, no state dir, no scheduled task");
}

const commands = { up, down, status, doctor };
const invokedDirectly =
  typeof process.argv[1] === "string" && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  const command = process.argv[2];
  if (!commands[command]) {
    fail(`usage: node ./scripts/verify-stack.mjs <${Object.keys(commands).join("|")}> [--port <n>] [--router-ready]`);
  }
  await commands[command](process.argv.slice(3));
}
