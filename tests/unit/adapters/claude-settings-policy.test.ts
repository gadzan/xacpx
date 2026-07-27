import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

import { resolveClaudeSpawnEnvironment } from "../../../src/adapters/claude-settings-policy";

test("provider-only imports provider env and overlays settings without moving session state", () => {
  let profilePath = "";
  let profileContent = "";
  let linkedState: { source: string; profile: string } | undefined;
  const env = resolveClaudeSpawnEnvironment(
    { driver: "claude" },
    {
      baseEnv: {
        KEEP: "yes",
        ANTHROPIC_MODEL: "daemon-model",
        CLAUDE_CONFIG_DIR: "/profiles/claude",
      },
      homeDir: "C:\\Users\\test",
      profileRoot: "C:\\temp\\xacpx-claude-profiles",
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
      writeProfile: (path, content) => {
        profilePath = path;
        profileContent = content;
      },
      linkSessionState: (source, profile) => {
        linkedState = { source, profile };
      },
    },
  );

  expect(env).toBeDefined();
  expect(env?.KEEP).toBe("yes");
  expect(env?.ANTHROPIC_BASE_URL).toBe("https://provider.example");
  expect(env?.ANTHROPIC_AUTH_TOKEN).toBe("secret-token");
  expect(env?.ANTHROPIC_MODEL).toBe("daemon-model");
  expect(env?.PATH).toBeUndefined();
  expect(env?.ACPX_CLAUDE_INCLUDE_USER_SETTINGS).toBeUndefined();
  expect(env?.CLAUDE_CONFIG_DIR).toBe(dirname(profilePath));
  expect(linkedState).toEqual({
    source: resolve("/profiles/claude"),
    profile: dirname(profilePath),
  });
  expect(JSON.parse(profileContent)).toEqual({
    model: "sonnet",
    modelOverrides: { sonnet: "provider-sonnet" },
    availableModels: ["sonnet", "opus"],
  });
  expect(JSON.parse(env?.CLAUDE_MODEL_CONFIG ?? "null")).toEqual({
    modelOverrides: { sonnet: "provider-sonnet" },
    availableModels: ["sonnet", "opus"],
  });
  expect(env?.CLAUDE_MODEL_CONFIG).not.toContain("secret-token");
  expect(env?.CLAUDE_MODEL_CONFIG).not.toContain("hooks");
  expect(env?.CLAUDE_MODEL_CONFIG).not.toContain("plugins");
  expect(env?.CLAUDE_MODEL_CONFIG).not.toContain("permissions");
});

test("provider-only maps a user model setting to ANTHROPIC_MODEL", () => {
  const env = resolveClaudeSpawnEnvironment(
    { driver: "claude" },
    {
      baseEnv: {},
      writeProfile: () => {},
      linkSessionState: () => {},
      readTextFile: () => JSON.stringify({
        model: "provider-model",
        env: { ANTHROPIC_BASE_URL: "https://provider.example" },
      }),
    },
  );

  expect(env?.ANTHROPIC_MODEL).toBe("provider-model");
  expect(env?.CLAUDE_MODEL_CONFIG).toBeUndefined();
});

test("an explicit session model wins over the user settings model", () => {
  let profileContent = "";
  const env = resolveClaudeSpawnEnvironment(
    { driver: "claude", model: "web-model" },
    {
      baseEnv: { ANTHROPIC_MODEL: "daemon-default" },
      readTextFile: () => JSON.stringify({
        model: "user-default",
        env: { ANTHROPIC_BASE_URL: "https://provider.example" },
      }),
      writeProfile: (_path, content) => { profileContent = content; },
      linkSessionState: () => {},
    },
  );

  expect(env?.ANTHROPIC_MODEL).toBe("web-model");
  expect(JSON.parse(profileContent)).toEqual({});
});

test("different sanitized settings use immutable profile directories", () => {
  const profileDirs: string[] = [];
  const options = {
    baseEnv: {},
    profileRoot: "/profiles",
    readTextFile: () => JSON.stringify({
      model: "user-default",
      env: { ANTHROPIC_BASE_URL: "https://provider.example" },
    }),
    writeProfile: (path: string) => { profileDirs.push(dirname(path)); },
    linkSessionState: () => {},
  };

  resolveClaudeSpawnEnvironment({ driver: "claude" }, options);
  resolveClaudeSpawnEnvironment({ driver: "claude", model: "web-model" }, options);

  expect(profileDirs).toHaveLength(2);
  expect(profileDirs[0]).not.toBe(profileDirs[1]);
});

test("profile layout changes do not reuse incompatible legacy directories", () => {
  const root = mkdtempSync(join(tmpdir(), "xacpx-claude-profile-layout-"));
  const sourceConfigDir = join(root, "source");
  const profileRoot = join(root, "profiles");
  const serialized = "{}\n";
  const legacyDigest = createHash("sha256")
    .update(sourceConfigDir)
    .update("\0")
    .update("provider-only")
    .update("\0")
    .update(serialized)
    .digest("hex")
    .slice(0, 20);
  const legacyProfileDir = join(profileRoot, legacyDigest);
  mkdirSync(join(legacyProfileDir, "projects"), { recursive: true });
  mkdirSync(sourceConfigDir, { recursive: true });
  writeFileSync(join(sourceConfigDir, "settings.json"), JSON.stringify({
    env: { ANTHROPIC_BASE_URL: "https://provider.example" },
  }));

  try {
    const env = resolveClaudeSpawnEnvironment(
      { driver: "claude" },
      {
        baseEnv: { CLAUDE_CONFIG_DIR: sourceConfigDir },
        profileRoot,
      },
    );

    expect(env?.CLAUDE_CONFIG_DIR).toBeDefined();
    expect(env?.CLAUDE_CONFIG_DIR).not.toBe(legacyProfileDir);
    writeFileSync(join(env!.CLAUDE_CONFIG_DIR!, "projects", "new.jsonl"), "new");
    expect(readFileSync(join(sourceConfigDir, "projects", "new.jsonl"), "utf8")).toBe("new");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Claude-managed runtime directories can be recreated between prompts", () => {
  const root = mkdtempSync(join(tmpdir(), "xacpx-claude-runtime-dirs-"));
  const sourceConfigDir = join(root, "source");
  const profileRoot = join(root, "profiles");
  mkdirSync(sourceConfigDir, { recursive: true });
  writeFileSync(join(sourceConfigDir, "settings.json"), JSON.stringify({
    env: { ANTHROPIC_BASE_URL: "https://provider.example" },
  }));

  try {
    const options = {
      baseEnv: { CLAUDE_CONFIG_DIR: sourceConfigDir },
      profileRoot,
    };
    const firstEnv = resolveClaudeSpawnEnvironment({ driver: "claude" }, options);
    const profileDir = firstEnv?.CLAUDE_CONFIG_DIR;
    expect(profileDir).toBeDefined();
    expect(existsSync(join(profileDir!, "session-env"))).toBe(false);
    expect(existsSync(join(profileDir!, "shell-snapshots"))).toBe(false);

    mkdirSync(join(profileDir!, "session-env"), { recursive: true });
    mkdirSync(join(profileDir!, "shell-snapshots"), { recursive: true });
    writeFileSync(join(profileDir!, "session-env", "turn.env"), "session");
    writeFileSync(join(profileDir!, "shell-snapshots", "turn.sh"), "snapshot");

    const secondEnv = resolveClaudeSpawnEnvironment({ driver: "claude" }, options);
    expect(secondEnv?.CLAUDE_CONFIG_DIR).toBe(profileDir);
    expect(lstatSync(join(profileDir!, "session-env")).isSymbolicLink()).toBe(false);
    expect(lstatSync(join(profileDir!, "shell-snapshots")).isSymbolicLink()).toBe(false);
    expect(readFileSync(join(profileDir!, "session-env", "turn.env"), "utf8")).toBe("session");
    expect(readFileSync(join(profileDir!, "shell-snapshots", "turn.sh"), "utf8")).toBe("snapshot");
    expect(existsSync(join(sourceConfigDir, "session-env"))).toBe(false);
    expect(existsSync(join(sourceConfigDir, "shell-snapshots"))).toBe(false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("default provider-only stays inert for normal first-party Claude settings", () => {
  const env = resolveClaudeSpawnEnvironment(
    { driver: "claude" },
    {
      baseEnv: { ANTHROPIC_API_KEY: "first-party-key" },
      readTextFile: () => JSON.stringify({ model: "sonnet", hooks: { Stop: [] } }),
    },
  );

  expect(env).toBeUndefined();
});

test("isolated hides user settings while linking the original session storage", () => {
  let profilePath = "";
  let profileContent = "";
  let linkedState: { source: string; profile: string } | undefined;
  const env = resolveClaudeSpawnEnvironment(
    { driver: "claude", settingsPolicy: "isolated" },
    {
      baseEnv: {
        ACPX_CLAUDE_INCLUDE_USER_SETTINGS: "1",
        CLAUDE_CONFIG_DIR: "/profiles/isolated",
        KEEP: "yes",
      },
      readTextFile: () => JSON.stringify({ env: { ANTHROPIC_AUTH_TOKEN: "secret" }, model: "sonnet" }),
      writeProfile: (path, content) => {
        profilePath = path;
        profileContent = content;
      },
      linkSessionState: (source, profile) => {
        linkedState = { source, profile };
      },
    },
  );

  expect(env?.ACPX_CLAUDE_INCLUDE_USER_SETTINGS).toBeUndefined();
  expect(env?.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
  expect(env?.KEEP).toBe("yes");
  expect(env?.CLAUDE_CONFIG_DIR).toBe(dirname(profilePath));
  expect(env?.CLAUDE_MODEL_CONFIG).toBeUndefined();
  expect(JSON.parse(profileContent)).toEqual({});
  expect(linkedState).toEqual({ source: resolve("/profiles/isolated"), profile: dirname(profilePath) });
});

test("provider-only clears an inherited full-user opt-in", () => {
  const env = resolveClaudeSpawnEnvironment(
    { driver: "claude" },
    {
      baseEnv: { ACPX_CLAUDE_INCLUDE_USER_SETTINGS: "1" },
      readTextFile: () => JSON.stringify({
        env: { ANTHROPIC_AUTH_TOKEN: "secret" },
      }),
      writeProfile: () => {},
      linkSessionState: () => {},
    },
  );

  expect(env?.ACPX_CLAUDE_INCLUDE_USER_SETTINGS).toBeUndefined();
});

test("Windows environment keys are matched and cleared case-insensitively", () => {
  const env = resolveClaudeSpawnEnvironment(
    { driver: "claude" },
    {
      platform: "win32",
      baseEnv: {
        Anthropic_Base_Url: "https://provider.example",
        Acpx_Claude_Include_User_Settings: "1",
      },
      readTextFile: () => "{}",
      writeProfile: () => {},
      linkSessionState: () => {},
    },
  );

  expect(Object.keys(env ?? {}).some((key) => key.toUpperCase() === "ACPX_CLAUDE_INCLUDE_USER_SETTINGS")).toBe(false);
  expect(Object.entries(env ?? {}).find(([key]) => key.toUpperCase() === "ANTHROPIC_BASE_URL")?.[1])
    .toBe("https://provider.example");
});

test("the filtered profile reads and writes native transcripts through the original session store", () => {
  const root = mkdtempSync(join(tmpdir(), "xacpx-claude-policy-"));
  const sourceConfigDir = join(root, "source");
  const sourceProjects = join(sourceConfigDir, "projects");
  const sourceTasks = join(sourceConfigDir, "tasks");
  mkdirSync(sourceProjects, { recursive: true });
  writeFileSync(join(sourceProjects, "existing.jsonl"), "existing");
  writeFileSync(join(sourceConfigDir, "settings.json"), JSON.stringify({
    env: { ANTHROPIC_BASE_URL: "https://provider.example" },
  }));

  try {
    const env = resolveClaudeSpawnEnvironment(
      { driver: "claude" },
      {
        baseEnv: { CLAUDE_CONFIG_DIR: sourceConfigDir },
        profileRoot: join(root, "profiles"),
      },
    );
    const profileDir = env?.CLAUDE_CONFIG_DIR;
    expect(profileDir).toBeDefined();
    expect(readFileSync(join(profileDir!, "projects", "existing.jsonl"), "utf8")).toBe("existing");

    writeFileSync(join(profileDir!, "projects", "new.jsonl"), "new");
    expect(readFileSync(join(sourceProjects, "new.jsonl"), "utf8")).toBe("new");
    writeFileSync(join(profileDir!, "tasks", "task.json"), "task");
    expect(readFileSync(join(sourceTasks, "task.json"), "utf8")).toBe("task");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("full-user explicitly opts acpx into the original Claude config", () => {
  const env = resolveClaudeSpawnEnvironment(
    { driver: "claude", settingsPolicy: "full-user", model: "web-model" },
    {
      baseEnv: {
        CLAUDE_CONFIG_DIR: "D:\\claude-profile",
        ANTHROPIC_MODEL: "inherited-model",
      },
    },
  );

  expect(env).toEqual({
    CLAUDE_CONFIG_DIR: "D:\\claude-profile",
    ANTHROPIC_MODEL: "web-model",
    ACPX_CLAUDE_INCLUDE_USER_SETTINGS: "1",
  });
});

test("isolated uses an explicit session model instead of an inherited model", () => {
  const env = resolveClaudeSpawnEnvironment(
    { driver: "claude", settingsPolicy: "isolated", model: "web-model" },
    {
      baseEnv: { ANTHROPIC_MODEL: "inherited-model" },
      writeProfile: () => {},
      linkSessionState: () => {},
    },
  );

  expect(env?.ANTHROPIC_MODEL).toBe("web-model");
});

test("non-Claude agents do not receive a copied process environment", () => {
  expect(resolveClaudeSpawnEnvironment(
    { driver: "codex", settingsPolicy: "full-user" },
    { baseEnv: { SECRET: "value" } },
  )).toBeUndefined();
});
