import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";

import plugin, { FeishuChannel, feishuCliProvider } from "../../../../packages/channel-feishu/src/index";
import { validateWeacpxPlugin } from "../../../../src/plugins/validate-plugin";

test("@ganglion/xacpx-channel-feishu exports a valid plugin definition", () => {
  const validated = validateWeacpxPlugin(plugin, "@ganglion/xacpx-channel-feishu", { currentXacpxVersion: "0.24.6-beta.0" });

  expect(validated.name).toBe("@ganglion/xacpx-channel-feishu");
  expect(validated.channels?.map((channel) => channel.type)).toEqual(["feishu"]);
  expect(validated.channels?.[0]?.cliProvider?.type).toBe("feishu");
});

test("@ganglion/xacpx-channel-feishu declares compatibility metadata", () => {
  expect(plugin.apiVersion).toBe(1);
  expect(plugin.minXacpxVersion).toBe("0.24.6-beta.0");
});

test("feishu's core floor covers the runtime plugin-api exports it imports", () => {
  // `elicitation-limits.ts` statically imports `satisfiesElicitationFormat`, a
  // RUNTIME named export from `xacpx/plugin-api` added in 0.24.6-beta.0. ESM
  // resolves named exports during module linking, BEFORE the plugin's default
  // export is evaluated — so a version floor that is too low would load on a core
  // that then throws a link error the runtime version check never sees.
  const pkg = JSON.parse(readFileSync("packages/channel-feishu/package.json", "utf8")) as {
    peerDependencies: { xacpx: string };
  };
  expect(pkg.peerDependencies.xacpx).toBe(">=0.24.6-beta.0");

  const source = readFileSync("packages/channel-feishu/src/elicitation-limits.ts", "utf8");
  expect(source).toContain('from "xacpx/plugin-api"');
  expect(source).toContain("satisfiesElicitationFormat");

  // Both compatibility gates reject a core that predates the export.
  expect(() => validateWeacpxPlugin(plugin, "@ganglion/xacpx-channel-feishu", { currentXacpxVersion: "0.23.0" })).toThrow();
  expect(() => validateWeacpxPlugin(plugin, "@ganglion/xacpx-channel-feishu", { currentXacpxVersion: "0.24.6-beta.0" }))
    .not.toThrow();
});

test("feishu plugin factory creates the FeishuChannel runtime", () => {
  const channel = plugin.channels?.[0]?.factory({ appId: "cli_xxx", appSecret: "secret_xxx" });

  expect(channel).toBeInstanceOf(FeishuChannel);
  expect(channel?.id).toBe("feishu");
  expect(feishuCliProvider.type).toBe("feishu");
});
