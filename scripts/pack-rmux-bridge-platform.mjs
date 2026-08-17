#!/usr/bin/env node
/**
 * Pack a release-built xacpx-rmux-bridge PLUS the pinned RMUX runtime into the
 * matching platform npm package and write checksums.json. Does not
 * cross-compile — run on (or with a binary for) each target OS/arch.
 *
 * The RMUX binary comes from the pinned official release (scripts/rmux-release.mjs,
 * fixed version + URL + SHA-256) so the platform package is self-contained and
 * offline-installable: users never need a machine-local RMUX, and a stale
 * PATH/~/.local RMUX can never shadow the bundled one (Windows field bug:
 * WinGet rmux 0.9.0 vs bridge rmux-sdk 0.10.0).
 *
 * Usage:
 *   node scripts/pack-rmux-bridge-platform.mjs \
 *     --platform darwin --arch arm64 \
 *     --binary packages/channel-relay/native/rmux-bridge/target/release/xacpx-rmux-bridge
 *
 * Optional overrides (normally the pinned release is fetched automatically):
 *   --rmux-binary <path>   pre-fetched bin/rmux[.exe] from the pinned release
 *   --rmux-helper <path>   pre-fetched libexec/rmux/rmux[.exe] (defaults to
 *                          ../libexec/rmux/rmux relative to --rmux-binary)
 *   --rmux-archive-cache <dir>  where downloaded RMUX archives are reused
 *   --skip-version-check   do not run `rmux -V` on this host (cross-pack only)
 *   --packages-dir <dir>    platform-packages root (tests); default repo root
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { extractRmuxRelease, fetchRmuxReleaseArchive, RMUX_VERSION } from "./rmux-release.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

function arg(name, fallback) {
  const idx = process.argv.indexOf(`--${name}`);
  if (idx >= 0 && process.argv[idx + 1]) return process.argv[idx + 1];
  return fallback;
}

const platform = arg("platform", process.platform);
const arch = arg("arch", process.arch);
const bridge = resolve(
  arg(
    "binary",
    join(root, "packages/channel-relay/native/rmux-bridge/target/release/xacpx-rmux-bridge"),
  ),
);
const rmuxBinaryArg = arg("rmux-binary", null);
const rmuxHelperArg = arg("rmux-helper", null);
const archiveCache = resolve(arg("rmux-archive-cache", join(root, ".rmux-release-cache")));
const skipVersionCheck = process.argv.includes("--skip-version-check");

const key = `${platform}-${arch}`;
const packagesRoot = resolve(arg("packages-dir", join(root, "platform-packages")));
const pkgDir = join(packagesRoot, `xacpx-rmux-bridge-${key}`);
const bridgeBinName = platform === "win32" ? "xacpx-rmux-bridge.exe" : "xacpx-rmux-bridge";
const rmuxBinName = platform === "win32" ? "rmux.exe" : "rmux";

if (!existsSync(pkgDir)) {
  console.error(`unknown platform package: ${pkgDir}`);
  process.exit(1);
}
if (!existsSync(bridge)) {
  console.error(`bridge binary not found: ${bridge}`);
  process.exit(1);
}

// --- Resolve the pinned RMUX CLI + hidden-daemon helper ----------------------
let rmuxSource;
let rmuxHelper;
if (rmuxBinaryArg) {
  rmuxSource = resolve(rmuxBinaryArg);
  if (!existsSync(rmuxSource)) {
    console.error(`--rmux-binary not found: ${rmuxSource}`);
    process.exit(1);
  }
  rmuxHelper = rmuxHelperArg
    ? resolve(rmuxHelperArg)
    : join(dirname(rmuxSource), "..", "libexec", "rmux", rmuxBinName);
  if (!existsSync(rmuxHelper)) {
    console.error(
      `rmux helper not found: ${rmuxHelper} (pass --rmux-helper, or drop --rmux-binary to fetch the pinned release)`,
    );
    process.exit(1);
  }
} else {
  // Pin + SHA-verify the official release, then extract the CLI + helper.
  const archive = fetchRmuxReleaseArchive({ platform, arch, cacheDir: archiveCache });
  const tmpExtract = join(archiveCache, `extract-${key}`);
  const extracted = extractRmuxRelease({ archive, platform, destDir: tmpExtract });
  rmuxSource = extracted.cli;
  rmuxHelper = extracted.helper;
}

const binDir = join(pkgDir, "bin");
const libexecRmuxDir = join(pkgDir, "libexec", "rmux");
mkdirSync(binDir, { recursive: true });
mkdirSync(libexecRmuxDir, { recursive: true });

const bridgeDest = join(binDir, bridgeBinName);
const rmuxDest = join(binDir, rmuxBinName);
const rmuxHelperDest = join(libexecRmuxDir, rmuxBinName);

copyFileSync(bridge, bridgeDest);
copyFileSync(rmuxSource, rmuxDest);
copyFileSync(rmuxHelper, rmuxHelperDest);
if (platform !== "win32") {
  chmodSync(bridgeDest, 0o755);
  chmodSync(rmuxDest, 0o755);
  chmodSync(rmuxHelperDest, 0o755);
}

// --- Version integrity: the bundled RMUX must match the bridge's SDK pin -----
if (!skipVersionCheck) {
  const probe = spawnSync(rmuxDest, ["-V"], { encoding: "utf8", timeout: 15_000 });
  const out = `${probe.stdout ?? ""}${probe.stderr ?? ""}`.trim();
  if (probe.status !== 0 || !out.includes(RMUX_VERSION)) {
    console.error(
      `bundled rmux version check failed: expected "rmux ${RMUX_VERSION}", ` +
        `got status=${probe.status} output=${JSON.stringify(out)}`,
    );
    process.exit(1);
  }
  console.log(`rmux -V => ${out}`);
}

const sha256Of = (path) => createHash("sha256").update(readFileSync(path)).digest("hex");

const bridgeSha = sha256Of(bridgeDest);
const rmuxSha = sha256Of(rmuxDest);
const rmuxHelperSha = sha256Of(rmuxHelperDest);

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
  rmuxSdk: RMUX_VERSION,
  rmuxVersion: RMUX_VERSION,
  platform: key,
  // Legacy single-artifact fields (bridge) kept for existing verify/publish
  // consumers; new consumers should read `artifacts`.
  artifact: `bin/${bridgeBinName}`,
  sha256: bridgeSha,
  artifacts: {
    bridge: {
      path: `bin/${bridgeBinName}`,
      sha256: bridgeSha,
    },
    rmux: {
      path: `bin/${rmuxBinName}`,
      sha256: rmuxSha,
    },
    rmuxHelper: {
      path: `libexec/rmux/${rmuxBinName}`,
      sha256: rmuxHelperSha,
    },
  },
  packedAt: new Date().toISOString(),
};
writeFileSync(join(pkgDir, "checksums.json"), `${JSON.stringify(checksums, null, 2)}\n`);
console.log(
  `packed ${pkgJson.name}@${channelRelayVersion} bridge=${bridgeSha.slice(0, 12)} rmux=${rmuxSha.slice(0, 12)} (v${RMUX_VERSION}) helper=${rmuxHelperSha.slice(0, 12)}`,
);