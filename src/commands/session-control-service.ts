import type { ActiveTurnRegistry } from "../sessions/active-turn-registry.js";
import type { AppConfig } from "../config/types";
import type { AppLogger } from "../logging/app-logger";
import type { SessionService } from "../sessions/session-service";
import type { AgentSession, ResolvedSession, SessionTransport } from "../transport/types";
import { resolveConfiguredAgentLaunch } from "../config/resolve-agent-command";
import type { OrchestrationRouterOps } from "./router-types";
import type { TransportInvoker } from "./transport-invoker";

export interface SessionControlServiceDeps {
  sessions: SessionService;
  transport: SessionTransport;
  orchestration?: OrchestrationRouterOps;
  activeTurns?: ActiveTurnRegistry;
  config?: AppConfig;
  logger: AppLogger;
  invoker: TransportInvoker;
  reserveLogicalTransportSession: (transportSession: string) => Promise<() => Promise<void>>;
}

export class SessionControlService {
  private readonly sessions: SessionService;
  private readonly transport: SessionTransport;
  private readonly orchestration?: OrchestrationRouterOps;
  private readonly activeTurns?: ActiveTurnRegistry;
  private readonly config?: AppConfig;
  private readonly logger: AppLogger;
  private readonly invoker: TransportInvoker;
  private readonly reserveLogicalTransportSession: (transportSession: string) => Promise<() => Promise<void>>;

  constructor(deps: SessionControlServiceDeps) {
    this.sessions = deps.sessions;
    this.transport = deps.transport;
    this.orchestration = deps.orchestration;
    this.activeTurns = deps.activeTurns;
    this.config = deps.config;
    this.logger = deps.logger;
    this.invoker = deps.invoker;
    this.reserveLogicalTransportSession = deps.reserveLogicalTransportSession;
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
    const releaseAliasReservation = this.sessions.tryReserveNewSessionAlias(internalAlias);
    if (!releaseAliasReservation) {
      throw new Error(`session "${internalAlias}" already exists`);
    }

    try {
      const stableTransportSession = `${workspace}:${internalAlias}`;
      const session = this.sessions.resolveSession(
        internalAlias,
        agent,
        workspace,
        this.sessions.buildFreshTransportSession(stableTransportSession),
      );
      // An explicit model override must be on the ResolvedSession BEFORE
      // ensureTransportSession so acpx creates the session under that model
      // (it carries through as `--model`). Mirrors handleSessionNew.
      const normalizedModel = model?.trim();
      if (normalizedModel) {
        session.model = normalizedModel;
      }
      // Reserve the stable coordinator identity rather than the incarnation-specific
      // name. This preserves conflict detection with external coordinators while the
      // transport name itself can rotate on every explicit create.
      const release = await this.reserveLogicalTransportSession(stableTransportSession);
      try {
        await this.invoker.ensureTransportSession(session);
        const exists = await this.invoker.checkTransportSession(session);
        if (!exists) {
          throw new Error(`transport session "${session.transportSession}" could not be verified`);
        }
        await this.sessions.attachSession(
          internalAlias,
          agent,
          workspace,
          session.transportSession,
          session.agentCommand,
          session.acpxAgent,
          session.agentArgv,
        );
        if (normalizedModel) {
          await this.sessions.setSessionModel(internalAlias, normalizedModel);
        }
        // Best-effort: a transient refresh failure must not fail a create that has
        // already succeeded, bound, and verified. Mirrors the chat paths' use of
        // refreshSessionTransportAgentCommandBestEffort.
        try {
          await this.invoker.refreshSessionTransportAgentCommand(internalAlias);
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
    } finally {
      releaseAliasReservation();
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
    const releaseAliasOperation = this.sessions.tryReserveSessionAliasOperation(internalAlias);
    if (!releaseAliasOperation) {
      throw new Error(`session "${internalAlias}" has another lifecycle operation in progress`);
    }
    try {
      return await this.removeSessionWithTransportUnderAliasClaim(internalAlias);
    } finally {
      releaseAliasOperation();
    }
  }

  private async removeSessionWithTransportUnderAliasClaim(internalAlias: string): Promise<{
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
    const launch = resolveConfiguredAgentLaunch(agentConfig, this.config?.transport);
    const result = await listAgentSessions({
      agent,
      ...(launch.agentCommand ? { agentCommand: launch.agentCommand } : {}),
      ...(launch.acpxAgent ? { acpxAgent: launch.acpxAgent } : {}),
      ...(launch.rawCommand ? { rawCommand: launch.rawCommand } : {}),
      ...(agentConfig.driver ? { driver: agentConfig.driver } : {}),
      ...(agentConfig.settingsPolicy ? { settingsPolicy: agentConfig.settingsPolicy } : {}),
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
    const releaseAliasReservation = this.sessions.tryReserveNewSessionAlias(internalAlias);
    if (!releaseAliasReservation) {
      throw new Error(`session "${internalAlias}" already exists`);
    }
    try {
      const session = this.sessions.resolveSession(
        internalAlias,
        agent,
        workspace,
        `${workspace}:${internalAlias}`,
      );
      const release = await this.reserveLogicalTransportSession(session.transportSession);
      try {
        await this.transport.resumeAgentSession(session, agentSessionId);
        const exists = await this.invoker.checkTransportSession(session);
        if (!exists) {
          throw new Error(`transport session "${session.transportSession}" could not be verified`);
        }
        await this.sessions.attachNativeSession({
          alias: internalAlias,
          agent,
          workspace,
          transportSession: session.transportSession,
          ...(session.agentCommand ? { transportAgentCommand: session.agentCommand } : {}),
          ...(session.acpxAgent ? { transportAcpxAgent: session.acpxAgent } : {}),
          ...(session.agentArgv ? { transportAgentArgv: session.agentArgv } : {}),
          agentSessionId,
          ...(nativeMeta?.title !== undefined ? { title: nativeMeta.title } : {}),
          ...(nativeMeta?.updatedAt !== undefined ? { updatedAt: nativeMeta.updatedAt } : {}),
        });
        // Best-effort: a transient refresh failure must not fail an attach that already
        // succeeded, resumed, and verified. Mirrors createSessionWithTransport.
        try {
          await this.invoker.refreshSessionTransportAgentCommand(internalAlias);
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
    } finally {
      releaseAliasReservation();
    }
  }
}
