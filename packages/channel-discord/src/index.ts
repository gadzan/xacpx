import type { XacpxPlugin } from "xacpx/plugin-api";

import { DiscordChannel } from "./channel.js";
import { discordCliProvider } from "./discord-provider.js";

export { DiscordChannel } from "./channel.js";
export { discordCliProvider } from "./discord-provider.js";

const plugin: XacpxPlugin = {
  apiVersion: 1,
  name: "@ganglion/xacpx-channel-discord",
  // Raised past the plugin's own 0.23.0 floor because `elicitation-limits.ts`
  // imports `satisfiesElicitationFormat` — a RUNTIME named export from
  // `xacpx/plugin-api` that this core release added. An ESM named-export
  // resolution failure happens when the module is LINKED, before the plugin's
  // default export is ever evaluated, so `minXacpxVersion`'s runtime check
  // cannot guard it. The only protection is refusing to load on an older core,
  // which is what this floor and `peerDependencies.xacpx` express together.
  minXacpxVersion: "0.24.6-beta.0",
  channels: [
    {
      type: "discord",
      factory: (options, deps) => new DiscordChannel(options, deps),
      cliProvider: discordCliProvider,
    },
  ],
};

export default plugin;
