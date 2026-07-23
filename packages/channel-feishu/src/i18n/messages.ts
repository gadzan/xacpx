/**
 * Shape of the bilingual catalog for the Feishu channel plugin.
 *
 * Static strings are `string`.
 * Interpolated strings are typed `(args) => string`.
 */

export interface FeishuMessages {
  // ---- strings (permission / abort ack) ----
  /** Acknowledgement sent when a running task is stopped. */
  abortAck: string;
  /** Footnote appended to an error message. */
  errorFootnote: (tail: string) => string;
  /** Error shown when required Feishu API scopes are missing. */
  permissionScopeMissing: (scopes: string) => string;
  /** Generic hint when no scope list is available. */
  permissionGenericScopeHint: string;
  /** Prompt telling an admin to grant the missing scopes. */
  permissionPromptToGrant: string;

  // ---- card-builder ----
  /** Card summary for thinking/streaming states. */
  summaryProcessing: string;
  /** Card summary for the complete state. */
  summaryComplete: string;
  /** Card summary for the aborted state. */
  summaryStopped: string;
  /** Card summary for the error state. */
  summaryError: string;
  /** Footer text while the card is in the "thinking" state (no elapsed time). */
  footerThinking: string;
  /** Footer text while the card is in the "thinking" state (with elapsed time). */
  footerThinkingElapsed: (elapsed: string) => string;
  /** Footer text for the aborted state. */
  footerAborted: (elapsedSuffix: string) => string;
  /** Footer text for the error state. */
  footerError: (elapsedSuffix: string) => string;
  /** Footer text for the complete state (with elapsed time). */
  footerComplete: (elapsed: string) => string;
  /** Footer text while the card is streaming (with elapsed time). */
  footerStreaming: (elapsed: string) => string;
  /** Collapsible panel header for the reasoning section (no elapsed time). */
  reasoningHeader: string;
  /** Collapsible panel header for the reasoning section (with elapsed time). */
  reasoningHeaderElapsed: (elapsed: string) => string;
  /** Text appended to the tool-use panel when entries are omitted. */
  toolPanelOmitted: (count: number) => string;
  /** Collapsible panel header for the tool-use section. */
  toolPanelHeader: (count: number) => string;
  /** Group header line for a delegating subagent step (with child count). */
  subagentHeader: (toolName: string, childCount: number) => string;
  /** Placeholder shown under a subagent that reported no child activity. */
  subagentNoActivity: string;
  /** Collapsible panel header for the plan/todo section (done / total). */
  planPanelHeader: (done: number, total: number) => string;
  /** Text appended to the plan panel when entries are omitted. */
  planPanelOmitted: (count: number) => string;

  // ---- channel ----
  /** Fallback text sent when an orchestration task completes with no result text. */
  taskCompleted: string;
  /** Error notice sent when a scheduled task fails (with task id). */
  scheduledFailureWithId: (taskId: string, message: string) => string;
  /** Error notice sent when a scheduled task fails (no task id). */
  scheduledFailure: (message: string) => string;

  // ---- feishu-provider ----
  /** Validation error when appId is missing. */
  providerMissingAppId: string;
  /** Validation error when appSecret is missing. */
  providerMissingAppSecret: string;
  /** Validation error when no account has both appId and appSecret configured. */
  providerAccountsMissingCredentials: string;

  // ---- completion-notice ----
  /** Short notice when a backgrounded session completes successfully. */
  completionDone: (displayAlias: string) => string;
  /** Short notice when a backgrounded session fails. */
  completionError: (displayAlias: string) => string;
}
