import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { writePrivateFileSync } from "../util/private-file.js";

export type ClaudeSettingsPolicy = "provider-only" | "isolated" | "full-user";

export const DEFAULT_CLAUDE_SETTINGS_POLICY: ClaudeSettingsPolicy = "provider-only";

export function isClaudeSettingsPolicy(value: unknown): value is ClaudeSettingsPolicy {
  return value === "provider-only" || value === "isolated" || value === "full-user";
}

interface ResolveClaudeSpawnEnvironmentInput {
  driver?: string;
  settingsPolicy?: ClaudeSettingsPolicy;
}

interface ResolveClaudeSpawnEnvironmentOptions {
  baseEnv?: NodeJS.ProcessEnv;
  homeDir?: string;
  snapshotRoot?: string;
  readTextFile?: (path: string) => string;
  writeSnapshot?: (path: string, content: string) => void;
}

/**
 * Builds the environment for one acpx invocation without ever putting provider
 * credentials on the bridge protocol or in xacpx state. The default policy is
 * intentionally inert for normal Claude OAuth/API-key users: it only installs
 * the filtered settings view when a third-party provider marker is present.
 */
export function resolveClaudeSpawnEnvironment(
  input: ResolveClaudeSpawnEnvironmentInput,
  options: ResolveClaudeSpawnEnvironmentOptions = {},
): NodeJS.ProcessEnv | undefined {
  if (input.driver !== "claude") return undefined;

  const policy = input.settingsPolicy ?? DEFAULT_CLAUDE_SETTINGS_POLICY;
  const baseEnv = { ...(options.baseEnv ?? process.env) };

  if (policy === "full-user") {
    baseEnv.ACPX_CLAUDE_INCLUDE_USER_SETTINGS = "1";
    return baseEnv;
  }

  const homeDir = options.homeDir ?? homedir();
  const sourceConfigDir = resolveClaudeConfigDir(baseEnv, homeDir);
  const settingsPath = join(sourceConfigDir, "settings.json");
  const readTextFile = options.readTextFile ?? ((path: string) => readFileSync(path, "utf8"));
  const rawSettings = readSettings(settingsPath, readTextFile);

  if (policy === "provider-only") {
    const settingsEnv = readAnthropicEnvironment(rawSettings?.env);
    const effectiveProviderEnv = { ...settingsEnv, ...pickAnthropicEnvironment(baseEnv) };
    if (!isThirdPartyProviderEnvironment(effectiveProviderEnv)) {
      return undefined;
    }
    for (const [key, value] of Object.entries(settingsEnv)) {
      if (!nonEmpty(baseEnv[key])) baseEnv[key] = value;
    }
    baseEnv.ACPX_CLAUDE_INCLUDE_USER_SETTINGS = "1";
  } else {
    // Explicit isolation wins even if the daemon inherited the acpx opt-in.
    delete baseEnv.ACPX_CLAUDE_INCLUDE_USER_SETTINGS;
  }

  const sanitizedSettings = policy === "provider-only"
    ? sanitizeClaudeModelSettings(rawSettings)
    : {};
  const serialized = `${JSON.stringify(sanitizedSettings, null, 2)}\n`;
  const digest = createHash("sha256")
    .update(sourceConfigDir)
    .update("\0")
    .update(serialized)
    .digest("hex")
    .slice(0, 20);
  const snapshotDir = join(options.snapshotRoot ?? join(tmpdir(), "xacpx-claude-settings"), digest);
  const snapshotPath = join(snapshotDir, "settings.json");
  (options.writeSnapshot ?? writePrivateFileSync)(snapshotPath, serialized);
  baseEnv.CLAUDE_CONFIG_DIR = snapshotDir;
  return baseEnv;
}

function resolveClaudeConfigDir(env: NodeJS.ProcessEnv, homeDir: string): string {
  const configured = env.CLAUDE_CONFIG_DIR?.trim();
  return configured ? resolve(configured) : join(homeDir, ".claude");
}

function readSettings(
  path: string,
  readTextFile: (path: string) => string,
): Record<string, unknown> | undefined {
  try {
    const parsed = JSON.parse(readTextFile(path).replace(/^\uFEFF/, "")) as unknown;
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    // Missing or malformed user settings must not make Claude unusable.
    return undefined;
  }
}

function readAnthropicEnvironment(value: unknown): Record<string, string> {
  if (!isRecord(value)) return {};
  const result: Record<string, string> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (/^ANTHROPIC_[A-Z0-9_]+$/.test(key) && typeof entry === "string" && entry.length > 0) {
      result[key] = entry;
    }
  }
  return result;
}

function pickAnthropicEnvironment(env: NodeJS.ProcessEnv): Record<string, string> {
  return readAnthropicEnvironment(env);
}

function isThirdPartyProviderEnvironment(env: Record<string, string>): boolean {
  // ANTHROPIC_API_KEY alone is also the normal first-party API-key flow. A
  // custom endpoint or auth-token convention is the reliable provider signal.
  return nonEmpty(env.ANTHROPIC_BASE_URL) || nonEmpty(env.ANTHROPIC_AUTH_TOKEN);
}

function sanitizeClaudeModelSettings(settings: Record<string, unknown> | undefined): Record<string, unknown> {
  if (!settings) return {};
  const sanitized: Record<string, unknown> = {};
  if (typeof settings.model === "string" && settings.model.trim()) {
    sanitized.model = settings.model;
  }
  if (isStringRecord(settings.modelOverrides)) {
    sanitized.modelOverrides = settings.modelOverrides;
  }
  if (Array.isArray(settings.availableModels) && settings.availableModels.every((value) => typeof value === "string")) {
    sanitized.availableModels = settings.availableModels;
  }
  return sanitized;
}

function isStringRecord(value: unknown): value is Record<string, string> {
  return isRecord(value) && Object.values(value).every((entry) => typeof entry === "string");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonEmpty(value: string | undefined): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

export const __claudeSettingsPolicyForTests = {
  sanitizeClaudeModelSettings,
};
