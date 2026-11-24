import type {
  ChannelCliInput,
  ChannelCliIo,
  ChannelCliParseResult,
  ChannelCliProvider,
  ChannelRuntimeConfig,
} from "xacpx/plugin-api";

import { validateWebChannelConfig, webConfigFromCli } from "./config.js";

function take(args: string[], index: number, flag: string): string {
  const value = args[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${flag} requires a value`);
  return value;
}

export const webCliProvider: ChannelCliProvider = {
  type: "web",
  displayName: "Local web",
  supportsLogin: false,

  parseAddArgs(args: string[]): ChannelCliParseResult {
    const input: ChannelCliInput = {};
    try {
      for (let i = 0; i < args.length; i += 1) {
        const arg = args[i] ?? "";
        if (arg === "--no-terminal") {
          input.terminal = "false";
        } else if (arg === "--host" || arg === "--port" || arg === "--token" || arg === "--name") {
          input[arg.slice(2)] = take(args, i, arg);
          i += 1;
        } else {
          return { ok: false, message: `unknown flag: ${arg}` };
        }
      }
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : "invalid arguments" };
    }
    return { ok: true, input };
  },

  buildDefaultConfig(input: ChannelCliInput): ChannelRuntimeConfig {
    return {
      id: "web",
      type: "web",
      enabled: true,
      options: webConfigFromCli(input),
    };
  },

  validateConfig(config: ChannelRuntimeConfig) {
    return validateWebChannelConfig(config);
  },

  renderSummary(config: ChannelRuntimeConfig): string[] {
    const options = (config.options ?? {}) as Record<string, unknown>;
    const host = typeof options.host === "string" ? options.host : "127.0.0.1";
    const port = typeof options.port === "number" ? options.port : 7890;
    const terminal = options.terminal as { enabled?: unknown } | undefined;
    const lines = [`web: http://${host}:${port}`, `terminal: ${terminal?.enabled === false ? "disabled" : "enabled"}`];
    if (typeof options.token === "string" && options.token.length > 0) lines.push("access token: ***");
    if (typeof options.name === "string") lines.push(`name: ${options.name}`);
    return lines;
  },

  async promptForMissingFields(input: ChannelCliInput, _io: ChannelCliIo): Promise<ChannelCliInput> {
    return { ...input };
  },
};
