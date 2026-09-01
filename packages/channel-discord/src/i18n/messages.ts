export interface DiscordMessages {
  abortAck: string;
  errorFootnote: (tail: string) => string;
  permissionGenericHint: string;
  summaryProcessing: string;
  summaryComplete: string;
  summaryStopped: string;
  summaryError: string;
  taskCompleted: string;
  scheduledFailureWithId: (taskId: string, message: string) => string;
  scheduledFailure: (message: string) => string;
  providerMissingToken: string;
  providerAccountsMissingCredentials: string;
  completionDone: (displayAlias: string) => string;
  completionError: (displayAlias: string) => string;
}
