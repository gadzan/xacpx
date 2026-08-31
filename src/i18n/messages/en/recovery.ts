import type { RecoveryMessages } from "../../types";

export const recovery: RecoveryMessages = {
  adapterRegistryE404: (registry, officialRegistry) =>
    `npm registry ${registry} returned E404 for the managed adapter. Run \`xacpx adapter registry set ${officialRegistry}\` and \`xacpx restart\`, or ask your registry administrator to proxy/allowlist the @agentclientprotocol scope.`,
  // renderTransportError — transient session
  transientSessionFailed: "The scheduled task's temporary session failed to start; this run was not executed.",
  transientSessionHint: "Temporary sessions are created automatically at run time — no manual action needed. To reschedule, use /lt.",

  // renderTransportError — normal session unavailable
  sessionUnavailable: (alias) => `Current session "${alias}" is temporarily unavailable.`,
  sessionUnavailableRenewHint: (alias, agent, quotedWorkspace) =>
    `Re-create it: /session new ${alias} --agent ${agent} --ws ${quotedWorkspace}`,
  sessionUnavailableAttachHint: (alias, agent, quotedWorkspace) =>
    `Or attach an existing session: /session attach ${alias} --agent ${agent} --ws ${quotedWorkspace} --name <session-name>`,

  // renderTransportError — partial output
  sessionInterrupted: (alias) => `Session "${alias}" was interrupted; no final reply received.`,
  sessionInterruptedHint: "Retry directly. If the session remains unresponsive, send /cancel first, then retry.",
  sessionInterruptedError: (summary) => `Error: ${summary}`,

  // renderTransportError — queue overflow (soft warning)
  queueOverflowWarning: "⚠️ Output too large — handled gracefully",
  queueOverflowHint: "Ask the agent to summarize or send in smaller chunks, then retry. The session is ready for your next message.",

  // renderSessionCreationError (AutoInstallFailedError)
  autoInstallHeadlineFixed: "⚠️ Auto-install ran but could not fix the session startup problem",
  autoInstallHeadlineFailed: "❌ Auto-install failed",
  autoInstallOriginalError: "Original error:",
  autoInstallStepVerifyFailed: (label) =>
    `Install ran but verification failed (${label}): session still throws a missing-dependency error`,
  autoInstallStepError: (label, stderrTail) => `Install error (${label}):\n${stderrTail}`,
  autoInstallManual: (pkg) => `Run manually: npm install -g ${pkg}`,
  autoInstallLog: (logPath) => `Detailed log: ${logPath}`,
  autoInstallScopePrecise: (manager, path) => {
    const parts = ["precise"];
    if (manager) parts.push(manager);
    if (path) parts.push(path);
    return parts.join(" / ");
  },
  autoInstallScopeGlobal: "global",

  // renderSessionCreationFailure / renderSessionCreationVerificationError
  sessionCreationFailed: "Session creation failed.",
  sessionCreationVerificationDetail: "No usable backend session detected.",
  sessionCreationError: (summary) => `Error: ${summary}`,
  sessionCreationAttachHint: (alias, agent, quotedWorkspace) =>
    `To attach an existing session instead: /session attach ${alias} --agent ${agent} --ws ${quotedWorkspace} --name <session-name>`,
};
