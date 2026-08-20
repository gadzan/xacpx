import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { collectPublishVerificationFailures } from "../../../scripts/verify-publish.mjs";
import { RMUX_VERSION } from "../../../scripts/rmux-release.mjs";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixtureRoot(): { root: string; pkgDir: string } {
  const root = mkdtempSync(join(tmpdir(), "verify-rmux-daemon-"));
  roots.push(root);
  const pkgDir = join(root, "platform-packages", "xacpx-rmux-bridge-linux-x64");
  mkdirSync(join(pkgDir, "bin"), { recursive: true });
  mkdirSync(join(pkgDir, "libexec", "rmux"), { recursive: true });
  mkdirSync(join(pkgDir, "THIRD_PARTY_LICENSES"), { recursive: true });
  writeFileSync(join(pkgDir, "THIRD_PARTY_NOTICES.md"), "RMUX 0.10.0 - The RMUX Authors\n");
  writeFileSync(
    join(pkgDir, "THIRD_PARTY_LICENSES", "RMUX-LICENSE-MIT.txt"),
    "MIT License\nThe RMUX Authors\n",
  );
  return { root, pkgDir };
}

function write(path: string, content: string): string {
  writeFileSync(path, content);
  return path;
}

function sha256(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function baseChecksums(pkgDir: string) {
  const bridge = write(join(pkgDir, "bin", "xacpx-rmux-bridge"), "bridge");
  const rmux = write(join(pkgDir, "bin", "rmux"), "rmux");
  const helper = write(join(pkgDir, "libexec", "rmux", "rmux"), "helper");
  return {
    package: "@ganglion/xacpx-rmux-bridge-linux-x64",
    version: "0.0.0-test",
    rmuxSdk: RMUX_VERSION,
    rmuxVersion: RMUX_VERSION,
    platform: "linux-x64",
    artifact: "bin/xacpx-rmux-bridge",
    sha256: sha256(bridge),
    artifacts: {
      bridge: { path: "bin/xacpx-rmux-bridge", sha256: sha256(bridge) },
      rmux: { path: "bin/rmux", sha256: sha256(rmux) },
      rmuxHelper: { path: "libexec/rmux/rmux", sha256: sha256(helper) },
    },
  };
}

async function verify(root: string): Promise<string[]> {
  return await collectPublishVerificationFailures({
    repoRoot: root,
    packages: [],
    scanPaths: [],
    runDryRun: false,
  });
}

test("publish verification requires checksums.artifacts.rmuxDaemon", async () => {
  const { root, pkgDir } = fixtureRoot();
  const checksums = baseChecksums(pkgDir);
  writeFileSync(join(pkgDir, "checksums.json"), `${JSON.stringify(checksums, null, 2)}\n`);

  const failures = await verify(root);
  expect(failures.some((failure) =>
    failure.includes("checksums.artifacts must list bridge + rmux + rmuxDaemon + rmuxHelper paths")
  )).toBe(true);
});

test("publish verification rejects a declared rmuxDaemon whose binary is missing", async () => {
  const { root, pkgDir } = fixtureRoot();
  const checksums = baseChecksums(pkgDir);
  const withDaemon = {
    ...checksums,
    artifacts: {
      ...checksums.artifacts,
      rmuxDaemon: { path: "bin/rmux-daemon", sha256: "0".repeat(64) },
    },
  };
  writeFileSync(join(pkgDir, "checksums.json"), `${JSON.stringify(withDaemon, null, 2)}\n`);

  const failures = await verify(root);
  expect(failures.some((failure) =>
    failure.includes("checksums artifact missing on disk: bin/rmux-daemon")
  )).toBe(true);
});
