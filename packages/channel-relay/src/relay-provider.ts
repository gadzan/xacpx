import type {
  ChannelCliInput,
  ChannelCliIo,
  ChannelCliParseResult,
  ChannelCliProvider,
  ChannelCliValidationIssue,
  ChannelRuntimeConfig,
} from "xacpx/plugin-api";
import { normalizeRelayUrl } from "./config.js";

function stringField(input: ChannelCliInput, key: string): string | undefined {
  const value = input[key];
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

export const relayCliProvider: ChannelCliProvider = {
  type: "relay",
  displayName: "Relay Hub",
  supportsLogin: false,

  parseAddArgs(args: string[]): ChannelCliParseResult {
    const input: ChannelCliInput = {};
    for (let i = 0; i < args.length; i++) {
      const arg = args[i];
      const next = args[i + 1];
      if (arg === "--url" || arg === "--token" || arg === "--name") {
        if (!next || next.startsWith("--")) {
          return { ok: false, message: `${arg} requires a value` };
        }
        input[arg.slice(2)] = next;
        i += 1;
      } else {
        return { ok: false, message: `unknown flag: ${arg}` };
      }
    }
    return { ok: true, input };
  },

  buildDefaultConfig(input: ChannelCliInput): ChannelRuntimeConfig {
    const url = stringField(input, "url");
    const pairingToken = stringField(input, "token");
    const name = stringField(input, "name");
    const options: Record<string, unknown> = {};
    if (url !== undefined) options.url = normalizeRelayUrl(url);
    if (pairingToken !== undefined) options.pairingToken = pairingToken;
    if (name !== undefined) options.name = name;
    return {
      id: "relay",
      type: "relay",
      enabled: true,
      options,
    };
  },

  validateConfig(config: ChannelRuntimeConfig): ChannelCliValidationIssue[] {
    const issues: ChannelCliValidationIssue[] = [];
    const options = (config.options ?? {}) as Record<string, unknown>;
    const url = normalizeRelayUrl(typeof options.url === "string" ? options.url : "");
    if (!url) {
      issues.push({ kind: "missing-required-field", flag: "--url", message: "relay url — a domain (wss), or IP[:port] (ws, default :8787) is required" });
    } else if (!url.startsWith("ws://") && !url.startsWith("wss://")) {
      issues.push({ kind: "invalid-config", message: `url must be a domain, IP[:port], or ws(s):// address, got: ${String(options.url ?? "")}` });
    }
    if (typeof options.pairingToken !== "string" || !options.pairingToken) {
      issues.push({ kind: "missing-required-field", flag: "--token", message: "access token is required (generate one with: xacpx-relay add token)" });
    }
    return issues;
  },

  renderSummary(config: ChannelRuntimeConfig): string[] {
    const options = (config.options ?? {}) as Record<string, unknown>;
    const lines = [`relay url: ${String(options.url ?? "")}`, "pairing token: ***"];
    if (typeof options.name === "string") lines.push(`instance name: ${options.name}`);
    return lines;
  },

  async promptForMissingFields(input: ChannelCliInput, io: ChannelCliIo): Promise<ChannelCliInput> {
    const completed: ChannelCliInput = { ...input };
    if (!stringField(completed, "url")) {
      const value = (await io.promptText("Relay url (domain, or IP[:port]; e.g. relay.example.com or 1.2.3.4): ")).trim();
      if (value) completed.url = value;
    }
    if (!stringField(completed, "token")) {
      const value = (await io.promptSecret("Pairing token: ")).trim();
      if (value) completed.token = value;
    }
    return completed;
  },
};
