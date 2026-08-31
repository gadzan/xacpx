import type { ChannelRuntimeConfig, ChannelDoctorFinding } from "xacpx/plugin-api";
import { parseDiscordChannelConfig } from "./config.js";
import { parseBooleanFlag, takeFlagValue } from "./provider.js";
import type { ChannelCliInput, ChannelCliIo, ChannelCliParseResult, ChannelCliProvider, ChannelCliValidationIssue } from "./provider.js";
import { t } from "./i18n/index.js";

const DISCORD_CHANNEL_LEVEL_OPTION_KEYS = ["dedupTtlMs", "dedupMaxEntries", "inboundExpiryMs", "defaultAccount", "accounts", "tuning"] as const;

function stringField(input: ChannelCliInput, key: string): string | undefined {
  const value = input[key];
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Cheap "is there any credential at all" test, used only to decide which
 * message the user should see. Semantic validation is delegated to the runtime
 * parser — see validateConfig.
 */
function hasAnyCredential(options: Record<string, unknown>): boolean {
  if (typeof options.token === "string" && options.token.trim().length > 0) return true;
  const accounts = options.accounts;
  if (isRecord(accounts)) {
    for (const account of Object.values(accounts)) {
      if (isRecord(account) && typeof account.token === "string" && account.token.trim().length > 0) return true;
    }
  }
  return false;
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
    const options = config.options;
    if (options === undefined) return issues;
    if (!isRecord(options)) {
      issues.push({ kind: "invalid-config", message: "channel.options must be an object when channel.type is discord" });
      return issues;
    }

    // No credential anywhere: keep the actionable flag hint instead of the
    // parser's generic "token is required".
    if (!hasAnyCredential(options)) {
      const hasAccountsBlock = typeof options.accounts === "object" && options.accounts !== null;
      if (hasAccountsBlock) {
        issues.push({ kind: "invalid-config", message: t().providerAccountsMissingCredentials });
      } else {
        issues.push({ kind: "missing-required-field", flag: "--token", message: t().providerMissingToken });
      }
      return issues;
    }

    // Everything else is the runtime parser's job. Duplicating a rule here is
    // how the CLI came to accept configs that only failed on the next start
    // (e.g. two accounts sharing one bot token), so the parser is called as the
    // single authority and its message is surfaced verbatim.
    try {
      parseDiscordChannelConfig(options);
    } catch (error) {
      issues.push({ kind: "invalid-config", message: error instanceof Error ? error.message : String(error) });
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
      // Warn if messageContent is off: the bot still comes online, but Discord
      // withholds content for ordinary server messages (see the finding below).
      if (messageContent === false) {
        findings.push({
          level: "warn",
          code: "discord-message-content-disabled",
          message: `Discord account "${accountId}" has intents.messageContent disabled, so the plugin does not request the Message Content intent. The bot still comes online, and Discord keeps delivering content for DMs, the bot's own messages and messages that @-mention it — but ordinary server messages arrive with empty content and are dropped, so a requireMention:false guild channel will not respond to plain messages.`,
          suggestion: "Enable Message Content Intent in the Discord Developer Portal and set intents.messageContent: true, or keep it off and require an @-mention (requireMention: true) in server channels.",
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
        message: "Discord config looks OK. This is a static local check — it never contacts Discord, so it cannot see token validity or privileged-intent approval. Start the channel and check the log for Gateway errors (e.g. close code 4014 disallowed intents).",
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
