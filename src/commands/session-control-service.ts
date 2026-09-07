import type { ActiveTurnRegistry } from "../sessions/active-turn-registry.js";
import type { AppConfig } from "../config/types";
import type { AppLogger } from "../logging/app-logger";
import type { SessionService } from "../sessions/session-service";
import type { AgentSession, ResolvedSession, SessionTransport } from "../transport/types";
import { resolveConfiguredAgentLaunch } from "../config/resolve-agent-command";
import { convergeProvisionalCreate, convergeProvisionalNativeAttach, removeAliasWithPhysicalLifecycle } from "./session-remove-lifecycle";
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
   * `internalAlias` must already be channel-scoped (e.g. "relay:demo"). When the
   * desired alias is already taken (by an active OR archived session), a numeric
   * suffix (`-2`, `-3`, …) is automatically appended; the caller can inspect the
   * returned session's `alias` field to find the final choice.
   */
  async createSessionWithTransport(
    internalAlias: string,
    agent: string,
    workspace: string,
    model?: string,
  ): Promise<ResolvedSession> {
    const reserved = this.sessions.tryReserveFreeSessionAlias(internalAlias);
    if (!reserved) {
      throw new Error(`session "${internalAlias}" already exists and could not derive a free alias`);
    }
    const { alias: finalInternalAlias, release: releaseAliasReservation } = reserved;

    try {
      const stableTransportSession = `${workspace}:${finalInternalAlias}`;
      const launchProbe = this.sessions.resolveSession(
        finalInternalAlias,
        agent,
        workspace,
        this.sessions.buildFreshTransportSession(stableTransportSession),
        { guardAcpOutput: true },
      );
      const normalizedModel = model?.trim();
      // R1 + coordinator TOCTOU: reserve BEFORE any logical row appears.
      const release = await this.reserveLogicalTransportSession(stableTransportSession);
      let persisted: ResolvedSession;
      let transportSucceeded = false;
      try {
        try {
          persisted = await this.sessions.attachSession(
            finalInternalAlias,
            agent,
            workspace,
            launchProbe.transportSession,
            launchProbe.agentCommand,
            launchProbe.acpxAgent,
            launchProbe.agentArgv,
          );
          if (normalizedModel) {
            await this.sessions.setSessionModel(finalInternalAlias, normalizedModel);
            const refreshed = this.sessions.getResolvedSessionByInternalAlias(finalInternalAlias);
            if (refreshed) persisted = refreshed;
            else persisted.model = normalizedModel;
          }
        } catch (error) {
          // Engine resolution fails before any owner — no ghost to rollback
          throw error;
        }
        if (normalizedModel) {
          persisted.model = normalizedModel;
        }
        try {
          await this.invoker.ensureTransportSession(persisted);
          const exists = await this.invoker.checkTransportSession(persisted);
          if (!exists) {
            await this.cleanupProvisionalCreate(persisted, finalInternalAlias);
            throw new Error(`transport session "${persisted.transportSession}" could not be verified`);
          }
          transportSucceeded = true;
          // Best-effort: a transient refresh failure must not fail a create that has
          // already succeeded, bound, and verified. Mirrors the chat paths' use of
          // refreshSessionTransportAgentCommandBestEffort.
          try {
            await this.invoker.refreshSessionTransportAgentCommand(finalInternalAlias);
          } catch (error) {
            await this.logger.error("session.agent_command_refresh_failed", "failed to refresh session agent command", {
              alias: finalInternalAlias,
              error: error instanceof Error ? error.message : String(error),
            });
          }
          return persisted;
        } catch (error) {
          if (!transportSucceeded) {
            await this.cleanupProvisionalCreate(persisted, finalInternalAlias, error);
          }
          throw error;
        }
      } finally {
        await release();
      }
    } finally {
      releaseAliasReservation();
    }
  }

  /**
   * Converge a failed create's provisional physical incarnation BEFORE the
   * logical row disappears (shared primitive in session-remove-lifecycle: a
   * daemon-side timeout is not a bridge-side cancellation). If the cleanup
   * cannot be verified, the logical row is kept and the combined failure
   * propagates for retry/delete.
   */
  private async cleanupProvisionalCreate(
    persisted: ResolvedSession,
    finalInternalAlias: string,
    cause?: unknown,
  ): Promise<void> {
    await convergeProvisionalCreate({
      sessions: this.sessions,
      transport: this.transport,
      session: persisted,
      internalAlias: finalInternalAlias,
      ...(cause !== undefined ? { cause } : {}),
    });
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
    // Same lifecycle contract as the chat remove path: every alias goes
    // through the physical-group remove transaction (recount, engine
    // settle, durable logical remove — all under one group lock).
    const outcome = await removeAliasWithPhysicalLifecycle({
      sessions: this.sessions,
      transport: this.transport,
      session,
      internalAlias,
    });
    const { wasActive } = outcome;
    const physicalSharedCount = outcome.sharedAliasCount;

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

    // Transport state was settled inside the transaction above. Runtime
    // failures threw before the logical row disappeared; CLI keeps its
    // legacy best-effort warning, surfaced by the helper outcome.
    const transportTeardownWarning = outcome.transportTeardownWarning;
    const transportTornDown = outcome.action === "deleted" && transportTeardownWarning === undefined;
    if (transportTeardownWarning) {
      await this.logger.error("session.transport_delete_failed", "failed to delete acpx session after logical remove", {
        alias: internalAlias,
        transportSession: session.transportSession,
        message: transportTeardownWarning,
      });
    }
    return {
      wasActive,
      sharedAliasCount: physicalSharedCount,
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
   * When the desired alias is already taken (by an active OR archived session), a
   * numeric suffix is automatically appended; inspect the returned session's `alias`
   * to see the final name.
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
    // Deliberately skip the transport-uniqueness derivation that the chat-side
    // /ssn handler performs before atomic reservation: the transport uniqueness
    // constraint is advisory for native attach and never a correctness barrier.
    // Using tryReserveFreeSessionAlias directly keeps this path deterministic
    // and lets us surface the same "suffix auto-derived" semantics as chat-side
    // creation when the logical alias collides with an archived session.
    const reserved = this.sessions.tryReserveFreeSessionAlias(internalAlias);
    if (!reserved) {
      throw new Error(`session "${internalAlias}" already exists and could not derive a free alias`);
    }
    const { alias: finalInternalAlias, release: releaseAliasReservation } = reserved;
    try {
      const launchProbe = this.sessions.resolveSession(
        finalInternalAlias,
        agent,
        workspace,
        `${workspace}:${finalInternalAlias}`,
        { guardAcpOutput: true },
      );
      const release = await this.reserveLogicalTransportSession(launchProbe.transportSession);
      let persisted: ResolvedSession;
      try {
        try {
          persisted = await this.sessions.attachNativeSession({
            alias: finalInternalAlias,
            agent,
            workspace,
            transportSession: launchProbe.transportSession,
            ...(launchProbe.agentCommand ? { transportAgentCommand: launchProbe.agentCommand } : {}),
            ...(launchProbe.acpxAgent ? { transportAcpxAgent: launchProbe.acpxAgent } : {}),
            ...(launchProbe.agentArgv ? { transportAgentArgv: launchProbe.agentArgv } : {}),
            agentSessionId,
            ...(nativeMeta?.title !== undefined ? { title: nativeMeta.title } : {}),
            ...(nativeMeta?.updatedAt !== undefined ? { updatedAt: nativeMeta.updatedAt } : {}),
          });
        } catch (error) {
          throw error;
        }
        try {
          await this.transport.resumeAgentSession(persisted, agentSessionId);
          const exists = await this.invoker.checkTransportSession(persisted);
          if (!exists) {
            throw new Error(`transport session "${persisted.transportSession}" could not be verified`);
          }
        } catch (error) {
          // Upstream-owned physical session: converge the xacpx provisional
          // incarnation only (release + soft close, never hard-delete the
          // native thread). Unverifiable cleanup keeps the row and the
          // combined failure propagates.
          try {
            await convergeProvisionalNativeAttach({
              sessions: this.sessions,
              transport: this.transport,
              session: persisted,
              internalAlias: persisted.alias,
              cause: error,
            });
          } catch (cleanupError) {
            await this.logger.error("session.native.rollback_failed", "failed to converge provisional native incarnation", {
              alias: persisted.alias,
              error: cleanupError instanceof Error ? cleanupError.message : String(cleanupError),
            });
            throw cleanupError;
          }
          throw error;
        }
        // Best-effort: a transient refresh failure must not fail an attach that already
        // succeeded, resumed, and verified. Mirrors createSessionWithTransport.
        try {
          await this.invoker.refreshSessionTransportAgentCommand(finalInternalAlias);
        } catch (error) {
          await this.logger.error("session.native.agent_command_refresh_failed", "failed to refresh native session agent command", {
            alias: finalInternalAlias,
            error: error instanceof Error ? error.message : String(error),
          });
        }
        return persisted;
      } finally {
        await release();
      }
    } finally {
      releaseAliasReservation();
    }
  }
}
