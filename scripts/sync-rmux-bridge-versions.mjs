#!/usr/bin/env node
/**
 * Keep channel-relay optionalDependencies and platform package versions
 * locked to packages/channel-relay/package.json#version.
 *
 * Platform packages live in platform-packages/ (outside the root workspaces
 * glob) so `npm ci` on Linux/Windows does not try to install darwin-only
 * packages as workspace members. The root lockfile records them as optional
 * stubs so PR CI does not fetch unpublished registry versions; consumers of
 * the published channel-relay package still receive the version pins below.
 *
 * Pack updates platform package.json versions, but publish must also rewrite
 * channel-relay's optionalDependencies before npm publish — otherwise a bump
 * of channel-relay alone ships requests for stale @ganglion/xacpx-rmux-bridge-*.
 *
 * Usage:
 *   node ./scripts/sync-rmux-bridge-versions.mjs           # write
 *   node ./scripts/sync-rmux-bridge-versions.mjs --check   # fail if drift
 */
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const BRIDGE_PREFIX = "@ganglion/xacpx-rmux-bridge-";
const CHANNEL_RELAY_PKG = join(root, "packages/channel-relay/package.json");

const PLATFORM_PACKAGES_DIR = "platform-packages";

export function listBridgePackageDirs(repoRoot = root) {
  return readdirSync(join(repoRoot, PLATFORM_PACKAGES_DIR), { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name.startsWith("xacpx-rmux-bridge-"))
    .map((entry) => entry.name)
    .sort();
}

/**
 * @param {string} [repoRoot]
 * @returns {{ version: string, optionalDeps: Record<string, string>, platforms: string[] }}
 */
export function readRmuxBridgeVersionState(repoRoot = root) {
  const channelRelay = JSON.parse(
    readFileSync(join(repoRoot, "packages/channel-relay/package.json"), "utf8"),
  );
  const version = String(channelRelay.version ?? "");
  const optionalDeps = { ...(channelRelay.optionalDependencies ?? {}) };
  const platforms = listBridgePackageDirs(repoRoot);
  return { version, optionalDeps, platforms };
}

/**
 * @param {string} [repoRoot]
 * @returns {string[]} human-readable drift lines (empty when aligned)
 */
export function collectRmuxBridgeVersionDrift(repoRoot = root) {
  const { version, optionalDeps, platforms } = readRmuxBridgeVersionState(repoRoot);
  const failures = [];
  if (!version) failures.push("packages/channel-relay/package.json missing version");

  const expectedKeys = platforms.map((dir) => `${BRIDGE_PREFIX}${dir.slice("xacpx-rmux-bridge-".length)}`);
  for (const key of expectedKeys) {
    const pinned = optionalDeps[key];
    if (pinned === undefined) {
      failures.push(`channel-relay optionalDependencies missing ${key}`);
    } else if (pinned !== version) {
      failures.push(`${key} optionalDependency is ${pinned}, expected ${version}`);
    }
  }
  for (const key of Object.keys(optionalDeps)) {
    if (!key.startsWith(BRIDGE_PREFIX)) continue;
    if (!expectedKeys.includes(key)) {
      failures.push(`channel-relay optionalDependencies has unexpected ${key}`);
    }
  }
  for (const dir of platforms) {
    const pkgPath = join(repoRoot, PLATFORM_PACKAGES_DIR, dir, "package.json");
    const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
    if (pkg.version !== version) {
      failures.push(`${dir} version is ${pkg.version}, expected ${version}`);
    }
    const expectedName = `${BRIDGE_PREFIX}${dir.slice("xacpx-rmux-bridge-".length)}`;
    if (pkg.name !== expectedName) {
      failures.push(`${dir} name is ${pkg.name}, expected ${expectedName}`);
    }
  }
  return failures;
}

/**
 * Rewrite channel-relay optionalDependencies + platform package versions.
 * @param {string} [repoRoot]
 * @returns {{ version: string, updated: string[] }}
 */
export function syncRmuxBridgeVersions(repoRoot = root) {
  const channelRelayPath = join(repoRoot, "packages/channel-relay/package.json");
  const channelRelay = JSON.parse(readFileSync(channelRelayPath, "utf8"));
  const version = String(channelRelay.version ?? "");
  if (!version) throw new Error("packages/channel-relay/package.json missing version");

  const platforms = listBridgePackageDirs(repoRoot);
  const optionalDependencies = { ...(channelRelay.optionalDependencies ?? {}) };
  const updated = [];

  for (const dir of platforms) {
    const key = `${BRIDGE_PREFIX}${dir.slice("xacpx-rmux-bridge-".length)}`;
    if (optionalDependencies[key] !== version) {
      optionalDependencies[key] = version;
      updated.push(`channel-relay optionalDependencies.${key}`);
    }
    const pkgPath = join(repoRoot, PLATFORM_PACKAGES_DIR, dir, "package.json");
    const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
    if (pkg.version !== version) {
      pkg.version = version;
      writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`);
      updated.push(`${dir}/package.json#version`);
    }
  }

  // Drop stale bridge pins that no longer have a platform package directory.
  for (const key of Object.keys(optionalDependencies)) {
    if (!key.startsWith(BRIDGE_PREFIX)) continue;
    const suffix = key.slice(BRIDGE_PREFIX.length);
    if (!platforms.includes(`xacpx-rmux-bridge-${suffix}`)) {
      delete optionalDependencies[key];
      updated.push(`removed channel-relay optionalDependencies.${key}`);
    }
  }

  channelRelay.optionalDependencies = optionalDependencies;
  writeFileSync(channelRelayPath, `${JSON.stringify(channelRelay, null, 2)}\n`);
  return { version, updated };
}

function main() {
  const checkOnly = process.argv.includes("--check");
  if (checkOnly) {
    const drift = collectRmuxBridgeVersionDrift();
    if (drift.length > 0) {
      console.error("rmux bridge version drift:");
      for (const line of drift) console.error(`  - ${line}`);
      console.error("Run: node ./scripts/sync-rmux-bridge-versions.mjs");
      process.exit(1);
    }
    const { version } = readRmuxBridgeVersionState();
    console.log(`rmux bridge versions aligned at ${version}`);
    return;
  }

  const { version, updated } = syncRmuxBridgeVersions();
  if (updated.length === 0) {
    console.log(`rmux bridge versions already aligned at ${version}`);
    return;
  }
  console.log(`synced rmux bridge versions to ${version}:`);
  for (const line of updated) console.log(`  - ${line}`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main();
}
