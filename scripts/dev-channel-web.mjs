#!/usr/bin/env node
/**
 * Run the local channel plugins from this checkout instead of npm.
 *
 * Debugging a channel plugin otherwise means publishing a beta and upgrading,
 * which costs a round trip for every fix. This links the checkout into the
 * plugin home so the running daemon loads the builds under `packages/*`.
 *
 * Two resolutions have to be satisfied, and both are easy to get wrong:
 *
 * 1. The daemon imports a plugin by its bare name through the plugin home's
 *    `node_modules`, so each linked package needs an entry there.
 * 2. Plugins built with `--external xacpx` import `xacpx/plugin-api`, which the
 *    daemon normally satisfies with a resolution shim inside the plugin home.
 *    A junction makes Node resolve that import from the CHECKOUT instead, so
 *    the checkout needs the same shim or every plugin fails to load.
 *
 * `--unlink` restores the npm-installed copies saved by `--link`.
 *
 *   node ./scripts/dev-channel-web.mjs           # link this checkout
 *   node ./scripts/dev-channel-web.mjs --build   # rebuild, then link
 *   node ./scripts/dev-channel-web.mjs --unlink  # go back to the npm package
 */
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readdirSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PLUGIN_HOME = process.env.XACPX_PLUGIN_HOME ?? join(homedir(), ".xacpx", "plugins");
const SCOPE = join(PLUGIN_HOME, "node_modules", "@ganglion");
// `web` is the dashboard the local console serves: `channel-web` resolves its
// webRoot through `@ganglion/xacpx-web`, so leaving it out serves whatever the
// last npm install left behind and every dashboard build in this checkout is
// silently ignored.
const PACKAGES = ["channel-web", "channel-relay", "web"];
const BACKUP_SUFFIX = ".npm-backup";
const SHIM_DIR = join(PLUGIN_HOME, "node_modules", "xacpx");

const options = new Set(process.argv.slice(2));

function log(message) {
  console.log(`dev-channel-web: ${message}`);
}

function run(command, args, cwd = ROOT) {
  // `bun` on Windows is a .cmd shim, so it needs a shell to be found.
  const needsShell = process.platform === "win32" && command === "bun";
  execFileSync(command, args, { cwd, stdio: "inherit", shell: needsShell });
}

/**
 * The `xacpx/plugin-api` shim, written in whichever tree Node will resolve it
 * from. The daemon writes the plugin-home copy; the checkout needs its own the
 * moment a junction points a plugin here.
 */
function writeShim(targetDir) {
  const bundle = join(ROOT, "dist", "plugin-api.js");
  if (!existsSync(bundle)) {
    throw new Error("dist/plugin-api.js is missing; run `bun run build` first");
  }
  mkdirSync(targetDir, { recursive: true });
  copyFileSync(bundle, join(targetDir, "plugin-api.js"));
  writeFileSync(
    join(targetDir, "package.json"),
    JSON.stringify({ name: "xacpx", type: "module", exports: { "./plugin-api": "./plugin-api.js" } }, null, 2) + "\n",
  );
  log(`wrote the plugin-api shim into ${targetDir}`);
}

/** A directory junction on Windows, a symlink elsewhere. */
function link(source, target) {
  if (process.platform === "win32") {
    execFileSync("cmd", ["/c", "mklink", "/J", target, source], { stdio: "pipe" });
    return;
  }
  execFileSync("ln", ["-s", source, target], { stdio: "pipe" });
}

/** True when `target` is already a link whose destination is `source`. */
function isLinkedTo(target, source) {
  try {
    const resolved = realpathSync(target);
    return resolved === realpathSync(source);
  } catch {
    return false;
  }
}

function linkPackages() {
  if (options.has("--build")) {
    log("building channel-web (which builds the dashboard, control bridge and channel-relay first)");
    run("bun", ["run", "build:channel-web"]);
  }
  for (const name of PACKAGES) {
    const source = join(ROOT, "packages", name);
    // `web` ships its entry at the package root (index.js) and the dashboard under
    // dist/; the channel packages build their entry into dist/index.js.
    const entry = name === "web"
      ? join(source, "dist", "index.html")
      : join(source, "dist", "index.js");
    if (!existsSync(entry)) {
      throw new Error(`${name} is not built; run with --build or \`bun run build:channel-web\``);
    }
    const target = join(SCOPE, `xacpx-${name}`);
    const backup = `${target}${BACKUP_SUFFIX}`;
    // Re-linking an already-linked package must be a no-op. Renaming it again would
    // collide with the backup kept on the first run (EPERM) and, worse, leave the
    // checkout's build replaced by its own backup.
    if (isLinkedTo(target, source)) {
      log(`${name} already linked -> ${source}`);
      continue;
    }
    // A junction to a path that no longer exists looks like a file to some
    // tools, so remove without following it. Only keep a backup when there is a
    // real npm copy to keep.
    if (existsSync(target) || readdirSync(SCOPE).includes(`xacpx-${name}`)) {
      if (!existsSync(backup)) {
        renameSync(target, backup);
        log(`kept the npm copy as ${name}${BACKUP_SUFFIX}`);
      } else {
        rmSync(target, { recursive: true, force: true });
      }
    }
    link(source, target);
    log(`linked ${name} -> ${source}`);
  }
  writeShim(join(ROOT, "node_modules", "xacpx"));
  writeShim(SHIM_DIR);
  log("restart the daemon to pick this up: node ./dist/cli.js restart");
}

function unlinkPackages() {
  for (const name of PACKAGES) {
    const target = join(SCOPE, `xacpx-${name}`);
    const backup = `${target}${BACKUP_SUFFIX}`;
    if (existsSync(target)) {
      rmSync(target, { recursive: true, force: true });
      log(`removed the link for ${name}`);
    }
    if (existsSync(backup)) {
      renameSync(backup, target);
      log(`restored the npm copy of ${name}`);
    }
  }
  rmSync(join(ROOT, "node_modules", "xacpx"), { recursive: true, force: true });
  log("removed the checkout plugin-api shim");
  log("restart the daemon to go back to the npm packages: node ./dist/cli.js restart");
}

/**
 * The terminal needs the platform RMUX package, and the root lockfile does not carry a
 * resolved entry for it — so `bun install` never fetches one and the console comes up
 * with `terminal: false` behind a single log line. Linking the relay plugin from source
 * is exactly the flow that exposes this, so close it here rather than relying on a
 * developer noticing the degradation.
 */
function ensureRmuxPlatform() {
  run(process.execPath, [join(ROOT, "scripts", "ensure-rmux-platform.mjs")]);
}

if (options.has("--unlink")) {
  unlinkPackages();
} else {
  ensureRmuxPlatform();
  linkPackages();
}
