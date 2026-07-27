import type { XacpxPlugin } from "xacpx/plugin-api";

import { YuanbaoChannel } from "./channel.js";
import { yuanbaoCliProvider } from "./yuanbao-provider.js";

export { YuanbaoChannel } from "./channel.js";
export { yuanbaoCliProvider } from "./yuanbao-provider.js";

const plugin: XacpxPlugin = {
  apiVersion: 1,
  name: "@ganglion/xacpx-channel-yuanbao",
  minXacpxVersion: "0.17.0",
  channels: [
    {
      type: "yuanbao",
      factory: (options, deps) => new YuanbaoChannel(options, deps ? { mediaStore: deps.mediaStore } : undefined),
      cliProvider: yuanbaoCliProvider,
    },
  ],
};

export default plugin;
