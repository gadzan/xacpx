import { hostname } from "node:os";

import type { ChannelCliInput, ChannelCliValidationIssue, ChannelRuntimeConfig } from "xacpx/plugin-api";

export const DEFAULT_WEB_HOST = "127.0.0.1";
export const DEFAULT_WEB_PORT = 7890;
export const LOCAL_INSTANCE_ID = "local";

export interface WebTerminalConfig {
  enabled: boolean;
}

export interface WebChannelConfig {
  host: string;
  port: number;
  token?: string;
  name?: string;
  terminal: WebTerminalConfig;
}

export function isLoopbackHost(host: string): boolean {
  const value = host.trim().toLowerCase();
  return value === "127.0.0.1" || value === "localhost" || value === "::1" || value === "[::1]";
}

export function parseWebChannelConfig(options: Record<string, unknown> | undefined): WebChannelConfig {
  const raw = options ?? {};
  const host = typeof raw.host === "string" && raw.host.trim() ? raw.host.trim() : DEFAULT_WEB_HOST;
  const portValue = raw.port;
  const port = typeof portValue === "number"
    ? portValue
    : typeof portValue === "string" && portValue.trim()
      ? Number(portValue)
      : DEFAULT_WEB_PORT;
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`web port must be an integer from 1 to 65535, got: ${String(portValue)}`);
  }
  const token = typeof raw.token === "string" && raw.token.length > 0 ? raw.token : undefined;
  const name = typeof raw.name === "string" && raw.name.trim() ? raw.name.trim() : undefined;
  if (host === "0.0.0.0" || host === "::" || host === "[::]") {
    throw new Error(`web host ${host} is not an address a browser can open; choose that computer's own address and set --token`);
  }
  if (!isLoopbackHost(host) && !token) {
    throw new Error(`web host ${host} is not loopback and needs --token; refusing to start without one`);
  }
  const terminal = raw.terminal;
  let enabled = true;
  if (terminal !== undefined) {
    if (typeof terminal !== "object" || terminal === null || Array.isArray(terminal)) {
      throw new Error("web terminal options must be an object");
    }
    const value = (terminal as { enabled?: unknown }).enabled;
    if (value !== undefined && typeof value !== "boolean") {
      throw new Error("web terminal.enabled must be a boolean");
    }
    enabled = value !== false;
  }
  return { host, port, ...(token ? { token } : {}), ...(name ? { name } : {}), terminal: { enabled } };
}

export function webConfigFromCli(input: ChannelCliInput): Record<string, unknown> {
  const options: Record<string, unknown> = {};
  if (typeof input.host === "string" && input.host.trim()) options.host = input.host.trim();
  if (typeof input.port === "string" && input.port.trim()) options.port = Number(input.port);
  if (typeof input.token === "string" && input.token.length > 0) options.token = input.token;
  if (typeof input.name === "string" && input.name.trim()) options.name = input.name.trim();
  if (input.terminal === "false" || input.terminal === false) options.terminal = { enabled: false };
  return options;
}

export function validateWebChannelConfig(config: ChannelRuntimeConfig): ChannelCliValidationIssue[] {
  try {
    parseWebChannelConfig((config.options ?? {}) as Record<string, unknown>);
    return [];
  } catch (error) {
    return [{
      kind: "invalid-config",
      message: error instanceof Error ? error.message : "invalid web channel config",
    }];
  }
}

export function localInstanceName(config: WebChannelConfig): string {
  return config.name ?? hostname();
}
