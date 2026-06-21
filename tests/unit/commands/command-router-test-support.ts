import { mock } from "bun:test";
import type { ConfigStore, RawConfigLookup, RawConfigPath } from "../../../src/config/config-store";
import {
  readRawConfigValue,
  setRawConfigValue,
  unsetRawConfigValue,
} from "../../../src/config/config-store";
import type { AppConfig } from "../../../src/config/types";
import type { OrchestrationRouterOps } from "../../../src/commands/router-types";
import { createEmptyState } from "../../../src/state/types";
import type { AppState } from "../../../src/state/types";
import type { StateStore } from "../../../src/state/state-store";
import { SessionService } from "../../../src/sessions/session-service";
import type {
  OrchestrationGroupRecord,
  OrchestrationGroupSummary,
  OrchestrationTaskRecord,
  OrchestrationTaskStatus,
} from "../../../src/orchestration/orchestration-types";
import type { ResolvedSession, SessionTransport } from "../../../src/transport/types";
import type { AppLogger } from "../../../src/logging/app-logger";

export function createConfig(): AppConfig {
  return {
    transport: {
      type: "acpx-cli",
      command: "acpx",
      permissionMode: "approve-all",
      nonInteractivePermissions: "deny",
    },
    logging: {
      level: "info",
      maxSizeBytes: 2 * 1024 * 1024,
      maxFiles: 5,
      retentionDays: 7,
    },
    channel: {
      type: "weixin",
      replyMode: "stream",
    },
    channels: [{ id: "weixin", type: "weixin", enabled: true }],
    plugins: [],
    agents: {
      codex: { driver: "codex" },
    },
    workspaces: {
      backend: {
        cwd: "/tmp/backend",
      },
    },
    orchestration: {
      maxPendingAgentRequestsPerCoordinator: 3,
      allowWorkerChainedRequests: false,
      allowedAgentRequestTargets: [],
      allowedAgentRequestRoles: [],
      progressHeartbeatSeconds: 300,
      maxParallelTasksPerAgent: 3,
    },
  };
}

export class MemoryStateStore implements Pick<StateStore, "save"> {
  async save(_state: AppState): Promise<void> {}
}

export class MemoryConfigStore
  implements
    Pick<
      ConfigStore,
      | "load"
      | "upsertWorkspace"
      | "removeWorkspace"
      | "upsertAgent"
      | "removeAgent"
      | "updateTransport"
      | "updateChannel"
      | "getRawValue"
      | "setRawValue"
      | "unsetRawValue"
    >
{
  constructor(private readonly config: AppConfig) {}

  async load(): Promise<AppConfig> {
    return this.config;
  }

  private root(): Record<string, unknown> {
    return this.config as unknown as Record<string, unknown>;
  }

  async getRawValue(path: RawConfigPath): Promise<RawConfigLookup> {
    return readRawConfigValue(this.root(), path);
  }

  async setRawValue(path: RawConfigPath, value: unknown): Promise<AppConfig> {
    setRawConfigValue(this.root(), path, value);
    return this.config;
  }

  async unsetRawValue(path: RawConfigPath): Promise<AppConfig> {
    unsetRawConfigValue(this.root(), path);
    return this.config;
  }

  async upsertWorkspace(name: string, cwd: string, description?: string): Promise<AppConfig> {
    this.config.workspaces[name] = {
      cwd,
      ...(description ? { description } : {}),
    };
    return this.config;
  }

  async removeWorkspace(name: string): Promise<AppConfig> {
    delete this.config.workspaces[name];
    return this.config;
  }

  async upsertAgent(name: string, agent: AppConfig["agents"][string]): Promise<AppConfig> {
    this.config.agents[name] = agent;
    return this.config;
  }

  async removeAgent(name: string): Promise<AppConfig> {
    delete this.config.agents[name];
    return this.config;
  }

  async updateTransport(transport: Partial<AppConfig["transport"]>): Promise<AppConfig> {
    applyPatch(this.config.transport as unknown as Record<string, unknown>, transport);
    return this.config;
  }

  async updateChannel(channel: Partial<AppConfig["channel"]>): Promise<AppConfig> {
    applyPatch(this.config.channel as unknown as Record<string, unknown>, channel);
    return this.config;
  }
}

function applyPatch(target: Record<string, unknown>, patch: object): void {
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) {
      delete target[key];
    } else {
      target[key] = value;
    }
  }
}

export function createTransport(): SessionTransport {
  return {
    ensureSession: mock(async (_session: ResolvedSession) => {}),
    tailSessionHistory: mock(async (_session: ResolvedSession, _lines: number) => ({ text: "" })),
    prompt: mock(async (session: ResolvedSession, text: string) => ({
      text: `agent:${session.alias}:${text}`,
    })),
    setMode: mock(async (_session: ResolvedSession, _modeId: string) => {}),
    cancel: mock(async () => ({
      cancelled: true,
      message: "cancelled",
    })),
    hasSession: mock(async () => true),
    listAgentSessions: mock(async () => ({ source: "agent" as const, sessions: [] })),
    resumeAgentSession: mock(async (_session: ResolvedSession, _agentSessionId: string) => {}),
    removeSession: mock(async (_session: ResolvedSession) => {}),
    deleteSession: mock(async (_session: ResolvedSession) => {}),
    updatePermissionPolicy: mock(async (_policy) => {}),
  };
}

type OrchestrationTaskSeed = Pick<
  OrchestrationTaskRecord,
  | "taskId"
  | "sourceHandle"
  | "sourceKind"
  | "coordinatorSession"
  | "workspace"
  | "targetAgent"
  | "task"
  | "status"
  | "summary"
  | "resultText"
  | "createdAt"
  | "updatedAt"
> &
  Partial<
    Pick<
      OrchestrationTaskRecord,
      | "workerSession"
      | "role"
      | "groupId"
      | "coordinatorInjectedAt"
      | "cancelRequestedAt"
      | "cancelCompletedAt"
      | "lastCancelError"
      | "noticePending"
      | "noticeSentAt"
      | "lastNoticeError"
      | "injectionPending"
      | "injectionAppliedAt"
      | "lastInjectionError"
      | "openQuestion"
      | "reviewPending"
    >
  >;

function cloneTask(task: OrchestrationTaskRecord): OrchestrationTaskRecord {
  return JSON.parse(JSON.stringify(task)) as OrchestrationTaskRecord;
}

function cloneGroup(group: OrchestrationGroupRecord): OrchestrationGroupRecord {
  return JSON.parse(JSON.stringify(group)) as OrchestrationGroupRecord;
}

function buildGroupSummary(group: OrchestrationGroupRecord, tasks: OrchestrationTaskRecord[]): OrchestrationGroupSummary {
  const sortedTasks = tasks
    .slice()
    .sort((left, right) => left.createdAt.localeCompare(right.createdAt))
    .map((task) => cloneTask(task));
  const pendingApprovalTasks = sortedTasks.filter(
    (task) => task.status === "needs_confirmation",
  ).length;
  const runningTasks = sortedTasks.filter((task) => task.status === "running").length;
  const completedTasks = sortedTasks.filter((task) => task.status === "completed").length;
  const failedTasks = sortedTasks.filter((task) => task.status === "failed").length;
  const cancelledTasks = sortedTasks.filter((task) => task.status === "cancelled").length;

  return {
    group: cloneGroup(group),
    tasks: sortedTasks,
    totalTasks: sortedTasks.length,
    pendingApprovalTasks,
    runningTasks,
    completedTasks,
    failedTasks,
    cancelledTasks,
    terminal:
      sortedTasks.length > 0 &&
      sortedTasks.every((task) => task.status === "completed" || task.status === "failed" || task.status === "cancelled"),
  };
}

function matchesTaskFilter(task: OrchestrationTaskRecord, filter?: { coordinatorSession?: string }) {
  return filter?.coordinatorSession === undefined || task.coordinatorSession === filter.coordinatorSession;
}

export function createOrchestrationService(options?: {
  tasks?: OrchestrationTaskSeed[];
  groups?: OrchestrationGroupRecord[];
  taskId?: string;
  activeHumanPackage?: {
    packageId: string;
    promptText: string;
    openTaskIds: string[];
    queuedCount: number;
    awaitingReplyMessageId?: string;
    deliveredChatKey?: string;
    deliveredAt?: string;
    messages?: Array<{
      messageId: string;
      kind: "initial" | "follow_up";
      promptText: string;
      createdAt: string;
      taskQuestions?: Array<{ taskId: string; questionId: string }>;
    }>;
  };
}) {
  let tasks: OrchestrationTaskRecord[] = (options?.tasks ?? []).map((task) => ({
    ...task,
    workerSession: task.workerSession ?? `${task.workspace}:${task.targetAgent}:${task.coordinatorSession}`,
  }));
  let groups: OrchestrationGroupRecord[] = (options?.groups ?? []).map((group) => ({ ...group }));
  let activeHumanPackage = options?.activeHumanPackage
    ? {
        ...options.activeHumanPackage,
        openTaskIds: [...options.activeHumanPackage.openTaskIds],
      }
    : undefined;
  const coordinatorRouteContexts: Array<{
    coordinatorSession: string;
    chatKey: string;
    accountId?: string;
    replyContextToken?: string;
  }> = [];

  const createGroup = mock(async ({ coordinatorSession, title }: { coordinatorSession: string; title: string }) => {
    const groupId = options?.taskId ?? "group-1";
    const group: OrchestrationGroupRecord = {
      groupId,
      coordinatorSession,
      title,
      createdAt: "2026-04-13T10:00:00.000Z",
      updatedAt: "2026-04-13T10:00:00.000Z",
    };
    groups.push(group);
    return { ...group };
  });

  const getGroupSummary = mock(
    async ({ groupId, coordinatorSession }: { groupId: string; coordinatorSession: string }) => {
      const group = groups.find(
        (item) => item.groupId === groupId && item.coordinatorSession === coordinatorSession,
      );
      if (!group) {
        return null;
      }
      return buildGroupSummary(group, tasks.filter((task) => task.groupId === groupId));
    },
  );

  const listGroupSummaries = mock(async (input: { coordinatorSession: string; status?: string; stuck?: boolean; sort?: string; order?: string }) => {
    return groups
      .filter((group) => group.coordinatorSession === input.coordinatorSession)
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
      .map((group) => buildGroupSummary(group, tasks.filter((task) => task.groupId === group.groupId)));
  });

  const requestDelegate = mock(async (input: {
    sourceHandle: string;
    sourceKind: "human" | "coordinator" | "worker";
    coordinatorSession: string;
    workspace: string;
    targetAgent: string;
    task: string;
    role?: string;
    groupId?: string;
  }) => {
    const taskId = options?.taskId ?? "task-1";
    const workerSession = [input.workspace, input.targetAgent, input.role, input.coordinatorSession]
      .filter((part): part is string => typeof part === "string" && part.trim().length > 0)
      .map((part) => part.trim())
      .join(":");
    const now = "2026-04-13T10:00:00.000Z";
    tasks.push({
      taskId,
      sourceHandle: input.sourceHandle,
      sourceKind: input.sourceKind,
      coordinatorSession: input.coordinatorSession,
      workerSession,
      workspace: input.workspace,
      targetAgent: input.targetAgent,
      ...(input.role ? { role: input.role } : {}),
      ...(input.groupId ? { groupId: input.groupId } : {}),
      task: input.task,
      status: "running",
      summary: "",
      resultText: "",
      createdAt: now,
      updatedAt: now,
    });
    return {
      taskId,
      status: "running" as OrchestrationTaskStatus,
      workerSession,
    };
  });

  const listTasks = mock(async (filter?: { coordinatorSession?: string }) => {
    return tasks.filter((task) => matchesTaskFilter(task, filter)).map((task) => cloneTask(task));
  });

  const getTask = mock(async (taskId: string) => {
    const task = tasks.find((item) => item.taskId === taskId);
    return task ? cloneTask(task) : null;
  });

  const requestTaskCancellation = mock(
    async ({
      taskId,
      sourceHandle,
      coordinatorSession,
    }: {
      taskId: string;
      sourceHandle?: string;
      coordinatorSession?: string;
    }) => {
      const task = tasks.find((item) => item.taskId === taskId);
      if (!task) {
        throw new Error(`task "${taskId}" does not exist`);
      }
      if (sourceHandle !== undefined && task.sourceHandle !== sourceHandle) {
        throw new Error(`task "${taskId}" belongs to source "${task.sourceHandle}", not "${sourceHandle}"`);
      }
      if (coordinatorSession !== undefined && task.coordinatorSession !== coordinatorSession) {
        throw new Error(`task "${taskId}" belongs to coordinator "${task.coordinatorSession}", not "${coordinatorSession}"`);
      }
      if (task.status === "completed" || task.status === "failed" || task.status === "cancelled") {
        return cloneTask(task);
      }
      if (task.status === "running") {
        task.cancelRequestedAt = "2026-04-13T10:00:00.000Z";
        task.updatedAt = "2026-04-13T10:00:00.000Z";
        return cloneTask(task);
      }
      task.status = "cancelled";
      task.cancelRequestedAt = "2026-04-13T10:00:00.000Z";
      task.cancelCompletedAt = "2026-04-13T10:00:00.000Z";
      task.updatedAt = "2026-04-13T10:00:00.000Z";
      return cloneTask(task);
    },
  );

  const cancelTask = mock(async ({ taskId, sourceHandle, coordinatorSession }: { taskId: string; sourceHandle?: string; coordinatorSession?: string }) => {
    const task = tasks.find((item) => item.taskId === taskId);
    if (!task) {
      throw new Error(`task "${taskId}" does not exist`);
    }
    if (sourceHandle !== undefined && task.sourceHandle !== sourceHandle) {
      throw new Error(`task "${taskId}" belongs to source "${task.sourceHandle}", not "${sourceHandle}"`);
    }
    if (coordinatorSession !== undefined && task.coordinatorSession !== coordinatorSession) {
      throw new Error(`task "${taskId}" belongs to coordinator "${task.coordinatorSession}", not "${coordinatorSession}"`);
    }
    if (task.status === "needs_confirmation" && task.summary.trim().length === 0) {
      task.summary = "rejected";
    }
    task.status = "cancelled";
    task.updatedAt = "2026-04-13T10:00:00.000Z";
    return cloneTask(task);
  });

  const approveTask = mock(async ({ taskId, coordinatorSession }: { taskId: string; coordinatorSession: string }) => {
    const task = tasks.find((item) => item.taskId === taskId);
    if (!task) {
      throw new Error(`task "${taskId}" does not exist`);
    }
    if (task.coordinatorSession !== coordinatorSession) {
      throw new Error(`task "${taskId}" belongs to coordinator "${task.coordinatorSession}", not "${coordinatorSession}"`);
    }
    if (task.status !== "needs_confirmation") {
      throw new Error(`task "${taskId}" is ${task.status}, not needs_confirmation`);
    }
    task.workerSession = task.workerSession ?? `${task.workspace}:${task.targetAgent}:${task.coordinatorSession}`;
    task.status = "running";
    task.updatedAt = "2026-04-13T10:00:00.000Z";
    return cloneTask(task);
  });

  const listPendingCoordinatorResults = mock(async (coordinatorSession: string) => {
    return tasks
      .filter(
        (task) =>
          task.coordinatorSession === coordinatorSession &&
          (task.status === "completed" || task.status === "failed") &&
          task.coordinatorInjectedAt === undefined,
      )
      .sort((left, right) => left.updatedAt.localeCompare(right.updatedAt))
      .map((task) => cloneTask(task));
  });

  const listPendingCoordinatorBlockers = mock(async (coordinatorSession: string) => {
    return tasks
      .filter(
        (task) =>
          task.coordinatorSession === coordinatorSession &&
          task.status === "blocked" &&
          task.openQuestion?.status === "open",
      )
      .sort((left, right) => left.updatedAt.localeCompare(right.updatedAt))
      .map((task) => cloneTask(task));
  });

  const listContestedCoordinatorResults = mock(async (coordinatorSession: string) => {
    return tasks
      .filter((task) => task.coordinatorSession === coordinatorSession && task.reviewPending !== undefined)
      .sort((left, right) => left.updatedAt.localeCompare(right.updatedAt))
      .map((task) => cloneTask(task));
  });

  const recordCoordinatorRouteContext = mock(
    async (input: {
      coordinatorSession: string;
      chatKey: string;
      sessionAlias?: string;
      accountId?: string;
      replyContextToken?: string;
      channel?: string;
      chatType?: "direct" | "group";
      senderId?: string;
      senderName?: string;
      groupId?: string;
      isOwner?: boolean;
    }) => {
      coordinatorRouteContexts.push({ ...input });
      return {
        ...input,
        updatedAt: "2026-04-13T10:00:00.000Z",
      };
    },
  );

  const claimActiveHumanReply = mock(
    async ({ coordinatorSession, chatKey }: { coordinatorSession: string; chatKey: string }) => {
      if (
        !activeHumanPackage ||
        activeHumanPackage.awaitingReplyMessageId === undefined ||
        (activeHumanPackage.deliveredChatKey ?? "wx:user") !== chatKey ||
        coordinatorSession !== tasks.find((task) => activeHumanPackage?.openTaskIds.includes(task.taskId))
          ?.coordinatorSession
      ) {
        return null;
      }

      const messageId = activeHumanPackage.awaitingReplyMessageId;
      activeHumanPackage = {
        ...activeHumanPackage,
        awaitingReplyMessageId: undefined,
        deliveredChatKey: activeHumanPackage.deliveredChatKey ?? chatKey,
        deliveredAt: activeHumanPackage.deliveredAt ?? "2026-04-13T10:06:00.000Z",
      };
      return {
        coordinatorSession,
        packageId: activeHumanPackage.packageId,
        messageId,
        chatKey,
        promptText: activeHumanPackage.promptText,
        queuedCount: activeHumanPackage.queuedCount,
        taskQuestions: activeHumanPackage.openTaskIds.flatMap((taskId) => {
          const task = tasks.find((item) => item.taskId === taskId);
          if (!task?.openQuestion || task.openQuestion.status !== "open") {
            return [];
          }
          return [{ taskId, questionId: task.openQuestion.questionId }];
        }),
      };
    },
  );

  const getActiveHumanQuestionPackage = mock(async (coordinatorSession: string) => {
    if (
      !activeHumanPackage ||
      coordinatorSession !== tasks.find((task) => activeHumanPackage?.openTaskIds.includes(task.taskId))
        ?.coordinatorSession
    ) {
      return null;
    }

      return {
        packageId: activeHumanPackage.packageId,
        promptText: activeHumanPackage.promptText,
        ...(activeHumanPackage.awaitingReplyMessageId
          ? { awaitingReplyMessageId: activeHumanPackage.awaitingReplyMessageId }
          : {}),
        ...(activeHumanPackage.deliveredChatKey
          ? { deliveredChatKey: activeHumanPackage.deliveredChatKey }
          : activeHumanPackage.awaitingReplyMessageId
            ? { deliveredChatKey: "wx:user" }
            : {}),
        ...(activeHumanPackage.deliveredAt
          ? { deliveredAt: activeHumanPackage.deliveredAt }
          : activeHumanPackage.awaitingReplyMessageId || activeHumanPackage.deliveredChatKey
            ? { deliveredAt: "2026-04-13T10:06:00.000Z" }
            : {}),
        openTaskIds: [...activeHumanPackage.openTaskIds],
        queuedCount: activeHumanPackage.queuedCount,
        ...(() => {
          const lastMessage = activeHumanPackage.messages?.at(-1);
          const messageTaskQuestions = (lastMessage?.taskQuestions ?? [])
            .filter((tq) => activeHumanPackage.openTaskIds.includes(tq.taskId))
            .filter((tq) => {
              const task = tasks.find((t) => t.taskId === tq.taskId);
              return task?.openQuestion?.status === "open" && task.openQuestion.questionId === tq.questionId;
            });
          return messageTaskQuestions.length > 0 ? { messageTaskQuestions } : {};
        })(),
      };
  });

  const listPendingCoordinatorGroups = mock(async (coordinatorSession: string) => {
    return groups
      .filter((group) => group.coordinatorSession === coordinatorSession)
      .filter((group) => {
        const groupTasks = tasks.filter((task) => task.groupId === group.groupId);
        return (
          groupTasks.length > 0 &&
          groupTasks.every((task) => task.status === "completed" || task.status === "failed") &&
          group.coordinatorInjectedAt === undefined
        );
      })
      .sort((left, right) => left.updatedAt.localeCompare(right.updatedAt))
      .map((group) => ({ ...group }));
  });

  const markCoordinatorGroupsInjected = mock(async (groupIds: string[]) => {
    const injectedAt = "2026-04-13T11:00:00.000Z";
    for (const groupId of groupIds) {
      const group = groups.find((item) => item.groupId === groupId);
      if (!group || group.coordinatorInjectedAt !== undefined) {
        continue;
      }
      group.coordinatorInjectedAt = injectedAt;
      group.injectionPending = false;
      group.injectionAppliedAt = injectedAt;
      group.lastInjectionError = undefined;
      group.updatedAt = injectedAt;
    }
  });

  const markCoordinatorGroupsInjectionFailed = mock(async (groupIds: string[], errorMessage: string) => {
    const failedAt = "2026-04-13T11:05:00.000Z";
    for (const groupId of groupIds) {
      const group = groups.find((item) => item.groupId === groupId);
      if (!group) {
        continue;
      }
      group.injectionPending = true;
      group.lastInjectionError = errorMessage;
      group.updatedAt = failedAt;
    }
  });

  const markCoordinatorResultsInjected = mock(async (taskIds: string[]) => {
    const injectedAt = "2026-04-13T11:00:00.000Z";
    for (const taskId of taskIds) {
      const task = tasks.find((item) => item.taskId === taskId);
      if (!task) {
        continue;
      }
      if (task.status !== "completed" && task.status !== "failed") {
        continue;
      }
      task.coordinatorInjectedAt = injectedAt;
      task.injectionPending = false;
      task.injectionAppliedAt = injectedAt;
      task.lastInjectionError = undefined;
      task.updatedAt = injectedAt;
    }
  });

  const markTaskInjectionApplied = mock(async (taskIds: string[]) => {
    await markCoordinatorResultsInjected(taskIds);
  });

  const markTaskInjectionFailed = mock(async (taskIds: string[], errorMessage: string) => {
    const failedAt = "2026-04-13T11:05:00.000Z";
    for (const taskId of taskIds) {
      const task = tasks.find((item) => item.taskId === taskId);
      if (!task) {
        continue;
      }
      if (task.status !== "completed" && task.status !== "failed") {
        continue;
      }
      task.injectionPending = true;
      task.lastInjectionError = errorMessage;
      task.updatedAt = failedAt;
    }
  });

  const listPendingTaskNotices = mock(async () => {
    return tasks.filter((task) => task.noticePending === true).map((task) => cloneTask(task));
  });

  const markTaskNoticeDelivered = mock(async (taskId: string, deliveryAccountId: string) => {
    const task = tasks.find((item) => item.taskId === taskId);
    if (!task) {
      throw new Error(`task "${taskId}" does not exist`);
    }
    task.noticePending = false;
    task.noticeSentAt = "2026-04-13T11:00:00.000Z";
    task.deliveryAccountId = deliveryAccountId;
    task.lastNoticeError = undefined;
    task.updatedAt = "2026-04-13T11:00:00.000Z";
    return cloneTask(task);
  });

  const markTaskNoticeFailed = mock(async ({ taskId, errorMessage }: { taskId: string; errorMessage: string }) => {
    const task = tasks.find((item) => item.taskId === taskId);
    if (!task) {
      throw new Error(`task "${taskId}" does not exist`);
    }
    task.noticePending = true;
    task.lastNoticeError = errorMessage;
    task.updatedAt = "2026-04-13T11:00:00.000Z";
    return cloneTask(task);
  });

  const cleanTasks = mock(async (coordinatorSession: string) => {
    let removedTasks = 0;
    const remaining: typeof tasks = [];
    for (const task of tasks) {
      if (
        task.coordinatorSession === coordinatorSession &&
        (task.status === "completed" || task.status === "failed" || task.status === "cancelled")
      ) {
        removedTasks += 1;
      } else {
        remaining.push(task);
      }
    }
    tasks.length = 0;
    tasks.push(...remaining);
    return { removedTasks, removedBindings: 0 };
  });

  const listSessionBlockingTasks = mock(async (transportSession: string) => {
    return tasks
      .filter(
        (task) =>
          task.status !== "completed" &&
          task.status !== "failed" &&
          task.status !== "cancelled" &&
          (task.coordinatorSession === transportSession || task.workerSession === transportSession),
      )
      .map((task) => cloneTask(task));
  });

  const purgeSessionReferences = mock(async (transportSession: string) => {
    let removedTasks = 0;
    const remaining: typeof tasks = [];
    for (const task of tasks) {
      const terminal =
        task.status === "completed" || task.status === "failed" || task.status === "cancelled";
      const references =
        task.coordinatorSession === transportSession || task.workerSession === transportSession;
      if (terminal && references) {
        removedTasks += 1;
      } else {
        remaining.push(task);
      }
    }
    tasks.length = 0;
    tasks.push(...remaining);
    return { removedTasks, removedBindings: 0 };
  });

  const cancelGroup = mock(async ({ groupId, coordinatorSession }: { groupId: string; coordinatorSession: string }) => {
    const group = groups.find(
      (item) => item.groupId === groupId && item.coordinatorSession === coordinatorSession,
    );
    if (!group) {
      throw new Error(`group "${groupId}" does not exist`);
    }

    const cancelledTaskIds: string[] = [];
    const skippedTaskIds: string[] = [];
    for (const task of tasks.filter((item) => item.groupId === groupId)) {
      if (task.status === "completed" || task.status === "failed" || task.status === "cancelled") {
        skippedTaskIds.push(task.taskId);
        continue;
      }

      await requestTaskCancellation({
        taskId: task.taskId,
        coordinatorSession,
      });
      cancelledTaskIds.push(task.taskId);
    }

    return {
      summary: buildGroupSummary(group, tasks.filter((task) => task.groupId === groupId)),
      cancelledTaskIds,
      skippedTaskIds,
    };
  });

  return {
    createGroup,
    getGroupSummary,
    listGroupSummaries,
    cancelGroup,
    requestDelegate,
    listTasks,
    getTask,
    requestTaskCancellation,
    cancelTask,
    approveTask,
    cleanTasks,
    listSessionBlockingTasks,
    purgeSessionReferences,
    listPendingTaskNotices,
    markTaskNoticeDelivered,
    markTaskNoticeFailed,
    listPendingCoordinatorGroups,
    markCoordinatorGroupsInjected,
    markCoordinatorGroupsInjectionFailed,
    listPendingCoordinatorResults,
    listPendingCoordinatorBlockers,
    listContestedCoordinatorResults,
    recordCoordinatorRouteContext,
    claimActiveHumanReply,
    getActiveHumanQuestionPackage,
    markCoordinatorResultsInjected,
    markTaskInjectionApplied,
    markTaskInjectionFailed,
  } satisfies OrchestrationRouterOps & {
    createGroup: ReturnType<typeof mock>;
    getGroupSummary: ReturnType<typeof mock>;
    listGroupSummaries: ReturnType<typeof mock>;
    cancelGroup: ReturnType<typeof mock>;
    requestDelegate: ReturnType<typeof mock>;
    listTasks: ReturnType<typeof mock>;
    getTask: ReturnType<typeof mock>;
    requestTaskCancellation: ReturnType<typeof mock>;
    cancelTask: ReturnType<typeof mock>;
    approveTask: ReturnType<typeof mock>;
    cleanTasks: ReturnType<typeof mock>;
    listSessionBlockingTasks: ReturnType<typeof mock>;
    purgeSessionReferences: ReturnType<typeof mock>;
    listPendingTaskNotices: ReturnType<typeof mock>;
    markTaskNoticeDelivered: ReturnType<typeof mock>;
    markTaskNoticeFailed: ReturnType<typeof mock>;
    listPendingCoordinatorGroups: ReturnType<typeof mock>;
    markCoordinatorGroupsInjected: ReturnType<typeof mock>;
    markCoordinatorGroupsInjectionFailed: ReturnType<typeof mock>;
    listPendingCoordinatorResults: ReturnType<typeof mock>;
    listPendingCoordinatorBlockers: ReturnType<typeof mock>;
    listContestedCoordinatorResults: ReturnType<typeof mock>;
    recordCoordinatorRouteContext: ReturnType<typeof mock>;
    claimActiveHumanReply: ReturnType<typeof mock>;
    getActiveHumanQuestionPackage: ReturnType<typeof mock>;
    markCoordinatorResultsInjected: ReturnType<typeof mock>;
    markTaskInjectionApplied: ReturnType<typeof mock>;
    markTaskInjectionFailed: ReturnType<typeof mock>;
  };
}

export function getCreateGroupMock(orchestration: ReturnType<typeof createOrchestrationService>) {
  return orchestration.createGroup as ReturnType<typeof mock>;
}

export function getGetGroupMock(orchestration: ReturnType<typeof createOrchestrationService>) {
  return orchestration.getGroupSummary as ReturnType<typeof mock>;
}

export function getListGroupsMock(orchestration: ReturnType<typeof createOrchestrationService>) {
  return orchestration.listGroupSummaries as ReturnType<typeof mock>;
}

export function getGetGroupSummaryMock(orchestration: ReturnType<typeof createOrchestrationService>) {
  return orchestration.getGroupSummary as ReturnType<typeof mock>;
}

export function getListGroupSummariesMock(orchestration: ReturnType<typeof createOrchestrationService>) {
  return orchestration.listGroupSummaries as ReturnType<typeof mock>;
}

export function getCancelGroupMock(orchestration: ReturnType<typeof createOrchestrationService>) {
  return orchestration.cancelGroup as ReturnType<typeof mock>;
}

export function getPromptMock(transport: SessionTransport) {
  return transport.prompt as ReturnType<typeof mock>;
}

export function getCancelMock(transport: SessionTransport) {
  return transport.cancel as ReturnType<typeof mock>;
}

export function getSetModeMock(transport: SessionTransport) {
  return transport.setMode as ReturnType<typeof mock>;
}

export function getUpdatePermissionPolicyMock(transport: SessionTransport) {
  return transport.updatePermissionPolicy as ReturnType<typeof mock>;
}

export function getRemoveSessionMock(transport: SessionTransport) {
  return transport.removeSession as ReturnType<typeof mock>;
}

export function getDeleteSessionMock(transport: SessionTransport) {
  return transport.deleteSession as ReturnType<typeof mock>;
}

export function getRequestDelegateMock(orchestration: ReturnType<typeof createOrchestrationService>) {
  return orchestration.requestDelegate as ReturnType<typeof mock>;
}

export function getListTasksMock(orchestration: ReturnType<typeof createOrchestrationService>) {
  return orchestration.listTasks as ReturnType<typeof mock>;
}

export function getGetTaskMock(orchestration: ReturnType<typeof createOrchestrationService>) {
  return orchestration.getTask as ReturnType<typeof mock>;
}

export function getCancelTaskMock(orchestration: ReturnType<typeof createOrchestrationService>) {
  return orchestration.requestTaskCancellation as ReturnType<typeof mock>;
}

export function getDirectCancelTaskMock(orchestration: ReturnType<typeof createOrchestrationService>) {
  return orchestration.cancelTask as ReturnType<typeof mock>;
}

export function getApproveTaskMock(orchestration: ReturnType<typeof createOrchestrationService>) {
  return orchestration.approveTask as ReturnType<typeof mock>;
}

export function getListPendingCoordinatorResultsMock(orchestration: ReturnType<typeof createOrchestrationService>) {
  return orchestration.listPendingCoordinatorResults as ReturnType<typeof mock>;
}

export function getListPendingCoordinatorBlockersMock(orchestration: ReturnType<typeof createOrchestrationService>) {
  return orchestration.listPendingCoordinatorBlockers as ReturnType<typeof mock>;
}

export function getListContestedCoordinatorResultsMock(orchestration: ReturnType<typeof createOrchestrationService>) {
  return orchestration.listContestedCoordinatorResults as ReturnType<typeof mock>;
}

export function getRecordCoordinatorRouteContextMock(orchestration: ReturnType<typeof createOrchestrationService>) {
  return orchestration.recordCoordinatorRouteContext as ReturnType<typeof mock>;
}

export function getClaimActiveHumanReplyMock(orchestration: ReturnType<typeof createOrchestrationService>) {
  return orchestration.claimActiveHumanReply as ReturnType<typeof mock>;
}

export function getActiveHumanQuestionPackageMock(orchestration: ReturnType<typeof createOrchestrationService>) {
  return orchestration.getActiveHumanQuestionPackage as ReturnType<typeof mock>;
}


export function getListPendingCoordinatorGroupsMock(orchestration: ReturnType<typeof createOrchestrationService>) {
  return orchestration.listPendingCoordinatorGroups as ReturnType<typeof mock>;
}

export function getMarkCoordinatorGroupsInjectedMock(orchestration: ReturnType<typeof createOrchestrationService>) {
  return orchestration.markCoordinatorGroupsInjected as ReturnType<typeof mock>;
}

export function getMarkCoordinatorResultsInjectedMock(orchestration: ReturnType<typeof createOrchestrationService>) {
  return orchestration.markCoordinatorResultsInjected as ReturnType<typeof mock>;
}

export function getMarkTaskInjectionAppliedMock(orchestration: ReturnType<typeof createOrchestrationService>) {
  return orchestration.markTaskInjectionApplied as ReturnType<typeof mock>;
}

export function getMarkTaskInjectionFailedMock(orchestration: ReturnType<typeof createOrchestrationService>) {
  return orchestration.markTaskInjectionFailed as ReturnType<typeof mock>;
}

export function basename(path: string): string {
  return path.split(/[\/]/).at(-1)!;
}

export function createLogger(events: string[]): AppLogger {
  return {
    debug: async (event, _message, context) => {
      events.push(`DEBUG ${event} ${JSON.stringify(context ?? {})}`);
    },
    info: async (event, _message, context) => {
      events.push(`INFO ${event} ${JSON.stringify(context ?? {})}`);
    },
    error: async (event, _message, context) => {
      events.push(`ERROR ${event} ${JSON.stringify(context ?? {})}`);
    },
    cleanup: async () => {},
    flush: async () => {},
  };
}

export { createEmptyState, SessionService };
