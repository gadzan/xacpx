import { allocateWorkspaceName, sanitizeWorkspaceName } from "../workspace-name";
import { basenameForWorkspacePath, normalizeWorkspacePath, pathExists, sameWorkspacePath } from "../workspace-path";
import type { CommandRouterContext, RouterResponse, SessionShortcutOps } from "../router-types";
import { AutoInstallFailedError } from "../../recovery/errors";
import { getChannelIdFromChatKey, scopeDisplayAliasToInternal, toDisplaySessionAlias } from "../../channels/channel-scope";
import { t } from "../../i18n";

interface ShortcutWorkspaceResolution {
  name: string;
  cwd: string;
  reused: boolean;
}


export async function handleSessionShortcutCommand(
  context: CommandRouterContext,
  ops: SessionShortcutOps,
  chatKey: string,
  agent: string,
  target: { cwd?: string; workspace?: string },
  createNew: boolean,
): Promise<RouterResponse> {
  if (!context.config || !context.configStore) {
    return { text: t().shortcut.noConfig };
  }

  if (!context.config.agents[agent]) {
    const agents = Object.keys(context.config.agents);
    const hint = agents.length > 0
      ? t().shortcut.agentNotRegisteredAvailable(agents.join("、"))
      : t().shortcut.agentNotRegisteredNone;
    return { text: t().shortcut.agentNotRegistered(agent, hint) };
  }

  const workspace = await resolveShortcutWorkspace(context, target);
  if ("error" in workspace) {
    return { text: workspace.error };
  }
  await context.logger.info("session.shortcut.workspace", "resolved shortcut workspace", {
    workspace: workspace.name,
    cwd: workspace.cwd,
    reused: workspace.reused,
  });

  const baseAlias = `${workspace.name}:${agent}`;
  const channelId = getChannelIdFromChatKey(chatKey);
  const scopedBase = scopeDisplayAliasToInternal(channelId, baseAlias);
  const alias = createNew ? await allocateUniqueSessionAlias(context, scopedBase, chatKey) : scopedBase;
  const display = toDisplaySessionAlias(alias);

  if (!createNew && (await hasLogicalSession(context, alias, chatKey))) {
    await context.sessions.useSession(chatKey, alias);
    await context.logger.info("session.shortcut.reused", "reused existing logical session", {
      alias,
      workspace: workspace.name,
      agent,
    });
    return {
      text: [
        t().shortcut.reuseHeader(display),
        t().shortcut.reuseWorkspace(workspace.name),
        t().shortcut.reuseSession(display),
      ].join("\n"),
    };
  }

  const releaseAliasReservation = context.sessions.tryReserveNewSessionAlias(alias);
  if (!releaseAliasReservation) {
    return renderShortcutSessionCreationError(workspace, display);
  }

  try {
    const stableTransportSession = channelId === "weixin" ? alias : context.sessions.buildDefaultTransportSessionForChat(chatKey, display);
    const session = ops.resolveSession(
      alias,
      agent,
      workspace.name,
      context.sessions.buildFreshTransportSession(stableTransportSession),
    );
    const releaseTransportReservation = await ops.reserveTransportSession(stableTransportSession);
    try {
      try {
        await ops.ensureTransportSession(session);
        const exists = await ops.checkTransportSession(session);
        if (!exists) {
          return renderShortcutSessionCreationError(workspace, display);
        }
      } catch (err) {
        if (err instanceof AutoInstallFailedError) throw err;
        return renderShortcutSessionCreationError(workspace, display);
      }

      await context.sessions.attachSession(
        alias,
        agent,
        workspace.name,
        session.transportSession,
        session.agentCommand,
        session.acpxAgent,
        session.agentArgv,
      );
      await context.sessions.useSession(chatKey, alias);
      try {
        await ops.refreshSessionTransportAgentCommand(alias);
      } catch (error) {
        await context.logger.error("session.shortcut.agent_command_refresh_failed", "failed to refresh session agent command", {
          alias,
          error: error instanceof Error ? error.message : String(error),
        });
      }
      await context.logger.info("session.shortcut.created", "created new logical session from shortcut", {
        alias,
        workspace: workspace.name,
        agent,
        workspaceReused: workspace.reused,
      });

      return {
        text: [
          t().shortcut.createdHeader(display),
          workspace.reused
            ? t().shortcut.createdReusedWorkspace(workspace.name)
            : t().shortcut.createdNewWorkspace(workspace.name, workspace.cwd),
          t().shortcut.createdNewSession(display),
        ].join("\n"),
      };
    } finally {
      await releaseTransportReservation();
    }
  } finally {
    releaseAliasReservation();
  }
}

async function resolveShortcutWorkspace(
  context: CommandRouterContext,
  target: { cwd?: string; workspace?: string },
): Promise<ShortcutWorkspaceResolution | { error: string }> {
  if (target.workspace) {
    const workspace = context.config?.workspaces[target.workspace];
    if (!workspace) {
      const workspaces = Object.keys(context.config?.workspaces ?? {});
      const hint = workspaces.length > 0
        ? t().shortcut.workspaceAvailable(workspaces.join("、"))
        : t().shortcut.workspaceNone;
      return { error: t().shortcut.workspaceNotRegistered(target.workspace, hint) };
    }

    return {
      name: target.workspace,
      cwd: workspace.cwd,
      reused: true,
    };
  }

  const cwdInput = target.cwd ?? "";
  const cwd = normalizeWorkspacePath(cwdInput);
  if (!(await pathExists(cwd))) {
    return { error: t().shortcut.workspacePathNotFound(cwdInput) };
  }

  const existingByPath = Object.entries(context.config?.workspaces ?? {}).find(([, workspace]) =>
    sameWorkspacePath(workspace.cwd, cwd),
  );
  if (existingByPath) {
    return {
      name: existingByPath[0],
      cwd: existingByPath[1].cwd,
      reused: true,
    };
  }

  const workspaceName = allocateWorkspaceName(
    sanitizeWorkspaceName(basenameForWorkspacePath(cwd)),
    context.config?.workspaces ?? {},
  );
  const updated = await context.configStore!.upsertWorkspace(workspaceName, cwd);
  context.replaceConfig(updated);

  return {
    name: workspaceName,
    cwd,
    reused: false,
  };
}

async function allocateUniqueSessionAlias(
  context: CommandRouterContext,
  baseAlias: string,
  chatKey: string,
): Promise<string> {
  if (!(await hasLogicalSession(context, baseAlias, chatKey))) {
    return baseAlias;
  }

  let suffix = 2;
  while (await hasLogicalSession(context, `${baseAlias}-${suffix}`, chatKey)) {
    suffix += 1;
  }

  return `${baseAlias}-${suffix}`;
}

async function hasLogicalSession(context: CommandRouterContext, alias: string, chatKey: string): Promise<boolean> {
  const sessions = await context.sessions.listSessions(chatKey);
  return sessions.some((session) => session.internalAlias === alias);
}

function renderShortcutSessionCreationError(
  workspace: ShortcutWorkspaceResolution,
  alias: string,
): RouterResponse {
  return {
    text: [
      t().shortcut.creationFailed(alias),
      workspace.reused
        ? t().shortcut.creationFailedReusedWorkspace(workspace.name)
        : t().shortcut.creationFailedNewWorkspace(workspace.name, workspace.cwd),
      t().shortcut.creationFailedSession,
    ].join("\n"),
  };
}
