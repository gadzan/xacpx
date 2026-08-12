#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { dirname, join, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { coreEnv } from "./runtime/core-env";
import { migrateCoreHome } from "./runtime/migrate-core-home";

import { ConfigStore } from "./config/config-store";
import { resolveConfigPathForCurrentEnv } from "./config/config-path";
import { loadConfig } from "./config/load-config";
import { ensureConfigExists } from "./config/ensure-config";
import { getAgentTemplate, listAgentTemplates, sameAgentConfig } from "./config/agent-templates";
import { createDaemonController } from "./daemon/create-daemon-controller";
import {
  resolveDaemonPaths,
  resolveRuntimeConsumerLockPath,
  resolveRuntimeDirFromConfigPath,
} from "./daemon/daemon-files";
import type { DaemonController } from "./daemon/daemon-controller";
import { DaemonRuntime } from "./daemon/daemon-runtime";
import type { DaemonStatus } from "./daemon/daemon-status";
import { createRuntimeConsumerLock } from "./daemon/runtime-consumer-lock";
import { initializeWindowsDaemonRuntime } from "./daemon/windows-daemon-runtime";
import type { DoctorRunOptions } from "./doctor/doctor-types";
import { runXacpxMcpServer } from "./mcp/xacpx-mcp-server";
import {
  inferExternalCoordinatorSession,
} from "./mcp/infer-coordinator-identity";
import { stableCoordinatorSession } from "./orchestration/coordinator-identity";
import { parseCoordinatorWorkspace } from "./mcp/parse-coordinator-workspace";
import { parseCoordinatorSession } from "./mcp/parse-coordinator-session";
import { parseInternalSessionToolsFlag } from "./mcp/parse-internal-session-tools";
import { parseSourceHandle } from "./mcp/parse-source-handle";
import { resolveDefaultOrchestrationEndpoint } from "./mcp/resolve-endpoint";
import { createOrchestrationTransport } from "./mcp/xacpx-mcp-transport";
import { OrchestrationClient } from "./orchestration/orchestration-client";
import { basenameForWorkspacePath, normalizeWorkspacePath, sameWorkspacePath } from "./commands/workspace-path";
import {
  allocateWorkspaceName,
  isWorkspaceNameValid,
  quoteWorkspaceNameIfNeeded,
  sanitizeWorkspaceName,
} from "./commands/workspace-name";
import { StateStore } from "./state/state-store";
import { toDisplaySessionAlias } from "./channels/channel-scope";
import { renderLaterList } from "./scheduled/scheduled-render";
import { ScheduledTaskService, normalizeId } from "./scheduled/scheduled-service";
import { maybeRunFirstUseOnboarding, type FirstRunOnboardingPlan } from "./onboarding.js";
import { handleUpdateCli, type UpdateCliDeps } from "./cli-update.js";
import { handleAdapterCli, type AdapterCliDeps } from "./adapters/adapter-cli";
import { getAdapterNpmVersion } from "./adapters/adapter-npm";
import { verifyAdapterVersion } from "./adapters/adapter-verifier";
import { listInstalledAdapterReleases, preinstallAdapter } from "./adapters/adapter-preinstall";
import { withAdapterOperationLock } from "./adapters/adapter-locks";
import { garbageCollectAdapterReleases } from "./adapters/adapter-gc";
import { OrphanRegistry } from "./transport/orphan-registry";
import { killWindowsOrphansWithConfirmation } from "./transport/manual-orphan-kill";
import type { AppConfig } from "./config/types";
import type { AppState } from "./state/types";
import { readVersion } from "./version.js";
import { handleChannelCli, type ChannelCliDeps } from "./channels/cli/channel-cli";
import { handlePluginCli, type PluginCliDeps } from "./plugins/plugin-cli";
import { createStartupWaitUi } from "./cli/startup-wait-ui";
import type { DaemonStartupWait } from "./daemon/daemon-controller";
import { setLocale, resolveLocale, getLocale, t } from "./i18n";

export interface PrepareMcpCoordinatorStartupInput {
  coordinatorSession: string;
  workspace?: string | null;
  config: Pick<AppConfig, "workspaces">;
  state: Pick<AppState, "sessions"> & {
    orchestration?: Pick<AppState["orchestration"], "externalCoordinators">;
  };
  client: {
    registerExternalCoordinator: (input: { coordinatorSession: string; workspace?: string }) => Promise<unknown>;
  };
}

export type PrepareMcpCoordinatorStartupResult =
  | { kind: "existing-session" }
  | { kind: "external-coordinator"; workspace?: string };

export async function prepareMcpCoordinatorStartup(
  input: PrepareMcpCoordinatorStartupInput,
): Promise<PrepareMcpCoordinatorStartupResult> {
  const coordinatorSession = input.coordinatorSession.trim();
  const existingSession = Object.values(input.state.sessions).find(
    (session) => stableCoordinatorSession(session.transport_session) === stableCoordinatorSession(coordinatorSession),
  );

  const workspace = input.workspace?.trim();
  if (workspace) {
    if (existingSession) {
      throw new Error(`coordinatorSession "${coordinatorSession}" conflicts with an existing logical session`);
    }
    const existingExternalCoordinator = input.state.orchestration?.externalCoordinators?.[coordinatorSession];
    if (existingExternalCoordinator?.workspace && existingExternalCoordinator.workspace !== workspace) {
      throw new Error(
        `coordinatorSession "${coordinatorSession}" is already bound to workspace "${existingExternalCoordinator.workspace}"; use a new coordinator session for workspace "${workspace}"`,
      );
    }
    if (!input.config.workspaces[workspace]) {
      if (existingExternalCoordinator?.workspace === workspace) {
        throw new Error(
          `workspace "${workspace}" is not configured for coordinatorSession "${coordinatorSession}"; restore that workspace config or use a new coordinator session for a different workspace`,
        );
      }
      throw new Error(`workspace "${workspace}" is not configured`);
    }

    await registerExternalCoordinatorOrThrow(input.client, { coordinatorSession, workspace });
    return { kind: "external-coordinator", workspace };
  }

  if (existingSession) {
    return { kind: "existing-session" };
  }

  const existingExternalCoordinator = input.state.orchestration?.externalCoordinators?.[coordinatorSession];
  if (existingExternalCoordinator) {
    if (existingExternalCoordinator.workspace && !input.config.workspaces[existingExternalCoordinator.workspace]) {
      throw new Error(
        `workspace "${existingExternalCoordinator.workspace}" is not configured for coordinatorSession "${coordinatorSession}"; restore that workspace config or use a new coordinator session for a different workspace`,
      );
    }
    await registerExternalCoordinatorOrThrow(input.client, {
      coordinatorSession,
      ...(existingExternalCoordinator.workspace ? { workspace: existingExternalCoordinator.workspace } : {}),
    });
    return {
      kind: "external-coordinator",
      ...(existingExternalCoordinator.workspace ? { workspace: existingExternalCoordinator.workspace } : {}),
    };
  }

  await registerExternalCoordinatorOrThrow(input.client, { coordinatorSession });
  return { kind: "external-coordinator" };
}

export function createMcpStdioIdentityResolver(input: {
  parsedCoordinatorSession?: string | null;
  sourceHandle?: string | null;
  workspace?: string | null;
  config: Pick<AppConfig, "workspaces">;
  state: Pick<AppState, "sessions"> & {
    orchestration?: Pick<AppState["orchestration"], "externalCoordinators">;
  };
  client: PrepareMcpCoordinatorStartupInput["client"];
  internalSessionTools?: boolean;
}): NonNullable<Parameters<typeof runXacpxMcpServer>[0]["resolveIdentity"]> {
  const instanceId = randomUUID().slice(0, 8);
  return async (context) => {
    const parsedCoordinatorSession = input.parsedCoordinatorSession?.trim() || null;
    const workspace = input.workspace?.trim() || null;
    const sourceHandle = input.sourceHandle?.trim() || null;

    const resolvedWorkspace = workspace;
    // Normalize at this ingress boundary: a coordinator launched while its
    // session carries a post-`/clear` `:reset-<ts>` suffix must present the
    // stable identity to the orchestration service, so every downstream tool
    // call (delegate, task_*, scheduled_*) shares one identity with the
    // WeChat-side handlers. External coordinators have no suffix to strip.
    const resolvedCoordinatorSession = stableCoordinatorSession(
      parsedCoordinatorSession ?? inferExternalCoordinatorSession({
        clientName: context.clientName,
        ...(resolvedWorkspace ? { workspace: resolvedWorkspace } : { instanceId }),
      }),
    );
    const startup = await prepareMcpCoordinatorStartup({
      coordinatorSession: resolvedCoordinatorSession,
      ...(resolvedWorkspace ? { workspace: resolvedWorkspace } : {}),
      config: input.config,
      state: input.state,
      client: input.client,
    });
    return {
      coordinatorSession: resolvedCoordinatorSession,
      ...(sourceHandle ? { sourceHandle } : {}),
      ...(startup.kind === "external-coordinator" ? { isExternalCoordinator: true } : {}),
      ...(input.internalSessionTools && startup.kind === "existing-session" && !sourceHandle
        ? { internalSessionTools: true }
        : {}),
    };
  };
}

async function registerExternalCoordinatorOrThrow(
  client: PrepareMcpCoordinatorStartupInput["client"],
  input: { coordinatorSession: string; workspace?: string },
): Promise<void> {
  try {
    await client.registerExternalCoordinator(input);
  } catch (error) {
    if (isUnavailableOrchestrationIpcError(error)) {
      throw new Error(
        "xacpx daemon orchestration IPC is unavailable; run `xacpx start` and check `xacpx status`",
      );
    }
    if (input.workspace && isDaemonWorkspaceNotConfiguredError(error, input.workspace)) {
      throw new Error(
        `workspace "${input.workspace}" is not configured in the running daemon; restart it with \`xacpx stop && xacpx start\``,
      );
    }
    throw error;
  }
}

function isDaemonWorkspaceNotConfiguredError(error: unknown, workspace: string): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message === `workspace "${workspace}" is not configured`;
}

function isUnavailableOrchestrationIpcError(error: unknown): boolean {
  const code = typeof error === "object" && error !== null && "code" in error
    ? String((error as NodeJS.ErrnoException).code)
    : "";
  if (code === "ENOENT" || code === "ECONNREFUSED" || code === "ECONNRESET") {
    return true;
  }
  const message = error instanceof Error ? error.message : String(error);
  return /connect (ENOENT|ECONNREFUSED|ECONNRESET)\b/.test(message);
}

interface StatusStopped {
  state: "stopped";
  stale?: boolean;
}

interface StatusRunning {
  state: "running";
  pid: number;
  status: DaemonStatus;
}

interface StartStarted {
  state: "started";
  pid: number;
}

interface StartAlreadyRunning {
  state: "already-running";
  pid: number;
}

interface StopStopped {
  state: "stopped";
  detail: "not-running" | "stopped";
}

interface CliController {
  getStatus: DaemonController["getStatus"];
  start: (options?: { firstRunOnboarding?: FirstRunOnboardingPlan; startupWait?: DaemonStartupWait }) => Promise<StartStarted | StartAlreadyRunning>;
  stop: () => Promise<StopStopped>;
}

interface CliDeps {
  login?: () => Promise<void>;
  logout?: () => Promise<void>;
  run?: (options?: { firstRunOnboarding?: FirstRunOnboardingPlan }) => Promise<void>;
  update?: (args: string[]) => Promise<number | null>;
  readVersion?: () => string;
  doctor?: (options: DoctorRunOptions) => number | Promise<number>;
  mcpStdio?: (args: string[]) => number | Promise<number>;
  controller?: CliController;
  print?: (line: string) => void;
  stderr?: (text: string) => void;
  cwd?: () => string;
  channelCliDeps?: Partial<ChannelCliDeps>;
  pluginCliDeps?: Partial<PluginCliDeps>;
  updateCliDeps?: Partial<UpdateCliDeps>;
  adapterCliDeps?: Partial<AdapterCliDeps>;
  orphansKill?: () => Promise<{ attempted: number; killed: number; retained: number }>;
  loadConfiguredPluginsForChannelCli?: () => Promise<void>;
  isInteractive?: () => boolean;
  promptText?: (message: string) => Promise<string>;
  promptSecret?: (message: string) => Promise<string>;
  isProcessRunning?: (pid: number) => boolean;
}

export function getUsageText(): string {
  return t().cli.helpLines.join("\n");
}

import { bootstrapBuiltinChannels } from "./channels/bootstrap.js";

const INFO_ONLY_COMMANDS = new Set(["version", "--version", "-v", "--help", "-h"]);

export async function runCli(args: string[], deps: CliDeps = {}): Promise<number> {
  {
    let configLanguage: string | undefined;
    try {
      const localePaths = (await import("./main")).resolveRuntimePaths();
      configLanguage = (await loadConfig(localePaths.configPath)).language;
    } catch {
      // Best-effort locale bootstrap: never let config problems break a CLI command.
      // Missing/invalid config falls back to the system locale here; the real config
      // load+validation happens later during command handling and surfaces errors there.
    }
    setLocale(resolveLocale({ configLanguage }));
  }
  bootstrapBuiltinChannels();
  const command = args[0];
  const print = deps.print ?? ((line: string) => console.log(line));

  switch (command) {
    case "version":
    case "--version":
    case "-v":
      print((deps.readVersion ?? readVersion)());
      return 0;
    case "--help":
    case "-h": {
      for (const line of t().cli.helpLines) {
        print(line);
      }
      return 0;
    }
    case "login":
      await (deps.login ?? defaultLogin)();
      return 0;
    case "logout":
      await (deps.logout ?? defaultLogout)();
      return 0;
    case "run":
      const onboarding = await runOnboardingBeforeStart({
        print,
        cwd: deps.cwd ?? (() => process.cwd()),
        isInteractive: deps.isInteractive,
        promptText: deps.promptText,
      });
      await (deps.run ?? runDefaultRuntime)({ firstRunOnboarding: onboarding ?? undefined });
      return 0;
    case "update": {
      const result = await (deps.update ?? ((subArgs) => defaultUpdate(subArgs, {
        print,
        isInteractive: deps.isInteractive,
        promptText: deps.promptText,
        overrides: {
          // Stop a running daemon before a weacpx→xacpx rename migration, so no
          // old-named daemon is left holding the channel connection.
          stopDaemon: async () => { await (deps.controller ?? createDefaultController(deps)).stop(); },
          ...deps.updateCliDeps,
        },
      })))(args.slice(1));
      if (result === null) {
        for (const line of t().cli.helpLines) print(line);
        return 1;
      }
      return result;
    }
    case "doctor": {
      const parsed = parseDoctorArgs(args.slice(1));
      if (!parsed.ok) {
        for (const line of t().cli.helpLines) {
          print(line);
        }
        return 1;
      }

      return await (deps.doctor ?? defaultDoctor)(parsed.options);
    }
    case "orphans": {
      if (args.length !== 3 || args[1] !== "kill" || args[2] !== "--confirm") {
        print("Usage: xacpx orphans kill --confirm");
        return 1;
      }
      const result = await (deps.orphansKill ?? defaultManualOrphanKill)();
      print(`orphan processes: ${result.killed}/${result.attempted} killed; ${result.retained} retained`);
      return result.retained === 0 ? 0 : 1;
    }
    case "workspace":
    case "ws": {
      const result = await handleWorkspaceCli(args.slice(1), {
        print,
        cwd: deps.cwd ?? (() => process.cwd()),
      });
      if (result === null) {
        for (const line of t().cli.helpLines) {
          print(line);
        }
        return 1;
      }
      return result;
    }
    case "agent":
    case "agents": {
      const result = await handleAgentCli(args.slice(1), { print });
      if (result === null) {
        for (const line of t().cli.helpLines) {
          print(line);
        }
        return 1;
      }
      return result;
    }
    case "adapter": {
      const result = await handleAdapterCli(args.slice(1), createAdapterCliDeps({
        print,
        overrides: deps.adapterCliDeps,
      }));
      if (result === null) {
        for (const line of t().cli.helpLines) print(line);
        return 1;
      }
      return result;
    }
    case "later":
    case "lt": {
      const result = await handleLaterCli(args.slice(1), { print });
      if (result === null) {
        for (const line of t().cli.helpLines) {
          print(line);
        }
        return 1;
      }
      return result;
    }
    case "plugin": {
      const result = await handlePluginCli(args.slice(1), await createPluginCliDeps({
        print,
        controller: deps.controller,
        isInteractive: deps.isInteractive,
        promptText: deps.promptText,
        overrides: deps.pluginCliDeps,
      }));
      if (result === null) {
        for (const line of t().cli.helpLines) {
          print(line);
        }
        return 1;
      }
      return result;
    }
    case "channel":
    case "ch": {
      await (deps.loadConfiguredPluginsForChannelCli ?? defaultLoadConfiguredPluginsForChannelCli)();
      const result = await handleChannelCli(args.slice(1), await createChannelCliDeps({
        print,
        stderr: deps.stderr,
        controller: deps.controller,
        isInteractive: deps.isInteractive,
        promptText: deps.promptText,
        promptSecret: deps.promptSecret,
        overrides: deps.channelCliDeps,
      }));
      if (result === null) {
        for (const line of t().cli.helpLines) {
          print(line);
        }
        return 1;
      }
      return result;
    }
    case "mcp-stdio":
      // mcp-stdio runs as an acpx-spawned child: prefer the parent-injected XACPX_LANG over config.
      setLocale(resolveLocale({ configLanguage: process.env.XACPX_LANG }));
      return await (deps.mcpStdio ?? ((subArgs) => defaultMcpStdio(subArgs, { stderr: deps.stderr })))(args.slice(1));
    case "start": {
      const controller = deps.controller ?? createDefaultController(deps);
      try {
        const isInteractive = deps.isInteractive ?? defaultIsInteractive;
        const status = await controller.getStatus();
        if (status.state === "running") {
          print(t().cli.alreadyRunning);
          print(`PID: ${status.pid}`);
          return 0;
        }
        if (status.state === "indeterminate") {
          throw new Error(`xacpx daemon process is already running (pid ${status.pid}) but daemon metadata is incomplete or inconsistent`);
        }
        const onboarding = await runOnboardingBeforeStart({
          print,
          cwd: deps.cwd ?? (() => process.cwd()),
          isInteractive,
          promptText: deps.promptText,
        });
        const startupWaitUi = onboarding
          ? createStartupWaitUi({ isInteractive })
          : null;
        let result: StartStarted | StartAlreadyRunning;
        try {
          result = await controller.start({
            firstRunOnboarding: onboarding ?? undefined,
            ...(startupWaitUi?.wait ? { startupWait: startupWaitUi.wait } : {}),
          });
        } finally {
          startupWaitUi?.stop();
        }
        if (result.state === "already-running") {
          print(t().cli.alreadyRunning);
          print(`PID: ${result.pid}`);
          return 0;
        }

        print(t().cli.started);
        print(`PID: ${result.pid}`);
        return 0;
      } catch (error) {
        print(t().cli.startFailed(describeFriendlyError(error)));
        printDaemonLogHints(print);
        return 1;
      }
    }
    case "status": {
      const controller = deps.controller ?? createDefaultController(deps);
      const status = await controller.getStatus();
      if (status.state === "indeterminate") {
        print(t().cli.indeterminate);
        print(`PID: ${status.pid}`);
        return 1;
      }

      if (status.state !== "running") {
        print(t().cli.notRunning);
        return 0;
      }

      print(t().cli.running);
      print(`PID: ${status.pid}`);
      print(`Started: ${status.status.started_at}`);
      print(`Heartbeat: ${status.status.heartbeat_at}`);
      print(`Config: ${status.status.config_path}`);
      print(`State: ${status.status.state_path}`);
      print(`App Log: ${status.status.app_log}`);
      print(`Stdout: ${status.status.stdout_log}`);
      print(`Stderr: ${status.status.stderr_log}`);
      return 0;
    }
    case "stop": {
      const controller = deps.controller ?? createDefaultController(deps);
      const result = await controller.stop();
      if (result.detail === "not-running") {
        print(t().cli.notRunning);
        return 0;
      }
      print(t().cli.stopped);
      return 0;
    }
    case "restart": {
      const controller = deps.controller ?? createDefaultController(deps);
      try {
        return await restartDaemonCli(controller, print);
      } catch (error) {
        print(t().cli.restartFailed(describeFriendlyError(error)));
        printDaemonLogHints(print);
        return 1;
      }
    }
    default:
      for (const line of t().cli.helpLines) {
        print(line);
      }
      return 1;
  }
}


async function defaultUpdate(
  args: string[],
  input: {
    print: (line: string) => void;
    isInteractive?: () => boolean;
    promptText?: (message: string) => Promise<string>;
    overrides?: Partial<UpdateCliDeps>;
  },
): Promise<number | null> {
  const store = await createCliConfigStore();
  const deps: UpdateCliDeps = {
    loadConfig: async () => await store.load(),
    savePlugins: async (plugins) => {
      await store.replacePlugins(plugins);
    },
    readCurrentVersion: readVersion,
    print: input.print,
    isInteractive: input.isInteractive ?? defaultIsInteractive,
    promptText: input.promptText ?? defaultPromptText,
    ...input.overrides,
  };
  return await handleUpdateCli(args, deps);
}

/**
 * Non-daemon CLI paths have no AppLogger; surface state.json load repairs on
 * stderr so a quarantine never happens silently. The daemon path logs the same
 * report through the app logger in buildApp.
 */
function warnStateLoadReport(
  store: StateStore,
  writeStderr: (text: string) => void = (text) => process.stderr.write(text),
): void {
  const report = store.lastLoadReport;
  if (!report) return;
  for (const record of report.dropped) {
    writeStderr(
      `[xacpx] state.record_quarantined section=${record.section}${record.key ? ` key=${record.key}` : ""} reason=${record.reason}\n`,
    );
  }
  if (report.corruptPath) {
    writeStderr(`[xacpx] state.file_corrupt unreadable state.json renamed to ${report.corruptPath}\n`);
  }
  if (report.quarantinePath) {
    writeStderr(`[xacpx] state.file_quarantined original state.json backed up to ${report.quarantinePath}\n`);
  }
  if (report.backupError) {
    writeStderr(`[xacpx] state.quarantine_backup_failed ${report.backupError}\n`);
  }
  for (const record of report.migrated ?? []) {
    writeStderr(
      `[xacpx] state.session_id_migrated section=${record.section}${record.key ? ` key=${record.key}` : ""} reason=${record.reason}\n`,
    );
  }
}

async function runOnboardingBeforeStart(input: {
  print: (line: string) => void;
  cwd: () => string;
  isInteractive?: () => boolean;
  promptText?: (message: string) => Promise<string>;
}): Promise<FirstRunOnboardingPlan | null> {
  const runtimePaths = (await import("./main")).resolveRuntimePaths();
  await ensureConfigExists(runtimePaths.configPath);
  const configStore = new ConfigStore(runtimePaths.configPath);
  const stateStore = new StateStore(runtimePaths.statePath);
  const config = await configStore.load();
  const state = await stateStore.load();
  warnStateLoadReport(stateStore);
  const result = await maybeRunFirstUseOnboarding({
    config,
    state,
    saveFirstRunConfig: async ({ workspace, agent }) => {
      await configStore.upsertWorkspace(workspace.name, workspace.cwd);
      await configStore.upsertAgent(agent.name, agent.config);
    },
    deps: {
      print: input.print,
      cwd: input.cwd,
      isInteractive: input.isInteractive ?? defaultIsInteractive,
      promptText: input.promptText ?? defaultPromptText,
    },
  });
  return result.created
    ? {
        alias: result.alias,
        agent: result.agent,
        workspace: result.workspace,
        rollback: result.rollback,
      }
    : null;
}

async function handleWorkspaceCli(
  args: string[],
  deps: {
    print: (line: string) => void;
    cwd: () => string;
  },
): Promise<number | null> {
  const subcommand = args[0];
  switch (subcommand) {
    case "list":
      if (args.length !== 1) return null;
      return await workspaceList(deps.print);
    case "add": {
      const rest = args.slice(1);
      let rawFlag = false;
      let explicit: string | undefined;
      for (const token of rest) {
        if (token === "--raw") {
          if (rawFlag) return null;
          rawFlag = true;
          continue;
        }
        if (explicit !== undefined) return null;
        explicit = token;
      }
      return await workspaceAdd(explicit, { ...deps, raw: rawFlag });
    }
    case "rm":
      if (args.length !== 2 || !args[1]) return null;
      return await workspaceRemove(args[1], deps.print);
    default:
      return null;
  }
}

async function workspaceList(print: (line: string) => void): Promise<number> {
  const store = await createCliConfigStore();
  const config = await store.load();
  const entries = Object.entries(config.workspaces);

  if (entries.length === 0) {
    print(t().cli.workspaceEmpty);
    return 0;
  }

  print(t().cli.workspaceListHeader);
  for (const [name, workspace] of entries) {
    print(`- ${name}: ${workspace.cwd}`);
  }
  return 0;
}

async function workspaceAdd(
  rawName: string | undefined,
  deps: {
    print: (line: string) => void;
    cwd: () => string;
    raw: boolean;
  },
): Promise<number> {
  const cwd = normalizeWorkspacePath(deps.cwd());
  const input = rawName === undefined ? basenameForWorkspacePath(cwd) : rawName.trim();
  if (input.length === 0) {
    deps.print(t().cli.workspaceNameEmpty);
    return 1;
  }

  const store = await createCliConfigStore();
  const config = await store.load();

  let name = input;
  if (!deps.raw && !isWorkspaceNameValid(input)) {
    const base = sanitizeWorkspaceName(input);
    name = allocateWorkspaceName(base, config.workspaces);
    const sourceLabel = rawName === undefined ? t().cli.workspaceSourceLabelDir : t().cli.workspaceSourceLabelName;
    deps.print(t().cli.workspaceNameSanitized(sourceLabel, input, name));
  }

  const existing = config.workspaces[name];
  if (existing) {
    if (sameWorkspacePath(existing.cwd, cwd)) {
      deps.print(t().cli.workspaceAlreadyExists(name, existing.cwd));
      return 0;
    }

    deps.print(t().cli.workspaceConflictPath(name, existing.cwd));
    deps.print(t().cli.workspaceConflictHint(quoteWorkspaceNameIfNeeded(name)));
    return 1;
  }

  await store.upsertWorkspace(name, cwd);
  deps.print(t().cli.workspaceSaved(name, cwd));
  return 0;
}

async function workspaceRemove(rawName: string, print: (line: string) => void): Promise<number> {
  const name = rawName.trim();
  if (name.length === 0) {
    print(t().cli.workspaceNameEmpty);
    return 1;
  }

  const store = await createCliConfigStore();
  const config = await store.load();
  if (!config.workspaces[name]) {
    print(t().cli.workspaceNotFound(name));
    return 1;
  }

  await store.removeWorkspace(name);
  print(t().cli.workspaceRemoved(name));
  return 0;
}

async function handleAgentCli(
  args: string[],
  deps: {
    print: (line: string) => void;
  },
): Promise<number | null> {
  const subcommand = args[0];
  switch (subcommand) {
    case "list":
      if (args.length !== 1) return null;
      return await agentList(deps.print);
    case "templates":
      if (args.length !== 1) return null;
      return agentTemplates(deps.print);
    case "add":
      if (args.length !== 2 || !args[1]) return null;
      return await agentAdd(args[1], deps.print);
    case "rm":
      if (args.length !== 2 || !args[1]) return null;
      return await agentRemove(args[1], deps.print);
    default:
      return null;
  }
}

async function agentList(print: (line: string) => void): Promise<number> {
  const store = await createCliConfigStore();
  const config = await store.load();
  const entries = Object.entries(config.agents);

  if (entries.length === 0) {
    print(t().cli.agentEmpty);
    return 0;
  }

  print(t().cli.agentListHeader);
  for (const [name, agent] of entries) {
    const command = agent.command ? ` command=${agent.command}` : "";
    print(`- ${name}: driver=${agent.driver}${command}`);
  }
  return 0;
}

function agentTemplates(print: (line: string) => void): number {
  print(t().cli.agentTemplatesHeader);
  for (const name of listAgentTemplates()) {
    print(`- ${name}`);
  }
  return 0;
}

async function agentAdd(rawName: string, print: (line: string) => void): Promise<number> {
  const name = rawName.trim();
  if (name.length === 0) {
    print(t().cli.agentNameEmpty);
    return 1;
  }

  const template = getAgentTemplate(name);
  if (!template) {
    print(t().cli.agentUnsupportedTemplate(listAgentTemplates()));
    return 1;
  }

  const store = await createCliConfigStore();
  const config = await store.load();
  const existing = config.agents[name];
  if (existing) {
    if (sameAgentConfig(existing, template)) {
      print(t().cli.agentAlreadyExists(name));
      return 0;
    }
    print(t().cli.agentAlreadyExistsDifferent(name));
    return 1;
  }
  await store.upsertAgent(name, template);
  print(t().cli.agentSaved(name));
  return 0;
}

async function agentRemove(rawName: string, print: (line: string) => void): Promise<number> {
  const name = rawName.trim();
  if (name.length === 0) {
    print(t().cli.agentNameEmpty);
    return 1;
  }

  const store = await createCliConfigStore();
  const config = await store.load();
  if (!config.agents[name]) {
    print(t().cli.agentNotFound(name));
    return 1;
  }

  await store.removeAgent(name);
  print(t().cli.agentRemoved(name));
  return 0;
}

async function handleLaterCli(
  args: string[],
  deps: {
    print: (line: string) => void;
  },
): Promise<number | null> {
  const subcommand = args[0];
  switch (subcommand) {
    case "list":
      if (args.length !== 1) return null;
      return await laterList(deps.print);
    case "cancel":
      if (args.length !== 2 || !args[1]) return null;
      return await laterCancel(args[1], deps.print);
    default:
      return null;
  }
}

async function laterList(print: (line: string) => void): Promise<number> {
  const scheduled = await createCliScheduledTaskService();
  // Local operator surface: the machine owner sees tasks from every chat.
  print(renderLaterList(scheduled.listPendingAllChats(), (alias) => toDisplaySessionAlias(alias)));
  return 0;
}

async function laterCancel(rawId: string, print: (line: string) => void): Promise<number> {
  const id = normalizeId(rawId);
  if (id.length === 0) {
    print(t().cli.laterIdEmpty);
    return 1;
  }

  const scheduled = await createCliScheduledTaskService();
  // Local operator surface: the machine owner may cancel any chat's task.
  const ok = await scheduled.cancelPendingAnyChat(id);
  if (!ok) {
    print(t().cli.laterNotFound(id));
    print(t().cli.laterNotFoundHint);
    return 1;
  }
  print(t().cli.laterCancelled(id));
  return 0;
}

async function createCliScheduledTaskService(): Promise<ScheduledTaskService> {
  // Keep `main` lazy-loaded like the other daemon/runtime CLI paths. Importing
  // it eagerly pulls in transport/channel wiring that simple commands such as
  // `xacpx --help`, `agent`, and `workspace` should not pay for.
  const runtimePaths = (await import("./main")).resolveRuntimePaths();
  const stateStore = new StateStore(runtimePaths.statePath);
  const state = await stateStore.load();
  warnStateLoadReport(stateStore);
  return new ScheduledTaskService(state, stateStore);
}

function resolveDaemonPathsForCurrentConfig() {
  const configPath = resolveConfigPathForCurrentEnv();
  return resolveDaemonPaths({
    home: requireHome(),
    runtimeDir: resolveRuntimeDirFromConfigPath(configPath),
  });
}

async function createCliConfigStore(): Promise<ConfigStore> {
  const configPath = resolveConfigPathForCurrentEnv();
  await ensureConfigExists(configPath);
  return new ConfigStore(configPath);
}

function createAdapterCliDeps(input: {
  print: (line: string) => void;
  overrides?: Partial<AdapterCliDeps>;
}): AdapterCliDeps {
  let storePromise: Promise<ConfigStore> | undefined;
  const getStore = (): Promise<ConfigStore> => storePromise ??= createCliConfigStore();
  const defaults: AdapterCliDeps = {
    loadVersions: async () => (await (await getStore()).load()).transport.adapterVersions ?? {},
    saveVersions: async (versions) => { await (await getStore()).replaceAdapterVersions(versions); },
    loadRegistry: async () => (await (await getStore()).load()).transport.adapterRegistry,
    saveRegistry: async (registry) => { await (await getStore()).updateTransport({ adapterRegistry: registry }); },
    getLatestVersion: async (id, registry) => await getAdapterNpmVersion(id, undefined, registry),
    versionExists: async (id, version, registry) =>
      await getAdapterNpmVersion(id, version, registry) === version,
    verifyVersion: verifyAdapterVersion,
    preinstall: async (id, version, registry) => {
      const runtimeRoot = dirname(resolveConfigPathForCurrentEnv());
      return await withAdapterOperationLock({ id, runtimeRoot }, async () => {
        const result = await preinstallAdapter({ runtimeRoot, id, version, registry });
        return { releaseId: result.manifest.releaseId };
      });
    },
    listInstalled: async () => await listInstalledAdapterReleases(dirname(resolveConfigPathForCurrentEnv())),
    uninstall: async (id, releaseId) => {
      const runtimeRoot = dirname(resolveConfigPathForCurrentEnv());
      let orphanRegistry: OrphanRegistry | undefined;
      if (process.platform === "win32") {
        orphanRegistry = new OrphanRegistry(join(runtimeRoot, "runtime"));
        await orphanRegistry.initialize();
      }
      const [result] = await garbageCollectAdapterReleases({
        runtimeRoot,
        id,
        releaseId,
        statePath: coreEnv("STATE") ?? join(runtimeRoot, "state.json"),
        ...(orphanRegistry ? { orphanRegistry } : {}),
      });
      return result!.disposition;
    },
    print: input.print,
  };
  return { ...defaults, ...input.overrides, print: input.overrides?.print ?? input.print };
}

export async function resolveLoginChannelForCli(): Promise<ReturnType<typeof createMessageChannel>> {
  const { createMessageChannel } = await import("./channels/create-channel.js");
  return createMessageChannel("weixin");
}

async function defaultLogin(): Promise<void> {
  const channel = await resolveLoginChannelForCli();
  await channel.login();
}

async function defaultLogout(): Promise<void> {
  const channel = await resolveLoginChannelForCli();
  await channel.logout();
}

async function defaultLoadConfiguredPluginsForChannelCli(): Promise<void> {
  const store = await createCliConfigStore();
  const config = await store.load();
  const { loadConfiguredPlugins } = await import("./plugins/plugin-loader.js");
  await loadConfiguredPlugins({ plugins: config.plugins });
}

const DAEMON_RUN_ENV_SUFFIX = "DAEMON_RUN";

export async function runDefaultRuntime(options: { firstRunOnboarding?: FirstRunOnboardingPlan } = {}): Promise<void> {
  const [{ buildApp, resolveRuntimePaths, prepareChannelMedia }, { runConsole }] = await Promise.all([
    import("./main"),
    import("./run-console"),
  ]);
  const runtimePaths = resolveRuntimePaths();
  await ensureConfigExists(runtimePaths.configPath);
  const config = await loadConfig(runtimePaths.configPath);
  const { loadConfiguredPlugins } = await import("./plugins/plugin-loader.js");
  await loadConfiguredPlugins({
    plugins: config.plugins,
    onPluginError: ({ name, error }) => {
      console.error(
        `[xacpx] skipping plugin ${name}: ${error instanceof Error ? error.message : String(error)}`,
      );
    },
  });
  const { createMessageChannels } = await import("./channels/create-channel.js");
  const { MessageChannelRegistry } = await import("./channels/channel-registry.js");
  const daemonPaths = resolveDaemonPathsForCurrentConfig();
  const daemonRuntime = new DaemonRuntime(daemonPaths, { pid: process.pid });
  const isDaemonRun = coreEnv(DAEMON_RUN_ENV_SUFFIX) === "1";
  if (!isDaemonRun) {
    const current = await createDefaultController().getStatus();
    if (current.state === "running" || current.state === "indeterminate") {
      throw new Error(
        `xacpx daemon process is already running (pid ${current.pid}); stop it before starting a foreground runtime`,
      );
    }
  }
  const windowsDaemonRuntime = isDaemonRun
    ? await initializeWindowsDaemonRuntime({
        configPath: runtimePaths.configPath,
        runtimeDir: daemonPaths.runtimeDir,
      })
    : {};
  const { publishGeneration, ...windowsDaemonRuntimeDeps } = windowsDaemonRuntime;
  let ownsRuntime = false;
  const { channelDeps } = await prepareChannelMedia(runtimePaths.configPath, config);
  const channelRegistry = new MessageChannelRegistry(createMessageChannels(config.channels, channelDeps));
  const lockCreators = channelRegistry.createConsumerLocks();
  const firstLockCreator = lockCreators[0];

  const firstRunOnboarding = options.firstRunOnboarding ?? decodeFirstRunOnboarding(coreEnv("FIRST_RUN_ONBOARDING"));
  await runConsole(runtimePaths, {
    buildApp: (paths) =>
      buildApp(paths, {
        defaultLoggingLevel: resolveCliEntryPath().includes(`${sep}src${sep}`) ? "debug" : "info",
        channel: channelRegistry,
        canReapQueueOwners: () => ownsRuntime,
        ...windowsDaemonRuntimeDeps,
      }),
    afterConsumerLockAcquired: async () => {
      await publishGeneration?.();
      ownsRuntime = true;
    },
    beforeReady: firstRunOnboarding
      ? async (runtime) => {
          await createFirstRunSession(runtime, firstRunOnboarding);
        }
      : undefined,
    channels: channelRegistry,
    channelStartupPolicy: isDaemonRun ? "best-effort" : "require-one",
    ...(isDaemonRun ? { daemonRuntime } : {}),
    consumerLockFactory: (runtime) => createRuntimeConsumerLock({
      lockFilePath: resolveRuntimeConsumerLockPath(daemonPaths.runtimeDir),
      ...(firstLockCreator
        ? { channelLock: firstLockCreator.create({
            lockFilePath: `${daemonPaths.runtimeDir}${sep}${firstLockCreator.channel.id}-consumer.lock.json`,
            onDiagnostic: async (event, context) => {
              await runtime.logger.info(`${firstLockCreator.channel.id}.consumer_lock.${event}`, `${firstLockCreator.channel.id} consumer lock diagnostic`, context);
            },
          }) }
        : {}),
      onDiagnostic: async (event, context) => {
        await runtime.logger.info(`runtime.consumer_lock.${event}`, "runtime ownership lock diagnostic", context);
      },
    }),
  });
}

async function createFirstRunSession(
  runtime: Awaited<ReturnType<typeof import("./main").buildApp>>,
  plan: FirstRunOnboardingPlan,
): Promise<void> {
  const session = runtime.sessions.resolveSession(plan.alias, plan.agent, plan.workspace, plan.alias);
  try {
    await runtime.transport.ensureSession(session);
    const exists = await runtime.transport.hasSession(session);
    if (!exists) {
      throw new Error(`first-run onboarding failed to create transport session: ${plan.alias}`);
    }
    await runtime.sessions.attachSession(
      plan.alias,
      plan.agent,
      plan.workspace,
      session.transportSession,
      session.agentCommand,
      session.acpxAgent,
      session.agentArgv,
    );
  } catch (error) {
    await rollbackFirstRunConfig(runtime, plan);
    throw error;
  }
  await runtime.logger.info("onboarding.session_created", "created first-run transport session", {
    alias: plan.alias,
    agent: plan.agent,
    workspace: plan.workspace,
  });
}

async function rollbackFirstRunConfig(
  runtime: Awaited<ReturnType<typeof import("./main").buildApp>>,
  plan: FirstRunOnboardingPlan,
): Promise<void> {
  try {
    if (!plan.rollback.workspaceExisted) {
      await runtime.configStore.removeWorkspace(plan.workspace);
    }
    if (!plan.rollback.agentExisted) {
      await runtime.configStore.removeAgent(plan.agent);
    }
  } catch (error) {
    await runtime.logger.error("onboarding.rollback_failed", "failed to roll back first-run config", {
      alias: plan.alias,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

async function defaultDoctor(options: DoctorRunOptions): Promise<number> {
  const { main } = await import("./doctor/index");
  return await main(options);
}

async function defaultManualOrphanKill() {
  const configPath = resolveConfigPathForCurrentEnv();
  return await killWindowsOrphansWithConfirmation({
    runtimeDir: resolveRuntimeDirFromConfigPath(configPath),
    confirmed: true,
  });
}

async function defaultMcpStdio(
  args: string[],
  deps: { stderr?: (text: string) => void } = {},
): Promise<number> {
  let coordinatorSession: string;
  let sourceHandle: string | null;
  let endpoint: ReturnType<typeof resolveDefaultOrchestrationEndpoint>;
  let transport!: ReturnType<typeof createOrchestrationTransport>;
  let identityResolver: Parameters<typeof runXacpxMcpServer>[0]["resolveIdentity"] | undefined;
  let availableAgents: string[] | undefined;
  let internalSessionTools = false;
  try {
    const parsedCoordinatorSession = parseCoordinatorSession(args, process.env);
    sourceHandle = parseSourceHandle(args, process.env);
    const workspace = parseCoordinatorWorkspace(args, process.env);
    const requestedInternalSessionTools = parseInternalSessionToolsFlag(args, process.env);
    endpoint = resolveDefaultOrchestrationEndpoint(process.env, process.platform);
    const client = new OrchestrationClient(endpoint);
    transport = createOrchestrationTransport(endpoint, { client });
    const runtimePaths = (await import("./main")).resolveRuntimePaths();
    await ensureConfigExists(runtimePaths.configPath);
    const config = await loadConfig(runtimePaths.configPath);
    availableAgents = Object.keys(config.agents);
    const stateStore = new StateStore(runtimePaths.statePath);
    const state = await stateStore.load();
    warnStateLoadReport(stateStore, deps.stderr ?? ((text: string) => process.stderr.write(text)));
    const resolveIdentity = createMcpStdioIdentityResolver({
      parsedCoordinatorSession,
      sourceHandle,
      workspace,
      config,
      state,
      client,
      internalSessionTools: requestedInternalSessionTools,
    });
    const eagerIdentity = parsedCoordinatorSession
      ? await resolveIdentity({ clientName: undefined, listRoots: async () => [] })
      : null;
    coordinatorSession = eagerIdentity?.coordinatorSession ?? "";
    internalSessionTools = eagerIdentity?.internalSessionTools ?? false;
    identityResolver = eagerIdentity ? undefined : resolveIdentity;
  } catch (error) {
    (deps.stderr ?? ((text: string) => process.stderr.write(text)))(
      `${error instanceof Error ? error.message : String(error)}\n`,
    );
    return 2;
  }

  await runXacpxMcpServer({
    transport,
    ...(coordinatorSession ? { coordinatorSession } : {}),
    ...(sourceHandle ? { sourceHandle } : {}),
    ...(internalSessionTools ? { internalSessionTools: true } : {}),
    ...(identityResolver ? { resolveIdentity: identityResolver } : {}),
    ...(availableAgents ? { availableAgents } : {}),
    onDiagnostic: (event, context) => {
      const suffix = context && Object.keys(context).length > 0 ? ` ${JSON.stringify(context)}` : "";
      (deps.stderr ?? ((text: string) => process.stderr.write(text)))(`[xacpx:mcp] ${event}${suffix}\n`);
    },
  });
  return 0;
}

function isUnknownCoordinatorRequiresWorkspaceError(error: unknown, coordinatorSession: string): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message === `unknown coordinator session "${coordinatorSession}" requires --workspace <name>`;
}

export async function restartDaemonCli(
  controller: CliController,
  print: (line: string) => void,
): Promise<number> {
  const status = await controller.getStatus();
  if (status.state === "indeterminate") {
    if (status.reason !== "missing-pid") {
      print(t().cli.restartIndeterminate);
      print(`PID: ${status.pid}`);
      print(t().cli.restartIndeterminateHint);
      return 1;
    }
    print(t().cli.restarting);
    await controller.stop();
    print(t().cli.stopped);
  } else if (status.state === "running") {
    print(t().cli.restarting);
    await controller.stop();
    print(t().cli.stopped);
  } else {
    print(t().cli.restartNotRunning);
  }

  const started = await controller.start();
  if (started.state === "already-running") {
    print(t().cli.alreadyRunning);
    print(`PID: ${started.pid}`);
    return 0;
  }

  print(t().cli.started);
  print(`PID: ${started.pid}`);
  return 0;
}

async function createChannelCliDeps(input: {
  print: (line: string) => void;
  stderr?: (text: string) => void;
  controller?: CliController;
  isInteractive?: () => boolean;
  promptText?: (message: string) => Promise<string>;
  promptSecret?: (message: string) => Promise<string>;
  overrides?: Partial<ChannelCliDeps>;
}): Promise<ChannelCliDeps> {
  const store = await createCliConfigStore();
  const controller = input.controller ?? createDefaultController();
  const base: ChannelCliDeps = {
    loadConfig: async () => await store.load(),
    saveChannels: async (channels) => {
      await store.replaceChannels(channels);
    },
    print: input.print,
    stderr: input.stderr ?? ((text: string) => process.stderr.write(text)),
    isInteractive: input.isInteractive ?? defaultIsInteractive,
    promptText: input.promptText ?? defaultPromptText,
    promptSecret: input.promptSecret ?? defaultPromptSecret,
    getDaemonStatus: async () => {
      const status = await controller.getStatus();
      if (status.state === "running") return { state: "running" as const, pid: status.pid };
      if (status.state === "indeterminate") return { state: "indeterminate" as const, pid: status.pid, reason: status.reason };
      return { state: "stopped" as const };
    },
    restartDaemon: async () => await restartDaemonCli(controller, input.print),
    clearChannelCredentials: async (channel) => {
      // Reuse the runtime's declared destructive-removal hook so credential
      // cleanup stays owned by each channel/plugin (relay clears its instance
      // credential; weixin clears its login). Plugins are already loaded for the
      // channel CLI path, so the factory resolves.
      const { createMessageChannel } = await import("./channels/create-channel.js");
      await createMessageChannel(channel.type, channel).logout();
    },
    retireChannel: async (channel, _reason) => {
      // Relay: one-shot terminal retirement using the original channel options
      // (even when the surviving config will disable terminal). Other channels
      // are a no-op. Credential clear stays in clearChannelCredentials / logout.
      if (channel.type !== "relay") return;
      const {
        retireRelayTerminals,
        defaultTerminalRegistryDir,
        parseRelayChannelConfig,
      } = await import("@ganglion/xacpx-channel-relay");
      const parsed = parseRelayChannelConfig(
        (channel.options ?? {}) as Record<string, unknown>,
      );
      const result = await retireRelayTerminals({
        registryDir: defaultTerminalRegistryDir(),
        terminalConfig: parsed.terminal,
      });
      if (result.status === "cleanup-pending") {
        input.print(
          `relay terminal cleanup is still pending under ${defaultTerminalRegistryDir()}; registry/owner identity was kept for retry`,
        );
      }
    },
  };
  return { ...base, ...input.overrides };
}

async function createPluginCliDeps(input: {
  print: (line: string) => void;
  controller?: CliController;
  isInteractive?: () => boolean;
  promptText?: (message: string) => Promise<string>;
  overrides?: Partial<PluginCliDeps>;
}): Promise<PluginCliDeps> {
  const store = await createCliConfigStore();
  const controller = input.controller ?? createDefaultController();
  const base: PluginCliDeps = {
    loadConfig: async () => await store.load(),
    savePlugins: async (plugins) => {
      await store.replacePlugins(plugins);
    },
    print: input.print,
    isInteractive: input.isInteractive ?? defaultIsInteractive,
    promptText: input.promptText ?? defaultPromptText,
    getDaemonStatus: async () => {
      const status = await controller.getStatus();
      if (status.state === "running") return { state: "running" as const, pid: status.pid };
      if (status.state === "indeterminate") return { state: "indeterminate" as const, pid: status.pid, reason: status.reason };
      return { state: "stopped" as const };
    },
    restartDaemon: async () => await restartDaemonCli(controller, input.print),
  };
  return { ...base, ...input.overrides };
}

async function defaultPromptText(message: string): Promise<string> {
  const readline = await import("node:readline/promises");
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    return await rl.question(message);
  } finally {
    rl.close();
  }
}

async function defaultPromptSecret(message: string): Promise<string> {
  if (!process.stdin.isTTY || !process.stdout.isTTY || typeof process.stdin.setRawMode !== "function") {
    return await defaultPromptText(message);
  }

  process.stdout.write(message);
  process.stdin.setRawMode(true);
  process.stdin.resume();

  return await new Promise<string>((resolve, reject) => {
    const chunks: string[] = [];
    let inEscape = false;
    const cleanup = () => {
      process.stdin.off("data", onData);
      process.stdin.setRawMode(false);
      process.stdin.pause();
      process.stdout.write("\n");
    };
    const onData = (buffer: Buffer) => {
      const text = buffer.toString("utf8");
      for (const char of text) {
        if (inEscape) {
          if ((char >= "a" && char <= "z") || (char >= "A" && char <= "Z") || char === "~") {
            inEscape = false;
          }
          continue;
        }
        if (char === "\u001b") {
          inEscape = true;
          continue;
        }
        if (char === "\u0003") {
          cleanup();
          reject(new Error("secret input cancelled"));
          return;
        }
        if (char === "\r" || char === "\n") {
          cleanup();
          resolve(chunks.join(""));
          return;
        }
        if (char === "\u007f" || char === "\b") {
          chunks.pop();
          continue;
        }
        chunks.push(char);
      }
    };
    process.stdin.on("data", onData);
  });
}

function createDefaultController(deps: Pick<CliDeps, "isProcessRunning"> = {}): CliController {
  const daemonPaths = resolveDaemonPathsForCurrentConfig();
  const controller = createDaemonController(daemonPaths, {
    processExecPath: process.execPath,
    cliEntryPath: resolveCliEntryPath(),
    cwd: process.cwd(),
    env: { ...process.env, XACPX_LANG: getLocale() },
    ...(deps.isProcessRunning ? { isProcessRunning: deps.isProcessRunning } : {}),
  });
  return {
    getStatus: () => controller.getStatus(),
    stop: () => controller.stop(),
    start: (options) => controller.start({
      ...(options?.firstRunOnboarding ? { firstRunOnboarding: encodeFirstRunOnboarding(options.firstRunOnboarding) } : {}),
      ...(options?.startupWait ? { startupWait: options.startupWait } : {}),
    }),
  };
}

function encodeFirstRunOnboarding(plan: FirstRunOnboardingPlan): string {
  return Buffer.from(JSON.stringify(plan), "utf8").toString("base64url");
}

function decodeFirstRunOnboarding(raw: string | undefined): FirstRunOnboardingPlan | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(Buffer.from(raw, "base64url").toString("utf8")) as Partial<FirstRunOnboardingPlan>;
    if (typeof parsed.alias === "string" && typeof parsed.agent === "string" && typeof parsed.workspace === "string") {
      const rollback = typeof parsed.rollback === "object" && parsed.rollback !== null
        ? parsed.rollback as Partial<FirstRunOnboardingPlan["rollback"]>
        : {};
      return {
        alias: parsed.alias,
        agent: parsed.agent,
        workspace: parsed.workspace,
        rollback: {
          workspaceExisted: rollback.workspaceExisted === true,
          agentExisted: rollback.agentExisted === true,
        },
      };
    }
  } catch {}
  return null;
}

function requireHome(): string {
  const home = process.env.HOME ?? homedir();
  if (!home) {
    throw new Error("Unable to resolve the current user home directory");
  }
  return home;
}

function defaultIsInteractive(): boolean {
  return Boolean(process.stdin.isTTY && process.stdout.isTTY);
}

function describeFriendlyError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function printDaemonLogHints(print: (line: string) => void): void {
  const paths = safeDaemonLogPaths();
  if (!paths) return;
  print(t().cli.checkAppLog(paths.appLog));
  print(t().cli.checkStderrLog(paths.stderrLog));
}

function safeDaemonLogPaths(): { appLog: string; stderrLog: string } | null {
  try {
    const configPath = resolveConfigPathForCurrentEnv();
    const paths = resolveDaemonPathsForCurrentConfig();
    return {
      appLog: join(dirname(configPath), "runtime", "app.log"),
      stderrLog: paths.stderrLog,
    };
  } catch {
    return null;
  }
}

function resolveCliEntryPath(): string {
  if (process.argv[1]) {
    return process.argv[1];
  }

  return fileURLToPath(import.meta.url);
}

function parseDoctorArgs(args: string[]): { ok: true; options: DoctorRunOptions } | { ok: false } {
  const options: DoctorRunOptions = {};

  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    switch (arg) {
      case "--verbose":
        options.verbose = true;
        break;
      case "--smoke":
        options.smoke = true;
        break;
      case "--fix":
        options.fix = true;
        break;
      case "--agent": {
        const value = args[index + 1];
        if (!value || value.startsWith("--")) {
          return { ok: false };
        }
        options.agent = value;
        index++;
        break;
      }
      case "--workspace": {
        const value = args[index + 1];
        if (!value || value.startsWith("--")) {
          return { ok: false };
        }
        options.workspace = value;
        index++;
        break;
      }
      default:
        return { ok: false };
    }
  }

  return { ok: true, options };
}

if (import.meta.main) {
  // One-time ~/.weacpx → ~/.xacpx state-directory migration (weacpx→xacpx
  // rename). Runs only in the real CLI process — before runCli resolves any
  // state paths — and is idempotent. Skipped for pure-info commands.
  const entryCommand = process.argv[2];
  if (entryCommand !== undefined && !INFO_ONLY_COMMANDS.has(entryCommand)) {
    migrateCoreHome(requireHome());
  }
  process.exitCode = await runCli(process.argv.slice(2));
}
