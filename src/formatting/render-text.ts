import type { AppConfig } from "../config/types";
import type {
  OrchestrationGroupRecord,
  OrchestrationGroupSummary,
  OrchestrationTaskRecord,
} from "../orchestration/orchestration-types";
import { t } from "../i18n";

export function renderAgents(config: AppConfig): string {
  const names = Object.keys(config.agents);
  const a = t().agent;
  if (names.length === 0) {
    return a.agentsEmpty;
  }
  return [a.agentsHeader, ...names.map((name) => `- ${name}`)].join("\n");
}

export function renderWorkspaces(config: AppConfig): string {
  const names = Object.entries(config.workspaces).filter(([, workspace]) => workspace.dedicated !== true);
  const w = t().workspace;
  if (names.length === 0) {
    return w.workspacesEmpty;
  }
  return [w.workspacesHeader, ...names.map(([name, workspace]) => `- ${name}: ${workspace.cwd}`)].join("\n");
}

export function renderOrchestrationUnavailable(): string {
  return t().orchestration.serviceUnavailable;
}

export function renderDelegateSuccess(taskId: string, workerSession: string): string {
  const o = t().orchestration;
  return [o.delegateSuccessCreated(taskId), o.delegateSuccessWorker(workerSession)].join("\n");
}

export function renderGroupCreated(group: OrchestrationGroupRecord): string {
  const o = t().orchestration;
  return [o.groupCreatedId(group.groupId), o.groupCreatedTitle(group.title)].join("\n");
}

export function renderGroupList(groups: OrchestrationGroupSummary[]): string {
  const o = t().orchestration;
  if (groups.length === 0) {
    return o.groupListEmpty;
  }

  return [o.groupListHeader, ...groups.map((group) => renderGroupListItem(group))].join("\n");
}

export function renderGroupSummary(summary: OrchestrationGroupSummary): string {
  const { group, tasks } = summary;
  const o = t().orchestration;
  const lines = [
    o.groupSummaryId(group.groupId),
    o.groupSummaryTitle(group.title),
    o.groupSummaryCoordinator(group.coordinatorSession),
    o.groupSummaryTotal(summary.totalTasks),
    o.groupSummaryPending(summary.pendingApprovalTasks),
    o.groupSummaryRunning(summary.runningTasks),
    o.groupSummaryCompleted(summary.completedTasks),
    o.groupSummaryFailed(summary.failedTasks),
    o.groupSummaryCancelled(summary.cancelledTasks),
    o.groupSummaryTerminal(summary.terminal),
  ];

  if (group.injectionPending !== undefined) {
    lines.push(o.groupSummaryInjectionPending(group.injectionPending));
  }
  if (group.injectionAppliedAt) {
    lines.push(o.groupSummaryInjectionAppliedAt(group.injectionAppliedAt));
  }
  if (group.lastInjectionError) {
    lines.push(o.groupSummaryLastInjectionError(group.lastInjectionError));
  }

  if (tasks.length > 0) {
    lines.push(o.groupSummaryMembersHeader);
    for (const task of tasks) {
      lines.push(`  - ${task.taskId} [${task.status}] ${task.targetAgent}`);
    }
  }

  return lines.join("\n");
}

export function renderGroupCancelSuccess(input: {
  summary: OrchestrationGroupSummary;
  cancelledTaskIds: string[];
  skippedTaskIds: string[];
}): string {
  const o = t().orchestration;
  return [
    o.groupCancelSuccessId(input.summary.group.groupId),
    o.groupCancelSuccessCancelledCount(input.cancelledTaskIds.length),
    o.groupCancelSuccessSkippedCount(input.skippedTaskIds.length),
  ].join("\n");
}

export function renderTaskList(tasks: OrchestrationTaskRecord[]): string {
  const o = t().orchestration;
  if (tasks.length === 0) {
    return o.taskListEmpty;
  }

  return [o.taskListHeader, ...tasks.map((task) => renderTaskListItem(task))].join("\n");
}

interface TimelineEvent {
  at: string;
  event: string;
  detail?: string;
}

export function renderTaskSummary(task: OrchestrationTaskRecord): string {
  const o = t().orchestration;
  const header = [
    o.taskSummaryId(task.taskId),
    o.taskSummaryStatus(task.status),
    o.taskSummaryCoordinator(task.coordinatorSession),
    o.taskSummaryWorker(task.workerSession ?? o.taskSummaryWorkerUnassigned),
    o.taskSummaryTargetAgent(task.targetAgent),
  ];
  if (task.role) header.push(o.taskSummaryRole(task.role));
  if (task.groupId) header.push(o.taskSummaryGroup(task.groupId));
  if (task.status === "needs_confirmation") {
    header.push(o.taskSummarySource(task.sourceKind, task.sourceHandle, task.role ? ` / ${task.role}` : ""));
  }
  header.push(o.taskSummaryTask(task.task));
  if (task.summary.trim().length > 0) header.push(o.taskSummarySummary(task.summary));
  if (task.lastProgressSummary) header.push(o.taskSummaryLatestProgress(task.lastProgressSummary));
  if (task.resultText.trim().length > 0) header.push(o.taskSummaryResult(task.resultText));

  const events: TimelineEvent[] = [];
  events.push({ at: task.createdAt, event: "created" });
  if (task.workerSession && task.status !== "needs_confirmation") {
    events.push({ at: task.createdAt, event: "dispatched", detail: task.workerSession });
  }
  if (task.lastProgressAt) events.push({ at: task.lastProgressAt, event: "last_progress" });
  if (task.cancelRequestedAt) events.push({ at: task.cancelRequestedAt, event: "cancel_requested" });
  if (task.cancelCompletedAt) events.push({ at: task.cancelCompletedAt, event: "cancel_completed" });
  if (task.lastCancelError) events.push({ at: task.updatedAt, event: "cancel_failed", detail: task.lastCancelError });
  if (task.status === "completed") events.push({ at: task.updatedAt, event: "completed" });
  if (task.status === "failed") events.push({ at: task.updatedAt, event: "failed" });
  if (task.noticeSentAt) events.push({ at: task.noticeSentAt, event: "notice_sent", detail: task.deliveryAccountId });
  if (task.lastNoticeError) events.push({ at: task.updatedAt, event: "notice_failed", detail: task.lastNoticeError });
  if (task.injectionAppliedAt) events.push({ at: task.injectionAppliedAt, event: "injection_applied" });
  if (task.lastInjectionError) events.push({ at: task.updatedAt, event: "injection_failed", detail: task.lastInjectionError });

  events.sort((a, b) => a.at.localeCompare(b.at));

  const timeline = events.length > 0
    ? [o.taskSummaryTimelineHeader, ...events.map((e) => `  - [${e.at}] ${e.event}${e.detail ? `: ${e.detail}` : ""}`)]
    : [];

  return [...header, ...timeline].join("\n");
}

export function renderTaskCancelSuccess(task: OrchestrationTaskRecord): string {
  const o = t().orchestration;
  if (task.status === "completed" || task.status === "failed" || task.status === "cancelled") {
    return [o.taskCancelAlreadyDone(task.taskId), o.taskCurrentStatus(task.status)].join("\n");
  }
  if (task.cancelRequestedAt) {
    return [o.taskCancelRequested(task.taskId), o.taskCurrentStatus(task.status)].join("\n");
  }
  return [o.taskCancelled(task.taskId), o.taskCurrentStatus(task.status)].join("\n");
}

export function renderTaskApprovalSuccess(task: OrchestrationTaskRecord): string {
  const o = t().orchestration;
  return [o.taskApproved(task.taskId), o.taskCurrentStatus(task.status)].join("\n");
}

export function renderTaskRejectSuccess(task: OrchestrationTaskRecord): string {
  const o = t().orchestration;
  return [o.taskRejected(task.taskId), o.taskCurrentStatus(task.status)].join("\n");
}

export function renderTaskConfirmationUnavailable(task: OrchestrationTaskRecord): string {
  const o = t().orchestration;
  return [o.taskConfirmationUnavailable(task.taskId), o.taskCurrentStatus(task.status)].join("\n");
}

export function renderTasksCleanResult(removedTasks: number, removedBindings: number): string {
  const o = t().orchestration;
  if (removedTasks === 0 && removedBindings === 0) {
    return o.tasksCleanEmpty;
  }

  const lines: string[] = [];
  if (removedTasks > 0) {
    lines.push(o.tasksCleanRemovedTasks(removedTasks));
  }
  if (removedBindings > 0) {
    lines.push(o.tasksCleanRemovedBindings(removedBindings));
  }
  return lines.join("\n");
}

function renderTaskListItem(task: OrchestrationTaskRecord): string {
  const o = t().orchestration;
  const role = task.role ? ` / ${task.role}` : "";
  const group = task.groupId ? o.taskListItemGroup(task.groupId) : "";
  const summary = task.summary.trim().length > 0 ? `：${task.summary}` : "";
  const source = task.status === "needs_confirmation"
    ? o.taskListItemSource(task.sourceKind, task.sourceHandle, task.role ? ` / ${task.role}` : "")
    : "";
  const reliability = [
    task.noticePending ? o.taskListItemNoticePending : "",
    task.injectionPending ? o.taskListItemInjectionPending : "",
    task.cancelRequestedAt && !task.cancelCompletedAt && task.status === "running" ? o.taskListItemCancelling : "",
  ]
    .filter(Boolean)
    .map((item) => `；${item}`)
    .join("");
  return `- ${task.taskId} [${task.status}] ${task.targetAgent}${role} -> ${task.workerSession ?? o.taskSummaryWorkerUnassigned}${group}${source}${summary}${reliability}`;
}

function renderGroupListItem(group: OrchestrationGroupSummary): string {
  const o = t().orchestration;
  const reliability = [
    group.group.injectionPending ? o.groupListItemInjectionPending : "",
  ]
    .filter(Boolean)
    .map((item) => `；${item}`)
    .join("");
  return [
    `- ${group.group.groupId}`,
    group.group.title,
    o.groupListItemTotal(group.totalTasks),
    o.groupListItemPending(group.pendingApprovalTasks),
    o.groupListItemRunning(group.runningTasks),
    o.groupListItemCompleted(group.completedTasks),
    o.groupListItemFailed(group.failedTasks),
    `${o.groupListItemCancelled(group.cancelledTasks)}${reliability}`,
  ].join(" | ");
}

export function renderTaskProgress(task: OrchestrationTaskRecord, summary: string): string {
  return t().render.taskProgress(task.taskId, task.targetAgent, summary);
}

export function renderTaskHeartbeat(task: OrchestrationTaskRecord, elapsedSeconds: number): string {
  const minutes = Math.floor(elapsedSeconds / 60);
  return t().render.taskHeartbeat(task.taskId, minutes);
}
