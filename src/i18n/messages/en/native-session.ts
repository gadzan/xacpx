import type { NativeSessionMessages } from "../../types";

export const nativeSession: NativeSessionMessages = {
  // handleNativeSessionList — unsupported transport
  transportNotSupported: "The current transport does not support listing local sessions. Keep using /ss.\nHelp: /help ssn",

  // handleNativeSessionList — no sessions found
  noSessionsFound: (agentDisplayName, workspaceLabel) =>
    `No local ${agentDisplayName} sessions found (${workspaceLabel}).`,
  noSessionsFoundHint: "Try again later, or keep your current logical session with /ss.",

  // handleNativeSessionSelect
  selectPrompt: "Please specify the native session number or sessionId to switch to.\nHelp: /help ssn",
  noCachedList: "No cached native session list available. Run /ssn first, then select.\nHelp: /help ssn",
  indexOutOfRange: "Index out of range. Run /ssn again to refresh the list.",

  // attachNativeSession
  attachNotSupported: "The current transport does not support attaching to local sessions. Keep using /ss.",
  alreadySwitched: (agentDisplayName, displayAlias) =>
    `Switched to already-attached local session: ${agentDisplayName} · ${displayAlias}`,
  attachVerificationFailed: (agentDisplayName) =>
    `Local ${agentDisplayName} session attach failed: no resumed backend session detected.`,
  attachedAndSwitched: (agentDisplayName, displayAlias) =>
    `Attached to local ${agentDisplayName} session and switched: ${displayAlias}`,

  // resolveNativeTarget / resolveNativeWorkspace
  noContextHint: "Please select a context first, e.g.:\n/ssn codex --ws project\n/ssn codex -d /Users/me/project\nHelp: /help ssn",
  agentNotRegistered: (agent) => `Agent "${agent}" is not registered.`,
  workspaceNotRegistered: (workspace) => `Workspace "${workspace}" is not registered.`,
  workspacePathNotFound: (cwd) => `Workspace path does not exist: ${cwd}`,
  workspaceNameUnderivable: (cwd) => `Cannot derive a workspace name from directory ${cwd}: its name has no letters or digits. Rename the directory or add a named workspace first.`,
  noWritableConfig: "No writable config is loaded. Cannot create a workspace from a path.",

  // renderNativeSessionTableList
  tableHeader: (agentDisplayName, workspaceLabel) =>
    `Local ${agentDisplayName} sessions (${workspaceLabel}):`,
  tableColNum: "#",
  tableColTitle: "Title",
  tableColUpdatedAt: "Updated",
  tableColId: "ID",
  tableAttachedLabel: (displayAlias) => `attached: ${displayAlias}`,
  tableAttachedCurrent: " [current]",
  tableActions: "Actions:",
  tableActionAttach: "Attach: /ssn 1",
  tableActionAlias: "With alias: /ssn 1 -a fix-ci",
  tableActionHelp: "Help: /help ssn",
  tableMore: (cmd) => `More: ${cmd}`,

  // renderNativeSessionCardList
  cardHeader: (agentDisplayName, workspaceLabel) =>
    `Local ${agentDisplayName} sessions (${workspaceLabel}):`,
  cardReplyHint: "Reply with a number to attach. The ID suffix distinguishes sessions.",
  cardTimeLabel: (updatedAt) => `Updated: ${updatedAt}`,
  cardIdLabel: (idTail) => `ID: ${idTail}`,
  cardAttachedLabel: (displayAlias) => `attached: ${displayAlias}`,
  cardAttachedCurrent: " [current]",
  cardActions: "Actions:",
  cardActionAttach: "Attach: /ssn 1",
  cardActionAlias: "With alias: /ssn 1 -a fix-ci",
  cardActionHelp: "Help: /help ssn",
  cardMore: (cmd) => `More: ${cmd}`,

  // renderNativeListError / renderNativeResumeError
  listError: (agentDisplayName, errorMessage) =>
    `Local ${agentDisplayName} session listing failed: ${errorMessage}`,
  listErrorHint: "Confirm that acpx/Agent supports native session listing, or keep using /ss.",
  listErrorHelp: "Help: /help ssn",
  resumeError: (agentDisplayName, errorMessage) =>
    `Local ${agentDisplayName} session attach failed: ${errorMessage}`,
  resumeErrorHint: "Confirm that acpx/Agent supports native session resume, or keep using /ss.",
  resumeErrorHelp: "Help: /help ssn",
};
