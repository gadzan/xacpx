import { useChatStore } from "../stores/chat";
import { useInstancesStore } from "../stores/instances";
import { genAlias, uniqueName } from "./session-form";

/** Coordinates the cross-store follow-up after the daemon registers a managed
 * worktree as a workspace: refresh workspace metadata, then create and select a
 * session only if the user is still viewing the source session. */
export function useWorktreeSession() {
  const instances = useInstancesStore();
  const chat = useChatStore();

  async function open(instanceId: string, agent: string, workspace: string, sourceSessionAlias: string): Promise<string | null> {
    await instances.loadWorkspaces(instanceId).catch(() => {});
    if (chat.instanceId !== instanceId || chat.sessionAlias !== sourceSessionAlias) return null;
    const existingAliases = instances.byId(instanceId)?.sessions.map((session) => session.alias) ?? [];
    const alias = uniqueName(genAlias(workspace, agent), existingAliases);
    if (!instances.beginSessionCreation(instanceId, alias, agent, workspace)) return null;
    chat.select(instanceId, alias);
    return alias;
  }

  return { open };
}
