import { expect, test, beforeAll, afterAll } from "bun:test";

import type { AppConfig, ChannelRuntimeConfig } from "../../../src/config/types";
import { handleChannelCli } from "../../../src/channels/cli/channel-cli";
import { getChannelCliProvider, hasChannelCliProvider, listChannelCliProviders } from "../../../src/channels/cli/registry";
import { hasChannelFactory } from "../../../src/channels/create-channel";
import { registerChannelPlugin, unregisterChannelPlugin } from "../../../src/channels/plugin";
import feishuPlugin from "../../../packages/channel-feishu/src/index";
import { setLocale, t } from "../../../src/i18n";
// The feishu provider's validateConfig runs outside start(), so it uses the
// plugin's own i18n module (separate from core's). Pin its locale directly —
// core's setLocale cannot reach the plugin catalog (bundle isolation).
import { setChannelLocale } from "../../../packages/channel-feishu/src/i18n";

/**
 * Plugin types THIS file registered. Bun runs every test file in one process,
 * so a registration left behind leaks into later files — moved-channel-hints
 * asserts the "plugin not installed" hints, which only hold on a clean
 * registry. afterAll puts the process back the way it found it.
 */
const registeredHere: string[] = [];

beforeAll(() => { setLocale("zh"); setChannelLocale("zh"); });
afterAll(() => {
  setLocale("en"); setChannelLocale("en");
  for (const type of registeredHere) unregisterChannelPlugin(type);
});

function ensureFeishuPluginRegisteredForTest(): void {
  const factoryRegistered = hasChannelFactory("feishu");
  const cliProviderRegistered = hasChannelCliProvider("feishu");
  if (factoryRegistered !== cliProviderRegistered) {
    throw new Error("inconsistent feishu test registration state");
  }
  if (!factoryRegistered) {
    registerChannelPlugin(feishuPlugin.channels![0]!);
    registeredHere.push("feishu");
  }
}

function baseConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    transport: { type: "acpx-bridge", permissionMode: "approve-all", nonInteractivePermissions: "deny" },
    logging: { level: "info", maxSizeBytes: 2097152, maxFiles: 5, retentionDays: 7 },
    channel: { type: "weixin", replyMode: "stream" },
    channels: [{ id: "weixin", type: "weixin", enabled: true }],
    plugins: [],
    agents: { codex: { driver: "codex" } },
    workspaces: {},
    orchestration: {
      maxPendingAgentRequestsPerCoordinator: 3,
      allowWorkerChainedRequests: false,
      allowedAgentRequestTargets: [],
      allowedAgentRequestRoles: [],
      progressHeartbeatSeconds: 300,
    },
    ...overrides,
  };
}

function createHarness(initial: AppConfig) {
  let config = structuredClone(initial) as AppConfig;
  const lines: string[] = [];
  const stderr: string[] = [];
  return {
    lines,
    stderr,
    getConfig: () => config,
    deps: {
      loadConfig: async () => structuredClone(config) as AppConfig,
      saveChannels: async (next: ChannelRuntimeConfig[]) => {
        config = { ...config, channels: structuredClone(next) as ChannelRuntimeConfig[] };
      },
      print: (line: string) => lines.push(line),
      stderr: (text: string) => stderr.push(text),
      isInteractive: () => false,
      promptText: async () => "",
      promptSecret: async () => "",
      getDaemonStatus: async () => ({ state: "stopped" as const }),
      restartDaemon: async () => 0,
    },
  };
}

test("built-in channel CLI registry exposes only weixin before plugins load", () => {
  const types = listChannelCliProviders().map((provider) => provider.type);
  expect(types).toContain("weixin");
  expect(types).not.toContain("feishu");
  expect(types).not.toContain("yuanbao");
  expect(getChannelCliProvider("weixin")?.supportsLogin).toBe(true);
  expect(getChannelCliProvider("unknown-channel-type")).toBeNull();
});

test("registering @ganglion/xacpx-channel-feishu plugin makes feishu available", () => {
  ensureFeishuPluginRegisteredForTest();
  expect(hasChannelFactory("feishu")).toBe(true);
  expect(hasChannelCliProvider("feishu")).toBe(true);
});

test("weixin provider builds default runtime channel", async () => {
  const provider = getChannelCliProvider("weixin");
  expect(provider).not.toBeNull();

  const parsed = provider!.parseAddArgs([]);
  expect(parsed).toEqual({ ok: true, input: {} });
  expect(provider!.buildDefaultConfig(parsed.ok ? parsed.input : {})).toEqual({
    id: "weixin",
    type: "weixin",
    enabled: true,
  });
});

test("feishu provider parses flags and redacts appSecret", async () => {
  const provider = getChannelCliProvider("feishu");
  expect(provider).not.toBeNull();

  const parsed = provider!.parseAddArgs([
    "--app-id",
    "cli_xxx",
    "--app-secret",
    "secret_xxx",
    "--domain",
    "lark",
    "--require-mention",
    "false",
  ]);

  expect(parsed).toEqual({
    ok: true,
    input: {
      appId: "cli_xxx",
      appSecret: "secret_xxx",
      domain: "lark",
      requireMention: false,
    },
  });

  const config = provider!.buildDefaultConfig(parsed.ok ? parsed.input : {});
  expect(config).toEqual({
    id: "feishu",
    type: "feishu",
    enabled: true,
    options: {
      appId: "cli_xxx",
      appSecret: "secret_xxx",
      domain: "lark",
      requireMention: false,
      textMessageFormat: "text",
      dedupTtlMs: 43200000,
      dedupMaxEntries: 5000,
    },
  });
  expect(provider!.renderSummary(config)).toContain("appSecret: ***");
  expect(provider!.renderSummary(config).join("\n")).not.toContain("secret_xxx");
});

test("feishu provider rejects invalid require-mention boolean", () => {
  const provider = getChannelCliProvider("feishu")!;
  expect(provider.parseAddArgs(["--require-mention", "maybe"])).toEqual({
    ok: false,
    message: "--require-mention must be true or false",
  });
});

test("feishu provider reports missing required fields structurally", () => {
  const provider = getChannelCliProvider("feishu")!;
  const config = provider.buildDefaultConfig({});

  const missingIssues = provider.validateConfig(config).filter((issue) => issue.kind === "missing-required-field");

  expect(missingIssues.map((issue) => issue.flag)).toEqual(["--app-id", "--app-secret"]);
  expect(missingIssues.map((issue) => issue.message)).toEqual(["缺少 Feishu appId", "缺少 Feishu appSecret"]);
});

test("channel list renders configured channels without secrets", async () => {
  const harness = createHarness(baseConfig({
    channels: [
      { id: "weixin", type: "weixin", enabled: true },
      {
        id: "feishu",
        type: "feishu",
        enabled: false,
        options: {
          appId: "cli_xxx",
          appSecret: "secret_xxx",
          domain: "feishu",
          requireMention: true,
          textMessageFormat: "text",
          dedupTtlMs: 43200000,
          dedupMaxEntries: 5000,
        },
      },
    ],
  }));

  await expect(handleChannelCli(["list"], harness.deps)).resolves.toBe(0);

  expect(harness.lines.join("\n")).toContain("weixin");
  expect(harness.lines.join("\n")).toContain("feishu");
  expect(harness.lines.join("\n")).toContain("disabled");
  expect(harness.lines.join("\n")).not.toContain("secret_xxx");
});

test("channel show redacts feishu appSecret", async () => {
  const harness = createHarness(baseConfig({
    channels: [{
      id: "feishu",
      type: "feishu",
      enabled: true,
      feishu: {
        appId: "cli_xxx",
        appSecret: "secret_xxx",
        domain: "feishu",
        requireMention: true,
        textMessageFormat: "text",
        dedupTtlMs: 43200000,
        dedupMaxEntries: 5000,
      },
    }],
  }));

  await expect(handleChannelCli(["show", "feishu"], harness.deps)).resolves.toBe(0);

  expect(harness.lines).toContain("appSecret: ***");
  expect(harness.lines.join("\n")).not.toContain("secret_xxx");
});

test("channel show returns 1 for absent channel", async () => {
  const harness = createHarness(baseConfig());

  await expect(handleChannelCli(["show", "feishu"], harness.deps)).resolves.toBe(1);

  expect(harness.lines).toEqual([t().channelCli.channelNotFound("feishu")]);
});

test("channel add weixin writes runtime channel when absent", async () => {
  const harness = createHarness(baseConfig({ channels: [] }));

  await expect(handleChannelCli(["add", "weixin", "--no-restart"], harness.deps)).resolves.toBe(0);

  expect(harness.getConfig().channels).toEqual([{ id: "weixin", type: "weixin", enabled: true }]);
  expect(harness.lines).toContain(t().channelCli.channelAdded("weixin"));
});

test("channel add feishu writes runtime config from flags and does not rewrite legacy channel.type", async () => {
  const harness = createHarness(baseConfig({ channels: [{ id: "weixin", type: "weixin", enabled: true }] }));

  await expect(
    handleChannelCli([
      "add",
      "feishu",
      "--app-id",
      "cli_xxx",
      "--app-secret",
      "secret_xxx",
      "--domain",
      "lark",
      "--require-mention",
      "false",
      "--no-restart",
    ], harness.deps),
  ).resolves.toBe(0);

  expect(harness.getConfig().channel.type).toBe("weixin");
  expect(harness.getConfig().channels[1]).toEqual({
    id: "feishu",
    type: "feishu",
    enabled: true,
    options: {
      appId: "cli_xxx",
      appSecret: "secret_xxx",
      domain: "lark",
      requireMention: false,
      textMessageFormat: "text",
      dedupTtlMs: 43200000,
      dedupMaxEntries: 5000,
    },
  });
  expect(harness.lines.join("\n")).not.toContain("secret_xxx");
});

test("channel add feishu prompts for missing required fields in interactive mode", async () => {
  const harness = createHarness(baseConfig({ channels: [] }));
  const deps = {
    ...harness.deps,
    isInteractive: () => true,
    promptText: async (message: string) => {
      expect(message).toBe("Feishu appId: ");
      return "cli_prompt";
    },
    promptSecret: async (message: string) => {
      expect(message).toBe("Feishu appSecret: ");
      return "secret_prompt";
    },
  };

  await expect(handleChannelCli(["add", "feishu", "--no-restart"], deps)).resolves.toBe(0);

  expect(harness.getConfig().channels[0].options?.appId).toBe("cli_prompt");
  expect(harness.getConfig().channels[0].options?.appSecret).toBe("secret_prompt");
  expect(harness.lines.join("\n")).not.toContain("secret_prompt");
});

test("channel add feishu rejects empty interactive prompt", async () => {
  const harness = createHarness(baseConfig({ channels: [] }));
  const deps = {
    ...harness.deps,
    isInteractive: () => true,
    promptText: async () => "",
    promptSecret: async () => "",
  };

  await expect(handleChannelCli(["add", "feishu", "--no-restart"], deps)).resolves.toBe(1);

  expect(harness.getConfig().channels).toEqual([]);
  expect(harness.lines.join("\n")).toContain("--app-id");
});

test("channel add feishu fails non-interactive when required flags are missing", async () => {
  const harness = createHarness(baseConfig({ channels: [] }));

  await expect(handleChannelCli(["add", "feishu"], harness.deps)).resolves.toBe(1);

  expect(harness.lines).toEqual([t().channelCli.missingRequiredFlags("--app-id, --app-secret")]);
  expect(harness.getConfig().channels).toEqual([]);
});

test("channel add returns 0 when equivalent channel already exists", async () => {
  const existing = {
    id: "feishu" as const,
    type: "feishu" as const,
    enabled: true,
    options: {
      appId: "cli_xxx",
      appSecret: "secret_xxx",
      domain: "feishu",
      requireMention: true,
      textMessageFormat: "text" as const,
      dedupTtlMs: 43200000,
      dedupMaxEntries: 5000,
    },
  };
  const harness = createHarness(baseConfig({ channels: [existing] }));

  await expect(handleChannelCli(["add", "feishu", "--app-id", "cli_xxx", "--app-secret", "secret_xxx"], harness.deps)).resolves.toBe(0);

  expect(harness.lines).toEqual([t().channelCli.channelAlreadyExistsSame("feishu")]);
});

test("channel add returns 1 when existing channel differs", async () => {
  const existing = {
    id: "feishu" as const,
    type: "feishu" as const,
    enabled: true,
    options: {
      appId: "cli_old",
      appSecret: "secret_old",
      domain: "feishu",
      requireMention: true,
      textMessageFormat: "text" as const,
      dedupTtlMs: 43200000,
      dedupMaxEntries: 5000,
    },
  };
  const harness = createHarness(baseConfig({ channels: [existing] }));

  await expect(handleChannelCli(["add", "feishu", "--app-id", "cli_new", "--app-secret", "secret_new"], harness.deps)).resolves.toBe(1);

  expect(harness.lines).toEqual([t().channelCli.channelAlreadyExistsDifferent("feishu")]);
});

test("channel disable rejects disabling the last enabled channel", async () => {
  const harness = createHarness(baseConfig({ channels: [{ id: "weixin", type: "weixin", enabled: true }] }));

  await expect(handleChannelCli(["disable", "weixin", "--no-restart"], harness.deps)).resolves.toBe(1);

  expect(harness.lines).toEqual([t().channelCli.cannotDisableLastEnabled]);
  expect(harness.getConfig().channels[0].enabled).toBe(true);
});

test("channel rm rejects removing the last enabled channel", async () => {
  const harness = createHarness(baseConfig({ channels: [{ id: "weixin", type: "weixin", enabled: true }] }));

  await expect(handleChannelCli(["rm", "weixin", "--no-restart"], harness.deps)).resolves.toBe(1);

  expect(harness.lines).toEqual([t().channelCli.cannotRemoveLastEnabled]);
  expect(harness.getConfig().channels).toEqual([{ id: "weixin", type: "weixin", enabled: true }]);
});

test("channel disable and enable mutate existing channels", async () => {
  const harness = createHarness(baseConfig({
    channels: [
      { id: "weixin", type: "weixin", enabled: true },
      { id: "feishu", type: "feishu", enabled: true, feishu: {
        appId: "cli_xxx",
        appSecret: "secret_xxx",
        domain: "feishu",
        requireMention: true,
        textMessageFormat: "text",
        dedupTtlMs: 43200000,
        dedupMaxEntries: 5000,
      } },
    ],
  }));

  await expect(handleChannelCli(["disable", "feishu", "--no-restart"], harness.deps)).resolves.toBe(0);
  expect(harness.getConfig().channels.find((channel) => channel.id === "feishu")?.enabled).toBe(false);

  await expect(handleChannelCli(["enable", "feishu", "--no-restart"], harness.deps)).resolves.toBe(0);
  expect(harness.getConfig().channels.find((channel) => channel.id === "feishu")?.enabled).toBe(true);
});

test("channel rm removes a non-last enabled channel", async () => {
  const harness = createHarness(baseConfig({
    channels: [
      { id: "weixin", type: "weixin", enabled: true },
      { id: "feishu", type: "feishu", enabled: false, feishu: {
        appId: "cli_xxx",
        appSecret: "secret_xxx",
        domain: "feishu",
        requireMention: true,
        textMessageFormat: "text",
        dedupTtlMs: 43200000,
        dedupMaxEntries: 5000,
      } },
    ],
  }));

  await expect(handleChannelCli(["rm", "feishu", "--no-restart"], harness.deps)).resolves.toBe(0);

  expect(harness.getConfig().channels.map((channel) => channel.id)).toEqual(["weixin"]);
});

test("channel enable returns 1 for absent channel", async () => {
  const harness = createHarness(baseConfig());

  await expect(handleChannelCli(["enable", "feishu", "--no-restart"], harness.deps)).resolves.toBe(1);

  expect(harness.lines).toEqual([t().channelCli.channelNotFound("feishu")]);
});

test("channel mutation with --restart calls restart when daemon is running", async () => {
  const harness = createHarness(baseConfig({ channels: [] }));
  const events: string[] = [];
  const deps = {
    ...harness.deps,
    getDaemonStatus: async () => ({ state: "running" as const, pid: 123 }),
    restartDaemon: async () => {
      events.push("restart");
      return 0;
    },
  };

  await expect(handleChannelCli(["add", "weixin", "--restart"], deps)).resolves.toBe(0);

  expect(events).toEqual(["restart"]);
});

test("channel mutation with --restart starts daemon when daemon is stopped", async () => {
  const harness = createHarness(baseConfig({ channels: [] }));
  const events: string[] = [];
  const deps = {
    ...harness.deps,
    getDaemonStatus: async () => ({ state: "stopped" as const }),
    restartDaemon: async () => {
      events.push("restart");
      return 0;
    },
  };

  await expect(handleChannelCli(["add", "weixin", "--restart"], deps)).resolves.toBe(0);

  expect(events).toEqual(["restart"]);
});

test("channel mutation asks interactive restart prompt when daemon is running", async () => {
  const harness = createHarness(baseConfig({ channels: [] }));
  const events: string[] = [];
  const deps = {
    ...harness.deps,
    isInteractive: () => true,
    getDaemonStatus: async () => ({ state: "running" as const, pid: 123 }),
    promptText: async (message: string) => {
      expect(message).toBe(t().channelCli.restartPrompt);
      return "y";
    },
    restartDaemon: async () => {
      events.push("restart");
      return 0;
    },
  };

  await expect(handleChannelCli(["add", "weixin"], deps)).resolves.toBe(0);

  expect(events).toEqual(["restart"]);
});

test("channel mutation interactive restart prompt skips when user says no", async () => {
  const harness = createHarness(baseConfig({ channels: [] }));
  const events: string[] = [];
  const deps = {
    ...harness.deps,
    isInteractive: () => true,
    getDaemonStatus: async () => ({ state: "running" as const, pid: 123 }),
    promptText: async (message: string) => {
      expect(message).toBe(t().channelCli.restartPrompt);
      return "n";
    },
    restartDaemon: async () => {
      events.push("restart");
      return 0;
    },
  };

  await expect(handleChannelCli(["add", "weixin"], deps)).resolves.toBe(0);

  expect(events).toEqual([]);
  expect(harness.lines).toContain(t().channelCli.savedRestartPending);
});

test("channel mutation skips automatic restart for indeterminate daemon", async () => {
  const harness = createHarness(baseConfig({ channels: [] }));
  const events: string[] = [];
  const deps = {
    ...harness.deps,
    getDaemonStatus: async () => ({ state: "indeterminate" as const, pid: 123, reason: "missing-status" as const }),
    restartDaemon: async () => {
      events.push("restart");
      return 0;
    },
  };

  await expect(handleChannelCli(["add", "weixin", "--restart"], deps)).resolves.toBe(0);

  expect(events).toEqual([]);
  expect(harness.lines).toContain(t().channelCli.savedDaemonIndeterminate);
});

test("channel mutation rejects conflicting restart flags", async () => {
  const harness = createHarness(baseConfig({ channels: [] }));

  await expect(handleChannelCli(["add", "weixin", "--restart", "--no-restart"], harness.deps)).resolves.toBe(1);

  expect(harness.lines).toEqual(["--restart and --no-restart cannot be used together"]);
});

test("channel add normalizes legacy single-channel config", async () => {
  const legacy = baseConfig();
  delete (legacy as Record<string, unknown>).channels;
  // Simulate legacy config: no explicit channels[].
  const harness = createHarness(legacy);
  // The harness loads config via loadConfig which returns our object.
  // We need the initial load to NOT have channels at all.
  let config = structuredClone(legacy) as AppConfig;
  (config as Record<string, unknown>).channels = undefined;
  const deps = {
    ...harness.deps,
    loadConfig: async () => config as AppConfig,
    saveChannels: async (next: ChannelRuntimeConfig[]) => {
      config = { ...config, channels: next };
    },
  };

  await expect(handleChannelCli(["add", "feishu", "--app-id", "cli_xxx", "--app-secret", "secret_xxx", "--no-restart"], deps)).resolves.toBe(0);

  // The new config should have channels[] with feishu added.
  expect(config.channels).toBeDefined();
  expect(config.channels.length).toBeGreaterThanOrEqual(1);
  expect(config.channels.find((c) => c.type === "feishu")).toBeDefined();
  // Legacy channel.type should not be modified.
  expect(config.channel.type).toBe("weixin");
});

test("channel add rejects unknown channel type and lists supported types", async () => {
  const harness = createHarness(baseConfig({ channels: [] }));

  await expect(handleChannelCli(["add", "dingtalk", "--no-restart"], harness.deps)).resolves.toBe(1);

  expect(harness.lines).toContain(t().channelCli.unknownChannelType("dingtalk"));
  const supportedLine = harness.lines.find((line) => line.includes("weixin") && line.includes("feishu"));
  expect(supportedLine).toBeDefined();
  expect(supportedLine).toContain("weixin");
  expect(supportedLine).toContain("feishu");
});

test("channel rm returns 1 for absent channel", async () => {
  const harness = createHarness(baseConfig({
    channels: [{ id: "weixin", type: "weixin", enabled: true }],
  }));

  await expect(handleChannelCli(["rm", "feishu", "--no-restart"], harness.deps)).resolves.toBe(1);

  expect(harness.lines).toEqual([t().channelCli.channelNotFound("feishu")]);
});

test("channel add feishu rejects missing flag value", async () => {
  const harness = createHarness(baseConfig({ channels: [] }));

  await expect(handleChannelCli(["add", "feishu", "--app-id", "--no-restart"], harness.deps)).resolves.toBe(1);

  expect(harness.lines).toEqual(["--app-id requires a value"]);
});

test("channel add feishu rejects unknown flag", async () => {
  const harness = createHarness(baseConfig({ channels: [] }));

  await expect(handleChannelCli(["add", "feishu", "--invalid-flag", "--no-restart"], harness.deps)).resolves.toBe(1);

  expect(harness.lines).toEqual(["unknown feishu option: --invalid-flag"]);
});

test("channel list shows empty message when no channels", async () => {
  const harness = createHarness(baseConfig({ channels: [] as unknown as AppConfig["channels"] }));

  await expect(handleChannelCli(["list"], harness.deps)).resolves.toBe(0);

  expect(harness.lines).toEqual([t().channelCli.noChannels]);
});

import { registerChannelPlugin, unregisterChannelPlugin } from "../../../src/channels/plugin";
import { hasChannelFactory } from "../../../src/channels/create-channel";
import { hasChannelCliProvider } from "../../../src/channels/cli/registry";
import yuanbaoPlugin from "../../../packages/channel-yuanbao/src/index";

function registerYuanbaoPluginForTest(): void {
  const factoryRegistered = hasChannelFactory("yuanbao");
  const cliProviderRegistered = hasChannelCliProvider("yuanbao");
  if (factoryRegistered !== cliProviderRegistered) {
    throw new Error("inconsistent yuanbao test registration state");
  }
  if (!factoryRegistered) {
    registerChannelPlugin(yuanbaoPlugin.channels![0]!);
    registeredHere.push("yuanbao");
  }
}

test("channel add yuanbao works after the yuanbao plugin is registered", async () => {
  registerYuanbaoPluginForTest();
  const harness = createHarness(baseConfig());

  const code = await handleChannelCli([
    "add",
    "yuanbao",
    "--app-key",
    "yb_key",
    "--app-secret",
    "yb_secret",
    "--no-restart",
  ], harness.deps);

  expect(code).toBe(0);
  expect(harness.getConfig().channels).toContainEqual(expect.objectContaining({ id: "yuanbao", type: "yuanbao", enabled: true }));
});

test("channel add yuanbao --account creates a fresh multi-bot channel", async () => {
  registerYuanbaoPluginForTest();
  const harness = createHarness(baseConfig({ channels: [{ id: "weixin", type: "weixin", enabled: true }] }));

  const code = await handleChannelCli([
    "add", "yuanbao",
    "--account", "main",
    "--app-key", "yb_main",
    "--app-secret", "secret_main",
    "--no-restart",
  ], harness.deps);

  expect(code).toBe(0);
  const yb = harness.getConfig().channels!.find((c) => c.id === "yuanbao");
  expect(yb).toBeDefined();
  const options = yb!.options as Record<string, any>;
  expect(options.defaultAccount).toBe("main");
  expect(options.accounts).toEqual({ main: { appKey: "yb_main", appSecret: "secret_main" } });
});

test("channel add yuanbao --account migrates legacy flat config to accounts shape", async () => {
  registerYuanbaoPluginForTest();
  const harness = createHarness(baseConfig({
    channels: [
      { id: "weixin", type: "weixin", enabled: true },
      {
        id: "yuanbao", type: "yuanbao", enabled: true,
        options: {
          appKey: "yb_legacy", appSecret: "secret_legacy",
          botId: "bot_legacy", apiDomain: "bot.yuanbao.tencent.com",
          requireMention: true, replyToMode: "first",
          gatewayModule: "@ganglion/yuanbao-gateway-custom",
        },
      },
    ],
  }));

  const code = await handleChannelCli([
    "add", "yuanbao",
    "--account", "review",
    "--app-key", "yb_review",
    "--app-secret", "secret_review",
    "--require-mention", "false",
    "--no-restart",
  ], harness.deps);

  expect(code).toBe(0);
  const yb = harness.getConfig().channels!.find((c) => c.id === "yuanbao");
  const options = yb!.options as Record<string, any>;
  expect(options.defaultAccount).toBe("default");
  expect(options.gatewayModule).toBe("@ganglion/yuanbao-gateway-custom");
  expect(options.appKey).toBeUndefined();
  expect(options.appSecret).toBeUndefined();
  expect(options.accounts.default).toEqual({
    appKey: "yb_legacy", appSecret: "secret_legacy",
    botId: "bot_legacy", apiDomain: "bot.yuanbao.tencent.com",
    requireMention: true, replyToMode: "first",
  });
  expect(options.accounts.review).toEqual({
    appKey: "yb_review", appSecret: "secret_review",
    requireMention: false,
  });
});

test("channel rm yuanbao --account drops a single account and reassigns defaultAccount when removing default", async () => {
  registerYuanbaoPluginForTest();
  const harness = createHarness(baseConfig({
    channels: [
      { id: "weixin", type: "weixin", enabled: true },
      {
        id: "yuanbao", type: "yuanbao", enabled: true,
        options: {
          defaultAccount: "main",
          accounts: {
            main: { appKey: "yb_main", appSecret: "secret_main" },
            ops: { appKey: "yb_ops", appSecret: "secret_ops" },
          },
        },
      },
    ],
  }));

  const code = await handleChannelCli(["rm", "yuanbao", "--account", "main", "--no-restart"], harness.deps);

  expect(code).toBe(0);
  const yb = harness.getConfig().channels!.find((c) => c.id === "yuanbao");
  const options = yb!.options as Record<string, any>;
  expect(Object.keys(options.accounts)).toEqual(["ops"]);
  expect(options.defaultAccount).toBe("ops");
});

test("channel disable yuanbao --account toggles a single account", async () => {
  registerYuanbaoPluginForTest();
  const harness = createHarness(baseConfig({
    channels: [
      { id: "weixin", type: "weixin", enabled: true },
      {
        id: "yuanbao", type: "yuanbao", enabled: true,
        options: {
          defaultAccount: "main",
          accounts: {
            main: { appKey: "yb_main", appSecret: "secret_main" },
            ops: { appKey: "yb_ops", appSecret: "secret_ops" },
          },
        },
      },
    ],
  }));

  expect(await handleChannelCli(["disable", "yuanbao", "--account", "ops", "--no-restart"], harness.deps)).toBe(0);
  const options = harness.getConfig().channels!.find((c) => c.id === "yuanbao")!.options as Record<string, any>;
  expect(options.accounts.ops.enabled).toBe(false);
  expect(options.accounts.main.enabled).toBeUndefined();
});

test("channel show yuanbao --account prints just one account's resolved summary", async () => {
  registerYuanbaoPluginForTest();
  const harness = createHarness(baseConfig({
    channels: [
      { id: "weixin", type: "weixin", enabled: true },
      {
        id: "yuanbao", type: "yuanbao", enabled: true,
        options: {
          defaultAccount: "main",
          accounts: {
            main: { appKey: "yb_main", appSecret: "secret_main", botId: "bot_main" },
            ops: { appKey: "yb_ops", appSecret: "secret_ops" },
          },
        },
      },
    ],
  }));

  const code = await handleChannelCli(["show", "yuanbao", "--account", "main"], harness.deps);
  expect(code).toBe(0);
  const out = harness.lines.join("\n");
  expect(harness.lines).toContain(t().channelCli.channelAccountHeader("yuanbao", "main"));
  expect(out).toContain("appKey: yb_main");
  expect(out).toContain("appSecret: ***");
  expect(out).toContain("botId: bot_main");
  expect(out).not.toContain("yb_ops");
});

test("channel add feishu --account creates a fresh multi-bot channel", async () => {
  ensureFeishuPluginRegisteredForTest();
  const harness = createHarness(baseConfig({ channels: [{ id: "weixin", type: "weixin", enabled: true }] }));

  const code = await handleChannelCli([
    "add", "feishu",
    "--account", "main",
    "--app-id", "cli_main",
    "--app-secret", "secret_main",
  ], harness.deps);

  expect(code).toBe(0);
  const feishu = harness.getConfig().channels!.find((c) => c.id === "feishu");
  expect(feishu).toBeDefined();
  expect(feishu!.options).toEqual({
    defaultAccount: "main",
    accounts: {
      main: { appId: "cli_main", appSecret: "secret_main" },
    },
  });
  expect(harness.lines).toContain(t().channelCli.channelAccountAdded("feishu", "main"));
});

test("channel add feishu --account migrates legacy flat config to accounts shape", async () => {
  ensureFeishuPluginRegisteredForTest();
  const harness = createHarness(baseConfig({
    channels: [
      { id: "weixin", type: "weixin", enabled: true },
      {
        id: "feishu", type: "feishu", enabled: true,
        options: {
          appId: "cli_legacy", appSecret: "secret_legacy",
          domain: "feishu", requireMention: true,
          textMessageFormat: "text", dedupTtlMs: 43_200_000, dedupMaxEntries: 5000,
        },
      },
    ],
  }));

  const code = await handleChannelCli([
    "add", "feishu",
    "--account", "ops",
    "--app-id", "cli_ops",
    "--app-secret", "secret_ops",
    "--require-mention", "false",
  ], harness.deps);

  expect(code).toBe(0);
  const feishu = harness.getConfig().channels!.find((c) => c.id === "feishu");
  const options = feishu!.options as Record<string, any>;
  // top-level channel-level fields preserved
  expect(options.textMessageFormat).toBe("text");
  expect(options.dedupTtlMs).toBe(43_200_000);
  expect(options.dedupMaxEntries).toBe(5000);
  expect(options.defaultAccount).toBe("default");
  // legacy flat fields no longer at top level
  expect(options.appId).toBeUndefined();
  expect(options.appSecret).toBeUndefined();
  // accounts populated
  expect(options.accounts.default).toEqual({
    appId: "cli_legacy", appSecret: "secret_legacy",
    domain: "feishu", requireMention: true,
  });
  expect(options.accounts.ops).toEqual({
    appId: "cli_ops", appSecret: "secret_ops",
    requireMention: false,
  });
});

test("channel add feishu --account refuses duplicate account id", async () => {
  ensureFeishuPluginRegisteredForTest();
  const harness = createHarness(baseConfig({
    channels: [
      { id: "weixin", type: "weixin", enabled: true },
      {
        id: "feishu", type: "feishu", enabled: true,
        options: {
          defaultAccount: "main",
          accounts: { main: { appId: "x", appSecret: "y" } },
        },
      },
    ],
  }));

  const code = await handleChannelCli([
    "add", "feishu",
    "--account", "main",
    "--app-id", "cli_dupe",
    "--app-secret", "secret_dupe",
  ], harness.deps);

  expect(code).toBe(1);
  expect(harness.lines.some((line) => line.includes("main") && line.includes("xacpx channel rm"))).toBe(true);
});

test("channel rm feishu --account drops a single account and keeps the channel", async () => {
  ensureFeishuPluginRegisteredForTest();
  const harness = createHarness(baseConfig({
    channels: [
      { id: "weixin", type: "weixin", enabled: true },
      {
        id: "feishu", type: "feishu", enabled: true,
        options: {
          defaultAccount: "main",
          accounts: {
            main: { appId: "x", appSecret: "y" },
            ops: { appId: "x2", appSecret: "y2" },
          },
        },
      },
    ],
  }));

  const code = await handleChannelCli(["rm", "feishu", "--account", "ops"], harness.deps);

  expect(code).toBe(0);
  const feishu = harness.getConfig().channels!.find((c) => c.id === "feishu");
  const options = feishu!.options as Record<string, any>;
  expect(Object.keys(options.accounts)).toEqual(["main"]);
  expect(options.defaultAccount).toBe("main");
});

test("channel rm feishu --account on the default account reassigns defaultAccount", async () => {
  ensureFeishuPluginRegisteredForTest();
  const harness = createHarness(baseConfig({
    channels: [
      { id: "weixin", type: "weixin", enabled: true },
      {
        id: "feishu", type: "feishu", enabled: true,
        options: {
          defaultAccount: "main",
          accounts: {
            main: { appId: "x", appSecret: "y" },
            ops: { appId: "x2", appSecret: "y2" },
          },
        },
      },
    ],
  }));

  const code = await handleChannelCli(["rm", "feishu", "--account", "main"], harness.deps);

  expect(code).toBe(0);
  const feishu = harness.getConfig().channels!.find((c) => c.id === "feishu");
  const options = feishu!.options as Record<string, any>;
  expect(options.defaultAccount).toBe("ops");
  expect(harness.lines.some((line) => line === t().channelCli.channelAccountDefaultSwitched("ops"))).toBe(true);
});

test("channel rm feishu --account refuses to leave channel empty when feishu is the only enabled channel", async () => {
  ensureFeishuPluginRegisteredForTest();
  const harness = createHarness(baseConfig({
    channels: [
      { id: "weixin", type: "weixin", enabled: false },
      {
        id: "feishu", type: "feishu", enabled: true,
        options: {
          defaultAccount: "main",
          accounts: { main: { appId: "x", appSecret: "y" } },
        },
      },
    ],
  }));

  const code = await handleChannelCli(["rm", "feishu", "--account", "main"], harness.deps);

  expect(code).toBe(1);
  expect(harness.lines.some((line) => line.includes("main") && line.includes("feishu") && line.includes("xacpx channel rm"))).toBe(true);
});

test("channel disable feishu --account toggles a single account", async () => {
  ensureFeishuPluginRegisteredForTest();
  const harness = createHarness(baseConfig({
    channels: [
      { id: "weixin", type: "weixin", enabled: true },
      {
        id: "feishu", type: "feishu", enabled: true,
        options: {
          defaultAccount: "main",
          accounts: {
            main: { appId: "x", appSecret: "y" },
            ops: { appId: "x2", appSecret: "y2" },
          },
        },
      },
    ],
  }));

  expect(await handleChannelCli(["disable", "feishu", "--account", "ops"], harness.deps)).toBe(0);
  const feishu = harness.getConfig().channels!.find((c) => c.id === "feishu");
  const options = feishu!.options as Record<string, any>;
  expect(options.accounts.ops.enabled).toBe(false);
  expect(options.accounts.main.enabled).toBeUndefined();

  expect(await handleChannelCli(["enable", "feishu", "--account", "ops"], harness.deps)).toBe(0);
  expect((harness.getConfig().channels!.find((c) => c.id === "feishu")!.options as any).accounts.ops.enabled).toBe(true);
});

test("channel disable feishu --account refuses to disable the last enabled account", async () => {
  ensureFeishuPluginRegisteredForTest();
  const harness = createHarness(baseConfig({
    channels: [
      { id: "weixin", type: "weixin", enabled: true },
      {
        id: "feishu", type: "feishu", enabled: true,
        options: {
          defaultAccount: "main",
          accounts: { main: { appId: "x", appSecret: "y" } },
        },
      },
    ],
  }));

  const code = await handleChannelCli(["disable", "feishu", "--account", "main"], harness.deps);
  expect(code).toBe(1);
  expect(harness.lines).toContain(t().channelCli.channelAccountCannotDisableLast("feishu"));
});

test("channel show feishu --account prints just one account's resolved summary", async () => {
  ensureFeishuPluginRegisteredForTest();
  const harness = createHarness(baseConfig({
    channels: [
      { id: "weixin", type: "weixin", enabled: true },
      {
        id: "feishu", type: "feishu", enabled: true,
        options: {
          defaultAccount: "main",
          accounts: {
            main: { appId: "cli_main", appSecret: "secret_main", name: "Main Bot" },
            ops: { appId: "cli_ops", appSecret: "secret_ops" },
          },
        },
      },
    ],
  }));

  const code = await handleChannelCli(["show", "feishu", "--account", "main"], harness.deps);
  expect(code).toBe(0);
  const out = harness.lines.join("\n");
  expect(harness.lines).toContain(t().channelCli.channelAccountHeader("feishu", "main"));
  expect(out).toContain("Main Bot");
  expect(out).toContain("appId: cli_main");
  expect(out).toContain("appSecret: ***");
  expect(out).not.toContain("cli_ops");
});

test("channel add feishu accepts --account=value single-token form", async () => {
  ensureFeishuPluginRegisteredForTest();
  const harness = createHarness(baseConfig({ channels: [{ id: "weixin", type: "weixin", enabled: true }] }));

  const code = await handleChannelCli([
    "add", "feishu",
    "--account=ops",
    "--app-id", "cli_ops",
    "--app-secret", "secret_ops",
  ], harness.deps);

  expect(code).toBe(0);
  const feishu = harness.getConfig().channels!.find((c) => c.id === "feishu");
  expect((feishu!.options as Record<string, any>).accounts).toEqual({
    ops: { appId: "cli_ops", appSecret: "secret_ops" },
  });
});

test("channel add feishu --account rejects empty value", async () => {
  ensureFeishuPluginRegisteredForTest();
  const harness = createHarness(baseConfig({ channels: [{ id: "weixin", type: "weixin", enabled: true }] }));

  const code = await handleChannelCli([
    "add", "feishu",
    "--account=",
    "--app-id", "x", "--app-secret", "y",
  ], harness.deps);

  expect(code).toBe(1);
  expect(harness.lines.some((line) => line.includes("--account") && line.includes("non-empty"))).toBe(true);
});

test("channel add feishu rejects --account specified twice", async () => {
  ensureFeishuPluginRegisteredForTest();
  const harness = createHarness(baseConfig({ channels: [{ id: "weixin", type: "weixin", enabled: true }] }));

  const code = await handleChannelCli([
    "add", "feishu",
    "--account", "main",
    "--account", "ops",
    "--app-id", "x", "--app-secret", "y",
  ], harness.deps);

  expect(code).toBe(1);
  expect(harness.lines.some((line) => line.includes("--account") && line.includes("more than once"))).toBe(true);
});

test("channel add feishu --account followed by another flag fails fast", async () => {
  ensureFeishuPluginRegisteredForTest();
  const harness = createHarness(baseConfig({ channels: [{ id: "weixin", type: "weixin", enabled: true }] }));

  const code = await handleChannelCli([
    "add", "feishu",
    "--account",
    "--app-id", "x", "--app-secret", "y",
  ], harness.deps);

  expect(code).toBe(1);
  expect(harness.lines.some((line) => line.includes("--account requires a value"))).toBe(true);
});

test("channel add feishu --account A then --account B accumulates accounts", async () => {
  ensureFeishuPluginRegisteredForTest();
  const harness = createHarness(baseConfig({ channels: [{ id: "weixin", type: "weixin", enabled: true }] }));

  await handleChannelCli([
    "add", "feishu",
    "--account", "main",
    "--app-id", "cli_main", "--app-secret", "secret_main",
  ], harness.deps);
  const code2 = await handleChannelCli([
    "add", "feishu",
    "--account", "ops",
    "--app-id", "cli_ops", "--app-secret", "secret_ops",
  ], harness.deps);

  expect(code2).toBe(0);
  const feishu = harness.getConfig().channels!.find((c) => c.id === "feishu");
  const options = feishu!.options as Record<string, any>;
  expect(Object.keys(options.accounts)).toEqual(["main", "ops"]);
  expect(options.defaultAccount).toBe("main");
});

test("channel add feishu --account auto-enables a previously disabled channel", async () => {
  ensureFeishuPluginRegisteredForTest();
  const harness = createHarness(baseConfig({
    channels: [
      { id: "weixin", type: "weixin", enabled: true },
      {
        id: "feishu", type: "feishu", enabled: false,
        options: {
          defaultAccount: "main",
          accounts: { main: { appId: "x", appSecret: "y" } },
        },
      },
    ],
  }));

  const code = await handleChannelCli([
    "add", "feishu",
    "--account", "ops",
    "--app-id", "cli_ops", "--app-secret", "secret_ops",
  ], harness.deps);

  expect(code).toBe(0);
  const feishu = harness.getConfig().channels!.find((c) => c.id === "feishu");
  expect(feishu!.enabled).toBe(true);
  expect(harness.lines.some((line) => line === t().channelCli.channelReEnabled("feishu"))).toBe(true);
});

test("channel add feishu --account fixes a stale defaultAccount referencing a non-existent account", async () => {
  ensureFeishuPluginRegisteredForTest();
  const harness = createHarness(baseConfig({
    channels: [
      { id: "weixin", type: "weixin", enabled: true },
      {
        id: "feishu", type: "feishu", enabled: true,
        options: {
          defaultAccount: "ghost",
          accounts: { main: { appId: "x", appSecret: "y" } },
        },
      },
    ],
  }));

  const code = await handleChannelCli([
    "add", "feishu",
    "--account", "ops",
    "--app-id", "cli_ops", "--app-secret", "secret_ops",
  ], harness.deps);

  expect(code).toBe(0);
  const options = harness.getConfig().channels!.find((c) => c.id === "feishu")!.options as Record<string, any>;
  expect(options.defaultAccount).toBe("ops");
});

test("channel rm feishu --account on the only remaining account deletes the whole channel when other channels are enabled", async () => {
  ensureFeishuPluginRegisteredForTest();
  const harness = createHarness(baseConfig({
    channels: [
      { id: "weixin", type: "weixin", enabled: true },
      {
        id: "feishu", type: "feishu", enabled: true,
        options: {
          defaultAccount: "main",
          accounts: { main: { appId: "x", appSecret: "y" } },
        },
      },
    ],
  }));

  const code = await handleChannelCli(["rm", "feishu", "--account", "main"], harness.deps);

  expect(code).toBe(0);
  expect(harness.getConfig().channels!.find((c) => c.id === "feishu")).toBeUndefined();
  expect(harness.lines.some((line) => line === t().channelCli.channelAccountRemovedWithChannel("feishu", "main"))).toBe(true);
});

test("channel rm feishu --account also fixes stale defaultAccount referencing another removed account", async () => {
  ensureFeishuPluginRegisteredForTest();
  const harness = createHarness(baseConfig({
    channels: [
      { id: "weixin", type: "weixin", enabled: true },
      {
        id: "feishu", type: "feishu", enabled: true,
        options: {
          defaultAccount: "ghost",
          accounts: {
            main: { appId: "x", appSecret: "y" },
            ops: { appId: "x2", appSecret: "y2" },
          },
        },
      },
    ],
  }));

  const code = await handleChannelCli(["rm", "feishu", "--account", "ops"], harness.deps);

  expect(code).toBe(0);
  const options = harness.getConfig().channels!.find((c) => c.id === "feishu")!.options as Record<string, any>;
  // defaultAccount was already stale; rm now points it at the remaining account
  expect(options.defaultAccount).toBe("main");
});

test("channel rm feishu --account refuses when remaining accounts are all disabled", async () => {
  ensureFeishuPluginRegisteredForTest();
  const harness = createHarness(baseConfig({
    channels: [
      { id: "weixin", type: "weixin", enabled: true },
      {
        id: "feishu", type: "feishu", enabled: true,
        options: {
          defaultAccount: "main",
          accounts: {
            main: { appId: "x", appSecret: "y" },
            ops: { appId: "x2", appSecret: "y2", enabled: false },
          },
        },
      },
    ],
  }));

  const code = await handleChannelCli(["rm", "feishu", "--account", "main"], harness.deps);

  expect(code).toBe(1);
  expect(harness.lines.some((line) => line.includes("ops") && line.includes("disabled"))).toBe(true);
  // 配置不变
  const feishu = harness.getConfig().channels!.find((c) => c.id === "feishu");
  const options = feishu!.options as Record<string, any>;
  expect(Object.keys(options.accounts).sort()).toEqual(["main", "ops"]);
});

test("channel rm feishu --account allows removing the only enabled account when channel itself is disabled", async () => {
  ensureFeishuPluginRegisteredForTest();
  const harness = createHarness(baseConfig({
    channels: [
      { id: "weixin", type: "weixin", enabled: true },
      {
        id: "feishu", type: "feishu", enabled: false,
        options: {
          defaultAccount: "main",
          accounts: {
            main: { appId: "x", appSecret: "y" },
            ops: { appId: "x2", appSecret: "y2", enabled: false },
          },
        },
      },
    ],
  }));

  const code = await handleChannelCli(["rm", "feishu", "--account", "main"], harness.deps);

  expect(code).toBe(0);
  const options = harness.getConfig().channels!.find((c) => c.id === "feishu")!.options as Record<string, any>;
  expect(Object.keys(options.accounts)).toEqual(["ops"]);
});

test("channel enable feishu --account refuses when target account lacks credentials", async () => {
  ensureFeishuPluginRegisteredForTest();
  const harness = createHarness(baseConfig({
    channels: [
      { id: "weixin", type: "weixin", enabled: true },
      {
        id: "feishu", type: "feishu", enabled: true,
        options: {
          defaultAccount: "main",
          accounts: {
            main: { appId: "x", appSecret: "y" },
            broken: { name: "Broken Bot", enabled: false },
          },
        },
      },
    ],
  }));

  const code = await handleChannelCli(["enable", "feishu", "--account", "broken"], harness.deps);

  expect(code).toBe(1);
  expect(harness.lines.some((line) => line.startsWith(t().channelCli.channelAccountIncomplete("broken", "")))).toBe(true);
  // 没改 enabled
  const options = harness.getConfig().channels!.find((c) => c.id === "feishu")!.options as Record<string, any>;
  expect(options.accounts.broken.enabled).toBe(false);
});

test("channel enable yuanbao --account refuses static-token account missing botId", async () => {
  registerYuanbaoPluginForTest();
  const harness = createHarness(baseConfig({
    channels: [
      { id: "weixin", type: "weixin", enabled: true },
      {
        id: "yuanbao", type: "yuanbao", enabled: true,
        options: {
          defaultAccount: "main",
          accounts: {
            main: { appKey: "yb_main", appSecret: "secret_main" },
            broken: { token: "static-token", enabled: false },
          },
        },
      },
    ],
  }));

  const code = await handleChannelCli(["enable", "yuanbao", "--account", "broken"], harness.deps);

  expect(code).toBe(1);
  expect(harness.lines.some((line) => /broken|botId/.test(line))).toBe(true);
});

test("channel add feishu --account rejects whitespace-only value", async () => {
  ensureFeishuPluginRegisteredForTest();
  const harness = createHarness(baseConfig({ channels: [{ id: "weixin", type: "weixin", enabled: true }] }));

  const code = await handleChannelCli([
    "add", "feishu",
    "--account", "   ",
    "--app-id", "x", "--app-secret", "y",
  ], harness.deps);

  expect(code).toBe(1);
  expect(harness.lines.some((line) => line.includes("--account") && line.includes("non-empty"))).toBe(true);
});

test("channel add weixin --account is rejected because weixin doesn't support multi-account", async () => {
  ensureFeishuPluginRegisteredForTest();
  const harness = createHarness(baseConfig());

  const code = await handleChannelCli(["add", "weixin", "--account", "main"], harness.deps);
  expect(code).toBe(1);
  expect(harness.lines).toContain(t().channelCli.channelNoMultiAccount("weixin"));
});

test("channel add can use plugin-provided CLI provider after plugin load", async () => {
  registerChannelPlugin({
    type: "demo-channel-cli",
    factory: () => ({ id: "demo-channel-cli", isLoggedIn: () => true, login: async () => "demo-channel-cli", logout: () => {}, start: async () => {}, notifyTaskCompletion: async () => {}, notifyTaskProgress: async () => {}, sendCoordinatorMessage: async () => {} }),
    cliProvider: {
      type: "demo-channel-cli",
      displayName: "Demo Channel CLI",
      supportsLogin: false,
      parseAddArgs: () => ({ ok: true, input: {} }),
      buildDefaultConfig: () => ({ id: "demo-channel-cli", type: "demo-channel-cli", enabled: true }),
      validateConfig: () => [],
      renderSummary: (config) => [`type: ${config.type}`, `enabled: ${config.enabled}`],
      promptForMissingFields: async (input) => input,
    },
  });

  const harness = createHarness(baseConfig());
  const code = await handleChannelCli(["add", "demo-channel-cli"], harness.deps);

  expect(code).toBe(0);
  expect(harness.getConfig().channels).toContainEqual({ id: "demo-channel-cli", type: "demo-channel-cli", enabled: true });
});
