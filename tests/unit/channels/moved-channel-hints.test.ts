import { expect, test, beforeEach, afterAll } from "bun:test";

import { createMessageChannel, createMessageChannelFromRuntimeConfig } from "../../../src/channels/create-channel";
import { handleChannelCli } from "../../../src/channels/cli/channel-cli";
import type { AppConfig } from "../../../src/config/types";
import { setLocale } from "../../../src/i18n";

beforeEach(() => { setLocale("zh"); });
afterAll(() => { setLocale("en"); });

function baseConfig(): AppConfig {
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
  };
}

test("core reports Yuanbao plugin install hint when Yuanbao runtime is missing", () => {
  expect(() => createMessageChannel("yuanbao")).toThrow("频道 yuanbao 需要安装插件：xacpx plugin add @ganglion/xacpx-channel-yuanbao");
  expect(() => createMessageChannelFromRuntimeConfig({ id: "yuanbao", type: "yuanbao", enabled: true })).toThrow("频道 yuanbao 需要安装插件：xacpx plugin add @ganglion/xacpx-channel-yuanbao");
});

test("channel add yuanbao reports the plugin install hint when the plugin is absent", async () => {
  const lines: string[] = [];
  const config = baseConfig();

  const code = await handleChannelCli(["add", "yuanbao"], {
    loadConfig: async () => structuredClone(config) as AppConfig,
    saveChannels: async () => {},
    print: (line) => lines.push(line),
    stderr: () => {},
    isInteractive: () => false,
    promptText: async () => "",
    promptSecret: async () => "",
    getDaemonStatus: async () => ({ state: "stopped" }),
    restartDaemon: async () => 0,
  });

  expect(code).toBe(1);
  expect(lines.join("\n")).toContain("频道 yuanbao 需要安装插件：xacpx plugin add @ganglion/xacpx-channel-yuanbao");
});

test("core reports Feishu plugin install hint when Feishu runtime is missing", () => {
  expect(() => createMessageChannel("feishu", { options: { appId: "cli_xxx", appSecret: "secret_xxx" } })).toThrow(
    "频道 feishu 需要安装插件：xacpx plugin add @ganglion/xacpx-channel-feishu",
  );
});

test("core reports Discord plugin install hint when Discord runtime is missing", () => {
  expect(() => createMessageChannel("discord")).toThrow(
    "频道 discord 需要安装插件：xacpx plugin add @ganglion/xacpx-channel-discord",
  );
});

test("channel add feishu reports the plugin install hint when the plugin is absent", async () => {
  const lines: string[] = [];
  const config = baseConfig();

  const code = await handleChannelCli(["add", "feishu"], {
    loadConfig: async () => structuredClone(config) as AppConfig,
    saveChannels: async () => {},
    print: (line) => lines.push(line),
    stderr: () => {},
    isInteractive: () => false,
    promptText: async () => "",
    promptSecret: async () => "",
    getDaemonStatus: async () => ({ state: "stopped" }),
    restartDaemon: async () => 0,
  });

  expect(code).toBe(1);
  expect(lines.join("\n")).toContain("频道 feishu 需要安装插件：xacpx plugin add @ganglion/xacpx-channel-feishu");
});
