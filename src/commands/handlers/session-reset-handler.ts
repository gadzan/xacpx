import type { CommandRouterContext, RouterResponse, SessionResetOps } from "../router-types";
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
    const wasNative = previous.source === "agent-side";

    const stableTransportSession = stableCoordinatorSession(previous.transportSession);
    const resetSession = ops.resolveSession(
      previous.alias,
      previous.agent,
      previous.workspace,
      context.sessions.buildFreshTransportSession(stableTransportSession),
    );

    const releaseTransportReservation = await ops.reserveTransportSession(stableTransportSession);
    try {
      try {
        await ops.ensureTransportSession(resetSession);
        const exists = await ops.checkTransportSession(resetSession);
        if (!exists) {
          return { text: t().misc.sessionResetFailed(previous.alias) };
        }
      } catch (error) {
        return renderTransportError(resetSession, error);
      }

      // Keep a native (agent-side) session native across /clear: the fresh
      // transport session is itself backed by a brand-new agent rollout, so read
      // back its agentSessionId and re-mark the logical session as native. If the
      // agent advertised none (or the read fails), fall back to a plain xacpx
      // session so /clear still succeeds.
      let freshAgentSessionId: string | undefined;
      if (wasNative) {
        try {
          freshAgentSessionId = await context.transport.getAgentSessionId?.(resetSession);
        } catch (error) {
          await context.logger.info(
            "session.reset.native_id_unavailable",
            "failed to read fresh agent session id; falling back to xacpx session",
            { alias: resetSession.alias, error: error instanceof Error ? error.message : String(error) },
          );
        }
      }

      if (wasNative && freshAgentSessionId) {
        await context.sessions.attachNativeSession({
          alias: resetSession.alias,
          agent: resetSession.agent,
          workspace: resetSession.workspace,
          transportSession: resetSession.transportSession,
          agentSessionId: freshAgentSessionId,
          updatedAt: new Date(ops.now()).toISOString(),
        });
      } else {
        await context.sessions.attachSession(
          resetSession.alias,
          resetSession.agent,
          resetSession.workspace,
          resetSession.transportSession,
        );
      }

      await ops.refreshSessionTransportAgentCommand(resetSession.alias);
      await context.sessions.useSession(chatKey, resetSession.alias);
      await context.logger.info("session.reset", "reset current logical session", {
        alias: resetSession.alias,
        agent: resetSession.agent,
        workspace: resetSession.workspace,
        transportSession: resetSession.transportSession,
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

    return { text: t().misc.sessionResetSuccess(resetSession.alias) };
  } finally {
    releaseAliasOperation();
  }
}
