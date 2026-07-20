import { expect, test } from "bun:test";
import { join } from "node:path";

import { resolveClaudeSpawnEnvironment } from "../../../src/adapters/claude-settings-policy";

test("provider-only imports provider env and writes only model settings", () => {
  let snapshotPath = "";
  let snapshotContent = "";
  const env = resolveClaudeSpawnEnvironment(
    { driver: "claude" },
    {
      baseEnv: { KEEP: "yes", ANTHROPIC_MODEL: "daemon-model" },
      homeDir: "C:\\Users\\test",
      snapshotRoot: "C:\\temp\\snapshots",
      readTextFile: () => JSON.stringify({
        model: "sonnet",
        modelOverrides: { sonnet: "provider-sonnet" },
        availableModels: ["sonnet", "opus"],
        env: {
          ANTHROPIC_BASE_URL: "https://provider.example",
          ANTHROPIC_AUTH_TOKEN: "secret-token",
          ANTHROPIC_MODEL: "settings-model",
          PATH: "must-not-import",
        },
        hooks: { SessionStart: [{ hooks: [] }] },
        enabledPlugins: { unsafe: true },
        permissions: { allow: ["Bash(*)"] },
      }),
      writeSnapshot: (path, content) => {
        snapshotPath = path;
        snapshotContent = content;
      },
    },
  );

  expect(env).toBeDefined();
  expect(env?.KEEP).toBe("yes");
  expect(env?.ANTHROPIC_BASE_URL).toBe("https://provider.example");
  expect(env?.ANTHROPIC_AUTH_TOKEN).toBe("secret-token");
  expect(env?.ANTHROPIC_MODEL).toBe("daemon-model");
  expect(env?.PATH).toBeUndefined();
  expect(env?.ACPX_CLAUDE_INCLUDE_USER_SETTINGS).toBe("1");
  expect(env?.CLAUDE_CONFIG_DIR).toBe(join(snapshotPath, ".."));
  expect(JSON.parse(snapshotContent)).toEqual({
    model: "sonnet",
    modelOverrides: { sonnet: "provider-sonnet" },
    availableModels: ["sonnet", "opus"],
  });
  expect(snapshotContent).not.toContain("secret-token");
  expect(snapshotContent).not.toContain("hooks");
  expect(snapshotContent).not.toContain("plugins");
  expect(snapshotContent).not.toContain("permissions");
});

test("default provider-only stays inert for normal first-party Claude settings", () => {
  let wrote = false;
  const env = resolveClaudeSpawnEnvironment(
    { driver: "claude" },
    {
      baseEnv: { ANTHROPIC_API_KEY: "first-party-key" },
      readTextFile: () => JSON.stringify({ model: "sonnet", hooks: { Stop: [] } }),
      writeSnapshot: () => { wrote = true; },
    },
  );

  expect(env).toBeUndefined();
  expect(wrote).toBe(false);
});

test("isolated hides user settings even when include-user was inherited", () => {
  let snapshotContent = "";
  const env = resolveClaudeSpawnEnvironment(
    { driver: "claude", settingsPolicy: "isolated" },
    {
      baseEnv: { ACPX_CLAUDE_INCLUDE_USER_SETTINGS: "1", KEEP: "yes" },
      snapshotRoot: "C:\\temp\\snapshots",
      readTextFile: () => JSON.stringify({ env: { ANTHROPIC_AUTH_TOKEN: "secret" }, model: "sonnet" }),
      writeSnapshot: (_path, content) => { snapshotContent = content; },
    },
  );

  expect(env?.ACPX_CLAUDE_INCLUDE_USER_SETTINGS).toBeUndefined();
  expect(env?.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
  expect(env?.KEEP).toBe("yes");
  expect(JSON.parse(snapshotContent)).toEqual({});
});

test("full-user explicitly opts acpx into the original Claude config", () => {
  const env = resolveClaudeSpawnEnvironment(
    { driver: "claude", settingsPolicy: "full-user" },
    { baseEnv: { CLAUDE_CONFIG_DIR: "D:\\claude-profile" } },
  );

  expect(env).toEqual({
    CLAUDE_CONFIG_DIR: "D:\\claude-profile",
    ACPX_CLAUDE_INCLUDE_USER_SETTINGS: "1",
  });
});

test("non-Claude agents do not receive a copied process environment", () => {
  expect(resolveClaudeSpawnEnvironment(
    { driver: "codex", settingsPolicy: "full-user" },
    { baseEnv: { SECRET: "value" } },
  )).toBeUndefined();
});
