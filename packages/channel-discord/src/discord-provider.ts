import type { ChannelRuntimeConfig, ChannelDoctorFinding } from "xacpx/plugin-api";
import { parseBooleanFlag, takeFlagValue } from "./provider.js";
import type { ChannelCliInput, ChannelCliIo, ChannelCliParseResult, ChannelCliProvider, ChannelCliValidationIssue } from "./provider.js";
import { t } from "./i18n/index.js";

const DISCORD_CHANNEL_LEVEL_OPTION_KEYS = ["dedupTtlMs", "dedupMaxEntries", "inboundExpiryMs", "defaultAccount", "accounts", "tuning"] as const;

function stringField(input: ChannelCliInput, key: string): string | undefined {
  const value = input[key];
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

export const discordCliProvider: ChannelCliProvider = {
  type: "discord",
  displayName: "Discord",
  supportsLogin: false,

  parseAddArgs(args: string[]): ChannelCliParseResult {
    const input: ChannelCliInput = {};
    for (let index = 0; index < args.length; index++) {
      const arg = args[index];
      switch (arg) {
        case "--token": {
          const value = takeFlagValue(args, index, arg);
          if (!value.ok) return value;
          input.token = value.value;
          index = value.nextIndex;
          break;
        }
        case "--application-id": {
          const value = takeFlagValue(args, index, arg);
          if (!value.ok) return value;
          input.applicationId = value.value;
          index = value.nextIndex;
          break;
        }
        case "--reply-mode": {
          const value = takeFlagValue(args, index, arg);
          if (!value.ok) return value;
          if (!["auto", "streaming", "static"].includes(value.value)) {
            return { ok: false, message: `${arg} must be one of: auto, streaming, static` };
          }
          input.replyMode = value.value;
          index = value.nextIndex;
          break;
        }
        case "--table-mode": {
          const value = takeFlagValue(args, index, arg);
          if (!value.ok) return value;
          if (!["code", "bullets", "off"].includes(value.value)) {
            return { ok: false, message: `${arg} must be one of: code, bullets, off` };
          }
          input.tableMode = value.value;
          index = value.nextIndex;
          break;
        }
        case "--require-mention": {
          const value = takeFlagValue(args, index, arg);
          if (!value.ok) return value;
          const parsed = parseBooleanFlag(value.value, arg);
          if (!parsed.ok) return parsed;
          input.requireMention = parsed.value;
          index = value.nextIndex;
          break;
        }
        case "--dm-policy": {
          const value = takeFlagValue(args, index, arg);
          if (!value.ok) return value;
          if (!["open", "allowlist", "disabled"].includes(value.value)) {
            return { ok: false, message: `${arg} must be one of: open, allowlist, disabled` };
          }
          input.dmPolicy = value.value;
          index = value.nextIndex;
          break;
        }
        case "--guild-policy": {
          const value = takeFlagValue(args, index, arg);
          if (!value.ok) return value;
          if (!["open", "allowlist", "disabled"].includes(value.value)) {
            return { ok: false, message: `${arg} must be one of: open, allowlist, disabled` };
          }
          input.guildPolicy = value.value;
          index = value.nextIndex;
          break;
        }
        default:
          return { ok: false, message: `unknown discord option: ${arg}` };
      }
    }
    return { ok: true, input };
  },

  buildDefaultConfig(input: ChannelCliInput): ChannelRuntimeConfig {
    const options: Record<string, unknown> = {
      token: stringField(input, "token"),
      applicationId: stringField(input, "applicationId"),
      replyMode: stringField(input, "replyMode") ?? "auto",
      tableMode: stringField(input, "tableMode") ?? "code",
      requireMention: typeof input.requireMention === "boolean" ? input.requireMention : true,
      dmPolicy: stringField(input, "dmPolicy") ?? "allowlist",
      guildPolicy: stringField(input, "guildPolicy") ?? "allowlist",
      dedupTtlMs: 24 * 60 * 60 * 1000,
      dedupMaxEntries: 10000,
      inboundExpiryMs: 5 * 60 * 1000,
    };
    for (const key of Object.keys(options)) {
      if (options[key] === undefined) delete options[key];
    }
    return { id: "discord", type: "discord", enabled: true, options };
  },

  validateConfig(config: ChannelRuntimeConfig): ChannelCliValidationIssue[] {
    const issues: ChannelCliValidationIssue[] = [];
    if (config.id !== "discord") issues.push({ kind: "invalid-config", message: "discord channel id must be discord" });
    if (config.type !== "discord") issues.push({ kind: "invalid-config", message: "discord channel type must be discord" });
    const options = config.options as Record<string, unknown> | undefined;
    const accounts = options && typeof options.accounts === "object" && options.accounts !== null
      ? (options.accounts as Record<string, Record<string, unknown>>)
      : undefined;

    const hasConfiguredAccount = accounts
      ? Object.values(accounts).some((acc) => typeof acc.token === "string" && acc.token.trim().length > 0)
        || (typeof options?.token === "string" && options.token.trim().length > 0)
      : Boolean(typeof options?.token === "string" && options.token.trim().length > 0);

    if (!hasConfiguredAccount) {
      if (!accounts && !options?.token) {
        issues.push({ kind: "missing-required-field", flag: "--token", message: t().providerMissingToken });
      }
      if (accounts) {
        issues.push({ kind: "invalid-config", message: t().providerAccountsMissingCredentials });
      }
    }
    return issues;
  },

  renderSummary(config: ChannelRuntimeConfig): string[] {
    const options = config.options as Record<string, unknown> | undefined;
    const accounts = options && typeof options.accounts === "object" && options.accounts !== null
      ? (options.accounts as Record<string, Record<string, unknown>>)
      : undefined;
    const lines = [
      `type: ${config.type}`,
      `enabled: ${config.enabled}`,
    ];
    if (accounts) {
      lines.push(`defaultAccount: ${String(options?.defaultAccount ?? Object.keys(accounts)[0] ?? "default")}`);
      lines.push(`accounts:`);
      for (const [accountId, acc] of Object.entries(accounts)) {
        const token = acc.token ?? options?.token ?? "";
        const applicationId = acc.applicationId ?? options?.applicationId ?? "";
        const replyMode = acc.replyMode ?? options?.replyMode ?? "auto";
        const tableMode = acc.tableMode ?? options?.tableMode ?? "code";
        const requireMention = acc.requireMention ?? options?.requireMention ?? true;
        const dmPolicy = acc.dmPolicy ?? options?.dmPolicy ?? "allowlist";
        const guildPolicy = acc.guildPolicy ?? options?.guildPolicy ?? "allowlist";
        const enabled = acc.enabled !== false;
        lines.push(`  - ${accountId}${typeof acc.name === "string" && acc.name ? ` (${acc.name})` : ""}${enabled ? "" : " [disabled]"}`);
        lines.push(`      token: ${token ? "***" : "(not set)"}`);
        if (applicationId) lines.push(`      applicationId: ${applicationId}`);
        lines.push(`      replyMode: ${replyMode}`);
        lines.push(`      tableMode: ${tableMode}`);
        lines.push(`      requireMention: ${requireMention}`);
        lines.push(`      dmPolicy: ${dmPolicy}`);
        lines.push(`      guildPolicy: ${guildPolicy}`);
      }
    } else {
      const token = options?.token as string | undefined;
      lines.push(`token: ${token ? "***" : "(not set)"}`);
      lines.push(`tableMode: ${String(options?.tableMode ?? "code")}`);
      lines.push(`requireMention: ${String(options?.requireMention ?? true)}`);
      lines.push(`dmPolicy: ${String(options?.dmPolicy ?? "allowlist")}`);
      lines.push(`guildPolicy: ${String(options?.guildPolicy ?? "allowlist")}`);
    }
    return lines;
  },

  async promptForMissingFields(input: ChannelCliInput, io: ChannelCliIo): Promise<ChannelCliInput> {
    const completed: ChannelCliInput = { ...input };
    if (!stringField(completed, "token")) {
      const value = (await io.promptSecret("Discord bot token: ")).trim();
      if (value) completed.token = value;
    }
    return completed;
  },

  async diagnose(config: ChannelRuntimeConfig): Promise<ChannelDoctorFinding[]> {
    const findings: ChannelDoctorFinding[] = [];
    const options = (config.options ?? {}) as Record<string, unknown>;
    const accountsRaw = options.accounts as Record<string, Record<string, unknown>> | undefined;
    const hasAccounts = accountsRaw && typeof accountsRaw === "object" && Object.keys(accountsRaw).length > 0;

    const checkAccount = (accountId: string, accountOpts: Record<string, unknown>): void => {
      const token = typeof accountOpts.token === "string" ? accountOpts.token.trim() : "";
      const enabled = accountOpts.enabled !== false;
      if (!token) {
        findings.push({
          level: "error",
          code: "discord-token-missing",
          message: `Discord account "${accountId}" is missing token`,
          suggestion: "Run: xacpx channel add discord --token <bot-token> (or set options.accounts.<id>.token)",
        });
      }
      if (!enabled && token) {
        // disabled but configured - not an error, just info; but spec says check disabled but channels enabled?
        // We don't have global enabled check here.
      }
      const intents = accountOpts.intents as Record<string, unknown> | undefined;
      const messageContent = intents?.messageContent;
      // Warn if messageContent not enabled (guild content will be empty)
      if (messageContent === false) {
        findings.push({
          level: "warn",
          code: "discord-message-content-disabled",
          message: `Discord account "${accountId}" has intents.messageContent disabled — guild message content will be empty. Enable Message Content Intent in Discord Developer Portal and set intents.messageContent: true.`,
        });
      }
      // Warn if token looks placeholder-ish but don't hard fail
      if (token && token.length > 0 && token.length < 20) {
        findings.push({
          level: "warn",
          code: "discord-token-shape",
          message: `Discord account "${accountId}" token looks unusually short; verify it is a valid bot token.`,
        });
      }
    };

    if (hasAccounts) {
      for (const [accountId, acc] of Object.entries(accountsRaw!)) {
        const merged: Record<string, unknown> = { ...options, ...acc };
        // Remove channel-level keys that are not account fields
        for (const k of DISCORD_CHANNEL_LEVEL_OPTION_KEYS) delete (merged as Record<string, unknown>)[k];
        // But token is account field, so merged already has it; ensure base token fallback
        if (!acc.token && typeof options.token === "string") merged.token = options.token;
        checkAccount(accountId, merged);
      }
    } else {
      checkAccount(String(options.defaultAccount ?? "default"), options);
    }

    if (findings.length === 0) {
      findings.push({
        level: "ok",
        code: "discord-config-ok",
        message: "Discord config looks OK (shallow check; run with --deep for live probe)",
      });
    }

    return findings;
  },

  supportsMultipleAccounts: true,
  channelLevelOptionKeys: DISCORD_CHANNEL_LEVEL_OPTION_KEYS,

  buildAccountOverride(input: ChannelCliInput): Record<string, unknown> {
    const override: Record<string, unknown> = {};
    const token = stringField(input, "token");
    if (token) override.token = token;
    const applicationId = stringField(input, "applicationId");
    if (applicationId) override.applicationId = applicationId;
    if (typeof input.requireMention === "boolean") override.requireMention = input.requireMention;
    const replyMode = stringField(input, "replyMode");
    if (replyMode) override.replyMode = replyMode;
    const tableMode = stringField(input, "tableMode");
    if (tableMode) override.tableMode = tableMode;
    const dmPolicy = stringField(input, "dmPolicy");
    if (dmPolicy) override.dmPolicy = dmPolicy;
    const guildPolicy = stringField(input, "guildPolicy");
    if (guildPolicy) override.guildPolicy = guildPolicy;
    return override;
  },

  renderAccountSummary(config: ChannelRuntimeConfig, accountId: string): string[] | null {
    const options = config.options as Record<string, unknown> | undefined;
    if (!options) return null;
    const accounts = typeof options.accounts === "object" && options.accounts !== null
      ? (options.accounts as Record<string, Record<string, unknown>>)
      : null;
    const acc = accounts ? accounts[accountId] : (accountId === String(options.defaultAccount ?? "default") ? options : undefined);
    if (!acc) return null;
    const token = acc.token ?? options.token ?? "";
    const applicationId = acc.applicationId ?? options.applicationId ?? "";
    const replyMode = acc.replyMode ?? options.replyMode ?? "auto";
    const tableMode = acc.tableMode ?? options.tableMode ?? "code";
    const requireMention = acc.requireMention ?? options.requireMention ?? true;
    const dmPolicy = acc.dmPolicy ?? options.dmPolicy ?? "allowlist";
    const guildPolicy = acc.guildPolicy ?? options.guildPolicy ?? "allowlist";
    const enabled = acc.enabled !== false;
    const lines = [
      `account: ${accountId}${typeof acc.name === "string" && acc.name ? ` (${acc.name})` : ""}${enabled ? "" : " [disabled]"}`,
      `token: ${token ? "***" : ""}`,
    ];
    if (applicationId) lines.push(`applicationId: ${String(applicationId)}`);
    lines.push(`replyMode: ${String(replyMode)}`);
    lines.push(`tableMode: ${String(tableMode)}`);
    lines.push(`requireMention: ${String(requireMention)}`);
    lines.push(`dmPolicy: ${String(dmPolicy)}`);
    lines.push(`guildPolicy: ${String(guildPolicy)}`);
    return lines;
  },
};
