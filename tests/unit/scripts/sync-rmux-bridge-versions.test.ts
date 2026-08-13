import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  collectRmuxBridgeVersionDrift,
  syncRmuxBridgeVersions,
} from "../../../scripts/sync-rmux-bridge-versions.mjs";

const tempRoots: string[] = [];

afterEach(async () => {
  for (const root of tempRoots.splice(0)) {
    await rm(root, { recursive: true, force: true });
  }
});

async function writeJson(path: string, value: unknown): Promise<void> {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function fixtureRepo(channelVersion: string, bridgeVersion: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "rmux-bridge-sync-"));
  tempRoots.push(root);
  await mkdir(join(root, "packages/channel-relay"), { recursive: true });
  await mkdir(join(root, "platform-packages/xacpx-rmux-bridge-linux-x64"), { recursive: true });
  await mkdir(join(root, "platform-packages/xacpx-rmux-bridge-darwin-arm64"), { recursive: true });

  await writeJson(join(root, "packages/channel-relay/package.json"), {
    name: "@ganglion/xacpx-channel-relay",
    version: channelVersion,
    optionalDependencies: {
      "@ganglion/xacpx-rmux-bridge-linux-x64": bridgeVersion,
      "@ganglion/xacpx-rmux-bridge-darwin-arm64": bridgeVersion,
    },
  });
  await writeJson(join(root, "platform-packages/xacpx-rmux-bridge-linux-x64/package.json"), {
    name: "@ganglion/xacpx-rmux-bridge-linux-x64",
    version: bridgeVersion,
  });
  await writeJson(join(root, "platform-packages/xacpx-rmux-bridge-darwin-arm64/package.json"), {
    name: "@ganglion/xacpx-rmux-bridge-darwin-arm64",
    version: bridgeVersion,
  });
  return root;
}

test("detects drift when channel-relay pins stale bridge betas", async () => {
  const root = await fixtureRepo("0.5.2", "0.5.0-beta.0");
  const drift = collectRmuxBridgeVersionDrift(root);
  expect(drift.some((line) => line.includes("0.5.0-beta.0"))).toBe(true);
});

test("sync rewrites optionalDependencies and platform package versions", async () => {
  const root = await fixtureRepo("0.5.2", "0.5.0-beta.0");
  const result = syncRmuxBridgeVersions(root);
  expect(result.version).toBe("0.5.2");
  expect(collectRmuxBridgeVersionDrift(root)).toEqual([]);

  const channelRelay = JSON.parse(
    await readFile(join(root, "packages/channel-relay/package.json"), "utf8"),
  );
  expect(channelRelay.optionalDependencies).toEqual({
    "@ganglion/xacpx-rmux-bridge-darwin-arm64": "0.5.2",
    "@ganglion/xacpx-rmux-bridge-linux-x64": "0.5.2",
  });
  const linux = JSON.parse(
    await readFile(join(root, "platform-packages/xacpx-rmux-bridge-linux-x64/package.json"), "utf8"),
  );
  expect(linux.version).toBe("0.5.2");
});
