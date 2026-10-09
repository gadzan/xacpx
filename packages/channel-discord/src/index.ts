import type { XacpxPlugin } from "xacpx/plugin-api";

import { DiscordChannel } from "./channel.js";
import { discordCliProvider } from "./discord-provider.js";

export { DiscordChannel } from "./channel.js";
export { discordCliProvider } from "./discord-provider.js";

const plugin: XacpxPlugin = {
  apiVersion: 1,
  name: "@ganglion/xacpx-channel-discord",
  // Raised because `channel.ts` statically imports `createConversationExecutor`
  // / `resolveTurnLane` / `toDisplaySessionAlias` and `elicitation-limits.ts`
  // imports `satisfiesElicitationFormat` — RUNTIME named exports from
  // `xacpx/plugin-api` added in 0.24.7-beta.0. An ESM named-export
  // resolution failure happens when the module is LINKED, before the plugin's
  // default export is ever evaluated, so `minXacpxVersion`'s runtime check
  // cannot guard it. The only protection is refusing to load on an older core,
  // which is what this floor and `peerDependencies.xacpx` express together.
  minXacpxVersion: "0.24.7-beta.0",
  channels: [
    {
      type: "discord",
      factory: (options, deps) => new DiscordChannel(options, deps),
      cliProvider: discordCliProvider,
    },
  ],
};

export default plugin;
