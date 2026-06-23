import type {
  CommandRouterContext,
  RouterResponse,
  SessionInteractionOps,
  SessionLifecycleOps,
  SessionRenderRecoveryOps,
} from "../router-types";
import type { AgentCommand, PromptMediaInput, PromptUsage, ResolvedSession } from "../../transport/types";
import type { ReplyMode } from "../../config/types";
import type { PlanEntry, ToolUseEvent } from "../../channels/types.js";
import type { PerfSpan } from "../../perf/perf-tracer";
import type { HelpTopicMetadata } from "../help/help-types";
import type { ChatRequestMetadata } from "../../weixin/agent/interface";
import { buildCoordinatorPrompt } from "../../orchestration/build-coordinator-prompt";
import { stableCoordinatorSession } from "../../orchestration/coordinator-identity";
import { toDisplaySessionAlias, getChannelIdFromChatKey, scopeDisplayAliasToInternal, resolveSessionAliasForInput } from "../../channels/channel-scope";
import { resolveChannelDefaultReplyMode, resolveEffectiveReplyMode } from "./resolve-reply-mode";
import { quoteWorkspaceNameIfNeeded } from "../workspace-name";
import type { SessionSwitchResult } from "../../sessions/session-service";
import { decorateUnread } from "./session-list-marker";
import { t } from "../../i18n";

export interface SessionHandlerContext extends CommandRouterContext {
  lifecycle: SessionLifecycleOps;
  interaction: SessionInteractionOps;
  recovery: SessionRenderRecoveryOps;
  readonly activeTurns?: import("../../sessions/active-turn-registry.js").ActiveTurnRegistry;
}

const DEFAULT_SESSION_TAIL_LINES = 50;
const MAX_SESSION_TAIL_LINES = 500;

export function sessionHelp(): HelpTopicMetadata {
  const s = t().session;
  return {
    topic: "session",
    aliases: ["ss", "sessions"],
    summary: s.sessionHelpSummary,
    commands: [
      { usage: s.sessionHelpCmdSsList, description: s.sessionHelpCmdSsListDesc },
      { usage: s.sessionHelpCmdSsOrSlash, description: s.sessionHelpCmdSsOrSlashDesc },
      { usage: s.sessionHelpCmdSsQuick, description: s.sessionHelpCmdSsQuickDesc },
      { usage: s.sessionHelpCmdSsNew, description: s.sessionHelpCmdSsNewDesc },
      { usage: s.sessionHelpCmdSsNewAlias, description: s.sessionHelpCmdSsNewAliasDesc },
      { usage: s.sessionHelpCmdSsAttach, description: s.sessionHelpCmdSsAttachDesc },
      { usage: s.sessionHelpCmdSsn, description: s.sessionHelpCmdSsnDesc },
      { usage: s.sessionHelpCmdTail, description: s.sessionHelpCmdTailDesc },
      { usage: s.sessionHelpCmdRm, description: s.sessionHelpCmdRmDesc },
      { usage: s.sessionHelpCmdUse, description: s.sessionHelpCmdUseDesc },
      { usage: s.sessionHelpCmdUseFuzzy, description: s.sessionHelpCmdUseFuzzyDesc },
      { usage: s.sessionHelpCmdUsePrev, description: s.sessionHelpCmdUsePrevDesc },
      { usage: s.sessionHelpCmdReset, description: s.sessionHelpCmdResetDesc },
    ],
    examples: [
      "/ss codex -d /absolute/path/to/repo",
      "/ssn",
      "/ssn 1",
      "/use backend-fix",
      "/use back",
      "/use -",
      "/session rm old-session",
      "/session reset",
    ],
  };
}

export function nativeSessionHelp(): HelpTopicMetadata {
  const s = t().session;
  return {
    topic: "native",
    aliases: ["ssn", "native-session"],
    summary: s.nativeHelpSummary,
    commands: [
      { usage: s.nativeHelpCmdSsn, description: s.nativeHelpCmdSsnDesc },
      { usage: s.nativeHelpCmdSsnAgentWs, description: s.nativeHelpCmdSsnAgentWsDesc },
      { usage: s.nativeHelpCmdSsnAgentDir, description: s.nativeHelpCmdSsnAgentDirDesc },
      { usage: s.nativeHelpCmdSsnAgentAll, description: s.nativeHelpCmdSsnAgentAllDesc },
      { usage: s.nativeHelpCmdSsnNumber, description: s.nativeHelpCmdSsnNumberDesc },
      { usage: s.nativeHelpCmdSsnNumberAlias, description: s.nativeHelpCmdSsnNumberAliasDesc },
      { usage: s.nativeHelpCmdSsnAttach, description: s.nativeHelpCmdSsnAttachDesc },
      { usage: s.nativeHelpCmdSsnAttachLong, description: s.nativeHelpCmdSsnAttachLongDesc },
    ],
    examples: [
      "/ssn codex --ws backend",
      "/ssn codex -d /absolute/path/to/repo",
      "/ssn",
      "/ssn 1",
      "/ssn 1 -a fix-ci",
    ],
    notes: [
      s.nativeHelpNote1,
      s.nativeHelpNote2,
      s.nativeHelpNote3,
      s.nativeHelpNote4,
    ],
  };
}

export function modeHelp(): HelpTopicMetadata {
  const s = t().session;
  return {
    topic: "mode",
    aliases: [],
    summary: s.modeHelpSummary,
    commands: [
      { usage: s.modeHelpCmdShow, description: s.modeHelpCmdShowDesc },
      { usage: s.modeHelpCmdSet, description: s.modeHelpCmdSetDesc },
    ],
    examples: ["/mode", "/mode plan"],
  };
}

export function modelHelp(): HelpTopicMetadata {
  const s = t().session;
  return {
    topic: "model",
    aliases: [],
    summary: s.modelHelpSummary,
    commands: [
      { usage: s.modelHelpCmdShow, description: s.modelHelpCmdShowDesc },
      { usage: s.modelHelpCmdSet, description: s.modelHelpCmdSetDesc },
    ],
    examples: ["/model", "/model gpt-5.2[high]"],
  };
}

export function replyModeHelp(): HelpTopicMetadata {
  const s = t().session;
  return {
    topic: "replymode",
    aliases: [],
    summary: s.replyModeHelpSummary,
    commands: [
      { usage: s.replyModeHelpCmdShow, description: s.replyModeHelpCmdShowDesc },
      { usage: s.replyModeHelpCmdStream, description: s.replyModeHelpCmdStreamDesc },
      { usage: s.replyModeHelpCmdVerbose, description: s.replyModeHelpCmdVerboseDesc },
      { usage: s.replyModeHelpCmdFinal, description: s.replyModeHelpCmdFinalDesc },
      { usage: s.replyModeHelpCmdReset, description: s.replyModeHelpCmdResetDesc },
    ],
    examples: ["/replymode", "/replymode final", "/replymode verbose"],
  };
}

export function statusHelp(): HelpTopicMetadata {
  const s = t().session;
  return {
    topic: "status",
    aliases: [],
    summary: s.statusHelpSummary,
    commands: [{ usage: s.statusHelpCmdShow, description: s.statusHelpCmdShowDesc }],
    examples: ["/status"],
  };
}

export function cancelHelp(): HelpTopicMetadata {
  const s = t().session;
  return {
    topic: "cancel",
    aliases: ["stop"],
    summary: s.cancelHelpSummary,
    commands: [
      { usage: s.cancelHelpCmdCancel, description: s.cancelHelpCmdCancelDesc },
      { usage: s.cancelHelpCmdCancelAlias, description: s.cancelHelpCmdCancelAliasDesc },
      { usage: s.cancelHelpCmdStop, description: s.cancelHelpCmdStopDesc },
      { usage: s.cancelHelpCmdStopAlias, description: s.cancelHelpCmdStopAliasDesc },
    ],
    examples: ["/cancel", "/cancel backend"],
  };
}

export async function handleSessions(context: SessionHandlerContext, chatKey: string): Promise<RouterResponse> {
  const sessions = await context.sessions.listSessions(chatKey);
  if (sessions.length === 0) {
    const channelId = getChannelIdFromChatKey(chatKey);
    const internalAliases = context.sessions.listInternalAliases();
    const hasOtherChannelSessions = internalAliases.some((alias) => {
      if (channelId !== "weixin" && !alias.includes(":")) {
        return true;
      }
      const prefix = alias.split(":", 1)[0];
      return prefix !== alias && prefix !== channelId;
    });

    const s = t().session;
    const lines = [s.noSessions];
    if (hasOtherChannelSessions) {
      lines.push(s.crossChannelHint);
    }
    lines.push(s.createSessionHint);
    lines.push(s.createSessionExample);
    return { text: lines.join("\n") };
  }

  const s = t().session;
  const unread = new Set(context.sessions.listBackgroundResultAliases(chatKey));
  return {
    text: [
      s.sessionListHeader,
      ...sessions.map((session) =>
        `${s.sessionListItem(decorateUnread(session.alias, unread.has(session.internalAlias)), session.agent, session.workspace)}${session.isCurrent ? ` ${s.currentLabel}` : ""}`,
      ),
    ].join("\n"),
  };
}

export async function handleSessionNew(
  context: SessionHandlerContext,
  chatKey: string,
  alias: string,
  agent: string,
  workspace: string,
  model?: string,
): Promise<RouterResponse> {
  const channelId = getChannelIdFromChatKey(chatKey);
  const internalAlias = scopeDisplayAliasToInternal(channelId, alias);

  // Refuse to overwrite an existing alias: silently re-pointing it would
  // either reuse the old transport session (stale history) or orphan it, and
  // a native session's agent_session_id would be silently dropped. Internal
  // repair paths (resolveSession) intentionally bypass this guard.
  const existing = context.sessions.getResolvedSessionByInternalAlias(internalAlias);
  if (existing) {
    return { text: t().session.sessionAlreadyExists(alias, existing.agent, existing.workspace) };
  }

  const session = context.lifecycle.resolveSession(internalAlias, agent, workspace, `${workspace}:${internalAlias}`);
  // An explicit --model overrides the agent default for this session, and must be
  // on the ResolvedSession before ensureTransportSession so acpx creates the
  // session under that model.
  const normalizedModel = model?.trim();
  if (normalizedModel) {
    session.model = normalizedModel;
  }
  const releaseTransportReservation = await context.lifecycle.reserveTransportSession(session.transportSession);
  try {
    try {
      await context.lifecycle.ensureTransportSession(session);
      const exists = await context.lifecycle.checkTransportSession(session);
      if (!exists) {
        return context.recovery.renderSessionCreationVerificationError(session);
      }
    } catch (error) {
      return context.recovery.renderSessionCreationError(session, error);
    }

    await context.sessions.attachSession(internalAlias, agent, workspace, session.transportSession);
    if (normalizedModel) {
      await context.sessions.setSessionModel(internalAlias, normalizedModel);
    }
    await context.sessions.useSession(chatKey, internalAlias);
    await refreshSessionTransportAgentCommandBestEffort(context, internalAlias, "session.agent_command_refresh_failed");
    await context.logger.info("session.created", "created and selected logical session", {
      alias: internalAlias,
      agent,
      workspace,
    });
    return { text: t().session.sessionCreated(alias) };
  } finally {
    await releaseTransportReservation();
  }
}

export async function handleSessionShortcut(
  context: SessionHandlerContext,
  chatKey: string,
  agent: string,
  target: { cwd?: string; workspace?: string },
  createNew: boolean,
): Promise<RouterResponse> {
  return await context.lifecycle.handleSessionShortcut(chatKey, agent, target, createNew);
}

export async function handleSessionAttach(
  context: SessionHandlerContext,
  chatKey: string,
  alias: string,
  agent: string,
  workspace: string,
  transportSession: string,
): Promise<RouterResponse> {
  const channelId = getChannelIdFromChatKey(chatKey);
  const internalAlias = scopeDisplayAliasToInternal(channelId, alias);
  const attached = context.lifecycle.resolveSession(internalAlias, agent, workspace, transportSession);
  const releaseTransportReservation = await context.lifecycle.reserveTransportSession(attached.transportSession);
  try {
    const exists = await context.lifecycle.checkTransportSession(attached);
    if (!exists) {
      return {
        text: t().session.sessionAttachNotFound(alias, agent, quoteWorkspaceNameIfNeeded(workspace)),
      };
    }
    context.lifecycle.markSessionReady?.(attached);

    await context.sessions.attachSession(internalAlias, agent, workspace, transportSession);
    await context.sessions.useSession(chatKey, internalAlias);
    await refreshSessionTransportAgentCommandBestEffort(context, internalAlias, "session.attach.agent_command_refresh_failed");
    await context.logger.info("session.attached", "attached existing transport session", {
      alias: internalAlias,
      agent,
      workspace,
      transportSession,
    });
    return { text: t().session.sessionAttached(alias) };
  } finally {
    await releaseTransportReservation();
  }
}

async function refreshSessionTransportAgentCommandBestEffort(
  context: SessionHandlerContext,
  alias: string,
  event: string,
): Promise<void> {
  try {
    await context.lifecycle.refreshSessionTransportAgentCommand(alias);
  } catch (error) {
    await context.logger.error(event, "failed to refresh session agent command", {
      alias,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

function renderSwitched(switched: SessionSwitchResult): string {
  const s = t().session;
  return switched.previousAlias
    ? s.switchedWithPrev(switched.alias, switched.agent, switched.workspace, switched.previousAlias)
    : s.switched(switched.alias, switched.agent, switched.workspace);
}

async function appendSwitchBackContext(
  context: SessionHandlerContext,
  chatKey: string,
  internalAlias: string,
  baseText: string,
): Promise<string> {
  const result = await context.sessions.takeBackgroundResult(chatKey, internalAlias);
  if (result) {
    return `${baseText}\n\n${result.text}`;
  }
  if (context.activeTurns?.isActive(chatKey, internalAlias)) {
    return `${baseText}\n\n${t().session.stillRunning(toDisplaySessionAlias(internalAlias))}`;
  }
  return baseText;
}

export async function handleSessionUse(
  context: SessionHandlerContext,
  chatKey: string,
  input: string,
): Promise<RouterResponse> {
  const result = context.sessions.resolveFuzzyAlias(chatKey, input);

  if (result.kind === "none") {
    return { text: t().session.noMatchingSession(input) };
  }

  if (result.kind === "ambiguous") {
    const lines = result.candidates.map((candidate) => `• ${candidate.alias} · ${candidate.agent} · ${candidate.workspace}`);
    return { text: [t().session.ambiguousSession(input), ...lines].join("\n") };
  }

  const switched = await context.sessions.useSession(chatKey, result.alias);
  await context.logger.info("session.selected", "selected logical session", {
    alias: switched.alias,
    chatKey,
  });
  const internalAlias = context.sessions.peekCurrentSessionAlias(chatKey) ?? result.alias;
  const text = await appendSwitchBackContext(context, chatKey, internalAlias, renderSwitched(switched));
  return { text };
}

export async function handleSessionUsePrevious(
  context: SessionHandlerContext,
  chatKey: string,
): Promise<RouterResponse> {
  const switched = await context.sessions.usePreviousSession(chatKey);
  if (!switched) {
    return { text: t().session.noPreviousSession };
  }
  await context.logger.info("session.selected", "selected previous logical session", {
    alias: switched.alias,
    chatKey,
  });
  const internalAlias = context.sessions.peekCurrentSessionAlias(chatKey) ?? switched.alias;
  const text = await appendSwitchBackContext(context, chatKey, internalAlias, renderSwitched(switched));
  return { text };
}

export async function handleModeShow(context: SessionHandlerContext, chatKey: string): Promise<RouterResponse> {
  const session = await context.sessions.getCurrentSession(chatKey);
  if (!session) {
    return { text: t().session.noCurrent };
  }

  const s = t().session;
  return {
    text: [
      s.modeHeader,
      s.modeSessionLabel(toDisplaySessionAlias(session.alias)),
      s.modeModeLabel(session.modeId ?? s.modeNotSet),
    ].join("\n"),
  };
}

export async function handleModeSet(
  context: SessionHandlerContext,
  chatKey: string,
  modeId: string,
): Promise<RouterResponse> {
  const session = await context.sessions.getCurrentSession(chatKey);
  if (!session) {
    return { text: t().session.noCurrent };
  }

  await context.interaction.setModeTransportSession(session, modeId);
  await context.sessions.setCurrentSessionMode(chatKey, modeId);
  return { text: t().session.modeSet(modeId) };
}

export async function handleModelShow(context: SessionHandlerContext, chatKey: string): Promise<RouterResponse> {
  const session = await context.sessions.getCurrentSession(chatKey);
  if (!session) {
    return { text: t().session.noCurrent };
  }

  const s = t().session;
  // Best-effort live query; fall back to the resolved model if the transport or
  // acpx can't answer (e.g. session not yet warm).
  let current = session.model;
  let available: string[] = [];
  try {
    const queried = await context.interaction.getModelTransportSession(session);
    current = queried.current ?? session.model;
    available = queried.available;
  } catch {
    // keep the resolved model; no catalog
  }

  const lines = [
    s.modelHeader,
    s.modelSessionLabel(toDisplaySessionAlias(session.alias)),
    s.modelModelLabel(current ?? s.modelNotSet),
  ];
  if (available.length > 0) {
    lines.push(s.modelAvailableLabel(available.join(", ")));
  }
  return { text: lines.join("\n") };
}

export async function handleModelSet(
  context: SessionHandlerContext,
  chatKey: string,
  modelId: string,
): Promise<RouterResponse> {
  const session = await context.sessions.getCurrentSession(chatKey);
  if (!session) {
    return { text: t().session.noCurrent };
  }

  try {
    await context.interaction.setModelTransportSession(session, modelId);
  } catch (error) {
    // acpx rejects an unsupported model id (validated against advertised models).
    return { text: t().session.modelSetFailed(modelId, error instanceof Error ? error.message : String(error)) };
  }
  await context.sessions.setCurrentSessionModel(chatKey, modelId);
  return { text: t().session.modelSet(modelId) };
}

export async function handleReplyModeShow(context: SessionHandlerContext, chatKey: string): Promise<RouterResponse> {
  const session = await context.sessions.getCurrentSession(chatKey);
  if (!session) {
    return { text: t().session.noCurrent };
  }

  const globalDefault = context.config?.channel.replyMode ?? "verbose";
  const channelDefault = resolveChannelDefaultReplyMode(context.config, chatKey);
  const sessionOverride = session.replyMode;
  const effective = resolveEffectiveReplyMode(context.config, chatKey, sessionOverride);
  const s = t().session;

  return {
    text: [
      s.replyModeHeader,
      s.replyModeSessionLabel(toDisplaySessionAlias(session.alias)),
      s.replyModeGlobalDefault(globalDefault),
      s.replyModeChannelDefault(channelDefault ?? s.modeNotSet),
      s.replyModeSessionOverride(sessionOverride ?? s.modeNotSet),
      s.replyModeEffective(effective),
    ].join("\n"),
  };
}

export async function handleReplyModeSet(
  context: SessionHandlerContext,
  chatKey: string,
  replyMode: "stream" | "final" | "verbose",
): Promise<RouterResponse> {
  const session = await context.sessions.getCurrentSession(chatKey);
  if (!session) {
    return { text: t().session.noCurrent };
  }

  await context.sessions.setCurrentSessionReplyMode(chatKey, replyMode);
  return { text: t().session.replyModeSet(replyMode) };
}

export async function handleReplyModeReset(context: SessionHandlerContext, chatKey: string): Promise<RouterResponse> {
  const session = await context.sessions.getCurrentSession(chatKey);
  if (!session) {
    return { text: t().session.noCurrent };
  }

  await context.sessions.setCurrentSessionReplyMode(chatKey, undefined);
  const fallback = resolveEffectiveReplyMode(context.config, chatKey, undefined);
  return { text: t().session.replyModeReset(fallback) };
}

export async function handleStatus(context: SessionHandlerContext, chatKey: string): Promise<RouterResponse> {
  const session = await context.sessions.getCurrentSession(chatKey);
  if (!session) {
    return { text: t().session.noCurrent };
  }

  const s = t().session;
  return {
    text: [
      s.statusHeader,
      s.statusNameLabel(toDisplaySessionAlias(session.alias)),
      s.statusAgentLabel(session.agent),
      s.statusWorkspaceLabel(session.workspace),
    ].join("\n"),
  };
}

export async function handleCancel(
  context: SessionHandlerContext,
  chatKey: string,
  alias?: string,
): Promise<RouterResponse> {
  // With an explicit alias, target that session's in-flight turn — even when it
  // is a backgrounded session we have switched away from. Resolution mirrors
  // handleSessionUse (fuzzy: exact > prefix > substring) and reuses the same
  // user-facing none/ambiguous messages. Without an alias we keep cancelling the
  // foreground session. The cancel mechanism itself is unchanged.
  if (alias !== undefined) {
    const result = context.sessions.resolveFuzzyAlias(chatKey, alias);
    if (result.kind === "none") {
      return { text: t().session.noMatchingSession(alias) };
    }
    if (result.kind === "ambiguous") {
      const lines = result.candidates.map(
        (candidate) => `• ${candidate.alias} · ${candidate.agent} · ${candidate.workspace}`,
      );
      return { text: [t().session.ambiguousSession(alias), ...lines].join("\n") };
    }

    const internalAlias = await context.sessions.resolveAliasForChat(chatKey, result.alias);
    const target = await context.sessions.getSession(internalAlias);
    if (!target) {
      return { text: t().session.noMatchingSession(alias) };
    }

    try {
      const cancelResult = await context.interaction.cancelTransportSession(target);
      return { text: cancelResult.message || "cancelled" };
    } catch (error) {
      const recovered = await context.recovery.tryRecoverMissingSession(target, error);
      if (recovered) {
        const cancelResult = await context.interaction.cancelTransportSession(recovered);
        return { text: cancelResult.message || "cancelled" };
      }
      return context.recovery.renderTransportError(target, error);
    }
  }

  const session = await context.sessions.getCurrentSession(chatKey);
  if (!session) {
    return { text: t().session.noCurrent };
  }

  try {
    const result = await context.interaction.cancelTransportSession(session);
    return { text: result.message || "cancelled" };
  } catch (error) {
    const recovered = await context.recovery.tryRecoverMissingSession(session, error);
    if (recovered) {
      const result = await context.interaction.cancelTransportSession(recovered);
      return { text: result.message || "cancelled" };
    }
    return context.recovery.renderTransportError(session, error);
  }
}

export async function handleSessionReset(context: SessionHandlerContext, chatKey: string): Promise<RouterResponse> {
  return await context.lifecycle.resetCurrentSession(chatKey);
}

export async function handleSessionTail(
  context: SessionHandlerContext,
  chatKey: string,
  lines?: number,
): Promise<RouterResponse> {
  const session = await context.sessions.getCurrentSession(chatKey);
  if (!session) {
    return { text: t().session.noCurrent };
  }

  const resolvedLines = Math.min(
    Math.max(lines ?? DEFAULT_SESSION_TAIL_LINES, 1),
    MAX_SESSION_TAIL_LINES,
  );
  const result = await context.transport.tailSessionHistory(session, resolvedLines);
  return { text: result.text };
}

export async function handleSessionRemove(
  context: SessionHandlerContext,
  chatKey: string,
  alias: string,
): Promise<RouterResponse> {
  const internalAlias = await context.sessions.resolveAliasForChat(chatKey, alias);
  const session = await context.sessions.getSession(internalAlias);
  if (!session) {
    return { text: t().session.sessionNotFound(alias) };
  }

  if (context.orchestration) {
    const blocking = await context.orchestration.listSessionBlockingTasks(session.transportSession);
    if (blocking.length > 0) {
      const s = t().session;
      return {
        text: [
          s.sessionBlockedByTasks(alias, blocking.length),
          s.sessionBlockedByTasksHint,
        ].join("\n"),
      };
    }
  }

  const sharedAliasCount = context.sessions.countAliasesSharingTransport(session.transportSession, internalAlias);
  const wasCurrentInThisChat = context.sessions.peekCurrentSessionAlias(chatKey) === internalAlias;
  const { wasActive } = await context.sessions.removeSession(internalAlias);
  // removeSession promotes previous_session to current_session; if that
  // happened for this chat, the next plain message routes to the promoted
  // session, so the reply must name it instead of claiming a cleared context.
  const promotedAlias = wasCurrentInThisChat
    ? context.sessions.peekCurrentSessionAlias(chatKey) || undefined
    : undefined;

  let orchestrationPurgeWarning: string | undefined;
  if (context.orchestration) {
    try {
      await context.orchestration.purgeSessionReferences(session.transportSession);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      orchestrationPurgeWarning = message;
      await context.logger.error("session.orchestration_purge_failed", "failed to purge orchestration references after logical remove", {
        alias: internalAlias,
        transportSession: session.transportSession,
        message,
      });
    }
  }

  let transportTeardownWarning: string | undefined;
  const shouldTeardownTransport = sharedAliasCount === 0;
  if (shouldTeardownTransport && context.transport.deleteSession) {
    try {
      await context.transport.deleteSession(session);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      transportTeardownWarning = message;
      await context.logger.error("session.transport_teardown_failed", "failed to close acpx session after logical remove", {
        alias: internalAlias,
        transportSession: session.transportSession,
        message,
      });
    }
  }
  await context.logger.info("session.removed", "removed logical session", {
    alias: internalAlias,
    sharedAliasCount,
    transportClosed: shouldTeardownTransport && transportTeardownWarning === undefined,
  });

  const s = t().session;
  const lines = [s.sessionRemoved(alias)];
  if (wasActive) {
    lines.push(
      promotedAlias
        ? s.sessionRemovedWasActivePromoted(toDisplaySessionAlias(promotedAlias))
        : s.sessionRemovedWasActive,
    );
  }
  if (!shouldTeardownTransport) {
    lines.push(s.sessionTransportShared(session.transportSession, sharedAliasCount));
  }
  if (orchestrationPurgeWarning) {
    lines.push(s.sessionOrchestrationPurgeFailed(orchestrationPurgeWarning));
  }
  if (transportTeardownWarning) {
    lines.push(s.sessionTransportTeardownFailed(transportTeardownWarning));
  }
  return { text: lines.join("\n") };
}

export async function handleSessionArchive(
  context: SessionHandlerContext,
  chatKey: string,
  alias: string,
  archive: (internalAlias: string) => Promise<void>,
): Promise<RouterResponse> {
  const internalAlias = await context.sessions.resolveAliasForChat(chatKey, alias);
  const session = await context.sessions.getSession(internalAlias);
  if (!session) {
    return { text: t().session.sessionNotFound(alias) };
  }
  await archive(internalAlias);
  return { text: t().session.sessionArchived(alias) };
}

async function promptWithSession(
  context: SessionHandlerContext,
  session: ResolvedSession,
  chatKey: string,
  text: string,
  reply?: (text: string) => Promise<void>,
  replyContextToken?: string,
  accountId?: string,
  media?: PromptMediaInput,
  abortSignal?: AbortSignal,
  onToolEvent?: (event: ToolUseEvent) => void | Promise<void>,
  onThought?: (chunk: string) => void | Promise<void>,
  perfSpan?: PerfSpan,
  metadata?: ChatRequestMetadata,
  onPlan?: (entries: PlanEntry[]) => void | Promise<void>,
  onUsage?: (usage: PromptUsage) => void | Promise<void>,
  onCommands?: (commands: AgentCommand[]) => void | Promise<void>,
): Promise<RouterResponse> {
  // Restore-on-message: a real prompt to an archived session un-archives it (mirrors
  // useSession on the web path, which the chat prompt path bypasses). The guard avoids
  // a needless persist on every normal prompt. `session.alias` is the internal alias,
  // the same key `setArchived` expects.
  if (session.archived) {
    await context.sessions.setArchived(session.alias, false);
    // Archiving an unshared session cancels + closes its acpx session
    // (archiveSessionWithTransport). acpx excludes closed records from name lookup,
    // so checkTransportSession reports the session missing and the next
    // transport.prompt would throw "No acpx session found" (wrongly telling the user
    // to re-run /session new). Recreate it here before prompting, but only when it's
    // actually gone — the shared-transport case (archive left the acpx session
    // intact) stays promptable and must not be recreated. Concurrent re-prompts to
    // one session are already serialized by the per-session turn lane, so no extra
    // lock is needed here. NOTE: ensureSession starts a FRESH acpx session (acpx
    // can't resume a closed record by name), so the restored conversation resumes
    // with empty agent context — history is not carried over.
    if (!(await context.lifecycle.checkTransportSession(session))) {
      await context.lifecycle.ensureTransportSession(session, reply, perfSpan);
    }
  }
  const effectiveReplyMode = resolveEffectiveReplyMode(context.config, chatKey, session.replyMode);
  // Ensure the session carries the resolved value so downstream transports
  // see "verbose" instead of undefined and format tool-call progress correctly.
  if (!session.replyMode) session.replyMode = effectiveReplyMode;
  const transportReply = effectiveReplyMode !== "final" ? reply : undefined;
  if (context.orchestration) {
    try {
      await context.orchestration.recordCoordinatorRouteContext?.({
        coordinatorSession: stableCoordinatorSession(session.transportSession),
        chatKey,
        sessionAlias: session.alias,
        ...(replyContextToken ? { replyContextToken } : {}),
        ...(accountId ? { accountId } : {}),
        ...toCoordinatorRouteChatMetadata(metadata),
      });
    } catch (error) {
      await context.logger.error(
        "orchestration.coordinator_route_context.record_failed",
        "failed to record coordinator route context",
        {
          alias: session.alias,
          transportSession: session.transportSession,
          chatKey,
          error: error instanceof Error ? error.message : String(error),
        },
      );
      const s = t().session;
      return {
        text: [s.orchestrationRouteError, s.orchestrationRouteRetry].join("\n"),
      };
    }
  }

  const { promptText, taskIds, groupIds, claimHumanReply } = await preparePromptWithFallback(
    context,
    session,
    chatKey,
    text,
    replyContextToken,
    accountId,
  );
  try {
    const replyContext = transportReply && context.quota && getChannelIdFromChatKey(chatKey) === "weixin"
      ? { chatKey, quota: context.quota }
      : undefined;
    const result = await context.interaction.promptTransportSession(
      session,
      promptText,
      transportReply,
      replyContext,
      media,
      abortSignal,
      onToolEvent,
      onThought,
      perfSpan,
      onPlan,
      onUsage,
      onCommands,
    );
    if (claimHumanReply) {
      try {
        await context.orchestration?.claimActiveHumanReply?.(claimHumanReply);
      } catch (error) {
        await context.logger.error(
          "orchestration.coordinator_reply_claim_failed",
          "failed to claim active human reply after prompt delivery",
          {
            alias: session.alias,
            transportSession: session.transportSession,
            chatKey,
            error: error instanceof Error ? error.message : String(error),
          },
        );
      }
    }
    await markCoordinatorResultsInjected(context, taskIds, groupIds);
    // result.text in streaming/verbose mode is `overflow_summary + final
    // agent_message` from the transport — it's the final-tier message that
    // must reach the user via reserveFinal, NOT a duplicate of streamed
    // mid-segments. Returning it lets executeChatTurn surface it as turn.text
    // so handle-weixin-message-turn routes it through the final-message path.
    return { text: result.text };
  } catch (error) {
    await markCoordinatorResultsInjectionFailed(context, taskIds, groupIds, error);
    throw error;
  }
}

export async function handlePromptWithSession(
  context: SessionHandlerContext,
  session: ResolvedSession,
  chatKey: string,
  text: string,
  reply?: (text: string) => Promise<void>,
  replyContextToken?: string,
  accountId?: string,
  media?: PromptMediaInput,
  abortSignal?: AbortSignal,
  onToolEvent?: (event: ToolUseEvent) => void | Promise<void>,
  onThought?: (chunk: string) => void | Promise<void>,
  perfSpan?: PerfSpan,
  metadata?: ChatRequestMetadata,
  onPlan?: (entries: PlanEntry[]) => void | Promise<void>,
  onUsage?: (usage: PromptUsage) => void | Promise<void>,
  onCommands?: (commands: AgentCommand[]) => void | Promise<void>,
): Promise<RouterResponse> {
  try {
    return await promptWithSession(context, session, chatKey, text, reply, replyContextToken, accountId, media, abortSignal, onToolEvent, onThought, perfSpan, metadata, onPlan, onUsage, onCommands);
  } catch (error) {
    const recovered = await context.recovery.tryRecoverMissingSession(session, error);
    if (recovered) {
      return await promptWithSession(context, recovered, chatKey, text, reply, replyContextToken, accountId, media, abortSignal, onToolEvent, onThought, perfSpan, metadata, onPlan, onUsage, onCommands);
    }
    return context.recovery.renderTransportError(session, error);
  }
}

export async function handlePrompt(
  context: SessionHandlerContext,
  chatKey: string,
  text: string,
  reply?: (text: string) => Promise<void>,
  replyContextToken?: string,
  accountId?: string,
  media?: PromptMediaInput,
  abortSignal?: AbortSignal,
  onToolEvent?: (event: ToolUseEvent) => void | Promise<void>,
  onThought?: (chunk: string) => void | Promise<void>,
  perfSpan?: PerfSpan,
  metadata?: ChatRequestMetadata,
  onPlan?: (entries: PlanEntry[]) => void | Promise<void>,
  onUsage?: (usage: PromptUsage) => void | Promise<void>,
  onCommands?: (commands: AgentCommand[]) => void | Promise<void>,
): Promise<RouterResponse> {
  const session = metadata?.boundSessionAlias
    ? context.sessions.getResolvedSessionByInternalAlias(metadata.boundSessionAlias)
    : await context.sessions.getCurrentSession(chatKey);
  if (!session) {
    return { text: t().session.noCurrent };
  }

  return await handlePromptWithSession(context, session, chatKey, text, reply, replyContextToken, accountId, media, abortSignal, onToolEvent, onThought, perfSpan, metadata, onPlan, onUsage, onCommands);
}

function toCoordinatorRouteChatMetadata(
  metadata: ChatRequestMetadata | undefined,
): {
  channel?: string;
  chatType?: "direct" | "group";
  senderId?: string;
  senderName?: string;
  groupId?: string;
  isOwner?: boolean;
} {
  if (!metadata) {
    return {};
  }
  return {
    ...(metadata.channel ? { channel: metadata.channel } : {}),
    ...(metadata.chatType ? { chatType: metadata.chatType } : {}),
    ...(metadata.senderId ? { senderId: metadata.senderId } : {}),
    ...(metadata.senderName ? { senderName: metadata.senderName } : {}),
    ...(metadata.groupId ? { groupId: metadata.groupId } : {}),
    ...(metadata.isOwner !== undefined ? { isOwner: metadata.isOwner } : {}),
  };
}

async function preparePromptWithFallback(
  context: SessionHandlerContext,
  session: ResolvedSession,
  chatKey: string,
  text: string,
  replyContextToken?: string,
  accountId?: string,
): Promise<{
  promptText: string;
  taskIds: string[];
  groupIds: string[];
  claimHumanReply?: {
    coordinatorSession: string;
    chatKey: string;
    packageId: string;
    messageId: string;
    accountId?: string;
    replyContextToken?: string;
  };
}> {
  const orchestration = context.orchestration;
  if (!orchestration) {
    return { promptText: text, taskIds: [], groupIds: [] };
  }

  try {
    return await buildCoordinatorPrompt({
      orchestration,
      coordinatorSession: stableCoordinatorSession(session.transportSession),
      chatKey,
      userText: text,
      ...(replyContextToken ? { replyContextToken } : {}),
      ...(accountId ? { accountId } : {}),
    });
  } catch (error) {
    await context.logger.error("orchestration.coordinator_results.load_failed", "failed to load coordinator results", {
      alias: session.alias,
      transportSession: session.transportSession,
      error: error instanceof Error ? error.message : String(error),
    });
    return { promptText: text, taskIds: [], groupIds: [] };
  }
}

async function markCoordinatorResultsInjected(
  context: SessionHandlerContext,
  taskIds: string[],
  groupIds: string[],
): Promise<void> {
  if ((taskIds.length === 0 && groupIds.length === 0) || !context.orchestration) {
    return;
  }

  try {
    if (groupIds.length > 0) {
      await context.orchestration.markCoordinatorGroupsInjected?.(groupIds);
    }
    if (taskIds.length > 0) {
      await context.orchestration.markTaskInjectionApplied(taskIds);
    }
  } catch (error) {
    await context.logger.error(
      "orchestration.coordinator_results.mark_failed",
      "failed to mark coordinator results injected",
      {
        taskIds: taskIds.join(","),
        groupIds: groupIds.join(","),
        error: error instanceof Error ? error.message : String(error),
      },
    );
  }
}

async function markCoordinatorResultsInjectionFailed(
  context: SessionHandlerContext,
  taskIds: string[],
  groupIds: string[],
  error: unknown,
): Promise<void> {
  if ((taskIds.length === 0 && groupIds.length === 0) || !context.orchestration) {
    return;
  }

  const errorMessage = error instanceof Error ? error.message : String(error);
  try {
    if (groupIds.length > 0) {
      await context.orchestration.markCoordinatorGroupsInjectionFailed?.(groupIds, errorMessage);
    }
    if (taskIds.length > 0) {
      await context.orchestration.markTaskInjectionFailed(taskIds, errorMessage);
    }
  } catch (markError) {
    await context.logger.error(
      "orchestration.coordinator_results.mark_failed",
      "failed to mark coordinator results injection failure",
      {
        taskIds: taskIds.join(","),
        groupIds: groupIds.join(","),
        error: markError instanceof Error ? markError.message : String(markError),
      },
    );
  }
}
