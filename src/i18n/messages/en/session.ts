import type { SessionMessages } from "../../types";

export const session: SessionMessages = {
  // Shared / guard
  noCurrent: "No session is currently selected. Run /session new ... or /use <alias> first.",

  // handleSessions
  noSessions: "No sessions yet.",
  crossChannelHint:
    "Hint: sessions from other channels were detected. Sessions are isolated per channel — please create or attach one in the current channel.",
  createSessionHint: "Create a session: /ss <agent> -d /path/to/the/project",
  createSessionExample: "Example: /ss claude -d /path/to/the/project",
  sessionListHeader: "Sessions:",
  currentLabel: "[current]",
  sessionListItem: (alias, agent, workspace) =>
    `- ${alias} (${agent} @ ${workspace})`,

  // handleSessionNew / handleSessionAttach
  sessionCreated: (alias) => `Session "${alias}" created and switched.`,
  sessionAlreadyExists: (alias, agent, workspace) =>
    [
      `Session "${alias}" already exists (${agent} @ ${workspace}).`,
      `Switch to it with /use ${alias}, or remove it first with /session rm ${alias}.`,
    ].join("\n"),
  sessionAttachNotFound: (alias, agent, workspace) =>
    [
      "No existing session found to attach.",
      `Check the session name and retry: /session attach ${alias} --agent ${agent} --ws ${workspace} --name <session-name>`,
    ].join("\n"),
  sessionAttached: (alias) => `Session "${alias}" attached and switched.`,

  // renderSwitched / appendSwitchBackContext
  switched: (alias, agent, workspace) =>
    `Switched to ${alias} · ${agent} · ${workspace}`,
  switchedWithPrev: (alias, agent, workspace, previousAlias) =>
    `Switched to ${alias} · ${agent} · ${workspace} (previous: ${previousAlias})`,
  stillRunning: (alias) => `⏳ ${alias} is still running…`,

  // handleSessionUse / handleSessionUsePrevious / handleCancel
  noMatchingSession: (input) =>
    `No session matching "${input}". Send /sessions to see all.`,
  ambiguousSession: (input) =>
    `"${input}" matches multiple sessions, please specify:`,
  noPreviousSession: "No previous session yet. Send /sessions to see all.",

  // handleModeShow / handleModeSet
  modeHeader: "Current mode:",
  modeSessionLabel: (alias) => `- Session: ${alias}`,
  modeModeLabel: (modeId) => `- mode: ${modeId}`,
  modeNotSet: "not set",
  modeSet: (modeId) => `Current session mode set to: ${modeId}`,

  modelHeader: "Current model:",
  modelSessionLabel: (alias) => `- Session: ${alias}`,
  modelModelLabel: (modelId) => `- model: ${modelId}`,
  modelNotSet: "not set (using agent default)",
  modelAvailableLabel: (models) => `- available: ${models}`,
  modelSet: (modelId) => `Current session model switched to: ${modelId}`,
  modelSetFailed: (modelId, detail) => `Failed to switch model: ${modelId}\n${detail}`,

  // handleReplyModeShow / handleReplyModeSet / handleReplyModeReset
  replyModeHeader: "Current reply mode:",
  replyModeSessionLabel: (alias) => `- Session: ${alias}`,
  replyModeGlobalDefault: (value) => `- Global default: ${value}`,
  replyModeChannelDefault: (value) => `- Channel default: ${value}`,
  replyModeSessionOverride: (value) => `- Session override: ${value}`,
  replyModeEffective: (value) => `- Effective: ${value}`,
  replyModeSet: (replyMode) => `Current session reply mode set to: ${replyMode}`,
  replyModeReset: (effective) =>
    `Session reply mode reset. Now effective: ${effective}`,

  // handleStatus
  statusHeader: "Current session:",
  statusNameLabel: (alias) => `- Name: ${alias}`,
  statusAgentLabel: (agent) => `- Agent: ${agent}`,
  statusWorkspaceLabel: (workspace) => `- Workspace: ${workspace}`,

  // promptWithSession — orchestration route error
  orchestrationRouteError:
    "Unable to record session route context. This request has been cancelled.",
  orchestrationRouteRetry:
    "Please retry later. If the issue persists, check the xacpx runtime log and state.json write permissions.",

  // handleSessionRemove
  sessionNotFound: (alias) => `Session "${alias}" does not exist.`,
  sessionBlockedByTasks: (alias, count) =>
    `Session "${alias}" has ${count} unfinished task(s). Cancel or wait for them to complete first.`,
  sessionBlockedByTasksHint:
    "Use /tasks to list tasks, or /task cancel <id> to cancel one.",
  sessionRemoved: (alias) => `Session "${alias}" removed.`,
  sessionRemovedWasActive:
    "This was the active session. Its chat context has been cleared.",
  sessionRemovedWasActivePromoted: (alias) =>
    `This was the active session. Switched back to the previous session "${alias}".`,
  sessionTransportShared: (transportSession, count) =>
    `Note: backend session "${transportSession}" is still referenced by ${count} other session(s) and was not closed.`,
  sessionOrchestrationPurgeFailed: (warning) =>
    `Note: failed to purge orchestration references (${warning}). Run /tasks clean manually to clean up.`,
  sessionTransportTeardownFailed: (warning) =>
    `Note: backend session could not be closed automatically (${warning}). Run acpx sessions close manually if needed.`,

  // sessionHelp metadata
  sessionHelpSummary: "Create, reuse, switch, and reset xacpx logical sessions.",
  sessionHelpCmdSsList: "/sessions",
  sessionHelpCmdSsListDesc: "List current sessions",
  sessionHelpCmdSsOrSlash: "/session or /ss",
  sessionHelpCmdSsOrSlashDesc: "List sessions",
  sessionHelpCmdSsQuick: "/ss <agent> (-d <path> | --ws <name>)",
  sessionHelpCmdSsQuickDesc: "Quickly create or reuse a session",
  sessionHelpCmdSsNew: "/ss new <agent> (-d <path> | --ws <name>)",
  sessionHelpCmdSsNewDesc: "Force-create a new session",
  sessionHelpCmdSsNewAlias: "/ss new <alias> -a <name> --ws <name>",
  sessionHelpCmdSsNewAliasDesc: "Create a session with explicit config",
  sessionHelpCmdSsAttach: "/ss attach <alias> -a <name> --ws <name> --name <transport-session>",
  sessionHelpCmdSsAttachDesc: "Attach to an existing session",
  sessionHelpCmdSsn: "/ssn or /help ssn",
  sessionHelpCmdSsnDesc: "Attach to a local native session (Codex and other agent-native sessions)",
  sessionHelpCmdTail: "/session tail [N]",
  sessionHelpCmdTailDesc: "Pull session history output (default 50 lines)",
  sessionHelpCmdRm: "/session rm <alias>",
  sessionHelpCmdRmDesc: "Remove a logical session",
  sessionHelpCmdUse: "/use <alias>",
  sessionHelpCmdUseDesc: "Switch to a session",
  sessionHelpCmdUseFuzzy: "/use <fragment>",
  sessionHelpCmdUseFuzzyDesc: "Switch by alias fragment (exact > prefix > substring; lists candidates on multiple matches)",
  sessionHelpCmdUsePrev: "/use -",
  sessionHelpCmdUsePrevDesc: "Switch back to the previous session (like shell cd -)",
  sessionHelpCmdReset: "/session reset or /clear",
  sessionHelpCmdResetDesc: "Reset the current session context",

  // nativeSessionHelp metadata
  nativeHelpSummary: "Attach to local native sessions of Codex and other agents.",
  nativeHelpCmdSsn: "/ssn",
  nativeHelpCmdSsnDesc: "List local native sessions using the current xacpx session context",
  nativeHelpCmdSsnAgentWs: "/ssn <agent> --ws <workspace>",
  nativeHelpCmdSsnAgentWsDesc: "Query native sessions for a workspace; auto-attach when only one candidate",
  nativeHelpCmdSsnAgentDir: "/ssn <agent> -d <path>",
  nativeHelpCmdSsnAgentDirDesc: "Query by absolute path; auto-attach when only one candidate",
  nativeHelpCmdSsnAgentAll: "/ssn <agent> --ws <workspace> --all",
  nativeHelpCmdSsnAgentAllDesc: "List all native sessions for the agent across working directories",
  nativeHelpCmdSsnNumber: "/ssn 1",
  nativeHelpCmdSsnNumberDesc: "Attach to or switch to the 1st candidate from the last listing",
  nativeHelpCmdSsnNumberAlias: "/ssn 1 -a <alias>",
  nativeHelpCmdSsnNumberAliasDesc: "Attach to the 1st candidate with an explicit xacpx alias (recommended, no full sessionId needed)",
  nativeHelpCmdSsnAttach: "/ssn attach <sessionId> -a <alias>",
  nativeHelpCmdSsnAttachDesc: "Attach by native sessionId (use when you know the full id) and assign an xacpx alias",
  nativeHelpCmdSsnAttachLong: "/ss attach native <sessionId> -a <alias>",
  nativeHelpCmdSsnAttachLongDesc: "Long form of /ssn attach",
  nativeHelpNote1:
    "/ss manages xacpx logical sessions; /ssn only queries and attaches to agent-native sessions.",
  nativeHelpNote2:
    "After attaching, subsequent messages continue the same agent-native session rather than cloning a new context.",
  nativeHelpNote3:
    "If the current acpx or agent does not support native sessions, keep using /ss.",
  nativeHelpNote4: "Full documentation at docs/native-sessions.md.",

  // modeHelp metadata
  modeHelpSummary: "View or set the mode for the current session.",
  modeHelpCmdShow: "/mode",
  modeHelpCmdShowDesc: "Show the saved mode of the current session",
  modeHelpCmdSet: "/mode <id>",
  modeHelpCmdSetDesc: "Set the current session mode",

  // modelHelp metadata
  modelHelpSummary: "View or switch the LLM model for the current session.",
  modelHelpCmdShow: "/model",
  modelHelpCmdShowDesc: "Show the current session model and the available ones",
  modelHelpCmdSet: "/model <id>",
  modelHelpCmdSetDesc: "Switch the current session model (e.g. gpt-5.2[high])",

  // replyModeHelp metadata
  replyModeHelpSummary: "View or set the reply output mode for the current logical session.",
  replyModeHelpCmdShow: "/replymode",
  replyModeHelpCmdShowDesc: "Show global default, current override, and effective value",
  replyModeHelpCmdStream: "/replymode stream",
  replyModeHelpCmdStreamDesc: "Use streaming replies for the current session",
  replyModeHelpCmdVerbose: "/replymode verbose",
  replyModeHelpCmdVerboseDesc: "Streaming replies with tool-call visibility for the current session",
  replyModeHelpCmdFinal: "/replymode final",
  replyModeHelpCmdFinalDesc: "Send only the final text for the current session",
  replyModeHelpCmdReset: "/replymode reset",
  replyModeHelpCmdResetDesc: "Clear the session override and revert to the global default",

  // statusHelp metadata
  statusHelpSummary: "View the status of the currently selected session.",
  statusHelpCmdShow: "/status",
  statusHelpCmdShowDesc: "Show the current session status",

  // cancelHelp metadata
  cancelHelpSummary: "Cancel the in-progress task in a session.",
  cancelHelpCmdCancel: "/cancel",
  cancelHelpCmdCancelDesc: "Cancel the current foreground session task",
  cancelHelpCmdCancelAlias: "/cancel <alias>",
  cancelHelpCmdCancelAliasDesc: "Cancel the task in the specified (including background) session",
  cancelHelpCmdStop: "/stop",
  cancelHelpCmdStopDesc: "Cancel the current task (alias for /cancel)",
  cancelHelpCmdStopAlias: "/stop <alias>",
  cancelHelpCmdStopAliasDesc: "Cancel the task in the specified session (alias for /cancel <alias>)",
};
