import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, realpathSync, symlinkSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { writePrivateFileSync } from "../util/private-file.js";

export type ClaudeSettingsPolicy = "provider-only" | "isolated" | "full-user";

export const DEFAULT_CLAUDE_SETTINGS_POLICY: ClaudeSettingsPolicy = "provider-only";

export function isClaudeSettingsPolicy(value: unknown): value is ClaudeSettingsPolicy {
  return value === "provider-only" || value === "isolated" || value === "full-user";
}

export interface ClaudeExecutionSettings {
  driver?: string;
  settingsPolicy?: ClaudeSettingsPolicy;
  model?: string;
}

interface ResolveClaudeSpawnEnvironmentOptions {
  baseEnv?: NodeJS.ProcessEnv;
  homeDir?: string;
  platform?: NodeJS.Platform;
  profileRoot?: string;
  readTextFile?: (path: string) => string;
  writeProfile?: (path: string, content: string) => void;
  linkSessionState?: (sourceConfigDir: string, profileDir: string) => void;
}

/**
 * Builds the environment for one acpx invocation without ever putting provider
 * credentials on the bridge protocol or in xacpx state. The default policy is
 * intentionally inert for normal Claude OAuth/API-key users: it only imports
 * the narrow provider/model fields when a third-party marker is present.
 */
export function resolveClaudeSpawnEnvironment(
  input: ClaudeExecutionSettings,
  options: ResolveClaudeSpawnEnvironmentOptions = {},
): NodeJS.ProcessEnv | undefined {
  if (input.driver !== "claude") return undefined;

  const policy = input.settingsPolicy ?? DEFAULT_CLAUDE_SETTINGS_POLICY;
  const baseEnv = { ...(options.baseEnv ?? process.env) };
  const platform = options.platform ?? process.platform;
  const explicitModel = readModel(input.model);
  if (explicitModel) {
    // The Claude adapter gives ANTHROPIC_MODEL precedence over its --model
    // argument and over settings.json. Keep every policy on the same explicit
    // session model, including full-user and isolated.
    setEnvironmentValue(baseEnv, "ANTHROPIC_MODEL", explicitModel, platform);
  }

  if (policy === "full-user") {
    setEnvironmentValue(baseEnv, "ACPX_CLAUDE_INCLUDE_USER_SETTINGS", "1", platform);
    return baseEnv;
  }

  const homeDir = options.homeDir ?? homedir();
  const sourceConfigDir = resolveClaudeConfigDir(baseEnv, homeDir, platform);

  if (policy === "isolated") {
    deleteEnvironmentValue(baseEnv, "ACPX_CLAUDE_INCLUDE_USER_SETTINGS", platform);
    installSettingsProfile(baseEnv, sourceConfigDir, policy, {}, options, platform);
    return baseEnv;
  }

  const settingsPath = join(sourceConfigDir, "settings.json");
  const readTextFile = options.readTextFile ?? ((path: string) => readFileSync(path, "utf8"));
  const rawSettings = readSettings(settingsPath, readTextFile);

  const settingsEnv = readAnthropicEnvironment(rawSettings?.env, platform);
  const effectiveProviderEnv = { ...settingsEnv, ...pickAnthropicEnvironment(baseEnv, platform) };
  if (!isThirdPartyProviderEnvironment(effectiveProviderEnv)) {
    return undefined;
  }
  for (const [key, value] of Object.entries(settingsEnv)) {
    if (!nonEmpty(getEnvironmentValue(baseEnv, key, platform))) {
      setEnvironmentValue(baseEnv, key, value, platform);
    }
  }

  // Never enable the adapter's full user-settings source for provider-only.
  // The managed Claude adapter accepts these narrow environment seams. The
  // filtered profile redirects settings reads while its state-directory links
  // keep session history in the user's original profile.
  deleteEnvironmentValue(baseEnv, "ACPX_CLAUDE_INCLUDE_USER_SETTINGS", platform);
  if (!explicitModel && !nonEmpty(getEnvironmentValue(baseEnv, "ANTHROPIC_MODEL", platform))) {
    const settingsModel = readModel(rawSettings?.model);
    if (settingsModel) setEnvironmentValue(baseEnv, "ANTHROPIC_MODEL", settingsModel, platform);
  }
  if (!nonEmpty(getEnvironmentValue(baseEnv, "CLAUDE_MODEL_CONFIG", platform))) {
    const modelConfig = sanitizeClaudeModelConfig(rawSettings);
    if (Object.keys(modelConfig).length > 0) {
      setEnvironmentValue(baseEnv, "CLAUDE_MODEL_CONFIG", JSON.stringify(modelConfig), platform);
    }
  }
  installSettingsProfile(
    baseEnv,
    sourceConfigDir,
    policy,
    sanitizeClaudeSettings(rawSettings, !input.model),
    options,
    platform,
  );
  return baseEnv;
}

function resolveClaudeConfigDir(env: NodeJS.ProcessEnv, homeDir: string, platform: NodeJS.Platform): string {
  const configured = getEnvironmentValue(env, "CLAUDE_CONFIG_DIR", platform)?.trim();
  return configured ? resolve(configured) : join(homeDir, ".claude");
}

function installSettingsProfile(
  env: NodeJS.ProcessEnv,
  sourceConfigDir: string,
  policy: Exclude<ClaudeSettingsPolicy, "full-user">,
  settings: Record<string, unknown>,
  options: ResolveClaudeSpawnEnvironmentOptions,
  platform: NodeJS.Platform,
): void {
  const serialized = `${JSON.stringify(settings, null, 2)}\n`;
  const digest = createHash("sha256")
    .update(sourceConfigDir)
    .update("\0")
    .update(policy)
    .update("\0")
    .update(serialized)
    .digest("hex")
    .slice(0, 20);
  const profileDir = join(options.profileRoot ?? join(tmpdir(), "xacpx-claude-profiles"), digest);
  const settingsPath = join(profileDir, "settings.json");
  (options.writeProfile ?? writePrivateFileSync)(settingsPath, serialized);
  (options.linkSessionState ?? ((source, profile) => linkClaudeSessionState(source, profile, platform)))(
    sourceConfigDir,
    profileDir,
  );
  setEnvironmentValue(env, "CLAUDE_CONFIG_DIR", profileDir, platform);
}

const CLAUDE_SESSION_STATE_DIRS = [
  "projects",
  "file-history",
  "plans",
  "todos",
  "session-env",
  "tasks",
  "teams",
  "sessions",
  "transcripts",
  "shell-snapshots",
] as const;

function linkClaudeSessionState(
  sourceConfigDir: string,
  profileDir: string,
  platform: NodeJS.Platform,
): void {
  for (const name of CLAUDE_SESSION_STATE_DIRS) {
    const source = join(sourceConfigDir, name);
    // Create lazy state stores in the native profile before linking them. If
    // Claude created them under the filtered profile instead, that state would
    // disappear from native session discovery and from future profile hashes.
    mkdirSync(source, { recursive: true });
    const target = join(profileDir, name);
    if (existsSync(target)) {
      if (realpathSync(target) !== realpathSync(source)) {
        throw new Error(`Claude settings profile state link points to an unexpected target: ${target}`);
      }
      continue;
    }
    try {
      symlinkSync(source, target, platform === "win32" ? "junction" : "dir");
    } catch (error) {
      if (!isAlreadyExistsError(error) || realpathSync(target) !== realpathSync(source)) throw error;
    }
  }
}

function isAlreadyExistsError(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && (error as { code?: unknown }).code === "EEXIST");
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

function readAnthropicEnvironment(value: unknown, platform: NodeJS.Platform): Record<string, string> {
  if (!isRecord(value)) return {};
  const result: Record<string, string> = {};
  for (const [key, entry] of Object.entries(value)) {
    const canonicalKey = platform === "win32" ? key.toUpperCase() : key;
    if (/^ANTHROPIC_[A-Z0-9_]+$/.test(canonicalKey) && typeof entry === "string" && entry.length > 0) {
      result[canonicalKey] = entry;
    }
  }
  return result;
}

function pickAnthropicEnvironment(env: NodeJS.ProcessEnv, platform: NodeJS.Platform): Record<string, string> {
  return readAnthropicEnvironment(env, platform);
}

function isThirdPartyProviderEnvironment(env: Record<string, string>): boolean {
  // ANTHROPIC_API_KEY alone is also the normal first-party API-key flow. A
  // custom endpoint or auth-token convention is the reliable provider signal.
  return nonEmpty(env.ANTHROPIC_BASE_URL) || nonEmpty(env.ANTHROPIC_AUTH_TOKEN);
}

function sanitizeClaudeModelConfig(settings: Record<string, unknown> | undefined): Record<string, unknown> {
  if (!settings) return {};
  const sanitized: Record<string, unknown> = {};
  if (isStringRecord(settings.modelOverrides)) {
    sanitized.modelOverrides = settings.modelOverrides;
  }
  if (Array.isArray(settings.availableModels) && settings.availableModels.every((value) => typeof value === "string")) {
    sanitized.availableModels = settings.availableModels;
  }
  return sanitized;
}

function sanitizeClaudeSettings(
  settings: Record<string, unknown> | undefined,
  includeModel: boolean,
): Record<string, unknown> {
  const sanitized: Record<string, unknown> = {};
  if (includeModel) {
    const model = readModel(settings?.model);
    if (model) sanitized.model = model;
  }
  return { ...sanitized, ...sanitizeClaudeModelConfig(settings) };
}

function readModel(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
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

function getEnvironmentValue(
  env: NodeJS.ProcessEnv,
  name: string,
  platform: NodeJS.Platform,
): string | undefined {
  if (platform !== "win32") return env[name];
  const key = Object.keys(env).find((candidate) => candidate.toUpperCase() === name.toUpperCase());
  return key ? env[key] : undefined;
}

function deleteEnvironmentValue(env: NodeJS.ProcessEnv, name: string, platform: NodeJS.Platform): void {
  for (const key of Object.keys(env)) {
    if (key === name || (platform === "win32" && key.toUpperCase() === name.toUpperCase())) {
      delete env[key];
    }
  }
}

function setEnvironmentValue(
  env: NodeJS.ProcessEnv,
  name: string,
  value: string,
  platform: NodeJS.Platform,
): void {
  deleteEnvironmentValue(env, name, platform);
  env[name] = value;
}

export const __claudeSettingsPolicyForTests = {
  sanitizeClaudeModelConfig,
  sanitizeClaudeSettings,
  linkClaudeSessionState,
};
