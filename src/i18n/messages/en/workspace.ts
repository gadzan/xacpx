import type { WorkspaceMessages } from "../../types";

export const workspace: WorkspaceMessages = {
  // render-text: renderWorkspaces
  workspacesEmpty: "No workspaces registered yet.",
  workspacesHeader: "Registered workspaces:",

  // handleWorkspaceCreate — no config
  noWritableConfig: "No writable config is currently loaded.",

  // handleWorkspaceCreate — path not found
  pathNotFound: (cwd) => `Workspace path does not exist: ${cwd}`,

  // handleWorkspaceCreate — name sanitization notice
  nameSanitized: (original, saved) =>
    `Name ${JSON.stringify(original)} contains special characters and has been saved as "${saved}". Add --raw to keep the original name.`,

  // handleWorkspaceCreate — saved confirmation
  saved: (name) => `Workspace "${name}" saved.`,

  // handleWorkspaceRemove — removed confirmation
  removed: (name) => `Workspace "${name}" removed.`,

  // handleWorkspaceRemove — still referenced by persisted sessions
  stillReferenced: (name, aliases) =>
    `Workspace "${name}" is still used by sessions: ${aliases}. Remove those sessions first.`,

  // workspaceHelp metadata
  helpSummary: "Manage registered workspaces.",
  helpCmdList: "/workspaces",
  helpCmdListDesc: "List all registered workspaces",
  helpCmdListOrAlias: "/workspace or /ws",
  helpCmdListOrAliasDesc: "List workspaces",
  helpCmdNew: "/ws new <name> -d <path> [--raw]",
  helpCmdNewDesc: "Add a workspace; names with special characters are auto-sanitized, --raw keeps the original name",
  helpCmdRm: "/workspace rm <name>",
  helpCmdRmDesc: "Remove a workspace",
};
