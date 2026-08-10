import { randomUUID } from "node:crypto";
import { readFile, rename, writeFile } from "node:fs/promises";

import { writePrivateFileAtomic } from "../util/private-file.js";
import { createEmptyState, type AppState, type LogicalSession } from "./types";
import type { ScheduledTaskRecord, ScheduledTaskStatus } from "../scheduled/scheduled-types";
import {
  createEmptyOrchestrationState,
  type OrchestrationCorrectionPendingRecord,
  type OrchestrationCoordinatorQuestionStateRecord,
  type OrchestrationCoordinatorRouteContextRecord,
  type ExternalCoordinatorRecord,
  type OrchestrationGroupRecord,
  type OrchestrationHumanQuestionPackageMessageRecord,
  type OrchestrationHumanQuestionPackageRecord,
  type OrchestrationOpenQuestionRecord,
  type OrchestrationReviewPendingRecord,
  type OrchestrationSourceKind,
  type OrchestrationState,
  type OrchestrationTaskRecord,
  type OrchestrationTaskEventRecord,
  type OrchestrationTaskStatus,
  type OrchestrationQueuedQuestionRecord,
  type WorkerBindingRecord,
} from "../orchestration/orchestration-types";
import { sameCoordinatorSession } from "../orchestration/coordinator-identity";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Format version written on every save. The parser tolerates files without it
 * (older releases) and ignores it on load; no migration chain exists yet.
 */
export const STATE_FILE_VERSION = 1;

/** A record or section that was skipped/repaired while loading state.json. */
export interface StateLoadDroppedRecord {
  section: string;
  key: string;
  reason: string;
}

export interface StateLoadReport {
  dropped: StateLoadDroppedRecord[];
  /**
   * Legacy session records that were assigned a fresh logical_session_id
   * during load. Kept separate from {@link dropped}: a migrated record is
   * healthy and survives, a dropped record is corrupt and was removed.
   */
  migrated?: StateLoadDroppedRecord[];
  /** Backup copy of the original file, written because records were dropped. */
  quarantinePath?: string;
  /** Unreadable original renamed aside (whole-file JSON corruption). */
  corruptPath?: string;
  /** Best-effort backup/rename failure; load still returned the cleaned state. */
  backupError?: string;
}

/**
 * A section that must be an object map. A wrong-typed section degrades to an
 * empty map (and is reported) instead of bricking the whole load; a missing
 * section is simply empty (older files legitimately omit newer sections).
 */
function sectionRecord(
  value: unknown,
  section: string,
  dropped: StateLoadDroppedRecord[],
): Record<string, unknown> {
  if (value === undefined) {
    return {};
  }
  if (!isRecord(value)) {
    dropped.push({
      section,
      key: "",
      reason: `field "${section}" is not an object; reset to empty`,
    });
    return {};
  }
  return value;
}

function isString(value: unknown): value is string {
  return typeof value === "string";
}

function isOptionalString(value: unknown): value is string | undefined {
  return value === undefined || typeof value === "string";
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

function isOptionalBoolean(value: unknown): value is boolean | undefined {
  return value === undefined || typeof value === "boolean";
}

function isTaskStatus(value: unknown): value is OrchestrationTaskStatus {
  return (
    value === "needs_confirmation" ||
    value === "queued" ||
    value === "running" ||
    value === "blocked" ||
    value === "waiting_for_human" ||
    value === "completed" ||
    value === "failed" ||
    value === "cancelled"
  );
}

function isSourceKind(value: unknown): value is OrchestrationSourceKind {
  return value === "human" || value === "coordinator" || value === "worker";
}

function isOptionalNumber(value: unknown): value is number | undefined {
  return value === undefined || typeof value === "number";
}

function isTaskEventRecord(value: unknown): value is OrchestrationTaskEventRecord {
  if (!isRecord(value)) {
    return false;
  }

  return (
    typeof value.seq === "number" &&
    isString(value.at) &&
    (
      value.type === "created" ||
      value.type === "progress" ||
      value.type === "status_changed" ||
      value.type === "attention_required" ||
      value.type === "cancel_requested"
    ) &&
    (value.status === undefined || isTaskStatus(value.status)) &&
    isOptionalString(value.summary) &&
    isOptionalString(value.message)
  );
}

function isOpenQuestionRecord(value: unknown): value is OrchestrationOpenQuestionRecord {
  if (!isRecord(value)) {
    return false;
  }

  return (
    isString(value.questionId) &&
    isString(value.question) &&
    isString(value.whyBlocked) &&
    isString(value.whatIsNeeded) &&
    isString(value.askedAt) &&
    (value.status === "open" || value.status === "answered" || value.status === "superseded") &&
    isOptionalString(value.answeredAt) &&
    (value.answerSource === undefined || value.answerSource === "coordinator" || value.answerSource === "human") &&
    isOptionalString(value.answerText) &&
    isOptionalString(value.packageId) &&
    isOptionalString(value.lastWakeError) &&
    isOptionalString(value.lastResumeError)
  );
}

function isReviewPendingRecord(value: unknown): value is OrchestrationReviewPendingRecord {
  if (!isRecord(value)) {
    return false;
  }

  return (
    isString(value.reviewId) &&
    value.reason === "misrouted_answer" &&
    isString(value.createdAt) &&
    isString(value.resultId) &&
    isString(value.resultText)
  );
}

function isCorrectionPendingRecord(value: unknown): value is OrchestrationCorrectionPendingRecord {
  if (!isRecord(value)) {
    return false;
  }

  return isString(value.requestedAt) && value.reason === "misrouted_answer";
}

function isTaskRecord(value: unknown): value is OrchestrationTaskRecord {
  if (!isRecord(value)) {
    return false;
  }

  return (
    isString(value.taskId) &&
    isString(value.sourceHandle) &&
    isSourceKind(value.sourceKind) &&
    isString(value.coordinatorSession) &&
    isOptionalString(value.workerSession) &&
    isString(value.workspace) &&
    isOptionalString(value.cwd) &&
    isString(value.targetAgent) &&
    isOptionalString(value.role) &&
    isString(value.task) &&
    isTaskStatus(value.status) &&
    isString(value.summary) &&
    isString(value.resultText) &&
    isString(value.createdAt) &&
    isString(value.updatedAt) &&
    isOptionalString(value.chatKey) &&
    isOptionalString(value.replyContextToken) &&
    isOptionalString(value.accountId) &&
    isOptionalString(value.deliveryAccountId) &&
    isOptionalString(value.coordinatorInjectedAt) &&
    isOptionalString(value.cancelRequestedAt) &&
    isOptionalString(value.cancelCompletedAt) &&
    isOptionalString(value.lastCancelError) &&
    isOptionalBoolean(value.noticePending) &&
    isOptionalString(value.noticeSentAt) &&
    isOptionalString(value.lastNoticeError) &&
    isOptionalBoolean(value.injectionPending) &&
    isOptionalBoolean(value.ephemeralWorkerSession) &&
    isOptionalBoolean(value.ephemeralWorkerSessionClosed) &&
    isOptionalString(value.injectionAppliedAt) &&
    isOptionalString(value.lastInjectionError) &&
    isOptionalString(value.lastProgressAt) &&
    isOptionalString(value.lastProgressSummary) &&
    isOptionalString(value.groupId) &&
    (value.openQuestion === undefined || isOpenQuestionRecord(value.openQuestion)) &&
    (value.reviewPending === undefined || isReviewPendingRecord(value.reviewPending)) &&
    (value.correctionPending === undefined || isCorrectionPendingRecord(value.correctionPending)) &&
    isOptionalNumber(value.eventSeq) &&
    (value.events === undefined || (Array.isArray(value.events) && value.events.every(isTaskEventRecord)))
  );
}


function isExternalCoordinatorRecord(value: unknown): value is ExternalCoordinatorRecord {
  if (!isRecord(value)) {
    return false;
  }

  return (
    isString(value.coordinatorSession) &&
    isOptionalString(value.workspace) &&
    isString(value.createdAt) &&
    isString(value.updatedAt) &&
    isOptionalString(value.defaultTargetAgent)
  );
}

function isWorkerBindingRecord(value: unknown): value is WorkerBindingRecord {
  if (!isRecord(value)) {
    return false;
  }

  return (
    isString(value.sourceHandle) &&
    isString(value.coordinatorSession) &&
    isString(value.workspace) &&
    isOptionalString(value.cwd) &&
    isString(value.targetAgent) &&
    isOptionalString(value.role) &&
    isOptionalBoolean(value.ephemeral)
  );
}

function isGroupRecord(value: unknown): value is OrchestrationGroupRecord {
  if (!isRecord(value)) {
    return false;
  }

  return (
    isString(value.groupId) &&
    isString(value.coordinatorSession) &&
    isString(value.title) &&
    isString(value.createdAt) &&
    isString(value.updatedAt) &&
    isOptionalString(value.coordinatorInjectedAt) &&
    isOptionalBoolean(value.injectionPending) &&
    isOptionalString(value.injectionAppliedAt) &&
    isOptionalString(value.lastInjectionError)
  );
}

function isQueuedQuestionRecord(value: unknown): value is OrchestrationQueuedQuestionRecord {
  if (!isRecord(value)) {
    return false;
  }

  return isString(value.taskId) && isString(value.questionId) && isString(value.enqueuedAt);
}

function isCoordinatorQuestionStateRecord(value: unknown): value is OrchestrationCoordinatorQuestionStateRecord {
  if (!isRecord(value)) {
    return false;
  }

  const queuedQuestions = value.queuedQuestions;
  if (queuedQuestions !== undefined && !Array.isArray(queuedQuestions)) {
    return false;
  }

  return (
    (value.activePackageId === undefined || isString(value.activePackageId)) &&
    (queuedQuestions === undefined || queuedQuestions.every(isQueuedQuestionRecord))
  );
}

function isCoordinatorRouteContextRecord(value: unknown): value is OrchestrationCoordinatorRouteContextRecord {
  if (!isRecord(value)) {
    return false;
  }

  return (
    isString(value.coordinatorSession) &&
    isString(value.chatKey) &&
    isOptionalString(value.sessionAlias) &&
    isOptionalString(value.accountId) &&
    isOptionalString(value.replyContextToken) &&
    isOptionalString(value.channel) &&
    (value.chatType === undefined || value.chatType === "direct" || value.chatType === "group") &&
    isOptionalString(value.senderId) &&
    isOptionalString(value.senderName) &&
    isOptionalString(value.groupId) &&
    isOptionalBoolean(value.isOwner) &&
    isString(value.updatedAt)
  );
}

function isHumanQuestionPackageMessageRecord(value: unknown): value is OrchestrationHumanQuestionPackageMessageRecord {
  if (!isRecord(value)) {
    return false;
  }

  return (
    isString(value.messageId) &&
    (value.kind === "initial" || value.kind === "follow_up") &&
    isString(value.promptText) &&
    isString(value.createdAt) &&
    isOptionalString(value.deliveredAt) &&
    isOptionalString(value.deliveredChatKey) &&
    isOptionalString(value.deliveryAccountId) &&
    isOptionalString(value.lastDeliveryError)
  );
}

function isHumanQuestionPackageRecord(value: unknown): value is OrchestrationHumanQuestionPackageRecord {
  if (!isRecord(value)) {
    return false;
  }

  const initialTaskIds = value.initialTaskIds;
  const openTaskIds = value.openTaskIds;
  const resolvedTaskIds = value.resolvedTaskIds;
  const messages = value.messages;

  return (
    isString(value.packageId) &&
    isString(value.coordinatorSession) &&
    (value.status === "active" || value.status === "closed") &&
    isString(value.createdAt) &&
    isString(value.updatedAt) &&
    isOptionalString(value.closedAt) &&
    Array.isArray(initialTaskIds) && initialTaskIds.every(isString) &&
    Array.isArray(openTaskIds) && openTaskIds.every(isString) &&
    Array.isArray(resolvedTaskIds) && resolvedTaskIds.every(isString) &&
    Array.isArray(messages) && messages.every(isHumanQuestionPackageMessageRecord) &&
    isOptionalString(value.awaitingReplyMessageId)
  );
}

function parseOrchestrationState(
  raw: unknown,
  dropped: StateLoadDroppedRecord[],
): OrchestrationState {
  if (raw === undefined) {
    return createEmptyOrchestrationState();
  }

  if (!isRecord(raw)) {
    dropped.push({
      section: "orchestration",
      key: "",
      reason: 'field "orchestration" is not an object; reset to empty',
    });
    return createEmptyOrchestrationState();
  }

  const tasks = sectionRecord(raw.tasks, "orchestration.tasks", dropped);
  const workerBindings = sectionRecord(raw.workerBindings, "orchestration.workerBindings", dropped);
  const groups = sectionRecord(raw.groups, "orchestration.groups", dropped);
  const humanQuestionPackages = sectionRecord(
    raw.humanQuestionPackages,
    "orchestration.humanQuestionPackages",
    dropped,
  );
  const coordinatorQuestionState = sectionRecord(
    raw.coordinatorQuestionState,
    "orchestration.coordinatorQuestionState",
    dropped,
  );
  const coordinatorRoutes = sectionRecord(raw.coordinatorRoutes, "orchestration.coordinatorRoutes", dropped);
  const externalCoordinators = sectionRecord(
    raw.externalCoordinators,
    "orchestration.externalCoordinators",
    dropped,
  );

  const parsedTasks: OrchestrationState["tasks"] = {};
  for (const [taskId, task] of Object.entries(tasks)) {
    if (!isTaskRecord(task)) {
      dropped.push({
        section: "orchestration.tasks",
        key: taskId,
        reason: "malformed orchestration task record",
      });
      continue;
    }
    parsedTasks[taskId] = task;
  }

  const parsedWorkerBindings: OrchestrationState["workerBindings"] = {};
  for (const [workerSession, binding] of Object.entries(workerBindings)) {
    if (!isWorkerBindingRecord(binding)) {
      dropped.push({
        section: "orchestration.workerBindings",
        key: workerSession,
        reason: "malformed orchestration worker binding record",
      });
      continue;
    }
    parsedWorkerBindings[workerSession] = binding;
  }

  const parsedGroups: OrchestrationState["groups"] = {};
  for (const [groupId, group] of Object.entries(groups)) {
    if (!isGroupRecord(group)) {
      dropped.push({
        section: "orchestration.groups",
        key: groupId,
        reason: "malformed orchestration group record",
      });
      continue;
    }
    parsedGroups[groupId] = group;
  }

  const parsedHumanQuestionPackages: OrchestrationState["humanQuestionPackages"] = {};
  for (const [packageId, packageRecord] of Object.entries(humanQuestionPackages)) {
    if (!isHumanQuestionPackageRecord(packageRecord)) {
      dropped.push({
        section: "orchestration.humanQuestionPackages",
        key: packageId,
        reason: "malformed human question package record",
      });
      continue;
    }
    parsedHumanQuestionPackages[packageId] = packageRecord;
  }

  const parsedCoordinatorQuestionState: OrchestrationState["coordinatorQuestionState"] = {};
  for (const [coordinatorSession, questionState] of Object.entries(coordinatorQuestionState)) {
    if (!isCoordinatorQuestionStateRecord(questionState)) {
      dropped.push({
        section: "orchestration.coordinatorQuestionState",
        key: coordinatorSession,
        reason: "malformed coordinator question state record",
      });
      continue;
    }
    parsedCoordinatorQuestionState[coordinatorSession] = {
      activePackageId: questionState.activePackageId,
      queuedQuestions: (questionState.queuedQuestions ?? []).map((question) => ({ ...question })),
    };
  }

  const parsedCoordinatorRoutes: OrchestrationState["coordinatorRoutes"] = {};
  for (const [coordinatorSession, route] of Object.entries(coordinatorRoutes)) {
    if (!isCoordinatorRouteContextRecord(route)) {
      dropped.push({
        section: "orchestration.coordinatorRoutes",
        key: coordinatorSession,
        reason: "malformed coordinator route record",
      });
      continue;
    }
    parsedCoordinatorRoutes[coordinatorSession] = route;
  }

  const parsedExternalCoordinators: OrchestrationState["externalCoordinators"] = {};
  for (const [coordinatorSession, externalCoordinator] of Object.entries(externalCoordinators)) {
    if (!isExternalCoordinatorRecord(externalCoordinator)) {
      dropped.push({
        section: "orchestration.externalCoordinators",
        key: coordinatorSession,
        reason: "malformed external coordinator record",
      });
      continue;
    }
    if (externalCoordinator.coordinatorSession !== coordinatorSession) {
      dropped.push({
        section: "orchestration.externalCoordinators",
        key: coordinatorSession,
        reason: `coordinatorSession "${externalCoordinator.coordinatorSession}" does not match map key`,
      });
      continue;
    }
    parsedExternalCoordinators[coordinatorSession] = externalCoordinator;
  }

  return {
    tasks: parsedTasks,
    workerBindings: parsedWorkerBindings,
    groups: parsedGroups,
    humanQuestionPackages: parsedHumanQuestionPackages,
    coordinatorQuestionState: parsedCoordinatorQuestionState,
    coordinatorRoutes: parsedCoordinatorRoutes,
    externalCoordinators: parsedExternalCoordinators,
  };
}

function isReplyMode(value: unknown): value is AppState["sessions"][string]["reply_mode"] {
  return value === "stream" || value === "final" || value === "verbose";
}

/**
 * A logical_session_id is always a UUIDv4 (randomUUID). Present-but-invalid
 * values are treated as corruption and quarantined with the record; only a
 * genuinely MISSING field (legacy record) enters the load-time migration.
 */
export function isLogicalSessionId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
  );
}

function isSessionSource(value: unknown): value is AppState["sessions"][string]["source"] {
  return value === undefined || value === "weacpx" || value === "xacpx" || value === "agent-side";
}

/** A parsed session record: legacy files may genuinely lack logical_session_id. */
type MaybeLegacySession = Omit<LogicalSession, "logical_session_id"> & { logical_session_id?: string };

function isSessionRecord(value: unknown): value is MaybeLegacySession {
  if (!isRecord(value)) {
    return false;
  }

  return (
    isString(value.alias) &&
    isString(value.agent) &&
    isString(value.workspace) &&
    isString(value.transport_session) &&
    (value.logical_session_id === undefined || isLogicalSessionId(value.logical_session_id)) &&
    isSessionSource(value.source) &&
    isOptionalString(value.agent_session_id) &&
    isOptionalString(value.agent_session_title) &&
    isOptionalString(value.agent_session_updated_at) &&
    isOptionalString(value.attached_at) &&
    isOptionalString(value.transport_agent_command) &&
    isOptionalString(value.transport_acpx_agent) &&
    (value.transport_agent_argv === undefined || isStringArray(value.transport_agent_argv)) &&
    isOptionalString(value.mode_id) &&
    isOptionalString(value.effort) &&
    (value.reply_mode === undefined || isReplyMode(value.reply_mode)) &&
    isString(value.created_at) &&
    isString(value.last_used_at)
  );
}

function parseSessions(
  raw: Record<string, unknown>,
  dropped: StateLoadDroppedRecord[],
  migrated: StateLoadDroppedRecord[],
): AppState["sessions"] {
  const sessions: AppState["sessions"] = {};
  for (const [alias, value] of Object.entries(raw)) {
    if (!isSessionRecord(value)) {
      dropped.push({ section: "sessions", key: alias, reason: "malformed session record" });
      continue;
    }
    if (value.logical_session_id === undefined) {
      // Legacy record from before logical_session_id existed: assign a fresh
      // UUIDv4 exactly once. StateStore.load() persists this synchronously
      // before returning (failing closed when the save fails); inspect() keeps
      // it in-memory only. Reports list this under `migrated`, never under
      // `dropped` — a migration is not a quarantined corrupt record.
      migrated.push({
        section: "sessions",
        key: alias,
        reason: "legacy record missing logical_session_id; assigned a new UUIDv4",
      });
    }
    sessions[alias] = {
      ...value,
      logical_session_id: value.logical_session_id ?? randomUUID(),
    };
  }
  return sessions;
}

function isChatContextRecord(value: unknown): value is AppState["chat_contexts"][string] {
  return isRecord(value) && isString(value.current_session);
}

function parseChatContexts(
  raw: Record<string, unknown>,
  dropped: StateLoadDroppedRecord[],
): AppState["chat_contexts"] {
  const chatContexts: AppState["chat_contexts"] = {};
  for (const [chatKey, value] of Object.entries(raw)) {
    if (!isChatContextRecord(value)) {
      dropped.push({ section: "chat_contexts", key: chatKey, reason: "malformed chat context record" });
      continue;
    }
    chatContexts[chatKey] = value;
  }
  return chatContexts;
}

function isNativeSessionCacheEntry(value: unknown): value is AppState["native_session_lists"][string]["sessions"][number] {
  if (!isRecord(value)) {
    return false;
  }

  return (
    isString(value.session_id) &&
    isOptionalString(value.cwd) &&
    (value.title === undefined || value.title === null || isString(value.title)) &&
    isOptionalString(value.updated_at)
  );
}

function isNativeSessionListCacheRecord(
  value: unknown,
): value is AppState["native_session_lists"][string] {
  if (!isRecord(value)) {
    return false;
  }

  return (
    isString(value.created_at) &&
    isString(value.agent) &&
    isOptionalString(value.workspace) &&
    isString(value.cwd) &&
    Array.isArray(value.sessions) &&
    value.sessions.every(isNativeSessionCacheEntry) &&
    (value.next_cursor === undefined || value.next_cursor === null || isString(value.next_cursor))
  );
}

function parseNativeSessionLists(raw: unknown): AppState["native_session_lists"] {
  // native_session_lists is a regenerable, TTL'd cache — a corrupt entry must
  // never fail the whole state load (which would block daemon startup). A
  // missing or non-object field resets to empty; individual malformed entries
  // are silently dropped. Real state (sessions/chat_contexts) stays strict.
  if (!isRecord(raw)) {
    return {};
  }

  const nativeSessionLists: AppState["native_session_lists"] = {};
  for (const [chatKey, value] of Object.entries(raw)) {
    if (isNativeSessionListCacheRecord(value)) {
      nativeSessionLists[chatKey] = value;
    }
  }
  return nativeSessionLists;
}

function isScheduledTaskStatus(value: unknown): value is ScheduledTaskStatus {
  return (
    value === "pending" ||
    value === "triggering" ||
    value === "executed" ||
    value === "cancelled" ||
    value === "missed" ||
    value === "failed"
  );
}

function isOptionalScheduledSessionMode(value: unknown): boolean {
  return value === undefined || value === "temp" || value === "bound";
}

function isScheduledTaskRecord(value: unknown): value is ScheduledTaskRecord {
  if (!isRecord(value)) return false;
  return (
    isString(value.id) &&
    isString(value.chat_key) &&
    isString(value.session_alias) &&
    isString(value.execute_at) &&
    isString(value.message) &&
    isScheduledTaskStatus(value.status) &&
    isString(value.created_at) &&
    isOptionalString(value.account_id) &&
    isOptionalString(value.reply_context_token) &&
    isOptionalString(value.source_label) &&
    isOptionalString(value.triggered_at) &&
    isOptionalString(value.executed_at) &&
    isOptionalString(value.cancelled_at) &&
    isOptionalString(value.missed_at) &&
    isOptionalString(value.failed_at) &&
    isOptionalString(value.last_error) &&
    isOptionalScheduledSessionMode(value.session_mode) &&
    isOptionalString(value.agent) &&
    isOptionalString(value.workspace)
  );
}

function parseScheduledTasks(
  raw: unknown,
  dropped: StateLoadDroppedRecord[],
): Record<string, ScheduledTaskRecord> {
  const source = sectionRecord(raw, "scheduled_tasks", dropped);
  const tasks: Record<string, ScheduledTaskRecord> = {};
  for (const [id, value] of Object.entries(source)) {
    if (!isScheduledTaskRecord(value) || value.id !== id) {
      dropped.push({ section: "scheduled_tasks", key: id, reason: "malformed scheduled task record" });
      continue;
    }
    tasks[id] = value;
  }
  return tasks;
}

/**
 * Lenient state parser: a malformed record (or wrong-typed section) is skipped
 * and collected in `dropped` instead of throwing, so one bad record can never
 * brick daemon startup. The per-record shape checks themselves stay strict — an
 * invalid record is quarantined, it never flows into dispatch logic. Only a
 * non-object top level still throws (StateStore.load treats that as a corrupt
 * file and renames it aside).
 */
export function parseState(
  raw: unknown,
  path: string,
  dropped: StateLoadDroppedRecord[] = [],
  migrated: StateLoadDroppedRecord[] = [],
): AppState {
  if (!isRecord(raw)) {
    throw new Error(`state file "${path}" must contain a JSON object`);
  }

  const parsedSessions = parseSessions(sectionRecord(raw.sessions, "sessions", dropped), dropped, migrated);
  const orchestration = parseOrchestrationState(raw.orchestration, dropped);
  repairExternalCoordinatorIdentityCollisions(parsedSessions, orchestration, dropped);

  return {
    sessions: parsedSessions,
    chat_contexts: parseChatContexts(sectionRecord(raw.chat_contexts, "chat_contexts", dropped), dropped),
    native_session_lists: parseNativeSessionLists(raw.native_session_lists),
    orchestration,
    scheduled_tasks: parseScheduledTasks(raw.scheduled_tasks, dropped),
  };
}

/**
 * Cross-record repair: an external coordinator handle that collides with a
 * logical session, worker binding, or active task worker session is dropped
 * (the coordinator record is the regenerable side — it is re-registered the
 * next time the coordinator connects) instead of failing the whole load.
 */
function repairExternalCoordinatorIdentityCollisions(
  sessions: AppState["sessions"],
  orchestration: OrchestrationState,
  dropped: StateLoadDroppedRecord[],
): void {
  for (const coordinatorSession of Object.keys(orchestration.externalCoordinators)) {
    const conflict = findExternalCoordinatorConflict(coordinatorSession, sessions, orchestration);
    if (!conflict) {
      continue;
    }
    delete orchestration.externalCoordinators[coordinatorSession];
    dropped.push({
      section: "orchestration.externalCoordinators",
      key: coordinatorSession,
      reason: `conflicts with ${conflict}; dropped (re-registered on next coordinator connect)`,
    });
  }
}

function findExternalCoordinatorConflict(
  coordinatorSession: string,
  sessions: AppState["sessions"],
  orchestration: OrchestrationState,
): string | null {
  if (Object.values(sessions).some((session) =>
    sameCoordinatorSession(session.transport_session, coordinatorSession),
  )) {
    return "a logical session";
  }
  if (orchestration.workerBindings[coordinatorSession]) {
    return "a worker binding";
  }
  if (Object.values(orchestration.tasks).some(
    (task) =>
      task.workerSession === coordinatorSession &&
      (!isTerminalTaskStatus(task.status) || task.reviewPending !== undefined),
  )) {
    return "an active task worker session";
  }
  return null;
}

function isTerminalTaskStatus(status: OrchestrationTaskStatus): boolean {
  return status === "completed" || status === "failed" || status === "cancelled";
}

export interface StateStoreOptions {
  /** Injectable clock used for quarantine/corrupt backup file names. */
  now?: () => Date;
  /**
   * Injectable backup writer (tests simulate backup failures). May return the
   * path actually written when it differs from the requested one (the default
   * writer suffix-retries instead of overwriting an existing backup).
   */
  writeBackup?: (targetPath: string, content: string) => Promise<string | void>;
  /**
   * Injectable durable writer for the legacy logical_session_id migration
   * (tests simulate write failures). Defaults to the regular atomic save.
   */
  writeMigration?: (state: AppState) => Promise<void>;
}

/** Result of a side-effect-free {@link StateStore.inspect}. */
export interface StateLoadInspection {
  state: AppState;
  /** Null when the file is fully valid (or missing/empty). */
  report: StateLoadReport | null;
}

type ParsedStateFile =
  | { kind: "absent" }
  | { kind: "corrupt"; reason: string }
  | {
      kind: "parsed";
      state: AppState;
      dropped: StateLoadDroppedRecord[];
      migrated: StateLoadDroppedRecord[];
      content: string;
    };

export class StateStore {
  private loadReport: StateLoadReport | null = null;

  constructor(
    private readonly path: string,
    private readonly options: StateStoreOptions = {},
  ) {}

  /**
   * Report of the most recent load(): null when the file was fully valid (or
   * missing/empty), otherwise the dropped/repaired records plus the quarantine
   * or corrupt backup path. Callers log/print this so silent repair is visible.
   */
  get lastLoadReport(): StateLoadReport | null {
    return this.loadReport;
  }

  async load(): Promise<AppState> {
    this.loadReport = null;

    const read = await this.readAndParse();
    if (read.kind === "absent") {
      return createEmptyState();
    }
    if (read.kind === "corrupt") {
      return await this.recoverFromCorruptFile(read.reason);
    }
    if (read.dropped.length === 0 && read.migrated.length === 0) {
      // Happy path: no report, no backup I/O.
      return read.state;
    }

    const report: StateLoadReport = { dropped: read.dropped };
    if (read.migrated.length > 0) {
      report.migrated = read.migrated;
    }

    if (read.dropped.length > 0) {
      // Something was dropped/repaired. Back up the ORIGINAL bytes before
      // returning: debounced saves fire shortly after load and would otherwise
      // overwrite the only copy of the quarantined records.
      const quarantinePath = `${this.path}.quarantine-${this.fileTimestamp()}`;
      try {
        const written = await (this.options.writeBackup ?? defaultWriteBackup)(quarantinePath, read.content);
        report.quarantinePath = typeof written === "string" ? written : quarantinePath;
      } catch (error) {
        // Best-effort: losing the backup must not re-introduce the startup brick.
        report.backupError = error instanceof Error ? error.message : String(error);
      }
    }

    if (read.migrated.length > 0) {
      // Durable, fail-closed migration: newly assigned logical_session_id
      // values must reach disk BEFORE any caller sees the state. If this save
      // fails, load() rejects (buildApp then fails and no channel/plugin
      // starts) rather than publishing in-memory-only temporary ids.
      await this.persistMigration(read.state);
    }

    this.loadReport = report;
    return read.state;
  }

  /** Synchronous (awaited) atomic write of a migrated state, via the private-file writer. */
  private async persistMigration(state: AppState): Promise<void> {
    await (this.options.writeMigration ?? ((next: AppState) => this.save(next)))(state);
  }

  /**
   * Side-effect-free variant of load() for diagnostic callers (doctor): parses
   * and reports exactly what load() would drop/repair/migrate, but never writes
   * a quarantine backup, never renames a corrupt file, never persists pending
   * logical_session_id migrations, and does not touch {@link lastLoadReport}.
   */
  async inspect(): Promise<StateLoadInspection> {
    const read = await this.readAndParse();
    if (read.kind === "absent") {
      return { state: createEmptyState(), report: null };
    }
    if (read.kind === "corrupt") {
      return {
        state: createEmptyState(),
        report: { dropped: [{ section: "file", key: this.path, reason: read.reason }] },
      };
    }
    return {
      state: read.state,
      report:
        read.dropped.length > 0 || read.migrated.length > 0
          ? {
              dropped: read.dropped,
              ...(read.migrated.length > 0 ? { migrated: read.migrated } : {}),
            }
          : null,
    };
  }

  private async readAndParse(): Promise<ParsedStateFile> {
    let content: string;
    try {
      content = await readFile(this.path, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return { kind: "absent" };
      }
      throw error;
    }
    if (content.trim() === "") {
      return { kind: "absent" };
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(content) as unknown;
    } catch (error) {
      return {
        kind: "corrupt",
        reason: `invalid JSON: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
    if (!isRecord(parsed)) {
      return { kind: "corrupt", reason: "top-level value is not an object" };
    }

    const dropped: StateLoadDroppedRecord[] = [];
    const migrated: StateLoadDroppedRecord[] = [];
    return { kind: "parsed", state: parseState(parsed, this.path, dropped, migrated), dropped, migrated, content };
  }

  async save(state: AppState): Promise<void> {
    await writePrivateFileAtomic(
      this.path,
      JSON.stringify({ version: STATE_FILE_VERSION, ...state }, null, 2),
    );
  }

  private fileTimestamp(): string {
    const now = this.options.now?.() ?? new Date();
    // Filesystem-safe ISO timestamp (":" and "." are not portable in names).
    return now.toISOString().replace(/[:.]/g, "-");
  }

  /**
   * Whole-file corruption (JSON syntax error / non-object top level): rename
   * the file aside — not copy — so the next save does not fight the corrupt
   * bytes, then start from an empty state.
   */
  private async recoverFromCorruptFile(reason: string): Promise<AppState> {
    const corruptPath = `${this.path}.corrupt-${this.fileTimestamp()}`;
    const report: StateLoadReport = {
      dropped: [{ section: "file", key: this.path, reason }],
    };
    try {
      await rename(this.path, corruptPath);
      report.corruptPath = corruptPath;
    } catch (error) {
      report.backupError = error instanceof Error ? error.message : String(error);
    }
    this.loadReport = report;
    return createEmptyState();
  }
}

async function defaultWriteBackup(targetPath: string, content: string): Promise<string> {
  // state.json is 0600 (it can reference private chat keys); keep backups
  // private too. "wx" + suffix retry: a same-millisecond load (e.g. a second
  // process) must never overwrite an existing quarantine backup.
  for (let attempt = 0; ; attempt += 1) {
    const candidate = attempt === 0 ? targetPath : `${targetPath}-${attempt}`;
    try {
      await writeFile(candidate, content, { encoding: "utf8", mode: 0o600, flag: "wx" });
      return candidate;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST" || attempt >= 9) {
        throw error;
      }
    }
  }
}
