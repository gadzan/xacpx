import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { expect, test } from "bun:test";

import type { AppConfig } from "../../../src/config/types";
import { inspectPlugins } from "../../../src/plugins/plugin-doctor";

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

async function createPluginHome(dependencies: Record<string, string> = {}) {
  const dir = await mkdtemp(join(tmpdir(), "weacpx-plugin-doctor-"));
  await writeFile(join(dir, "package.json"), JSON.stringify({ private: true, type: "module", dependencies }, null, 2));
  return dir;
}

test("doctor reports ok for valid configured plugin", async () => {
  const pluginHome = await createPluginHome({ "weacpx-channel-demo": "1.0.0" });
  try {
    const issues = await inspectPlugins({
      pluginHome,
      config: baseConfig({ plugins: [{ name: "weacpx-channel-demo", enabled: true }] }),
      importPlugin: async () => ({ default: { apiVersion: 1, name: "weacpx-channel-demo", channels: [{ type: "demo", factory: () => ({ id: "demo", start: async () => {}, stop: async () => {} }) }] } }),
    });

    expect(issues).toContainEqual({ level: "ok", plugin: "weacpx-channel-demo", message: "plugin is installed and valid; channels: demo" });
  } finally {
    await rm(pluginHome, { recursive: true, force: true });
  }
});

test("doctor reports missing dependency error", async () => {
  const pluginHome = await createPluginHome();
  try {
    const issues = await inspectPlugins({
      pluginHome,
      config: baseConfig({ plugins: [{ name: "weacpx-channel-demo", enabled: true }] }),
      importPlugin: async () => ({ default: { apiVersion: 1, name: "weacpx-channel-demo", channels: [] } }),
    });

    expect(issues).toContainEqual({ level: "error", plugin: "weacpx-channel-demo", message: "package not installed in plugin home; run xacpx plugin add weacpx-channel-demo", suggestion: "xacpx plugin add weacpx-channel-demo && xacpx restart" });
  } finally {
    await rm(pluginHome, { recursive: true, force: true });
  }
});

test("doctor reports import and validation failures", async () => {
  const pluginHome = await createPluginHome({ "weacpx-channel-demo": "1.0.0" });
  try {
    const importIssues = await inspectPlugins({
      pluginHome,
      config: baseConfig({ plugins: [{ name: "weacpx-channel-demo", enabled: true }] }),
      importPlugin: async () => { throw new Error("module not found"); },
    });
    expect(importIssues).toContainEqual({ level: "error", plugin: "weacpx-channel-demo", message: "failed to import plugin: module not found", suggestion: "xacpx plugin add weacpx-channel-demo && xacpx restart" });

    const validationIssues = await inspectPlugins({
      pluginHome,
      config: baseConfig({ plugins: [{ name: "weacpx-channel-demo", enabled: true }] }),
      importPlugin: async () => ({ default: { apiVersion: 2, name: "weacpx-channel-demo", channels: [] } }),
    });
    expect(validationIssues.some((issue) => issue.level === "error" && issue.message.includes("apiVersion"))).toBe(true);
  } finally {
    await rm(pluginHome, { recursive: true, force: true });
  }
});

test("doctor reports duplicate channel type across configured plugins", async () => {
  const pluginHome = await createPluginHome({ "plugin-a": "1.0.0", "plugin-b": "1.0.0" });
  try {
    const issues = await inspectPlugins({
      pluginHome,
      config: baseConfig({ plugins: [{ name: "plugin-a", enabled: true }, { name: "plugin-b", enabled: true }] }),
      importPlugin: async (name) => ({ default: { apiVersion: 1, name, channels: [{ type: "demo", factory: () => ({ id: "demo", start: async () => {}, stop: async () => {} }) }] } }),
    });

    expect(issues).toContainEqual({ level: "error", plugin: "plugin-b", message: "channel type demo is already provided by plugin-a" });
  } finally {
    await rm(pluginHome, { recursive: true, force: true });
  }
});

test("doctor reports error when configured channel has no provider plugin", async () => {
  const pluginHome = await createPluginHome();
  try {
    const issues = await inspectPlugins({
      pluginHome,
      config: baseConfig({
        plugins: [],
        channels: [
          { id: "weixin", type: "weixin", enabled: true },
          { id: "yuanbao", type: "yuanbao", enabled: true },
        ],
      }),
      importPlugin: async () => ({ default: { apiVersion: 1, channels: [] } }),
    });

    expect(issues).toContainEqual({ level: "error", message: "channel yuanbao is configured but no enabled plugin provides it; run xacpx plugin add @ganglion/xacpx-channel-yuanbao or another plugin that provides type \"yuanbao\"", suggestion: "xacpx plugin add @ganglion/xacpx-channel-yuanbao" });
  } finally {
    await rm(pluginHome, { recursive: true, force: true });
  }
});

test("doctor with name filter still detects cross-plugin channel type conflicts", async () => {
  const pluginHome = await createPluginHome({ "plugin-a": "1.0.0", "plugin-b": "1.0.0" });
  try {
    const issues = await inspectPlugins({
      pluginHome,
      pluginName: "plugin-b",
      config: baseConfig({ plugins: [{ name: "plugin-a", enabled: true }, { name: "plugin-b", enabled: true }] }),
      importPlugin: async (name) => ({ default: { apiVersion: 1, name, channels: [{ type: "demo", factory: () => ({ id: "demo", start: async () => {}, stop: async () => {} }) }] } }),
    });

    expect(issues).toContainEqual({ level: "error", plugin: "plugin-b", message: "channel type demo is already provided by plugin-a" });
  } finally {
    await rm(pluginHome, { recursive: true, force: true });
  }
});

test("doctor reports plugin requiring newer weacpx core", async () => {
  const pluginHome = await createPluginHome({ "weacpx-channel-demo": "1.0.0" });
  try {
    const issues = await inspectPlugins({
      pluginHome,
      currentXacpxVersion: "0.3.3",
      config: baseConfig({ plugins: [{ name: "weacpx-channel-demo", enabled: true }] }),
      importPlugin: async () => ({
        default: {
          apiVersion: 1,
          name: "weacpx-channel-demo",
          minWeacpxVersion: "0.4.0",
          channels: [{ type: "demo", factory: () => ({ id: "demo", start: async () => {}, stop: async () => {} }) }],
        },
      }),
    });

    expect(issues.some((issue) =>
      issue.level === "error" &&
      issue.plugin === "weacpx-channel-demo" &&
      /requires xacpx >=?0\.4\.0/.test(issue.message) &&
      /upgrade xacpx/i.test(issue.message),
    )).toBe(true);
  } finally {
    await rm(pluginHome, { recursive: true, force: true });
  }
});

test("doctor reports plugin built for unsupported apiVersion", async () => {
  const pluginHome = await createPluginHome({ "weacpx-channel-demo": "1.0.0" });
  try {
    const issues = await inspectPlugins({
      pluginHome,
      currentXacpxVersion: "0.3.3",
      config: baseConfig({ plugins: [{ name: "weacpx-channel-demo", enabled: true }] }),
      importPlugin: async () => ({
        default: {
          apiVersion: 2,
          name: "weacpx-channel-demo",
          channels: [],
        },
      }),
    });

    expect(issues.some((issue) =>
      issue.level === "error" &&
      issue.plugin === "weacpx-channel-demo" &&
      /apiVersion 2/.test(issue.message) &&
      /supported: 1/.test(issue.message),
    )).toBe(true);
  } finally {
    await rm(pluginHome, { recursive: true, force: true });
  }
});

test("doctor errors when configured channel provider plugin is disabled", async () => {
  const pluginHome = await createPluginHome({ "weacpx-channel-demo": "1.0.0" });
  try {
    const issues = await inspectPlugins({
      pluginHome,
      config: baseConfig({
        plugins: [{ name: "weacpx-channel-demo", enabled: false }],
        channels: [
          { id: "weixin", type: "weixin", enabled: true },
          { id: "demo", type: "demo", enabled: true },
        ],
      }),
      importPlugin: async () => ({ default: { apiVersion: 1, name: "weacpx-channel-demo", channels: [{ type: "demo", factory: () => ({ id: "demo", start: async () => {}, stop: async () => {} }) }] } }),
    });

    expect(issues).toContainEqual({ level: "error", plugin: "weacpx-channel-demo", message: "channel demo is configured but provider plugin is disabled; run xacpx plugin enable weacpx-channel-demo", suggestion: "xacpx plugin enable weacpx-channel-demo" });
  } finally {
    await rm(pluginHome, { recursive: true, force: true });
  }
});

test("doctor with legacy pluginName filter finds the configured plugin (Bug B)", async () => {
  const pluginHome = await createPluginHome({ "@ganglion/xacpx-channel-feishu": "1.0.0" });
  try {
    const issues = await inspectPlugins({
      pluginHome,
      // config stores the normalized name
      config: baseConfig({ plugins: [{ name: "@ganglion/xacpx-channel-feishu", enabled: true }] }),
      // user passes the legacy name as filter
      pluginName: "@ganglion/weacpx-channel-feishu",
      importPlugin: async () => ({ default: { apiVersion: 1, name: "@ganglion/xacpx-channel-feishu", channels: [] } }),
    });

    // Should NOT return "plugin is not configured" error
    expect(issues.some((issue) => issue.message.includes("plugin is not configured"))).toBe(false);
    // Should find the plugin and report it as valid
    expect(issues.some((issue) => issue.level === "ok")).toBe(true);
  } finally {
    await rm(pluginHome, { recursive: true, force: true });
  }
});

test("doctor does not flag a disabled channel as orphan (Bug C)", async () => {
  const pluginHome = await createPluginHome();
  try {
    const issues = await inspectPlugins({
      pluginHome,
      config: baseConfig({
        plugins: [],
        channels: [
          { id: "weixin", type: "weixin", enabled: true },
          // feishu channel intentionally disabled — no plugin needed
          { id: "feishu", type: "feishu", enabled: false },
        ],
      }),
      importPlugin: async () => ({ default: { apiVersion: 1, channels: [] } }),
    });

    // disabled channel must NOT produce an orphan error
    expect(issues.some((issue) => issue.message.includes("channel feishu is configured"))).toBe(false);
  } finally {
    await rm(pluginHome, { recursive: true, force: true });
  }
});

test("doctor still flags an enabled channel with no provider as error (Bug C regression)", async () => {
  const pluginHome = await createPluginHome();
  try {
    const issues = await inspectPlugins({
      pluginHome,
      config: baseConfig({
        plugins: [],
        channels: [
          { id: "weixin", type: "weixin", enabled: true },
          { id: "feishu", type: "feishu", enabled: true },
        ],
      }),
      importPlugin: async () => ({ default: { apiVersion: 1, channels: [] } }),
    });

    expect(issues).toContainEqual(expect.objectContaining({
      level: "error",
      message: expect.stringContaining("channel feishu is configured but no enabled plugin provides it"),
    }));
  } finally {
    await rm(pluginHome, { recursive: true, force: true });
  }
});

test("doctor surfaces optional channel diagnose findings without core RMUX knowledge", async () => {
  const pluginHome = await createPluginHome({ "demo-relay": "1.0.0" });
  try {
    const issues = await inspectPlugins({
      pluginHome,
      currentXacpxVersion: "0.17.0",
      config: baseConfig({
        plugins: [{ name: "demo-relay", enabled: true }],
        channels: [
          { id: "weixin", type: "weixin", enabled: true },
          {
            id: "relay",
            type: "relay",
            enabled: true,
            options: { url: "ws://h:1", pairingToken: "t", terminal: { enabled: true } },
          },
        ],
      }),
      importPlugin: async () => ({
        default: {
          apiVersion: 1,
          minXacpxVersion: "0.17.0",
          channels: [
            {
              type: "relay",
              factory: () => ({}),
              cliProvider: {
                type: "relay",
                displayName: "Relay",
                supportsLogin: false,
                parseAddArgs: () => ({ ok: true, input: {} }),
                buildDefaultConfig: () => ({ id: "relay", type: "relay", enabled: true }),
                validateConfig: () => [],
                renderSummary: () => [],
                promptForMissingFields: async (input: unknown) => input,
                diagnose: async () => [
                  {
                    level: "warn" as const,
                    code: "terminal-cleanup-pending",
                    message: "1 terminal resource(s) are in durable reaping",
                    suggestion: "leave registry/owner identity intact",
                  },
                ],
              },
            },
          ],
        },
      }),
    });

    expect(issues).toContainEqual(
      expect.objectContaining({
        level: "warn",
        plugin: "demo-relay",
        message: expect.stringContaining("terminal-cleanup-pending"),
        suggestion: "leave registry/owner identity intact",
      }),
    );
    expect(JSON.stringify(issues)).not.toContain("pairingToken");
  } finally {
    await rm(pluginHome, { recursive: true, force: true });
  }
});
