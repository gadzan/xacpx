import type { XacpxPlugin } from "xacpx/plugin-api";

import { WebChannel } from "./channel.js";
import { webCliProvider } from "./provider.js";

export { WebChannel } from "./channel.js";
export { webCliProvider } from "./provider.js";
export { parseWebChannelConfig, isLoopbackHost } from "./config.js";
export type { WebChannelConfig } from "./config.js";

const plugin: XacpxPlugin = {
  apiVersion: 1,
  name: "@ganglion/xacpx-channel-web",
  minXacpxVersion: "0.24.11-beta.0",
  channels: [
    {
      type: "web",
      factory: (options) => new WebChannel(options as Record<string, unknown>),
      cliProvider: webCliProvider,
    },
  ],
};

export default plugin;
