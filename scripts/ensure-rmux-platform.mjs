#!/usr/bin/env node
/**
 * Ensure the current platform's RMUX bridge package is installed and complete.
 *
 * `packages/channel-relay/package.json` declares `@ganglion/xacpx-rmux-bridge-<os>-<arch>`
 * as optional dependencies, but the root `bun.lock` carries only those declarations and
 * no resolved entry for them. Bun therefore never installs one, and a fresh checkout
 * builds and serves with `terminal: false`: the runtime is "gracefully degraded", so the
 * only trace is a log line at startup:
 *
 *   platform RMUX package is incomplete: dedicated rmux-daemon is missing beside …
 *
 * The degraded path is deliberately quiet for end users (their plugin install does
 * fetch the optional package correctly), which is exactly why a developer can lose the
 * terminal without noticing. This script closes that gap for local development.
 *
 * Completeness mirrors `packages/channel-relay/src/terminal/resolve-rmux-binaries.ts`:
 * a platform package whose `bin/` lacks the dedicated `rmux-daemon` cannot be used, and
 * the resolver refuses to fall back to a PATH daemon rather than risk version skew.
 *
 * Usage:
 *   node ./scripts/ensure-rmux-platform.mjs           # install when missing/incomplete
 *   node ./scripts/ensure-rmux-platform.mjs --check   # exit 1 instead of installing
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const REGISTRY = "https://registry.npmjs.org";

/** Same naming as the runtime resolver, so an install here is the one it looks for. */
export function platformPackageName(platform = process.platform, arch = process.arch) {
  const os = platform === "darwin" ? "darwin" : platform === "linux" ? "linux" : platform === "win32" ? "win32" : platform;
  return `@ganglion/xacpx-rmux-bridge-${os}-${arch}`;
}

/** The version channel-relay asks npm for, so both agree instead of drifting. */
export function expectedVersion(repoRoot, name) {
  const relay = JSON.parse(readFileSync(join(repoRoot, "packages/channel-relay/package.json"), "utf8"));
  return relay.optionalDependencies?.[name] ?? String(relay.version ?? "") ?? "";
}

/**
 * @returns {{ present: boolean, version: string | null, bridge: boolean, daemon: boolean, complete: boolean }}
 */
export function inspectPlatformPackage(repoRoot, name, platform = process.platform) {
  const pkgDir = join(repoRoot, "node_modules", ...name.split("/"));
  const pkgJsonPath = join(pkgDir, "package.json");
  if (!existsSync(pkgJsonPath)) {
    return { present: false, version: null, bridge: false, daemon: false, complete: false };
  }
  let version = null;
  try {
    version = String(JSON.parse(readFileSync(pkgJsonPath, "utf8")).version ?? "") || null;
  } catch {
    version = null;
  }
  const exe = platform === "win32" ? ".exe" : "";
  const bridge = existsSync(join(pkgDir, "bin", `xacpx-rmux-bridge${exe}`));
  // The resolver accepts the bare name too; Windows ships the .exe form.
  const daemon = existsSync(join(pkgDir, "bin", `rmux-daemon${exe}`))
    || existsSync(join(pkgDir, "bin", "rmux-daemon"))
    || existsSync(join(pkgDir, "bin", "rmux-daemon.exe"));
  return { present: true, version, bridge, daemon, complete: bridge && daemon };
}

/** @returns {string[]} human-readable problems (empty when usable) */
export function collectProblems(repoRoot, name, platform = process.platform) {
  const expected = expectedVersion(repoRoot, name);
  const state = inspectPlatformPackage(repoRoot, name, platform);
  if (!state.present) return [`${name} is not installed (wanted ${expected})`];
  const problems = [];
  if (expected && state.version !== expected) {
    problems.push(`${name} is ${state.version}, expected ${expected}`);
  }
  if (!state.bridge) problems.push(`${name}/bin is missing xacpx-rmux-bridge`);
  if (!state.daemon) problems.push(`${name}/bin is missing the dedicated rmux-daemon`);
  return problems;
}

function install(name) {
  const version = expectedVersion(root, name);
  // Bun treats an existing copy as installed and will not repair missing files, so a
  // package that is present but incomplete (the shape that ships a bridge without its
  // dedicated daemon) has to be removed first. Without this the repair silently
  // "installs" a package that still cannot start.
  rmSync(join(root, "node_modules", ...name.split("/")), { recursive: true, force: true });
  const useBun = commandExists("bun", ["--version"]);
  const args = useBun
    ? ["add", "--no-save", `${name}@${version}`]
    : ["install", "--no-save", "--no-audit", "--no-fund", `--registry=${REGISTRY}`, `${name}@${version}`];
  execFileSync(useBun ? "bun" : "npm", args, { cwd: root, stdio: "inherit" });
}

function commandExists(command, args = ["--version"]) {
  try {
    execFileSync(command, args, { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function main() {
  const checkOnly = process.argv.includes("--check");
  const name = platformPackageName();
  const before = collectProblems(root, name);

  if (before.length === 0) {
    const state = inspectPlatformPackage(root, name);
    console.log(`rmux platform package ready: ${name}@${state.version}`);
    return;
  }

  if (checkOnly) {
    console.error("rmux platform package is not usable:");
    for (const line of before) console.error(`  - ${line}`);
    console.error("Run: node ./scripts/ensure-rmux-platform.mjs");
    process.exit(1);
  }

  console.log(`installing ${name} (${before.join("; ")})`);
  install(name);

  const after = collectProblems(root, name);
  if (after.length > 0) {
    console.error("rmux platform package is still not usable:");
    for (const line of after) console.error(`  - ${line}`);
    process.exit(1);
  }
  const state = inspectPlatformPackage(root, name);
  console.log(`rmux platform package ready: ${name}@${state.version}`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main();
}
