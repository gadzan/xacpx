import { expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  resolveRmuxBinaries,
  RmuxBinaryUnavailableError,
} from "../../../../packages/channel-relay/src/terminal/resolve-rmux-binaries";

function touchExecutable(path: string): string {
  writeFileSync(path, "#!/bin/sh\nexit 0\n");
  chmodSync(path, 0o755);
  return path;
}

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

test("resolveRmuxBinaries finds bridge on PATH", () => {
  const dir = mkdtempSync(join(tmpdir(), "rmux-path-"));
  try {
    const bridge = touchExecutable(join(dir, "xacpx-rmux-bridge"));
    const resolved = resolveRmuxBinaries({ pathEnv: dir, homeDir: dir });
    expect(resolved.bridgeCommand).toBe(bridge);
    expect(resolved.source.bridge).toBe("path");
    expect(resolved.rmuxCommand).toBeUndefined();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("resolveRmuxBinaries finds Windows-style rmux.exe under ~/.local/libexec/rmux", () => {
  const dir = mkdtempSync(join(tmpdir(), "rmux-helper-"));
  try {
    const bridge = touchExecutable(join(dir, "xacpx-rmux-bridge"));
    const helperDir = join(dir, ".local", "libexec", "rmux");
    mkdirSync(helperDir, { recursive: true });
    const helper = touchExecutable(join(helperDir, "rmux.exe"));
    const resolved = resolveRmuxBinaries({
      bridgeCommand: bridge,
      pathEnv: "",
      homeDir: dir,
    });
    expect(resolved.rmuxCommand).toBe(helper);
    expect(resolved.source.rmux).toBe("path");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("resolveRmuxBinaries prefers rmux-daemon on PATH over rmux", () => {
  const dir = mkdtempSync(join(tmpdir(), "rmux-daemon-path-"));
  try {
    const bridge = touchExecutable(join(dir, "xacpx-rmux-bridge"));
    const daemon = touchExecutable(join(dir, "rmux-daemon"));
    touchExecutable(join(dir, "rmux"));
    const resolved = resolveRmuxBinaries({
      bridgeCommand: bridge,
      pathEnv: dir,
      homeDir: dir,
    });
    expect(resolved.rmuxCommand).toBe(daemon);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("resolveRmuxBinaries finds a daemon sitting next to the bridge", () => {
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
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});


test("resolveRmuxBinaries fails closed when nothing is available", () => {
  expect(() => resolveRmuxBinaries({ pathEnv: "/empty-path-that-does-not-exist" })).toThrow(
    RmuxBinaryUnavailableError,
  );
});
