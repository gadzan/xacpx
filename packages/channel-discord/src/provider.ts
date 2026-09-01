import type { ChannelRuntimeConfig } from "xacpx/plugin-api";

export type ChannelCliInput = Record<string, string | boolean | undefined>;

export type ChannelCliParseResult =
  | { ok: true; input: ChannelCliInput }
  | { ok: false; message: string };

export type ChannelCliValidationIssue =
  | { kind: "missing-required-field"; flag: string; message: string }
  | { kind: "invalid-config"; message: string };

export interface ChannelCliIo {
  print: (line: string) => void;
  stderr: (text: string) => void;
  isInteractive: () => boolean;
  promptText: (message: string) => Promise<string>;
  promptSecret: (message: string) => Promise<string>;
}

export interface ChannelCliProvider {
  type: string;
  displayName: string;
  supportsLogin: boolean;
  parseAddArgs(args: string[]): ChannelCliParseResult;
  buildDefaultConfig(input: ChannelCliInput): ChannelRuntimeConfig;
  validateConfig(config: ChannelRuntimeConfig): ChannelCliValidationIssue[];
  renderSummary(config: ChannelRuntimeConfig): string[];
  promptForMissingFields(input: ChannelCliInput, io: ChannelCliIo): Promise<ChannelCliInput>;
  supportsMultipleAccounts?: boolean;
  buildAccountOverride?(input: ChannelCliInput): Record<string, unknown>;
  channelLevelOptionKeys?: readonly string[];
  renderAccountSummary?(config: ChannelRuntimeConfig, accountId: string): string[] | null;
  diagnose?(config: ChannelRuntimeConfig): Promise<import("xacpx/plugin-api").ChannelDoctorFinding[]> | import("xacpx/plugin-api").ChannelDoctorFinding[];
}

export function parseBooleanFlag(value: string, flagName: string): { ok: true; value: boolean } | { ok: false; message: string } {
  if (value === "true") return { ok: true, value: true };
  if (value === "false") return { ok: true, value: false };
  return { ok: false, message: `${flagName} must be true or false` };
}

export function takeFlagValue(args: string[], index: number, flagName: string): { ok: true; value: string; nextIndex: number } | { ok: false; message: string } {
  const value = args[index + 1];
  if (!value || value.startsWith("--")) {
    return { ok: false, message: `${flagName} requires a value` };
  }
  return { ok: true, value, nextIndex: index + 1 };
}
