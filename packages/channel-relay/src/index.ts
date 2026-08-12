import type { XacpxPlugin } from "xacpx/plugin-api";

import { RelayChannel } from "./channel.js";
import { relayCliProvider } from "./relay-provider.js";

export { RelayChannel, defaultTerminalRegistryDir } from "./channel.js";
export { relayCliProvider } from "./relay-provider.js";
export { parseRelayChannelConfig, parseRelayTerminalConfig } from "./config.js";
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
  minXacpxVersion: "0.17.0",
  channels: [
    {
      type: "relay",
      factory: (options, deps) => new RelayChannel(options, deps as never),
      cliProvider: relayCliProvider,
    },
  ],
};

export default plugin;
