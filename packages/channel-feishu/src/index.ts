import type { XacpxPlugin } from "xacpx/plugin-api";

import { FeishuChannel } from "./channel.js";
import { feishuCliProvider } from "./feishu-provider.js";

export { FeishuChannel } from "./channel.js";
export { feishuCliProvider } from "./feishu-provider.js";

const plugin: XacpxPlugin = {
  apiVersion: 1,
  name: "@ganglion/xacpx-channel-feishu",
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
      type: "feishu",
      factory: (options, deps) => new FeishuChannel(options, deps),
      cliProvider: feishuCliProvider,
    },
  ],
};

export default plugin;
