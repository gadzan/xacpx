#!/usr/bin/env node
/**
 * Copy a release-built xacpx-rmux-bridge into the matching platform npm package
 * and write checksums.json. Does not cross-compile — run on (or with a binary
 * for) each target OS/arch.
 *
 * Usage:
 *   node scripts/pack-rmux-bridge-platform.mjs \
 *     --platform darwin --arch arm64 \
 *     --binary packages/channel-relay/native/rmux-bridge/target/release/xacpx-rmux-bridge
 */
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

function arg(name, fallback) {
  const idx = process.argv.indexOf(`--${name}`);
  if (idx >= 0 && process.argv[idx + 1]) return process.argv[idx + 1];
  return fallback;
}

const platform = arg("platform", process.platform);
const arch = arg("arch", process.arch);
const binary = resolve(
  arg(
    "binary",
    join(root, "packages/channel-relay/native/rmux-bridge/target/release/xacpx-rmux-bridge"),
  ),
);

const key = `${platform}-${arch}`;
const pkgDir = join(root, `packages/xacpx-rmux-bridge-${key}`);
const binName = platform === "win32" ? "xacpx-rmux-bridge.exe" : "xacpx-rmux-bridge";
const dest = join(pkgDir, "bin", binName);

if (!existsSync(pkgDir)) {
  console.error(`unknown platform package: ${pkgDir}`);
  process.exit(1);
}
if (!existsSync(binary)) {
  console.error(`binary not found: ${binary}`);
  process.exit(1);
}

mkdirSync(join(pkgDir, "bin"), { recursive: true });
copyFileSync(binary, dest);
if (platform !== "win32") chmodSync(dest, 0o755);

const sha256 = createHash("sha256").update(readFileSync(dest)).digest("hex");
const channelRelayVersion = JSON.parse(
  readFileSync(join(root, "packages/channel-relay/package.json"), "utf8"),
).version;
const pkgJsonPath = join(pkgDir, "package.json");
const pkgJson = JSON.parse(readFileSync(pkgJsonPath, "utf8"));
pkgJson.version = channelRelayVersion;
writeFileSync(pkgJsonPath, `${JSON.stringify(pkgJson, null, 2)}\n`);

// Keep channel-relay optionalDependencies on the same version the platform
// package is about to publish. Without this, publish can ship channel-relay
// still pinning an older bridge beta.
const { syncRmuxBridgeVersions } = await import("./sync-rmux-bridge-versions.mjs");
syncRmuxBridgeVersions(root);

const checksums = {
  package: pkgJson.name,
  version: channelRelayVersion,
  bridgeVersion: "0.1.0",
  rmuxSdk: "0.10.0",
  platform: key,
  artifact: `bin/${binName}`,
  sha256,
  packedAt: new Date().toISOString(),
};
writeFileSync(join(pkgDir, "checksums.json"), `${JSON.stringify(checksums, null, 2)}\n`);
console.log(`packed ${pkgJson.name}@${channelRelayVersion} sha256=${sha256}`);
