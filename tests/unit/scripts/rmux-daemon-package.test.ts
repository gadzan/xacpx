import { afterEach, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

import { rmuxBinariesForExtractedRelease } from "../../../scripts/rmux-release.mjs";

const repoRoot = resolve(import.meta.dir, "../../..");
const packScript = join(repoRoot, "scripts/pack-rmux-bridge-platform.mjs");
const tempRoots: string[] = [];

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempRoots.push(dir);
  return dir;
}

function writeExecutable(path: string, content: string): string {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
  chmodSync(path, 0o755);
  return path;
}

function sha256Of(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function createFakePackage(packagesRoot: string): string {
  const pkgDir = join(packagesRoot, "xacpx-rmux-bridge-win32-x64");
  mkdirSync(join(pkgDir, "bin"), { recursive: true });
  mkdirSync(join(pkgDir, "libexec", "rmux"), { recursive: true });
  writeFileSync(
    join(pkgDir, "package.json"),
    `${JSON.stringify(
      {
        name: "@ganglion/xacpx-rmux-bridge-win32-x64",
        version: "0.0.0-test",
        files: ["bin", "libexec", "checksums.json"],
      },
      null,
      2,
    )}\n`,
  );
  return pkgDir;
}

test("release layout discovery includes the dedicated daemon on Unix and Windows", () => {
  const unixRoot = tempDir("rmux-release-unix-");
  const unixCli = writeExecutable(join(unixRoot, "bin", "rmux"), "cli");
  const unixDaemon = writeExecutable(join(unixRoot, "bin", "rmux-daemon"), "daemon");
  const unixHelper = writeExecutable(join(unixRoot, "libexec", "rmux", "rmux"), "helper");
  expect(rmuxBinariesForExtractedRelease(unixRoot, "linux")).toEqual({
    cli: unixCli,
    daemon: unixDaemon,
    helper: unixHelper,
  });

  const windowsRoot = tempDir("rmux-release-windows-");
  const windowsCli = writeExecutable(join(windowsRoot, "rmux.exe"), "cli");
  const windowsDaemon = writeExecutable(join(windowsRoot, "rmux-daemon.exe"), "daemon");
  const windowsHelper = writeExecutable(
    join(windowsRoot, "libexec", "rmux", "rmux.exe"),
    "helper",
  );
  expect(rmuxBinariesForExtractedRelease(windowsRoot, "win32")).toEqual({
    cli: windowsCli,
    daemon: windowsDaemon,
    helper: windowsHelper,
  });
});

test("pack script ships rmux-daemon.exe and records its checksum", () => {
  const packagesRoot = tempDir("rmux-daemon-packages-");
  const pkgDir = createFakePackage(packagesRoot);
  const sourceRoot = tempDir("rmux-daemon-source-");
  const bridge = writeExecutable(join(sourceRoot, "xacpx-rmux-bridge.exe"), "bridge");
  const rmux = writeExecutable(join(sourceRoot, "rmux.exe"), "cli");
  const daemon = writeExecutable(join(sourceRoot, "rmux-daemon.exe"), "daemon");
  const helper = writeExecutable(join(sourceRoot, "helper", "rmux.exe"), "helper");

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
      rmux,
      "--rmux-daemon",
      daemon,
      "--rmux-helper",
      helper,
      "--packages-dir",
      packagesRoot,
      "--skip-version-check",
    ],
    { encoding: "utf8" },
  );

  expect(run.status, run.stderr).toBe(0);
  const daemonDest = join(pkgDir, "bin", "rmux-daemon.exe");
  expect(readFileSync(daemonDest, "utf8")).toBe("daemon");

  const checksums = JSON.parse(readFileSync(join(pkgDir, "checksums.json"), "utf8"));
  expect(checksums.artifacts.rmuxDaemon).toEqual({
    path: "bin/rmux-daemon.exe",
    sha256: sha256Of(daemonDest),
  });
});

test("pack script fails closed instead of falling back to rmux.exe when the daemon is missing", () => {
  const packagesRoot = tempDir("rmux-daemon-missing-packages-");
  createFakePackage(packagesRoot);
  const sourceRoot = tempDir("rmux-daemon-missing-source-");
  const bridge = writeExecutable(join(sourceRoot, "xacpx-rmux-bridge.exe"), "bridge");
  const rmux = writeExecutable(join(sourceRoot, "rmux.exe"), "cli");
  const helper = writeExecutable(join(sourceRoot, "helper", "rmux.exe"), "helper");

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
      rmux,
      "--rmux-helper",
      helper,
      "--packages-dir",
      packagesRoot,
      "--skip-version-check",
    ],
    { encoding: "utf8" },
  );

  expect(run.status).not.toBe(0);
  expect(run.stderr).toContain("rmux daemon not found");
});
