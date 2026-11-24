import { expect, test } from "bun:test";

import plugin from "../../../../packages/channel-web/src/index";

test("the local web plugin names the current core floor", () => {
  expect(plugin.name).toBe("@ganglion/xacpx-channel-web");
  expect(plugin.minXacpxVersion).toBe("0.24.11-beta.0");
  expect(plugin.channels.map((channel) => channel.type)).toEqual(["web"]);
});
