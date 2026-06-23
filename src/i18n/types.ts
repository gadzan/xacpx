export interface CommonMessages {
  localeName: string;
}

export interface SessionMessages {
  // Shared / guard
  noCurrent: string;

  // handleSessions
  noSessions: string;
  crossChannelHint: string;
  createSessionHint: string;
  createSessionExample: string;
  sessionListHeader: string;
  currentLabel: string;
  sessionListItem: (alias: string, agent: string, workspace: string) => string;

  // handleSessionNew / handleSessionAttach
  sessionCreated: (alias: string) => string;
  sessionAlreadyExists: (alias: string, agent: string, workspace: string) => string;
  sessionAttachNotFound: (alias: string, agent: string, workspace: string) => string;
  sessionAttached: (alias: string) => string;

  // renderSwitched / appendSwitchBackContext
  switched: (alias: string, agent: string, workspace: string) => string;
  switchedWithPrev: (alias: string, agent: string, workspace: string, previousAlias: string) => string;
  stillRunning: (alias: string) => string;

  // handleSessionUse / handleSessionUsePrevious / handleCancel
  noMatchingSession: (input: string) => string;
  ambiguousSession: (input: string) => string;
  noPreviousSession: string;

  // handleModeShow / handleModeSet
  modeHeader: string;
  modeSessionLabel: (alias: string) => string;
  modeModeLabel: (modeId: string) => string;
  modeNotSet: string;
  modeSet: (modeId: string) => string;

  // handleModelShow / handleModelSet
  modelHeader: string;
  modelSessionLabel: (alias: string) => string;
  modelModelLabel: (modelId: string) => string;
  modelNotSet: string;
  modelAvailableLabel: (models: string) => string;
  modelSet: (modelId: string) => string;
  modelSetFailed: (modelId: string, detail: string) => string;

  // handleReplyModeShow / handleReplyModeSet / handleReplyModeReset
  replyModeHeader: string;
  replyModeSessionLabel: (alias: string) => string;
  replyModeGlobalDefault: (value: string) => string;
  replyModeChannelDefault: (value: string) => string;
  replyModeSessionOverride: (value: string) => string;
  replyModeEffective: (value: string) => string;
  replyModeSet: (replyMode: string) => string;
  replyModeReset: (effective: string) => string;

  // handleStatus
  statusHeader: string;
  statusNameLabel: (alias: string) => string;
  statusAgentLabel: (agent: string) => string;
  statusWorkspaceLabel: (workspace: string) => string;

  // promptWithSession — orchestration route error
  orchestrationRouteError: string;
  orchestrationRouteRetry: string;

  // handleSessionRemove
  sessionNotFound: (alias: string) => string;
  sessionBlockedByTasks: (alias: string, count: number) => string;
  sessionBlockedByTasksHint: string;
  sessionRemoved: (alias: string) => string;
  sessionArchived: (alias: string) => string;
  sessionRemovedWasActive: string;
  sessionRemovedWasActivePromoted: (alias: string) => string;
  sessionTransportShared: (transportSession: string, count: number) => string;
  sessionOrchestrationPurgeFailed: (warning: string) => string;
  sessionTransportTeardownFailed: (warning: string) => string;

  // sessionHelp metadata
  sessionHelpSummary: string;
  sessionHelpCmdSsList: string;
  sessionHelpCmdSsListDesc: string;
  sessionHelpCmdSsOrSlash: string;
  sessionHelpCmdSsOrSlashDesc: string;
  sessionHelpCmdSsQuick: string;
  sessionHelpCmdSsQuickDesc: string;
  sessionHelpCmdSsNew: string;
  sessionHelpCmdSsNewDesc: string;
  sessionHelpCmdSsNewAlias: string;
  sessionHelpCmdSsNewAliasDesc: string;
  sessionHelpCmdSsAttach: string;
  sessionHelpCmdSsAttachDesc: string;
  sessionHelpCmdSsn: string;
  sessionHelpCmdSsnDesc: string;
  sessionHelpCmdTail: string;
  sessionHelpCmdTailDesc: string;
  sessionHelpCmdRm: string;
  sessionHelpCmdRmDesc: string;
  sessionHelpCmdUse: string;
  sessionHelpCmdUseDesc: string;
  sessionHelpCmdUseFuzzy: string;
  sessionHelpCmdUseFuzzyDesc: string;
  sessionHelpCmdUsePrev: string;
  sessionHelpCmdUsePrevDesc: string;
  sessionHelpCmdReset: string;
  sessionHelpCmdResetDesc: string;

  // nativeSessionHelp metadata
  nativeHelpSummary: string;
  nativeHelpCmdSsn: string;
  nativeHelpCmdSsnDesc: string;
  nativeHelpCmdSsnAgentWs: string;
  nativeHelpCmdSsnAgentWsDesc: string;
  nativeHelpCmdSsnAgentDir: string;
  nativeHelpCmdSsnAgentDirDesc: string;
  nativeHelpCmdSsnAgentAll: string;
  nativeHelpCmdSsnAgentAllDesc: string;
  nativeHelpCmdSsnNumber: string;
  nativeHelpCmdSsnNumberDesc: string;
  nativeHelpCmdSsnNumberAlias: string;
  nativeHelpCmdSsnNumberAliasDesc: string;
  nativeHelpCmdSsnAttach: string;
  nativeHelpCmdSsnAttachDesc: string;
  nativeHelpCmdSsnAttachLong: string;
  nativeHelpCmdSsnAttachLongDesc: string;
  nativeHelpNote1: string;
  nativeHelpNote2: string;
  nativeHelpNote3: string;
  nativeHelpNote4: string;

  // modeHelp metadata
  modeHelpSummary: string;
  modeHelpCmdShow: string;
  modeHelpCmdShowDesc: string;
  modeHelpCmdSet: string;
  modeHelpCmdSetDesc: string;

  // modelHelp metadata
  modelHelpSummary: string;
  modelHelpCmdShow: string;
  modelHelpCmdShowDesc: string;
  modelHelpCmdSet: string;
  modelHelpCmdSetDesc: string;

  // replyModeHelp metadata
  replyModeHelpSummary: string;
  replyModeHelpCmdShow: string;
  replyModeHelpCmdShowDesc: string;
  replyModeHelpCmdStream: string;
  replyModeHelpCmdStreamDesc: string;
  replyModeHelpCmdVerbose: string;
  replyModeHelpCmdVerboseDesc: string;
  replyModeHelpCmdFinal: string;
  replyModeHelpCmdFinalDesc: string;
  replyModeHelpCmdReset: string;
  replyModeHelpCmdResetDesc: string;

  // statusHelp metadata
  statusHelpSummary: string;
  statusHelpCmdShow: string;
  statusHelpCmdShowDesc: string;

  // cancelHelp metadata
  cancelHelpSummary: string;
  cancelHelpCmdCancel: string;
  cancelHelpCmdCancelDesc: string;
  cancelHelpCmdCancelAlias: string;
  cancelHelpCmdCancelAliasDesc: string;
  cancelHelpCmdStop: string;
  cancelHelpCmdStopDesc: string;
  cancelHelpCmdStopAlias: string;
  cancelHelpCmdStopAliasDesc: string;
}

export interface NativeSessionMessages {
  // handleNativeSessionList — unsupported transport
  transportNotSupported: string;

  // handleNativeSessionList — no sessions found
  noSessionsFound: (agentDisplayName: string, workspaceLabel: string) => string;
  noSessionsFoundHint: string;

  // handleNativeSessionSelect
  selectPrompt: string;
  noCachedList: string;
  indexOutOfRange: string;

  // attachNativeSession
  attachNotSupported: string;
  alreadySwitched: (agentDisplayName: string, displayAlias: string) => string;
  attachVerificationFailed: (agentDisplayName: string) => string;
  attachedAndSwitched: (agentDisplayName: string, displayAlias: string) => string;

  // resolveNativeTarget / resolveNativeWorkspace
  noContextHint: string;
  agentNotRegistered: (agent: string) => string;
  workspaceNotRegistered: (workspace: string) => string;
  workspacePathNotFound: (cwd: string) => string;
  noWritableConfig: string;

  // renderNativeSessionTableList
  tableHeader: (agentDisplayName: string, workspaceLabel: string) => string;
  tableColNum: string;
  tableColTitle: string;
  tableColUpdatedAt: string;
  tableColId: string;
  tableAttachedLabel: (displayAlias: string) => string;
  tableAttachedCurrent: string;
  tableActions: string;
  tableActionAttach: string;
  tableActionAlias: string;
  tableActionHelp: string;
  tableMore: (cmd: string) => string;

  // renderNativeSessionCardList
  cardHeader: (agentDisplayName: string, workspaceLabel: string) => string;
  cardReplyHint: string;
  cardTimeLabel: (updatedAt: string) => string;
  cardIdLabel: (idTail: string) => string;
  cardAttachedLabel: (displayAlias: string) => string;
  cardAttachedCurrent: string;
  cardActions: string;
  cardActionAttach: string;
  cardActionAlias: string;
  cardActionHelp: string;
  cardMore: (cmd: string) => string;

  // renderNativeListError / renderNativeResumeError
  listError: (agentDisplayName: string, errorMessage: string) => string;
  listErrorHint: string;
  listErrorHelp: string;
  resumeError: (agentDisplayName: string, errorMessage: string) => string;
  resumeErrorHint: string;
  resumeErrorHelp: string;
}

export interface RecoveryMessages {
  // renderTransportError — transient session
  transientSessionFailed: string;
  transientSessionHint: string;

  // renderTransportError — normal session unavailable
  sessionUnavailable: (alias: string) => string;
  sessionUnavailableRenewHint: (alias: string, agent: string, quotedWorkspace: string) => string;
  sessionUnavailableAttachHint: (alias: string, agent: string, quotedWorkspace: string) => string;

  // renderTransportError — partial output
  sessionInterrupted: (alias: string) => string;
  sessionInterruptedHint: string;
  sessionInterruptedError: (summary: string) => string;

  // renderSessionCreationError (AutoInstallFailedError)
  autoInstallHeadlineFixed: string;
  autoInstallHeadlineFailed: string;
  autoInstallOriginalError: string;
  autoInstallStepVerifyFailed: (label: string) => string;
  autoInstallStepError: (label: string, stderrTail: string) => string;
  autoInstallManual: (pkg: string) => string;
  autoInstallLog: (logPath: string) => string;
  autoInstallScopePrecise: (manager?: string, path?: string) => string;
  autoInstallScopeGlobal: string;

  // renderSessionCreationFailure / renderSessionCreationVerificationError
  sessionCreationFailed: string;
  sessionCreationVerificationDetail: string;
  sessionCreationError: (summary: string) => string;
  sessionCreationAttachHint: (alias: string, agent: string, quotedWorkspace: string) => string;
}

export interface ShortcutMessages {
  // handleSessionShortcutCommand — no config
  noConfig: string;

  // agent not registered
  agentNotRegistered: (agent: string, hint: string) => string;
  agentNotRegisteredAvailable: (names: string) => string;
  agentNotRegisteredNone: string;

  // reuse existing logical session
  reuseHeader: (display: string) => string;
  reuseWorkspace: (name: string) => string;
  reuseSession: (display: string) => string;

  // new session created
  createdHeader: (display: string) => string;
  createdNewWorkspace: (name: string, cwd: string) => string;
  createdReusedWorkspace: (name: string) => string;
  createdNewSession: (display: string) => string;

  // renderShortcutSessionCreationError
  creationFailed: (alias: string) => string;
  creationFailedNewWorkspace: (name: string, cwd: string) => string;
  creationFailedReusedWorkspace: (name: string) => string;
  creationFailedSession: string;

  // resolveShortcutWorkspace — workspace errors
  workspaceNotRegistered: (workspace: string, hint: string) => string;
  workspaceAvailable: (names: string) => string;
  workspaceNone: string;
  workspacePathNotFound: (cwd: string) => string;
}

export interface WorkspaceMessages {
  // render-text: renderWorkspaces
  workspacesEmpty: string;
  workspacesHeader: string;

  // handleWorkspaceCreate — no config
  noWritableConfig: string;

  // handleWorkspaceCreate — path not found
  pathNotFound: (cwd: string) => string;

  // handleWorkspaceCreate — name sanitization notice
  nameSanitized: (original: string, saved: string) => string;

  // handleWorkspaceCreate — saved confirmation
  saved: (name: string) => string;

  // handleWorkspaceRemove — no config
  // (reuses noWritableConfig)

  // handleWorkspaceRemove — removed confirmation
  removed: (name: string) => string;

  // workspaceHelp metadata
  helpSummary: string;
  helpCmdList: string;
  helpCmdListDesc: string;
  helpCmdListOrAlias: string;
  helpCmdListOrAliasDesc: string;
  helpCmdNew: string;
  helpCmdNewDesc: string;
  helpCmdRm: string;
  helpCmdRmDesc: string;
}

export interface AgentMessages {
  // render-text: renderAgents
  agentsEmpty: string;
  agentsHeader: string;

  // handleAgentAdd / handleAgentRemove — no config
  noWritableConfig: string;

  // handleAgentAdd — unsupported template
  unsupportedTemplate: (available: string) => string;

  // handleAgentAdd — already exists (identical)
  alreadyExists: (name: string) => string;

  // handleAgentAdd — already exists (different config)
  alreadyExistsDifferent: (name: string) => string;

  // handleAgentAdd — saved confirmation
  saved: (name: string) => string;

  // handleAgentRemove — not found
  notFound: string;

  // handleAgentRemove — removed confirmation
  removed: (name: string) => string;

  // agentHelp metadata
  helpSummary: string;
  helpCmdList: string;
  helpCmdListDesc: string;
  helpCmdAdd: (templates: string) => string;
  helpCmdAddDesc: string;
  helpCmdRm: string;
  helpCmdRmDesc: string;
}

export interface LaterMessages {
  // command-router.ts — scheduled service not enabled
  serviceNotEnabled: string;

  // handleLaterCreate — flags mutually exclusive
  bindAndTempMutuallyExclusive: string;

  // handleLaterCreate — no current session
  noSession: string;
  noSessionHint: string;
  noSessionExampleNew: string;
  noSessionExampleUse: string;

  // handleLaterCreate — slash-prefixed message rejected
  slashMessageRejected: string;
  slashMessageHint: string;
  slashMessageExample: string;

  // handleLaterCancel — success
  cancelSuccess: (id: string) => string;

  // handleLaterCancel — not found
  cancelNotFound: (id: string) => string;
  cancelNotFoundHint: string;

  // renderTimeParseError
  missingMessage: string;
  tooSoon: string;
  outOfRange: string;
  pastTodayTime: (value: string) => string;
  unrecognizedTime: string;
  unrecognizedTimeFormats: string;
  unrecognizedTimeExample1: string;
  unrecognizedTimeExample2: string;
  unrecognizedTimeExample3: string;
  unrecognizedTimeExample4: string;

  // laterHelp metadata
  helpSummary: string;
  helpCmdCreate: string;
  helpCmdCreateDesc: string;
  helpCmdBind: string;
  helpCmdBindDesc: string;
  helpCmdTemp: string;
  helpCmdTempDesc: string;
  helpCmdList: string;
  helpCmdListDesc: string;
  helpCmdCancel: string;
  helpCmdCancelDesc: string;
  helpExample1: string;
  helpExample2: string;
  helpExample3: string;
  helpExample4: string;
  helpExample5: string;
  helpNote1: string;
  helpNote2: string;
  helpNote3: string;
  helpNote4: string;
  helpNote5: string;
  helpNote6: string;
  helpNote7: string;
}

export interface ScheduledRenderMessages {
  // sessionLabel
  tempSession: (workspace: string, agent: string) => string;
  boundSession: (displaySession: string) => string;

  // renderLaterHelp
  helpUsage: string;
  helpCreate: string;
  helpCreateEx1: string;
  helpCreateEx2: string;
  helpCreateEx3: string;
  helpCreateEx4: string;
  helpView: string;
  helpViewCmd: string;
  helpCancel: string;
  helpCancelCmd: string;
  helpNotes: string;
  helpNote1: string;
  helpNote2: string;
  helpNote3: string;
  helpNote4: string;
  helpNote5: string;
  helpNote6: string;
  helpNote7: string;

  // renderLaterUnsupportedChannel
  unsupportedChannel: string;
  unsupportedChannelReason: string;
  unsupportedChannelHint: string;

  // renderTaskCreated
  taskCreated: (id: string) => string;
  taskExecuteAt: (datetime: string) => string;
  taskContent: (preview: string) => string;

  // renderLaterList
  listEmpty: string;
  listHeader: string;

  // formatLocalDateTime — weekdays
  weekdaySun: string;
  weekdayMon: string;
  weekdayTue: string;
  weekdayWed: string;
  weekdayThu: string;
  weekdayFri: string;
  weekdaySat: string;
}

export interface OrchestrationMessages {
  // handler guard — no current session
  noCurrentSession: string;

  // handler guard — orchestration service not enabled
  serviceUnavailable: string;

  // handler — task/group not found
  taskNotFound: string;
  groupNotFound: string;

  // render-text: renderDelegateSuccess
  delegateSuccessCreated: (taskId: string) => string;
  delegateSuccessWorker: (workerSession: string) => string;

  // render-text: renderGroupCreated
  groupCreatedId: (groupId: string) => string;
  groupCreatedTitle: (title: string) => string;

  // render-text: renderGroupList
  groupListEmpty: string;
  groupListHeader: string;

  // render-text: renderGroupSummary
  groupSummaryId: (groupId: string) => string;
  groupSummaryTitle: (title: string) => string;
  groupSummaryCoordinator: (coordinatorSession: string) => string;
  groupSummaryTotal: (count: number) => string;
  groupSummaryPending: (count: number) => string;
  groupSummaryRunning: (count: number) => string;
  groupSummaryCompleted: (count: number) => string;
  groupSummaryFailed: (count: number) => string;
  groupSummaryCancelled: (count: number) => string;
  groupSummaryTerminal: (isTerminal: boolean) => string;
  groupSummaryTerminalYes: string;
  groupSummaryTerminalNo: string;
  groupSummaryInjectionPending: (pending: boolean) => string;
  groupSummaryInjectionAppliedAt: (time: string) => string;
  groupSummaryLastInjectionError: (error: string) => string;
  groupSummaryMembersHeader: string;

  // render-text: renderGroupCancelSuccess
  groupCancelSuccessId: (groupId: string) => string;
  groupCancelSuccessCancelledCount: (count: number) => string;
  groupCancelSuccessSkippedCount: (count: number) => string;

  // render-text: renderTaskList
  taskListEmpty: string;
  taskListHeader: string;

  // render-text: renderTaskSummary
  taskSummaryId: (taskId: string) => string;
  taskSummaryStatus: (status: string) => string;
  taskSummaryCoordinator: (coordinatorSession: string) => string;
  taskSummaryWorker: (workerSession: string) => string;
  taskSummaryWorkerUnassigned: string;
  taskSummaryTargetAgent: (agent: string) => string;
  taskSummaryRole: (role: string) => string;
  taskSummaryGroup: (groupId: string) => string;
  taskSummarySource: (sourceKind: string, sourceHandle: string, roleSuffix: string) => string;
  taskSummaryTask: (task: string) => string;
  taskSummarySummary: (summary: string) => string;
  taskSummaryLatestProgress: (progress: string) => string;
  taskSummaryResult: (result: string) => string;
  taskSummaryTimelineHeader: string;

  // render-text: renderTaskCancelSuccess
  taskCancelAlreadyDone: (taskId: string) => string;
  taskCancelRequested: (taskId: string) => string;
  taskCancelled: (taskId: string) => string;
  taskCurrentStatus: (status: string) => string;

  // render-text: renderTaskApprovalSuccess
  taskApproved: (taskId: string) => string;

  // render-text: renderTaskRejectSuccess
  taskRejected: (taskId: string) => string;

  // render-text: renderTaskConfirmationUnavailable
  taskConfirmationUnavailable: (taskId: string) => string;

  // render-text: renderTasksCleanResult
  tasksCleanEmpty: string;
  tasksCleanRemovedTasks: (count: number) => string;
  tasksCleanRemovedBindings: (count: number) => string;

  // render-text: renderTaskListItem (inline rendering)
  taskListItemGroup: (groupId: string) => string;
  taskListItemSource: (sourceKind: string, sourceHandle: string, roleSuffix: string) => string;
  taskListItemNoticePending: string;
  taskListItemInjectionPending: string;
  taskListItemCancelling: string;

  // render-text: renderGroupListItem (inline rendering)
  groupListItemInjectionPending: string;
  groupListItemTotal: (count: number) => string;
  groupListItemPending: (count: number) => string;
  groupListItemRunning: (count: number) => string;
  groupListItemCompleted: (count: number) => string;
  groupListItemFailed: (count: number) => string;
  groupListItemCancelled: (count: number) => string;

  // render-delegate-group-result: truncate
  truncatedResult: (taskId: string) => string;

  // render-delegate-group-result: pickNextAction
  nextActionNoMembers: string;
  nextActionMixed: string;
  nextActionAllFailed: string;
  nextActionOtherOnly: string;
  nextActionMostlySuccess: string;
  nextActionAllSuccess: string;

  // orchestrationHelp metadata
  helpSummary: string;
  helpCmdDg: string;
  helpCmdDgDesc: string;
  helpCmdDelegate: string;
  helpCmdDelegateDesc: string;
  helpCmdDelegateRole: string;
  helpCmdDelegateRoleDesc: string;
  helpCmdDelegateGroup: string;
  helpCmdDelegateGroupDesc: string;
  helpCmdGroupNew: string;
  helpCmdGroupNewDesc: string;
  helpCmdGroupGet: string;
  helpCmdGroupGetDesc: string;
  helpCmdGroupAdd: string;
  helpCmdGroupAddDesc: string;
  helpCmdGroupAddRole: string;
  helpCmdGroupAddRoleDesc: string;
  helpCmdGroupCancel: string;
  helpCmdGroupCancelDesc: string;
  helpCmdGroups: string;
  helpCmdGroupsDesc: string;
  helpCmdTasks: string;
  helpCmdTasksDesc: string;
  helpCmdTasksStatus: string;
  helpCmdTasksStatusDesc: string;
  helpCmdTasksStuck: string;
  helpCmdTasksStuckDesc: string;
  helpCmdTasksClean: string;
  helpCmdTasksCleanDesc: string;
  helpCmdTaskGet: string;
  helpCmdTaskGetDesc: string;
  helpCmdTaskApprove: string;
  helpCmdTaskApproveDesc: string;
  helpCmdTaskReject: string;
  helpCmdTaskRejectDesc: string;
  helpCmdTaskCancel: string;
  helpCmdTaskCancelDesc: string;
  helpExample1: string;
  helpExample2: string;
  helpExample3: string;
  helpExample4: string;
  helpExample5: string;
  helpExample6: string;
  helpExample7: string;
  helpExample8: string;
  helpExample9: string;
  helpExample10: string;
}

export interface CoordinatorPromptMessages {
  // build-coordinator-prompt.ts — pending results section header
  pendingResultsHeader: string;

  // build-coordinator-prompt.ts — human reply binding section
  humanReplyBindingHeader: string;
  reopenedOutsideSnapshotLabel: string;

  // build-coordinator-prompt.ts — active package still awaiting reply
  activePackageAwaitingReply: string;

  // build-coordinator-prompt.ts — package not yet delivered
  packageNotDelivered: string;

  // build-coordinator-prompt.ts — active package not closed
  activePackageNotClosed: string;
  recentHumanPackageLabel: string;

  // build-coordinator-prompt.ts — user message label
  userMessageLabel: string;
}

export interface WorkerPromptMessages {
  // worker-prompts.ts — buildWorkerTaskPrompt
  taskHeader: string;
  taskIdLabel: (taskId: string) => string;
  taskWorkerSessionLabel: (workerSession: string) => string;
  taskRoleLabel: (role: string) => string;
  taskInstruction: string;
  taskBlockerInstruction: string;
  taskProgressInstruction: string;
  taskProgressNote: string;
  taskContentLabel: (task: string) => string;

  // worker-prompts.ts — buildWorkerAnswerPrompt
  answerHeader: string;
  answerInstruction: string;
  answerLabel: string;
}

export interface ConfigMessages {
  // configHelp metadata
  helpSummary: string;
  helpCmdShow: string;
  helpCmdShowDesc: string;
  helpCmdSet: string;
  helpCmdSetDesc: string;

  // handleConfigShow — section headers
  showSupportedHeader: string;
  showLegacyHeader: string;
  showExamplesHeader: string;

  // handleConfigShow — legacy path display strings
  legacyWechatReplyMode: string;
  legacyChannelType: string;
  legacyChannels: string;

  // handleConfigSet — no writable config
  noWritableConfig: string;

  // handleConfigSet — success
  updated: (path: string, value: string) => string;

  // applySupportedConfigUpdate — language
  languageInvalid: string;

  // applySupportedConfigUpdate — transport.type
  transportTypeInvalid: string;

  // applySupportedConfigUpdate — transport.command
  transportCommandEmpty: string;

  // applySupportedConfigUpdate — transport.permissionMode
  transportPermissionModeInvalid: string;

  // applySupportedConfigUpdate — transport.nonInteractivePermissions
  transportNonInteractiveInvalid: string;

  // applySupportedConfigUpdate — transport.permissionPolicy
  transportPermissionPolicyEmpty: string;

  // applySupportedConfigUpdate — logging.level
  loggingLevelInvalid: string;

  // applySupportedConfigUpdate — positive number validation
  mustBePositiveNumber: (path: string) => string;

  // applySupportedConfigUpdate — channel.type (legacy, write disabled)
  channelTypeDisabled: string;

  // applySupportedConfigUpdate — channel.replyMode
  channelReplyModeInvalid: string;
  channelRuntimeNotFound: (id: string) => string;
  channelRuntimeReplyModeInvalid: (id: string) => string;

  // applySupportedConfigUpdate — wechat.replyMode (legacy)
  wechatReplyModeInvalid: string;

  // applySupportedConfigUpdate — wechat.replyMode mapped renderedValue
  wechatReplyModeMapped: (value: string) => string;

  // applySupportedConfigUpdate — dynamic path: agent not found
  agentNotFound: (name: string) => string;

  // applySupportedConfigUpdate — dynamic path: field cannot be empty
  fieldEmpty: (path: string) => string;

  // applySupportedConfigUpdate — dynamic path: workspace not found
  workspaceNotFound: (name: string) => string;

  // applySupportedConfigUpdate — unsupported path
  pathNotSupported: (path: string) => string;
}

export interface PermissionMessages {
  // permissionHelp metadata
  helpSummary: string;
  helpCmdShow: string;
  helpCmdShowDesc: string;
  helpCmdSet: string;
  helpCmdSetDesc: string;
  helpCmdAuto: string;
  helpCmdAutoDesc: string;
  helpCmdAutoSet: string;
  helpCmdAutoSetDesc: string;

  // handlePermissionModeSet / handlePermissionAutoSet — no writable config
  noWritableConfig: string;

  // renderPermissionStatus — title variants
  statusTitleCurrent: string;
  statusTitleAutoStatus: string;
  statusTitleModeUpdated: string;
  statusTitleAutoUpdated: string;
}

export interface HelpMessages {
  // handleInvalidCommand — with dedicated topic
  invalidCommandPrefix: string;

  // handleInvalidCommand — fallback (no topic)
  invalidCommandFallbackHeader: string;
  invalidCommandFallbackFormat: string;
  invalidCommandFallbackExample: string;

  // renderHelpIndex — common entry list
  indexCommonHeader: string;
  indexEntryShortcut: string;
  indexEntryNative: string;
  indexEntryUse: string;
  indexEntryStatus: string;
  indexTopicsHeader: string;
  indexViewTopicHeader: string;
  indexViewTopicExample: string;

  // renderHelpTopic — labels
  topicHeader: (name: string) => string;
  topicSummary: (summary: string) => string;
  topicAliases: (aliases: string) => string;
  topicCommandsHeader: string;
  topicExamplesHeader: string;
  topicNotesHeader: string;

  // renderUnknownHelpTopic
  unknownTopicHeader: (name: string) => string;
  unknownTopicAvailableHeader: string;
}

export interface HintsMessages {
  // listWeacpxCommandHints — /help description
  helpDescription: string;
}

export interface RouterMessages {
  // ensureTransportSession — auto-install progress
  depMissing: (pkg: string) => string;
  depInstallVerifying: string;

  // createProgressHandler — heartbeat / spawn / initializing
  agentHeartbeat: (agent: string, elapsed: number) => string;
  agentSpawning: (agent: string) => string;
  agentInitializing: (agent: string, elapsed: number) => string;

  // createProgressHandler — acpx note with elapsed
  acpxNoteElapsed: (note: string, elapsed: number) => string;
}

export interface RenderMessages {
  // render-text: renderTaskProgress
  taskProgress: (taskId: string, targetAgent: string, summary: string) => string;

  // render-text: renderTaskHeartbeat
  taskHeartbeat: (taskId: string, minutes: number) => string;
}

export interface AcpxNoteMessages {
  // translateAcpxNote — built-in agent spawn
  spawnBuiltIn: (name: string) => string;

  // translateAcpxNote — generic agent spawn
  spawnAgent: string;

  // translateAcpxNote — downloading deps
  downloading: string;

  // translateAcpxNote — installing/extracting deps
  installing: string;

  // translateAcpxNote — initializing
  initializing: string;

  // translateAcpxNote — fallback raw line
  fallback: (line: string) => string;
}

export interface CliMessages {
  // HELP_LINES — usage text printed by --help and on unknown commands
  helpLines: string[];

  // start command
  alreadyRunning: string;
  started: string;
  startFailed: (detail: string) => string;

  // status command
  running: string;
  notRunning: string;
  indeterminate: string;

  // stop command
  stopped: string;

  // restart command
  restarting: string;
  restartNotRunning: string;
  restartFailed: (detail: string) => string;
  restartIndeterminate: string;
  restartIndeterminateHint: string;

  // daemon log hints
  checkAppLog: (path: string) => string;
  checkStderrLog: (path: string) => string;

  // workspace commands
  workspaceEmpty: string;
  workspaceListHeader: string;
  workspaceNameEmpty: string;
  workspaceNameSanitized: (sourceLabel: string, original: string, saved: string) => string;
  workspaceSourceLabelDir: string;
  workspaceSourceLabelName: string;
  workspaceAlreadyExists: (name: string, cwd: string) => string;
  workspaceConflictPath: (name: string, cwd: string) => string;
  workspaceConflictHint: (name: string) => string;
  workspaceSaved: (name: string, cwd: string) => string;
  workspaceNotFound: (name: string) => string;
  workspaceRemoved: (name: string) => string;

  // agent commands
  agentEmpty: string;
  agentListHeader: string;
  agentTemplatesHeader: string;
  agentNameEmpty: string;
  agentUnsupportedTemplate: (templates: string[]) => string;
  agentAlreadyExists: (name: string) => string;
  agentAlreadyExistsDifferent: (name: string) => string;
  agentSaved: (name: string) => string;
  agentNotFound: (name: string) => string;
  agentRemoved: (name: string) => string;

  // later commands
  laterIdEmpty: string;
  laterNotFound: (id: string) => string;
  laterNotFoundHint: string;
  laterCancelled: (id: string) => string;
}

export interface CliUpdateMessages {
  // handleUpdateCli — listing header
  updatesAvailable: string;

  // handleUpdateCli — unavailable / abort
  unavailableAborted: (names: string) => string;

  // handleUpdateCli — nothing to do
  nothingToUpdate: string;

  // handleUpdateCli — non-interactive self-update confirmation required
  selfUpdateNeedsConfirmNonInteractive: (name: string) => string;
  renameNeedsConfirmNonInteractive: (successor: string) => string;

  // handleUpdateCli — interactive self-update confirmation prompt
  selfUpdateConfirmPrompt: (name: string) => string;
  renameConfirmPrompt: (successor: string) => string;

  // handleUpdateCli — confirmation declined
  selfUpdateCancelled: (name: string) => string;
  renameCancelled: (successor: string) => string;

  // handleUpdateCli — success messages
  selfUpdated: (name: string, version: string) => string;
  renameMigrated: (successor: string, version: string) => string;
  pluginUpdated: (name: string, version: string) => string;
  pluginRollbackFailed: (name: string, version: string, error: string) => string;
  pluginNotInConfig: (name: string) => string;
  updateFailed: (name: string, error: string) => string;

  // selectTargets — no target found
  targetNotFound: (name: string) => string;
  targetVersionUnknown: (name: string) => string;

  // selectTargets — non-interactive multi-target
  multiTargetNonInteractive: string;

  // selectTargets — interactive selection prompt
  selectionPrompt: string;
  selectionInvalid: (part: string) => string;

  // formatTarget
  formatSelf: (name: string, current: string, latest: string) => string;
  formatRename: (successor: string, current: string, latest: string) => string;
  formatPlugin: (name: string, current: string, latest: string) => string;
  versionUnlocked: string;
  versionUnknown: string;
}

export interface ChannelCliMessages {
  // listChannels
  noChannels: string;
  channelListHeader: string;

  // showChannel / showChannelAccount
  channelNotFound: (type: string) => string;
  channelHeader: (id: string) => string;
  channelNoMultiAccount: (type: string) => string;
  channelAccountNotFound: (type: string, accountId: string) => string;
  channelAccountHeader: (id: string, accountId: string) => string;

  // addChannel
  missingRequiredFlags: (flags: string) => string;
  channelAlreadyExistsSame: (type: string) => string;
  channelAlreadyExistsDifferent: (type: string) => string;
  channelAdded: (type: string) => string;

  // removeChannel
  cannotRemoveLastEnabled: string;
  channelRemoved: (id: string) => string;
  channelCredentialsCleared: (id: string) => string;
  channelCredentialsClearFailed: (id: string, error: string) => string;
  channelCredentialsKept: (id: string) => string;

  // setChannelEnabled
  cannotDisableLastEnabled: string;
  channelEnabledToggled: (id: string, enabled: boolean) => string;
  channelReplyModeSet: (id: string, mode: string) => string;
  channelReplyModeInvalid: (mode: string) => string;

  // addChannelAccount
  channelAccountAlreadyExists: (type: string, accountId: string) => string;
  channelAccountAdded: (type: string, accountId: string) => string;
  channelReEnabled: (type: string) => string;

  // removeChannelAccount
  channelAccountRemoveBlockedLast: (accountId: string, type: string) => string;
  channelAccountRemovedWithChannel: (type: string, accountId: string) => string;
  channelAccountRemoveBlockedAllDisabled: (type: string, accountId: string, remainingIds: string) => string;
  channelAccountDefaultSwitched: (newDefault: string) => string;
  channelAccountRemoved: (type: string, accountId: string) => string;

  // setChannelAccountEnabled
  channelAccountIncomplete: (accountId: string, issues: string) => string;
  channelAccountCannotDisableLast: (type: string) => string;
  channelAccountEnabledToggled: (type: string, accountId: string, enabled: boolean) => string;

  // unknownChannelType
  unknownChannelType: (type: string) => string;
  supportedBuiltinChannels: (types: string) => string;

  // maybeRestartAfterMutation
  savedNoRestart: string;
  savedDaemonIndeterminate: string;
  savedDaemonRunning: string;
  restartPrompt: string;
  savedRestartPending: string;
  savedDaemonStopped: string;

  // runRestart
  savedRestartFailed: (message: string) => string;
  checkLog: (path: string) => string;
  orRunLater: string;
}

export interface PluginCliMessages {
  // listPlugins
  noPlugins: string;
  pluginListHeader: string;

  // addPlugin
  unrecognizedArgs: (args: string) => string;
  pluginSpecHasDoubleQuote: (spec: string) => string;
  pluginSpecHasPercentOnWindows: (spec: string) => string;
  pluginInstallFailed: (packageSpec: string, error: string) => string;
  pluginValidateFailed: (recordedName: string, error: string) => string;
  pluginInstalled: (recordedName: string) => string;
  providesChannels: (channels: string) => string;

  // removePlugin
  pluginNotFound: (packageName: string) => string;
  pluginUninstallFailed: (packageName: string, error: string) => string;
  pluginRemoved: (packageName: string) => string;

  // updatePlugins
  pluginUpdateFailed: (name: string, error: string) => string;
  pluginUpdateValidateFailed: (name: string, message: string) => string;
  pluginRolledBack: (version: string) => string;
  pluginRollbackFailed: (name: string, version: string, message: string) => string;
  pluginRollbackUnavailable: (name: string) => string;
  pluginUpdated: (name: string) => string;

  // setPluginEnabled
  pluginEnabledToggled: (packageName: string, enabled: boolean) => string;

  // dependencyGuard
  dependencyGuardBlocked: (ids: string) => string;
  dependencyGuardBlockedUnknown: (pluginName: string, ids: string) => string;

  // doctorPlugins
  pluginDoctorOk: string;

  // knownPlugins
  noKnownPlugins: string;
  knownPluginsHeader: string;
  knownPluginsInstallLabel: string;
  knownPluginsInstallCmd: string;

  // resolveLocalPluginName
  cannotResolveLocalPluginName: (installSpec: string) => string;

  // maybeRestartAfterMutation
  savedNoRestart: string;
  savedDaemonIndeterminate: string;
  savedDaemonRunning: string;
  restartPrompt: string;
  savedRestartPending: string;
  savedDaemonStopped: string;

  // runRestart
  savedRestartFailed: (message: string) => string;
  checkLog: (path: string) => string;
  orRunLater: string;

  // validateWeacpxPlugin (validate-plugin.ts)
  pluginNoDefaultExport: (packageName: string) => string;
  pluginNameMismatch: (packageName: string, name: string) => string;
  pluginChannelsNotArray: (packageName: string) => string;
  pluginIllegalChannelType: (packageName: string, type: string) => string;
  pluginIllegalChannelTypeNoType: (packageName: string) => string;
  pluginDuplicateChannelType: (packageName: string, type: string) => string;
  pluginMissingFactory: (packageName: string, type: string) => string;
  pluginInvalidCliProvider: (packageName: string, type: string) => string;

  // validatePluginCompatibility (compatibility.ts)
  compatMissingApiVersion: (packageName: string) => string;
  compatUnsupportedApiVersion: (packageName: string, apiVersion: number, supported: string) => string;
  compatInvalidMinVersion: (packageName: string, field: string) => string;
  compatInvalidMinVersionDetail: (packageName: string, field: string, detail: string) => string;
  compatMinVersionNotSatisfied: (packageName: string, minVersion: string, currentVersion: string) => string;
  compatInvalidCompatibleVersions: (packageName: string, field: string) => string;
  compatInvalidCompatibleVersionsDetail: (packageName: string, field: string, detail: string) => string;
  compatCompatibleVersionsNotSatisfied: (packageName: string, requirement: string, currentVersion: string) => string;
}

export interface LoginMessages {
  // startWeixinLoginWithQr — existing session reused
  qrReady: string;

  // startWeixinLoginWithQr — new session started
  qrScanToConnect: string;

  // waitForWeixinLogin — no active login
  noActiveLogin: string;

  // waitForWeixinLogin — QR already expired before polling
  qrExpiredBeforeStart: string;

  // waitForWeixinLogin — too many QR expiries
  loginTimeoutTooManyExpiries: string;

  // refreshQRCode — new QR generated (written to stdout)
  newQrGenerated: string;

  // refreshQRCode — browser fallback after successful generation
  qrBrowserFallback: string;

  // refreshQRCode — browser fallback when qrcode-terminal fails to load
  qrLoadFailed: string;

  // refreshQRCode — refresh API call failed
  qrRefreshFailed: (detail: string) => string;

  // waitForWeixinLogin — scanned status (written to stdout)
  scanned: string;

  // waitForWeixinLogin — QR expired during polling (written to stdout)
  qrExpiringRefresh: (current: number, max: number) => string;

  // waitForWeixinLogin — verify code: wrong input
  verifyCodeMismatch: string;

  // waitForWeixinLogin — verify code: first prompt
  verifyCodePrompt: string;

  // waitForWeixinLogin — verify code: no TTY available
  verifyCodeNoTty: string;

  // waitForWeixinLogin — verify code blocked (written to stdout)
  verifyCodeBlocked: string;

  // waitForWeixinLogin — verify code blocked, max retries reached
  verifyCodeBlockedStop: string;

  // waitForWeixinLogin — confirmed but missing ilink_bot_id
  loginMissingBotId: string;

  // waitForWeixinLogin — confirmed success
  loginSuccess: string;

  // waitForWeixinLogin — overall timeout
  loginTimeout: string;

  // bot.login — starting
  startingLogin: string;

  // bot.login — scan instruction (printed before QR)
  scanInstruction: string;

  // bot.login — QR link fallback (when qrcode-terminal not available)
  qrLinkFallback: (url: string) => string;

  // bot.login — waiting for scan
  waitingForScan: string;

  // bot.login — overall success (printed after connect)
  loginSuccessLine: string;

  // bot.logout — no accounts
  noAccountsLoggedIn: string;

  // bot.logout — success
  logoutSuccess: string;

  // bot.start — no accounts (Error message)
  noAccountsError: string;

  // bot.start — account not configured (Error message)
  accountNotConfigured: (accountId: string) => string;
}

export interface WeixinMessages {
  // handleEcho — timing block header and rows
  echoTimingHeader: string;
  echoTimingEventTime: (iso: string) => string;
  echoTimingPlatformDelay: (delay: string) => string;
  echoTimingPluginDelay: (ms: number) => string;

  // /toggle-debug
  debugEnabled: string;
  debugDisabled: string;

  // /clear
  sessionCleared: string;

  // handleSlashCommand — command execution error
  commandFailed: (detail: string) => string;
}

export interface MigrateMessages {
  // migrateCoreHome — legacy daemon still alive
  daemonRunning: (pid: number, legacy: string, primary: string) => string;

  // migrateCoreHome — copy succeeded
  copied: (legacy: string, primary: string) => string;

  // migrateCoreHome — copy failed
  failed: (legacy: string, primary: string, detail: string) => string;

  // supplementMissingCoreFiles — per-file supplement copy failed
  supplementFailed: (from: string, to: string, detail: string) => string;

  // supplementMissingCoreFiles — supplemented missing files from legacy dir
  supplemented: (files: string, primary: string) => string;
}

export interface MiscMessages {
  // console-agent: empty message guard
  emptyMessage: string;

  // config/default-workspace: default workspace description
  defaultHomeWorkspaceDescription: string;

  // plugins/known-plugins: channel descriptions
  pluginChannelFeishu: string;
  pluginChannelYuanbao: string;
  pluginChannelRelay: string;
  pluginChannelInstallHint: (channelType: string, packageName: string) => string;

  // doctor/orchestration-health: suggestions
  orchestrationSuggestion1: string;
  orchestrationSuggestion2: string;
  orchestrationSuggestion3: string;

  // cli/startup-wait-ui
  startupWaitLine: (frame: string, elapsed: number, timeout: number) => string;
  startupWaitLineFirstBoot: (frame: string, elapsed: number, timeout: number) => string;

  // sessions/session-service: validation errors
  workspaceNotRegistered: (workspace: string) => string;
  agentNotRegistered: (agent: string) => string;

  // transport/quota-gated-reply-sink
  quotaHeadsUp: string;
  quotaOverflowSummary: (count: number) => string;

  // weixin/messaging/final-heads-up
  finalHeadsUp: (total: number, sentSoFar: number, remaining: number) => string;

  // weixin/messaging/handle-weixin-message-turn: standalone notice when the
  // final quota is exhausted and every page had to be parked
  finalAllParked: (count: number) => string;

  // weixin/messaging/inbound
  quotedMessagePrefix: (parts: string) => string;

  // weixin/messaging/scheduled-turn
  scheduledTaskFailed: (message: string) => string;

  // weixin/messaging/send-orchestration-notice
  orchestrationTaskCompleted: (taskId: string, workerSession: string, result: string) => string;
  orchestrationTaskFailed: (taskId: string, workerSession: string, reason: string) => string;
  workerUnassigned: string;

  // weixin/messaging/completion-notice
  bgSessionDone: (display: string) => string;
  bgSessionError: (display: string) => string;

  // weixin/messaging/handle-weixin-message-turn
  executionError: (message: string) => string;

  // onboarding
  onboardingFirstUsePrompt: (workspaceName: string) => string;
  onboardingSelectAgent: string;
  onboardingEnterChoice: string;
  onboardingNoValidAgent: string;
  onboardingCreatedWorkspace: (workspaceName: string, alias: string) => string;

  // orchestration/render-human-question-package
  humanQuestionQueued: (count: number) => string;
  humanQuestionResumed: (taskId: string, summary: string) => string;
  humanQuestionUnresolved: (taskId: string, summary: string) => string;
  humanQuestionQueuedLine: (count: number) => string;

  // orchestration/render-delegate-question-package
  delegateQPackageInstr1: string;
  delegateQPackageInstr2: string;
  delegateQPackageInstr3: string;

  // commands/command-policy
  commandAccessDeniedSuffix: string;
  commandAccessDeniedHint: string;
  commandAccessDeniedChatTypeMissingSuffix: string;
  commandAccessDeniedChatTypeMissingHint: string;
  commandLabelThisMessage: string;

  // commands/handlers/session-reset-handler
  sessionResetNoCurrentSession: string;
  sessionResetFailed: (alias: string) => string;
  sessionResetSuccess: (alias: string) => string;

  // scheduled/scheduled-dispatch
  scheduledDispatchNoticeBound: (taskId: string, sessionDisplay: string, preview: string) => string;
  scheduledDispatchNoticeTemp: (taskId: string, workspace: string, agent: string, preview: string) => string;

  // channels/weixin-channel
  weixinNoCredentials: string;

  // weixin/bot.ts
  weixinMultipleAccounts: (accountId: string) => string;
  weixinBotStarting: (accountId: string) => string;
}

export interface Messages {
  common: CommonMessages;
  session: SessionMessages;
  nativeSession: NativeSessionMessages;
  recovery: RecoveryMessages;
  shortcut: ShortcutMessages;
  workspace: WorkspaceMessages;
  agent: AgentMessages;
  later: LaterMessages;
  scheduledRender: ScheduledRenderMessages;
  orchestration: OrchestrationMessages;
  coordinatorPrompt: CoordinatorPromptMessages;
  workerPrompt: WorkerPromptMessages;
  config: ConfigMessages;
  permission: PermissionMessages;
  help: HelpMessages;
  hints: HintsMessages;
  router: RouterMessages;
  acpxNote: AcpxNoteMessages;
  render: RenderMessages;
  cli: CliMessages;
  cliUpdate: CliUpdateMessages;
  channelCli: ChannelCliMessages;
  pluginCli: PluginCliMessages;
  login: LoginMessages;
  weixin: WeixinMessages;
  migrate: MigrateMessages;
  misc: MiscMessages;
}
