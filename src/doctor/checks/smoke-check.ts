import { loadConfig } from "../../config/load-config";
import { resolveAcpxCommandMetadata, type AcpxCommandMetadata } from "../../config/resolve-acpx-command";
import { resolveConfiguredAgentLaunch } from "../../config/resolve-agent-command";
import type { AgentLaunchSpec } from "../../config/agent-launch";
import type { AppConfig } from "../../config/types";
import { resolveBridgeEntryPath, resolveRuntimePaths, type RuntimePaths } from "../../main";
import { spawnAcpxBridgeClient, type ManagedBridgeClient } from "../../transport/acpx-bridge/acpx-bridge-client";
import { AcpxBridgeTransport } from "../../transport/acpx-bridge/acpx-bridge-transport";
import { AcpxCliTransport } from "../../transport/acpx-cli/acpx-cli-transport";
import type { ResolvedSession, SessionTransport } from "../../transport/types";
import type { DoctorCheckResult, DoctorRunOptions } from "../doctor-types";

const SMOKE_PROMPT = "Reply with exactly: ok";

export interface SmokeCheckOptions extends DoctorRunOptions {
  resolveRuntimePaths?: () => RuntimePaths;
  loadConfig?: (configPath: string) => Promise<AppConfig>;
  resolveAcpxCommandMetadata?: (options: { configuredCommand?: string }) => AcpxCommandMetadata;
  createTransport?: (context: { config: AppConfig; metadata: AcpxCommandMetadata }) => Promise<SessionTransport>;
  resolveBridgeEntryPath?: () => string;
  spawnAcpxBridgeClient?: (options: {
    acpxCommand?: string;
    bridgeEntryPath?: string;
    cwd?: string;
    permissionMode?: string;
    nonInteractivePermissions?: string;
  }) => Promise<ManagedBridgeClient>;
  now?: () => Date;
}

export async function checkSmoke(
  options: DoctorRunOptions = {},
  deps: Omit<SmokeCheckOptions, keyof DoctorRunOptions> = {},
): Promise<DoctorCheckResult> {
  const resolvedOptions: SmokeCheckOptions = { ...options, ...deps };
  const runtimePaths = (resolvedOptions.resolveRuntimePaths ?? resolveRuntimePaths)();

  try {
    const config = await (resolvedOptions.loadConfig ?? loadConfig)(runtimePaths.configPath);
    const agentSelection = selectAgent(config, resolvedOptions.agent);
    if (agentSelection.error) {
      return agentSelection.error;
    }

    const workspaceSelection = selectWorkspace(config, resolvedOptions.workspace);
    if (workspaceSelection.error) {
      return workspaceSelection.error;
    }

    const missingDefaults = [agentSelection.missingDefault, workspaceSelection.missingDefault].filter(
      (value): value is string => typeof value === "string",
    );
    if (missingDefaults.length > 0) {
      return {
        id: "smoke",
        label: "Smoke",
        severity: "skip",
        summary: `smoke prerequisites missing: ${missingDefaults.join(", ")}`,
        details: [
          `config path: ${runtimePaths.configPath}`,
          ...selectionDetails(agentSelection, workspaceSelection),
        ],
        suggestions: ["configure at least one agent and one workspace before running --smoke"],
      };
    }

    const agent = agentSelection.value;
    const workspace = workspaceSelection.value;
    if (!agent || !workspace) {
      return {
        id: "smoke",
        label: "Smoke",
        severity: "skip",
        summary: "smoke prerequisites missing: agent, workspace",
        details: [
          `config path: ${runtimePaths.configPath}`,
          ...selectionDetails(agentSelection, workspaceSelection),
        ],
      };
    }

    const metadata = (resolvedOptions.resolveAcpxCommandMetadata ?? resolveAcpxCommandMetadata)({
      configuredCommand: config.transport.command,
    });
    const transport = await (resolvedOptions.createTransport ?? defaultCreateTransport)({
      config,
      metadata,
      resolveBridgeEntryPath: resolvedOptions.resolveBridgeEntryPath,
      spawnAcpxBridgeClient: resolvedOptions.spawnAcpxBridgeClient,
    });

    const session = buildSession({
      config,
      agent,
      workspace,
      now: resolvedOptions.now,
    });

    try {
      await transport.ensureSession(session);
      const reply = await transport.prompt(session, SMOKE_PROMPT);
      const replyText = reply.text.trim();

      if (replyText.length === 0) {
        return {
          id: "smoke",
          label: "Smoke",
          severity: "fail",
          summary: "smoke prompt returned empty text",
          details: buildDetails({
            runtimePaths,
            metadata,
            session,
            agentReason: agentSelection.reason,
            workspaceReason: workspaceSelection.reason,
            replyText,
            verbose: resolvedOptions.verbose,
          }),
        };
      }

      return {
        id: "smoke",
        label: "Smoke",
        severity: replyText === "ok" ? "pass" : "warn",
        summary: replyText === "ok"
          ? "smoke prompt succeeded and reply received"
          : "smoke prompt succeeded with non-ideal reply",
        details: buildDetails({
          runtimePaths,
          metadata,
          session,
          agentReason: agentSelection.reason,
          workspaceReason: workspaceSelection.reason,
          replyText,
          verbose: resolvedOptions.verbose,
        }),
        metadata: {
          agent: session.agent,
          workspace: session.workspace,
          transportSession: session.transportSession,
          replyText,
        },
      };
    } finally {
      await transport.dispose?.();
    }
  } catch (error) {
    return {
      id: "smoke",
      label: "Smoke",
      severity: "fail",
      summary: "smoke transport probe failed",
      details: [`config path: ${runtimePaths.configPath}`, `error: ${formatError(error)}`],
    };
  }
}

function selectAgent(config: AppConfig, explicitAgent?: string): SelectionResult {
  if (explicitAgent) {
    if (!(explicitAgent in config.agents)) {
      return {
        reason: "explicit --agent",
        error: createSelectionFailure(`smoke agent not found: ${explicitAgent}`),
      };
    }

    return {
      value: explicitAgent,
      reason: "explicit --agent",
    };
  }

  const firstAgent = Object.keys(config.agents)[0];
  if (!firstAgent) {
    return {
      missingDefault: "agent",
      reason: "no configured agent available",
    };
  }

  return {
    value: firstAgent,
    reason: "default first configured agent",
  };
}

function selectWorkspace(config: AppConfig, explicitWorkspace?: string): SelectionResult {
  if (explicitWorkspace) {
    if (!(explicitWorkspace in config.workspaces)) {
      return {
        reason: "explicit --workspace",
        error: createSelectionFailure(`smoke workspace not found: ${explicitWorkspace}`),
      };
    }

    return {
      value: explicitWorkspace,
      reason: "explicit --workspace",
    };
  }

  const firstWorkspace = Object.keys(config.workspaces)[0];
  if (!firstWorkspace) {
    return {
      missingDefault: "workspace",
      reason: "no configured workspace available",
    };
  }

  return {
    value: firstWorkspace,
    reason: "default first configured workspace",
  };
}

function createSelectionFailure(summary: string): DoctorCheckResult {
  return {
    id: "smoke",
    label: "Smoke",
    severity: "fail",
    summary,
  };
}

function selectionDetails(agentSelection: SelectionResult, workspaceSelection: SelectionResult): string[] {
  const details: string[] = [];

  if (agentSelection.value) {
    details.push(`agent: ${agentSelection.value} (${agentSelection.reason})`);
  } else {
    details.push(`agent: unavailable (${agentSelection.reason})`);
  }

  if (workspaceSelection.value) {
    details.push(`workspace: ${workspaceSelection.value} (${workspaceSelection.reason})`);
  } else {
    details.push(`workspace: unavailable (${workspaceSelection.reason})`);
  }

  return details;
}

function buildSession(options: {
  config: AppConfig;
  agent: string;
  workspace: string;
  now?: () => Date;
}): ResolvedSession {
  const timestamp = (options.now ?? (() => new Date()))().getTime();
  const agentConfig = options.config.agents[options.agent];
  const workspaceConfig = options.config.workspaces[options.workspace];

  if (!agentConfig) {
    throw new Error(`smoke agent not found: ${options.agent}`);
  }
  if (!workspaceConfig) {
    throw new Error(`smoke workspace not found: ${options.workspace}`);
  }

  return {
    alias: "xacpx-doctor",
    agent: options.agent,
    driver: agentConfig.driver,
    settingsPolicy: agentConfig.settingsPolicy,
    // Resolve the SAME way the runtime spawn paths do, so the smoke test validates the
    // real launch spec (structured alias argv incl. pinned adapters and locally-preferred
    // native CLIs), not acpx's npx fallback.
    ...launchSpecFields(resolveConfiguredAgentLaunch(agentConfig, options.config.transport)),
    workspace: options.workspace,
    transportSession: `xacpx-doctor-${timestamp}`,
    // Match SessionService.resolve(): a configured agent model is the default for
    // every new logical session. Omitting it here made `doctor --smoke` exercise the
    // adapter default instead of the model the real relay/command path would use.
    ...(agentConfig.model ? { model: agentConfig.model } : {}),
    replyMode: options.config.channel.replyMode,
    cwd: workspaceConfig.cwd,
  };
}

function launchSpecFields(launch: AgentLaunchSpec): {
  agentCommand?: string;
  acpxAgent?: string;
  rawCommand?: string;
  agentArgv?: string[];
} {
  return {
    ...(launch.agentCommand ? { agentCommand: launch.agentCommand } : {}),
    ...(launch.acpxAgent ? { acpxAgent: launch.acpxAgent } : {}),
    ...(launch.rawCommand ? { rawCommand: launch.rawCommand } : {}),
    ...(launch.agentArgv ? { agentArgv: launch.agentArgv } : {}),
  };
}

async function defaultCreateTransport(options: {
  config: AppConfig;
  metadata: AcpxCommandMetadata;
  resolveBridgeEntryPath?: SmokeCheckOptions["resolveBridgeEntryPath"];
  spawnAcpxBridgeClient?: SmokeCheckOptions["spawnAcpxBridgeClient"];
}): Promise<SessionTransport> {
  if (options.config.transport.type === "acpx-bridge") {
    const client = await (options.spawnAcpxBridgeClient ?? spawnAcpxBridgeClient)({
      acpxCommand: options.metadata.command,
      bridgeEntryPath: (options.resolveBridgeEntryPath ?? resolveBridgeEntryPath)(),
      permissionMode: options.config.transport.permissionMode,
      nonInteractivePermissions: options.config.transport.nonInteractivePermissions,
    });
    return new AcpxBridgeTransport(client);
  }

  return new AcpxCliTransport({
    ...options.config.transport,
    command: options.metadata.command,
  });
}

function buildDetails(options: {
  runtimePaths: RuntimePaths;
  metadata: AcpxCommandMetadata;
  session: ResolvedSession;
  agentReason: string;
  workspaceReason: string;
  replyText: string;
  verbose?: boolean;
}): string[] {
  const details = [
    `config path: ${options.runtimePaths.configPath}`,
    `agent: ${options.session.agent} (${options.agentReason})`,
    `workspace: ${options.session.workspace} (${options.workspaceReason})`,
    options.session.model
      ? `model: ${options.session.model} (agent default)`
      : "model: adapter default (no agent default configured)",
    `transport session: ${options.session.transportSession}`,
    `reply: ${JSON.stringify(options.replyText)}`,
  ];

  if (options.verbose) {
    details.push(`transport type: ${options.session.agentCommand ? "agent-command" : "driver-default"}`);
    details.push(`acpx command: ${options.metadata.command}`);
    details.push(`acpx source: ${options.metadata.source}`);
    details.push(`smoke prompt: ${JSON.stringify(SMOKE_PROMPT)}`);
  }

  return details;
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

interface SelectionResult {
  value?: string;
  reason: string;
  missingDefault?: string;
  error?: DoctorCheckResult;
}
