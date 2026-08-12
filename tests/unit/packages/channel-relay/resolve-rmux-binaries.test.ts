import { expect, test } from "bun:test";
import { chmodSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  resolveRmuxBinaries,
  RmuxBinaryUnavailableError,
} from "../../../../packages/channel-relay/src/terminal/resolve-rmux-binaries";

test("resolveRmuxBinaries uses absolute config bridgeCommand when executable", () => {
  const dir = mkdtempSync(join(tmpdir(), "rmux-bin-"));
  try {
    const bridge = join(dir, "xacpx-rmux-bridge");
    writeFileSync(bridge, "#!/bin/sh\nexit 0\n");
    chmodSync(bridge, 0o755);
    const resolved = resolveRmuxBinaries({ bridgeCommand: bridge, pathEnv: "" });
    expect(resolved.bridgeCommand).toBe(bridge);
    expect(resolved.source.bridge).toBe("config");
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
    const bridge = join(dir, "xacpx-rmux-bridge");
    writeFileSync(bridge, "#!/bin/sh\nexit 0\n");
    chmodSync(bridge, 0o755);
    const resolved = resolveRmuxBinaries({ pathEnv: dir });
    expect(resolved.bridgeCommand).toBe(bridge);
    expect(resolved.source.bridge).toBe("path");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("resolveRmuxBinaries fails closed when nothing is available", () => {
  expect(() => resolveRmuxBinaries({ pathEnv: "/empty-path-that-does-not-exist" })).toThrow(
    RmuxBinaryUnavailableError,
  );
});
