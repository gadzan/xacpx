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
  // A running turn must quiesce before its identity is replaced: swapping
  // the alias to a fresh LID while the old incarnation still runs would
  // report success while old tool calls and side effects continue.
  if (context.activeTurns?.isActiveAnywhere(previous.alias)) {
    return { text: t().misc.sessionResetTurnActive(previous.alias) };
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
          await cleanupFreshIncarnation(context, persistedSession);
          return { text: t().misc.sessionResetFailed(previous.alias) };
        }
      } catch (error) {
        await context.sessions.rollbackSessionRecord(previous.alias, previousSnapshot);
        await cleanupFreshIncarnation(context, persistedSession);
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

      // Retire the previous logical identity as a mandatory participant. For
      // Runtime the old LID owns a worker/fence/journal: releaseLogicalSession
      // stops the worker and drops the old journal, and MUST succeed — a
      // reset that reports success while the old incarnation still runs
      // would keep producing tool calls and side effects under a "reset"
      // session. On failure the alias rolls back to the previous snapshot
      // and the fresh incarnation is converged, exactly like a
      // fresh-ensure failure.
      if (previous.transportEngine === "runtime") {
        if (!context.transport.releaseLogicalSession) {
          await context.sessions.rollbackSessionRecord(previous.alias, previousSnapshot);
          await cleanupFreshIncarnation(context, persistedSession);
          await context.logger.info(
            "session.reset.release_unsupported",
            "active transport cannot release the previous runtime identity; reset refused",
            { transportSession: previous.transportSession },
          );
          return { text: t().misc.sessionResetFailed(previous.alias) };
        }
        try {
          await context.transport.releaseLogicalSession(previous);
        } catch (error) {
          await context.sessions.rollbackSessionRecord(previous.alias, previousSnapshot);
          await cleanupFreshIncarnation(context, persistedSession);
          await context.logger.info(
            "session.reset.release_previous_failed",
            "failed to retire the previous runtime identity; reset rolled back",
            {
              transportSession: previous.transportSession,
              error: error instanceof Error ? error.message : String(error),
            },
          );
          return { text: t().misc.sessionResetFailed(previous.alias) };
        }
      }

      // Best-effort: close the previous physical record (warm owner stop,
      // rollout/history kept on disk, still reattachable via /ssn). Guarded
      // by canonical physical membership — same-name aliases with different
      // cwd/launch are different physical sessions, and worker bindings
      // count as surviving owners — so a record another owner still uses is
      // never closed. Indeterminate membership skips the close (the
      // mandatory LID release above already ran). Failure must never fail
      // /clear.
      let closePrevious = false;
      try {
        const { siblings, indeterminateAliases } = context.sessions.findPhysicalSiblings(previous, previous.alias);
        if (indeterminateAliases.length > 0) {
          await context.logger.info(
            "session.reset.sibling_indeterminate",
            "previous physical membership cannot be proven; keeping the previous record",
            {
              transportSession: previous.transportSession,
              indeterminate: indeterminateAliases.join(","),
            },
          );
        } else {
          closePrevious = siblings.length === 0;
        }
      } catch (error) {
        await context.logger.info(
          "session.reset.sibling_check_failed",
          "failed to check previous physical membership; keeping the previous record",
          {
            transportSession: previous.transportSession,
            error: error instanceof Error ? error.message : String(error),
          },
        );
      }
      if (closePrevious && context.transport.removeSession) {
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

/**
 * Best-effort cleanup of the fresh `/clear` incarnation after the logical
 * record has been rolled back to the previous snapshot. Scoped strictly to
 * the fresh transport identity (`fresh.transportSession`, fresh LID): the
 * previous session keeps its own transport and is never touched. Soft close
 * only (stop the provisional owner, keep rollout/history on disk) — a
 * leftover provisional owner would otherwise linger until TTL/shutdown with
 * no logical owner. Failures are logged, never thrown: the logical rollback
 * above is the correctness boundary.
 */
async function cleanupFreshIncarnation(
  context: CommandRouterContext,
  fresh: ResolvedSession,
): Promise<void> {
  if (!context.transport.removeSession) return;
  try {
    await context.transport.removeSession(fresh);
    await context.logger.info(
      "session.reset.cleaned_fresh_incarnation",
      "cleaned provisional fresh session after reset rollback",
      { transportSession: fresh.transportSession },
    );
  } catch (error) {
    await context.logger.info(
      "session.reset.cleanup_fresh_failed",
      "failed to clean provisional fresh session after reset rollback",
      {
        transportSession: fresh.transportSession,
        error: error instanceof Error ? error.message : String(error),
      },
    );
  }
}
