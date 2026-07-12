
import type { ActiveTurnRegistry } from "../sessions/active-turn-registry.js";
import type { AppConfig } from "../config/types";
import type { AppLogger } from "../logging/app-logger";
import { createNoopAppLogger } from "../logging/app-logger";
import type { SessionService } from "../sessions/session-service";
import type { AgentCommand, PromptMediaInput, PromptUsage, ReplyQuotaContext, SessionTransport } from "../transport/types";
import type { AgentSession, ResolvedSession } from "../transport/types";
import { resolveRuntimeAgentCommand } from "../config/resolve-agent-command";
import type { PerfSpan } from "../perf/perf-tracer";
import type { QuotaManager } from "../weixin/messaging/quota-manager.js";
import { resolveSessionAgentCommandFromIndex, type SessionAgentCommandResolver } from "../transport/acpx-session-index";
import { parseCommand } from "./parse-command";
import { authorizeCommandForChat, renderCommandAccessDenied, withEffectiveOwner } from "./command-policy";
import type { ChatRequestMetadata } from "../weixin/agent/interface";
import type { PlanEntry, ToolUseEvent } from "../channels/types.js";
import { handlePermissionAutoSet, handlePermissionAutoStatus, handlePermissionModeSet, handlePermissionStatus } from "./handlers/permission-handler";
import { handleConfigSet, handleConfigShow } from "./handlers/config-handler";
import {
  handleCancel,
  handleModeSet,
  handleModeShow,
  handleModelSet,
  handleModelShow,
  handlePrompt,
  handlePromptWithSession,
  handleReplyModeReset,
  handleReplyModeSet,
  handleReplyModeShow,
  handleSessionAttach,
  handleSessionNew,
  handleSessionRemove,
  handleSessionArchive,
  handleSessionReset,
  handleSessionTail,
  handleSessions,
  handleSessionShortcut,
  handleSessionUse,
  handleSessionUsePrevious,
  handleStatus,
  type SessionHandlerContext,
} from "./handlers/session-handler";
import {
  handleDelegateRequest,
  handleGroupCancel,
  handleGroupCreate,
  handleGroupDelegate,
  handleGroupGet,
  handleGroupList,
  handleTaskApprove,
  handleTaskCancel,
  handleTaskGet,
  handleTaskList,
  handleTaskReject,
  handleTasksClean,
} from "./handlers/orchestration-handler";
import {
  isPartialPromptOutputError,
  summarizeTransportError,
} from "./transport-diagnostics";
import { handleHelp, handleInvalidCommand } from "./handlers/help-handler";
import { handleAgents, handleAgentAdd, handleAgentRemove } from "./handlers/agent-handler";
import { handleWorkspaces, handleWorkspaceCreate, handleWorkspaceRemove } from "./handlers/workspace-handler";
import { handleSessionShortcutCommand } from "./handlers/session-shortcut-handler";
import { handleNativeSessionList, handleNativeSessionSelect } from "./handlers/native-session-handler";
import { handleLaterHelp, handleLaterCreate, handleLaterList, handleLaterCancel } from "./handlers/later-handler";
import { t } from "../i18n";
import { renderSessionCreationError, renderSessionCreationVerificationError, renderTransportError, tryRecoverMissingSession } from "./handlers/session-recovery-handler";
import { autoInstallOptionalDep as defaultAutoInstall } from "../recovery/auto-install-optional-dep";
import { discoverParentPackagePaths as defaultDiscoverPaths } from "../recovery/discover-parent-package-paths";
import { AutoInstallFailedError } from "../recovery/errors";
import { handleSessionResetCommand } from "./handlers/session-reset-handler";
import type {
  CommandRouterContext,
  RouterResponse,
  ScheduledDeliveryCapabilityOps,
  ScheduledRouterOps,
  SessionInteractionOps,
  SessionLifecycleOps,
  SessionRecoveryOps,
  SessionRenderRecoveryOps,
  SessionResetOps,
  SessionShortcutOps,
  OrchestrationRouterOps,
  WritableConfigStore,
} from "./router-types";
import { renderLaterUnsupportedChannel } from "../scheduled/scheduled-render";
import { TransportInvoker } from "./transport-invoker";

type AutoInstallFn = typeof defaultAutoInstall;
type DiscoverPathsFn = typeof defaultDiscoverPaths;

export class CommandRouter {
  private readonly logger: AppLogger;
  private autoInstall: AutoInstallFn = defaultAutoInstall;
  private discoverPaths: DiscoverPathsFn = defaultDiscoverPaths;

  __setAutoInstallForTest(fn: AutoInstallFn): void {
    this.autoInstall = fn;
  }

  __setDiscoverPathsForTest(fn: DiscoverPathsFn): void {
    this.discoverPaths = fn;
  }

  private readonly activeTurns?: ActiveTurnRegistry;
  private readonly transportInvoker: TransportInvoker;

  constructor(
    private readonly sessions: SessionService,
    private readonly transport: SessionTransport,
    private readonly config?: AppConfig,
    private readonly configStore?: WritableConfigStore,
    logger?: AppLogger,
    private readonly resolveSessionAgentCommand: SessionAgentCommandResolver = resolveSessionAgentCommandFromIndex,
    private readonly orchestration?: OrchestrationRouterOps,
    private readonly quota?: QuotaManager,
    private readonly scheduled?: ScheduledRouterOps,
    private readonly scheduledDelivery?: ScheduledDeliveryCapabilityOps,
    private readonly resolveNativeSessionListFormat?: (chatKey: string) => "cards" | "table",
    activeTurns?: ActiveTurnRegistry,
  ) {
    this.logger = logger ?? createNoopAppLogger();
    this.activeTurns = activeTurns;
    // Late-binding forwarding lambdas (not direct field references): autoInstall/
    // discoverPaths are mutable fields swapped post-construction by
    // __setAutoInstallForTest/__setDiscoverPathsForTest (recovery tests, oracle
    // scenario 18). Capturing the values here would freeze the pre-swap default.
    this.transportInvoker = new TransportInvoker({
      transport: this.transport,
      logger: this.logger,
      config: this.config,
      sessions: this.sessions,
      resolveSessionAgentCommand: this.resolveSessionAgentCommand,
      autoInstall: (...a) => this.autoInstall(...a),
      discoverPaths: (...a) => this.discoverPaths(...a),
    });
  }

  async handle(
    chatKey: string,
    input: string,
    reply?: (text: string) => Promise<void>,
    replyContextToken?: string,
    accountId?: string,
    media?: PromptMediaInput,
    metadata?: ChatRequestMetadata,
    abortSignal?: AbortSignal,
    onToolEvent?: (event: ToolUseEvent) => void | Promise<void>,
    onThought?: (chunk: string) => void | Promise<void>,
    perfSpan?: PerfSpan,
    onPlan?: (entries: PlanEntry[]) => void | Promise<void>,
    onUsage?: (usage: PromptUsage) => void | Promise<void>,
    onCommands?: (commands: AgentCommand[]) => void | Promise<void>,
  ): Promise<RouterResponse> {
    const startedAt = Date.now();
    let command = parseCommand(input);
    // GUI-first clients (relay-web and other structured control consumers) drive the
    // console through the dashboard, not through xacpx slash commands. So anything the
    // user types in the web chat box — including `/`-prefixed text — is forwarded
    // verbatim to the agent instead of being interpreted by xacpx. WeChat/Feishu and
    // other chat channels have no GUI and still depend on xacpx commands, so this
    // passthrough is scoped to the control channel (set by the control service for
    // every structured-control turn; see docs/control-module.md).
    //
    // Exception: `session.reset` (`/clear`, `/session reset`) stays xacpx-handled even on
    // the control channel. The web GUI has no other "clear/reset session" entry, and codex
    // (and other ACP agents) don't interpret `/clear` themselves — forwarding it verbatim
    // would silently no-op. Reset is side-effecting on the xacpx session model (recreates
    // the transport session, preserving native), so it must not be sent to the agent as text.
    if (metadata?.channel === "control" && command.kind !== "prompt" && command.kind !== "session.reset") {
      command = { kind: "prompt", text: input.trim() };
    }
    await this.logger.debug("command.parsed", "parsed inbound command", {
      chatKey,
      kind: command.kind,
    });

    // No per-message config reload here. Out-of-band config edits (CLI
    // `xacpx workspace add`, manual config.json edits — including ownerIds)
    // are picked up by the config watcher in main.ts, which refreshes this
    // router's shared AppConfig object in place within ~100ms of the file
    // change. In-process edits (`/config set`, control-API agent/workspace
    // writes) update the same object synchronously. Reloading from disk on
    // every inbound message was a full read + parse + config rebuild on the
    // hot path for no additional freshness.

    // Single seam for channel-turn ownership: the effective metadata (with
    // ownerIds applied) is what gets authorized AND what flows down to the
    // handlers, so the coordinator route records the per-turn effective
    // isOwner instead of whatever a previous turn left behind.
    metadata = withEffectiveOwner(metadata, this.config);

    const access = authorizeCommandForChat(command, metadata);
    perfSpan?.mark("router.authorized", { decision: access.allowed ? "allow" : "deny" });
    if (!access.allowed) {
      if (access.reason === "chat-type-missing") {
        await this.logger.error(
          "channel.chat_type_missing",
          "channel turn carried no chatType; denying privileged command (channel metadata contract violation)",
          {
            chatKey,
            kind: command.kind,
            channel: metadata?.channel,
            senderId: metadata?.senderId,
          },
        );
      }
      await this.logger.info("command.blocked", "blocked command by chat policy", {
        chatKey,
        kind: command.kind,
        reason: access.reason,
        channel: metadata?.channel,
        senderId: metadata?.senderId,
      });
      return { text: renderCommandAccessDenied(command, access.reason) };
    }

    return await this.executeCommand(chatKey, command.kind, startedAt, async () => {
      switch (command.kind) {
        case "invalid":
          return handleInvalidCommand(command.recognizedCommand);
        case "help":
          return handleHelp(command.topic);
        case "agents":
          return handleAgents(this.createHandlerContext());
        case "agent.add":
          return await handleAgentAdd(this.createHandlerContext(), command.template, command.model);
        case "agent.rm":
          return await handleAgentRemove(this.createHandlerContext(), command.name);
        case "permission.status":
          return handlePermissionStatus(this.createHandlerContext());
        case "permission.mode.set":
          return await handlePermissionModeSet(this.createHandlerContext(), command.mode);
        case "permission.auto.status":
          return handlePermissionAutoStatus(this.createHandlerContext());
        case "permission.auto.set":
          return await handlePermissionAutoSet(this.createHandlerContext(), command.policy);
        case "config.show":
          return handleConfigShow(this.createHandlerContext());
        case "config.set":
          return await handleConfigSet(this.createHandlerContext(), command.path, command.value);
        case "workspaces":
          return handleWorkspaces(this.createHandlerContext());
        case "workspace.new":
          return await handleWorkspaceCreate(
            this.createHandlerContext(),
            command.name,
            command.cwd,
            command.raw ? { raw: true } : {},
          );
        case "workspace.rm":
          return await handleWorkspaceRemove(this.createHandlerContext(), command.name);
        case "sessions":
          return await handleSessions(this.createSessionHandlerContext(undefined, perfSpan), chatKey);
        case "session.new":
          return await handleSessionNew(
            this.createSessionHandlerContext(reply, perfSpan),
            chatKey,
            command.alias,
            command.agent,
            command.workspace,
            command.model,
          );
        case "session.shortcut":
          return await handleSessionShortcut(this.createSessionHandlerContext(reply, perfSpan), chatKey, command.agent, command, false);
        case "session.shortcut.new":
          return await handleSessionShortcut(this.createSessionHandlerContext(reply, perfSpan), chatKey, command.agent, command, true);
        case "session.attach":
          return await handleSessionAttach(
            this.createSessionHandlerContext(reply, perfSpan),
            chatKey,
            command.alias,
            command.agent,
            command.workspace,
            command.transportSession,
          );
        case "session.native.list":
          return await handleNativeSessionList(this.createSessionHandlerContext(undefined, perfSpan), chatKey, command);
        case "session.native.select":
          return await handleNativeSessionSelect(this.createSessionHandlerContext(undefined, perfSpan), chatKey, command.identifier, command.alias);
        case "session.native.attach":
          return await handleNativeSessionSelect(this.createSessionHandlerContext(undefined, perfSpan), chatKey, command.identifier, command.alias);
        case "session.use":
          return await handleSessionUse(this.createSessionHandlerContext(undefined, perfSpan), chatKey, command.alias);
        case "session.use.previous":
          return await handleSessionUsePrevious(this.createSessionHandlerContext(undefined, perfSpan), chatKey);
        case "mode.show":
          return await handleModeShow(this.createSessionHandlerContext(undefined, perfSpan), chatKey);
        case "mode.set":
          return await handleModeSet(this.createSessionHandlerContext(undefined, perfSpan), chatKey, command.modeId);
        case "model.show":
          return await handleModelShow(this.createSessionHandlerContext(undefined, perfSpan), chatKey);
        case "model.set":
          return await handleModelSet(this.createSessionHandlerContext(reply, perfSpan), chatKey, command.modelId);
        case "replymode.show":
          return await handleReplyModeShow(this.createSessionHandlerContext(undefined, perfSpan), chatKey);
        case "replymode.set":
          return await handleReplyModeSet(this.createSessionHandlerContext(undefined, perfSpan), chatKey, command.replyMode);
        case "replymode.reset":
          return await handleReplyModeReset(this.createSessionHandlerContext(undefined, perfSpan), chatKey);
        case "status":
          return await handleStatus(this.createSessionHandlerContext(undefined, perfSpan), chatKey);
        case "cancel":
          return await handleCancel(this.createSessionHandlerContext(undefined, perfSpan), chatKey, command.alias);
        case "session.reset":
          // The control channel is GUI-first: don't stream the chat-style "🚀 Starting…"
          // progress pings into the web chat pane — they're mobile-oriented and clash with the
          // web UI. The clean "Session … has been reset" confirmation is still returned as the
          // turn result, and the dashboard refreshes the row via the sessions-changed event.
          // Other channels (no GUI) keep the live progress feedback.
          return await handleSessionReset(
            this.createSessionHandlerContext(metadata?.channel === "control" ? undefined : reply, perfSpan),
            chatKey,
          );
        case "session.tail":
          return await handleSessionTail(this.createSessionHandlerContext(undefined, perfSpan), chatKey, command.lines);
        case "session.rm":
          return await handleSessionRemove(this.createSessionHandlerContext(undefined, perfSpan), chatKey, command.alias);
        case "session.archive":
          return await handleSessionArchive(
            this.createSessionHandlerContext(undefined, perfSpan),
            chatKey,
            command.alias,
            (internalAlias) => this.archiveSessionWithTransport(internalAlias),
          );
        case "groups":
          return await handleGroupList(this.createHandlerContext(), chatKey, command.filter);
        case "group.new":
          return await handleGroupCreate(this.createHandlerContext(), chatKey, command.title);
        case "group.get":
          return await handleGroupGet(this.createHandlerContext(), chatKey, command.groupId);
        case "group.cancel":
          return await handleGroupCancel(this.createHandlerContext(), chatKey, command.groupId);
        case "group.delegate":
          return await handleGroupDelegate(
            this.createHandlerContext(),
            chatKey,
            command.groupId,
            command.targetAgent,
            command.task,
            command.role,
            replyContextToken,
            accountId,
          );
        case "delegate.request":
          return await handleDelegateRequest(
            this.createHandlerContext(),
            chatKey,
            command.targetAgent,
            command.task,
            command.role,
            command.groupId,
            replyContextToken,
            accountId,
          );
        case "tasks":
          return await handleTaskList(this.createHandlerContext(), chatKey, command.filter);
        case "tasks.clean":
          return await handleTasksClean(this.createHandlerContext(), chatKey);
        case "task.get":
          return await handleTaskGet(this.createHandlerContext(), chatKey, command.taskId);
        case "task.approve":
          return await handleTaskApprove(this.createHandlerContext(), chatKey, command.taskId);
        case "task.reject":
          return await handleTaskReject(this.createHandlerContext(), chatKey, command.taskId);
        case "task.cancel":
          return await handleTaskCancel(this.createHandlerContext(), chatKey, command.taskId);
        case "later.help":
          if (!this.scheduled) return { text: t().later.serviceNotEnabled };
          return handleLaterHelp();
        case "later.list":
          if (!this.scheduled) return { text: t().later.serviceNotEnabled };
          return handleLaterList(this.scheduled, chatKey);
        case "later.create": {
          if (!this.scheduled) return { text: t().later.serviceNotEnabled };
          if (this.scheduledDelivery && !this.scheduledDelivery.supportsScheduledMessages(chatKey)) {
            return { text: renderLaterUnsupportedChannel() };
          }
          const currentSession = await this.sessions.getCurrentSession(chatKey);
          return await handleLaterCreate(
            command.tokens,
            command.tails,
            this.scheduled,
            chatKey,
            currentSession
              ? { alias: currentSession.alias, agent: currentSession.agent, workspace: currentSession.workspace }
              : null,
            // Map the config surface ("temp" | "bind") to the internal mode
            // ("temp" | "bound"). Anything other than "bind" (incl. undefined)
            // defaults to temp.
            this.config?.later?.defaultMode === "bind" ? "bound" : "temp",
            accountId,
            replyContextToken,
          );
        }
        case "later.cancel":
          if (!this.scheduled) return { text: t().later.serviceNotEnabled };
          return await handleLaterCancel(command.id, this.scheduled, chatKey);
        case "prompt": {
          const sessionContext = this.createSessionHandlerContext(undefined, perfSpan);
          if (metadata?.scheduledSessionDescriptor) {
            const descriptor = metadata.scheduledSessionDescriptor;
            const transientSession = {
              ...this.sessions.resolveSession(
                descriptor.alias,
                descriptor.agent,
                descriptor.workspace,
                descriptor.transportSession,
              ),
              transient: true,
            };
            return await handlePromptWithSession(
              sessionContext,
              transientSession,
              chatKey,
              command.text,
              reply,
              replyContextToken,
              accountId,
              media,
              abortSignal,
              onToolEvent,
              onThought,
              perfSpan,
              metadata,
              onPlan,
              onUsage,
              onCommands,
            );
          }
          if (metadata?.scheduledSessionAlias) {
            const scheduledSession = await this.sessions.getSession(metadata.scheduledSessionAlias);
            if (!scheduledSession) {
              throw new Error(`session "${metadata.scheduledSessionAlias}" not found for scheduled prompt`);
            }
            return await handlePromptWithSession(
              sessionContext,
              scheduledSession,
              chatKey,
              command.text,
              reply,
              replyContextToken,
              accountId,
              media,
              abortSignal,
              onToolEvent,
              onThought,
              perfSpan,
              metadata,
              onPlan,
              onUsage,
              onCommands,
            );
          }
          return await handlePrompt(
            sessionContext,
            chatKey,
            command.text,
            reply,
            replyContextToken,
            accountId,
            media,
            abortSignal,
            onToolEvent,
            onThought,
            perfSpan,
            metadata,
            onPlan,
            onUsage,
            onCommands,
          );
        }
      }
    });
  }

  async clearSession(chatKey: string): Promise<void> {
    await handleSessionResetCommand(this.createHandlerContext(), this.createSessionResetOps(), chatKey);
  }

  private createHandlerContext(): CommandRouterContext {
    return {
      sessions: this.sessions,
      transport: this.transport,
      orchestration: this.orchestration,
      config: this.config,
      configStore: this.configStore,
      logger: this.logger,
      replaceConfig: (updated) => this.replaceConfig(updated),
      ...(this.quota ? { quota: this.quota } : {}),
      ...(this.resolveNativeSessionListFormat ? { resolveNativeSessionListFormat: this.resolveNativeSessionListFormat } : {}),
    };
  }

  private createSessionHandlerContext(reply?: (text: string) => Promise<void>, perfSpan?: PerfSpan): SessionHandlerContext {
    return {
      ...this.createHandlerContext(),
      lifecycle: this.createSessionLifecycleOps(reply, perfSpan),
      interaction: this.createSessionInteractionOps(perfSpan),
      recovery: this.createSessionRenderRecoveryOps(),
      ...(this.activeTurns ? { activeTurns: this.activeTurns } : {}),
    };
  }


  private createSessionLifecycleOps(reply?: (text: string) => Promise<void>, perfSpan?: PerfSpan): SessionLifecycleOps {
    return {
      resolveSession: (alias, agent, workspace, transportSession) =>
        this.sessions.resolveSession(alias, agent, workspace, transportSession),
      ensureTransportSession: (session, replyOverride, perfSpanOverride) => this.transportInvoker.ensureTransportSession(session, replyOverride ?? reply, perfSpanOverride ?? perfSpan),
      checkTransportSession: (session) => this.transportInvoker.checkTransportSession(session),
      markSessionReady: () => perfSpan?.mark("session.ready"),
      reserveTransportSession: (transportSession) => this.reserveLogicalTransportSession(transportSession),
      handleSessionShortcut: async (chatKey, agent, target, createNew, replyOverride) => {
        try {
          return await handleSessionShortcutCommand(this.createHandlerContext(), this.createSessionShortcutOps(replyOverride ?? reply, perfSpan), chatKey, agent, target, createNew);
        } catch (err) {
          if (err instanceof AutoInstallFailedError) {
            // Find a dummy session for rendering — use agent/workspace as best-effort
            const session = this.sessions.resolveSession(`${agent}`, agent, target.workspace ?? "", `${agent}`);
            return renderSessionCreationError(session, err);
          }
          throw err;
        }
      },
      resetCurrentSession: (chatKey, replyOverride) => handleSessionResetCommand(this.createHandlerContext(), this.createSessionResetOps(replyOverride ?? reply, perfSpan), chatKey),
      refreshSessionTransportAgentCommand: (alias) => this.transportInvoker.refreshSessionTransportAgentCommand(alias),
    };
  }

  /**
   * Create a session through the FULL transport lifecycle (resolve → reserve →
   * ensure acpx named session → verify → bind logical session → refresh agent
   * command), with no chat reply/progress. Used by the relay control surface so a
   * dashboard-created session is immediately promptable, exactly like `/ss new`.
   * `internalAlias` must already be channel-scoped (e.g. "relay:demo").
   */
  async createSessionWithTransport(
    internalAlias: string,
    agent: string,
    workspace: string,
    model?: string,
  ): Promise<ResolvedSession> {
    // Refuse to overwrite an existing alias: silently re-pointing it would either
    // reuse the old transport session (stale history) or orphan it, and a native
    // session's agent_session_id would be silently dropped. Mirrors handleSessionNew.
    const existing = this.sessions.getResolvedSessionByInternalAlias(internalAlias);
    if (existing) {
      throw new Error(`session "${internalAlias}" already exists`);
    }

    const session = this.sessions.resolveSession(
      internalAlias,
      agent,
      workspace,
      `${workspace}:${internalAlias}`,
    );
    // An explicit model override must be on the ResolvedSession BEFORE
    // ensureTransportSession so acpx creates the session under that model
    // (it carries through as `--model`). Mirrors handleSessionNew.
    const normalizedModel = model?.trim();
    if (normalizedModel) {
      session.model = normalizedModel;
    }
    const release = await this.reserveLogicalTransportSession(session.transportSession);
    try {
      await this.transportInvoker.ensureTransportSession(session);
      const exists = await this.transportInvoker.checkTransportSession(session);
      if (!exists) {
        throw new Error(`transport session "${session.transportSession}" could not be verified`);
      }
      await this.sessions.attachSession(internalAlias, agent, workspace, session.transportSession);
      if (normalizedModel) {
        await this.sessions.setSessionModel(internalAlias, normalizedModel);
      }
      // Best-effort: a transient refresh failure must not fail a create that has
      // already succeeded, bound, and verified. Mirrors the chat paths' use of
      // refreshSessionTransportAgentCommandBestEffort.
      try {
        await this.transportInvoker.refreshSessionTransportAgentCommand(internalAlias);
      } catch (error) {
        await this.logger.error("session.agent_command_refresh_failed", "failed to refresh session agent command", {
          alias: internalAlias,
          error: error instanceof Error ? error.message : String(error),
        });
      }
      return session;
    } finally {
      await release();
    }
  }

  /** Real delete: logical removal + acpx history delete, guarded so a transport
   *  session shared by another alias is left intact. */
  async removeSessionWithTransport(internalAlias: string): Promise<{
    wasActive: boolean;
    sharedAliasCount: number;
    transportTornDown: boolean;
    transportTeardownWarning?: string;
  }> {
    const session = await this.sessions.getSession(internalAlias);
    if (!session) {
      throw new Error(`session "${internalAlias}" does not exist`);
    }
    // Both delete entry points (this web/control path and chat `handleSessionRemove`)
    // MUST enforce the orchestration blocking-task guard + reference purge, or a
    // coordinator session with in-flight delegated tasks can be irreversibly wiped.
    if (this.orchestration) {
      const blocking = await this.orchestration.listSessionBlockingTasks(session.transportSession);
      if (blocking.length > 0) {
        throw new Error(`session "${internalAlias}" has ${blocking.length} blocking task(s); cancel them before deleting`);
      }
    }
    const sharedAliasCount = this.sessions.countAliasesSharingTransport(session.transportSession, internalAlias);
    const { wasActive } = await this.sessions.removeSession(internalAlias);

    if (this.orchestration) {
      try {
        await this.orchestration.purgeSessionReferences(session.transportSession);
      } catch (error) {
        await this.logger.error("session.orchestration_purge_failed", "failed to purge orchestration references after web remove", {
          alias: internalAlias,
          transportSession: session.transportSession,
          message: error instanceof Error ? error.message : String(error),
        });
      }
    }

    let transportTornDown = false;
    let transportTeardownWarning: string | undefined;
    if (sharedAliasCount === 0 && this.transport.deleteSession) {
      try {
        await this.transport.deleteSession(session);
        transportTornDown = true;
      } catch (error) {
        transportTeardownWarning = error instanceof Error ? error.message : String(error);
        await this.logger.error("session.transport_delete_failed", "failed to delete acpx session after logical remove", {
          alias: internalAlias,
          transportSession: session.transportSession,
          message: transportTeardownWarning,
        });
      }
    }
    return {
      wasActive,
      sharedAliasCount,
      transportTornDown,
      ...(transportTeardownWarning ? { transportTeardownWarning } : {}),
    };
  }

  /** Archive: cancel any in-flight turn and free the warm queue-owner process
   *  (when no other alias shares the transport), but keep the acpx session open
   *  and resumable, then flag the logical session archived. Re-prompting later
   *  resumes the same conversation with full history; the first post-archive
   *  prompt cold-starts a fresh queue owner. */
  async archiveSessionWithTransport(internalAlias: string): Promise<void> {
    const session = await this.sessions.getSession(internalAlias);
    if (!session) {
      throw new Error(`session "${internalAlias}" does not exist`);
    }
    // Archiving cancels any in-flight turn but deliberately KEEPS the acpx session
    // alive, so re-prompting later resumes the same conversation with full agent
    // context + history. Refuse while a turn is in flight so we don't race (and
    // silently abort) the running prompt.
    if (this.activeTurns?.isActiveAnywhere(internalAlias)) {
      throw new Error(`session "${internalAlias}" has a running turn; stop it before archiving`);
    }
    const shared = this.sessions.countAliasesSharingTransport(session.transportSession, internalAlias) > 0;
    if (!shared) {
      try {
        await this.transport.cancel(session);
      } catch {
        /* best-effort */
      }
      // Free the warm queue-owner process now instead of waiting for acpx's TTL to
      // idle it out. freeWarmProcess kills ONLY the owner process — it does NOT
      // `sessions close` the record (no `closed` flag), so the session stays open
      // and the next prompt resumes the same conversation with full history,
      // repeatably across archive→restore cycles. Best-effort: on failure the
      // process simply lingers until TTL (the prior behavior), never a regression.
      try {
        await this.transport.freeWarmProcess?.(session);
      } catch (error) {
        await this.logger.error(
          "session.free_warm_process_failed",
          "failed to free warm queue-owner on archive",
          {
            alias: internalAlias,
            transportSession: session.transportSession,
            message: error instanceof Error ? error.message : String(error),
          },
        );
      }
    }
    await this.sessions.setArchived(internalAlias, true);
  }

  /** Explicit un-archive (web undo / manual). No process action — it resumes on the
   *  next message via useSession. */
  async unarchiveSession(internalAlias: string): Promise<void> {
    await this.sessions.setArchived(internalAlias, false);
  }

  /**
   * List the agent-native (acpx-owned) sessions for a given agent + workspace, for the
   * web "attach a native session" picker. Resolves the workspace's cwd from config and
   * the agent's runtime command, then queries the transport, filtered to that cwd.
   * Returns [] when the transport doesn't support native listing.
   */
  async listNativeSessionsForControl(agent: string, workspace: string): Promise<AgentSession[]> {
    const listAgentSessions = this.transport.listAgentSessions?.bind(this.transport);
    if (!listAgentSessions) return [];
    const agentConfig = this.config?.agents[agent];
    const workspaceConfig = this.config?.workspaces[workspace];
    if (!agentConfig || !workspaceConfig) {
      throw new Error(`unknown agent "${agent}" or workspace "${workspace}"`);
    }
    const agentCommand = resolveRuntimeAgentCommand(
      agentConfig.driver,
      agentConfig.command,
      this.config?.transport.preferLocalAgents !== false,
    );
    const result = await listAgentSessions({
      agent,
      ...(agentCommand ? { agentCommand } : {}),
      ...(agentConfig.driver ? { driver: agentConfig.driver } : {}),
      cwd: workspaceConfig.cwd,
      filterCwd: workspaceConfig.cwd,
    });
    return result?.sessions ?? [];
  }

  /**
   * Create a logical session bound to an EXISTING agent-native session (resume) — the
   * web counterpart of `/ssn` → select. Mirrors createSessionWithTransport but resumes
   * the given agentSessionId and records the binding as a native ("agent-side")
   * attachment. `internalAlias` must already be channel-scoped (e.g. "relay:demo").
   */
  async attachNativeSessionWithTransport(
    internalAlias: string,
    agent: string,
    workspace: string,
    agentSessionId: string,
    nativeMeta?: { title?: string | null; updatedAt?: string },
  ): Promise<ResolvedSession> {
    if (!this.transport.resumeAgentSession) {
      throw new Error("the active transport does not support native sessions");
    }
    const existing = this.sessions.getResolvedSessionByInternalAlias(internalAlias);
    if (existing) {
      throw new Error(`session "${internalAlias}" already exists`);
    }
    const session = this.sessions.resolveSession(
      internalAlias,
      agent,
      workspace,
      `${workspace}:${internalAlias}`,
    );
    const release = await this.reserveLogicalTransportSession(session.transportSession);
    try {
      await this.transport.resumeAgentSession(session, agentSessionId);
      const exists = await this.transportInvoker.checkTransportSession(session);
      if (!exists) {
        throw new Error(`transport session "${session.transportSession}" could not be verified`);
      }
      await this.sessions.attachNativeSession({
        alias: internalAlias,
        agent,
        workspace,
        transportSession: session.transportSession,
        agentSessionId,
        ...(nativeMeta?.title !== undefined ? { title: nativeMeta.title } : {}),
        ...(nativeMeta?.updatedAt !== undefined ? { updatedAt: nativeMeta.updatedAt } : {}),
      });
      // Best-effort: a transient refresh failure must not fail an attach that already
      // succeeded, resumed, and verified. Mirrors createSessionWithTransport.
      try {
        await this.transportInvoker.refreshSessionTransportAgentCommand(internalAlias);
      } catch (error) {
        await this.logger.error("session.native.agent_command_refresh_failed", "failed to refresh native session agent command", {
          alias: internalAlias,
          error: error instanceof Error ? error.message : String(error),
        });
      }
      return session;
    } finally {
      await release();
    }
  }

  private createSessionInteractionOps(perfSpan?: PerfSpan): SessionInteractionOps {
    return {
      setModeTransportSession: (session, modeId) => this.transportInvoker.setModeTransportSession(session, modeId),
      setModelTransportSession: (session, modelId) => this.transportInvoker.setModelTransportSession(session, modelId),
      getModelTransportSession: (session) => this.transportInvoker.getModelTransportSession(session),
      cancelTransportSession: (session) => this.transportInvoker.cancelTransportSession(session),
      promptTransportSession: (session, text, reply, replyContext, media, abortSignal, onToolEvent, onThought, perfSpanOverride, onPlan, onUsage, onCommands) =>
        this.transportInvoker.promptTransportSession(session, text, reply, replyContext, media, abortSignal, onToolEvent, onThought, perfSpanOverride ?? perfSpan, onPlan, onUsage, onCommands),
    };
  }

  private createSessionRenderRecoveryOps(): SessionRenderRecoveryOps {
    return {
      renderSessionCreationError: (session, error) => renderSessionCreationError(session, error),
      renderSessionCreationVerificationError: (session) => renderSessionCreationVerificationError(session),
      tryRecoverMissingSession: (session, error) => tryRecoverMissingSession(this.createSessionRecoveryOps(), session, error),
      renderTransportError: (session, error) => renderTransportError(session, error),
    };
  }

  private createSessionResetOps(reply?: (text: string) => Promise<void>, perfSpan?: PerfSpan): SessionResetOps {
    return {
      ensureTransportSession: (session, replyOverride, perfSpanOverride) => this.transportInvoker.ensureTransportSession(session, replyOverride ?? reply, perfSpanOverride ?? perfSpan),
      checkTransportSession: (session) => this.transportInvoker.checkTransportSession(session),
      reserveTransportSession: (transportSession) => this.reserveLogicalTransportSession(transportSession),
      resolveSession: (alias, agent, workspace, transportSession) =>
        this.sessions.resolveSession(alias, agent, workspace, transportSession),
      refreshSessionTransportAgentCommand: (alias) => this.transportInvoker.refreshSessionTransportAgentCommand(alias),
      now: () => Date.now(),
    };
  }

  private createSessionRecoveryOps(): SessionRecoveryOps {
    return {
      resolveSessionAgentCommand: (session) => this.resolveSessionAgentCommand(session),
      setSessionTransportAgentCommand: (alias, command) => this.sessions.setSessionTransportAgentCommand(alias, command),
      getSession: (alias) => this.sessions.getSession(alias),
    };
  }

  private createSessionShortcutOps(reply?: (text: string) => Promise<void>, perfSpan?: PerfSpan): SessionShortcutOps {
    return {
      resolveSession: (alias, agent, workspace, transportSession) =>
        this.sessions.resolveSession(alias, agent, workspace, transportSession),
      ensureTransportSession: (session, replyOverride, perfSpanOverride) => this.transportInvoker.ensureTransportSession(session, replyOverride ?? reply, perfSpanOverride ?? perfSpan),
      checkTransportSession: (session) => this.transportInvoker.checkTransportSession(session),
      reserveTransportSession: (transportSession) => this.reserveLogicalTransportSession(transportSession),
      refreshSessionTransportAgentCommand: (alias) => this.transportInvoker.refreshSessionTransportAgentCommand(alias),
    };
  }

  private async reserveLogicalTransportSession(transportSession: string): Promise<() => Promise<void>> {
    if (this.orchestration?.reserveLogicalTransportSession) {
      return await this.orchestration.reserveLogicalTransportSession(transportSession);
    }
    return async () => {};
  }

  private replaceConfig(updated: AppConfig): void {
    if (!this.config) {
      return;
    }

    // Replace reference to prevent mutation of caller's object
    this.config.transport = { ...updated.transport };
    this.config.logging = { ...updated.logging };
    this.config.channel = {
      ...updated.channel,
      ...(updated.channel.options ? { options: { ...updated.channel.options } } : {}),
    };
    this.config.channels = updated.channels.map((channel) => ({
      ...channel,
      ...(channel.options ? { options: { ...channel.options } } : {}),
    }));
    this.config.plugins = updated.plugins.map((plugin) => ({ ...plugin }));
    this.config.agents = { ...updated.agents };
    this.config.workspaces = { ...updated.workspaces };
    this.config.orchestration = {
      ...updated.orchestration,
      allowedAgentRequestTargets: [...updated.orchestration.allowedAgentRequestTargets],
      allowedAgentRequestRoles: [...updated.orchestration.allowedAgentRequestRoles],
    };
    this.config.language = updated.language;
  }

  private async executeCommand(
    chatKey: string,
    kind: string,
    startedAt: number,
    operation: () => Promise<RouterResponse>,
  ): Promise<RouterResponse> {
    try {
      const response = await operation();
      await this.logger.info("command.completed", "completed command handling", {
        chatKey,
        kind,
        durationMs: Date.now() - startedAt,
      });
      return response;
    } catch (error) {
      await this.logger.error("command.failed", "command handling failed", {
        chatKey,
        kind,
        durationMs: Date.now() - startedAt,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }
}
