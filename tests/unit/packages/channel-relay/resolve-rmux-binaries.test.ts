import { expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  resolveRmuxBinaries,
  RmuxBinaryUnavailableError,
  RMUX_BUNDLED_VERSION,
} from "../../../../packages/channel-relay/src/terminal/resolve-rmux-binaries";

function touchExecutable(path: string): string {
  writeFileSync(path, "#!/bin/sh\nexit 0\n");
  chmodSync(path, 0o755);
  return path;
}

/**
 * Home-relative fixture helpers: the resolver must only ever accept RMUX
 * found beside the selected bridge before falling back to the legacy helper.
 */
function homeWithManagedHelper(dir: string): string {
  const helperDir = join(dir, ".local", "libexec", "rmux");
  mkdirSync(helperDir, { recursive: true });
  touchExecutable(join(helperDir, "rmux.exe"));
  return helperDir;
}

test("bundled RMUX beside a platform-package bridge wins over PATH", () => {
  const dir = mkdtempSync(join(tmpdir(), "rmux-bundled-path-"));
  try {
    const pkgBin = join(dir, "pkg", "bin");
    mkdirSync(pkgBin, { recursive: true });
    const bridge = touchExecutable(join(pkgBin, "xacpx-rmux-bridge.exe"));
    const bundled = touchExecutable(join(pkgBin, "rmux.exe"));

    // Hostile PATH: a stale rmux (e.g. WinGet 0.9.0) that must never win.
    const staleDir = join(dir, "stale-path");
    mkdirSync(staleDir, { recursive: true });
    const stale = touchExecutable(join(staleDir, "rmux.exe"));
    touchExecutable(join(staleDir, "rmux-daemon.exe"));

    const resolved = resolveRmuxBinaries({
      platformPackageResolver: () => bridge,
      pathEnv: staleDir,
      homeDir: join(dir, "home"),
    });
    expect(resolved.source.bridge).toBe("platform-package");
    expect(resolved.rmuxCommand).toBe(bundled);
    expect(resolved.source.rmux).toBe("platform-package");
    expect(resolved.rmuxCommand).not.toBe(stale);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("bundled RMUX wins over a stale managed helper in ~/.local/libexec/rmux", () => {
  const dir = mkdtempSync(join(tmpdir(), "rmux-bundled-helper-"));
  try {
    const pkgBin = join(dir, "pkg", "bin");
    mkdirSync(pkgBin, { recursive: true });
    const bridge = touchExecutable(join(pkgBin, "xacpx-rmux-bridge.exe"));
    const bundled = touchExecutable(join(pkgBin, "rmux.exe"));
    const helperDir = homeWithManagedHelper(dir);

    const resolved = resolveRmuxBinaries({
      platformPackageResolver: () => bridge,
      pathEnv: "",
      homeDir: dir,
    });
    expect(resolved.rmuxCommand).toBe(bundled);
    expect(resolved.source.rmux).toBe("platform-package");
    expect(resolved.rmuxCommand).not.toBe(join(helperDir, "rmux.exe"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("explicit terminal.rmuxCommand always wins over bundled RMUX", () => {
  const dir = mkdtempSync(join(tmpdir(), "rmux-explicit-"));
  try {
    const pkgBin = join(dir, "pkg", "bin");
    mkdirSync(pkgBin, { recursive: true });
    const bridge = touchExecutable(join(pkgBin, "xacpx-rmux-bridge.exe"));
    touchExecutable(join(pkgBin, "rmux.exe"));
    const customDir = join(dir, "custom");
    mkdirSync(customDir, { recursive: true });
    const custom = touchExecutable(join(customDir, "rmux.exe"));

    const resolved = resolveRmuxBinaries({
      bridgeCommand: bridge,
      rmuxCommand: custom,
      pathEnv: "",
      homeDir: dir,
    });
    expect(resolved.rmuxCommand).toBe(custom);
    expect(resolved.source.rmux).toBe("config");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("no bundled RMUX falls back to the managed helper in ~/.local/libexec/rmux", () => {
  const dir = mkdtempSync(join(tmpdir(), "rmux-helper-"));
  try {
    const bridge = touchExecutable(join(dir, "xacpx-rmux-bridge"));
    const helperDir = homeWithManagedHelper(dir);
    const resolved = resolveRmuxBinaries({
      bridgeCommand: bridge,
      pathEnv: "",
      homeDir: dir,
    });
    expect(resolved.rmuxCommand).toBe(join(helperDir, "rmux.exe"));
    expect(resolved.source.rmux).toBe("managed-helper");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("no bundled RMUX or helper falls back to PATH", () => {
  const dir = mkdtempSync(join(tmpdir(), "rmux-path-"));
  try {
    const bridgeBin = join(dir, "bridge-bin");
    mkdirSync(bridgeBin, { recursive: true });
    const bridge = touchExecutable(join(bridgeBin, "xacpx-rmux-bridge"));
    // PATH binaries must live apart from the bridge dir, otherwise the
    // beside-the-bridge lookup legitimately wins first.
    const pathBin = join(dir, "path-bin");
    mkdirSync(pathBin, { recursive: true });
    const onPath = touchExecutable(join(pathBin, "rmux-daemon"));
    const resolved = resolveRmuxBinaries({
      bridgeCommand: bridge,
      pathEnv: pathBin,
      homeDir: join(dir, "empty-home"),
    });
    expect(resolved.rmuxCommand).toBe(onPath);
    expect(resolved.source.rmux).toBe("path");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("prefers rmux-daemon on PATH over rmux (SDK candidate order)", () => {
  const dir = mkdtempSync(join(tmpdir(), "rmux-daemon-path-"));
  try {
    const bridgeBin = join(dir, "bridge-bin");
    mkdirSync(bridgeBin, { recursive: true });
    const bridge = touchExecutable(join(bridgeBin, "xacpx-rmux-bridge"));
    const pathBin = join(dir, "path-bin");
    mkdirSync(pathBin, { recursive: true });
    const daemon = touchExecutable(join(pathBin, "rmux-daemon"));
    touchExecutable(join(pathBin, "rmux"));
    const resolved = resolveRmuxBinaries({
      bridgeCommand: bridge,
      pathEnv: pathBin,
      homeDir: join(dir, "empty-home"),
    });
    expect(resolved.rmuxCommand).toBe(daemon);
    expect(resolved.source.rmux).toBe("path");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("no RMUX anywhere leaves rmuxCommand undefined (SDK self-resolves or fails at handshake)", () => {
  // Documented behavior: when nothing is bundled and nothing is on PATH, the
  // resolver deliberately returns rmuxCommand undefined instead of failing —
  // platform packages always bundle RMUX, so this only happens in dev setups.
  // The sidecar sets no RMUX_SDK_DAEMON_BINARY, the bridge's SDK tries its own
  // defaults, and a machine without any RMUX fails at handshake with an
  // actionable error (surfaced by doctor / relay.terminal_bootstrap_failed).
  const dir = mkdtempSync(join(tmpdir(), "rmux-none-"));
  try {
    const bridge = touchExecutable(join(dir, "xacpx-rmux-bridge"));
    const resolved = resolveRmuxBinaries({
      bridgeCommand: bridge,
      pathEnv: "/empty/missing/path",
      homeDir: join(dir, "empty-home"),
    });
    expect(resolved.rmuxCommand).toBeUndefined();
    expect(resolved.source.rmux).toBeUndefined();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("rmux beside a non-platform-package bridge is labeled beside-bridge, not platform-package", () => {
  const dir = mkdtempSync(join(tmpdir(), "rmux-beside-"));
  try {
    const bridge = touchExecutable(join(dir, "xacpx-rmux-bridge"));
    const daemon = touchExecutable(join(dir, "rmux-daemon.exe"));
    const resolved = resolveRmuxBinaries({
      bridgeCommand: bridge,
      pathEnv: "",
      homeDir: dir,
    });
    expect(resolved.rmuxCommand).toBe(daemon);
    expect(resolved.source.rmux).toBe("beside-bridge");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("resolveRmuxBinaries uses absolute config bridgeCommand when executable", () => {
  const dir = mkdtempSync(join(tmpdir(), "rmux-bin-"));
  try {
    const bridge = touchExecutable(join(dir, "xacpx-rmux-bridge"));
    const resolved = resolveRmuxBinaries({ bridgeCommand: bridge, pathEnv: "", homeDir: dir });
    expect(resolved.bridgeCommand).toBe(bridge);
    expect(resolved.source.bridge).toBe("config");
    expect(resolved.rmuxCommand).toBeUndefined();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("resolveRmuxBinaries rejects missing config bridgeCommand", () => {
  expect(() =>
    resolveRmuxBinaries({ bridgeCommand: "/definitely/missing/xacpx-rmux-bridge", pathEnv: "" }),
  ).toThrow(RmuxBinaryUnavailableError);
});

test("resolveRmuxBinaries rejects missing config rmuxCommand even with bundled RMUX", () => {
  const dir = mkdtempSync(join(tmpdir(), "rmux-bin-"));
  try {
    const bridge = touchExecutable(join(dir, "xacpx-rmux-bridge"));
    touchExecutable(join(dir, "rmux"));
    expect(() =>
      resolveRmuxBinaries({
        bridgeCommand: bridge,
        rmuxCommand: join(dir, "does-not-exist", "rmux"),
        pathEnv: "",
        homeDir: dir,
      }),
    ).toThrow(RmuxBinaryUnavailableError);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("resolveRmuxBinaries finds bridge on PATH", () => {
  const dir = mkdtempSync(join(tmpdir(), "rmux-path-"));
  try {
    const bridge = touchExecutable(join(dir, "xacpx-rmux-bridge"));
    // Force the PATH fallback: the platform-package resolver is enabled by
    // default and would otherwise take priority when @ganglion/xacpx-rmux-bridge-*
    // is installed as an optional dep of the channel-relay workspace (which it
    // is in CI after the lockfile was regenerated with real metadata).
    const resolved = resolveRmuxBinaries({
      pathEnv: dir,
      homeDir: dir,
      platformPackageResolver: () => undefined,
    });
    expect(resolved.bridgeCommand).toBe(bridge);
    expect(resolved.source.bridge).toBe("path");
    expect(resolved.rmuxCommand).toBeUndefined();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("RMUX_BUNDLED_VERSION matches the packaging pin expected by release tooling", () => {
  // The version checked here is the same one verify-publish cross-checks
  // against scripts/rmux-release.mjs and the bridge Cargo.toml. Keeping it
  // under test means a bump requires touching all three consciously.
  expect(RMUX_BUNDLED_VERSION).toBe("0.10.0");
});

test("resolveRmuxBinaries fails closed when nothing at all is available", () => {
  expect(() =>
    resolveRmuxBinaries({
      pathEnv: "/empty-path-that-does-not-exist",
      platformPackageResolver: () => undefined,
    }),
  ).toThrow(RmuxBinaryUnavailableError);
});