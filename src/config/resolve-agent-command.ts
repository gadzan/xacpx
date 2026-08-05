import { dirname } from "node:path";

import { resolveLocalAgentCommand } from "./local-agent-bin";
import { MANAGED_ADAPTERS, effectiveAdapterVersion, isManagedAdapterId, resolveManagedAdapterCommand, type AdapterVersionOverrides } from "../adapters/adapter-catalog";
import { effectiveAdapterRegistry } from "../adapters/adapter-registry";
import { resolveActiveAdapterCommandSync } from "../adapters/adapter-preinstall";
import { hermesAcpShimCommand, isDefaultHermesCommand } from "../adapters/hermes-shim";
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
