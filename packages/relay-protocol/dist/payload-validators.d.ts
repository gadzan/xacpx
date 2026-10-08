import { MSG, type AgentsCreatePayload, type AgentsRemovePayload, type BotsCreatePayload, type BotsDeletePayload, type BotsGetPayload, type BotsUpdatePayload, type CommandExecutePayload, type ConversationHistoryPayload, type ConversationPromptPayload, type ConversationsGetPayload, type ConversationsListPayload, type DesktopCancelPayload, type DesktopPreparePayload, type GroupsCreatePayload, type GroupsDeletePayload, type GroupsGetPayload, type GroupsUpdatePayload, type GroupTopicsArchivePayload, type GroupTopicsCreatePayload, type GroupTopicsTeardownPayload, type FsCopyPayload, type FsCreatePayload, type FsDeletePayload, type FsDiffPayload, type FsDownloadPayload, type FsBrowsePayload, type FsListPayload, type FsReadPayload, type FsRenamePayload, type FsSearchPayload, type FsWritePayload, type GitCheckoutPayload, type GitCommitPayload, type GitFetchPayload, type GitPathsPayload, type GitPullPayload, type GitPushPayload, type GitStatusPayload, type GitWorktreeCreatePayload, type InteractionRequestPayload, type InteractionResponsePayload, type InteractionWithdrawPayload, type OrchestrationCancelPayload, type OrchestrationGetPayload, type PromptCancelPayload, type PromptPayload, type QueueCancelPayload, type RunsCancelPayload, type RunsResolveIndeterminatePayload, type BotsTeardownDirectPayload, type DirectTopicsTeardownPayload, type RunsGetPayload, type RunsListPayload, type ScheduledCancelPayload, type ScheduledCreatePayload, type ScheduledListPayload, type SessionModelGetPayload, type SessionModelSetPayload, type SessionEffortGetPayload, type SessionEffortSetPayload, type SessionsArchivePayload, type SessionsCreatePayload, type SessionsListPayload, type SessionsNativeListPayload, type SessionsRemovePayload, type SessionsRenamePayload, type SessionsUnarchivePayload, type TerminalAttachPayload, type TerminalCreatePayload, type TerminalDetachPayload, type TerminalHeartbeatPayload, type TerminalInputPayload, type TerminalOpenPayload, type TerminalResyncPayload, type TerminalResizePayload, type TerminalResourceExitPayload, type TerminalStreamStartPayload, type TerminalTakeControlPayload, type TerminalTerminatePayload, type TerminalViewerEventPayload, type TopicsCreatePayload, type TopicsListPayload, type UploadPayload, type WorkspacesCreatePayload, type WorkspacesRemovePayload } from "./messages.js";
export type Validator<T> = (payload: unknown) => T | null;
/**
 * One normalized form field.
 *
 * The field's own bounds are checked here so a hub cannot forward a shape core
 * never produced (e.g. a 100k-char title, or a select with a million options).
 * An out-of-range field invalidates the whole request: a partially-validated
 * form would render a question the agent did not ask.
 *
 * The wire's copy of core's normalized-form bounds, and why it needs its own
 * table below: `relayFieldsFrom()` is contracted to copy the form core already
 * normalized and bounded, field for field. That makes core's
 * `ELICITATION_SCHEMA_LIMITS` the authority on what a LEGAL form looks like, and
 * this module must accept all of it — a stricter number here rejects a form core
 * accepted, which turns a legal elicitation into a transport failure rather than
 * a UI difference. A looser number is also wrong: the validator's own claim is
 * that it refuses shapes "core never produced", and a bound wider than core's
 * cannot keep that claim.
 *
 * Both failures have already happened. `key` was capped at 64 against core's 128,
 * so a legal 80-character key made the whole request unopenable; and
 * `schemaTitle` had no length check at all while the section comment implied one.
 *
 * `relay-protocol` does not import core's constants, so these values must be kept
 * in sync by hand — which is why the boundary tests below assert that every core
 * MAXIMUM is accepted and every core maximum + 1 is refused. A drift there is red
 * instead of an unexplained cancel in production.
 */
export declare const INTERACTION_WIRE_LIMITS: {
    /** Field key. Core: `maxFieldKeyLength`. */
    readonly maxFieldKey: 128;
    /** Field title, and the schema-level title reuses the same bound. */
    readonly maxTitle: 256;
    /** Field and option description. Core: `maxFieldDescriptionLength`. */
    readonly maxDescription: 1000;
    /** Fields in one form. Core: `maxFields`. */
    readonly maxFields: 20;
    /** Options in one select. Core: `maxOptionsPerField`. */
    readonly maxOptions: 100;
    /** Option value and label. Core: `maxOptionValueLength` / `maxOptionLabelLength`. */
    readonly maxOptionText: 256;
    /** A string default, and each item of an array default. Core: `maxDefaultValueLength`. */
    readonly maxDefaultText: 256;
    /** The pattern, carried as text and never compiled. Core's own bound. */
    readonly maxPattern: 512;
    /** A `format` name: open string, bounded. Core: `maxFormatLength`. */
    readonly maxFormat: 64;
    /** The schema-level description. Core: `maxFieldDescriptionLength`. */
    readonly maxSchemaDescription: 1000;
    /** The prose message. Core carries this separately from the schema metadata. */
    readonly maxMessage: 8000;
};
/**
 * The opened-interaction request.
 *
 * Requires the kind's own payload: an `elicitation` request with no
 * `elicitation` block, or a `permission` request with no `permission` block, is
 * rejected rather than forwarded to a renderer that has nothing to render.
 */
export declare const validateInteractionRequest: Validator<InteractionRequestPayload>;
/**
 * The human's decision.
 *
 * Carries NO responder identity — the hub stamps that. A frame that smuggles one
 * in is rejected rather than having the field silently dropped: an explicit
 * rejection surfaces the protocol violation, whereas dropping would let a
 * client believe it asserted an identity that was ignored.
 *
 * EXPORTED because the connector re-validates every answer it is handed against
 * it. A second, weaker local check would let a hub/connector pair drift on what
 * counts as an answer — including on the identity rule, which is the one part
 * that must not drift.
 */
export declare const validateInteractionResponse: Validator<InteractionResponsePayload>;
/**
 * Connector -> hub WITHDRAW: which interaction, and nothing else.
 *
 * No reason and no identity — the withdrawal IS the request, and the hub's
 * registry treats withdrawing an already-closed interaction as success, so a
 * withdrawal racing a resolve cannot be observed as an error.
 */
export declare const validateInteractionWithdraw: Validator<InteractionWithdrawPayload>;
/** The control-RPC message types that carry a client-supplied payload to validate.
 *  Excludes: handshake (instanceRegister/instanceAuth — validated in instance-gateway),
 *  event-direction (instanceEvent/instanceNotice — boundary B via validControlEvent),
 *  terminal I/O events (legacy terminalInput/Resize/Close and recoverable terminal
 *  stream/input/resize/heartbeat/detach/viewer-event/resource-exit — see
 *  parseTerminalEventPayload), and the no-payload list RPCs
 *  (agentsList/workspacesList/agentsCatalog/orchestrationList/botsList). */
export type ControlRpcType = typeof MSG.sessionsList | typeof MSG.sessionsCreate | typeof MSG.sessionsNativeList | typeof MSG.sessionsRemove | typeof MSG.sessionsArchive | typeof MSG.sessionsUnarchive | typeof MSG.sessionsRename | typeof MSG.workspacesCreate | typeof MSG.agentsCreate | typeof MSG.agentsRemove | typeof MSG.workspacesRemove | typeof MSG.prompt | typeof MSG.promptCancel | typeof MSG.queueCancel | typeof MSG.commandExecute | typeof MSG.scheduledList | typeof MSG.scheduledCreate | typeof MSG.scheduledCancel | typeof MSG.orchestrationGet | typeof MSG.orchestrationCancel | typeof MSG.fsList | typeof MSG.fsBrowse | typeof MSG.fsRead | typeof MSG.fsDiff | typeof MSG.fsSearch | typeof MSG.fsCreate | typeof MSG.fsRename | typeof MSG.fsDelete | typeof MSG.fsCopy | typeof MSG.fsDownload | typeof MSG.fsWrite | typeof MSG.sessionModelGet | typeof MSG.sessionModelSet | typeof MSG.sessionEffortGet | typeof MSG.sessionEffortSet | typeof MSG.gitStatus | typeof MSG.gitStage | typeof MSG.gitUnstage | typeof MSG.gitUntrack | typeof MSG.gitDiscard | typeof MSG.gitCommit | typeof MSG.gitFetch | typeof MSG.gitPull | typeof MSG.gitPush | typeof MSG.gitCheckout | typeof MSG.gitWorktreeCreate | typeof MSG.terminalCreate | typeof MSG.terminalAttach | typeof MSG.terminalOpen | typeof MSG.terminalTakeControl | typeof MSG.terminalResync | typeof MSG.terminalTerminate | typeof MSG.desktopPrepare | typeof MSG.upload | typeof MSG.botsGet | typeof MSG.botsCreate | typeof MSG.botsUpdate | typeof MSG.botsDelete | typeof MSG.conversationsList | typeof MSG.conversationsGet | typeof MSG.topicsList | typeof MSG.topicsCreate | typeof MSG.groupsCreate | typeof MSG.groupsUpdate | typeof MSG.groupsDelete | typeof MSG.groupsGet | typeof MSG.groupsList | typeof MSG.groupTopicsCreate | typeof MSG.groupTopicsArchive | typeof MSG.groupTopicsTeardown | typeof MSG.conversationPrompt | typeof MSG.conversationHistory | typeof MSG.conversationBindingsList | typeof MSG.conversationBindingsSet | typeof MSG.conversationBindingsDelete | typeof MSG.runsGet | typeof MSG.runsList | typeof MSG.runsCancel | typeof MSG.runsResolveIndeterminate | typeof MSG.botsTeardownDirect | typeof MSG.directTopicsTeardown | typeof MSG.interactionRequest | typeof MSG.interactionRespond | typeof MSG.interactionWithdraw;
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
    "control.fs.browse": Validator<FsBrowsePayload>;
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
    "instance.desktop.prepare": Validator<DesktopPreparePayload>;
    "control.upload": Validator<UploadPayload>;
    "control.bots.get": Validator<BotsGetPayload>;
    "control.bots.create": Validator<BotsCreatePayload>;
    "control.bots.update": Validator<BotsUpdatePayload>;
    "control.bots.delete": Validator<BotsDeletePayload>;
    "control.conversations.list": Validator<ConversationsListPayload>;
    "control.conversations.get": Validator<ConversationsGetPayload>;
    "control.topics.list": Validator<TopicsListPayload>;
    "control.topics.create": Validator<TopicsCreatePayload>;
    "control.groups.create": Validator<GroupsCreatePayload>;
    "control.groups.update": Validator<GroupsUpdatePayload>;
    "control.groups.delete": Validator<GroupsDeletePayload>;
    "control.groups.get": Validator<GroupsGetPayload>;
    "control.groups.list": Validator<Record<string, never>>;
    "control.group.topics.create": Validator<GroupTopicsCreatePayload>;
    "control.group.topics.archive": Validator<GroupTopicsArchivePayload>;
    "control.group.topics.teardown": Validator<GroupTopicsTeardownPayload>;
    "control.conversation.prompt": Validator<ConversationPromptPayload>;
    "control.conversation.bindings.list": Validator<Record<string, never>>;
    "control.conversation.bindings.set": Validator<{
        chatKey: string;
        conversationId: string;
        topicId?: string;
    }>;
    "control.conversation.bindings.delete": Validator<{
        chatKey: string;
    }>;
    "control.conversation.history": Validator<ConversationHistoryPayload>;
    "control.runs.get": Validator<RunsGetPayload>;
    "control.runs.list": Validator<RunsListPayload>;
    "control.runs.cancel": Validator<RunsCancelPayload>;
    "control.runs.resolve-indeterminate": Validator<RunsResolveIndeterminatePayload>;
    "control.bots.teardown-direct": Validator<BotsTeardownDirectPayload>;
    "control.direct.topics.teardown": Validator<DirectTopicsTeardownPayload>;
    "control.interaction.request": Validator<import("./dtos.js").InteractionRequestDto>;
    "control.interaction.respond": Validator<import("./dtos.js").InteractionResponseDto>;
    "control.interaction.withdraw": Validator<import("./dtos.js").InteractionWithdrawDto>;
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
/** Desktop cancel is the only fire-and-forget desktop control event. */
export type DesktopEventType = typeof MSG.desktopCancel;
export declare const DESKTOP_EVENT_PAYLOAD_VALIDATORS: {
    "instance.desktop.cancel": Validator<DesktopCancelPayload>;
};
export type DesktopEventPayloadFor<T extends DesktopEventType> = T extends DesktopEventType ? DesktopCancelPayload : never;
/** Validate a desktop event payload (never the binary framebuffer path). */
export declare function parseDesktopEventPayload(type: DesktopEventType, payload: unknown): DesktopCancelPayload | null;
