import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, realpathSync, symlinkSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { writePrivateFileSync } from "../util/private-file.js";

export type ClaudeSettingsPolicy = "provider-only" | "isolated" | "full-user";

export const DEFAULT_CLAUDE_SETTINGS_POLICY: ClaudeSettingsPolicy = "provider-only";

// Bump this when the filtered profile's on-disk layout changes. Reusing a
// digest created by an older layout can leave real directories where the
// current version requires links, and must not make every future prompt fail.
const CLAUDE_SETTINGS_PROFILE_LAYOUT_VERSION = "persistent-state-links-v1";

export function isClaudeSettingsPolicy(value: unknown): value is ClaudeSettingsPolicy {
  return value === "provider-only" || value === "isolated" || value === "full-user";
}

export interface ClaudeExecutionSettings {
  driver?: string;
  settingsPolicy?: ClaudeSettingsPolicy;
  model?: string;
}

/**
 * Mutation provenance for one Claude spawn-env resolution: which keys the
 * resolver explicitly wrote or removed, independent of whether the value
 * happens to equal the parent. A same-value intentional write (e.g. an
 * explicit session model matching an inherited ANTHROPIC_MODEL) must still
 * ride the Runtime overlay above persisted session env — a pure value diff
 * cannot recover that intent.
 */
export interface ClaudeEnvironmentProvenance {
  setKeys: Set<string>;
  clearedKeys: Set<string>;
}

export interface ResolveClaudeSpawnEnvironmentOptions {
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
  return resolveClaudeSpawnEnvironmentWithProvenance(input, options).env;
}

/**
 * Resolves the Runtime `agentProcessEnv` overlay in a single pass: the
 * intentional overlay for acpx, derived with the resolver's own mutation
 * provenance (not a value diff — a same-value intentional write still rides
 * above persisted session env). `undefined` when the resolver yields no env.
 */
export function resolveClaudeAgentProcessEnv(
  input: ClaudeExecutionSettings,
  options: ResolveClaudeSpawnEnvironmentOptions = {},
): Record<string, string> | undefined {
  const baseEnv = options.baseEnv ?? process.env;
  const platform = options.platform ?? process.platform;
  const { env, provenance } = resolveClaudeSpawnEnvironmentWithProvenance(input, options);
  return narrowToAgentProcessEnvOverlay(env, baseEnv, platform, provenance);
}

function resolveClaudeSpawnEnvironmentWithProvenance(
  input: ClaudeExecutionSettings,
  options: ResolveClaudeSpawnEnvironmentOptions = {},
): { env: NodeJS.ProcessEnv | undefined; provenance: ClaudeEnvironmentProvenance } {
  if (input.driver !== "claude") {
    return { env: undefined, provenance: { setKeys: new Set(), clearedKeys: new Set() } };
  }

  const policy = input.settingsPolicy ?? DEFAULT_CLAUDE_SETTINGS_POLICY;
  const baseEnv = { ...(options.baseEnv ?? process.env) };
  const platform = options.platform ?? process.platform;
  const provenance: ClaudeEnvironmentProvenance = { setKeys: new Set(), clearedKeys: new Set() };
  const explicitModel = readModel(input.model);
  if (explicitModel) {
    // The Claude adapter gives ANTHROPIC_MODEL precedence over its --model
    // argument and over settings.json. Keep every policy on the same explicit
    // session model, including full-user and isolated.
    setEnvironmentValue(baseEnv, "ANTHROPIC_MODEL", explicitModel, platform, provenance);
  }

  if (policy === "full-user") {
    setEnvironmentValue(baseEnv, "ACPX_CLAUDE_INCLUDE_USER_SETTINGS", "1", platform, provenance);
    return { env: baseEnv, provenance };
  }

  const homeDir = options.homeDir ?? homedir();
  const sourceConfigDir = resolveClaudeConfigDir(baseEnv, homeDir, platform);

  if (policy === "isolated") {
    deleteEnvironmentValue(baseEnv, "ACPX_CLAUDE_INCLUDE_USER_SETTINGS", platform, provenance);
    installSettingsProfile(baseEnv, sourceConfigDir, policy, {}, options, platform, provenance);
    return { env: baseEnv, provenance };
  }

  const settingsPath = join(sourceConfigDir, "settings.json");
  const readTextFile = options.readTextFile ?? ((path: string) => readFileSync(path, "utf8"));
  const rawSettings = readSettings(settingsPath, readTextFile);

  const settingsEnv = readAnthropicEnvironment(rawSettings?.env, platform);
  const effectiveProviderEnv = { ...settingsEnv, ...pickAnthropicEnvironment(baseEnv, platform) };
  if (!isThirdPartyProviderEnvironment(effectiveProviderEnv)) {
    return { env: undefined, provenance };
  }
  for (const [key, value] of Object.entries(settingsEnv)) {
    if (!nonEmpty(getEnvironmentValue(baseEnv, key, platform))) {
      setEnvironmentValue(baseEnv, key, value, platform, provenance);
    }
  }

  // Never enable the adapter's full user-settings source for provider-only.
  // The managed Claude adapter accepts these narrow environment seams. The
  // filtered profile redirects settings reads while its state-directory links
  // keep session history in the user's original profile.
  deleteEnvironmentValue(baseEnv, "ACPX_CLAUDE_INCLUDE_USER_SETTINGS", platform, provenance);
  if (!explicitModel && !nonEmpty(getEnvironmentValue(baseEnv, "ANTHROPIC_MODEL", platform))) {
    const settingsModel = readModel(rawSettings?.model);
    if (settingsModel) setEnvironmentValue(baseEnv, "ANTHROPIC_MODEL", settingsModel, platform, provenance);
  }
  if (!nonEmpty(getEnvironmentValue(baseEnv, "CLAUDE_MODEL_CONFIG", platform))) {
    const modelConfig = sanitizeClaudeModelConfig(rawSettings);
    if (Object.keys(modelConfig).length > 0) {
      setEnvironmentValue(baseEnv, "CLAUDE_MODEL_CONFIG", JSON.stringify(modelConfig), platform, provenance);
    }
  }
  installSettingsProfile(
    baseEnv,
    sourceConfigDir,
    policy,
    sanitizeClaudeSettings(rawSettings, !input.model),
    options,
    platform,
    provenance,
  );
  return { env: baseEnv, provenance };
}

/**
 * xacpx-owned control keys whose REMOVAL from the resolved env is itself an
 * intentional policy decision (the resolver deletes them to force a
 * restricted profile). An additive-only overlay like acpx `agentProcessEnv`
 * cannot express deletion, so these are re-expressed as explicit clear
 * values — the Claude adapter only treats the exact string `"1"` as enabled
 * (`resolveClaudeCodeSettingSources`), hence `"0"` provably restores the
 * restricted default.
 */
const RUNTIME_CLEARED_CONTROL_KEYS = ["ACPX_CLAUDE_INCLUDE_USER_SETTINGS"] as const;

/**
 * Narrows a fully-resolved Claude spawn env (see
 * resolveClaudeSpawnEnvironment) to the intentional Runtime overlay for
 * acpx `agentProcessEnv`. A key crosses the boundary when the resolver
 * explicitly wrote it (provenance, when provided) or when its value
 * differs from the base — the inherited parent remainder stays out, so
 * persisted `sessionOptions.env` keeps its upstream precedence (protected
 * auth > agentProcessEnv > persisted session env > inherited parent env)
 * instead of being shadowed by a re-elevated copy of the parent. A
 * same-value intentional write (e.g. an explicit session model matching
 * an inherited ANTHROPIC_MODEL) still rides the overlay: without
 * provenance a pure value diff cannot tell it apart from inheritance.
 *
 * `resolved === undefined` (first-party provider-only: nothing intentional)
 * narrows to `undefined`, as does an empty delta. `baseEnv` must be the
 * same base the resolver derived from (defaults to process.env, matching
 * the resolver default).
 */
export function narrowToAgentProcessEnvOverlay(
  resolved: NodeJS.ProcessEnv | undefined,
  baseEnv: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  provenance?: ClaudeEnvironmentProvenance,
): Record<string, string> | undefined {
  if (resolved === undefined) return undefined;
  const overlay: Record<string, string> = {};
  for (const [key, value] of Object.entries(resolved)) {
    if (typeof value !== "string") continue;
    if ((provenance && hasProvenanceKey(provenance.setKeys, key, platform)) || getEnvironmentValue(baseEnv, key, platform) !== value) {
      overlay[key] = value;
    }
  }
  for (const name of RUNTIME_CLEARED_CONTROL_KEYS) {
    // A resolver-deleted control key is re-expressed as an explicit clear
    // so it keeps beating persisted session env. With provenance, the
    // recorded clear is itself the intent — no base-presence gate, otherwise
    // a stale persisted "1" could resurrect a restricted policy the parent
    // never had. Without provenance, fall back to base-has/resolved-lacks
    // detection to avoid inventing noise. Either way a re-set value present
    // in the resolved env is never covered.
    const resolvedLacks = getEnvironmentValue(resolved, name, platform) === undefined;
    if (provenance) {
      if (hasProvenanceKey(provenance.clearedKeys, name, platform) && resolvedLacks) {
        overlay[name] = "0";
      }
    } else if (getEnvironmentValue(baseEnv, name, platform) !== undefined && resolvedLacks) {
      overlay[name] = "0";
    }
  }
  return Object.keys(overlay).length > 0 ? overlay : undefined;
}

function hasProvenanceKey(keys: Set<string>, name: string, platform: NodeJS.Platform): boolean {
  if (keys.has(name)) return true;
  if (platform !== "win32") return false;
  const upper = name.toUpperCase();
  for (const candidate of keys) {
    if (candidate.toUpperCase() === upper) return true;
  }
  return false;
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
  provenance?: ClaudeEnvironmentProvenance,
): void {
  const serialized = `${JSON.stringify(settings, null, 2)}\n`;
  const digest = createHash("sha256")
    .update(sourceConfigDir)
    .update("\0")
    .update(policy)
    .update("\0")
    .update(CLAUDE_SETTINGS_PROFILE_LAYOUT_VERSION)
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
  setEnvironmentValue(env, "CLAUDE_CONFIG_DIR", profileDir, platform, provenance);
}

// Link only durable state that native list/resume and transcript discovery need.
// Claude recreates session-env and shell-snapshots during a running turn. If
// either is a junction, Claude can replace it with a real directory and poison
// the next prompt's link validation. Those runtime-owned directories therefore
// stay local to the filtered profile.
const CLAUDE_PERSISTENT_SESSION_STATE_DIRS = [
  "projects",
  "file-history",
  "plans",
  "todos",
  "tasks",
  "teams",
  "sessions",
  "transcripts",
] as const;

function linkClaudeSessionState(
  sourceConfigDir: string,
  profileDir: string,
  platform: NodeJS.Platform,
): void {
  for (const name of CLAUDE_PERSISTENT_SESSION_STATE_DIRS) {
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

function deleteEnvironmentValue(
  env: NodeJS.ProcessEnv,
  name: string,
  platform: NodeJS.Platform,
  provenance?: ClaudeEnvironmentProvenance,
): void {
  for (const key of Object.keys(env)) {
    if (key === name || (platform === "win32" && key.toUpperCase() === name.toUpperCase())) {
      delete env[key];
    }
  }
  provenance?.clearedKeys.add(name);
}

function setEnvironmentValue(
  env: NodeJS.ProcessEnv,
  name: string,
  value: string,
  platform: NodeJS.Platform,
  provenance?: ClaudeEnvironmentProvenance,
): void {
  deleteEnvironmentValue(env, name, platform);
  env[name] = value;
  provenance?.setKeys.add(name);
}

export const __claudeSettingsPolicyForTests = {
  sanitizeClaudeModelConfig,
  sanitizeClaudeSettings,
  linkClaudeSessionState,
};
