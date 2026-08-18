import { existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";

import { RMUX_VERSION } from "./rmux-release.mjs";

/**
 * @typedef {Object} PublishPackageConfig
 * @property {string} id
 * @property {string} dir
 * @property {string} expectedName
 * @property {string[]} requiredFiles
 * @property {string=} requiredPeer
 * @property {string=} forbiddenPeer
 * @property {string=} expectedExportedName
 */

const DEFAULT_PACKAGES = [
  {
    id: "root",
    dir: ".",
    expectedName: "@ganglion/xacpx",
    requiredFiles: ["dist/cli.js", "dist/bridge/bridge-main.js", "dist/adapters/hermes-acp-shim.js", "dist/adapters/acp-output-guard-main.js", "dist/plugin-api.js", "dist/plugin-api.d.ts", "README.md", "config.example.json", "package.json"],
    forbiddenPathPatterns: [
      "^dist/channels/feishu/",
      "^dist/channels/cli/feishu-provider",
      "^dist/channels/yuanbao/",
      "^dist/channels/cli/yuanbao-provider",
    ],
  },
  {
    id: "channel-feishu",
    dir: "packages/channel-feishu",
    expectedName: "@ganglion/xacpx-channel-feishu",
    requiredFiles: ["dist/index.js", "dist/index.d.ts", "README.md", "package.json"],
    requiredPeer: "xacpx",
    forbiddenPeer: "weacpx",
    expectedExportedName: "@ganglion/xacpx-channel-feishu",
  },
  {
    id: "channel-yuanbao",
    dir: "packages/channel-yuanbao",
    expectedName: "@ganglion/xacpx-channel-yuanbao",
    requiredFiles: ["dist/index.js", "dist/index.d.ts", "README.md", "package.json"],
    requiredPeer: "xacpx",
    forbiddenPeer: "weacpx",
    expectedExportedName: "@ganglion/xacpx-channel-yuanbao",
  },
  {
    id: "relay-protocol",
    dir: "packages/relay-protocol",
    expectedName: "@ganglion/xacpx-relay-protocol",
    requiredFiles: ["dist/index.js", "dist/index.d.ts", "README.md", "package.json"],
  },
  {
    id: "relay",
    dir: "packages/relay",
    expectedName: "@ganglion/xacpx-relay",
    // dist/relay-web/index.html proves the dashboard was embedded into the hub
    // package — without it `npm i -g @ganglion/xacpx-relay` ships no web UI.
    requiredFiles: ["dist/cli.js", "dist/relay-web/index.html", "README.md", "package.json"],
  },
  {
    id: "channel-relay",
    dir: "packages/channel-relay",
    expectedName: "@ganglion/xacpx-channel-relay",
    requiredFiles: ["dist/index.js", "dist/index.d.ts", "README.md", "package.json"],
    requiredPeer: "xacpx",
    forbiddenPeer: "weacpx",
    expectedExportedName: "@ganglion/xacpx-channel-relay",
  },
];

const DEFAULT_SCAN_PATHS = [
  "package.json",
  "packages",
  "README.md",
  "docs/plugin-development.md",
  "docs/channel-management.md",
  "docs/config-reference.md",
  "docs/superpowers/specs/2026-05-08-channel-plugin-next-roadmap.md",
  "docs/superpowers/specs/2026-05-08-channel-plugin-toolchain-design.md",
];

export async function collectPublishVerificationFailures(input = {}) {
  const repoRoot = input.repoRoot ?? process.cwd();
  const packages = input.packages ?? DEFAULT_PACKAGES;
  const scanPaths = input.scanPaths ?? DEFAULT_SCAN_PATHS;
  const runDryRun = input.runDryRun ?? true;
  const failures = [];

  for (const pkg of packages) {
    await verifyPackage(repoRoot, pkg, failures, runDryRun);
  }

  await verifyNoStaleConsoleReferences(repoRoot, scanPaths, failures);

  await verifyPlatformPackages(repoRoot, failures);

  return failures;
}

/**
 * Platform packages bundle a pinned RMUX next to the bridge. Verify:
 *   - the three version pins agree (release manifest ↔ TS resolver constant ↔
 *     Cargo.toml rmux-sdk), so the packaged RMUX provably matches the bridge
 *   - every packed package contains bridge + rmux + libexec helper binaries
 *   - checksums.json artifacts match the actual file bytes
 * Unpacked (post-checkout placeholder) packages pass as long as their
 * checksums are null; a non-null checksum must always match its file.
 */
export async function verifyPlatformPackages(repoRoot, failures = []) {
  const root = join(repoRoot, "platform-packages");
  if (!existsSync(root)) return failures;

  // Pin cross-check: scripts/rmux-release.mjs ↔ resolve-rmux-binaries.ts
  // ↔ packages/channel-relay/native/rmux-bridge/Cargo.toml.
  const resolverPath = join(
    repoRoot,
    "packages/channel-relay/src/terminal/resolve-rmux-binaries.ts",
  );
  if (existsSync(resolverPath)) {
    const resolverSource = await readFile(resolverPath, "utf8");
    const match = resolverSource.match(/export const RMUX_BUNDLED_VERSION = "([^"]+)"/);
    if (!match) {
      failures.push("channel-relay: resolve-rmux-binaries.ts missing RMUX_BUNDLED_VERSION");
    } else if (match[1] !== RMUX_VERSION) {
      failures.push(
        `channel-relay: RMUX_BUNDLED_VERSION=${match[1]} != rmux-release.mjs RMUX_VERSION=${RMUX_VERSION}`,
      );
    }
  }
  const cargoToml = join(repoRoot, "packages/channel-relay/native/rmux-bridge/Cargo.toml");
  if (existsSync(cargoToml)) {
    const cargo = await readFile(cargoToml, "utf8");
    if (!cargo.includes(`rmux-sdk = "=${RMUX_VERSION}"`)) {
      failures.push(
        `channel-relay: rmux-bridge must pin rmux-sdk = "=${RMUX_VERSION}" to match the packaged RMUX`,
      );
    }
  }

  const packageDirs = (await readdir(root, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory() && entry.name.startsWith("xacpx-rmux-bridge-"))
    .map((entry) => entry.name)
    .sort();

  for (const dir of packageDirs) {
    const pkgRoot = join(root, dir);
    // The package redistributes the official RMUX binary (MIT OR Apache-2.0);
    // MIT redistribution requires the copyright + permission notice to ride
    // along — never publish a bundled RMUX without it.
    if (!existsSync(join(pkgRoot, "THIRD_PARTY_NOTICES.md"))) {
      failures.push(`${dir}: missing redistributed-RMUX notice THIRD_PARTY_NOTICES.md`);
    }
    const mitLicense = join(pkgRoot, "THIRD_PARTY_LICENSES", "RMUX-LICENSE-MIT.txt");
    if (!existsSync(mitLicense)) {
      failures.push(
        `${dir}: missing redistributed-RMUX license THIRD_PARTY_LICENSES/RMUX-LICENSE-MIT.txt`,
      );
    } else {
      const mitText = await readFile(mitLicense, "utf8");
      if (!mitText.includes("The RMUX Authors") || !mitText.includes("MIT License")) {
        failures.push(`${dir}: RMUX-LICENSE-MIT.txt does not carry the upstream MIT notice`);
      }
    }
    const checksumsPath = join(pkgRoot, "checksums.json");
    if (!existsSync(checksumsPath)) {
      failures.push(`${dir}: missing checksums.json`);
      continue;
    }
    const checksums = JSON.parse(await readFile(checksumsPath, "utf8"));
    if (checksums.rmuxVersion !== RMUX_VERSION || checksums.rmuxSdk !== RMUX_VERSION) {
      failures.push(
        `${dir}: checksums must record rmuxVersion + rmuxSdk = ${RMUX_VERSION} (got ${checksums.rmuxSdk}/${checksums.rmuxVersion})`,
      );
    }
    const artifacts = checksums.artifacts;
    if (!artifacts?.bridge?.path || !artifacts?.rmux?.path || !artifacts?.rmuxHelper?.path) {
      failures.push(
        `${dir}: checksums.artifacts must list bridge + rmux + rmuxHelper paths`,
      );
      continue;
    }

    const bridgeBin = join(pkgRoot, artifacts.bridge.path);
    const anyArtifactPresent = Object.values(artifacts).some((entry) =>
      existsSync(join(pkgRoot, entry.path)),
    );
    if (anyArtifactPresent) {
      // Packed (or partially packed) state: every artifact must exist and
      // match its recorded SHA-256 — including the bundled RMUX + helper.
      await verifyArtifactBytes(dir, artifacts.bridge, pkgRoot, checksums, failures);
      await verifyArtifactBytes(dir, artifacts.rmux, pkgRoot, checksums, failures);
      await verifyArtifactBytes(dir, artifacts.rmuxHelper, pkgRoot, checksums, failures);
      // Legacy single-artifact fields must stay the bridge entry.
      if (checksums.artifact !== artifacts.bridge.path) {
        failures.push(`${dir}: legacy checksums.artifact must equal artifacts.bridge.path`);
      }
      if (checksums.sha256 !== artifacts.bridge.sha256) {
        failures.push(`${dir}: legacy checksums.sha256 must equal artifacts.bridge.sha256`);
      }
    } else {
      // Unpacked placeholder state: fine only if nothing claims a packed sha.
      for (const [kind, entry] of Object.entries(artifacts)) {
        if (entry.sha256 != null) {
          failures.push(
            `${dir}: checksums artifact ${kind} has sha256 but file ${entry.path} is missing`,
          );
        }
      }
      if (checksums.sha256 != null) {
        failures.push(`${dir}: legacy checksums.sha256 set but platform binaries are not packed`);
      }
    }
  }

  return failures;
}

async function verifyArtifactBytes(dir, entry, pkgRoot, checksums, failures) {
  const abs = join(pkgRoot, entry.path);
  if (!existsSync(abs)) {
    failures.push(`${dir}: checksums artifact missing on disk: ${entry.path}`);
    return;
  }
  if (!entry.sha256) {
    failures.push(`${dir}: checksums artifact ${entry.path} missing sha256`);
    return;
  }
  const actual = createHash("sha256").update(await readFile(abs)).digest("hex");
  if (actual !== entry.sha256) {
    failures.push(
      `${dir}: SHA-256 mismatch for ${entry.path}: expected ${entry.sha256}, got ${actual} (re-pack the platform package)`,
    );
  }
}

async function verifyPackage(repoRoot, pkg, failures, runDryRun) {
  const packageRoot = join(repoRoot, pkg.dir);
  const packageJsonPath = join(packageRoot, "package.json");
  let packageJson;
  try {
    packageJson = JSON.parse(await readFile(packageJsonPath, "utf8"));
  } catch (error) {
    failures.push(`${pkg.id}: failed to read package.json: ${error instanceof Error ? error.message : String(error)}`);
    return;
  }

  if (packageJson.name !== pkg.expectedName) {
    failures.push(`${pkg.id}: package.json name must be ${pkg.expectedName}, got ${String(packageJson.name)}`);
  }
  if (pkg.id === "channel-relay") {
    const version = String(packageJson.version ?? "");
    const optional = packageJson.optionalDependencies ?? {};
    for (const [name, pinned] of Object.entries(optional)) {
      if (!name.startsWith("@ganglion/xacpx-rmux-bridge-")) continue;
      if (pinned !== version) {
        failures.push(
          `${pkg.id}: optionalDependency ${name} is ${pinned}, must equal package version ${version} (run scripts/sync-rmux-bridge-versions.mjs)`,
        );
      }
    }
  }
  if (pkg.id === "root" && pkg.expectedName === "@ganglion/xacpx") {
    if (packageJson.optionalDependencies?.["fs-ext"] !== "2.1.1") {
      failures.push("root: optionalDependencies must include fs-ext@2.1.1 for the Unix flock helper");
    }
    await verifyRootRuntimeBundle(packageRoot, failures);
  }

  if (pkg.id === "channel-relay") {
    const expected = [
      "@ganglion/xacpx-rmux-bridge-darwin-arm64",
      "@ganglion/xacpx-rmux-bridge-darwin-x64",
      "@ganglion/xacpx-rmux-bridge-linux-arm64",
      "@ganglion/xacpx-rmux-bridge-linux-x64",
      "@ganglion/xacpx-rmux-bridge-win32-x64",
    ];
    const optional = packageJson.optionalDependencies ?? {};
    for (const name of expected) {
      if (!(name in optional)) {
        failures.push(`channel-relay: optionalDependencies must include ${name}`);
      }
    }
    const cargoToml = join(repoRoot, "packages/channel-relay/native/rmux-bridge/Cargo.toml");
    if (existsSync(cargoToml)) {
      const cargo = await readFile(cargoToml, "utf8");
      if (/rmux-sdk\s*=\s*\{[^}]*path\s*=/.test(cargo) || cargo.includes("../rmux")) {
        failures.push("channel-relay: rmux-bridge Cargo.toml must not path-depend on ../rmux");
      }
      if (!cargo.includes('rmux-sdk = "=0.10.0"')) {
        failures.push('channel-relay: rmux-bridge must pin rmux-sdk = "=0.10.0"');
      }
    }
  }

  for (const file of pkg.requiredFiles) {
    if (!existsSync(join(packageRoot, file))) {
      failures.push(`${pkg.id}: missing required publish file ${file}`);
    }
  }

  // Every `bin` target must start with a `#!` shebang, or running the installed
  // command directly (not via `node <file>`) fails with a shell syntax error.
  const binEntries = typeof packageJson.bin === "string"
    ? [packageJson.bin]
    : Object.values(packageJson.bin ?? {});
  for (const binRel of binEntries) {
    const binPath = join(packageRoot, binRel);
    if (!existsSync(binPath)) continue; // missing-file is already reported via requiredFiles
    const firstLine = (await readFile(binPath, "utf8")).split("\n", 1)[0] ?? "";
    if (!firstLine.startsWith("#!")) {
      failures.push(`${pkg.id}: bin ${binRel} is missing a shebang (first line: ${JSON.stringify(firstLine.slice(0, 40))}). Add '#!/usr/bin/env node' to the entry source.`);
    }
  }

  if (pkg.requiredPeer && !(pkg.requiredPeer in (packageJson.peerDependencies ?? {}))) {
    failures.push(`${pkg.id}: package.json peerDependencies must include ${pkg.requiredPeer}`);
  }
  if (pkg.forbiddenPeer && pkg.forbiddenPeer in (packageJson.peerDependencies ?? {})) {
    failures.push(`${pkg.id}: package.json peerDependencies must not include ${pkg.forbiddenPeer}`);
  }
  if (pkg.requiredPeer && packageJson.peerDependenciesMeta?.[pkg.requiredPeer]?.optional !== true) {
    failures.push(`${pkg.id}: package.json peerDependenciesMeta.${pkg.requiredPeer}.optional must be true`);
  }

  if (pkg.expectedExportedName) {
    await verifyExportedPluginName(packageRoot, pkg, failures);
  }

  if (runDryRun) {
    const dryRun = spawnSync("bun", ["pm", "pack", "--dry-run"], {
      cwd: packageRoot,
      encoding: "utf8",
    });
    if (dryRun.status !== 0) {
      failures.push(`${pkg.id}: bun pm pack --dry-run failed: ${(dryRun.stderr || dryRun.stdout).trim()}`);
      return;
    }
    const packedPaths = parsePackedPaths(`${dryRun.stdout}\n${dryRun.stderr}`);
    for (const file of pkg.requiredFiles) {
      if (!packedPaths.includes(file)) {
        failures.push(`${pkg.id}: tarball missing required file ${file}`);
      }
    }
    for (const pattern of pkg.forbiddenPathPatterns ?? []) {
      const regex = new RegExp(pattern);
      const matches = packedPaths.filter((p) => regex.test(p));
      for (const match of matches) {
        failures.push(`${pkg.id}: tarball contains forbidden path ${match} (matched ${pattern})`);
      }
    }
  }
}

async function verifyRootRuntimeBundle(packageRoot, failures) {
  const targets = ["dist/cli.js", "dist/bridge/bridge-main.js"];
  for (const target of targets) {
    const path = join(packageRoot, target);
    if (!existsSync(path)) continue;
    const source = await readFile(path, "utf8");
    const absolutePackageRoot = packageRoot.replaceAll("\\", "/");
    if (source.replaceAll("\\", "/").includes(absolutePackageRoot)) {
      failures.push(`root: ${target} embeds a machine-specific user path`);
    }
  }
  const cliPath = join(packageRoot, "dist/cli.js");
  if (!existsSync(cliPath)) return;
  const cli = await readFile(cliPath, "utf8");
  for (const marker of ["IPC guard is already held", "XACPX_PROCESS_REQUEST", "adapter command failed trust-boundary decoding"]) {
    if (!cli.includes(marker)) failures.push(`root: dist/cli.js is missing runtime marker ${marker}`);
  }
}

function parsePackedPaths(output) {
  const paths = [];
  for (const line of output.split(/\r?\n/)) {
    const match = line.match(/^\s*packed\s+\S+\s+(.+)$/);
    if (match) paths.push(match[1].trim());
  }
  return paths;
}

async function verifyExportedPluginName(packageRoot, pkg, failures) {
  const entry = join(packageRoot, "src/index.ts");
  let source;
  try {
    source = await readFile(entry, "utf8");
  } catch (error) {
    failures.push(`${pkg.id}: failed to read src/index.ts: ${error instanceof Error ? error.message : String(error)}`);
    return;
  }
  if (!source.includes(`name: "${pkg.expectedExportedName}"`) && !source.includes(`name: '${pkg.expectedExportedName}'`)) {
    failures.push(`${pkg.id}: exported plugin name must be ${pkg.expectedExportedName}`);
  }
}

async function verifyNoStaleConsoleReferences(repoRoot, scanPaths, failures) {
  const files = [];
  for (const scanPath of scanPaths) {
    await collectFiles(join(repoRoot, scanPath), files);
  }
  for (const file of files) {
    if (!isTextFile(file)) continue;
    const text = await readFile(file, "utf8");
    if (text.includes("weacpx-console/plugin-api")) {
      failures.push(`${toPosixPath(relative(repoRoot, file))}: replace stale weacpx-console/plugin-api reference with weacpx/plugin-api`);
    }
  }
}

function toPosixPath(path) {
  return path.replaceAll("\\", "/");
}

async function collectFiles(path, out) {
  if (!existsSync(path)) return;
  const entries = await readdir(path, { withFileTypes: true }).catch(() => null);
  if (!entries) {
    out.push(path);
    return;
  }
  for (const entry of entries) {
    if (entry.name === "node_modules" || entry.name === "dist") continue;
    const child = join(path, entry.name);
    if (entry.isDirectory()) await collectFiles(child, out);
    else if (entry.isFile()) out.push(child);
  }
}

function isTextFile(file) {
  return /\.(json|md|ts|tsx|js|mjs|cjs|yaml|yml|toml)$/.test(file);
}

async function main() {
  const failures = await collectPublishVerificationFailures();
  if (failures.length > 0) {
    console.error("Publish verification failed:");
    for (const failure of failures) console.error(`- ${failure}`);
    process.exitCode = 1;
    return;
  }
  console.log("Publish verification passed.");
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  await main();
}
