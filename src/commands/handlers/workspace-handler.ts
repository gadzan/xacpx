import { renderWorkspaces } from "../../formatting/render-text";
import { allocateWorkspaceName, isWorkspaceNameValid, sanitizeWorkspaceName } from "../workspace-name";
import { normalizeWorkspacePath, pathExists } from "../workspace-path";
import type { HelpTopicMetadata } from "../help/help-types";
import type { CommandRouterContext, RouterResponse } from "../router-types";
import { t } from "../../i18n";

export function workspaceHelp(): HelpTopicMetadata {
  const w = t().workspace;
  return {
    topic: "workspace",
    aliases: ["ws", "workspaces"],
    summary: w.helpSummary,
    commands: [
      { usage: w.helpCmdList, description: w.helpCmdListDesc },
      { usage: w.helpCmdListOrAlias, description: w.helpCmdListOrAliasDesc },
      { usage: w.helpCmdNew, description: w.helpCmdNewDesc },
      { usage: w.helpCmdRm, description: w.helpCmdRmDesc },
    ],
    examples: ['/ws new backend -d "/tmp/backend"', "/workspace rm backend"],
  };
}

export function handleWorkspaces(context: CommandRouterContext): RouterResponse {
  return { text: context.config ? renderWorkspaces(context.config) : "No config loaded." };
}

export async function handleWorkspaceCreate(
  context: CommandRouterContext,
  workspaceName: string,
  cwd: string,
  options: { raw?: boolean } = {},
): Promise<RouterResponse> {
  const w = t().workspace;
  if (!context.config || !context.configStore) {
    return { text: w.noWritableConfig };
  }

  const normalizedCwd = normalizeWorkspacePath(cwd);
  if (!(await pathExists(normalizedCwd))) {
    return { text: w.pathNotFound(cwd) };
  }

  // Store mutation + whole-snapshot live publish join the shared config
  // mutation domain (see ConfigMutationMutex): publishing a snapshot read
  // from disk must never interleave with an in-flight permission
  // transaction's uncommitted value or rollback.
  const configStore = context.configStore;
  const liveConfig = context.config;
  return await context.configMutationMutex.run(async () => {
    let name = workspaceName;
    let notice: string | undefined;
    if (!options.raw && !isWorkspaceNameValid(workspaceName)) {
      const base = sanitizeWorkspaceName(workspaceName);
      if (base === null) return { text: w.nameUnderivable(workspaceName) };
      name = allocateWorkspaceName(base, liveConfig.workspaces);
      notice = w.nameSanitized(workspaceName, name);
    }
    if (liveConfig.workspaces[name]?.dedicated === true) {
      return { text: w.dedicatedConflict(name) };
    }

    // Persist the user's raw input (a `~` stays literal in the file and is
    // expanded at config-load time), but validate the expanded path above.
    const updated = await configStore.upsertWorkspace(name, cwd);
    context.replaceConfig(updated);
    const savedLine = w.saved(name);
    return { text: notice ? `${notice}\n${savedLine}` : savedLine };
  });
}

export async function handleWorkspaceRemove(
  context: CommandRouterContext,
  workspaceName: string,
): Promise<RouterResponse> {
  const w = t().workspace;
  if (!context.config || !context.configStore) {
    return { text: w.noWritableConfig };
  }
  if (context.config.workspaces[workspaceName]?.dedicated === true) {
    return { text: w.dedicatedRemove(workspaceName) };
  }
  const configStore = context.configStore;
  // A workspace backing persisted sessions or worker bindings cannot be
  // removed: their rows would become unresolvable, turning
  // physical-membership decisions for every same-name owner fail-ambiguous.
  // Remove those sessions first. C outer, S inner (the same order as the
  // Control API delete): the occupancy check and the delete share one S
  // section, so a binding that lands while this command waits for C/S is
  // seen before the delete.
  return await context.configMutationMutex.run(async () => {
    return await context.sessions.withSessionLock(async () => {
      const users = [
        ...context.sessions.aliasesUsingWorkspace(workspaceName),
        ...context.sessions.workerBindingsUsingWorkspace(workspaceName),
      ];
      if (users.length > 0) {
        return { text: w.stillReferenced(workspaceName, users.join(", ")) };
      }
      const updated = await configStore.removeWorkspace(workspaceName);
      context.replaceConfig(updated);
      context.controlEvents?.emit({ type: "workspaces-changed" });
      return { text: w.removed(workspaceName) };
    });
  });
}
