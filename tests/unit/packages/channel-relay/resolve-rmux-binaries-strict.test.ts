import { expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import {
  resolveRmuxBinaries,
  RmuxBinaryUnavailableError,
} from "../../../../packages/channel-relay/src/terminal/resolve-rmux-binaries";

function touchExecutable(path: string): string {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, "#!/bin/sh\nexit 0\n");
  chmodSync(path, 0o755);
  return path;
}

test("incomplete platform package fails closed even when HOME and PATH contain RMUX fallbacks", () => {
  const dir = mkdtempSync(join(tmpdir(), "rmux-platform-strict-"));
  try {
    const pkgBin = join(dir, "pkg", "bin");
    const bridge = touchExecutable(join(pkgBin, "xacpx-rmux-bridge.exe"));
    touchExecutable(join(pkgBin, "rmux.exe"));

    const homeDir = join(dir, "home");
    touchExecutable(join(homeDir, ".local", "libexec", "rmux", "rmux.exe"));
    touchExecutable(join(homeDir, ".local", "libexec", "rmux", "rmux-daemon.exe"));

    const pathDir = join(dir, "path");
    touchExecutable(join(pathDir, "rmux.exe"));
    touchExecutable(join(pathDir, "rmux-daemon.exe"));

    expect(() =>
      resolveRmuxBinaries({
        platformPackageResolver: () => bridge,
        homeDir,
        pathEnv: pathDir,
      }),
    ).toThrow(RmuxBinaryUnavailableError);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
