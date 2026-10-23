import type { AppConfig } from "../../config/types";
import type { AppState } from "../../state/types";
import type { DoctorCheckResult } from "../doctor-types";
import { t } from "../../i18n/index.js";

export interface CheckOrchestrationHealthOptions {
  loadState: () => Promise<AppState>;
  now: () => Date;
  heartbeatThresholdSeconds: number;
  /**
   * Live workspace registry. When provided, persisted sessions and cwd-less
   * worker bindings whose workspace disappeared (e.g. a hand-edited config)
   * are reported. Pathless bindings with an explicit cwd are self-contained
   * and intentionally ignored.
   */
  workspaces?: AppConfig["workspaces"];
}

export async function checkOrchestrationHealth(
  options: CheckOrchestrationHealthOptions,
): Promise<DoctorCheckResult> {
  const state = await options.loadState();
  const now = options.now().getTime();
  const threshold = options.heartbeatThresholdSeconds;

  const tasks = Object.values(state.orchestration.tasks);
  const bindings = state.orchestration.workerBindings ?? {};

  const stuckTasks = tasks.filter((task) => {
    if (task.status !== "running") return false;
    const reference = task.lastProgressAt ?? task.createdAt;
    return (now - new Date(reference).getTime()) / 1000 >= threshold;
  });

  const pendingNotices = tasks.filter((task) => task.noticePending === true);
  const failedNotices = pendingNotices.filter((task) => task.lastNoticeError);
  const pendingInjections = tasks.filter(
    (task) =>
      task.injectionPending === true &&
      (task.status === "completed" || task.status === "failed"),
  );
  const failedInjections = pendingInjections.filter((task) => task.lastInjectionError);

  const referencedWorkers = new Set(
    tasks.map((t) => t.workerSession).filter((s): s is string => typeof s === "string"),
  );
  const orphanBindings = Object.entries(bindings)
    .filter(([workerSession]) => !referencedWorkers.has(workerSession))
    .map(([workerSession]) => workerSession);
  const workspaces = options.workspaces;
  const missingWorkspaceSessions = workspaces
    ? Object.entries(state.sessions)
      .filter(([, session]) => !workspaces[session.workspace])
      .map(([alias, session]) => `${alias} -> ${session.workspace}`)
    : [];
  const missingWorkspaceBindings = workspaces
    ? Object.entries(bindings)
      .filter(([, binding]) => !workspaces[binding.workspace] && !binding.cwd?.trim())
      .map(([workerSession, binding]) => `${workerSession} -> ${binding.workspace}`)
    : [];

  const details: string[] = [];
  for (const task of stuckTasks) {
    details.push(
      `stuck task ${task.taskId}: ${task.targetAgent} running since ${task.lastProgressAt ?? task.createdAt}`,
    );
  }
  for (const task of failedNotices) {
    details.push(`notice failed for task ${task.taskId}: ${task.lastNoticeError}`);
  }
  for (const task of failedInjections) {
    details.push(`injection failed for task ${task.taskId}: ${task.lastInjectionError}`);
  }
  for (const binding of orphanBindings) {
    details.push(`orphan worker binding: ${binding}`);
  }
  for (const session of missingWorkspaceSessions) {
    details.push(`session references missing workspace: ${session}`);
  }
  for (const binding of missingWorkspaceBindings) {
    details.push(`worker binding references missing workspace: ${binding}`);
  }

  const missingWorkspaceRefs = missingWorkspaceSessions.length + missingWorkspaceBindings.length;
  const problems =
    stuckTasks.length + failedNotices.length + failedInjections.length + orphanBindings.length + missingWorkspaceRefs;
  const summaryParts = [
    ...(stuckTasks.length > 0 ? [`${stuckTasks.length} stuck`] : []),
    ...(failedNotices.length > 0 ? [`${failedNotices.length} notice-failed`] : []),
    ...(failedInjections.length > 0 ? [`${failedInjections.length} injection-failed`] : []),
    ...(orphanBindings.length > 0 ? [`${orphanBindings.length} orphan bindings`] : []),
    ...(missingWorkspaceRefs > 0 ? [`${missingWorkspaceRefs} missing-workspace refs`] : []),
  ];

  return {
    id: "orchestration",
    label: "Orchestration",
    severity: problems > 0 ? "warn" : "pass",
    summary:
      problems === 0
        ? "orchestration state healthy"
        : summaryParts.join(" / "),
    ...(details.length > 0 ? { details } : {}),
    ...(problems > 0
      ? {
          suggestions: [
            t().misc.orchestrationSuggestion1,
            t().misc.orchestrationSuggestion2,
            t().misc.orchestrationSuggestion3,
            ...(missingWorkspaceRefs > 0 ? [t().misc.orchestrationSuggestionMissingWorkspace] : []),
          ],
        }
      : {}),
  };
}
