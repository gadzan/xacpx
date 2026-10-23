import type { ShortcutMessages } from "../../types";

export const shortcut: ShortcutMessages = {
  // handleSessionShortcutCommand — no config
  noConfig: "No writable config is currently loaded.",

  // agent not registered
  agentNotRegistered: (agent, hint) => `Agent "${agent}" is not registered. ${hint}`,
  agentNotRegisteredAvailable: (names) => `Available: ${names}`,
  agentNotRegisteredNone: "No agents are registered yet. Run /agent add <template> first.",

  // reuse existing logical session
  reuseHeader: (display) => `Switched to session "${display}"`,
  reuseWorkspace: (name) => `- Reusing workspace: ${name}`,
  reuseSession: (display) => `- Reusing session: ${display}`,

  // new session created
  createdHeader: (display) => `Created and switched to session "${display}"`,
  createdNewWorkspace: (name, cwd) => `- New workspace: ${name} -> ${cwd}`,
  createdReusedWorkspace: (name) => `- Reusing workspace: ${name}`,
  createdNewSession: (display) => `- New session: ${display}`,

  // renderShortcutSessionCreationError
  creationFailed: (alias) => `Session "${alias}" creation failed.`,
  creationFailedNewWorkspace: (name, cwd) => `- Workspace added: ${name} -> ${cwd}`,
  creationFailedReusedWorkspace: (name) => `- Reusing workspace: ${name}`,
  creationFailedSession: "- Session was not created. Please retry.",

  // resolveShortcutWorkspace — workspace errors
  workspaceNotRegistered: (workspace, hint) => `Workspace "${workspace}" is not registered. ${hint}`,
  workspaceAvailable: (names) => `Available: ${names}`,
  workspaceNone: "No workspaces are registered yet. Run /ws new <name> -d <path> first.",
  workspacePathNotFound: (cwd) => `Workspace path does not exist: ${cwd}`,
  workspaceNameUnderivable: (cwd) => `Cannot derive a workspace name from directory ${cwd}: its name has no letters or digits. Rename the directory or add a named workspace first.`,
};
