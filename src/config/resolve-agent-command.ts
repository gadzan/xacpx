import { createHash } from "node:crypto";
import { dirname } from "node:path";

import { resolveLocalAgentArgv, resolveLocalAgentCommand } from "./local-agent-bin";
import {
  MANAGED_ADAPTERS,
  effectiveAdapterVersion,
  isManagedAdapterId,
  resolveManagedAdapterArgv,
  resolveManagedAdapterCommand,
  type AdapterVersionOverrides,
} from "../adapters/adapter-catalog";
import { effectiveAdapterRegistry } from "../adapters/adapter-registry";
import { resolveActiveAdapterArgvSync, resolveActiveAdapterCommandSync } from "../adapters/adapter-preinstall";
import {
  DEFAULT_CLAUDE_SETTINGS_POLICY,
  resolveClaudeAgentProcessEnv,
  type ClaudeSettingsPolicy,
  type ResolveClaudeSpawnEnvironmentOptions,
} from "../adapters/claude-settings-policy";
import { hermesAcpShimArgv, hermesAcpShimCommand, isDefaultHermesCommand } from "../adapters/hermes-shim";
import { wrapAcpOutputGuardArgv } from "../adapters/acp-output-guard";
import { deriveAgentAlias, renderAgentArgvIdentity, type AgentLaunchSpec } from "./agent-launch";
/** Stable identity of the launch fields a session record persists. Shared by the
 * session launch resolver and the model-probe launch seam so a probe can prove
 * it runs the same launch a normal session would. */
export function launchFingerprint(spec: {
  agentCommand?: string;
  acpxAgent?: string;
  rawCommand?: string;
  agentArgv?: readonly string[];
}): string {
  return createHash("sha256").update(JSON.stringify({
    agentCommand: spec.agentCommand ?? null,
    acpxAgent: spec.acpxAgent ?? null,
    rawCommand: spec.rawCommand ?? null,
    agentArgv: spec.agentArgv ?? null,
  })).digest("hex");
}

import type { AgentCommandRegistry } from "./agent-catalog";
import type { AgentConfig, TransportConfig } from "./types";
import { resolveConfigPathForCurrentEnv } from "./config-path";

export function resolveAgentCommand(
  driver: string,
  command: string | undefined,
): string | undefined {
  if (!command) {
    return undefined;
  }

  if (driver === "codex" && isLegacyCodexCommand(command)) {
    return undefined;
  }

  // The 0.19.2 hermes template persisted this literal command; treating it as
  // "no explicit command" migrates those configs onto the runtime shim below.
  if (driver === "hermes" && isDefaultHermesCommand(command)) {
    return undefined;
  }

  return command;
}

/**
 * Agent command for the RUNTIME spawn/reap paths. An explicit per-agent `command`
 * always wins. Managed codex/claude drivers then use xacpx's exact npx pin; only
 * unmanaged drivers fall through to the optional locally-installed native CLI.
 *
 * Use this — not bare resolveAgentCommand — wherever an agentCommand is built to spawn
 * OR reap a queue owner, so both resolve identically (a mismatch would orphan the owner).
 * It is deliberately NOT used on the config-persistence paths (load/ensure-config), so a
 * machine-specific local binary is never baked into the shareable config file.
 */
export function resolveRuntimeAgentCommand(
  driver: string,
  command: string | undefined,
  preferLocal = true,
  adapterVersions?: AdapterVersionOverrides,
  adapterRegistry?: string,
  runtimeRoot: string = dirname(resolveConfigPathForCurrentEnv()),
): string | undefined {
  const explicit = resolveAgentCommand(driver, command);
  if (explicit) {
    return explicit;
  }
  const managedId = isManagedAdapterId(driver) ? driver : undefined;
  const managedSpec = managedId ? MANAGED_ADAPTERS[managedId] : undefined;
  if (managedId && managedSpec) {
    const version = effectiveAdapterVersion(managedId, adapterVersions);
    const registry = effectiveAdapterRegistry(adapterRegistry);
    const preinstalled = resolveActiveAdapterCommandSync(runtimeRoot, {
      id: managedId,
      version,
      registry,
      packageName: managedSpec.packageName,
    });
    if (preinstalled) return preinstalled;
  }
  const managed = resolveManagedAdapterCommand(driver, adapterVersions, adapterRegistry);
  if (managed) return managed;
  // hermes is not an acpx builtin, so xacpx must always supply its command; the
  // shim strips the buggy `resume` capability (see adapters/hermes-shim.ts).
  if (driver === "hermes") return hermesAcpShimCommand();
  return preferLocal ? resolveLocalAgentCommand(driver) : undefined;
}

/** Config-shaped entrypoint used by every runtime spawn/list/reap path. Keeping
 * this decomposition here prevents those identity-sensitive paths from drifting. */
export function resolveConfiguredAgentCommand(
  agent: Pick<AgentConfig, "driver" | "command">,
  transport?: Pick<TransportConfig, "preferLocalAgents" | "adapterVersions" | "adapterRegistry">,
): string | undefined {
  return resolveRuntimeAgentCommand(
    agent.driver,
    agent.command,
    transport?.preferLocalAgents !== false,
    transport?.adapterVersions,
    transport?.adapterRegistry,
  );
}

export interface ResolveAgentLaunchOptions {
  platform?: NodeJS.Platform;
  /** Runtime root for preinstalled adapter releases; defaults like the runtime resolver. */
  runtimeRoot?: string;
  /** Wrap a newly-created structured launch before raw ACP reaches official acpx. */
  guardAcpOutput?: boolean;
}

/**
 * Structured launch spec for an agent: the single selector every runtime path
 * (transports, state, reaper, doctor) must use.
 *
 * Selection order:
 * 1. explicit raw `command`: Unix keeps it as `--agent`; Windows converts a
 *    single token to argv and rejects anything multi-token with migration guidance.
 * 2. user `argv`: content-addressed overlay alias + canonical identity.
 * 3. managed codex/claude: structured pinned npx argv (alias launch).
 * 4. hermes: ACP shim argv (alias launch).
 * 5. local fallback (opencode/kilocode/reasonix/omp on PATH): structured argv (alias launch).
 * 6. anything else: bare built-in driver positional.
 */
export function resolveConfiguredAgentLaunch(
  agent: Pick<AgentConfig, "driver" | "command" | "argv">,
  transport?: Pick<TransportConfig, "preferLocalAgents" | "adapterVersions" | "adapterRegistry">,
  options: ResolveAgentLaunchOptions = {},
): AgentLaunchSpec {
  const platform = options.platform ?? process.platform;
  const explicit = resolveAgentCommand(agent.driver, agent.command);
  if (explicit) {
    if (platform === "win32") {
      if (/\s/.test(explicit)) {
        throw new Error(
          `agent "${agent.driver}" command cannot be launched on Windows without lossy quoting. ` +
            "Migrate it to an argv array in config: agents.<name>.argv = [\"agent.exe\", \"--acp\", ...]",
        );
      }
      const argv = options.guardAcpOutput
        ? wrapAcpOutputGuardArgv([explicit])
        : [explicit];
      return {
        acpxAgent: deriveAgentAlias(agent.driver, argv),
        agentCommand: renderAgentArgvIdentity(argv),
        agentArgv: argv,
      };
    }
    // agentCommand is the canonical session identity: for a raw command the raw
    // string itself (acpx persists it verbatim via splitCommandLine).
    return { acpxAgent: agent.driver, rawCommand: explicit, agentCommand: explicit };
  }

  const resolvedArgv = structuredAgentArgv(agent, transport, options.runtimeRoot);
  const argv = resolvedArgv && options.guardAcpOutput
    ? wrapAcpOutputGuardArgv(resolvedArgv)
    : resolvedArgv;
  if (argv) {
    return {
      acpxAgent: deriveAgentAlias(agent.driver, argv),
      agentCommand: renderAgentArgvIdentity(argv),
      agentArgv: argv,
    };
  }

  return { acpxAgent: agent.driver };
}

/** Structured argv for explicit-launch agents; undefined for bare built-ins. */
export function structuredAgentArgv(
  agent: Pick<AgentConfig, "driver" | "command" | "argv">,
  transport?: Pick<TransportConfig, "preferLocalAgents" | "adapterVersions" | "adapterRegistry">,
  runtimeRoot: string = dirname(resolveConfigPathForCurrentEnv()),
): string[] | undefined {
  if (agent.argv) return [...agent.argv];
  if (isManagedAdapterId(agent.driver)) {
    // An active preinstalled release replaces the generated npx command for
    // real session launches too (not just --agent paths): offline startup and
    // Windows durable-owner fencing depend on the structured launch honoring it.
    const preinstalled = resolveActiveAdapterArgvSync(runtimeRoot, {
      id: agent.driver,
      version: effectiveAdapterVersion(agent.driver, transport?.adapterVersions),
      registry: effectiveAdapterRegistry(transport?.adapterRegistry),
      packageName: MANAGED_ADAPTERS[agent.driver].packageName,
    });
    if (preinstalled) return preinstalled;
  }
  const managed = resolveManagedAdapterArgv(
    agent.driver,
    transport?.adapterVersions,
    transport?.adapterRegistry,
  );
  if (managed) return managed;
  if (agent.driver === "hermes") return hermesAcpShimArgv();
  if (transport?.preferLocalAgents !== false) {
    const local = resolveLocalAgentArgv(agent.driver);
    if (local) return local;
  }
  return undefined;
}

export function isLegacyCodexCommand(command: string): boolean {
  const normalized = command.trim().replaceAll("\\", "/").toLowerCase();

  return (
    normalized === "./node_modules/.bin/codex-acp" ||
    normalized === "./node_modules/.bin/codex-acp.exe" ||
    normalized.endsWith("/node_modules/.bin/codex-acp") ||
    normalized.endsWith("/node_modules/.bin/codex-acp.exe") ||
    normalized.includes("/@zed-industries/codex-acp/bin/codex-acp.js") ||
    normalized.includes("@zed-industries/codex-acp/bin/codex-acp.js")
  );
}

/**
 * The `CapabilityContext` subset a model probe needs. `CapabilityContext` itself
 * satisfies this shape; the narrower type keeps the config layer free of an
 * import cycle with the agents layer.
 */
export interface ModelProbeLaunchContext {
  cwd: string;
  driver: string;
  settingsPolicy?: ClaudeSettingsPolicy;
  configuredModel?: string;
  launch: {
    agentCommand?: string;
    acpxAgent?: string;
    rawCommand?: string;
    agentArgv?: readonly string[];
  };
  adapterVersion?: string;
  adapterRegistryDigest?: string;
  configRevision?: string;
}

/** Fingerprint identity of one resolved probe (design section 4.2). No argv, no
 * env values, no secrets — digests only. */
export interface ModelProbeLaunchIdentity {
  agent: string;
  driver: string;
  settingsPolicy: string;
  launchDigest: string;
  resolvedAgentCommandDigest: string;
  adapterVersion?: string;
  adapterRegistryDigest?: string;
  authRevision: string;
  configRevision: string;
}

export type ModelProbeLaunch =
  | {
      ok: true;
      agentCommand: string[];
      cwd: string;
      agentProcessEnv?: Record<string, string>;
      identity: ModelProbeLaunchIdentity;
    }
  | {
      ok: false;
      cwd: string;
      identity: ModelProbeLaunchIdentity;
      reason: "probe-unavailable";
      message: string;
    };

export interface ResolveModelProbeLaunchOptions {
  cwd?: string;
  platform?: NodeJS.Platform;
  /** Auth presence is read from here; defaults to `process.env`. Values never leave. */
  env?: NodeJS.ProcessEnv;
  /** Resolve the Claude `agentProcessEnv` overlay. Off by default: profile
   * resolution can touch disk, so passive fingerprinting never opts in. */
  includeEnv?: boolean;
  transport?: Pick<TransportConfig, "adapterVersions" | "adapterRegistry">;
  /** acpx registry for bare drivers. No hand-written driver-to-command table:
   * without a loader a bare driver is probe-unavailable. */
  loadAgentRegistry?: () => AgentCommandRegistry | null;
  claudeEnv?: ResolveClaudeSpawnEnvironmentOptions;
}

/** Policy identity shared by the probe env and the fingerprint: an unset Claude
 * policy behaves as the resolver default, anything else is meaningless. */
export function normalizeProbeSettingsPolicy(driver: string, policy?: ClaudeSettingsPolicy): string {
  if (policy) return policy;
  if (driver === "claude") return DEFAULT_CLAUDE_SETTINGS_POLICY;
  return "none";
}

/**
 * Auth revision from an allowlist of auth-indicating variable NAMES. Presence
 * only — values (and therefore secrets or their hashes) never enter the
 * fingerprint. File-based logins stay invisible here by design; the short TTL
 * plus explicit refresh covers those.
 */
const AUTH_PRESENCE_ALLOWLIST: Record<string, true> = {
  ANTHROPIC_API_KEY: true,
  ANTHROPIC_AUTH_TOKEN: true,
  CLAUDE_CODE_OAUTH_TOKEN: true,
  OPENAI_API_KEY: true,
  GEMINI_API_KEY: true,
  GOOGLE_API_KEY: true,
};

export function authRevisionForEnv(env: NodeJS.ProcessEnv): string {
  const present = Object.keys(env).filter((key) => AUTH_PRESENCE_ALLOWLIST[key]).sort();
  return createHash("sha256").update(`auth-revision-v1\n${present.join("\n")}`).digest("hex");
}

function adapterRegistryDigestFor(registry: string | undefined): string | undefined {
  if (!registry) return undefined;
  return createHash("sha256").update(`adapter-registry-v1\n${effectiveAdapterRegistry(registry)}`).digest("hex");
}

/**
 * Resolve the exact argv a cold model probe must spawn: the ALREADY-resolved
 * session launch from the capability context, never a re-guessed driver.
 * Structured launches (user argv, managed pin, preinstalled release, Hermes
 * shim, local fallback, overlay alias, Windows single-token synthesis) carry
 * their argv and are reused verbatim. Unix raw commands and bare drivers
 * without a registry answer are probe-unavailable, never guessed.
 *
 * A probe has no session, so recorded-launch stickiness does not apply: the
 * current config resolution is the only provable identity. Sessions pinned to
 * older recorded launches keep their own identity and simply do not match.
 */
export function resolveModelProbeLaunch(
  agent: string,
  context: ModelProbeLaunchContext,
  options: ResolveModelProbeLaunchOptions = {},
): ModelProbeLaunch {
  const env = options.env ?? options.claudeEnv?.baseEnv ?? process.env;
  const cwd = options.cwd ?? context.cwd;
  const settingsPolicy = normalizeProbeSettingsPolicy(context.driver, context.settingsPolicy);
  const launchDigest = launchFingerprint(context.launch);
  const argv = probeArgvForLaunch(context.driver, context.launch, options);
  const resolvedAgentCommandDigest = argv.ok
    ? createHash("sha256").update(JSON.stringify(argv.argv)).digest("hex")
    : createHash("sha256").update(`unresolved-model-probe-launch\n${launchDigest}`).digest("hex");
  const adapterVersion = context.adapterVersion ??
    (isManagedAdapterId(context.driver)
      ? effectiveAdapterVersion(context.driver, options.transport?.adapterVersions)
      : undefined);
  const adapterRegistryDigest = context.adapterRegistryDigest ??
    adapterRegistryDigestFor(options.transport?.adapterRegistry);
  const identity: ModelProbeLaunchIdentity = {
    agent,
    driver: context.driver,
    settingsPolicy,
    launchDigest,
    resolvedAgentCommandDigest,
    ...(adapterVersion !== undefined ? { adapterVersion } : {}),
    ...(adapterRegistryDigest !== undefined ? { adapterRegistryDigest } : {}),
    authRevision: authRevisionForEnv(env),
    configRevision: context.configRevision ?? "unversioned",
  };
  if (!argv.ok) {
    return { ok: false, cwd, identity, reason: "probe-unavailable", message: argv.message };
  }
  if (!options.includeEnv) {
    return { ok: true, agentCommand: argv.argv, cwd, identity };
  }
  const agentProcessEnv = resolveClaudeAgentProcessEnv(
    {
      driver: context.driver,
      ...(context.settingsPolicy ? { settingsPolicy: context.settingsPolicy } : {}),
      ...(context.configuredModel ? { model: context.configuredModel } : {}),
    },
    {
      ...(options.claudeEnv ?? {}),
      baseEnv: env,
      platform: options.platform ?? options.claudeEnv?.platform ?? process.platform,
    },
  );
  return {
    ok: true,
    agentCommand: argv.argv,
    cwd,
    ...(agentProcessEnv ? { agentProcessEnv } : {}),
    identity,
  };
}

function probeArgvForLaunch(
  driver: string,
  launch: ModelProbeLaunchContext["launch"],
  options: ResolveModelProbeLaunchOptions,
): { ok: true; argv: string[] } | { ok: false; message: string } {
  if (launch.agentArgv && launch.agentArgv.length > 0 && launch.agentArgv[0]) {
    return { ok: true, argv: [...launch.agentArgv] };
  }
  if (launch.rawCommand !== undefined) {
    return {
      ok: false,
      message: `agent "${driver}" uses a raw command override; the probe cannot prove argv boundaries without lossy splitting, so it stays unavailable. Start a normal session or migrate the command to argv.`,
    };
  }
  let registry: AgentCommandRegistry | null = null;
  try {
    registry = options.loadAgentRegistry?.() ?? null;
  } catch {
    registry = null;
  }
  if (registry) {
    let resolved: string | string[] | undefined;
    try {
      resolved = registry.resolve(driver);
    } catch {
      resolved = undefined;
    }
    if (Array.isArray(resolved) && resolved.length > 0 && resolved[0]) {
      return { ok: true, argv: [...resolved] };
    }
    if (typeof resolved === "string" && resolved.trim()) {
      return {
        ok: false,
        message: `agent "${driver}" resolved to a raw registry command; the probe cannot prove argv boundaries without lossy splitting, so it stays unavailable.`,
      };
    }
  }
  return {
    ok: false,
    message: `agent "${driver}" has no structured launch for the probe to reuse; start a normal session or configure an explicit command or argv.`,
  };
}
