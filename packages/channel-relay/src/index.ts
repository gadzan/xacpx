import type { XacpxPlugin } from "xacpx/plugin-api";

import { RelayChannel } from "./channel.js";
import { relayCliProvider } from "./relay-provider.js";

export { RelayChannel } from "./channel.js";
export { relayCliProvider } from "./relay-provider.js";

const plugin: XacpxPlugin = {
  apiVersion: 1,
  name: "@ganglion/xacpx-channel-relay",
  minXacpxVersion: "0.17.0-beta.10",
  channels: [
    {
      type: "relay",
      factory: (options, deps) => new RelayChannel(options, deps as never),
      cliProvider: relayCliProvider,
    },
  ],
};

export default plugin;
