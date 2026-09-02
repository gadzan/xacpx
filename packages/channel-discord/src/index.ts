import type { XacpxPlugin } from "xacpx/plugin-api";

import { DiscordChannel } from "./channel.js";
import { discordCliProvider } from "./discord-provider.js";

export { DiscordChannel } from "./channel.js";
export { discordCliProvider } from "./discord-provider.js";

const plugin: XacpxPlugin = {
  apiVersion: 1,
  name: "@ganglion/xacpx-channel-discord",
  minXacpxVersion: "0.23.0",
  channels: [
    {
      type: "discord",
      factory: (options, deps) => new DiscordChannel(options, deps),
      cliProvider: discordCliProvider,
    },
  ],
};

export default plugin;
