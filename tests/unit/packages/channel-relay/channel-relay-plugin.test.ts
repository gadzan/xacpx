import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";

import plugin from "../../../../packages/channel-relay/src/index";
import { validatePluginCompatibility } from "../../../../src/plugins/compatibility";

test("relay connector requires the M3-elicitation-capable xacpx core", () => {
  const pkg = JSON.parse(readFileSync("packages/channel-relay/package.json", "utf8"));

  expect(plugin.minXacpxVersion).toBe("0.24.10");
  expect(pkg.peerDependencies.xacpx).toBe(">=0.24.10");

  expect(() => validatePluginCompatibility(plugin, {
    packageName: plugin.name,
    currentXacpxVersion: "0.24.9",
  })).toThrow();
  // The floor graduated from a prerelease to `0.24.10`, and a stable minimum
  // normalizes the running core before comparing, so a prerelease of that same
  // version satisfies it (see normalizeCoreVersionForCompat).
  expect(() => validatePluginCompatibility(plugin, {
    packageName: plugin.name,
    currentXacpxVersion: "0.24.10-beta.2",
  })).not.toThrow();
  expect(() => validatePluginCompatibility(plugin, {
    packageName: plugin.name,
    currentXacpxVersion: "0.24.10",
  })).not.toThrow();
  expect(() => validatePluginCompatibility(plugin, {
    packageName: plugin.name,
    currentXacpxVersion: "0.24.11-beta.0",
  })).not.toThrow();
});
