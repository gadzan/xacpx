import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";

import plugin from "../../../../packages/channel-relay/src/index";
import { validatePluginCompatibility } from "../../../../src/plugins/compatibility";

test("relay connector requires the M3-elicitation-capable xacpx core", () => {
  const pkg = JSON.parse(readFileSync("packages/channel-relay/package.json", "utf8"));

  expect(plugin.minXacpxVersion).toBe("0.24.10-beta.9");
  expect(pkg.peerDependencies.xacpx).toBe(">=0.24.10-beta.9");

  expect(() => validatePluginCompatibility(plugin, {
    packageName: plugin.name,
    currentXacpxVersion: "0.24.10-beta.2",
  })).toThrow();
  expect(() => validatePluginCompatibility(plugin, {
    packageName: plugin.name,
    currentXacpxVersion: "0.24.10-beta.9",
  })).not.toThrow();
  expect(() => validatePluginCompatibility(plugin, {
    packageName: plugin.name,
    currentXacpxVersion: "0.24.11-beta.0",
  })).not.toThrow();
});
