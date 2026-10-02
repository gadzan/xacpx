/**
 * The Discord plugin's published contract: its metadata, and the compatibility
 * floor that keeps it from loading on a core without the runtime exports it
 * imports.
 */

import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";

import plugin, { DiscordChannel } from "../../../../packages/channel-discord/src/index";
import { validateWeacpxPlugin } from "../../../../src/plugins/validate-plugin";

test("@ganglion/xacpx-channel-discord exports a valid plugin definition", () => {
  const validated = validateWeacpxPlugin(plugin, "@ganglion/xacpx-channel-discord", {
    currentXacpxVersion: "0.24.6-beta.0",
  });

  expect(validated.name).toBe("@ganglion/xacpx-channel-discord");
  expect(validated.channels?.map((channel) => channel.type)).toEqual(["discord"]);
});

test("discord's core floor covers the runtime plugin-api exports it imports", () => {
  // `elicitation-limits.ts` statically imports `satisfiesElicitationFormat`, a
  // RUNTIME named export from `xacpx/plugin-api` added in 0.24.6-beta.0. ESM
  // resolves named exports during module linking, BEFORE the plugin's default
  // export is evaluated — so a floor that is too low lets the plugin load on a
  // core that then throws a link error the runtime version check never sees.
  // `minXacpxVersion` alone cannot protect against that; `peerDependencies`
  // plus this floor is the only thing that can.
  const pkg = JSON.parse(readFileSync("packages/channel-discord/package.json", "utf8")) as {
    peerDependencies: { xacpx: string };
  };
  expect(pkg.peerDependencies.xacpx).toBe(">=0.24.6-beta.0");

  const source = readFileSync("packages/channel-discord/src/elicitation-limits.ts", "utf8");
  expect(source).toContain('from "xacpx/plugin-api"');
  expect(source).toContain("satisfiesElicitationFormat");

  // A core predating the export is rejected before the plugin is evaluated.
  expect(() => validateWeacpxPlugin(plugin, "@ganglion/xacpx-channel-discord", { currentXacpxVersion: "0.23.0" }))
    .toThrow();
  expect(() => validateWeacpxPlugin(plugin, "@ganglion/xacpx-channel-discord", { currentXacpxVersion: "0.24.6-beta.0" }))
    .not.toThrow();
});

test("discord plugin factory creates the DiscordChannel runtime", () => {
  const channel = plugin.channels?.[0]?.factory({ token: "t" });
  expect(channel).toBeInstanceOf(DiscordChannel);
  expect(channel?.id).toBe("discord");
});
