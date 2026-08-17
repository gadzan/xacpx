#!/usr/bin/env node
/**
 * Pinned RMUX release manifest used by platform packaging.
 *
 * RMUX_VERSION must stay in lock-step with:
 *   - packages/channel-relay/src/terminal/resolve-rmux-binaries.ts
 *     (RMUX_BUNDLED_VERSION for the runtime resolver + doctor)
 *   - packages/channel-relay/native/rmux-bridge/Cargo.toml (rmux-sdk = "=X")
 * verify-publish.mjs cross-checks all three at publish time.
 *
 * Never "latest": downloads are a fixed version, a fixed GitHub release URL,
 * and a pinned SHA-256 verified before extraction. The platform package is
 * assembled offline and installs without any network access.
 *
 * SHA-256 values are the v0.10.0 release SHA256SUMS, verified against a local
 * download of every artifact on 2026-08-17 (scripts/pack-rmux-bridge-platform.mjs
 * re-verifies the SHAs on every pack).
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

export const RMUX_VERSION = "0.10.0";

export const RMUX_RELEASE_REPO = "Helvesec/rmux";

/**
 * Official release asset per platform/arch with its pinned SHA-256.
 * Release layout (rmux-package-v2): `bin/rmux[.exe]` (connect-or-start CLI)
 * + `libexec/rmux/rmux[.exe]` (hidden-daemon helper the CLI re-execs). The
 * bridge only needs the CLI; the helper must ride along in the same package
 * because `rmux` refuses to daemonize without it ("private rmux helper not
 * found under libexec/rmux").
 */
export const RMUX_RELEASE_ASSETS = {
  "darwin-arm64": {
    asset: "rmux-0.10.0-macos-aarch64.tar.gz",
    sha256: "aac857519071f680be53aa9a328dc0cd04c2abe66ec726f78aa9e26337c5ef7b",
  },
  "darwin-x64": {
    asset: "rmux-0.10.0-macos-x86_64.tar.gz",
    sha256: "b897898eadc4d96c6d555b79affd834bd488013c44f8c6f815bb5195eafd1e0a",
  },
  "linux-arm64": {
    asset: "rmux-0.10.0-linux-aarch64.tar.gz",
    sha256: "7e916560ea0fb90864b8c24e5d0f81b4e3e0b013b8aad5ab53839d7e8e5e1926",
  },
  "linux-x64": {
    asset: "rmux-0.10.0-linux-x86_64.tar.gz",
    sha256: "1bec11eff08c3313c3a400196e7a93d00b8ad4a24f81ef13debb03355c2696c5",
  },
  "win32-x64": {
    asset: "rmux-0.10.0-windows-x86_64.zip",
    sha256: "e315e2d51d927ba9621732812c0f932c862d05f4b677dbf3cab76f0d27372a70",
  },
};

export function rmuxReleaseAsset(platform, arch) {
  const key = `${platform}-${arch}`;
  const entry = RMUX_RELEASE_ASSETS[key];
  if (!entry) {
    throw new Error(
      `no pinned RMUX ${RMUX_VERSION} release asset for ${key} ` +
        `(known: ${Object.keys(RMUX_RELEASE_ASSETS).join(", ")})`,
    );
  }
  return entry;
}

export function rmuxReleaseUrl(platform, arch) {
  const { asset } = rmuxReleaseAsset(platform, arch);
  return `https://github.com/${RMUX_RELEASE_REPO}/releases/download/v${RMUX_VERSION}/${asset}`;
}

export function rmuxBinariesForExtractedRelease(extractRoot, platform) {
  const exe = platform === "win32" ? ".exe" : "";
  const cliName = `rmux${exe}`;
  const helperName = `${cliName}`;
  // Two official layouts exist (package_layout rmux-package-v2):
  //   unix tarballs: bin/rmux + libexec/rmux/rmux
  //   windows zip:   rmux.exe + libexec/rmux/rmux.exe at the package root
  const cliCandidates = [join(extractRoot, "bin", cliName), join(extractRoot, cliName)];
  const helperCandidates = [
    join(extractRoot, "libexec", "rmux", helperName),
    join(extractRoot, "bin", "..", "libexec", "rmux", helperName),
  ];
  const cli = cliCandidates.find((candidate) => existsSync(candidate));
  const helper = helperCandidates.find((candidate) => existsSync(candidate));
  return { cli, helper };
}

/**
 * Download (once per cache dir) + SHA-verify the pinned RMUX release archive
 * for a platform/arch. Returns the local archive path. Never uses PATH rmux.
 */
export function fetchRmuxReleaseArchive({ platform, arch, cacheDir }) {
  const { asset, sha256 } = rmuxReleaseAsset(platform, arch);
  mkdirSync(cacheDir, { recursive: true });
  const archive = join(cacheDir, asset);
  if (existsSync(archive)) {
    const cached = sha256OfFile(archive);
    if (cached === sha256) return archive;
    console.error(`cached ${archive} failed SHA-256 (${cached}); re-downloading`);
  }
  const url = rmuxReleaseUrl(platform, arch);
  console.log(`downloading ${url}`);
  execFileSync("curl", ["-fsSL", url, "-o", archive], { stdio: "inherit" });
  const actual = sha256OfFile(archive);
  if (actual !== sha256) {
    throw new Error(
      `SHA-256 mismatch for ${asset}\n  expected ${sha256}\n  actual   ${actual}`,
    );
  }
  return archive;
}

/**
 * Extract a fetched RMUX release archive into destDir and return the
 * connect-or-start CLI + hidden-daemon helper paths.
 */
export function extractRmuxRelease({ archive, platform, destDir }) {
  mkdirSync(destDir, { recursive: true });
  if (archive.endsWith(".zip")) {
    try {
      // bsdtar ships on modern Windows and reads zip.
      execFileSync("tar", ["-xf", archive, "-C", destDir], { stdio: "pipe" });
    } catch {
      execFileSync(
        "powershell",
        [
          "-NoProfile",
          "-Command",
          `Expand-Archive -LiteralPath '${archive.replaceAll("'", "''")}' -DestinationPath '${destDir.replaceAll("'", "''")}'`,
        ],
        { stdio: "pipe" },
      );
    }
  } else {
    execFileSync("tar", ["-xzf", archive, "-C", destDir], { stdio: "pipe" });
  }

  // Releases extract into a single top-level dir (rmux-0.10.0-<os>-<arch>/).
  const entries = readdirSync(destDir, { withFileTypes: true });
  const topLevel =
    entries.length === 1 && entries[0].isDirectory() ? join(destDir, entries[0].name) : destDir;
  const { cli, helper } = rmuxBinariesForExtractedRelease(topLevel, platform);
  if (!existsSync(cli) || !existsSync(helper)) {
    throw new Error(
      `unexpected RMUX ${platform} release layout: missing ${cli} or ${helper}; ` +
        `update scripts/rmux-release.mjs to the current layout`,
    );
  }
  return { cli, helper };
}

function sha256OfFile(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

import { pathToFileURL } from "node:url";

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  // CLI: fetch the pinned release for the current host and print the cached archive path.
  const archive = fetchRmuxReleaseArchive({
    platform: process.platform,
    arch: process.arch,
    cacheDir: process.env.RMUX_RELEASE_CACHE ?? join(process.cwd(), ".rmux-release-cache"),
  });
  console.log(archive);
}