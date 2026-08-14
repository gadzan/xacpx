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
import { hermesAcpShimArgv, hermesAcpShimCommand, isDefaultHermesCommand } from "../adapters/hermes-shim";
import { wrapAcpOutputGuardArgv } from "../adapters/acp-output-guard";
import { deriveAgentAlias, renderAgentArgvIdentity, type AgentLaunchSpec } from "./agent-launch";
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
