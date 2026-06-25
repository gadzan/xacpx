import { resolveRuntimeAgentCommand } from "../../config/resolve-agent-command";
import { getChannelIdFromChatKey, scopeDisplayAliasToInternal, toDisplaySessionAlias } from "../../channels/channel-scope";
import type { AgentSession, AgentSessionListQuery, AgentSessionListResult, ResolvedSession } from "../../transport/types";
import { allocateWorkspaceName, sanitizeWorkspaceName } from "../workspace-name";
import { basenameForWorkspacePath, normalizeWorkspacePath, pathExists, sameWorkspacePath } from "../workspace-path";
import type { CommandRouterContext, RouterResponse, SessionLifecycleOps } from "../router-types";
import { t } from "../../i18n";

export interface NativeSessionListCommand {
  agent?: string;
  cwd?: string;
  workspace?: string;
  all?: boolean;
  cursor?: string;
}

interface NativeTarget {
  agent: string;
  agentDisplayName: string;
  agentCommand?: string;
  /** Resolved acpx driver for `agent` (e.g. a `my-codex` agent has driver `codex`). */
  driver?: string;
  workspace: string;
  workspaceLabel: string;
  cwd: string;
  source: "workspace" | "cwd";
}

interface CachedNativeSessionList {
  agent: string;
  workspace?: string;
  cwd: string;
  sessions: AgentSession[];
  nextCursor?: string | null;
}

interface NativeCandidateEntry {
  session: AgentSession;
  attached?: {
    alias: string;
    displayAlias: string;
    isCurrent: boolean;
  };
}

const NATIVE_SESSION_CACHE_TTL_MS = 10 * 60 * 1000;

// Upper bound on how many fully-filtered (empty) pages we'll skip past before giving
// up, so a long run of filtered-out sessions can't turn into an unbounded fetch loop.
const MAX_EMPTY_PAGE_ADVANCE = 25;

/**
 * Fetch the first page that still has sessions after transport-side filtering.
 *
 * The transport may filter a whole page (e.g. a page of only Codex subagent threads)
 * down to empty while real sessions remain behind `nextCursor`. Without this, the
 * caller would report "no sessions" while results sit one page on. We follow the
 * cursor past empty pages, bounded by {@link MAX_EMPTY_PAGE_ADVANCE}. Exported for tests.
 */
export async function listFirstNonEmptyPage(
  listAgentSessions: (query: AgentSessionListQuery) => Promise<AgentSessionListResult | undefined>,
  query: AgentSessionListQuery,
): Promise<AgentSessionListResult | undefined> {
  let result = await listAgentSessions(query);
  let guard = 0;
  while (result && result.sessions.length === 0 && result.nextCursor && guard < MAX_EMPTY_PAGE_ADVANCE) {
    guard++;
    result = await listAgentSessions({ ...query, cursor: result.nextCursor });
  }
  return result;
}

export async function handleNativeSessionList(
  context: CommandRouterContext & { lifecycle: SessionLifecycleOps },
  chatKey: string,
  input: NativeSessionListCommand,
): Promise<RouterResponse> {
  const target = await resolveNativeTarget(context, chatKey, input);
  if (isRouterResponse(target)) {
    return target;
  }

  const listAgentSessions = context.transport.listAgentSessions?.bind(context.transport);
  if (!listAgentSessions) {
    return { text: t().nativeSession.transportNotSupported };
  }

  const query: AgentSessionListQuery = {
    agent: target.agent,
    agentCommand: target.agentCommand,
    ...(target.driver ? { driver: target.driver } : {}),
    cwd: target.cwd,
    ...(input.cursor ? { cursor: input.cursor } : {}),
    ...(input.all ? {} : { filterCwd: target.cwd }),
  };

  let result: AgentSessionListResult | undefined;
  try {
    result = await listFirstNonEmptyPage(listAgentSessions, query);
  } catch (error) {
    return { text: renderNativeListError(target, error) };
  }
  if (!result) {
    return { text: t().nativeSession.transportNotSupported };
  }

  await context.sessions.cacheNativeSessionList(chatKey, {
    agent: target.agent,
    workspace: target.workspace,
    cwd: target.cwd,
    sessions: result.sessions,
    ...(result.nextCursor !== undefined ? { nextCursor: result.nextCursor } : {}),
  });

  if (result.sessions.length === 0) {
    return {
      text: [
        t().nativeSession.noSessionsFound(target.agentDisplayName, target.workspaceLabel),
        t().nativeSession.noSessionsFoundHint,
      ].join("\n"),
    };
  }

  const explicitAttachTarget = Boolean(input.workspace || input.cwd);
  if (explicitAttachTarget && !input.all && !input.cursor && result.sessions.length === 1) {
    return await attachNativeSession(context, chatKey, target, result.sessions[0]!, undefined);
  }

  const attachedEntries = await buildAttachedEntries(context, chatKey, target.agent, result.sessions);
  // Render format is a channel-declared capability (MessageChannelRuntime
  // `nativeSessionListFormat`): weixin renders markdown tables poorly and declares
  // "cards"; channels that don't declare it default to "table".
  const nativeSessionListOptions = { format: context.resolveNativeSessionListFormat?.(chatKey) ?? "table" } as const;
  return {
    text: renderNativeSessionList(target, result, attachedEntries, Boolean(input.all), nativeSessionListOptions),
  };
}

export async function handleNativeSessionSelect(
  context: CommandRouterContext & { lifecycle: SessionLifecycleOps },
  chatKey: string,
  identifier: string,
  alias?: string,
): Promise<RouterResponse> {
  const trimmed = identifier.trim();
  if (!trimmed) {
    return { text: t().nativeSession.selectPrompt };
  }

  if (/^[0-9]+$/.test(trimmed)) {
    const cached = await context.sessions.getNativeSessionList(chatKey, NATIVE_SESSION_CACHE_TTL_MS);
    if (!cached || cached.sessions.length === 0) {
      return { text: t().nativeSession.noCachedList };
    }

    const index = Number(trimmed) - 1;
    const session = cached.sessions[index];
    if (!session) {
      return { text: t().nativeSession.indexOutOfRange };
    }

    const target = await resolveTargetFromCachedSession(context, chatKey, cached, session);
    if (isRouterResponse(target)) {
      return target;
    }

    return await attachNativeSession(context, chatKey, target, session, alias);
  }

  const target = await resolveNativeTarget(context, chatKey, {});
  if (isRouterResponse(target)) {
    return target;
  }
  return await attachNativeSession(context, chatKey, target, { sessionId: trimmed }, alias);
}

async function attachNativeSession(
  context: CommandRouterContext & { lifecycle: SessionLifecycleOps },
  chatKey: string,
  target: NativeTarget,
  session: AgentSession,
  alias?: string,
): Promise<RouterResponse> {
  if (!context.transport.resumeAgentSession) {
    return { text: t().nativeSession.attachNotSupported };
  }

  const nativeTarget = target as NativeTarget;
  const existing = await context.sessions.findAttachedNativeSession(chatKey, nativeTarget.agent, session.sessionId);
  if (existing) {
    await context.sessions.useSession(chatKey, existing.alias);
    const displayAlias = toDisplaySessionAlias(existing.alias);
    return {
      text: t().nativeSession.alreadySwitched(nativeTarget.agentDisplayName, displayAlias),
    };
  }

  const requestedAlias = alias?.trim() || buildDefaultNativeAlias(nativeTarget.agent, session.sessionId);
  const displayAlias = await allocateUniqueNativeAlias(context, chatKey, requestedAlias);
  const internalAlias = scopeDisplayAliasToInternal(getChannelIdFromChatKey(chatKey), displayAlias);
  const transportSession = context.sessions.buildDefaultTransportSessionForChat(chatKey, displayAlias);
  const resolvedSession = context.lifecycle.resolveSession(internalAlias, nativeTarget.agent, nativeTarget.workspace, transportSession);
  const releaseReservation = await context.lifecycle.reserveTransportSession(resolvedSession.transportSession);

  try {
    try {
      await context.transport.resumeAgentSession(resolvedSession, session.sessionId);
    } catch (error) {
      return { text: renderNativeResumeError(target, error) };
    }
    const verified = await context.lifecycle.checkTransportSession(resolvedSession);
    if (!verified) {
      return { text: t().nativeSession.attachVerificationFailed(target.agentDisplayName) };
    }

    await context.sessions.attachNativeSession({
      alias: internalAlias,
      agent: nativeTarget.agent,
      workspace: nativeTarget.workspace,
      transportSession,
      ...(target.agentCommand ? { transportAgentCommand: target.agentCommand } : {}),
      agentSessionId: session.sessionId,
      title: session.title,
      updatedAt: session.updatedAt,
    });
    await context.sessions.useSession(chatKey, internalAlias);
    await refreshAgentCommandBestEffort(context, internalAlias);

    return {
      text: t().nativeSession.attachedAndSwitched(target.agentDisplayName, toDisplaySessionAlias(internalAlias)),
    };
  } finally {
    await releaseReservation();
  }
}

async function resolveNativeTarget(
  context: CommandRouterContext,
  chatKey: string,
  input: NativeSessionListCommand,
): Promise<NativeTarget | RouterResponse> {
  const currentSession = await context.sessions.getCurrentSession(chatKey);
  const agent = input.agent?.trim() || currentSession?.agent || "";
  if (!agent) {
    return { text: t().nativeSession.noContextHint };
  }

  const agentConfig = context.config?.agents[agent];
  if (!agentConfig) {
    return { text: t().nativeSession.agentNotRegistered(agent) };
  }

  const workspaceResolution = await resolveNativeWorkspace(context, input, currentSession);
  if (isRouterResponse(workspaceResolution)) {
    return workspaceResolution;
  }

  return {
    agent,
    agentDisplayName: displayAgentName(agent),
    agentCommand: resolveRuntimeAgentCommand(agentConfig.driver, agentConfig.command, context.config?.transport.preferLocalAgents !== false),
    driver: agentConfig.driver,
    workspace: workspaceResolution.workspace,
    workspaceLabel: workspaceResolution.workspaceLabel,
    cwd: workspaceResolution.cwd,
    source: workspaceResolution.source,
  };
}

async function resolveTargetFromCachedSession(
  context: CommandRouterContext,
  chatKey: string,
  cached: CachedNativeSessionList,
  session: AgentSession,
): Promise<NativeTarget | RouterResponse> {
  if (session.cwd && !sameWorkspacePath(session.cwd, cached.cwd)) {
    return await resolveNativeTarget(context, chatKey, {
      agent: cached.agent,
      cwd: session.cwd,
    });
  }

  return await resolveNativeTarget(context, chatKey, {
    agent: cached.agent,
    ...(cached.workspace ? { workspace: cached.workspace } : { cwd: cached.cwd }),
  });
}

async function resolveNativeWorkspace(
  context: CommandRouterContext,
  input: NativeSessionListCommand,
  currentSession: ResolvedSession | null,
): Promise<{ workspace: string; workspaceLabel: string; cwd: string; source: "workspace" | "cwd" } | RouterResponse> {
  if (input.workspace) {
    const workspaceConfig = context.config?.workspaces[input.workspace];
    if (!workspaceConfig) {
      return { text: t().nativeSession.workspaceNotRegistered(input.workspace) };
    }
    return {
      workspace: input.workspace,
      workspaceLabel: input.workspace,
      cwd: workspaceConfig.cwd,
      source: "workspace",
    };
  }

  if (input.cwd) {
    const cwd = normalizeWorkspacePath(input.cwd);
    const existing = Object.entries(context.config?.workspaces ?? {}).find(([, workspace]) => sameWorkspacePath(workspace.cwd, cwd));
    if (existing) {
      return {
        workspace: existing[0],
        workspaceLabel: existing[0],
        cwd: existing[1].cwd,
        source: "cwd",
      };
    }

    if (!(await pathExists(cwd))) {
      return { text: t().nativeSession.workspacePathNotFound(input.cwd) };
    }

    if (!context.configStore || !context.config) {
      return { text: t().nativeSession.noWritableConfig };
    }

    const workspaceName = allocateWorkspaceName(sanitizeWorkspaceName(basenameForWorkspacePath(cwd)), context.config.workspaces);
    const updated = await context.configStore.upsertWorkspace(workspaceName, cwd);
    context.replaceConfig(updated);
    return {
      workspace: workspaceName,
      workspaceLabel: workspaceName,
      cwd,
      source: "cwd",
    };
  }

  if (currentSession) {
    return {
      workspace: currentSession.workspace,
      workspaceLabel: currentSession.workspace,
      cwd: currentSession.cwd,
      source: "workspace",
    };
  }

  return { text: t().nativeSession.noContextHint };
}

async function buildAttachedEntries(
  context: CommandRouterContext,
  chatKey: string,
  agent: string,
  sessions: AgentSession[],
): Promise<NativeCandidateEntry[]> {
  const currentSession = await context.sessions.getCurrentSession(chatKey);
  return await Promise.all(
    sessions.map(async (session) => {
      const attached = await context.sessions.findAttachedNativeSession(chatKey, agent, session.sessionId);
      if (!attached) {
        return { session };
      }
      return {
        session,
        attached: {
          alias: attached.alias,
          displayAlias: toDisplaySessionAlias(attached.alias),
          isCurrent: currentSession?.alias === attached.alias,
        },
      };
    }),
  );
}

function renderNativeSessionList(
  target: NativeTarget,
  result: AgentSessionListResult,
  entries: NativeCandidateEntry[],
  includeAll: boolean,
  options: { format?: "cards" | "table" } = {},
): string {
  if (options.format === "cards") {
    return renderNativeSessionCardList(target, result, entries, includeAll);
  }
  return renderNativeSessionTableList(target, result, entries, includeAll);
}

function renderNativeSessionTableList(
  target: NativeTarget,
  result: AgentSessionListResult,
  entries: NativeCandidateEntry[],
  includeAll: boolean,
): string {
  const ns = t().nativeSession;
  const lines = [ns.tableHeader(target.agentDisplayName, target.workspaceLabel)];
  lines.push(`| ${ns.tableColNum} | ${ns.tableColTitle} | ${ns.tableColUpdatedAt} | ${ns.tableColId} |`);
  lines.push("|---|---|---|---|");
  entries.forEach((entry, index) => {
    const title = escapeMarkdownTableCell(renderNativeSessionTitle(entry.session.title, entry.session.sessionId));
    const updatedAt = entry.session.updatedAt ? formatNativeSessionTime(entry.session.updatedAt) : "-";
    const idParts: string[] = [entry.session.sessionId];
    if (entry.attached) {
      idParts.push(`${ns.tableAttachedLabel(entry.attached.displayAlias)}${entry.attached.isCurrent ? ns.tableAttachedCurrent : ""}`);
    }
    lines.push(`| ${index + 1} | ${title} | ${escapeMarkdownTableCell(updatedAt)} | ${escapeMarkdownTableCell(idParts.join(" · "))} |`);
  });

  lines.push("");
  lines.push(ns.tableActions);
  lines.push(ns.tableActionAttach);
  lines.push(ns.tableActionAlias);
  lines.push(ns.tableActionHelp);
  if (result.nextCursor) {
    lines.push(ns.tableMore(renderNextPageCommand(target, result.nextCursor, includeAll)));
  }
  return lines.join("\n");
}

function renderNativeSessionCardList(
  target: NativeTarget,
  result: AgentSessionListResult,
  entries: NativeCandidateEntry[],
  includeAll: boolean,
): string {
  const ns = t().nativeSession;
  const lines = [
    ns.cardHeader(target.agentDisplayName, target.workspaceLabel),
    ns.cardReplyHint,
  ];

  entries.forEach((entry, index) => {
    const title = renderNativeSessionTitle(entry.session.title, entry.session.sessionId);
    const updatedAt = entry.session.updatedAt ? formatNativeSessionTime(entry.session.updatedAt) : "-";
    lines.push("");
    lines.push(`【${index + 1}】 ${title}`);
    lines.push(ns.cardTimeLabel(updatedAt));
    lines.push(ns.cardIdLabel(formatSessionIdTail(entry.session.sessionId)));
    if (entry.attached) {
      lines.push(`${ns.cardAttachedLabel(entry.attached.displayAlias)}${entry.attached.isCurrent ? ns.cardAttachedCurrent : ""}`);
    }
  });

  lines.push("");
  lines.push(ns.cardActions);
  lines.push(ns.cardActionAttach);
  lines.push(ns.cardActionAlias);
  lines.push(ns.cardActionHelp);
  if (result.nextCursor) {
    lines.push(ns.cardMore(renderNextPageCommand(target, result.nextCursor, includeAll)));
  }
  return lines.join("\n");
}

function renderNativeSessionTitle(title: string | null | undefined, fallback: string): string {
  const normalized = (title?.trim() || fallback).replace(/\s+/g, " ");
  const maxLength = 60;
  return normalized.length > maxLength ? `${normalized.slice(0, maxLength - 1)}…` : normalized;
}

function buildDefaultNativeAlias(agent: string, sessionId: string): string {
  return `${agent}-${sessionIdTail(sessionId)}`;
}

function formatSessionIdTail(sessionId: string): string {
  const tail = sessionIdTail(sessionId);
  return tail.length < sessionId.trim().length ? `…${tail}` : tail;
}

function sessionIdTail(sessionId: string): string {
  const trimmed = sessionId.trim();
  if (trimmed.length <= 8) {
    return trimmed;
  }
  return trimmed.slice(-8);
}

function formatNativeSessionTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }
  const pad = (input: number) => String(input).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function escapeMarkdownTableCell(value: string): string {
  return value.replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
}

function renderNextPageCommand(target: NativeTarget, nextCursor: string, includeAll: boolean): string {
  const scope = target.source === "workspace" && target.workspace
    ? `--ws ${target.workspace}`
    : `-d ${target.cwd}`;
  const allFlag = includeAll ? " --all" : "";
  return `/ssn ${target.agent} ${scope}${allFlag} --cursor ${nextCursor}`;
}

async function allocateUniqueNativeAlias(
  context: CommandRouterContext,
  chatKey: string,
  baseDisplayAlias: string,
): Promise<string> {
  const channelId = getChannelIdFromChatKey(chatKey);
  const visible = await context.sessions.listSessions(chatKey);
  const existing = new Set(visible.map((session) => session.internalAlias));
  const base = baseDisplayAlias.trim() || "native-session";
  const transportFor = (candidate: string) => context.sessions.buildDefaultTransportSessionForChat(chatKey, candidate);
  const isFree = (candidate: string) =>
    !existing.has(scopeDisplayAliasToInternal(channelId, candidate)) &&
    context.sessions.countAliasesSharingTransport(transportFor(candidate)) === 0;

  if (isFree(base)) {
    return base;
  }

  let suffix = 2;
  while (!isFree(`${base}-${suffix}`)) {
    suffix += 1;
  }
  return `${base}-${suffix}`;
}

async function refreshAgentCommandBestEffort(
  context: CommandRouterContext & { lifecycle: SessionLifecycleOps },
  alias: string,
): Promise<void> {
  try {
    await context.lifecycle.refreshSessionTransportAgentCommand(alias);
  } catch (error) {
    await context.logger.error("session.native.agent_command_refresh_failed", "failed to refresh native session agent command", {
      alias,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

function renderNativeListError(target: NativeTarget, error: unknown): string {
  const ns = t().nativeSession;
  return [
    ns.listError(target.agentDisplayName, formatErrorMessage(error)),
    ns.listErrorHint,
    ns.listErrorHelp,
  ].join("\n");
}

function renderNativeResumeError(target: NativeTarget, error: unknown): string {
  const ns = t().nativeSession;
  return [
    ns.resumeError(target.agentDisplayName, formatErrorMessage(error)),
    ns.resumeErrorHint,
    ns.resumeErrorHelp,
  ].join("\n");
}

function formatErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isRouterResponse(value: RouterResponse | NativeTarget | { workspace: string; workspaceLabel: string; cwd: string; source: "workspace" | "cwd" }): value is RouterResponse {
  return typeof (value as RouterResponse).text === "string";
}

function displayAgentName(agent: string): string {
  if (!agent) {
    return agent;
  }
  return agent.charAt(0).toUpperCase() + agent.slice(1);
}
