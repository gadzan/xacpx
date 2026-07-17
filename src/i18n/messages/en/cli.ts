import type { CliMessages } from "../../types";

export const cli: CliMessages = {
  // HELP_LINES — usage text printed by --help and on unknown commands
  helpLines: [
    "Usage:",
    "xacpx login  - WeChat login",
    "xacpx logout - Log out",
    "xacpx run    - Run in the foreground",
    "xacpx start  - Start in the background",
    "xacpx status - Check daemon status",
    "xacpx stop   - Stop the daemon",
    "xacpx restart - Restart the background daemon",
    "xacpx update [--all|<name>] - Update xacpx and installed plugins",
    "xacpx channel|ch list|show|add|rm|enable|disable [--account <id>] - Manage message channels (use --account for multi-bot)",
    "xacpx plugin list|add|update|remove|enable|disable|doctor|known - Manage plugins",
    "xacpx doctor - Run diagnostics",
    "xacpx version - Show version",
    "xacpx agent|agents list|add|rm|templates - Manage local agents",
    "xacpx adapter list|check [name]|update (<name>|--all)|set <name> <version>|reset <name> - Manage ACP adapter versions",
    "xacpx workspace list|add [name] [--raw]|rm <name> - Manage local workspaces (alias: ws)",
    "xacpx later|lt list|cancel <id> - Manage local scheduled tasks",
    "xacpx mcp-stdio [--coordinator-session <session>] [--source-handle <handle>] [--workspace <name>] - Start MCP stdio server",
  ],

  // start command
  alreadyRunning: "xacpx is already running in the background",
  started: "xacpx started in the background",
  startFailed: (detail) => `xacpx failed to start: ${detail}`,

  // status command
  running: "xacpx is running",
  notRunning: "xacpx is not running",
  indeterminate: "xacpx process is still running but status metadata is missing",

  // stop command
  stopped: "xacpx stopped",

  // restart command
  restarting: "xacpx restarting...",
  restartNotRunning: "xacpx is not running, starting...",
  restartFailed: (detail) => `xacpx failed to restart: ${detail}`,
  restartIndeterminate: "xacpx process is still running but status metadata is missing",
  restartIndeterminateHint: "Run `xacpx stop` first, or manually clean up the stale PID/status before retrying.",

  // daemon log hints
  checkAppLog: (path) => `Check App Log: ${path}`,
  checkStderrLog: (path) => `Check Stderr: ${path}`,

  // workspace commands
  workspaceEmpty: "No workspaces yet.",
  workspaceListHeader: "Workspaces:",
  workspaceNameEmpty: "Workspace name cannot be empty.",
  workspaceNameSanitized: (sourceLabel, original, saved) =>
    `${sourceLabel} ${JSON.stringify(original)} contains special characters and was saved as "${saved}". Add --raw to keep the original name.`,
  workspaceSourceLabelDir: "Directory name",
  workspaceSourceLabelName: "Name",
  workspaceAlreadyExists: (name, cwd) => `Workspace "${name}" already exists: ${cwd}`,
  workspaceConflictPath: (name, cwd) => `Workspace "${name}" already exists with a different path: ${cwd}`,
  workspaceConflictHint: (name) => `Choose a different name, or run: xacpx workspace rm ${name}`,
  workspaceSaved: (name, cwd) => `Workspace "${name}" saved: ${cwd}`,
  workspaceNotFound: (name) => `Workspace "${name}" not found.`,
  workspaceRemoved: (name) => `Workspace "${name}" removed`,

  // agent commands
  agentEmpty: "No agents yet.",
  agentListHeader: "Agent list:",
  agentTemplatesHeader: "Available agent templates:",
  agentNameEmpty: "Agent name cannot be empty.",
  agentUnsupportedTemplate: (templates) => `This agent template is not supported. Available: ${templates.join(", ")}`,
  agentAlreadyExists: (name) => `Agent "${name}" already exists`,
  agentAlreadyExistsDifferent: (name) => `Agent "${name}" already exists with a different configuration. Run: xacpx agent rm ${name}`,
  agentSaved: (name) => `Agent "${name}" saved`,
  agentNotFound: (name) => `Agent "${name}" not found.`,
  agentRemoved: (name) => `Agent "${name}" removed`,

  // adapter commands
  adapterListHeader: "Managed ACP adapters:",
  adapterListRow: (id, effective, defaultVersion, source) =>
    `${id}: effective=${effective} default=${defaultVersion} source=${source}`,
  adapterSourceDefault: "xacpx-default",
  adapterSourceConfigured: "configured",
  adapterUnsupported: (id) => `Unsupported managed adapter "${id}". Available: codex, claude`,
  adapterInvalidVersion: (version) => `Adapter version must be an exact semver value: ${version}`,
  adapterVersionUnavailable: (id, version) => `${id} adapter version ${version} is not published by npm.`,
  adapterLatestUnavailable: (id) => `Could not resolve the latest ${id} adapter version from npm.`,
  adapterCheckRow: (id, effective, latest) => `${id}: effective=${effective} latest=${latest}`,
  adapterAlreadyLatest: (id, version) => `${id} already uses the latest adapter version ${version}.`,
  adapterVerifying: (id, version) => `Verifying ${id} adapter ${version} with ACP initialize...`,
  adapterSaved: (id, version) => `${id} adapter version set to ${version}.`,
  adapterReset: (id, version) => `${id} adapter override removed; effective version is ${version}.`,
  adapterFailed: (id, detail) => `Failed to update ${id} adapter: ${detail}`,
  adapterRestartRequired: "Restart the xacpx daemon before using the new adapter version.",

  // later commands
  laterIdEmpty: "Scheduled task ID cannot be empty.",
  laterNotFound: (id) => `Pending scheduled task #${id} not found.`,
  laterNotFoundHint: "Run xacpx later list to see current pending tasks.",
  laterCancelled: (id) => `Scheduled task #${id} cancelled`,
};
