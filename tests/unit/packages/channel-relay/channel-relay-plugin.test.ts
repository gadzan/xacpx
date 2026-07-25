import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";

import plugin from "../../../../packages/channel-relay/src/index";
import { validatePluginCompatibility } from "../../../../src/plugins/compatibility";

test("relay connector requires the git-ops-capable xacpx core", () => {
  const pkg = JSON.parse(readFileSync("packages/channel-relay/package.json", "utf8"));

  expect(plugin.minXacpxVersion).toBe("0.17.0");
  expect(pkg.peerDependencies.xacpx).toBe(">=0.17.0");

  expect(() => validatePluginCompatibility(plugin, {
    packageName: plugin.name,
    currentXacpxVersion: "0.16.0",
  })).toThrow();
  expect(() => validatePluginCompatibility(plugin, {
    packageName: plugin.name,
    currentXacpxVersion: "0.17.0",
  })).not.toThrow();
  expect(() => validatePluginCompatibility(plugin, {
    packageName: plugin.name,
    currentXacpxVersion: "0.18.0",
  })).not.toThrow();
});
