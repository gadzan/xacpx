import { allocateWorkspaceName, sanitizeWorkspaceName } from "../workspace-name";
import { basenameForWorkspacePath, normalizeWorkspacePath, pathExists, sameWorkspacePath } from "../workspace-path";
import type { CommandRouterContext, RouterResponse, SessionShortcutOps } from "../router-types";
import { AutoInstallFailedError } from "../../recovery/errors";
import { getChannelIdFromChatKey, scopeDisplayAliasToInternal, toDisplaySessionAlias } from "../../channels/channel-scope";
import { convergeProvisionalCreate } from "../session-remove-lifecycle";
import type { ResolvedSession } from "../../transport/types";
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
  // `allocateUniqueSessionAlias` used to do suffix derivation before alias reservation
  // landed. Now `tryReserveFreeSessionAlias` (below) is the single source of truth for
  // unique suffix derivation — it sees every alias including archived ones and has
  // atomic reservation. Skip the pre-derivation on the create-new path to avoid the
  // redundant (and in edge cases compounding) double suffix.
  const desiredAlias = scopedBase;
  const desiredDisplay = toDisplaySessionAlias(desiredAlias);

  if (!createNew && (await hasLogicalSession(context, desiredAlias, chatKey))) {
    await context.sessions.useSession(chatKey, desiredAlias);
    await context.logger.info("session.shortcut.reused", "reused existing logical session", {
      alias: desiredAlias,
      workspace: workspace.name,
      agent,
    });
    return {
      text: [
        t().shortcut.reuseHeader(desiredDisplay),
        t().shortcut.reuseWorkspace(workspace.name),
        t().shortcut.reuseSession(desiredDisplay),
      ].join("\n"),
    };
  }

  const reserved = context.sessions.tryReserveFreeSessionAlias(desiredAlias);
  if (!reserved) {
    return renderShortcutSessionCreationError(workspace, desiredDisplay);
  }
  const { alias: finalAlias, release: releaseAliasReservation } = reserved;
  const finalDisplay = toDisplaySessionAlias(finalAlias);

  try {
    const stableTransportSession = channelId === "weixin" ? finalAlias : context.sessions.buildDefaultTransportSessionForChat(chatKey, finalDisplay);
    const launchProbe = ops.resolveSession(
      finalAlias,
      agent,
      workspace.name,
      context.sessions.buildFreshTransportSession(stableTransportSession),
      { guardAcpOutput: true },
    );
    let releaseTransportReservation: any;
    try {
      releaseTransportReservation = await ops.reserveTransportSession(stableTransportSession);
    } catch (err) {
      return renderShortcutSessionCreationError(workspace, finalDisplay);
    }
    let persisted: any;
    try {
      try {
        persisted = await context.sessions.attachSession(
          finalAlias,
          agent,
          workspace.name,
          launchProbe.transportSession,
          launchProbe.agentCommand,
          launchProbe.acpxAgent,
          launchProbe.agentArgv,
        );
      } catch (err) {
        if (err instanceof AutoInstallFailedError) throw err;
        return renderShortcutSessionCreationError(workspace, finalDisplay);
      }
      try {
        await ops.ensureTransportSession(persisted);
        const exists = await ops.checkTransportSession(persisted);
        if (!exists) {
          await cleanupProvisionalCreate(context, persisted);
          return renderShortcutSessionCreationError(workspace, finalDisplay);
        }
      } catch (err) {
        await cleanupProvisionalCreate(context, persisted, err);
        if (err instanceof AutoInstallFailedError) throw err;
        return renderShortcutSessionCreationError(workspace, finalDisplay);
      }

      // attach already done as persisted, no second attach needed
      await context.sessions.useSession(chatKey, finalAlias);
      try {
        await ops.refreshSessionTransportAgentCommand(finalAlias);
      } catch (error) {
        await context.logger.error("session.shortcut.agent_command_refresh_failed", "failed to refresh session agent command", {
          alias: finalAlias,
          error: error instanceof Error ? error.message : String(error),
        });
      }
      await context.logger.info("session.shortcut.created", "created new logical session from shortcut", {
        alias: finalAlias,
        workspace: workspace.name,
        agent,
        workspaceReused: workspace.reused,
      });

      return {
        text: [
          t().shortcut.createdHeader(finalDisplay),
          workspace.reused
            ? t().shortcut.createdReusedWorkspace(workspace.name)
            : t().shortcut.createdNewWorkspace(workspace.name, workspace.cwd),
          t().shortcut.createdNewSession(finalDisplay),
        ].join("\n"),
      };
    } finally {
      await releaseTransportReservation();
    }
  } finally {
    releaseAliasReservation();
  }
}

async function cleanupProvisionalCreate(
  context: CommandRouterContext,
  persisted: ResolvedSession,
  cause?: unknown,
): Promise<void> {
  await convergeProvisionalCreate({
    sessions: context.sessions,
    transport: context.transport,
    session: persisted,
    internalAlias: persisted.alias,
    ...(cause !== undefined ? { cause } : {}),
  });
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
  // Whole-snapshot publish joins the shared config mutation domain (see
  // ConfigMutationMutex).
  const configStore = context.configStore;
  await context.configMutationMutex.run(async () => {
    const next = await configStore!.upsertWorkspace(workspaceName, cwd);
    context.replaceConfig(next);
  });

  return {
    name: workspaceName,
    cwd,
    reused: false,
  };
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
