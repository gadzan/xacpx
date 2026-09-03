import type { CommandRouterContext, RouterResponse, SessionResetOps } from "../router-types";
import type { ResolvedSession } from "../../transport/types";
import { renderTransportError } from "./session-recovery-handler";
import { t } from "../../i18n/index.js";
import { stableCoordinatorSession } from "../../orchestration/coordinator-identity";
export async function handleSessionResetCommand(
  context: CommandRouterContext,
  ops: SessionResetOps,
  chatKey: string,
): Promise<RouterResponse> {
  const previous = await context.sessions.getCurrentSession(chatKey);
  if (!previous) {
    return { text: t().misc.sessionResetNoCurrentSession };
  }
  const releaseAliasOperation = context.sessions.tryReserveSessionAliasOperation(previous.alias);
  if (!releaseAliasOperation) {
    return { text: t().misc.sessionResetFailed(previous.alias) };
  }

  try {
    const previousRecord = context.sessions.getLogicalSessionRecord(previous.alias);
    const previousSnapshot = previousRecord ? structuredClone(previousRecord) : null;
    const wasNative = previous.source === "agent-side";

    const stableTransportSession = stableCoordinatorSession(previous.transportSession);
    const freshTransportSession = context.sessions.buildFreshTransportSession(stableTransportSession);

    const releaseTransportReservation = await ops.reserveTransportSession(stableTransportSession);
    let persistedSession: ResolvedSession;
    try {
      if (wasNative) {
        persistedSession = await context.sessions.attachNativeSession({
          alias: previous.alias,
          agent: previous.agent,
          workspace: previous.workspace,
          transportSession: freshTransportSession,
          ...(previous.agentCommand ? { transportAgentCommand: previous.agentCommand } : {}),
          ...(previous.acpxAgent ? { transportAcpxAgent: previous.acpxAgent } : {}),
          ...(previous.agentArgv ? { transportAgentArgv: previous.agentArgv } : {}),
          updatedAt: new Date(ops.now()).toISOString(),
        });
      } else {
        persistedSession = await context.sessions.attachSession(
          previous.alias,
          previous.agent,
          previous.workspace,
          freshTransportSession,
          previous.agentCommand,
          previous.acpxAgent,
          previous.agentArgv,
        );
      }

      try {
        await ops.ensureTransportSession(persistedSession);
        const exists = await ops.checkTransportSession(persistedSession);
        if (!exists) {
          await context.sessions.rollbackSessionRecord(previous.alias, previousSnapshot);
          return { text: t().misc.sessionResetFailed(previous.alias) };
        }
      } catch (error) {
        await context.sessions.rollbackSessionRecord(previous.alias, previousSnapshot);
        return renderTransportError(persistedSession, error);
      }

      // Keep a native (agent-side) session native across /clear: the fresh
      // transport session is itself backed by a brand-new agent rollout, so read
      // back its agentSessionId and re-mark the logical session as native. If the
      // agent advertised none (or the read fails), fall back to a plain xacpx
      // session so /clear still succeeds.
      let freshAgentSessionId: string | undefined;
      if (wasNative) {
        try {
          freshAgentSessionId = await context.transport.getAgentSessionId?.(persistedSession);
        } catch (error) {
          await context.logger.info(
            "session.reset.native_id_unavailable",
            "failed to read fresh agent session id; falling back to xacpx session",
            { alias: persistedSession.alias, error: error instanceof Error ? error.message : String(error) },
          );
        }
      }

      if (wasNative && freshAgentSessionId) {
        await context.sessions.updateNativeAgentSessionId(
          persistedSession.alias,
          freshAgentSessionId,
          new Date(ops.now()).toISOString(),
        );
      } else if (wasNative) {
        await context.sessions.updateNativeAgentSessionId(
          persistedSession.alias,
          undefined,
        );
      }
      await ops.refreshSessionTransportAgentCommand(persistedSession.alias);
      await context.sessions.useSession(chatKey, persistedSession.alias);
      await context.logger.info("session.reset", "reset current logical session", {
        alias: persistedSession.alias,
        agent: persistedSession.agent,
        workspace: persistedSession.workspace,
        transportSession: persistedSession.transportSession,
        chatKey,
        native: wasNative && Boolean(freshAgentSessionId),
      });

      // Best-effort: close the previous transport session (acpx sessions close)
      // to stop its warm owner while keeping its rollout on disk (still
      // reattachable via /ssn, prunable later). Applies to native and plain
      // sessions alike — both orphan a warm owner otherwise. Guarded so we never
      // close a transport another logical alias still uses. Failure must never
      // fail /clear.
      if (
        context.transport.removeSession &&
        context.sessions.countAliasesSharingTransport(previous.transportSession) === 0
      ) {
        try {
          await context.transport.removeSession(previous);
        } catch (error) {
          await context.logger.info(
            "session.reset.close_previous_failed",
            "failed to close previous session after reset",
            {
              transportSession: previous.transportSession,
              error: error instanceof Error ? error.message : String(error),
            },
          );
        }
      }
    } finally {
      await releaseTransportReservation();
    }

    return { text: t().misc.sessionResetSuccess(persistedSession.alias) };
  } finally {
    releaseAliasOperation();
  }
}
