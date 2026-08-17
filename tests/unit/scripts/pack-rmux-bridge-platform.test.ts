import { afterEach, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, readFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

import { collectPublishVerificationFailures } from "../../../scripts/verify-publish.mjs";
import { RMUX_VERSION } from "../../../scripts/rmux-release.mjs";

const repoRoot = resolve(import.meta.dir, "../../..");
const packScript = join(repoRoot, "scripts/pack-rmux-bridge-platform.mjs");

const tempRoots: string[] = [];

afterEach(() => {
  for (const root of tempRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempRoots.push(dir);
  return dir;
}

function writeExecutable(path: string, content = "fake-binary\n"): string {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
  chmodSync(path, 0o755);
  return path;
}

function sha256Of(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function createFakePlatformPackage(packagesRoot: string, platform: string): string {
  const pkgDir = join(packagesRoot, `xacpx-rmux-bridge-${platform}`);
  mkdirSync(join(pkgDir, "bin"), { recursive: true });
  writeFileSync(
    join(pkgDir, "package.json"),
    JSON.stringify(
      {
        name: `@ganglion/xacpx-rmux-bridge-${platform}`,
        version: "0.0.0-test",
        files: ["bin", "libexec", "README.md", "checksums.json"],
      },
      null,
      2,
    ),
  );
  return pkgDir;
}

test("pack script bundles bridge + rmux + helper and writes the new checksums schema", () => {
  const packagesRoot = tempDir("pack-pkgs-");
  const pkgDir = createFakePlatformPackage(packagesRoot, "darwin-x64");

  const bridge = writeExecutable(join(tempDir("pack-src-"), "xacpx-rmux-bridge"), "bridge-binary");
  const rmux = writeExecutable(join(tempDir("pack-rmux-"), "rmux"), "rmux-binary");
  const helper = writeExecutable(
    join(tempDir("pack-helper-"), "rmux"),
    "rmux-helper-binary",
  );

  const run = spawnSync(
    "node",
    [
      packScript,
      "--platform",
      "darwin",
      "--arch",
      "x64",
      "--binary",
      bridge,
      "--rmux-binary",
      rmux,
      "--rmux-helper",
      helper,
      "--packages-dir",
      packagesRoot,
      "--skip-version-check",
    ],
    { encoding: "utf8" },
  );

  expect(run.status, run.stderr).toBe(0);

  // Layout: bridge + rmux in bin/, helper under libexec/rmux/.
  const bridgeDest = join(pkgDir, "bin", "xacpx-rmux-bridge");
  const rmuxDest = join(pkgDir, "bin", "rmux");
  const helperDest = join(pkgDir, "libexec", "rmux", "rmux");
  expect(readFileSync(bridgeDest, "utf8")).toBe("bridge-binary");
  expect(readFileSync(rmuxDest, "utf8")).toBe("rmux-binary");
  expect(readFileSync(helperDest, "utf8")).toBe("rmux-helper-binary");

  const checksums = JSON.parse(readFileSync(join(pkgDir, "checksums.json"), "utf8"));
  expect(checksums.rmuxSdk).toBe(RMUX_VERSION);
  expect(checksums.rmuxVersion).toBe(RMUX_VERSION);
  expect(checksums.platform).toBe("darwin-x64");
  expect(checksums.artifact).toBe("bin/xacpx-rmux-bridge");
  expect(checksums.sha256).toBe(sha256Of(bridgeDest));
  expect(checksums.artifacts.bridge).toEqual({
    path: "bin/xacpx-rmux-bridge",
    sha256: sha256Of(bridgeDest),
  });
  expect(checksums.artifacts.rmux).toEqual({
    path: "bin/rmux",
    sha256: sha256Of(rmuxDest),
  });
  expect(checksums.artifacts.rmuxHelper).toEqual({
    path: "libexec/rmux/rmux",
    sha256: sha256Of(helperDest),
  });
});

test("pack script derives the helper from ../libexec/rmux next to --rmux-binary", () => {
  const packagesRoot = tempDir("pack-pkgs-");
  const pkgDir = createFakePlatformPackage(packagesRoot, "linux-x64");

  const srcRoot = tempDir("pack-rel-");
  const bridge = writeExecutable(join(srcRoot, "bin", "xacpx-rmux-bridge"), "bridge");
  const rmux = writeExecutable(join(srcRoot, "bin", "rmux"), "rmux");
  const helper = writeExecutable(join(srcRoot, "libexec", "rmux", "rmux"), "helper");

  const run = spawnSync(
    "node",
    [
      packScript,
      "--platform",
      "linux",
      "--arch",
      "x64",
      "--binary",
      bridge,
      "--rmux-binary",
      rmux,
      "--packages-dir",
      packagesRoot,
      "--skip-version-check",
    ],
    { encoding: "utf8" },
  );

  expect(run.status, run.stderr).toBe(0);
  expect(readFileSync(join(pkgDir, "libexec", "rmux", "rmux"), "utf8")).toBe("helper");
});

test("pack script fails with an actionable error when --rmux-binary is missing", () => {
  const packagesRoot = tempDir("pack-pkgs-");
  createFakePlatformPackage(packagesRoot, "win32-x64");
  const bridge = writeExecutable(join(tempDir("pack-src-"), "xacpx-rmux-bridge.exe"), "bridge");

  const run = spawnSync(
    "node",
    [
      packScript,
      "--platform",
      "win32",
      "--arch",
      "x64",
      "--binary",
      bridge,
      "--rmux-binary",
      join(tempDir("pack-nope-"), "rmux.exe"),
      "--packages-dir",
      packagesRoot,
      "--skip-version-check",
    ],
    { encoding: "utf8" },
  );

  expect(run.status).not.toBe(0);
  expect(run.stderr).toContain("--rmux-binary not found");
  // Nothing may be half-packed when the RMUX artifact is missing.
  expect(() => readFileSync(join(packagesRoot, "xacpx-rmux-bridge-win32-x64", "checksums.json"))).toThrow();
});

/** Minimal repo skeleton for verifyPlatformPackages pin cross-checks. */
function createVerifyRepo(): string {
  const root = tempDir("verify-plat-");
  mkdirSync(join(root, "platform-packages"), { recursive: true });
  mkdirSync(join(root, "packages/channel-relay/src/terminal"), { recursive: true });
  mkdirSync(join(root, "packages/channel-relay/native/rmux-bridge"), { recursive: true });
  writeFileSync(
    join(root, "packages/channel-relay/src/terminal/resolve-rmux-binaries.ts"),
    `export const RMUX_BUNDLED_VERSION = "${RMUX_VERSION}";\n`,
  );
  writeFileSync(
    join(root, "packages/channel-relay/native/rmux-bridge/Cargo.toml"),
    `rmux-sdk = "=${RMUX_VERSION}"\n`,
  );
  return root;
}

function writePackedPackage(repoRoot: string, tamperRmuxSha = false): void {
  const pkgDir = join(repoRoot, "platform-packages", "xacpx-rmux-bridge-linux-x64");
  mkdirSync(join(pkgDir, "bin"), { recursive: true });
  mkdirSync(join(pkgDir, "libexec", "rmux"), { recursive: true });
  const bridge = writeExecutable(join(pkgDir, "bin", "xacpx-rmux-bridge"), "bridge");
  const rmux = writeExecutable(join(pkgDir, "bin", "rmux"), "rmux");
  const helper = writeExecutable(join(pkgDir, "libexec", "rmux", "rmux"), "helper");

  const checksums = {
    package: "@ganglion/xacpx-rmux-bridge-linux-x64",
    version: "0.0.0-test",
    bridgeVersion: "0.1.0",
    rmuxSdk: RMUX_VERSION,
    rmuxVersion: RMUX_VERSION,
    platform: "linux-x64",
    artifact: "bin/xacpx-rmux-bridge",
    sha256: sha256Of(bridge),
    artifacts: {
      bridge: { path: "bin/xacpx-rmux-bridge", sha256: sha256Of(bridge) },
      rmux: {
        path: "bin/rmux",
        sha256: tamperRmuxSha ? "deadbeef".repeat(8) : sha256Of(rmux),
      },
      rmuxHelper: { path: "libexec/rmux/rmux", sha256: sha256Of(helper) },
    },
  };
  writeFileSync(join(pkgDir, "checksums.json"), `${JSON.stringify(checksums, null, 2)}\n`);
}

test("verifyRepo accepts a correctly packed platform package including rmux", async () => {
  const repoRoot = createVerifyRepo();
  writePackedPackage(repoRoot);
  const failures = await collectPublishVerificationFailures({
    repoRoot,
    packages: [],
    scanPaths: [],
    runDryRun: false,
  });
  expect(failures.filter((f) => f.includes("xacpx-rmux-bridge-linux-x64"))).toEqual([]);
});

test("verifyRepo rejects a platform package whose rmux checksum does not match the file", async () => {
  const repoRoot = createVerifyRepo();
  writePackedPackage(repoRoot, true);
  const failures = await collectPublishVerificationFailures({
    repoRoot,
    packages: [],
    scanPaths: [],
    runDryRun: false,
  });
  const relevant = failures.filter((f) => f.includes("xacpx-rmux-bridge-linux-x64"));
  expect(relevant.some((f) => f.includes("SHA-256 mismatch for bin/rmux"))).toBe(true);
});

test("verifyRepo accepts the unpacked placeholder state (null checksums, no binaries)", async () => {
  const repoRoot = createVerifyRepo();
  const pkgDir = join(repoRoot, "platform-packages", "xacpx-rmux-bridge-win32-x64");
  mkdirSync(join(pkgDir, "bin"), { recursive: true });
  writeFileSync(
    join(pkgDir, "checksums.json"),
    `${JSON.stringify(
      {
        package: "@ganglion/xacpx-rmux-bridge-win32-x64",
        version: "0.0.0-test",
        rmuxSdk: RMUX_VERSION,
        rmuxVersion: RMUX_VERSION,
        platform: "win32-x64",
        artifact: "bin/xacpx-rmux-bridge.exe",
        sha256: null,
        artifacts: {
          bridge: { path: "bin/xacpx-rmux-bridge.exe", sha256: null },
          rmux: { path: "bin/rmux.exe", sha256: null },
          rmuxHelper: { path: "libexec/rmux/rmux.exe", sha256: null },
        },
      },
      null,
      2,
    )}\n`,
  );
  const failures = await collectPublishVerificationFailures({
    repoRoot,
    packages: [],
    scanPaths: [],
    runDryRun: false,
  });
  expect(failures.filter((f) => f.includes("xacpx-rmux-bridge-win32-x64"))).toEqual([]);
});

test("verifyRepo rejects drift between the resolver constant and the release manifest", async () => {
  const repoRoot = createVerifyRepo();
  writeFileSync(
    join(repoRoot, "packages/channel-relay/src/terminal/resolve-rmux-binaries.ts"),
    `export const RMUX_BUNDLED_VERSION = "0.9.0";\n`,
  );
  const failures = await collectPublishVerificationFailures({
    repoRoot,
    packages: [],
    scanPaths: [],
    runDryRun: false,
  });
  expect(
    failures.some((f) => f.includes("RMUX_BUNDLED_VERSION=0.9.0 != rmux-release.mjs")),
  ).toBe(true);
});