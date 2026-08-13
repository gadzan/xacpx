import { MSG, type AgentsCreatePayload, type AgentsRemovePayload, type CommandExecutePayload, type FsCopyPayload, type FsCreatePayload, type FsDeletePayload, type FsDiffPayload, type FsDownloadPayload, type FsListPayload, type FsReadPayload, type FsRenamePayload, type FsSearchPayload, type FsWritePayload, type GitCheckoutPayload, type GitCommitPayload, type GitFetchPayload, type GitPathsPayload, type GitPullPayload, type GitPushPayload, type GitStatusPayload, type GitWorktreeCreatePayload, type OrchestrationCancelPayload, type OrchestrationGetPayload, type PromptCancelPayload, type PromptPayload, type QueueCancelPayload, type ScheduledCancelPayload, type ScheduledCreatePayload, type ScheduledListPayload, type SessionModelGetPayload, type SessionModelSetPayload, type SessionEffortGetPayload, type SessionEffortSetPayload, type SessionsArchivePayload, type SessionsCreatePayload, type SessionsListPayload, type SessionsNativeListPayload, type SessionsRemovePayload, type SessionsRenamePayload, type SessionsUnarchivePayload, type TerminalAttachPayload, type TerminalCreatePayload, type TerminalDetachPayload, type TerminalHeartbeatPayload, type TerminalInputPayload, type TerminalOpenPayload, type TerminalResyncPayload, type TerminalResizePayload, type TerminalResourceExitPayload, type TerminalStreamStartPayload, type TerminalTakeControlPayload, type TerminalTerminatePayload, type TerminalViewerEventPayload, type UploadPayload, type WorkspacesCreatePayload, type WorkspacesRemovePayload } from "./messages.js";
export type Validator<T> = (payload: unknown) => T | null;
/** The control-RPC message types that carry a client-supplied payload to validate.
 *  Excludes: handshake (instanceRegister/instanceAuth — validated in instance-gateway),
 *  event-direction (instanceEvent/instanceNotice — boundary B via validControlEvent),
 *  terminal I/O events (legacy terminalInput/Resize/Close and recoverable terminal
 *  stream/input/resize/heartbeat/detach/viewer-event/resource-exit — see
 *  parseTerminalEventPayload), and the four no-payload list RPCs
 *  (agentsList/workspacesList/agentsCatalog/orchestrationList). */
export type ControlRpcType = typeof MSG.sessionsList | typeof MSG.sessionsCreate | typeof MSG.sessionsNativeList | typeof MSG.sessionsRemove | typeof MSG.sessionsArchive | typeof MSG.sessionsUnarchive | typeof MSG.sessionsRename | typeof MSG.workspacesCreate | typeof MSG.agentsCreate | typeof MSG.agentsRemove | typeof MSG.workspacesRemove | typeof MSG.prompt | typeof MSG.promptCancel | typeof MSG.queueCancel | typeof MSG.commandExecute | typeof MSG.scheduledList | typeof MSG.scheduledCreate | typeof MSG.scheduledCancel | typeof MSG.orchestrationGet | typeof MSG.orchestrationCancel | typeof MSG.fsList | typeof MSG.fsRead | typeof MSG.fsDiff | typeof MSG.fsSearch | typeof MSG.fsCreate | typeof MSG.fsRename | typeof MSG.fsDelete | typeof MSG.fsCopy | typeof MSG.fsDownload | typeof MSG.fsWrite | typeof MSG.sessionModelGet | typeof MSG.sessionModelSet | typeof MSG.sessionEffortGet | typeof MSG.sessionEffortSet | typeof MSG.gitStatus | typeof MSG.gitStage | typeof MSG.gitUnstage | typeof MSG.gitUntrack | typeof MSG.gitDiscard | typeof MSG.gitCommit | typeof MSG.gitFetch | typeof MSG.gitPull | typeof MSG.gitPush | typeof MSG.gitCheckout | typeof MSG.gitWorktreeCreate | typeof MSG.terminalCreate | typeof MSG.terminalAttach | typeof MSG.terminalOpen | typeof MSG.terminalTakeControl | typeof MSG.terminalResync | typeof MSG.terminalTerminate | typeof MSG.upload;
/** Registry: control-RPC type → shape validator. `satisfies` locks both directions —
 *  a ControlRpcType with no validator, or a validator whose key isn't a ControlRpcType,
 *  is a compile error. */
export declare const CONTROL_PAYLOAD_VALIDATORS: {
    "control.sessions.list": Validator<SessionsListPayload>;
    "control.sessions.create": Validator<SessionsCreatePayload>;
    "control.sessions.native.list": Validator<SessionsNativeListPayload>;
    "control.sessions.remove": Validator<SessionsRemovePayload>;
    "control.sessions.archive": Validator<SessionsArchivePayload>;
    "control.sessions.unarchive": Validator<SessionsUnarchivePayload>;
    "control.sessions.rename": Validator<SessionsRenamePayload>;
    "control.workspaces.create": Validator<WorkspacesCreatePayload>;
    "control.agents.create": Validator<AgentsCreatePayload>;
    "control.agents.remove": Validator<AgentsRemovePayload>;
    "control.workspaces.remove": Validator<WorkspacesRemovePayload>;
    "control.prompt": Validator<PromptPayload>;
    "control.prompt.cancel": Validator<PromptCancelPayload>;
    "control.queue.cancel": Validator<QueueCancelPayload>;
    "control.command.execute": Validator<CommandExecutePayload>;
    "control.scheduled.list": Validator<ScheduledListPayload>;
    "control.scheduled.create": Validator<ScheduledCreatePayload>;
    "control.scheduled.cancel": Validator<ScheduledCancelPayload>;
    "control.orchestration.get": Validator<OrchestrationGetPayload>;
    "control.orchestration.cancel": Validator<OrchestrationCancelPayload>;
    "control.fs.list": Validator<FsListPayload>;
    "control.fs.read": Validator<FsReadPayload>;
    "control.fs.diff": Validator<FsDiffPayload>;
    "control.fs.search": Validator<FsSearchPayload>;
    "control.fs.create": Validator<FsCreatePayload>;
    "control.fs.rename": Validator<FsRenamePayload>;
    "control.fs.delete": Validator<FsDeletePayload>;
    "control.fs.copy": Validator<FsCopyPayload>;
    "control.fs.download": Validator<FsDownloadPayload>;
    "control.fs.write": Validator<FsWritePayload>;
    "control.git.status": Validator<GitStatusPayload>;
    "control.git.stage": Validator<GitPathsPayload>;
    "control.git.unstage": Validator<GitPathsPayload>;
    "control.git.untrack": Validator<GitPathsPayload>;
    "control.git.discard": Validator<GitPathsPayload>;
    "control.git.commit": Validator<GitCommitPayload>;
    "control.git.fetch": Validator<GitFetchPayload>;
    "control.git.pull": Validator<GitPullPayload>;
    "control.git.push": Validator<GitPushPayload>;
    "control.git.checkout": Validator<GitCheckoutPayload>;
    "control.git.worktree.create": Validator<GitWorktreeCreatePayload>;
    "control.session.model.get": Validator<SessionModelGetPayload>;
    "control.session.model.set": Validator<SessionModelSetPayload>;
    "control.session.effort.get": Validator<SessionEffortGetPayload>;
    "control.session.effort.set": Validator<SessionEffortSetPayload>;
    "control.terminal.create": Validator<TerminalCreatePayload>;
    "control.terminal.attach": Validator<TerminalAttachPayload>;
    "instance.terminal.open": Validator<TerminalOpenPayload>;
    "instance.terminal.take-control": Validator<TerminalTakeControlPayload>;
    "instance.terminal.resync": Validator<TerminalResyncPayload>;
    "instance.terminal.terminate": Validator<TerminalTerminatePayload>;
    "control.upload": Validator<UploadPayload>;
};
/** The payload type bound to a control-RPC message, derived from its validator's return. */
export type PayloadFor<T extends ControlRpcType> = NonNullable<ReturnType<(typeof CONTROL_PAYLOAD_VALIDATORS)[T]>>;
/** Type-safe replacement for `payload as XxxPayload`: validates shape, returns the bound
 *  payload type or null. */
export declare function parseControlPayload<T extends ControlRpcType>(type: T, payload: unknown): PayloadFor<T> | null;
/** Recoverable terminal event message types (hub↔connector fire-and-forget / targeted push). */
export type TerminalEventType = typeof MSG.terminalStreamStart | typeof MSG.terminalInput | typeof MSG.terminalResize | typeof MSG.terminalHeartbeat | typeof MSG.terminalDetach | typeof MSG.terminalViewerEvent | typeof MSG.terminalResourceExit;
export declare const TERMINAL_EVENT_PAYLOAD_VALIDATORS: {
    "instance.terminal.stream-start": Validator<TerminalStreamStartPayload>;
    "instance.terminal.input": Validator<TerminalInputPayload>;
    "instance.terminal.resize": Validator<TerminalResizePayload>;
    "instance.terminal.heartbeat": Validator<TerminalHeartbeatPayload>;
    "instance.terminal.detach": Validator<TerminalDetachPayload>;
    "instance.terminal.viewer-event": Validator<TerminalViewerEventPayload>;
    "instance.terminal.resource-exit": Validator<TerminalResourceExitPayload>;
};
export type TerminalEventPayloadFor<T extends TerminalEventType> = NonNullable<ReturnType<(typeof TERMINAL_EVENT_PAYLOAD_VALIDATORS)[T]>>;
/** Validate a recoverable terminal event payload (not the legacy live-PTY shapes). */
export declare function parseTerminalEventPayload<T extends TerminalEventType>(type: T, payload: unknown): TerminalEventPayloadFor<T> | null;
