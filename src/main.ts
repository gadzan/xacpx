import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { coreHomeDir } from "./runtime/core-home";
import { coreEnv } from "./runtime/core-env";

import { CommandRouter } from "./commands/command-router";
import { ConfigStore } from "./config/config-store";
import { ensureConfigExists } from "./config/ensure-config";
import { loadConfig } from "./config/load-config";
import { resolveAcpxCommand } from "./config/resolve-acpx-command";
import { resolveConfiguredAgentLaunch } from "./config/resolve-agent-command";
import { ConsoleAgent } from "./console-agent";
import type { AppConfig, LoggingLevel } from "./config/types";
import { terminalEnabled, terminalIdleTimeoutSeconds, terminalShell, filesWriteEnabled, turnIdleTimeoutSeconds } from "./config/types";
import { createAppLogger, type AppLogger } from "./logging/app-logger";
import { resolveDaemonOrchestrationSocketPath, resolveRuntimeDirFromConfigPath } from "./daemon/daemon-files";
import type { OrchestrationTaskRecord } from "./orchestration/orchestration-types";
import { createOrchestrationEndpoint, resolveOrchestrationEndpoint } from "./orchestration/orchestration-ipc";
import { AsyncMutex } from "./orchestration/async-mutex";
import { OrchestrationServer } from "./orchestration/orchestration-server";
import { OrchestrationService } from "./orchestration/orchestration-service";
import { buildCoordinatorPrompt } from "./orchestration/build-coordinator-prompt";
import { sameCoordinatorSession } from "./orchestration/coordinator-identity";
import { buildWorkerAnswerPrompt, buildWorkerTaskPrompt } from "./orchestration/worker-prompts";
import { ScheduledTaskScheduler } from "./scheduled/scheduled-scheduler";
import { ScheduledTaskService } from "./scheduled/scheduled-service";
import { buildScheduledDispatchTask } from "./scheduled/scheduled-dispatch";
import { createScheduledTaskFromRoute } from "./scheduled/scheduled-route-create";
import { cancelScheduledTaskFromRoute, listScheduledTasksFromRoute } from "./scheduled/scheduled-route-manage";
import { SessionService, type SessionLockedTransaction } from "./sessions/session-service";
import { createActiveTurnRegistry, type ActiveTurnRegistry } from "./sessions/active-turn-registry";
import { DebouncedStateStore } from "./state/debounced-state-store";
import { StateStore } from "./state/state-store";
import type { AppState } from "./state/types";
import { runConsole } from "./run-console";
import { spawnAcpxBridgeClient } from "./transport/acpx-bridge/acpx-bridge-client";
import { AcpxBridgeTransport } from "./transport/acpx-bridge/acpx-bridge-transport";
import { AcpxCliTransport } from "./transport/acpx-cli/acpx-cli-transport";
import { createBackgroundFollowupTransport } from "./transport/background-followup-transport";
import type { ResolvedSession, SessionTransport } from "./transport/types";
import { reapQueueOwners } from "./transport/queue-owner-reaper";
import { collectReapTargets } from "./transport/collect-reap-targets";
import type { MessageChannelRuntime, CoordinatorMessageInput } from "./channels/types.js";
import { MessageChannelRegistry } from "./channels/channel-registry.js";
import { RuntimeMediaStore } from "./channels/media-store.js";
import { isQuotaDeferredError } from "./weixin/messaging/quota-errors";
import { normalizeWeixinUserIdFromChatKey } from "./weixin/messaging/inbound.js";
import { setWeixinLog } from "./weixin/util/weixin-log";
import { ProgressLineBuffer } from "./orchestration/progress-line-parser";
import { renderTaskHeartbeat, renderTaskProgress } from "./formatting/render-text";
import { QuotaManager } from "./weixin/messaging/quota-manager";
import { createControlEventBus } from "./control/control-event-bus";
import { ControlService } from "./control/control-service";
import { SessionWarmthTracker } from "./control/session-warmth-tracker";
import { createTerminalService } from "./control/terminal-service";
import { UploadStore } from "./control/upload-store.js";
import { listAgentCatalog } from "./config/agent-catalog";
import { createAcpxAgentRegistryLoader } from "./transport/agent-registry";
import { startConfigWatcher } from "./config/config-watcher";
import { createDaemonIdentity, OrphanRegistry, type DaemonIdentity } from "./transport/orphan-registry";
import { sweepWindowsOrphans } from "./transport/windows-orphan-reaper";
import { replaceRuntimeState } from "./state/replace-runtime-state";
import { LaunchIntentCoordinator } from "./transport/launch-intent-coordinator";
import { withAdapterOperationLock } from "./adapters/adapter-locks";
import { validateAndReResolveAdapterCommand } from "./adapters/adapter-preinstall";
import { classifyPreinstalledAdapterCommandShape } from "./adapters/adapter-catalog";
import { probeWindowsProcessIdentity, snapshotWindowsProcessesByToken } from "./process/windows-process-tree";
import { createQueueOwnerAdapterContext } from "./transport/queue-owner-adapter-context";
import {
  computeAgentOverlayEntries,
  ensureAgentOverlays,
  type EnsureAgentOverlaysResult,
} from "./transport/acpx-agent-overlay";

async function defaultProvisionAgentOverlays(
  config: AppConfig,
  logger: AppLogger,
): Promise<EnsureAgentOverlaysResult> {
  const entries = computeAgentOverlayEntries(config);
  const result = await ensureAgentOverlays(entries);
  for (const [alias, outcome] of Object.entries(result.outcomes)) {
    await logger.info("acpx.overlay", `acpx agent overlay ${outcome}`, { alias });
  }
  return result;
}

export interface RuntimePaths {
  configPath: string;
  statePath: string;
  perfLogPath?: string;
  orchestrationSocketPath?: string;
}

export interface AppRuntime {
  agent: ConsoleAgent;
  router: CommandRouter;
  sessions: SessionService;
  activeTurns: ActiveTurnRegistry;
  stateStore: StateStore;
  configStore: ConfigStore;
  logger: AppLogger;
  perfTracer: PerfTracer;
  quota: QuotaManager;
  transport: SessionTransport;
  daemonIdentity?: DaemonIdentity;
  orphanRegistry?: OrphanRegistry;
  launchIntentCoordinator?: LaunchIntentCoordinator;
  orchestration: {
    service: OrchestrationService;
    server: OrchestrationServer;
    endpoint: ReturnType<typeof resolveOrchestrationEndpoint>;
  };
  scheduled: {
    service: ScheduledTaskService;
    scheduler: ScheduledTaskScheduler;
  };
  control: ControlService;
  /**
   * Terminate warm acpx queue owners orphaned by a previous daemon that exited
   * without a clean shutdown (Windows verified stop, crashes,
   * machine reboot). Run once at startup before serving: this daemon has not launched
   * any owners yet, so every owner recorded for a known session is stale. Best-effort.
   */
  reapStaleQueueOwners: () => Promise<void>;
  reconcileOrphans?: () => Promise<void>;
  dispose: () => Promise<void>;
}

interface RuntimeDeps {
  createCliTransport?: (command: string) => SessionTransport;
  createBridgeTransport?: () => Promise<SessionTransport>;
  defaultLoggingLevel?: LoggingLevel;
  loggerNow?: () => Date;
  channel?: Pick<MessageChannelRuntime, "notifyTaskCompletion" | "notifyTaskProgress" | "sendCoordinatorMessage" | "sendScheduledMessage"> & {
    configureOrchestration?: MessageChannelRuntime["configureOrchestration"];
    supportsScheduledMessages?: (chatKey: string) => boolean;
    nativeSessionListFormat?: (chatKey: string) => "cards" | "table";
  };
  sendOrchestrationNotice?: (task: OrchestrationTaskRecord) => Promise<void>;
  sendCoordinatorMessage?: (input: CoordinatorMessageInput) => Promise<void>;
  /**
   * state.json write debounce window in ms. Coalesces bursts of mutations
   * into one disk write. Defaults to 50ms; tests pass 0 for deterministic
   * sync semantics.
   */
  stateSaveDebounceMs?: number;
  daemonIdentity?: DaemonIdentity;
  orphanRegistry?: OrphanRegistry;
  /**
   * Provision xacpx-managed acpx agent overlays before transport creation.
   * Injectable for tests; defaults to provisioning from the loaded config.
   */
  provisionAgentOverlays?: (
    config: AppConfig,
    logger: AppLogger,
  ) => Promise<EnsureAgentOverlaysResult>;
}

function startProgressHeartbeat(
  orchestration: OrchestrationService,
  config: AppConfig,
  logger: AppLogger,
  channel: RuntimeDeps["channel"] | null,
): NodeJS.Timeout | undefined {
  const thresholdSeconds = config.orchestration.progressHeartbeatSeconds;
  if (thresholdSeconds <= 0) {
    return undefined;
  }

  let ticking = false;
  return setInterval(async () => {
    // Skip this tick if the previous one is still running (e.g. a slow channel
    // delivery) so heartbeat ticks cannot overlap and stack up.
    if (ticking) return;
    ticking = true;
    try {
      const tasks = await orchestration.listHeartbeatTasks(thresholdSeconds);
      for (const task of tasks) {
        try {
          const elapsedSeconds =
            (Date.now() - new Date(task.lastProgressAt ?? task.createdAt).getTime()) / 1000;
          if (task.chatKey && task.replyContextToken && channel) {
            await channel.notifyTaskProgress(task, renderTaskHeartbeat(task, elapsedSeconds));
          }
          await orchestration.recordTaskProgress(task.taskId);
        } catch (error) {
          await logger.error("orchestration.heartbeat.send_failed", "failed to send heartbeat", {
            taskId: task.taskId,
            message: error instanceof Error ? error.message : String(error),
          });
        }
      }
    } catch (error) {
      await logger.error("orchestration.heartbeat.check_failed", "heartbeat check failed", {
        message: error instanceof Error ? error.message : String(error),
      });
    } finally {
      ticking = false;
    }
  }, 60_000);
}

import { createPerfTracer, createNoopPerfTracer, type PerfTracer } from "./perf/perf-tracer";
import { bootstrapBuiltinChannels } from "./channels/bootstrap.js";
import { setLocale, resolveLocale, getLocale } from "./i18n";

export async function buildApp(paths: RuntimePaths, deps: RuntimeDeps = {}): Promise<AppRuntime> {
  bootstrapBuiltinChannels();
  await ensureConfigExists(paths.configPath);
  const configStore = new ConfigStore(paths.configPath);
  const config = await loadConfig(paths.configPath, {
    defaultLoggingLevel: deps.defaultLoggingLevel,
  });
  setLocale(resolveLocale({ configLanguage: config.language }));
  // Hot-reload path: any new/changed agent (argv, adapter pin, registry) may need
  // a fresh overlay alias. Provision BEFORE swapping the in-memory config so a
  // conflicting/failed overlay never leaves memory and disk disagreeing.
  const provisionOverlays = async (target: AppConfig): Promise<void> => {
    await (deps.provisionAgentOverlays ?? defaultProvisionAgentOverlays)(target, logger);
  };
  const reloadRuntimeConfig = async (): Promise<AppConfig> => {
    const updated = await configStore.load();
    await provisionOverlays(updated);
    setLocale(resolveLocale({ configLanguage: updated.language }));
    replaceRuntimeConfig(config, updated);
    return config;
  };
  const logger = createAppLogger({
    filePath: resolveAppLogPath(paths.configPath),
    level: config.logging.level,
    maxSizeBytes: config.logging.maxSizeBytes,
    maxFiles: config.logging.maxFiles,
    retentionDays: config.logging.retentionDays,
    now: deps.loggerNow,
  });
  // Route the weixin subsystem's logs through the DI'd app logger (no more
  // world-readable /tmp/openclaw). Must run before any weixin activity starts.
  setWeixinLog(logger);
  await logger.cleanup();
  const perfLogPath = paths.perfLogPath ?? resolvePerfLogPath(paths.configPath);
  const perfTracer: PerfTracer = config.logging.perf.enabled
    ? createPerfTracer({
        filePath: perfLogPath,
        maxSizeBytes: config.logging.perf.maxSizeBytes,
        maxFiles: config.logging.perf.maxFiles,
        retentionDays: config.logging.perf.retentionDays,
        appLogger: logger,
      })
    : createNoopPerfTracer();
  await perfTracer.cleanup();
  // Provision xacpx-managed acpx agent overlays (`~/.acpx/config.json` agents
  // entries) before any transport exists, so every acpx launch resolves its
  // positional alias to the exact structured argv.
  await (deps.provisionAgentOverlays ?? defaultProvisionAgentOverlays)(config, logger);
  const acpxCommand = resolveAcpxCommand({ configuredCommand: config.transport.command });
  const stateStore = new StateStore(paths.statePath);
  const state = await stateStore.load();
  const stateLoadReport = stateStore.lastLoadReport;
  if (stateLoadReport) {
    // Loud by design: a quarantined record means data was dropped to keep the
    // daemon bootable; operators must be able to find what was lost and where.
    for (const record of stateLoadReport.dropped) {
      await logger.error("state.record_quarantined", "dropped malformed state.json record", {
        statePath: paths.statePath,
        section: record.section,
        key: record.key,
        reason: record.reason,
      });
    }
    if (stateLoadReport.corruptPath) {
      await logger.error("state.file_corrupt", "state.json was unreadable; renamed aside and starting empty", {
        statePath: paths.statePath,
        corruptPath: stateLoadReport.corruptPath,
      });
    }
    if (stateLoadReport.quarantinePath) {
      await logger.error("state.file_quarantined", "original state.json backed up before dropping records", {
        statePath: paths.statePath,
        quarantinePath: stateLoadReport.quarantinePath,
      });
    }
    if (stateLoadReport.backupError) {
      await logger.error("state.quarantine_backup_failed", "failed to back up the original state.json", {
        statePath: paths.statePath,
        message: stateLoadReport.backupError,
      });
    }
  }
  const stateMutex = new AsyncMutex();
  const debouncedStateStore = new DebouncedStateStore({
    delegate: stateStore,
    intervalMs: deps.stateSaveDebounceMs ?? 50,
    onError: (error) => {
      void logger.error("state.debounced_save.failed", "debounced state.json write failed", {
        message: error instanceof Error ? error.message : String(error),
      });
    },
  });
  const runtimeRoot = dirname(paths.configPath);
  const sessions = new SessionService(config, debouncedStateStore, state, { stateMutex, runtimeRoot });
  const launchIntentCoordinator = new LaunchIntentCoordinator<SessionLockedTransaction>({
    platform: process.platform,
    runtimeRoot,
    configRoot: runtimeRoot,
    generationId: deps.daemonIdentity?.generationId ?? randomUUID(),
    ...(deps.orphanRegistry ? { registry: deps.orphanRegistry } : {}),
    classifyAdapter: (command) => classifyPreinstalledAdapterCommandShape(command),
    resolveAdapter: async (command) => (await validateAndReResolveAdapterCommand(runtimeRoot, command)).agentCommand,
    withSessionLock: (critical) => sessions.withSessionLock(critical),
    withAdapterLock: (id, critical) => withAdapterOperationLock({ id, runtimeRoot }, critical),
    persistCommand: (locked, sessionKey, command) => locked.setTransportAgentCommandDurably(sessionKey, command),
    queryLauncherIdentity: async (pid) => {
      const identity = await probeWindowsProcessIdentity(pid);
      return identity.status === "found" ? { creationDate: identity.identity.creationDate } : null;
    },
    verifyOwner: async (pid, token) => {
      const snapshot = await snapshotWindowsProcessesByToken(token);
      const candidate = snapshot?.find((item) => item.pid === pid);
      if (!candidate) return null;
      const identity = await probeWindowsProcessIdentity(pid);
      if (identity.status !== "found") return null;
      const delta = BigInt(identity.identity.creationDate) - BigInt(candidate.creationDate);
      if ((delta < 0n ? -delta : delta) > 9n) return null;
      return {
        creationDate: identity.identity.creationDate,
        commandLine: candidate.commandLine,
        executablePath: identity.identity.executablePath,
      };
    },
    snapshotToken: (token) => snapshotWindowsProcessesByToken(token),
    onWarning: (message, context) => {
      void logger.info("transport.launch_intent.warning", message, {
        ...(context ? { context: JSON.stringify(context) } : {}),
      }).catch(() => {});
    },
  });
  // One shared, non-persisted registry of in-flight (chatKey, alias) turns. The
  // monitor marks turns active/inactive around dispatch; the command router can
  // later read it to tell the user "session X is still running".
  const activeTurns = createActiveTurnRegistry();
  const scheduledService = new ScheduledTaskService(state, debouncedStateStore, { stateMutex });
  const pendingWorkerDispatches = new Set<Promise<void>>();
  const baseTransport =
    config.transport.type === "acpx-bridge"
      ? await (deps.createBridgeTransport?.() ??
          Promise.resolve(
            new AcpxBridgeTransport(
              await spawnAcpxBridgeClient({
                acpxCommand,
                bridgeEntryPath: resolveBridgeEntryPath(),
                agentOverlays: computeAgentOverlayEntries(config),
                permissionMode: config.transport.permissionMode,
                nonInteractivePermissions: config.transport.nonInteractivePermissions,
                ...(typeof config.transport.permissionPolicy === "string"
                  ? { permissionPolicy: config.transport.permissionPolicy }
                  : {}),
                ...(typeof config.transport.queueOwnerTtlSeconds === "number"
                  ? { queueOwnerTtlSeconds: config.transport.queueOwnerTtlSeconds }
                  : {}),
                ...(typeof config.transport.sessionInitTimeoutMs === "number"
                  ? { sessionInitTimeoutMs: config.transport.sessionInitTimeoutMs }
                  : {}),
                ...(deps.orphanRegistry
                  ? { generationFilePath: join(deps.orphanRegistry.root, "generation.json") }
                  : {}),
                // A dropped (undecodable) bridge stdout line can be a lost
                // response; the client-side request timeout unblocks the
                // caller, but the corruption itself must be visible in logs.
                onMalformedLine: (line) => {
                  void logger.error("bridge.protocol.malformed_line", "dropped undecodable bridge output line", {
                    line: line.length > 500 ? `${line.slice(0, 500)}…` : line,
                  });
                },
                onBridgeRequest: (method, params, context) => launchIntentCoordinator.handle(method, params, context),
                onBridgeDisconnect: () => launchIntentCoordinator.disconnect(),
              }),
            ),
          ))
      : (deps.createCliTransport?.(acpxCommand) ??
          new AcpxCliTransport({
            ...config.transport,
            command: acpxCommand,
            createAdapterContext: ({ id, sessionKey, agentCommand }) => createQueueOwnerAdapterContext({
              id,
              sessionKey,
              agentCommand,
              launcherIdentity: async () => {
                if (process.platform !== "win32") return { pid: process.pid, creationDate: "0" };
                const identity = await probeWindowsProcessIdentity(process.pid);
                if (identity.status !== "found") throw new Error("CLI launcher identity is unavailable");
                return { pid: process.pid, creationDate: identity.identity.creationDate };
              },
              requestDaemon: (method, params) => launchIntentCoordinator.handle(method, params, { launcherPid: process.pid }),
              readCurrentGeneration: async () => {
                const current = await deps.orphanRegistry?.readGeneration();
                return current && current.terminating !== true ? current.generationId : null;
              },
            }),
          }));
  const transport = createBackgroundFollowupTransport(baseTransport, {
    logger,
    resolveDriver: (agent) => config.agents[agent]?.driver,
  });
  // Per-chatKey outbound quota (WeChat 24h budget). Shared across SDK boundary
  // (inbound reset / final reservation) and orchestration deliveries (mid gate).
  // Observer pipes every quota decision into the AppLogger so the path is
  // visible at runtime (otherwise quota throttling is invisible to operators).
  const quota = new QuotaManager({
    onInbound: (chatKey) => {
      void logger.info("weixin.quota.inbound_reset", "inbound message reset quota window", {
        chatKey,
      });
    },
    onMidReserved: (chatKey, snap) => {
      void logger.info("weixin.quota.mid_reserved", "mid-segment quota reserved", {
        chatKey,
        mid_used: snap.midUsed,
        remaining: snap.remaining,
      });
    },
    onMidRejected: (chatKey, snap) => {
      void logger.info("weixin.quota.mid_rejected", "mid-segment quota exhausted; segment dropped/deferred", {
        chatKey,
        mid_used: snap.midUsed,
        remaining: snap.remaining,
      });
    },
    onFinalReserved: (chatKey, snap) => {
      void logger.info("weixin.quota.final_reserved", "final-tier quota reserved", {
        chatKey,
        mid_used: snap.midUsed,
        final_used: snap.finalUsed,
        remaining: snap.remaining,
      });
    },
    onFinalRejected: (chatKey, snap) => {
      void logger.error(
        "weixin.quota.final_rejected",
        "final-tier quota exhausted; final message dropped",
        {
          chatKey,
          mid_used: snap.midUsed,
          final_used: snap.finalUsed,
        },
      );
    },
  }, (key) => key.startsWith("weixin:") ? normalizeWeixinUserIdFromChatKey(key) : key);
  let orchestration!: OrchestrationService;
  let sendCompletionNotice!: (task: OrchestrationTaskRecord) => Promise<void>;
  const sendCoordinatorMessage =
    deps.sendCoordinatorMessage ?? (deps.channel
      ? (input: CoordinatorMessageInput) => deps.channel!.sendCoordinatorMessage(input)
      : async () => {});

  const wakeCoordinatorLocks = new Map<string, Promise<void>>();
  const wakeCoordinator = async (coordinatorSession: string): Promise<void> => {
    const previous = wakeCoordinatorLocks.get(coordinatorSession) ?? Promise.resolve();
    const next = previous.then(
      () => doWakeCoordinator(coordinatorSession),
      () => doWakeCoordinator(coordinatorSession),
    );
    const tracked = next.catch(() => {});
    wakeCoordinatorLocks.set(coordinatorSession, tracked);
    void tracked.finally(() => {
      if (wakeCoordinatorLocks.get(coordinatorSession) === tracked) {
        wakeCoordinatorLocks.delete(coordinatorSession);
      }
    });
    return next;
  };
  const doWakeCoordinator = async (coordinatorSession: string): Promise<void> => {
    const session = await sessions.getPreferredSessionForTransport(coordinatorSession);
    if (!session) {
      throw new Error(`no logical session is attached to coordinator "${coordinatorSession}"`);
    }
    session.mcpCoordinatorSession = coordinatorSession;

    const { promptText, taskIds, groupIds } = await buildCoordinatorPrompt({
      orchestration,
      coordinatorSession,
    });
    if (promptText.trim().length === 0) {
      return;
    }

    // Auto-wake has no inbound message bound to it, so the coordinator's
    // reply has nowhere to go unless we push it via the recorded route.
    const route = state.orchestration.coordinatorRoutes?.[coordinatorSession];
    const pushReply: ((text: string) => Promise<void>) | undefined =
      route && route.chatKey
        ? async (text) => {
            await sendCoordinatorMessage({
              coordinatorSession,
              chatKey: route.chatKey,
              ...(route.accountId ? { accountId: route.accountId } : {}),
              ...(route.replyContextToken ? { replyContextToken: route.replyContextToken } : {}),
              text,
            });
          }
        : undefined;

    try {
      await transport.prompt(session, promptText, pushReply);
      if (groupIds.length > 0) {
        await orchestration.markCoordinatorGroupsInjected(groupIds);
      }
      if (taskIds.length > 0) {
        await orchestration.markTaskInjectionApplied(taskIds);
      }
    } catch (error) {
      if (isQuotaDeferredError(error)) {
        // Deferred (not failed): leave injectionPending so the next wake retries.
        await logger.info(
          "orchestration.coordinator_wake.deferred",
          "coordinator wake deferred because outbound quota is exhausted",
          {
            coordinatorSession,
            chatKey: error.chatKey,
            taskIds: taskIds.join(","),
            groupIds: groupIds.join(","),
          },
        );
        return;
      }
      const errorMessage = error instanceof Error ? error.message : String(error);
      if (groupIds.length > 0) {
        await orchestration.markCoordinatorGroupsInjectionFailed(groupIds, errorMessage);
      }
      if (taskIds.length > 0) {
        await orchestration.markTaskInjectionFailed(taskIds, errorMessage);
      }
      throw error;
    }
  };

  const finalizeWorkerTurn = async (input: {
    taskId: string;
    workerSession: string;
    status: "completed" | "failed";
    summary?: string;
    resultText?: string;
  }): Promise<OrchestrationTaskRecord | undefined> => {
    const currentTask = await orchestration.getTask(input.taskId);
    if (!currentTask) {
      return undefined;
    }
    if (currentTask.workerSession !== input.workerSession) {
      await logger.debug(
        "orchestration.worker.reply_skipped",
        "skipping worker turn finalization because the task worker changed",
        {
          taskId: input.taskId,
          expectedWorkerSession: input.workerSession,
          actualWorkerSession: currentTask.workerSession,
        },
      );
      return undefined;
    }
    if (currentTask.status !== "running") {
      await logger.debug(
        "orchestration.worker.reply_skipped",
        "skipping worker turn finalization because the task is no longer running",
        {
          taskId: input.taskId,
          workerSession: input.workerSession,
          status: currentTask.status,
        },
      );
      return undefined;
    }

    try {
      return await orchestration.recordWorkerReply({
        taskId: input.taskId,
        sourceHandle: input.workerSession,
        status: input.status,
        ...(input.summary !== undefined ? { summary: input.summary } : {}),
        ...(input.resultText !== undefined ? { resultText: input.resultText } : {}),
      });
    } catch (error) {
      await logger.error(
        "orchestration.worker.reply_record_failed",
        "failed to persist worker task result",
        {
          taskId: input.taskId,
          workerSession: input.workerSession,
          message: error instanceof Error ? error.message : String(error),
        },
      );
      return undefined;
    }
  };

  const resolveWorkerRuntimeSession = (input: {
    workerSession: string;
    targetAgent: string;
    workspace: string;
    cwd?: string;
  }): ResolvedSession => {
    if (!input.cwd) {
      return sessions.resolveSession(
        input.workerSession,
        input.targetAgent,
        input.workspace,
        input.workerSession,
      );
    }

    const agentConfig = config.agents[input.targetAgent];
    if (!agentConfig) {
      throw new Error(`agent "${input.targetAgent}" is not configured`);
    }

    const launch = resolveConfiguredAgentLaunch(agentConfig, config.transport);
    return {
      alias: input.workerSession,
      agent: input.targetAgent,
      driver: agentConfig.driver,
      settingsPolicy: agentConfig.settingsPolicy,
      ...(launch.agentCommand ? { agentCommand: launch.agentCommand } : {}),
      ...(launch.acpxAgent ? { acpxAgent: launch.acpxAgent } : {}),
      ...(launch.rawCommand ? { rawCommand: launch.rawCommand } : {}),
      ...(launch.agentArgv ? { agentArgv: launch.agentArgv } : {}),
      model: agentConfig.model,
      workspace: input.workspace,
      transportSession: input.workerSession,
      cwd: input.cwd,
    };
  };

  const launchWorkerTurn = (input: {
    taskId: string;
    workerSession: string;
    coordinatorSession: string;
    targetAgent: string;
    workspace: string;
    cwd?: string;
    promptText: string;
  }): void => {
    const workerDispatch = (async () => {
      let taskRecord: OrchestrationTaskRecord | undefined;
      try {
        await reloadRuntimeConfig();
        const session = resolveWorkerRuntimeSession(input);
        session.mcpCoordinatorSession = input.coordinatorSession;
        session.mcpSourceHandle = input.workerSession;
        const progressBuffer = new ProgressLineBuffer();
        const recordProgress = async (summary: string) => {
          try {
            await orchestration.recordTaskProgress(input.taskId, summary);
            const taskState = await orchestration.getTask(input.taskId);
            if (taskState?.chatKey && taskState.replyContextToken && deps.channel) {
              await deps.channel.notifyTaskProgress(taskState, renderTaskProgress(taskState, summary));
            }
          } catch (error) {
            await logger.error(
              "orchestration.progress.send_failed",
              "failed to send task progress",
              {
                taskId: input.taskId,
                message: error instanceof Error ? error.message : String(error),
              },
            );
          }
        };
        const result = await transport.prompt(
          session,
          input.promptText,
          undefined,
          undefined,
          {
            onSegment: async (chunk) => {
              const summaries = progressBuffer.feed(chunk, { segmentComplete: true });
              for (const summary of summaries) {
                await recordProgress(summary);
              }
            },
          },
        );
        for (const summary of progressBuffer.flush()) {
          await recordProgress(summary);
        }
        taskRecord = await finalizeWorkerTurn({
          taskId: input.taskId,
          workerSession: input.workerSession,
          status: "completed",
          resultText: result.text,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        await logger.error("orchestration.worker.dispatch_failed", "worker task dispatch failed", {
          taskId: input.taskId,
          workerSession: input.workerSession,
          message,
        });
        taskRecord = await finalizeWorkerTurn({
          taskId: input.taskId,
          workerSession: input.workerSession,
          status: "failed",
          summary: message,
          resultText: "",
        });
      }

      try {
        await orchestration.reconcileParallelSlots();
      } catch (reconcileError) {
        await logger.error(
          "orchestration.parallel.reconcile_failed",
          "failed to reconcile parallel slots after worker turn",
          {
            taskId: input.taskId,
            message: reconcileError instanceof Error ? reconcileError.message : String(reconcileError),
          },
        );
      }

      if (taskRecord && shouldNotifyTaskCompletion(taskRecord)) {
        try {
          await sendCompletionNotice(taskRecord);
        } catch (noticeError) {
          await logger.error("orchestration.worker.notice_failed", "failed to notify delegated task result", {
            taskId: input.taskId,
            workerSession: input.workerSession,
            message: noticeError instanceof Error ? noticeError.message : String(noticeError),
          });
        }
      }

      if (taskRecord && !isRuntimeExternalCoordinator(taskRecord.coordinatorSession)) {
        try {
          await wakeCoordinator(taskRecord.coordinatorSession);
        } catch (wakeError) {
          await logger.error(
            "orchestration.worker.wake_failed",
            "failed to wake coordinator after worker task finished",
            {
              taskId: input.taskId,
              coordinatorSession: taskRecord.coordinatorSession,
              message: wakeError instanceof Error ? wakeError.message : String(wakeError),
            },
          );
        }
      }
    })();
    pendingWorkerDispatches.add(workerDispatch);
    void workerDispatch.finally(() => {
      pendingWorkerDispatches.delete(workerDispatch);
    });
  };

  const isRuntimeExternalCoordinator = (coordinatorSession: string): boolean => {
    return Boolean(state.orchestration.externalCoordinators[coordinatorSession]);
  };

  orchestration = new OrchestrationService({
    now: deps.loggerNow ?? (() => new Date()),
    createId: () => randomUUID(),
    config,
    loadState: async () => JSON.parse(JSON.stringify(state)) as typeof state,
    saveState: async (nextState) => {
      // Orchestration is durability-gated: a task transition becomes visible
      // in memory only AFTER it is persisted (see the "keeps the previous
      // orchestration snapshot visible until task completion is persisted"
      // test). saveNow() writes immediately — it does not wait out the
      // debounce window and does not resolve at commit time like save() —
      // and rejects on write failure so the mutation fails loudly.
      await debouncedStateStore.saveNow(nextState);
      replaceRuntimeState(state, nextState);
    },
    stateMutex,
    ensureWorkerSession: async ({ workerSession, targetAgent, workspace, cwd, coordinatorSession }) => {
      await reloadRuntimeConfig();
      const session = resolveWorkerRuntimeSession({ workerSession, targetAgent, workspace, ...(cwd ? { cwd } : {}) });
      session.mcpCoordinatorSession = coordinatorSession;
      session.mcpSourceHandle = workerSession;
      await transport.ensureSession(session);
      return workerSession;
    },
    dispatchWorkerTask: async ({ workerSession, coordinatorSession, targetAgent, workspace, cwd, taskId, role, task }) => {
      launchWorkerTurn({
        taskId,
        workerSession,
        coordinatorSession,
        targetAgent,
        workspace,
        ...(cwd ? { cwd } : {}),
        promptText: buildWorkerTaskPrompt({ taskId, workerSession, role, task }),
      });
    },
    cancelWorkerTask: async ({ workerSession, targetAgent, workspace, cwd }) => {
      const session = resolveWorkerRuntimeSession({ workerSession, targetAgent, workspace, ...(cwd ? { cwd } : {}) });
      const result = await transport.cancel(session);
      if (!result.cancelled) {
        throw new Error(result.message || "worker task cancel was not acknowledged");
      }
    },
    closeWorkerSession: async ({ workerSession, targetAgent, workspace, cwd }) => {
      if (!transport.removeSession) {
        return;
      }
      const session = resolveWorkerRuntimeSession({ workerSession, targetAgent, workspace, ...(cwd ? { cwd } : {}) });
      await transport.removeSession(session);
    },
    resumeWorkerTask: async ({ taskId, workerSession, coordinatorSession, targetAgent, workspace, cwd, answer }) => {
      launchWorkerTurn({
        taskId,
        workerSession,
        coordinatorSession,
        targetAgent,
        workspace,
        ...(cwd ? { cwd } : {}),
        promptText: buildWorkerAnswerPrompt(answer),
      });
    },
    wakeCoordinatorSession: async ({ coordinatorSession }) => {
      await wakeCoordinator(coordinatorSession);
    },
    deliverCoordinatorMessage: async (input) => {
      await sendCoordinatorMessage(input);
    },
    interruptWorkerTask: async ({ workerSession, targetAgent, workspace, cwd }) => {
      const session = resolveWorkerRuntimeSession({ workerSession, targetAgent, workspace, ...(cwd ? { cwd } : {}) });
      const result = await transport.cancel(session);
      if (!result.cancelled) {
        throw new Error(result.message || "worker interrupt was not acknowledged");
      }
    },
    findReusableWorkerSession: async ({ coordinatorSession, workspace, cwd, targetAgent, role }) => {
      const binding = Object.entries(state.orchestration.workerBindings).find(
        ([, current]) =>
          current.ephemeral !== true &&
          sameCoordinatorSession(current.coordinatorSession, coordinatorSession) &&
          current.workspace === workspace &&
          current.cwd === cwd &&
          current.targetAgent === targetAgent &&
          current.role === role,
      );
      return binding?.[0] ?? null;
    },
    logger,
  });
  if (deps.channel) {
    deps.channel.configureOrchestration?.({
      markTaskNoticeDelivered: async (taskId, accountId) => {
        await orchestration.markTaskNoticeDelivered(taskId, accountId);
      },
      markTaskNoticeFailed: async (taskId, errorMessage) => {
        await orchestration.markTaskNoticeFailed({ taskId, errorMessage });
      },
    });
  }
  sendCompletionNotice =
    deps.sendOrchestrationNotice ?? (deps.channel
      ? async (task) => { await deps.channel!.notifyTaskCompletion(task); }
      : async () => {});
  for (const task of await orchestration.listPendingTaskNotices()) {
    try {
      await sendCompletionNotice(task);
    } catch (error) {
      await logger.error("orchestration.notice.replay_failed", "failed to replay pending orchestration notice", {
        taskId: task.taskId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  const progressHeartbeatInterval = startProgressHeartbeat(orchestration, config, logger, deps.channel ?? null);
  const orchestrationEndpoint = createOrchestrationEndpoint(
    paths.orchestrationSocketPath ?? resolveOrchestrationSocketPathFromConfigPath(paths.configPath),
  );
  const orchestrationServer = new OrchestrationServer(orchestrationEndpoint, orchestration, {
    onSocketHardenError: (error) => {
      void logger.error(
        "orchestration.socket.chmod_failed",
        "failed to restrict orchestration socket to owner-only (0600); falling back to runtime dir permissions",
        { message: error instanceof Error ? error.message : String(error) },
      );
    },
    createScheduledTaskFromRoute: async (input) =>
      await createScheduledTaskFromRoute(input, {
        state,
        config,
        sessions,
        scheduled: scheduledService,
        ...(deps.channel?.supportsScheduledMessages
          ? { supportsScheduledMessages: deps.channel.supportsScheduledMessages.bind(deps.channel) }
          : {}),
      }),
    listScheduledTasksFromRoute: async (input) =>
      await listScheduledTasksFromRoute(input, { state, scheduled: scheduledService }),
    cancelScheduledTaskFromRoute: async (input) =>
      await cancelScheduledTaskFromRoute(input, { state, scheduled: scheduledService }),
  });
  const router = new CommandRouter(
    sessions,
    transport,
    config,
    configStore,
    logger,
    undefined,
    orchestration,
    quota,
    scheduledService,
    deps.channel?.supportsScheduledMessages ? { supportsScheduledMessages: deps.channel.supportsScheduledMessages.bind(deps.channel) } : undefined,
    deps.channel?.nativeSessionListFormat ? deps.channel.nativeSessionListFormat.bind(deps.channel) : undefined,
    activeTurns,
  );
  const agent = new ConsoleAgent(router, logger);
  const controlEvents = createControlEventBus(logger);
  const terminalService = createTerminalService({
    events: controlEvents,
    idleTimeoutSeconds: () => terminalIdleTimeoutSeconds(config),
    shell: () => terminalShell(config),
  });
  const uploadStore = new UploadStore();
  const loadAgentRegistry = createAcpxAgentRegistryLoader({ logger });
  void uploadStore.cleanup(); // best-effort startup sweep of expired uploads
  // A long-lived daemon never re-sweeps on the startup pass alone, so expired uploads
  // would accumulate forever despite the 24h TTL. Re-run hourly; cleared on dispose.
  const uploadCleanupInterval = setInterval(
    () => void uploadStore.cleanup().catch(() => {}),
    60 * 60 * 1000,
  );
  // Warmth poller for the relay-web cold-session indicator: samples queue-owner
  // liveness every 60s and nudges dashboards via `sessions-changed` when a session
  // silently goes cold (TTL expiry). Only when the transport can observe liveness.
  const sessionWarmth = transport.isSessionWarm
    ? new SessionWarmthTracker({
        listSessions: () => sessions.listAllResolvedSessions(),
        isWarm: (session) => transport.isSessionWarm!(session),
        events: controlEvents,
        logger,
      })
    : undefined;
  sessionWarmth?.start();
  const control = new ControlService({
    logger,
    agent,
    sessions,
    transport,
    createSessionWithTransport: (internalAlias, agent, workspace, model) =>
      router.createSessionWithTransport(internalAlias, agent, workspace, model),
    listNativeSessions: (agent, workspace) =>
      router.listNativeSessionsForControl(agent, workspace),
    attachNativeSessionWithTransport: (internalAlias, agent, workspace, agentSessionId, nativeMeta) =>
      router.attachNativeSessionWithTransport(internalAlias, agent, workspace, agentSessionId, nativeMeta),
    removeSessionWithTransport: (internalAlias) => router.removeSessionWithTransport(internalAlias),
    archiveSessionWithTransport: (internalAlias) => router.archiveSessionWithTransport(internalAlias),
    unarchiveSession: (internalAlias) => router.unarchiveSession(internalAlias),
    activeTurns,
    ...(sessionWarmth ? { sessionWarmth } : {}),
    scheduled: scheduledService,
    orchestration,
    events: controlEvents,
    agents: {
      list: () =>
        Object.entries(config.agents).map(([name, agentConfig]) => ({ name, driver: agentConfig.driver })),
      catalog: () => listAgentCatalog(config, { registry: loadAgentRegistry() }),
      create: async (name, driver) => {
        const updated = await configStore.upsertAgent(name, { driver });
        await provisionOverlays(updated);
        replaceRuntimeConfig(config, updated);
        return { name, driver };
      },
      remove: async (name) => {
        const updated = await configStore.removeAgent(name);
        replaceRuntimeConfig(config, updated);
      },
    },
    workspaces: {
      list: () =>
        Object.entries(config.workspaces).map(([name, workspace]) => ({
          name,
          cwd: workspace.cwd,
          ...(workspace.description ? { description: workspace.description } : {}),
        })),
      create: async (name, cwd, description) => {
        const updated = await configStore.upsertWorkspace(name, cwd, description);
        replaceRuntimeConfig(config, updated);
        // Push to every web client (the caller updates optimistically; peers need this).
        // The config watcher won't double-fire: it diffs against in-memory config, which
        // replaceRuntimeConfig already refreshed above, so its later event is a no-op.
        controlEvents.emit({ type: "workspaces-changed" });
        // The persisted values equal the inputs; build the DTO from them directly
        // (avoids an unchecked index read of the freshly-written workspaces map).
        return { name, cwd, ...(description ? { description } : {}) };
      },
      remove: async (name) => {
        const updated = await configStore.removeWorkspace(name);
        replaceRuntimeConfig(config, updated);
        controlEvents.emit({ type: "workspaces-changed" });
      },
    },
    uploadStore,
    terminal: terminalService,
    terminalEnabled: () => terminalEnabled(config),
    filesWriteEnabled: () => filesWriteEnabled(config),
    turnIdleTimeoutMs: () => turnIdleTimeoutSeconds(config) * 1000,
    onTurnIdleTimeout: ({ chatKey, sessionAlias, idleMs }) => {
      void logger.info("control.turn.idle_timeout", "reclaimed a wedged turn after inactivity", {
        chatKey,
        sessionAlias,
        idleMs,
      });
    },
  });

  // Pick up out-of-band config edits without a daemon restart. `xacpx workspace add`
  // (and `agent add`, `/config` from another process) run as separate CLI processes:
  // they only write config.json and can't reach this daemon's in-memory config, so the
  // control API — and thus the relay web panel — would serve a stale list until restart.
  // Reload on file change; when the workspace set actually changed, tell structured
  // consumers so they re-fetch. The whole config (agents included) is refreshed in
  // memory either way, so a manual web refresh also reflects out-of-band agent edits.
  // A collision-free signature of the workspace set (JSON of sorted name/cwd/description
  // tuples), used to decide whether a config reload actually changed workspaces.
  const workspaceSignature = (cfg: AppConfig): string =>
    JSON.stringify(
      Object.keys(cfg.workspaces)
        .sort()
        .map((name) => {
          const ws = cfg.workspaces[name]!;
          return [name, ws.cwd, ws.description ?? ""];
        }),
    );
  const configWatcher = startConfigWatcher({
    configPath: paths.configPath,
    logger,
    onChange: () => {
      const before = workspaceSignature(config);
      void reloadRuntimeConfig()
        .then(() => {
          if (workspaceSignature(config) !== before) {
            controlEvents.emit({ type: "workspaces-changed" });
          }
        })
        .catch((error) => {
          void logger.error("config.reload_failed", "failed to reload config after file change", {
            error: error instanceof Error ? error.message : String(error),
          });
        });
    },
  });

  const scheduledScheduler = new ScheduledTaskScheduler(scheduledService, {
    dispatchTask: buildScheduledDispatchTask({
      getSession: (alias) => sessions.getSession(alias),
      resolveAliasForChat: (chatKey, alias) => sessions.resolveAliasForChat(chatKey, alias),
      resolveSession: (alias, agent, workspace, transportSession) =>
        sessions.resolveSession(alias, agent, workspace, transportSession),
      sendScheduledMessage: async (input) => {
        if (!deps.channel?.sendScheduledMessage) {
          throw new Error("no channel runtime available for scheduled task dispatch");
        }
        await deps.channel.sendScheduledMessage(input);
      },
      ...(transport.removeSession ? { removeSession: (session) => transport.removeSession!(session) } : {}),
      logger,
    }),
    // A fired task reaches a terminal state here; tell structured consumers (the web
    // panel) so it reloads and the run shows its Done/Failed status instead of vanishing.
    onSettled: (task) => controlEvents.emit({ type: "scheduled-changed", chatKey: task.chat_key }),
    logger,
  });

  // Terminate warm acpx queue owners for our sessions. At shutdown this stops them
  // lingering until their --ttl expires (or forever, when ttl=0). At startup it sweeps
  // owners orphaned by a previous daemon that died without a clean shutdown (Windows
  // verified `stop`, crashes, reboots) — safe because this daemon has
  // not launched any owners yet, so every recorded owner is stale. Best-effort and
  // bounded: failures/timeouts just leave owners to expire on TTL.
  const reapWarmQueueOwners = async (phase: "startup" | "periodic" | "shutdown"): Promise<void> => {
    try {
      if (deps.orphanRegistry && deps.daemonIdentity) {
        const outcome = await sweepWindowsOrphans(
          deps.orphanRegistry,
          deps.daemonIdentity.generationId,
          {
            phase,
            onWarning: (message) => {
              void logger.info("transport.orphan_reap.degraded", message, { phase }).catch(() => {});
            },
          },
        );
        await logger.info("transport.orphan_reap.completed", "reconciled durable Windows orphan records", {
          phase,
          ...outcome,
        }).catch(() => {});
        return;
      }
      const targets = collectReapTargets(sessions, state.orchestration, config);
      if (targets.length === 0) {
        return;
      }
      const { terminated, attempted } = await reapQueueOwners(acpxCommand, targets, {
        onError: (target, error) => {
          void logger.info("transport.queue_owner_reap.failed", "failed to reap queue owner", {
            phase,
            transport_session: target.transportSession,
            error: error instanceof Error ? error.message : String(error),
          }).catch(() => {});
        },
      });
      await logger.info("transport.queue_owner_reap.completed", "reaped warm queue owners", {
        phase,
        terminated,
        attempted,
      }).catch(() => {});
    } catch (err) {
      await logger.error("transport.queue_owner_reap.error", "queue owner reap failed", {
        phase,
        error: err instanceof Error ? err.message : String(err),
      }).catch(() => {});
    }
  };

  return {
    agent,
    router,
    sessions,
    activeTurns,
    stateStore,
    configStore,
    logger,
    perfTracer,
    quota,
    transport,
    ...(deps.daemonIdentity ? { daemonIdentity: deps.daemonIdentity } : {}),
    ...(deps.orphanRegistry ? { orphanRegistry: deps.orphanRegistry } : {}),
    launchIntentCoordinator,
    orchestration: {
      service: orchestration,
      server: orchestrationServer,
      endpoint: orchestrationEndpoint,
    },
    scheduled: {
      service: scheduledService,
      scheduler: scheduledScheduler,
    },
    control,
    reapStaleQueueOwners: () => reapWarmQueueOwners("startup"),
    ...(deps.orphanRegistry && deps.daemonIdentity
      ? { reconcileOrphans: () => reapWarmQueueOwners("periodic") }
      : {}),
    dispose: async () => {
      scheduledScheduler.stop();
      sessionWarmth?.stop();
      configWatcher.close();
      clearInterval(uploadCleanupInterval);
      terminalService.disposeAll();
      if (progressHeartbeatInterval !== undefined) {
        clearInterval(progressHeartbeatInterval);
      }
      await Promise.allSettled([...pendingWorkerDispatches]);
      await debouncedStateStore.dispose();
      if ("dispose" in transport && typeof transport.dispose === "function") {
        // Bridge dispose waits for its subprocess to acknowledge shutdown and
        // terminate. Do this before the final orphan sweep and before runConsole
        // releases the consumer guard, so no old launcher can publish afterward.
        await transport.dispose();
      }
      await reapWarmQueueOwners("shutdown");
      try {
        await perfTracer.flush();
      } catch (err) {
        await logger.error("perf.flush_failed", "perf tracer flush failed during shutdown", {
          error: err instanceof Error ? err.message : String(err),
        }).catch(() => {});
      }
      await logger.flush();
    },
  };
}

function replaceRuntimeConfig(target: AppConfig, source: AppConfig): void {
  // Copy every AppConfig field onto the live config object in place, preserving
  // its identity for holders of the reference. Object.assign stays exhaustive
  // automatically, so a newly added AppConfig field cannot be silently missed.
  Object.assign(target, source);
}

export async function main(): Promise<void> {
  const paths = resolveRuntimePaths();

  try {
    const { createMessageChannels } = await import("./channels/create-channel.js");
    let daemonIdentity: DaemonIdentity | undefined;
    let orphanRegistry: OrphanRegistry | undefined;
    if (process.platform === "win32") {
      const configRoot = dirname(paths.configPath);
      orphanRegistry = new OrphanRegistry(join(configRoot, "runtime"));
      await orphanRegistry.initialize();
      daemonIdentity = await createDaemonIdentity({ configRoot });
      await orphanRegistry.writeGeneration(daemonIdentity);
    }
    await ensureConfigExists(paths.configPath);
    const startupConfig = await loadConfig(paths.configPath);

    const { loadConfiguredPlugins } = await import("./plugins/plugin-loader.js");
    await loadConfiguredPlugins({
      plugins: startupConfig.plugins,
      onPluginError: ({ name, error }) => {
        console.error(
          `[xacpx] skipping plugin ${name}: ${error instanceof Error ? error.message : String(error)}`,
        );
      },
    });

    const { channelDeps } = await prepareChannelMedia(paths.configPath, startupConfig);
    const channelRegistry = new MessageChannelRegistry(createMessageChannels(startupConfig.channels, channelDeps));
    await runConsole(paths, {
      buildApp: (paths) => buildApp(paths, { channel: channelRegistry, daemonIdentity, orphanRegistry }),
      channels: channelRegistry,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(
      [
        "Failed to start xacpx console.",
        `config: ${paths.configPath}`,
        `state: ${paths.statePath}`,
        message,
      ].join("\n"),
    );
  }
}

if (import.meta.main) {
  await main();
}

export async function prepareChannelMedia(configPath: string, config: AppConfig): Promise<{
  mediaStore: RuntimeMediaStore;
  channelDeps: import("./channels/create-channel").CreateChannelDeps;
}> {
  const runtimeDir = join(dirname(configPath), "runtime");
  const mediaRootDir = join(runtimeDir, "media");
  const mediaStore = new RuntimeMediaStore({ rootDir: mediaRootDir });
  await mediaStore.cleanupExpired().catch((error) => {
    console.error("[xacpx] media cleanup failed:", error instanceof Error ? error.message : String(error));
  });
  const allowedMediaRoots = Object.values(config.workspaces).map((ws) => ws.cwd);
  return { mediaStore, channelDeps: { mediaStore, allowedMediaRoots } };
}

export function resolveRuntimePaths(): RuntimePaths {
  const home = process.env.HOME ?? homedir();
  if (!home) {
    throw new Error("Unable to resolve the current user home directory");
  }

  const configPath = coreEnv("CONFIG") ?? join(coreHomeDir(home), "config.json");
  const runtimeDir = join(dirname(configPath), "runtime");

  return {
    configPath,
    statePath: coreEnv("STATE") ?? join(coreHomeDir(home), "state.json"),
    perfLogPath: join(runtimeDir, "perf.log"),
    orchestrationSocketPath:
      coreEnv("ORCHESTRATION_SOCKET") ?? resolveDaemonOrchestrationSocketPath(runtimeDir),
  };
}

export function resolveBridgeEntryPath(): string {
  if (import.meta.url.includes("/dist/")) {
    return fileURLToPath(new URL("./bridge/bridge-main.js", import.meta.url));
  }

  return fileURLToPath(new URL("./bridge/bridge-main.ts", import.meta.url));
}

function resolveAppLogPath(configPath: string): string {
  const rootDir = dirname(configPath);
  const runtimeDir = join(rootDir, "runtime");
  return join(runtimeDir, "app.log");
}

function resolvePerfLogPath(configPath: string): string {
  const rootDir = dirname(configPath);
  const runtimeDir = join(rootDir, "runtime");
  return join(runtimeDir, "perf.log");
}

function resolveOrchestrationSocketPathFromConfigPath(configPath: string): string {
  const runtimeDir = resolveRuntimeDirFromConfigPath(configPath);
  return resolveDaemonOrchestrationSocketPath(runtimeDir);
}


function shouldNotifyTaskCompletion(task: OrchestrationTaskRecord): boolean {
  return Boolean(task.chatKey && task.replyContextToken && (task.status === "completed" || task.status === "failed"));
}
