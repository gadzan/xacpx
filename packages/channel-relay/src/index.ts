import type { XacpxPlugin } from "xacpx/plugin-api";

import { RelayChannel } from "./channel.js";
import { relayCliProvider } from "./relay-provider.js";
import { retireRelayChannelFromCli } from "./retire-channel-cli.js";

export { RelayChannel, defaultTerminalRegistryDir } from "./channel.js";
export { relayCliProvider } from "./relay-provider.js";
export { retireRelayChannelFromCli } from "./retire-channel-cli.js";
export { parseRelayChannelConfig, parseRelayTerminalConfig, parseRelayDesktopConfig } from "./config.js";
export type { RelayChannelConfig, RelayDesktopConfig, RelayTerminalConfig } from "./config.js";
export { clientVersionForBanner, evaluateRfbHandshake, parseBanner, probeLoopbackRfb, RFB_CLIENT_VERSION_BYTES, RFB_LOOPBACK_HOST } from "./desktop/rfb-probe.js";
export type { RfbProbeErrorCode, RfbProbeVerdict } from "./desktop/rfb-probe.js";
export { desktopSetupGuidance } from "./desktop/platform-guidance.js";
export { DesktopTunnelRuntime } from "./desktop/desktop-tunnel-runtime.js";
export {
  retireRelayTerminals,
  type RetireRelayTerminalsInput,
  type RetireRelayTerminalsResult,
} from "./terminal/retire-terminals.js";
export {
  diagnoseRelayTerminal,
  redactPathForDoctor,
  type ChannelDoctorFinding,
  type ChannelDoctorFindingLevel,
  type DiagnoseRelayTerminalInput,
} from "./terminal/terminal-diagnostics.js";
export {
  logTerminalEvent,
  sanitizeTerminalLogFields,
  TERMINAL_LOG_EVENTS,
  type TerminalLogEvent,
  type TerminalLogFields,
} from "./terminal/terminal-log.js";

const plugin: XacpxPlugin = {
  apiVersion: 1,
  name: "@ganglion/xacpx-channel-relay",
  // Raised for the M3 elicitation chain: `channel.ts` statically imports
  // `isDirectConversationChatKey` / `parseDirectConversationChatKey` — RUNTIME
  // named exports from `xacpx/plugin-api` added after 0.24.6-beta.0. An ESM
  // named-export resolution failure happens when the module is LINKED, before
  // the plugin's default export is ever evaluated, so `minXacpxVersion`'s
  // runtime check cannot guard it. The only protection is refusing to load on
  // an older core, which is what this floor and `peerDependencies.xacpx`
  // express together.
  minXacpxVersion: "0.24.8-beta.0",
  channels: [
    {
      type: "relay",
      factory: (options, deps) => new RelayChannel(options, deps as never),
      cliProvider: relayCliProvider,
      retireChannel: retireRelayChannelFromCli,
    },
  ],
};

export default plugin;
