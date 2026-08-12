import type { ChannelRuntimeConfig } from "../../config/types";

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

/**
 * Structured doctor finding from an optional channel/plugin diagnostic hook.
 * Core renders these verbatim and must not interpret RMUX-specific codes.
 */
export type ChannelDoctorFindingLevel = "ok" | "warn" | "error" | "skip";

export interface ChannelDoctorFinding {
  level: ChannelDoctorFindingLevel;
  code: string;
  message: string;
  suggestion?: string;
  details?: Record<string, string | number | boolean | null>;
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

  /**
   * Optional read-only health probe for `xacpx doctor` / `xacpx plugin doctor`.
   * Must not mutate registry, credentials, or kill resources.
   */
  diagnose?(config: ChannelRuntimeConfig): Promise<ChannelDoctorFinding[]> | ChannelDoctorFinding[];

  /**
   * Optional: declares this plugin supports the `xacpx channel ... --account <id>`
   * multi-bot CLI surface. Plugins that opt in must also implement
   * {@link buildAccountOverride} and {@link channelLevelOptionKeys}.
   */
  supportsMultipleAccounts?: boolean;

  /**
   * Optional: builds the per-account override object that core nests under
   * `options.accounts.<accountId>`. Should NOT include channel-level fields
   * (those live on top-level `options`).
   */
  buildAccountOverride?(input: ChannelCliInput): Record<string, unknown>;

  /**
   * Optional: option keys that stay on top-level `options` (not duplicated into
   * each account). Used to migrate a legacy flat single-bot config into the
   * accounts shape on first `--account` add.
   */
  channelLevelOptionKeys?: readonly string[];

  /**
   * Optional: renders summary lines for a single account inside a multi-bot
   * channel. Falls back to {@link renderSummary} on the whole channel when
   * unspecified.
   */
  renderAccountSummary?(config: ChannelRuntimeConfig, accountId: string): string[] | null;
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
