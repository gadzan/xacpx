import { expect, test } from "bun:test";

import { normalize } from "node:path";

import { createConfig } from "../commands/command-router-test-support";
import { clampWatchTimeout, OrchestrationService, type OrchestrationServiceDeps } from "../../../src/orchestration/orchestration-service";
import { AsyncMutex } from "../../../src/orchestration/async-mutex";
import {
  DEFAULT_TASK_WATCH_TIMEOUT_MS,
  MAX_TASK_WATCH_TIMEOUT_MS,
} from "../../../src/orchestration/task-watch-timeouts";
import { createEmptyState, type AppState } from "../../../src/state/types";
import type { AppConfig } from "../../../src/config/types";
import { QuotaDeferredError } from "../../../src/weixin/messaging/quota-errors";

function cloneState(state: AppState): AppState {
  return JSON.parse(JSON.stringify(state)) as AppState;
}

function createDeferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

class InterleavingMutex extends AsyncMutex {
  private readonly inner = new AsyncMutex();
  afterRun?: (result: unknown) => Promise<void>;

  override async run<T>(critical: () => Promise<T>): Promise<T> {
    const result = await this.inner.run(critical);
    await this.afterRun?.(result);
    return result;
  }
}

function makeDeps(
  overrides?: Partial<OrchestrationServiceDeps> & {
    reusableWorkerSession?: string | null;
    initialState?: AppState;
    config?: AppConfig;
    closeWorkerSession?: NonNullable<OrchestrationServiceDeps["closeWorkerSession"]>;
  },
) {
  let state = cloneState(overrides?.initialState ?? createEmptyState());
  const config = overrides?.config ?? createConfig();
  const savedStates: AppState[] = [];
  const ensureCalls: Array<Parameters<OrchestrationServiceDeps["ensureWorkerSession"]>[0]> = [];
  const dispatchCalls: Array<Parameters<OrchestrationServiceDeps["dispatchWorkerTask"]>[0]> = [];
  const closeCalls: Array<Parameters<NonNullable<OrchestrationServiceDeps["closeWorkerSession"]>>[0]> = [];
  const lookupCalls: Array<
    NonNullable<OrchestrationServiceDeps["findReusableWorkerSession"]> extends (
      request: infer Request,
    ) => unknown
      ? Request
      : never
  > = [];
  const wakeCoordinatorCalls: Array<
    NonNullable<OrchestrationServiceDeps["wakeCoordinatorSession"]> extends (
      request: infer Request,
    ) => unknown
      ? Request
      : never
  > = [];
  const resumeCalls: Array<
    NonNullable<OrchestrationServiceDeps["resumeWorkerTask"]> extends (
      request: infer Request,
    ) => unknown
      ? Request
      : never
  > = [];
  const deliverCoordinatorCalls: Array<
    NonNullable<OrchestrationServiceDeps["deliverCoordinatorMessage"]> extends (
      request: infer Request,
    ) => unknown
      ? Request
      : never
  > = [];
  const interruptCalls: Array<
    NonNullable<OrchestrationServiceDeps["interruptWorkerTask"]> extends (
      request: infer Request,
    ) => unknown
      ? Request
      : never
  > = [];

  // Pull `closeWorkerSession` out of overrides so the recording wrapper below is
  // not clobbered by the `...overrides` spread; the wrapper still delegates to it.
  const closeWorkerSessionOverride = overrides?.closeWorkerSession;
  const { closeWorkerSession: _ignoredCloseOverride, ...spreadOverrides } = overrides ?? {};

  const deps: OrchestrationServiceDeps = {
    now: () => new Date("2026-04-13T10:00:00.000Z"),
    createId: () => "task-1",
    loadState: async () => cloneState(state),
    saveState: async (nextState) => {
      state = cloneState(nextState);
      savedStates.push(cloneState(nextState));
    },
    config,
    resolveWorkerBindingEngine: () => "cli",
    ensureWorkerSession: async (request) => {
      ensureCalls.push(request);
      return request.workerSession;
    },
    dispatchWorkerTask: async (request) => {
      dispatchCalls.push(request);
    },
    closeWorkerSession: async (request) => {
      closeCalls.push(request);
      if (closeWorkerSessionOverride) {
        return closeWorkerSessionOverride(request);
      }
    },
    findReusableWorkerSession: async (request) => {
      lookupCalls.push(request);
      return overrides?.reusableWorkerSession ?? null;
    },
    wakeCoordinatorSession: async (request) => {
      wakeCoordinatorCalls.push(request);
    },
    resumeWorkerTask: async (request) => {
      resumeCalls.push(request);
    },
    deliverCoordinatorMessage: async (request) => {
      deliverCoordinatorCalls.push(request);
    },
    interruptWorkerTask: async (request) => {
      interruptCalls.push(request);
    },
    ...spreadOverrides,
  };

  return {
    deps,
    getState: () => cloneState(state),
    savedStates,
    ensureCalls,
    dispatchCalls,
    closeCalls,
    lookupCalls,
    wakeCoordinatorCalls,
    resumeCalls,
    deliverCoordinatorCalls,
    interruptCalls,
  };
}

function makeBlockedTask(taskId: string, questionId: string) {
  return {
    taskId,
    sourceHandle: "wx:user-1",
    sourceKind: "human" as const,
    coordinatorSession: "backend:main",
    workerSession: "worker:claude:1",
    workspace: "backend",
    targetAgent: "claude",
    task: `task ${taskId}`,
    status: "blocked" as const,
    summary: "",
    resultText: "",
    createdAt: "2026-04-13T10:00:00.000Z",
    updatedAt: "2026-04-13T10:00:00.000Z",
    openQuestion: {
      questionId,
      question: `question ${taskId}`,
      whyBlocked: `blocked ${taskId}`,
      whatIsNeeded: `needed ${taskId}`,
      askedAt: "2026-04-13T10:00:00.000Z",
      status: "open" as const,
    },
  };
}

function makeCompletedTask(taskId: string) {
  return {
    taskId,
    sourceHandle: "wx:user-1",
    sourceKind: "human" as const,
    coordinatorSession: "backend:main",
    workerSession: "worker:claude:1",
    workspace: "backend",
    targetAgent: "claude",
    task: `task ${taskId}`,
    status: "completed" as const,
    summary: "done",
    resultText: `result ${taskId}`,
    createdAt: "2026-04-13T10:00:00.000Z",
    updatedAt: "2026-04-13T10:05:00.000Z",
    injectionPending: true,
  };
}

test("creates a running task and reuses an injected worker session", async () => {
  const harness = makeDeps({
    createId: () => "task-1",
    reusableWorkerSession: "backend:claude:shared-worker",
  });
  const service = new OrchestrationService(harness.deps);

  const result = await service.requestDelegate({
    sourceHandle: "wx:user-1",
    sourceKind: "human",
    coordinatorSession: "backend:main",
    workspace: "backend",
    targetAgent: "claude",
    role: "reviewer",
    task: "review the design notes",
  });

  expect(result).toEqual({
    taskId: "task-1",
    status: "running",
    workerSession: "backend:claude:shared-worker",
  });
  expect(harness.lookupCalls).toEqual([
    {
      sourceHandle: "wx:user-1",
      sourceKind: "human",
      coordinatorSession: "backend:main",
      workspace: "backend",
      targetAgent: "claude",
      role: "reviewer",
    },
  ]);
  expect(harness.ensureCalls).toEqual([
    {
      workerSession: "backend:claude:shared-worker",
      sourceHandle: "wx:user-1",
      sourceKind: "human",
      coordinatorSession: "backend:main",
      workspace: "backend",
      targetAgent: "claude",
      role: "reviewer",
    },
  ]);
  expect(harness.dispatchCalls).toEqual([
    {
      taskId: "task-1",
      workerSession: "backend:claude:shared-worker",
      coordinatorSession: "backend:main",
      workspace: "backend",
      targetAgent: "claude",
      role: "reviewer",
      task: "review the design notes",
    },
  ]);

  // Two durable writes: the binding shell (LID + engine) lands before
  // ensure can start the first owner; the task lands after.
  expect(harness.savedStates).toHaveLength(2);
  expect(harness.getState().orchestration.tasks["task-1"]).toMatchObject({
    taskId: "task-1",
    sourceHandle: "wx:user-1",
    sourceKind: "human",
    coordinatorSession: "backend:main",
    workerSession: "backend:claude:shared-worker",
    workspace: "backend",
    targetAgent: "claude",
    role: "reviewer",
    task: "review the design notes",
    status: "running",
    summary: "",
    resultText: "",
    createdAt: "2026-04-13T10:00:00.000Z",
    updatedAt: "2026-04-13T10:00:00.000Z",
    eventSeq: 1,
    events: [{ seq: 1, at: "2026-04-13T10:00:00.000Z", type: "created", status: "running", message: "Task created" }],
  });
  expect(harness.getState().orchestration.workerBindings["backend:claude:shared-worker"]).toEqual({
    sourceHandle: "backend:claude:shared-worker",
    coordinatorSession: "backend:main",
    workspace: "backend",
    targetAgent: "claude",
    role: "reviewer",
    guardAcpOutput: true,
    logicalSessionId: "task-1",
    transportEngine: "cli",
  });
});
test("reusing a legacy worker binding does not silently switch it to the guarded rollout", async () => {
  const legacyWorkerSession = "backend:claude:shared-worker";
  const initialState = createEmptyState();
  initialState.orchestration.workerBindings[legacyWorkerSession] = {
    sourceHandle: legacyWorkerSession,
    coordinatorSession: "backend:main",
    workspace: "backend",
    targetAgent: "claude",
  };
  const harness = makeDeps({
    createId: () => "task-legacy-worker-1",
    reusableWorkerSession: legacyWorkerSession,
    initialState,
  });
  const service = new OrchestrationService(harness.deps);

  await service.requestDelegate({
    sourceHandle: "wx:user-1",
    sourceKind: "human",
    coordinatorSession: "backend:main",
    workspace: "backend",
    targetAgent: "claude",
    task: "continue the existing worker",
  });

  expect(harness.getState().orchestration.workerBindings[legacyWorkerSession]).not.toHaveProperty("guardAcpOutput");
});

test("stores chat reply context on human delegate tasks", async () => {
  const harness = makeDeps({
    createId: () => "task-chat-1",
    reusableWorkerSession: "backend:claude:shared-worker",
  });
  const service = new OrchestrationService(harness.deps);

  await service.requestDelegate({
    sourceHandle: "backend:main",
    sourceKind: "coordinator",
    coordinatorSession: "backend:main",
    workspace: "backend",
    targetAgent: "claude",
    task: "reply ok",
    chatKey: "wx:user",
    replyContextToken: "ctx-123",
    accountId: "acc-1",
  });

  expect(harness.getState().orchestration.tasks["task-chat-1"]).toMatchObject({
    chatKey: "wx:user",
    replyContextToken: "ctx-123",
    accountId: "acc-1",
  });
});

test("creates a group for the current coordinator", async () => {
  const harness = makeDeps({
    createId: () => "group-review",
  });
  const service = new OrchestrationService(harness.deps);

  const group = await service.createGroup({
    coordinatorSession: "backend:main",
    title: "review",
  });

  expect(group).toMatchObject({
    groupId: "group-review",
    coordinatorSession: "backend:main",
    title: "review",
  });
  expect(harness.getState().orchestration.groups["group-review"]).toMatchObject({
    groupId: "group-review",
    coordinatorSession: "backend:main",
    title: "review",
  });
});

test("computes aggregate group status counts from member tasks", async () => {
  const harness = makeDeps({
    initialState: {
      ...createEmptyState(),
      orchestration: {
        tasks: {
          "task-1": {
            taskId: "task-1",
            sourceHandle: "backend:main",
            sourceKind: "coordinator",
            coordinatorSession: "backend:main",
            workspace: "backend",
            targetAgent: "claude",
            task: "review api",
            groupId: "group-review",
            status: "running",
            summary: "",
            resultText: "",
            createdAt: "2026-04-13T10:00:00.000Z",
            updatedAt: "2026-04-13T10:01:00.000Z",
          },
          "task-2": {
            taskId: "task-2",
            sourceHandle: "backend:main",
            sourceKind: "coordinator",
            coordinatorSession: "backend:main",
            workspace: "backend",
            targetAgent: "codex",
            task: "implement fix",
            groupId: "group-review",
            status: "completed",
            summary: "done",
            resultText: "ok",
            createdAt: "2026-04-13T10:00:00.000Z",
            updatedAt: "2026-04-13T10:02:00.000Z",
          },
          "task-3": {
            taskId: "task-3",
            sourceHandle: "backend:main",
            sourceKind: "coordinator",
            coordinatorSession: "backend:main",
            workspace: "backend",
            targetAgent: "claude",
            task: "double check",
            groupId: "group-review",
            status: "failed",
            summary: "boom",
            resultText: "",
            createdAt: "2026-04-13T10:00:00.000Z",
            updatedAt: "2026-04-13T10:03:00.000Z",
          },
        },
        workerBindings: {},
        groups: {
          "group-review": {
            groupId: "group-review",
            coordinatorSession: "backend:main",
            title: "review",
            createdAt: "2026-04-13T10:00:00.000Z",
            updatedAt: "2026-04-13T10:03:00.000Z",
          },
        },
      },
    },
  });
  const service = new OrchestrationService(harness.deps);

  const summary = await service.getGroupSummary({
    groupId: "group-review",
    coordinatorSession: "backend:main",
  });

  expect(summary).not.toBeNull();
  expect(summary).toMatchObject({
    totalTasks: 3,
    runningTasks: 1,
    completedTasks: 1,
    failedTasks: 1,
    cancelledTasks: 0,
    pendingApprovalTasks: 0,
    terminal: false,
  });
});

test("treats a group as terminal only when all member tasks are terminal", async () => {
  const harness = makeDeps({
    initialState: {
      ...createEmptyState(),
      orchestration: {
        tasks: {
          "task-1": {
            taskId: "task-1",
            sourceHandle: "backend:main",
            sourceKind: "coordinator",
            coordinatorSession: "backend:main",
            workspace: "backend",
            targetAgent: "claude",
            task: "review api",
            groupId: "group-review",
            status: "completed",
            summary: "done",
            resultText: "ok",
            createdAt: "2026-04-13T10:00:00.000Z",
            updatedAt: "2026-04-13T10:01:00.000Z",
          },
          "task-2": {
            taskId: "task-2",
            sourceHandle: "backend:main",
            sourceKind: "coordinator",
            coordinatorSession: "backend:main",
            workspace: "backend",
            targetAgent: "codex",
            task: "implement fix",
            groupId: "group-review",
            status: "cancelled",
            summary: "",
            resultText: "",
            createdAt: "2026-04-13T10:00:00.000Z",
            updatedAt: "2026-04-13T10:02:00.000Z",
          },
        },
        workerBindings: {},
        groups: {
          "group-review": {
            groupId: "group-review",
            coordinatorSession: "backend:main",
            title: "review",
            createdAt: "2026-04-13T10:00:00.000Z",
            updatedAt: "2026-04-13T10:02:00.000Z",
          },
        },
      },
    },
  });
  const service = new OrchestrationService(harness.deps);

  const summary = await service.getGroupSummary({
    groupId: "group-review",
    coordinatorSession: "backend:main",
  });

  expect(summary?.terminal).toBe(true);
});

test("treats a group with a contested member result as non-terminal and non-injectable", async () => {
  const harness = makeDeps({
    initialState: {
      ...createEmptyState(),
      orchestration: {
        ...createEmptyState().orchestration,
        tasks: {
          "task-1": {
            ...makeCompletedTask("task-1"),
            groupId: "group-review",
          },
          "task-2": {
            ...makeCompletedTask("task-2"),
            groupId: "group-review",
            reviewPending: {
              reviewId: "review-1",
              reason: "misrouted_answer",
              createdAt: "2026-04-13T10:03:00.000Z",
              resultId: "result-1",
              resultText: "wrong answer",
            },
          },
        },
        groups: {
          "group-review": {
            groupId: "group-review",
            coordinatorSession: "backend:main",
            title: "review",
            createdAt: "2026-04-13T10:00:00.000Z",
            updatedAt: "2026-04-13T10:05:00.000Z",
          },
        },
      },
    },
  });
  const service = new OrchestrationService(harness.deps);

  const summary = await service.getGroupSummary({
    groupId: "group-review",
    coordinatorSession: "backend:main",
  });
  const terminalGroups = await service.listGroupSummaries({
    coordinatorSession: "backend:main",
    status: "terminal",
  });
  const pendingGroups = await service.listPendingCoordinatorGroups("backend:main");

  expect(summary?.terminal).toBe(false);
  expect(terminalGroups).toEqual([]);
  expect(pendingGroups).toEqual([]);
});

test("group cancel requests cancellation for every non-terminal task in the group", async () => {
  const harness = makeDeps({
    cancelWorkerTask: async () => await new Promise<void>(() => {}),
    initialState: {
      ...createEmptyState(),
      orchestration: {
        tasks: {
          "task-1": {
            taskId: "task-1",
            sourceHandle: "backend:main",
            sourceKind: "coordinator",
            coordinatorSession: "backend:main",
            workerSession: "worker-1",
            workspace: "backend",
            targetAgent: "claude",
            task: "review api",
            groupId: "group-review",
            status: "running",
            summary: "",
            resultText: "",
            createdAt: "2026-04-13T10:00:00.000Z",
            updatedAt: "2026-04-13T10:01:00.000Z",
          },
          "task-2": {
            taskId: "task-2",
            sourceHandle: "backend:main",
            sourceKind: "coordinator",
            coordinatorSession: "backend:main",
            workspace: "backend",
            targetAgent: "codex",
            task: "implement fix",
            groupId: "group-review",
            status: "needs_confirmation",
            summary: "",
            resultText: "",
            createdAt: "2026-04-13T10:00:00.000Z",
            updatedAt: "2026-04-13T10:02:00.000Z",
          },
          "task-3": {
            taskId: "task-3",
            sourceHandle: "backend:main",
            sourceKind: "coordinator",
            coordinatorSession: "backend:main",
            workspace: "backend",
            targetAgent: "claude",
            task: "done already",
            groupId: "group-review",
            status: "completed",
            summary: "done",
            resultText: "ok",
            createdAt: "2026-04-13T10:00:00.000Z",
            updatedAt: "2026-04-13T10:03:00.000Z",
          },
        },
        workerBindings: {},
        groups: {
          "group-review": {
            groupId: "group-review",
            coordinatorSession: "backend:main",
            title: "review",
            createdAt: "2026-04-13T10:00:00.000Z",
            updatedAt: "2026-04-13T10:03:00.000Z",
          },
        },
      },
    },
  });
  const service = new OrchestrationService(harness.deps);

  const result = await service.cancelGroup({
    groupId: "group-review",
    coordinatorSession: "backend:main",
  });

  expect(result.cancelledTaskIds).toEqual(["task-1", "task-2"]);
  expect(result.skippedTaskIds).toEqual(["task-3"]);
  expect(result.summary.runningTasks).toBe(1);
  expect(result.summary.cancelledTasks).toBe(1);
});

test("attaches a delegated task to an existing group", async () => {
  const harness = makeDeps({
    createId: () => "task-group-1",
    reusableWorkerSession: "backend:claude:backend:main",
    initialState: {
      ...createEmptyState(),
      orchestration: {
        tasks: {},
        workerBindings: {},
        groups: {
          "group-review": {
            groupId: "group-review",
            coordinatorSession: "backend:main",
            title: "review",
            createdAt: "2026-04-13T10:00:00.000Z",
            updatedAt: "2026-04-13T10:00:00.000Z",
          },
        },
      },
    },
  });
  const service = new OrchestrationService(harness.deps);

  await service.requestDelegate({
    sourceHandle: "wx:user-1",
    sourceKind: "human",
    coordinatorSession: "backend:main",
    workspace: "backend",
    targetAgent: "claude",
    task: "review the API",
    groupId: "group-review",
  });

  expect(harness.getState().orchestration.tasks["task-group-1"]).toMatchObject({
    groupId: "group-review",
  });
});

test("attaches an rpc-delegated task to an existing group when groupId is provided", async () => {
  const harness = makeDeps({
    createId: () => "task-rpc-group",
    reusableWorkerSession: "backend:claude:backend:main",
    initialState: {
      ...createEmptyState(),
      sessions: {
        main: {
          alias: "main",
          agent: "codex",
          workspace: "backend",
          transport_session: "backend:main",
          created_at: "2026-04-13T10:00:00.000Z",
          last_used_at: "2026-04-13T10:00:00.000Z",
        },
      },
      orchestration: {
        tasks: {},
        workerBindings: {},
        groups: {
          "group-review": {
            groupId: "group-review",
            coordinatorSession: "backend:main",
            title: "review",
            createdAt: "2026-04-13T10:00:00.000Z",
            updatedAt: "2026-04-13T10:00:00.000Z",
            coordinatorInjectedAt: "2026-04-13T09:59:00.000Z",
          },
        },
      },
    },
  });
  const service = new OrchestrationService(harness.deps);

  await service.requestDelegateFromRpc({
    sourceHandle: "backend:main",
    targetAgent: "claude",
    task: "review the API",
    groupId: "group-review",
  });

  const task = harness.getState().orchestration.tasks["task-rpc-group"];
  expect(task).toMatchObject({
    groupId: "group-review",
    status: "running",
  });
  const group = harness.getState().orchestration.groups!["group-review"]!;
  expect(group.coordinatorInjectedAt).toBeUndefined();
  expect(group.updatedAt).toBe("2026-04-13T10:00:00.000Z");
  for (let attempt = 0; attempt < 20 && harness.dispatchCalls.length === 0; attempt += 1) {
    await Bun.sleep(0);
  }
  expect(harness.dispatchCalls).toHaveLength(1);
});

test("rejects rpc delegation when groupId belongs to a different coordinator", async () => {
  const harness = makeDeps({
    createId: () => "task-rpc-group-reject",
    reusableWorkerSession: "backend:claude:backend:main",
    initialState: {
      ...createEmptyState(),
      sessions: {
        main: {
          alias: "main",
          agent: "codex",
          workspace: "backend",
          transport_session: "backend:main",
          created_at: "2026-04-13T10:00:00.000Z",
          last_used_at: "2026-04-13T10:00:00.000Z",
        },
      },
      orchestration: {
        tasks: {},
        workerBindings: {},
        groups: {
          "group-other": {
            groupId: "group-other",
            coordinatorSession: "backend:other",
            title: "other team",
            createdAt: "2026-04-13T10:00:00.000Z",
            updatedAt: "2026-04-13T10:00:00.000Z",
          },
        },
      },
    },
  });
  const service = new OrchestrationService(harness.deps);

  await expect(
    service.requestDelegateFromRpc({
      sourceHandle: "backend:main",
      targetAgent: "claude",
      task: "review the API",
      groupId: "group-other",
    }),
  ).rejects.toThrow(/belongs to coordinator/);

  expect(harness.getState().orchestration.tasks).toEqual({});
});

test("lists pending coordinator groups whose tasks are all terminal", async () => {
  const harness = makeDeps({
    initialState: {
      ...createEmptyState(),
      orchestration: {
        tasks: {
          "task-group-a-1": {
            taskId: "task-group-a-1",
            sourceHandle: "wx:user-1",
            sourceKind: "human",
            coordinatorSession: "backend:main",
            workspace: "backend",
            targetAgent: "claude",
            task: "review api",
            groupId: "group-a",
            status: "completed",
            summary: "done",
            resultText: "ok",
            createdAt: "2026-04-13T10:00:00.000Z",
            updatedAt: "2026-04-13T10:01:00.000Z",
          },
          "task-group-a-2": {
            taskId: "task-group-a-2",
            sourceHandle: "wx:user-1",
            sourceKind: "human",
            coordinatorSession: "backend:main",
            workspace: "backend",
            targetAgent: "codex",
            task: "implement fix",
            groupId: "group-a",
            status: "failed",
            summary: "fail",
            resultText: "error",
            createdAt: "2026-04-13T10:00:00.000Z",
            updatedAt: "2026-04-13T10:02:00.000Z",
          },
          "task-group-b-1": {
            taskId: "task-group-b-1",
            sourceHandle: "wx:user-2",
            sourceKind: "human",
            coordinatorSession: "backend:main",
            workspace: "backend",
            targetAgent: "claude",
            task: "still running",
            groupId: "group-b",
            status: "running",
            summary: "",
            resultText: "",
            createdAt: "2026-04-13T10:00:00.000Z",
            updatedAt: "2026-04-13T10:03:00.000Z",
          },
        },
        workerBindings: {},
        groups: {
          "group-a": {
            groupId: "group-a",
            coordinatorSession: "backend:main",
            title: "parallel review",
            createdAt: "2026-04-13T10:00:00.000Z",
            updatedAt: "2026-04-13T10:02:00.000Z",
          },
          "group-b": {
            groupId: "group-b",
            coordinatorSession: "backend:main",
            title: "parallel build",
            createdAt: "2026-04-13T10:00:00.000Z",
            updatedAt: "2026-04-13T10:03:00.000Z",
          },
        },
      },
    },
  });
  const service = new OrchestrationService(harness.deps);

  const groups = await service.listPendingCoordinatorGroups("backend:main");

  expect(groups.map((group) => group.groupId)).toEqual(["group-a"]);
});

test("marks coordinator groups injected and persists the timestamp", async () => {
  const harness = makeDeps({
    now: () => new Date("2026-04-13T11:00:00.000Z"),
    initialState: {
      ...createEmptyState(),
      orchestration: {
        tasks: {
          "task-group-a-1": {
            ...makeCompletedTask("task-group-a-1"),
            groupId: "group-a",
          },
          "task-group-a-2": {
            ...makeCompletedTask("task-group-a-2"),
            groupId: "group-a",
            status: "failed",
          },
        },
        workerBindings: {},
        groups: {
          "group-a": {
            groupId: "group-a",
            coordinatorSession: "backend:main",
            title: "parallel review",
            createdAt: "2026-04-13T10:00:00.000Z",
            updatedAt: "2026-04-13T10:02:00.000Z",
          },
          "group-b": {
            groupId: "group-b",
            coordinatorSession: "backend:main",
            title: "already injected",
            createdAt: "2026-04-13T10:00:00.000Z",
            updatedAt: "2026-04-13T10:03:00.000Z",
            coordinatorInjectedAt: "2026-04-13T10:10:00.000Z",
          },
        },
      },
    },
  });
  const service = new OrchestrationService(harness.deps);

  await service.markCoordinatorGroupsInjected(["group-b", "group-a", "group-missing"]);

  expect(harness.getState().orchestration.groups["group-a"]).toMatchObject({
    coordinatorInjectedAt: "2026-04-13T11:00:00.000Z",
    injectionPending: false,
    injectionAppliedAt: "2026-04-13T11:00:00.000Z",
    updatedAt: "2026-04-13T11:00:00.000Z",
  });
  expect(harness.getState().orchestration.groups["group-b"]).toMatchObject({
    coordinatorInjectedAt: "2026-04-13T10:10:00.000Z",
  });
});

test("markCoordinatorGroupsInjected skips groups that are no longer injectable", async () => {
  const harness = makeDeps({
    now: () => new Date("2026-04-13T11:05:00.000Z"),
    initialState: {
      ...createEmptyState(),
      orchestration: {
        ...createEmptyState().orchestration,
        tasks: {
          "task-group-ready": {
            ...makeCompletedTask("task-group-ready"),
            groupId: "group-a",
          },
          "task-group-contested": {
            ...makeCompletedTask("task-group-contested"),
            groupId: "group-a",
            reviewPending: {
              reviewId: "review-1",
              reason: "misrouted_answer",
              createdAt: "2026-04-13T10:03:00.000Z",
              resultId: "result-1",
              resultText: "wrong answer",
            },
          },
        },
        groups: {
          "group-a": {
            groupId: "group-a",
            coordinatorSession: "backend:main",
            title: "parallel review",
            createdAt: "2026-04-13T10:00:00.000Z",
            updatedAt: "2026-04-13T10:02:00.000Z",
            injectionPending: true,
          },
        },
      },
    },
  });
  const service = new OrchestrationService(harness.deps);

  await service.markCoordinatorGroupsInjected(["group-a"]);

  expect(harness.getState().orchestration.groups["group-a"]).not.toHaveProperty("coordinatorInjectedAt");
  expect(harness.getState().orchestration.groups["group-a"]).toMatchObject({
    injectionPending: true,
  });
});

test("markCoordinatorGroupsInjected also stamps grouped member tasks so late contesting is rejected", async () => {
  const harness = makeDeps({
    now: () => new Date("2026-04-13T11:10:00.000Z"),
    initialState: {
      ...createEmptyState(),
      orchestration: {
        ...createEmptyState().orchestration,
        tasks: {
          "task-group-a-1": {
            ...makeCompletedTask("task-group-a-1"),
            groupId: "group-a",
            openQuestion: {
              questionId: "question-group-a-1",
              question: "Should I keep SQLite?",
              whyBlocked: "Need the database decision",
              whatIsNeeded: "A confirmed database choice",
              askedAt: "2026-04-13T10:00:00.000Z",
              status: "answered",
              answeredAt: "2026-04-13T10:02:00.000Z",
              answerSource: "coordinator",
              answerText: "Keep SQLite",
            },
          },
        },
        groups: {
          "group-a": {
            groupId: "group-a",
            coordinatorSession: "backend:main",
            title: "parallel review",
            createdAt: "2026-04-13T10:00:00.000Z",
            updatedAt: "2026-04-13T10:02:00.000Z",
          },
        },
      },
    },
  });
  const service = new OrchestrationService(harness.deps);

  await service.markCoordinatorGroupsInjected(["group-a"]);

  expect(harness.getState().orchestration.tasks["task-group-a-1"]).toMatchObject({
    coordinatorInjectedAt: "2026-04-13T11:10:00.000Z",
    injectionAppliedAt: "2026-04-13T11:10:00.000Z",
    injectionPending: false,
  });
  await expect(
    service.coordinatorRetractAnswer({
      coordinatorSession: "backend:main",
      taskId: "task-group-a-1",
      questionId: "question-group-a-1",
    }),
  ).rejects.toThrow('task "task-group-a-1" is completed, not running or contestable');
});

test("creates a deterministic worker session when no reusable worker exists", async () => {
  const harness = makeDeps({
    createId: () => "task-2",
    findReusableWorkerSession: async () => null,
  });
  const service = new OrchestrationService(harness.deps);

  const result = await service.requestDelegate({
    sourceHandle: "wx:user-2",
    sourceKind: "human",
    coordinatorSession: "backend:main",
    workspace: "backend",
    targetAgent: "codex",
    task: "implement the API",
  });

  expect(result.workerSession).toBe("backend:codex:backend:main");
  expect(harness.ensureCalls).toEqual([
    {
      workerSession: "backend:codex:backend:main",
      sourceHandle: "wx:user-2",
      sourceKind: "human",
      coordinatorSession: "backend:main",
      workspace: "backend",
      targetAgent: "codex",
      role: undefined,
    },
  ]);
  expect(harness.dispatchCalls).toEqual([
    {
      taskId: "task-2",
      workerSession: "backend:codex:backend:main",
      coordinatorSession: "backend:main",
      workspace: "backend",
      targetAgent: "codex",
      task: "implement the API",
    },
  ]);
  expect(harness.getState().orchestration.tasks["task-2"]).toMatchObject({
    workerSession: "backend:codex:backend:main",
    status: "running",
    task: "implement the API",
  });
});

test("auto-runs and dispatches coordinator-originated rpc delegations", async () => {
  const harness = makeDeps({
    createId: () => "task-rpc-1",
    reusableWorkerSession: "backend:claude:reviewer:backend:main",
    initialState: {
      ...createEmptyState(),
      sessions: {
        main: {
          alias: "main",
          agent: "codex",
          workspace: "backend",
          transport_session: "backend:main",
          created_at: "2026-04-13T10:00:00.000Z",
          last_used_at: "2026-04-13T10:00:00.000Z",
        },
      },
    },
  });
  const service = new OrchestrationService(harness.deps);

  const result = await service.requestDelegateFromRpc({
    sourceHandle: "backend:main",
    targetAgent: "claude",
    task: "review the design",
    role: "reviewer",
  });

  expect(result).toEqual({
    taskId: "task-rpc-1",
    status: "running",
    workerSession: "backend:claude:reviewer:backend:main",
  });
  expect(harness.ensureCalls).toHaveLength(1);
  for (let attempt = 0; attempt < 20 && harness.dispatchCalls.length === 0; attempt += 1) {
    await Bun.sleep(0);
  }
  expect(harness.dispatchCalls).toHaveLength(1);
  const rpcTask = harness.getState().orchestration.tasks["task-rpc-1"];
  expect(rpcTask).toMatchObject({
    taskId: "task-rpc-1",
    sourceHandle: "backend:main",
    sourceKind: "coordinator",
    coordinatorSession: "backend:main",
    workerSession: "backend:claude:reviewer:backend:main",
    workspace: "backend",
    targetAgent: "claude",
    role: "reviewer",
    task: "review the design",
    status: "running",
    summary: "",
    resultText: "",
    createdAt: "2026-04-13T10:00:00.000Z",
    updatedAt: "2026-04-13T10:00:00.000Z",
  });
  expect(rpcTask.chatKey).toBeUndefined();
  expect(rpcTask.replyContextToken).toBeUndefined();
  expect(rpcTask.accountId).toBeUndefined();
  expect(harness.getState().orchestration.workerBindings["backend:claude:reviewer:backend:main"]).toEqual({
    sourceHandle: "backend:claude:reviewer:backend:main",
    coordinatorSession: "backend:main",
    workspace: "backend",
    targetAgent: "claude",
    role: "reviewer",
    guardAcpOutput: true,
  });
});


test("coordinator-originated rpc delegation returns before slow worker ensure finishes", async () => {
  const ensureDeferred = createDeferred<string>();
  const harness = makeDeps({
    createId: () => "task-rpc-fast-return",
    ensureWorkerSession: async (request) => {
      harness.ensureCalls.push(request);
      return await ensureDeferred.promise;
    },
    initialState: {
      ...createEmptyState(),
      sessions: {
        main: {
          alias: "main",
          agent: "codex",
          workspace: "backend",
          transport_session: "backend:main",
          created_at: "2026-04-13T10:00:00.000Z",
          last_used_at: "2026-04-13T10:00:00.000Z",
        },
      },
    },
  });
  const service = new OrchestrationService(harness.deps);

  const delegatePromise = service.requestDelegateFromRpc({
    sourceHandle: "backend:main",
    targetAgent: "claude",
    task: "review the design",
  });

  while (harness.ensureCalls.length === 0) {
    await Bun.sleep(0);
  }

  try {
    await expect(
      Promise.race([
        delegatePromise,
        Bun.sleep(20).then(() => "blocked-before-ensure-finished" as const),
      ]),
    ).resolves.toEqual({
      taskId: "task-rpc-fast-return",
      status: "running",
      workerSession: "backend:claude:backend:main",
    });
    expect(harness.dispatchCalls).toEqual([]);
    expect(harness.getState().orchestration.tasks["task-rpc-fast-return"]).toMatchObject({
      status: "running",
      workerSession: "backend:claude:backend:main",
    });
  } finally {
    ensureDeferred.resolve("backend:claude:backend:main");
    await delegatePromise.catch(() => undefined);
  }

  for (let attempt = 0; attempt < 20 && harness.dispatchCalls.length === 0; attempt += 1) {
    await Bun.sleep(0);
  }
  expect(harness.dispatchCalls).toHaveLength(1);
});


test("coordinator-originated rpc worker ensure failure marks the returned task failed", async () => {
  const ensureDeferred = createDeferred<string>();
  const harness = makeDeps({
    createId: () => "task-rpc-ensure-fail",
    ensureWorkerSession: async (request) => {
      harness.ensureCalls.push(request);
      return await ensureDeferred.promise;
    },
    initialState: {
      ...createEmptyState(),
      sessions: {
        main: {
          alias: "main",
          agent: "codex",
          workspace: "backend",
          transport_session: "backend:main",
          created_at: "2026-04-13T10:00:00.000Z",
          last_used_at: "2026-04-13T10:00:00.000Z",
        },
      },
    },
  });
  const service = new OrchestrationService(harness.deps);

  const result = await service.requestDelegateFromRpc({
    sourceHandle: "backend:main",
    targetAgent: "claude",
    task: "review the design",
  });

  expect(result).toEqual({
    taskId: "task-rpc-ensure-fail",
    status: "running",
    workerSession: "backend:claude:backend:main",
  });
  expect(harness.getState().orchestration.tasks["task-rpc-ensure-fail"]).toMatchObject({
    status: "running",
  });

  ensureDeferred.reject(new Error("worker cold start failed"));
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const task = harness.getState().orchestration.tasks["task-rpc-ensure-fail"];
    if (task?.status === "failed") {
      break;
    }
    await Bun.sleep(0);
  }

  expect(harness.dispatchCalls).toEqual([]);
  expect(harness.getState().orchestration.tasks["task-rpc-ensure-fail"]).toMatchObject({
    status: "failed",
    summary: "worker cold start failed",
    resultText: "",
  });
  expect(harness.getState().orchestration.workerBindings["backend:claude:backend:main"]).toBeUndefined();
});


test("stale rpc startup failure does not clobber a newer binding for the same worker session", async () => {
  const ensureDeferred = createDeferred<string>();
  let ensureCalls = 0;
  const harness = makeDeps({
    createId: () => ensureCalls === 0 ? "task-stale-startup" : "task-new-owner",
    reusableWorkerSession: "backend:claude:shared",
    ensureWorkerSession: async (request) => {
      harness.ensureCalls.push(request);
      ensureCalls += 1;
      if (ensureCalls === 1) {
        return await ensureDeferred.promise;
      }
      return request.workerSession;
    },
    initialState: {
      ...createEmptyState(),
      sessions: {
        main: {
          alias: "main",
          agent: "codex",
          workspace: "backend",
          transport_session: "backend:main",
          created_at: "2026-04-13T10:00:00.000Z",
          last_used_at: "2026-04-13T10:00:00.000Z",
        },
      },
    },
  });
  const service = new OrchestrationService(harness.deps);

  const first = await service.requestDelegateFromRpc({
    sourceHandle: "backend:main",
    targetAgent: "claude",
    task: "first",
  });
  expect(first.workerSession).toBe("backend:claude:shared");
  for (let attempt = 0; attempt < 20 && harness.ensureCalls.length === 0; attempt += 1) {
    await Bun.sleep(0);
  }
  expect(harness.ensureCalls).toHaveLength(1);

  await service.completeTaskCancellation(first.taskId);

  const second = await service.requestDelegateFromRpc({
    sourceHandle: "backend:main",
    targetAgent: "claude",
    task: "second",
  });
  expect(second.workerSession).toBe("backend:claude:shared");

  const savesBeforeStaleStartupFailure = harness.savedStates.length;
  ensureDeferred.reject(new Error("stale startup failed"));
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (harness.savedStates.length > savesBeforeStaleStartupFailure) {
      break;
    }
    await Bun.sleep(0);
  }

  expect(harness.savedStates.length).toBeGreaterThan(savesBeforeStaleStartupFailure);
  expect(harness.getState().orchestration.workerBindings["backend:claude:shared"]).toMatchObject({
    sourceHandle: "backend:claude:shared",
    coordinatorSession: "backend:main",
    workspace: "backend",
    targetAgent: "claude",
  });
  expect(harness.getState().orchestration.tasks[second.taskId]).toMatchObject({
    status: "running",
    task: "second",
  });
});

test("coordinator-originated rpc delegation skips dispatch when cancelled during worker startup", async () => {
  const ensureDeferred = createDeferred<string>();
  const harness = makeDeps({
    createId: () => "task-cancel-during-startup",
    ensureWorkerSession: async (request) => {
      harness.ensureCalls.push(request);
      return await ensureDeferred.promise;
    },
    initialState: {
      ...createEmptyState(),
      sessions: {
        main: {
          alias: "main",
          agent: "codex",
          workspace: "backend",
          transport_session: "backend:main",
          created_at: "2026-04-13T10:00:00.000Z",
          last_used_at: "2026-04-13T10:00:00.000Z",
        },
      },
    },
  });
  const service = new OrchestrationService(harness.deps);

  const delegated = await service.requestDelegateFromRpc({
    sourceHandle: "backend:main",
    targetAgent: "claude",
    task: "review",
  });
  await service.cancelTask({
    taskId: delegated.taskId,
    coordinatorSession: "backend:main",
  });

  ensureDeferred.resolve("backend:claude:backend:main");
  for (let attempt = 0; attempt < 20; attempt += 1) {
    await Bun.sleep(0);
  }

  expect(harness.dispatchCalls).toEqual([]);
  expect(harness.getState().orchestration.tasks[delegated.taskId]).toMatchObject({
    status: "cancelled",
    cancelRequestedAt: "2026-04-13T10:00:00.000Z",
    cancelCompletedAt: "2026-04-13T10:00:00.000Z",
  });
  expect(harness.getState().orchestration.workerBindings["backend:claude:backend:main"]).toBeUndefined();
});

test("coordinator-originated rpc delegation completes cancellation after startup when early transport cancel fails", async () => {
  const ensureDeferred = createDeferred<string>();
  const cancelCalls: Array<Parameters<NonNullable<OrchestrationServiceDeps["cancelWorkerTask"]>>[0]> = [];
  const harness = makeDeps({
    createId: () => "task-cancel-after-startup",
    ensureWorkerSession: async (request) => {
      harness.ensureCalls.push(request);
      return await ensureDeferred.promise;
    },
    cancelWorkerTask: async (request) => {
      cancelCalls.push(request);
      throw new Error("worker session not ready");
    },
    initialState: {
      ...createEmptyState(),
      sessions: {
        main: {
          alias: "main",
          agent: "codex",
          workspace: "backend",
          transport_session: "backend:main",
          created_at: "2026-04-13T10:00:00.000Z",
          last_used_at: "2026-04-13T10:00:00.000Z",
        },
      },
    },
  });
  const service = new OrchestrationService(harness.deps);

  const delegated = await service.requestDelegateFromRpc({
    sourceHandle: "backend:main",
    targetAgent: "claude",
    task: "review",
  });
  for (let attempt = 0; attempt < 20 && harness.ensureCalls.length === 0; attempt += 1) {
    await Bun.sleep(0);
  }

  await service.cancelTask({
    taskId: delegated.taskId,
    coordinatorSession: "backend:main",
  });
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const task = harness.getState().orchestration.tasks[delegated.taskId];
    if (task?.lastCancelError === "worker session not ready") {
      break;
    }
    await Bun.sleep(0);
  }
  expect(cancelCalls).toHaveLength(1);
  expect(harness.getState().orchestration.tasks[delegated.taskId]).toMatchObject({
    status: "running",
    cancelRequestedAt: "2026-04-13T10:00:00.000Z",
    lastCancelError: "worker session not ready",
  });

  ensureDeferred.resolve("backend:claude:backend:main");
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const task = harness.getState().orchestration.tasks[delegated.taskId];
    if (task?.status === "cancelled") {
      break;
    }
    await Bun.sleep(0);
  }

  expect(harness.dispatchCalls).toEqual([]);
  expect(harness.getState().orchestration.tasks[delegated.taskId]).toMatchObject({
    status: "cancelled",
    cancelRequestedAt: "2026-04-13T10:00:00.000Z",
    cancelCompletedAt: "2026-04-13T10:00:00.000Z",
  });
  expect(harness.getState().orchestration.tasks[delegated.taskId]!.lastCancelError).toBeUndefined();
  expect(harness.getState().orchestration.workerBindings["backend:claude:backend:main"]).toBeUndefined();
});

test("coordinator-originated rpc delegation completes cancellation when startup fails after early transport cancel fails", async () => {
  const ensureDeferred = createDeferred<string>();
  const harness = makeDeps({
    createId: () => "task-cancel-after-startup-fail",
    ensureWorkerSession: async (request) => {
      harness.ensureCalls.push(request);
      return await ensureDeferred.promise;
    },
    cancelWorkerTask: async () => {
      throw new Error("worker session not ready");
    },
    initialState: {
      ...createEmptyState(),
      sessions: {
        main: {
          alias: "main",
          agent: "codex",
          workspace: "backend",
          transport_session: "backend:main",
          created_at: "2026-04-13T10:00:00.000Z",
          last_used_at: "2026-04-13T10:00:00.000Z",
        },
      },
    },
  });
  const service = new OrchestrationService(harness.deps);

  const delegated = await service.requestDelegateFromRpc({
    sourceHandle: "backend:main",
    targetAgent: "claude",
    task: "review",
  });
  for (let attempt = 0; attempt < 20 && harness.ensureCalls.length === 0; attempt += 1) {
    await Bun.sleep(0);
  }

  await service.cancelTask({
    taskId: delegated.taskId,
    coordinatorSession: "backend:main",
  });
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const task = harness.getState().orchestration.tasks[delegated.taskId];
    if (task?.lastCancelError === "worker session not ready") {
      break;
    }
    await Bun.sleep(0);
  }

  ensureDeferred.reject(new Error("worker cold start failed"));
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const task = harness.getState().orchestration.tasks[delegated.taskId];
    if (task?.status === "cancelled") {
      break;
    }
    await Bun.sleep(0);
  }

  expect(harness.dispatchCalls).toEqual([]);
  expect(harness.getState().orchestration.tasks[delegated.taskId]).toMatchObject({
    status: "cancelled",
    cancelRequestedAt: "2026-04-13T10:00:00.000Z",
    cancelCompletedAt: "2026-04-13T10:00:00.000Z",
  });
  expect(harness.getState().orchestration.tasks[delegated.taskId]!.lastCancelError).toBeUndefined();
  expect(harness.getState().orchestration.workerBindings["backend:claude:backend:main"]).toBeUndefined();
});

test("coordinator-originated rpc startup failure cleans binding after cancellation already completed", async () => {
  const ensureDeferred = createDeferred<string>();
  const harness = makeDeps({
    createId: () => "task-cancelled-before-startup-fail",
    ensureWorkerSession: async (request) => {
      harness.ensureCalls.push(request);
      return await ensureDeferred.promise;
    },
    initialState: {
      ...createEmptyState(),
      sessions: {
        main: {
          alias: "main",
          agent: "codex",
          workspace: "backend",
          transport_session: "backend:main",
          created_at: "2026-04-13T10:00:00.000Z",
          last_used_at: "2026-04-13T10:00:00.000Z",
        },
      },
    },
  });
  const service = new OrchestrationService(harness.deps);

  const delegated = await service.requestDelegateFromRpc({
    sourceHandle: "backend:main",
    targetAgent: "claude",
    task: "review",
  });
  for (let attempt = 0; attempt < 20 && harness.ensureCalls.length === 0; attempt += 1) {
    await Bun.sleep(0);
  }

  await service.cancelTask({
    taskId: delegated.taskId,
    coordinatorSession: "backend:main",
  });
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const task = harness.getState().orchestration.tasks[delegated.taskId];
    if (task?.status === "cancelled") {
      break;
    }
    await Bun.sleep(0);
  }

  expect(harness.getState().orchestration.tasks[delegated.taskId]).toMatchObject({
    status: "cancelled",
    cancelRequestedAt: "2026-04-13T10:00:00.000Z",
    cancelCompletedAt: "2026-04-13T10:00:00.000Z",
  });

  ensureDeferred.reject(new Error("worker cold start failed"));
  for (let attempt = 0; attempt < 20; attempt += 1) {
    await Bun.sleep(0);
  }

  expect(harness.dispatchCalls).toEqual([]);
  expect(harness.getState().orchestration.tasks[delegated.taskId]).toMatchObject({
    status: "cancelled",
    cancelCompletedAt: "2026-04-13T10:00:00.000Z",
  });
  expect(harness.getState().orchestration.workerBindings["backend:claude:backend:main"]).toBeUndefined();
});

test("coordinator-originated rpc cancellation during startup restores a previous worker binding", async () => {
  const ensureDeferred = createDeferred<string>();
  const harness = makeDeps({
    createId: () => "task-cancel-restore-binding",
    reusableWorkerSession: "backend:claude:shared",
    ensureWorkerSession: async (request) => {
      harness.ensureCalls.push(request);
      return await ensureDeferred.promise;
    },
    initialState: {
      ...createEmptyState(),
      sessions: {
        main: {
          alias: "main",
          agent: "codex",
          workspace: "backend",
          transport_session: "backend:main",
          created_at: "2026-04-13T10:00:00.000Z",
          last_used_at: "2026-04-13T10:00:00.000Z",
        },
      },
      orchestration: {
        tasks: {},
        workerBindings: {
          "backend:claude:shared": {
            sourceHandle: "backend:claude:shared",
            coordinatorSession: "backend:main",
            workspace: "backend",
            targetAgent: "claude",
            role: "previous",
          },
        },
      },
    },
  });
  const service = new OrchestrationService(harness.deps);

  const delegated = await service.requestDelegateFromRpc({
    sourceHandle: "backend:main",
    targetAgent: "claude",
    task: "review",
  });
  await service.cancelTask({
    taskId: delegated.taskId,
    coordinatorSession: "backend:main",
  });

  ensureDeferred.resolve("backend:claude:shared");
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const task = harness.getState().orchestration.tasks[delegated.taskId];
    const binding = harness.getState().orchestration.workerBindings["backend:claude:shared"];
    if (task?.status === "cancelled" && binding?.role === "previous") {
      break;
    }
    await Bun.sleep(0);
  }

  expect(harness.dispatchCalls).toEqual([]);
  expect(harness.getState().orchestration.workerBindings["backend:claude:shared"]).toEqual({
    sourceHandle: "backend:claude:shared",
    coordinatorSession: "backend:main",
    workspace: "backend",
    targetAgent: "claude",
    role: "previous",
  });
});

test("coordinator-originated rpc delegation rechecks cancellation immediately before dispatch", async () => {
  const interleavingMutex = new InterleavingMutex();
  let service!: OrchestrationService;
  let injectedCancel = false;
  const harness = makeDeps({
    createId: () => "task-cancel-before-dispatch",
    stateMutex: interleavingMutex,
    initialState: {
      ...createEmptyState(),
      sessions: {
        main: {
          alias: "main",
          agent: "codex",
          workspace: "backend",
          transport_session: "backend:main",
          created_at: "2026-04-13T10:00:00.000Z",
          last_used_at: "2026-04-13T10:00:00.000Z",
        },
      },
    },
  });
  service = new OrchestrationService(harness.deps);
  interleavingMutex.afterRun = async (result) => {
    if (result === "dispatch" && !injectedCancel) {
      injectedCancel = true;
      await service.cancelTask({
        taskId: "task-cancel-before-dispatch",
        coordinatorSession: "backend:main",
      });
    }
  };

  await service.requestDelegateFromRpc({
    sourceHandle: "backend:main",
    targetAgent: "claude",
    task: "review",
  });
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const task = harness.getState().orchestration.tasks["task-cancel-before-dispatch"];
    if (task?.status === "cancelled") {
      break;
    }
    await Bun.sleep(0);
  }

  expect(injectedCancel).toBe(true);
  expect(harness.dispatchCalls).toEqual([]);
  expect(harness.getState().orchestration.tasks["task-cancel-before-dispatch"]).toMatchObject({
    status: "cancelled",
    cancelRequestedAt: "2026-04-13T10:00:00.000Z",
    cancelCompletedAt: "2026-04-13T10:00:00.000Z",
  });
  expect(harness.getState().orchestration.workerBindings["backend:claude:backend:main"]).toBeUndefined();
});

test("approves worker-chained rpc tasks against the worker target captured at request time", async () => {
  let reusableWorkerSession = "backend:codex:worker-a";
  const harness = makeDeps({
    createId: () => "task-rpc-immutable",
    findReusableWorkerSession: async () => reusableWorkerSession,
    initialState: {
      ...createEmptyState(),
      orchestration: {
        tasks: {},
        workerBindings: {
          "backend:claude:backend:main": {
            sourceHandle: "backend:claude:backend:main",
            coordinatorSession: "backend:main",
            workspace: "backend",
            targetAgent: "claude",
          },
        },
      },
    },
    config: {
      ...createConfig(),
      orchestration: {
        maxPendingAgentRequestsPerCoordinator: 3,
        allowWorkerChainedRequests: true,
        allowedAgentRequestTargets: [],
        allowedAgentRequestRoles: [],
      },
    },
  });
  const service = new OrchestrationService(harness.deps);

  await service.requestDelegateFromRpc({
    sourceHandle: "backend:claude:backend:main",
    targetAgent: "codex",
    task: "review the design",
  });

  reusableWorkerSession = "backend:codex:worker-b";

  const approved = await service.approveTask({
    taskId: "task-rpc-immutable",
    coordinatorSession: "backend:main",
  });

  expect(harness.getState().orchestration.tasks["task-rpc-immutable"]).toMatchObject({
    workerSession: "backend:codex:worker-a",
  });
  expect(harness.ensureCalls.at(-1)).toMatchObject({
    workerSession: "backend:codex:worker-a",
  });
  expect(harness.dispatchCalls.at(-1)).toMatchObject({
    workerSession: "backend:codex:worker-a",
  });
  expect(approved.workerSession).toBe("backend:codex:worker-a");
});

test("resolves rpc source context from an existing worker binding", async () => {
  let nextId = 0;
  const harness = makeDeps({
    createId: () => (nextId++ === 0 ? "task-manual-1" : "task-rpc-2"),
    reusableWorkerSession: null,
    initialState: {
      ...createEmptyState(),
      sessions: {
        main: {
          alias: "main",
          agent: "codex",
          workspace: "backend",
          transport_session: "backend:main",
          created_at: "2026-04-13T10:00:00.000Z",
          last_used_at: "2026-04-13T10:00:00.000Z",
        },
      },
    },
    config: {
      ...createConfig(),
      orchestration: {
        maxPendingAgentRequestsPerCoordinator: 3,
        allowWorkerChainedRequests: true,
        allowedAgentRequestTargets: [],
        allowedAgentRequestRoles: [],
      },
    },
  });
  const service = new OrchestrationService(harness.deps);

  await service.requestDelegate({
    sourceHandle: "wx:user-5",
    sourceKind: "human",
    coordinatorSession: "backend:main",
    workspace: "backend",
    targetAgent: "claude",
    task: "create a worker binding",
  });

  const result = await service.requestDelegateFromRpc({
    sourceHandle: "backend:claude:backend:main",
    targetAgent: "codex",
    task: "delegate a follow-up",
  });

  expect(result).toEqual({
    taskId: "task-rpc-2",
    status: "needs_confirmation",
  });
  expect(harness.ensureCalls).toHaveLength(1);
  expect(harness.dispatchCalls).toHaveLength(1);
  expect(harness.getState().orchestration.tasks["task-rpc-2"]).toMatchObject({
    sourceHandle: "backend:claude:backend:main",
    sourceKind: "worker",
    coordinatorSession: "backend:main",
    workspace: "backend",
    targetAgent: "codex",
    task: "delegate a follow-up",
    status: "needs_confirmation",
  });
});

test("rejects worker-originated rpc requests when chained requests are disabled", async () => {
  const harness = makeDeps({
    initialState: {
      ...createEmptyState(),
      orchestration: {
        tasks: {},
        workerBindings: {
          "backend:claude:backend:main": {
            sourceHandle: "backend:claude:backend:main",
            coordinatorSession: "backend:main",
            workspace: "backend",
            targetAgent: "claude",
            role: "reviewer",
          },
        },
      },
    },
    config: {
      ...createConfig(),
      orchestration: {
        maxPendingAgentRequestsPerCoordinator: 3,
        allowWorkerChainedRequests: false,
        allowedAgentRequestTargets: [],
        allowedAgentRequestRoles: [],
      },
    },
  });
  const service = new OrchestrationService(harness.deps);

  await expect(
    service.requestDelegateFromRpc({
      sourceHandle: "backend:claude:backend:main",
      targetAgent: "codex",
      task: "review this",
    }),
  ).rejects.toThrow("worker-originated delegation is disabled by orchestration policy");

  expect(harness.ensureCalls).toEqual([]);
  expect(harness.dispatchCalls).toEqual([]);
  expect(harness.getState().orchestration.tasks).toEqual({});
});

test("rejects rpc requests that target disallowed agents", async () => {
  const harness = makeDeps({
    initialState: {
      ...createEmptyState(),
      sessions: {
        main: {
          alias: "main",
          agent: "codex",
          workspace: "backend",
          transport_session: "backend:main",
          created_at: "2026-04-13T10:00:00.000Z",
          last_used_at: "2026-04-13T10:00:00.000Z",
        },
      },
    },
    config: {
      ...createConfig(),
      orchestration: {
        maxPendingAgentRequestsPerCoordinator: 3,
        allowWorkerChainedRequests: true,
        allowedAgentRequestTargets: ["claude"],
        allowedAgentRequestRoles: [],
      },
    },
  });
  const service = new OrchestrationService(harness.deps);

  await expect(
    service.requestDelegateFromRpc({
      sourceHandle: "backend:main",
      targetAgent: "codex",
      task: "review this",
    }),
  ).rejects.toThrow('target agent "codex" is not allowed for agent-requested delegation');

  expect(harness.ensureCalls).toEqual([]);
  expect(harness.dispatchCalls).toEqual([]);
  expect(harness.getState().orchestration.tasks).toEqual({});
});

test("rejects rpc requests that use disallowed roles", async () => {
  const harness = makeDeps({
    initialState: {
      ...createEmptyState(),
      sessions: {
        main: {
          alias: "main",
          agent: "codex",
          workspace: "backend",
          transport_session: "backend:main",
          created_at: "2026-04-13T10:00:00.000Z",
          last_used_at: "2026-04-13T10:00:00.000Z",
        },
      },
    },
    config: {
      ...createConfig(),
      orchestration: {
        maxPendingAgentRequestsPerCoordinator: 3,
        allowWorkerChainedRequests: true,
        allowedAgentRequestTargets: ["claude"],
        allowedAgentRequestRoles: ["reviewer"],
      },
    },
  });
  const service = new OrchestrationService(harness.deps);

  await expect(
    service.requestDelegateFromRpc({
      sourceHandle: "backend:main",
      targetAgent: "claude",
      task: "review this",
      role: "planner",
    }),
  ).rejects.toThrow('role "planner" is not allowed for agent-requested delegation');

  expect(harness.ensureCalls).toEqual([]);
  expect(harness.dispatchCalls).toEqual([]);
  expect(harness.getState().orchestration.tasks).toEqual({});
});

test("rejects rpc requests when the coordinator exceeds the pending agent request quota", async () => {
  const harness = makeDeps({
    initialState: {
      ...createEmptyState(),
      sessions: {
        main: {
          alias: "main",
          agent: "codex",
          workspace: "backend",
          transport_session: "backend:main",
          created_at: "2026-04-13T10:00:00.000Z",
          last_used_at: "2026-04-13T10:00:00.000Z",
        },
      },
      orchestration: {
        tasks: {
          "task-1": {
            taskId: "task-1",
            sourceHandle: "backend:claude:worker-1",
            sourceKind: "worker",
            coordinatorSession: "backend:main",
            workerSession: "backend:claude:worker-1",
            workspace: "backend",
            targetAgent: "claude",
            task: "pending task 1",
            status: "needs_confirmation",
            summary: "",
            resultText: "",
            createdAt: "2026-04-13T09:59:00.000Z",
            updatedAt: "2026-04-13T10:00:00.000Z",
          },
          "task-2": {
            taskId: "task-2",
            sourceHandle: "backend:claude:worker-2",
            sourceKind: "worker",
            coordinatorSession: "backend:main",
            workerSession: "backend:claude:worker-2",
            workspace: "backend",
            targetAgent: "claude",
            task: "running task 2",
            status: "running",
            summary: "",
            resultText: "",
            createdAt: "2026-04-13T09:58:00.000Z",
            updatedAt: "2026-04-13T10:00:00.000Z",
          },
          "task-3": {
            taskId: "task-3",
            sourceHandle: "backend:claude:worker-3",
            sourceKind: "worker",
            coordinatorSession: "backend:main",
            workerSession: "backend:claude:worker-3",
            workspace: "backend",
            targetAgent: "claude",
            task: "pending task 3",
            status: "needs_confirmation",
            summary: "",
            resultText: "",
            createdAt: "2026-04-13T09:57:00.000Z",
            updatedAt: "2026-04-13T10:00:00.000Z",
          },
        },
        workerBindings: {},
      },
    },
    config: {
      ...createConfig(),
      orchestration: {
        maxPendingAgentRequestsPerCoordinator: 3,
        allowWorkerChainedRequests: true,
        allowedAgentRequestTargets: [],
        allowedAgentRequestRoles: [],
      },
    },
  });
  const service = new OrchestrationService(harness.deps);

  await expect(
    service.requestDelegateFromRpc({
      sourceHandle: "backend:main",
      targetAgent: "claude",
      task: "one more request",
    }),
  ).rejects.toThrow("agent-requested delegation quota exceeded for this coordinator");

  expect(harness.ensureCalls).toEqual([]);
  expect(harness.dispatchCalls).toEqual([]);
  expect(harness.getState().orchestration.tasks).toHaveProperty("task-1");
  expect(harness.getState().orchestration.tasks).toHaveProperty("task-2");
  expect(harness.getState().orchestration.tasks).toHaveProperty("task-3");
});

test("queued parallel tasks count toward the coordinator pending agent request quota", async () => {
  let idCounter = 0;
  const harness = makeDeps({
    createId: () => `id-${++idCounter}`,
    initialState: {
      ...createEmptyState(),
      sessions: {
        main: {
          alias: "main",
          agent: "codex",
          workspace: "backend",
          transport_session: "backend:main",
          created_at: "2026-04-13T10:00:00.000Z",
          last_used_at: "2026-04-13T10:00:00.000Z",
        },
      },
      orchestration: {
        tasks: {
          // A queued parallel task from a prior coordinator delegation.
          "task-queued": {
            taskId: "task-queued",
            sourceHandle: "backend:main",
            sourceKind: "coordinator",
            coordinatorSession: "backend:main",
            workerSession: "backend:claude:p-queued",
            workspace: "backend",
            targetAgent: "claude",
            task: "queued parallel task",
            status: "queued",
            ephemeralWorkerSession: true,
            summary: "",
            resultText: "",
            createdAt: "2026-04-13T09:59:00.000Z",
            updatedAt: "2026-04-13T10:00:00.000Z",
            eventSeq: 1,
            events: [],
          },
          "task-running": {
            taskId: "task-running",
            sourceHandle: "backend:main",
            sourceKind: "coordinator",
            coordinatorSession: "backend:main",
            workerSession: "backend:claude:p-running",
            workspace: "backend",
            targetAgent: "claude",
            task: "running parallel task",
            status: "running",
            ephemeralWorkerSession: true,
            summary: "",
            resultText: "",
            createdAt: "2026-04-13T09:58:00.000Z",
            updatedAt: "2026-04-13T10:00:00.000Z",
            eventSeq: 1,
            events: [],
          },
        },
        workerBindings: {},
      },
    },
    config: {
      ...createConfig(),
      orchestration: {
        maxPendingAgentRequestsPerCoordinator: 2,
        allowWorkerChainedRequests: true,
        allowedAgentRequestTargets: [],
        allowedAgentRequestRoles: [],
        progressHeartbeatSeconds: 300,
        maxParallelTasksPerAgent: 3,
      },
    },
  });
  const service = new OrchestrationService(harness.deps);

  // Two outstanding tasks (one queued, one running) already hit the cap of 2.
  // The queued task must count — otherwise this further request would be allowed.
  await expect(
    service.requestDelegateFromRpc({
      sourceHandle: "backend:main",
      targetAgent: "claude",
      task: "one more request",
    }),
  ).rejects.toThrow("agent-requested delegation quota exceeded for this coordinator");

  expect(harness.ensureCalls).toEqual([]);
  expect(harness.dispatchCalls).toEqual([]);
  expect(Object.keys(harness.getState().orchestration.tasks).sort()).toEqual([
    "task-queued",
    "task-running",
  ]);
});

test("concurrent worker-originated rpc requests recheck quota before persisting", async () => {
  let nextId = 1;
  let lookupCount = 0;
  const releaseLookups = createDeferred<void>();
  const harness = makeDeps({
    createId: () => `task-rpc-quota-${nextId++}`,
    initialState: {
      ...createEmptyState(),
      orchestration: {
        tasks: {},
        workerBindings: {
          "backend:claude:backend:main": {
            sourceHandle: "backend:claude:backend:main",
            coordinatorSession: "backend:main",
            workspace: "backend",
            targetAgent: "claude",
          },
        },
      },
    },
    config: {
      ...createConfig(),
      orchestration: {
        maxPendingAgentRequestsPerCoordinator: 1,
        allowWorkerChainedRequests: true,
        allowedAgentRequestTargets: [],
        allowedAgentRequestRoles: [],
      },
    },
    findReusableWorkerSession: async () => {
      lookupCount += 1;
      if (lookupCount === 2) {
        releaseLookups.resolve();
      }
      await releaseLookups.promise;
      return null;
    },
  });
  const service = new OrchestrationService(harness.deps);

  const first = service.requestDelegateFromRpc({
    sourceHandle: "backend:claude:backend:main",
    targetAgent: "codex",
    role: "first",
    task: "first follow-up",
  });
  const second = service.requestDelegateFromRpc({
    sourceHandle: "backend:claude:backend:main",
    targetAgent: "codex",
    role: "second",
    task: "second follow-up",
  });

  const results = await Promise.allSettled([first, second]);

  expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
  const rejected = results.find((result) => result.status === "rejected");
  expect(rejected).toBeDefined();
  expect(rejected).toMatchObject({
    status: "rejected",
    reason: expect.objectContaining({
      message: "agent-requested delegation quota exceeded for this coordinator",
    }),
  });
  expect(Object.values(harness.getState().orchestration.tasks)).toHaveLength(1);
  expect(harness.ensureCalls).toEqual([]);
  expect(harness.dispatchCalls).toEqual([]);
});


test("task_watch returns new task events and advances afterSeq", async () => {
  const harness = makeDeps({
    initialState: {
      ...createEmptyState(),
      orchestration: {
        ...createEmptyState().orchestration,
        tasks: {
          "task-1": {
            ...makeCompletedTask("task-1"),
            status: "running",
            summary: "",
            resultText: "",
            eventSeq: 1,
            events: [{ seq: 1, at: "2026-04-13T10:00:00.000Z", type: "created", status: "running", message: "Task created" }],
          },
        },
      },
    },
  });
  const service = new OrchestrationService(harness.deps);

  await service.recordTaskProgress("task-1", "analyzing code");

  await expect(
    service.watchTask({
      coordinatorSession: "backend:main",
      taskId: "task-1",
      afterSeq: 1,
      mode: "next_event",
      timeoutMs: 0,
    }),
  ).resolves.toMatchObject({
    status: "event",
    task: { taskId: "task-1", status: "running" },
    events: [{ seq: 2, type: "progress", summary: "analyzing code" }],
    nextAfterSeq: 2,
  });
});

test("clampWatchTimeout collapses invalid input to an immediate watch", () => {
  expect(clampWatchTimeout(undefined)).toBe(DEFAULT_TASK_WATCH_TIMEOUT_MS);
  // Invalid values must not silently become a 60s long-poll.
  expect(clampWatchTimeout(-1)).toBe(0);
  expect(clampWatchTimeout(Number.NaN)).toBe(0);
  expect(clampWatchTimeout(Number.POSITIVE_INFINITY)).toBe(0);
  expect(clampWatchTimeout(1_500.9)).toBe(1_500);
  expect(clampWatchTimeout(MAX_TASK_WATCH_TIMEOUT_MS + 10_000)).toBe(MAX_TASK_WATCH_TIMEOUT_MS);
});

test("task_watch returns terminal, attention_required, timeout, and not_found states", async () => {
  const terminalHarness = makeDeps({
    initialState: {
      ...createEmptyState(),
      orchestration: {
        ...createEmptyState().orchestration,
        tasks: { "task-1": makeCompletedTask("task-1") },
      },
    },
  });
  await expect(
    new OrchestrationService(terminalHarness.deps).watchTask({
      coordinatorSession: "backend:main",
      taskId: "task-1",
      timeoutMs: 0,
    }),
  ).resolves.toMatchObject({ status: "terminal", task: { taskId: "task-1", status: "completed" } });

  const attentionHarness = makeDeps({
    initialState: {
      ...createEmptyState(),
      orchestration: {
        ...createEmptyState().orchestration,
        tasks: { "task-1": makeBlockedTask("task-1", "question-1") },
      },
    },
  });
  await expect(
    new OrchestrationService(attentionHarness.deps).watchTask({
      coordinatorSession: "backend:main",
      taskId: "task-1",
      timeoutMs: 0,
    }),
  ).resolves.toMatchObject({ status: "attention_required", task: { taskId: "task-1", status: "blocked" } });

  const runningHarness = makeDeps({
    initialState: {
      ...createEmptyState(),
      orchestration: {
        ...createEmptyState().orchestration,
        tasks: { "task-1": { ...makeCompletedTask("task-1"), status: "running", summary: "", resultText: "" } },
      },
    },
  });
  const runningService = new OrchestrationService(runningHarness.deps);
  await expect(
    runningService.watchTask({ coordinatorSession: "backend:main", taskId: "task-1", timeoutMs: 0 }),
  ).resolves.toMatchObject({ status: "timeout", task: { taskId: "task-1", status: "running" } });
  await expect(
    runningService.watchTask({ coordinatorSession: "backend:main", taskId: "missing", timeoutMs: 0 }),
  ).resolves.toEqual({ status: "not_found", task: null, events: [], nextAfterSeq: 0 });
});

test("task_watch flags historyTruncated once the 200-event cap prunes older events", async () => {
  const harness = makeDeps({
    initialState: {
      ...createEmptyState(),
      orchestration: {
        ...createEmptyState().orchestration,
        tasks: {
          "task-1": {
            ...makeCompletedTask("task-1"),
            status: "running",
            summary: "",
            resultText: "",
            eventSeq: 1,
            events: [{ seq: 1, at: "2026-04-13T10:00:00.000Z", type: "created", status: "running", message: "Task created" }],
          },
        },
      },
    },
  });
  const service = new OrchestrationService(harness.deps);

  // 249 progress events + the initial "created" event = 250 events; the
  // appendTaskEvent ring buffer keeps only the last 200 (seq 51..250).
  for (let index = 0; index < 249; index += 1) {
    await service.recordTaskProgress("task-1", `progress ${index}`);
  }

  // A cursor older than the retained window must surface historyTruncated and
  // still hand back every retained event without re-delivering pruned ones.
  const truncated = await service.watchTask({
    coordinatorSession: "backend:main",
    taskId: "task-1",
    afterSeq: 1,
    mode: "next_event",
    timeoutMs: 0,
  });
  expect(truncated.status).toBe("event");
  expect(truncated.historyTruncated).toBe(true);
  expect(truncated.nextAfterSeq).toBe(250);
  expect(truncated.events).toHaveLength(200);
  expect(truncated.events[0]?.seq).toBe(51);
  expect(truncated.events.at(-1)?.seq).toBe(250);

  // A cursor inside the retained window is fully caught up: no truncation flag.
  const withinWindow = await service.watchTask({
    coordinatorSession: "backend:main",
    taskId: "task-1",
    afterSeq: 200,
    mode: "next_event",
    timeoutMs: 0,
  });
  expect(withinWindow.status).toBe("event");
  expect(withinWindow.historyTruncated).toBeUndefined();
  expect(withinWindow.events.map((event) => event.seq)).toEqual(
    Array.from({ length: 50 }, (_, index) => 201 + index),
  );
});

test("registers or refreshes an external coordinator", async () => {
  const harness = makeDeps();
  const service = new OrchestrationService(harness.deps);

  await service.registerExternalCoordinator({
    coordinatorSession: "codex:backend",
    workspace: "backend",
    defaultTargetAgent: "codex",
  });
  await service.registerExternalCoordinator({
    coordinatorSession: "codex:backend",
    workspace: "backend",
    defaultTargetAgent: " ",
  });

  expect(harness.getState().orchestration.externalCoordinators?.["codex:backend"]).toEqual({
    coordinatorSession: "codex:backend",
    workspace: "backend",
    createdAt: "2026-04-13T10:00:00.000Z",
    updatedAt: "2026-04-13T10:00:00.000Z",
    defaultTargetAgent: "codex",
  });
  expect(harness.savedStates).toHaveLength(2);
});

test("rejects rebinding an external coordinator to a different workspace", async () => {
  const harness = makeDeps({
    config: {
      ...createConfig(),
      workspaces: {
        backend: { cwd: "/tmp/backend" },
        frontend: { cwd: "/tmp/frontend" },
      },
    },
  });
  const service = new OrchestrationService(harness.deps);

  await service.registerExternalCoordinator({
    coordinatorSession: "codex:backend",
    workspace: "backend",
  });

  await expect(
    service.registerExternalCoordinator({
      coordinatorSession: "codex:backend",
      workspace: "frontend",
    }),
  ).rejects.toThrow(
    'coordinatorSession "codex:backend" is already bound to workspace "backend"; use a new coordinator session for workspace "frontend"',
  );

  expect(harness.getState().orchestration.externalCoordinators?.["codex:backend"]?.workspace).toBe("backend");
});

test("rejects external coordinator registration for unknown workspaces", async () => {
  const harness = makeDeps();
  const service = new OrchestrationService(harness.deps);

  await expect(
    service.registerExternalCoordinator({ coordinatorSession: "codex:missing", workspace: "missing" }),
  ).rejects.toThrow('workspace "missing" is not configured');

  expect(harness.getState().orchestration.externalCoordinators).toEqual({});
});

test("allows external coordinator registration while an unrelated worker session is starting", async () => {
  const ensureDeferred = createDeferred<string>();
  const ensureCalls: Array<Parameters<OrchestrationServiceDeps["ensureWorkerSession"]>[0]> = [];
  const harness = makeDeps({
    ensureWorkerSession: async (request) => {
      ensureCalls.push(request);
      return await ensureDeferred.promise;
    },
  });
  const service = new OrchestrationService(harness.deps);

  const delegatePromise = service.requestDelegate({
    sourceHandle: "wx:user-1",
    sourceKind: "human",
    coordinatorSession: "backend:main",
    workspace: "backend",
    targetAgent: "codex",
    task: "review",
  });

  while (ensureCalls.length === 0) {
    await Bun.sleep(0);
  }

  await expect(
    service.registerExternalCoordinator({ coordinatorSession: "codex:external", workspace: "backend" }),
  ).resolves.toMatchObject({ coordinatorSession: "codex:external", workspace: "backend" });

  ensureDeferred.resolve("backend:codex:backend:main");
  await delegatePromise;
});

test("rejects concurrent delegation to the same worker session", async () => {
  const ensureDeferred = createDeferred<string>();
  const ensureCalls: Array<Parameters<OrchestrationServiceDeps["ensureWorkerSession"]>[0]> = [];
  const harness = makeDeps({
    reusableWorkerSession: "backend:codex:shared",
    ensureWorkerSession: async (request) => {
      ensureCalls.push(request);
      return await ensureDeferred.promise;
    },
  });
  const service = new OrchestrationService(harness.deps);

  const first = service.requestDelegate({
    sourceHandle: "wx:user-1",
    sourceKind: "human",
    coordinatorSession: "backend:main",
    workspace: "backend",
    targetAgent: "codex",
    task: "first",
  });
  while (ensureCalls.length === 0) {
    await Bun.sleep(0);
  }

  await expect(
    service.requestDelegate({
      sourceHandle: "wx:user-2",
      sourceKind: "human",
      coordinatorSession: "backend:main",
      workspace: "backend",
      targetAgent: "codex",
      task: "second",
    }),
  ).rejects.toThrow('worker session "backend:codex:shared" is already in use');

  ensureDeferred.resolve("backend:codex:shared");
  await first;
  expect(harness.dispatchCalls).toHaveLength(1);
});

test("rejects delegation to a worker session with an active task", async () => {
  const harness = makeDeps({
    reusableWorkerSession: "backend:codex:shared",
    initialState: {
      ...createEmptyState(),
      orchestration: {
        ...createEmptyState().orchestration,
        tasks: {
          "task-active": {
            ...makeCompletedTask("task-active"),
            status: "running",
            resultText: "",
            summary: "",
            workerSession: "backend:codex:shared",
          },
        },
      },
    },
  });
  const service = new OrchestrationService(harness.deps);

  await expect(
    service.requestDelegate({
      sourceHandle: "wx:user-2",
      sourceKind: "human",
      coordinatorSession: "backend:main",
      workspace: "backend",
      targetAgent: "codex",
      task: "second",
    }),
  ).rejects.toThrow('worker session "backend:codex:shared" is already in use');
});

test("rejects registering an external coordinator whose handle collides with a worker binding", async () => {
  const harness = makeDeps({
    initialState: {
      ...createEmptyState(),
      orchestration: {
        ...createEmptyState().orchestration,
        workerBindings: {
          "codex:backend": {
            sourceHandle: "codex:backend",
            coordinatorSession: "backend:main",
            workspace: "backend",
            targetAgent: "codex",
          },
        },
      },
    },
  });
  const service = new OrchestrationService(harness.deps);

  await expect(
    service.registerExternalCoordinator({ coordinatorSession: "codex:backend", workspace: "backend" }),
  ).rejects.toThrow('coordinatorSession "codex:backend" conflicts with an existing worker session');

  expect(harness.getState().orchestration.externalCoordinators).toEqual({});
});

test("rejects registering an external coordinator whose handle is reserved by a non-terminal task worker", async () => {
  const harness = makeDeps({
    initialState: {
      ...createEmptyState(),
      orchestration: {
        ...createEmptyState().orchestration,
        tasks: {
          "task-1": {
            taskId: "task-1",
            sourceHandle: "backend:claude:backend:main",
            sourceKind: "worker",
            coordinatorSession: "backend:main",
            workerSession: "codex:backend",
            workspace: "backend",
            targetAgent: "codex",
            task: "review",
            status: "needs_confirmation",
            summary: "",
            resultText: "",
            createdAt: "2026-04-28T10:00:00.000Z",
            updatedAt: "2026-04-28T10:00:00.000Z",
          },
        },
      },
    },
  });
  const service = new OrchestrationService(harness.deps);

  await expect(
    service.registerExternalCoordinator({ coordinatorSession: "codex:backend", workspace: "backend" }),
  ).rejects.toThrow('coordinatorSession "codex:backend" conflicts with an existing worker session');

  expect(harness.getState().orchestration.externalCoordinators).toEqual({});
});

test("rejects registering an external coordinator whose handle collides with a logical session", async () => {
  const harness = makeDeps({
    initialState: {
      ...createEmptyState(),
      sessions: {
        "chat-1": {
          alias: "main",
          agent: "codex",
          workspace: "backend",
          transport_session: "codex:backend",
          created_at: "2026-04-28T10:00:00.000Z",
          last_used_at: "2026-04-28T10:00:00.000Z",
        },
      },
    },
  });
  const service = new OrchestrationService(harness.deps);

  await expect(
    service.registerExternalCoordinator({ coordinatorSession: "codex:backend", workspace: "backend" }),
  ).rejects.toThrow('coordinatorSession "codex:backend" conflicts with an existing logical session');

  expect(harness.getState().orchestration.externalCoordinators).toEqual({});
});

test("rejects refreshing an external coordinator after a worker binding collision appears", async () => {
  const harness = makeDeps({
    initialState: {
      ...createEmptyState(),
      orchestration: {
        ...createEmptyState().orchestration,
        externalCoordinators: {
          "codex:backend": {
            coordinatorSession: "codex:backend",
            workspace: "backend",
            createdAt: "2026-04-28T10:00:00.000Z",
            updatedAt: "2026-04-28T10:00:00.000Z",
          },
        },
        workerBindings: {
          "codex:backend": {
            sourceHandle: "codex:backend",
            coordinatorSession: "backend:main",
            workspace: "backend",
            targetAgent: "codex",
          },
        },
      },
    },
  });
  const service = new OrchestrationService(harness.deps);

  await expect(
    service.registerExternalCoordinator({ coordinatorSession: "codex:backend", workspace: "backend" }),
  ).rejects.toThrow('coordinatorSession "codex:backend" conflicts with an existing worker session');
});

test("rejects refreshing an external coordinator after a logical session collision appears", async () => {
  const harness = makeDeps({
    initialState: {
      ...createEmptyState(),
      sessions: {
        "chat-1": {
          alias: "main",
          agent: "codex",
          workspace: "backend",
          transport_session: "codex:backend",
          created_at: "2026-04-28T10:00:00.000Z",
          last_used_at: "2026-04-28T10:00:00.000Z",
        },
      },
      orchestration: {
        ...createEmptyState().orchestration,
        externalCoordinators: {
          "codex:backend": {
            coordinatorSession: "codex:backend",
            workspace: "backend",
            createdAt: "2026-04-28T10:00:00.000Z",
            updatedAt: "2026-04-28T10:00:00.000Z",
          },
        },
      },
    },
  });
  const service = new OrchestrationService(harness.deps);

  await expect(
    service.registerExternalCoordinator({ coordinatorSession: "codex:backend", workspace: "backend" }),
  ).rejects.toThrow('coordinatorSession "codex:backend" conflicts with an existing logical session');
});

test("rejects worker bindings that would collide with an external coordinator handle", async () => {
  const harness = makeDeps({
    reusableWorkerSession: "codex:backend",
    initialState: {
      ...createEmptyState(),
      orchestration: {
        ...createEmptyState().orchestration,
        externalCoordinators: {
          "codex:backend": {
            coordinatorSession: "codex:backend",
            workspace: "backend",
            createdAt: "2026-04-28T10:00:00.000Z",
            updatedAt: "2026-04-28T10:00:00.000Z",
          },
        },
      },
    },
  });
  const service = new OrchestrationService(harness.deps);

  await expect(
    service.requestDelegate({
      sourceHandle: "wx:user-1",
      sourceKind: "human",
      coordinatorSession: "backend:main",
      workspace: "backend",
      targetAgent: "claude",
      task: "review",
    }),
  ).rejects.toThrow('worker session "codex:backend" conflicts with an external coordinator');

  expect(harness.ensureCalls).toEqual([]);
  expect(harness.getState().orchestration.workerBindings).toEqual({});
  expect(harness.getState().orchestration.tasks).toEqual({});
});

test("rejects auto-run rpc worker handles that collide with external coordinators before ensuring transport", async () => {
  const harness = makeDeps({
    reusableWorkerSession: "codex:worker",
    initialState: {
      ...createEmptyState(),
      orchestration: {
        ...createEmptyState().orchestration,
        externalCoordinators: {
          "codex:backend": {
            coordinatorSession: "codex:backend",
            workspace: "backend",
            createdAt: "2026-04-28T10:00:00.000Z",
            updatedAt: "2026-04-28T10:00:00.000Z",
          },
          "codex:worker": {
            coordinatorSession: "codex:worker",
            workspace: "backend",
            createdAt: "2026-04-28T10:00:00.000Z",
            updatedAt: "2026-04-28T10:00:00.000Z",
          },
        },
      },
    },
  });
  const service = new OrchestrationService(harness.deps);

  await expect(
    service.requestDelegateFromRpc({
      sourceHandle: "codex:backend",
      targetAgent: "claude",
      task: "review",
    }),
  ).rejects.toThrow('worker session "codex:worker" conflicts with an external coordinator');

  expect(harness.ensureCalls).toEqual([]);
  expect(harness.getState().orchestration.workerBindings).toEqual({});
  expect(harness.getState().orchestration.tasks).toEqual({});
});

test("worker-originated rpc rechecks external coordinator collisions before persisting pending tasks", async () => {
  let state = createEmptyState();
  state.orchestration.workerBindings["backend:claude:backend:main"] = {
    sourceHandle: "backend:claude:backend:main",
    coordinatorSession: "backend:main",
    workspace: "backend",
    targetAgent: "claude",
  };
  let loadCount = 0;
  const savedStates: AppState[] = [];
  const harness = makeDeps({
    createId: () => "task-rpc-race",
    reusableWorkerSession: "codex:backend",
    loadState: async () => {
      loadCount += 1;
      const snapshot = cloneState(state);
      if (loadCount >= 3) {
        snapshot.orchestration.externalCoordinators = {
          "codex:backend": {
            coordinatorSession: "codex:backend",
            workspace: "backend",
            createdAt: "2026-04-28T10:00:00.000Z",
            updatedAt: "2026-04-28T10:00:00.000Z",
          },
        };
      }
      return snapshot;
    },
    saveState: async (nextState) => {
      state = cloneState(nextState);
      savedStates.push(cloneState(nextState));
    },
    config: {
      ...createConfig(),
      orchestration: {
        maxPendingAgentRequestsPerCoordinator: 3,
        allowWorkerChainedRequests: true,
        allowedAgentRequestTargets: [],
        allowedAgentRequestRoles: [],
      },
    },
  });
  const service = new OrchestrationService(harness.deps);

  await expect(
    service.requestDelegateFromRpc({
      sourceHandle: "backend:claude:backend:main",
      targetAgent: "codex",
      task: "review",
    }),
  ).rejects.toThrow('worker session "codex:backend" conflicts with an external coordinator');

  expect(harness.ensureCalls).toEqual([]);
  expect(harness.dispatchCalls).toEqual([]);
  expect(savedStates).toEqual([]);
});

test("worker-originated rpc rejects duplicate pending tasks for the same worker session", async () => {
  let nextId = 1;
  const harness = makeDeps({
    createId: () => `task-rpc-${nextId++}`,
    initialState: {
      ...createEmptyState(),
      orchestration: {
        tasks: {},
        workerBindings: {
          "backend:claude:backend:main": {
            sourceHandle: "backend:claude:backend:main",
            coordinatorSession: "backend:main",
            workspace: "backend",
            targetAgent: "claude",
          },
        },
      },
    },
    config: {
      ...createConfig(),
      orchestration: {
        maxPendingAgentRequestsPerCoordinator: 3,
        allowWorkerChainedRequests: true,
        allowedAgentRequestTargets: [],
        allowedAgentRequestRoles: [],
      },
    },
  });
  const service = new OrchestrationService(harness.deps);

  await expect(
    service.requestDelegateFromRpc({
      sourceHandle: "backend:claude:backend:main",
      targetAgent: "codex",
      task: "first follow-up",
    }),
  ).resolves.toEqual({
    taskId: "task-rpc-1",
    status: "needs_confirmation",
  });

  await expect(
    service.requestDelegateFromRpc({
      sourceHandle: "backend:claude:backend:main",
      targetAgent: "codex",
      task: "second follow-up",
    }),
  ).rejects.toThrow('worker session "backend:codex:backend:main" is already in use');

  expect(Object.keys(harness.getState().orchestration.tasks)).toEqual(["task-rpc-1"]);
  expect(harness.ensureCalls).toEqual([]);
  expect(harness.dispatchCalls).toEqual([]);
});

test("rejects approval worker handles that collide with external coordinators before ensuring transport", async () => {
  const harness = makeDeps({
    reusableWorkerSession: "codex:worker",
    initialState: {
      ...createEmptyState(),
      orchestration: {
        ...createEmptyState().orchestration,
        externalCoordinators: {
          "codex:worker": {
            coordinatorSession: "codex:worker",
            workspace: "backend",
            createdAt: "2026-04-28T10:00:00.000Z",
            updatedAt: "2026-04-28T10:00:00.000Z",
          },
        },
        tasks: {
          "task-1": {
            taskId: "task-1",
            sourceHandle: "worker:requester",
            sourceKind: "worker",
            coordinatorSession: "backend:main",
            workspace: "backend",
            targetAgent: "claude",
            task: "review",
            status: "needs_confirmation",
            summary: "",
            resultText: "",
            createdAt: "2026-04-28T10:00:00.000Z",
            updatedAt: "2026-04-28T10:00:00.000Z",
          },
        },
      },
    },
  });
  const service = new OrchestrationService(harness.deps);

  await expect(
    service.approveTask({ coordinatorSession: "backend:main", taskId: "task-1" }),
  ).rejects.toThrow('worker session "codex:worker" conflicts with an external coordinator');

  expect(harness.ensureCalls).toEqual([]);
  expect(harness.getState().orchestration.tasks["task-1"]).toMatchObject({ status: "needs_confirmation" });
  expect(harness.getState().orchestration.workerBindings).toEqual({});
});

test("auto-runs rpc delegations from pathless external coordinators using explicit cwd", async () => {
  const cwd = normalize("/repo/weacpx");
  const harness = makeDeps({
    createId: () => "task-external-cwd",
    reusableWorkerSession: "weacpx:claude:codex:instance",
  });
  const service = new OrchestrationService(harness.deps);

  await expect(
    service.registerExternalCoordinator({ coordinatorSession: "codex:instance" } as any),
  ).resolves.toMatchObject({ coordinatorSession: "codex:instance" });

  const result = await service.requestDelegateFromRpc({
    sourceHandle: "codex:instance",
    targetAgent: "claude",
    task: "review the design",
    cwd,
  } as any);

  expect(result).toEqual({
    taskId: "task-external-cwd",
    status: "running",
    workerSession: "weacpx:claude:codex:instance",
  });
  expect(harness.lookupCalls[0]).toMatchObject({
    sourceHandle: "codex:instance",
    sourceKind: "coordinator",
    coordinatorSession: "codex:instance",
    targetAgent: "claude",
    cwd,
  });
  expect(harness.ensureCalls[0]).toMatchObject({
    sourceHandle: "codex:instance",
    sourceKind: "coordinator",
    coordinatorSession: "codex:instance",
    targetAgent: "claude",
    cwd,
  });
  while (harness.dispatchCalls.length === 0) {
    await Bun.sleep(0);
  }
  expect(harness.dispatchCalls[0]).toMatchObject({
    taskId: "task-external-cwd",
    workerSession: "weacpx:claude:codex:instance",
    coordinatorSession: "codex:instance",
    targetAgent: "claude",
    cwd,
    task: "review the design",
  });
  expect(harness.getState().orchestration.tasks["task-external-cwd"]).toMatchObject({
    sourceHandle: "codex:instance",
    sourceKind: "coordinator",
    coordinatorSession: "codex:instance",
    workerSession: "weacpx:claude:codex:instance",
    targetAgent: "claude",
    cwd,
    status: "running",
  });
  expect(harness.getState().orchestration.workerBindings["weacpx:claude:codex:instance"]).toMatchObject({
    sourceHandle: "weacpx:claude:codex:instance",
    coordinatorSession: "codex:instance",
    targetAgent: "claude",
    cwd,
  });
});

test("pathless external coordinator cancellation and resume preserve cwd", async () => {
  const cwd = normalize("/repo/weacpx");
  const cancelCalls: Array<Parameters<NonNullable<OrchestrationServiceDeps["cancelWorkerTask"]>>[0]> = [];
  const blockedTask = makeBlockedTask("task-blocked-cwd", "question-cwd");
  const harness = makeDeps({
    cancelWorkerTask: async (request) => {
      cancelCalls.push(request);
    },
    initialState: {
      ...createEmptyState(),
      orchestration: {
        ...createEmptyState().orchestration,
        tasks: {
          "task-running-cwd": {
            taskId: "task-running-cwd",
            sourceHandle: "codex:instance",
            sourceKind: "coordinator",
            coordinatorSession: "codex:instance",
            workerSession: "weacpx:claude:codex:instance",
            workspace: "weacpx",
            cwd,
            targetAgent: "claude",
            task: "review",
            status: "running",
            summary: "",
            resultText: "",
            createdAt: "2026-04-28T10:00:00.000Z",
            updatedAt: "2026-04-28T10:00:00.000Z",
          },
          "task-blocked-cwd": {
            ...blockedTask,
            coordinatorSession: "codex:instance",
            workerSession: "weacpx:claude:codex:instance",
            workspace: "weacpx",
            cwd,
          },
        },
        workerBindings: {
          "weacpx:claude:codex:instance": {
            sourceHandle: "weacpx:claude:codex:instance",
            coordinatorSession: "codex:instance",
            workspace: "weacpx",
            cwd,
            targetAgent: "claude",
          },
        },
      },
    },
  });
  const service = new OrchestrationService(harness.deps);

  await service.requestTaskCancellation({
    taskId: "task-running-cwd",
    coordinatorSession: "codex:instance",
  });
  await service.coordinatorAnswerQuestion({
    coordinatorSession: "codex:instance",
    taskId: "task-blocked-cwd",
    questionId: "question-cwd",
    answer: "Use this repository.",
  });

  expect(cancelCalls).toEqual([
    {
      taskId: "task-running-cwd",
      workerSession: "weacpx:claude:codex:instance",
      workspace: "weacpx",
      cwd,
      targetAgent: "claude",
    },
  ]);
  expect(harness.resumeCalls).toEqual([
    {
      taskId: "task-blocked-cwd",
      workerSession: "weacpx:claude:codex:instance",
      coordinatorSession: "codex:instance",
      workspace: "weacpx",
      cwd,
      targetAgent: "claude",
      answer: "Use this repository.",
    },
  ]);
});

test("rejects pathless external coordinator delegation without explicit cwd", async () => {
  const harness = makeDeps();
  const service = new OrchestrationService(harness.deps);

  await service.registerExternalCoordinator({ coordinatorSession: "codex:instance" } as any);

  await expect(
    service.requestDelegateFromRpc({
      sourceHandle: "codex:instance",
      targetAgent: "claude",
      task: "review the design",
    }),
  ).rejects.toThrow("workingDirectory is required");

  expect(harness.ensureCalls).toEqual([]);
  expect(harness.dispatchCalls).toEqual([]);
  expect(harness.getState().orchestration.tasks).toEqual({});
});

test("registered external coordinator accepts arbitrary explicit cwd over its default workspace cwd", async () => {
  const cwd = normalize("/repo/other-repo");
  const harness = makeDeps({
    createId: () => "task-external-default-plus-cwd",
    reusableWorkerSession: "backend:other-repo:claude:codex:backend",
    initialState: {
      ...createEmptyState(),
      orchestration: {
        ...createEmptyState().orchestration,
        externalCoordinators: {
          "codex:backend": {
            coordinatorSession: "codex:backend",
            workspace: "backend",
            createdAt: "2026-04-28T10:00:00.000Z",
            updatedAt: "2026-04-28T10:00:00.000Z",
          },
        },
      },
    },
  });
  const service = new OrchestrationService(harness.deps);

  const result = await service.requestDelegateFromRpc({
    sourceHandle: "codex:backend",
    targetAgent: "claude",
    task: "review another repo",
    cwd,
  });

  expect(result).toEqual({
    taskId: "task-external-default-plus-cwd",
    status: "running",
    workerSession: "backend:other-repo:claude:codex:backend",
  });
  while (harness.ensureCalls.length === 0) {
    await Bun.sleep(0);
  }
  expect(harness.ensureCalls[0]).toMatchObject({
    workspace: "backend",
    cwd,
  });
  expect(harness.getState().orchestration.tasks["task-external-default-plus-cwd"]).toMatchObject({
    workspace: "backend",
    cwd,
  });
});

test("auto-runs rpc delegations from registered external coordinators using their workspace", async () => {
  const harness = makeDeps({
    createId: () => "task-external-rpc",
    reusableWorkerSession: "backend:claude:reviewer:codex:backend",
    initialState: {
      ...createEmptyState(),
      orchestration: {
        ...createEmptyState().orchestration,
        externalCoordinators: {
          "codex:backend": {
            coordinatorSession: "codex:backend",
            workspace: "backend",
            createdAt: "2026-04-28T10:00:00.000Z",
            updatedAt: "2026-04-28T10:00:00.000Z",
          },
        },
      },
    },
  });
  const service = new OrchestrationService(harness.deps);

  const result = await service.requestDelegateFromRpc({
    sourceHandle: "codex:backend",
    targetAgent: "claude",
    role: "reviewer",
    task: "review the design",
  });

  expect(result).toEqual({
    taskId: "task-external-rpc",
    status: "running",
    workerSession: "backend:claude:reviewer:codex:backend",
  });
  expect(harness.ensureCalls[0]).toMatchObject({
    sourceHandle: "codex:backend",
    sourceKind: "coordinator",
    coordinatorSession: "codex:backend",
    workspace: "backend",
  });
  expect(harness.getState().orchestration.tasks["task-external-rpc"]).toMatchObject({
    sourceHandle: "codex:backend",
    sourceKind: "coordinator",
    coordinatorSession: "codex:backend",
    workspace: "backend",
    status: "running",
  });
});

test("rejects rpc requests from unknown source handles", async () => {
  const harness = makeDeps({
    createId: () => "task-rpc-unknown",
  });
  const service = new OrchestrationService(harness.deps);

  await expect(
    service.requestDelegateFromRpc({
      sourceHandle: "unknown:session",
      targetAgent: "claude",
      task: "review the design",
    }),
  ).rejects.toThrow('sourceHandle "unknown:session" is not a registered coordinator or worker session');

  expect(harness.ensureCalls).toEqual([]);
  expect(harness.dispatchCalls).toEqual([]);
  expect(harness.getState().orchestration.tasks).toEqual({});
});



test("worker questions for external coordinators do not wake coordinator transport", async () => {
  const harness = makeDeps({
    createId: () => "question-1",
    initialState: {
      ...createEmptyState(),
      orchestration: {
        ...createEmptyState().orchestration,
        externalCoordinators: {
          "codex:backend": {
            coordinatorSession: "codex:backend",
            workspace: "backend",
            createdAt: "2026-04-28T10:00:00.000Z",
            updatedAt: "2026-04-28T10:00:00.000Z",
          },
        },
        tasks: {
          "task-1": {
            taskId: "task-1",
            sourceHandle: "codex:backend",
            sourceKind: "coordinator",
            coordinatorSession: "codex:backend",
            workerSession: "backend:claude:codex:backend",
            workspace: "backend",
            targetAgent: "claude",
            task: "review",
            status: "running",
            summary: "",
            resultText: "",
            createdAt: "2026-04-28T10:00:00.000Z",
            updatedAt: "2026-04-28T10:00:00.000Z",
          },
        },
      },
    },
  });
  const service = new OrchestrationService(harness.deps);

  await expect(
    service.workerRaiseQuestion({
      taskId: "task-1",
      sourceHandle: "backend:claude:codex:backend",
      question: "Need details",
      whyBlocked: "missing details",
      whatIsNeeded: "details",
    }),
  ).resolves.toEqual({ taskId: "task-1", questionId: "question-1", status: "blocked" });

  expect(harness.wakeCoordinatorCalls).toEqual([]);
});

test("external coordinators do not wake transport during stale queued question handoff", async () => {
  const externalTask1 = {
    ...makeBlockedTask("task-1", "question-1"),
    sourceHandle: "codex:backend",
    sourceKind: "coordinator" as const,
    coordinatorSession: "codex:backend",
    workerSession: "backend:claude:codex:backend",
    status: "waiting_for_human" as const,
    openQuestion: {
      ...makeBlockedTask("task-1", "question-1").openQuestion,
      packageId: "package-1",
    },
  };
  const externalTask2 = {
    ...makeBlockedTask("task-2", "question-2"),
    sourceHandle: "codex:backend",
    sourceKind: "coordinator" as const,
    coordinatorSession: "codex:backend",
    workerSession: "backend:claude:codex:backend",
  };
  const harness = makeDeps({
    initialState: {
      ...createEmptyState(),
      orchestration: {
        ...createEmptyState().orchestration,
        externalCoordinators: {
          "codex:backend": {
            coordinatorSession: "codex:backend",
            workspace: "backend",
            createdAt: "2026-04-28T10:00:00.000Z",
            updatedAt: "2026-04-28T10:00:00.000Z",
          },
        },
        tasks: {
          "task-1": externalTask1,
          "task-2": externalTask2,
        },
        humanQuestionPackages: {
          "package-1": {
            packageId: "package-1",
            coordinatorSession: "codex:backend",
            status: "active",
            createdAt: "2026-04-28T10:00:00.000Z",
            updatedAt: "2026-04-28T10:00:00.000Z",
            initialTaskIds: ["task-1"],
            openTaskIds: ["task-1"],
            resolvedTaskIds: [],
            awaitingReplyMessageId: "message-1",
            messages: [
              {
                messageId: "message-1",
                kind: "initial",
                promptText: "Please answer task 1.",
                createdAt: "2026-04-28T10:00:00.000Z",
                taskQuestions: [{ taskId: "task-1", questionId: "question-1" }],
              },
            ],
          },
        },
        coordinatorQuestionState: {
          "codex:backend": {
            activePackageId: "package-1",
            queuedQuestions: [
              {
                taskId: "task-2",
                questionId: "question-2",
                enqueuedAt: "2026-04-28T10:01:00.000Z",
              },
            ],
          },
        },
      },
    },
  });
  const service = new OrchestrationService(harness.deps);

  await service.coordinatorAnswerQuestion({
    coordinatorSession: "codex:backend",
    taskId: "task-1",
    questionId: "question-1",
    answer: "Use staging instead",
  });

  expect(harness.wakeCoordinatorCalls).toEqual([]);
  expect(harness.getState().orchestration.coordinatorQuestionState["codex:backend"]).toEqual({
    queuedQuestions: [
      {
        taskId: "task-2",
        questionId: "question-2",
        enqueuedAt: "2026-04-28T10:01:00.000Z",
      },
    ],
  });
});

test("external coordinator worker replies persist results without coordinator injection", async () => {
  const harness = makeDeps({
    initialState: {
      ...createEmptyState(),
      orchestration: {
        ...createEmptyState().orchestration,
        externalCoordinators: {
          "codex:backend": {
            coordinatorSession: "codex:backend",
            workspace: "backend",
            createdAt: "2026-04-28T10:00:00.000Z",
            updatedAt: "2026-04-28T10:00:00.000Z",
          },
        },
        tasks: {
          "task-1": {
            taskId: "task-1",
            sourceHandle: "codex:backend",
            sourceKind: "coordinator",
            coordinatorSession: "codex:backend",
            workerSession: "backend:claude:codex:backend",
            workspace: "backend",
            targetAgent: "claude",
            task: "review",
            status: "running",
            summary: "",
            resultText: "",
            createdAt: "2026-04-28T10:00:00.000Z",
            updatedAt: "2026-04-28T10:00:00.000Z",
          },
        },
      },
    },
  });
  const service = new OrchestrationService(harness.deps);

  const task = await service.recordWorkerReply({
    taskId: "task-1",
    sourceHandle: "backend:claude:codex:backend",
    summary: "done",
    resultText: "external result",
  });

  expect(task).toMatchObject({
    status: "completed",
    summary: "done",
    resultText: "external result",
  });
  expect(task.injectionPending).toBeUndefined();
  expect(task.coordinatorInjectedAt).toBeUndefined();
  await expect(service.getTask("task-1")).resolves.toMatchObject({ resultText: "external result" });
  await expect(
    service.watchTask({ coordinatorSession: "codex:backend", taskId: "task-1", timeoutMs: 0 }),
  ).resolves.toMatchObject({ status: "terminal", task: { resultText: "external result" } });
  expect(harness.wakeCoordinatorCalls).toEqual([]);
});

test("external coordinator results are excluded from pending coordinator injection lists", async () => {
  const harness = makeDeps({
    initialState: {
      ...createEmptyState(),
      orchestration: {
        ...createEmptyState().orchestration,
        externalCoordinators: {
          "codex:backend": {
            coordinatorSession: "codex:backend",
            workspace: "backend",
            createdAt: "2026-04-28T10:00:00.000Z",
            updatedAt: "2026-04-28T10:00:00.000Z",
          },
        },
        groups: {
          "group-1": {
            groupId: "group-1",
            coordinatorSession: "codex:backend",
            title: "external group",
            createdAt: "2026-04-28T10:00:00.000Z",
            updatedAt: "2026-04-28T10:05:00.000Z",
          },
        },
        tasks: {
          "task-standalone": {
            ...makeCompletedTask("task-standalone"),
            sourceHandle: "codex:backend",
            sourceKind: "coordinator",
            coordinatorSession: "codex:backend",
            injectionPending: undefined,
          },
          "task-group": {
            ...makeCompletedTask("task-group"),
            sourceHandle: "codex:backend",
            sourceKind: "coordinator",
            coordinatorSession: "codex:backend",
            groupId: "group-1",
            injectionPending: undefined,
          },
        },
      },
    },
  });
  const service = new OrchestrationService(harness.deps);

  await expect(service.listPendingCoordinatorResults("codex:backend")).resolves.toEqual([]);
  await expect(service.listPendingCoordinatorGroups("codex:backend")).resolves.toEqual([]);
});

test("discarding external coordinator contested results does not wake coordinator transport", async () => {
  const harness = makeDeps({
    createId: () => "replacement-question-1",
    initialState: {
      ...createEmptyState(),
      orchestration: {
        ...createEmptyState().orchestration,
        externalCoordinators: {
          "codex:backend": {
            coordinatorSession: "codex:backend",
            workspace: "backend",
            createdAt: "2026-04-28T10:00:00.000Z",
            updatedAt: "2026-04-28T10:00:00.000Z",
          },
        },
        tasks: {
          "task-1": {
            ...makeCompletedTask("task-1"),
            sourceHandle: "codex:backend",
            sourceKind: "coordinator",
            coordinatorSession: "codex:backend",
            reviewPending: {
              reviewId: "review-1",
              reason: "misrouted_answer",
              createdAt: "2026-04-28T10:10:00.000Z",
              resultId: "result-1",
              resultText: "wrong result",
            },
          },
        },
      },
    },
  });
  const service = new OrchestrationService(harness.deps);

  await service.coordinatorReviewContestedResult({
    coordinatorSession: "codex:backend",
    taskId: "task-1",
    reviewId: "review-1",
    decision: "discard",
  });

  expect(harness.getState().orchestration.tasks["task-1"]).toMatchObject({
    status: "blocked",
    openQuestion: { questionId: "replacement-question-1", status: "open" },
  });
  expect(harness.wakeCoordinatorCalls).toEqual([]);
});

test("external coordinator correction cancellation reopen does not wake coordinator transport", async () => {
  const harness = makeDeps({
    createId: () => "replacement-question-1",
    initialState: {
      ...createEmptyState(),
      orchestration: {
        ...createEmptyState().orchestration,
        externalCoordinators: {
          "codex:backend": {
            coordinatorSession: "codex:backend",
            workspace: "backend",
            createdAt: "2026-04-28T10:00:00.000Z",
            updatedAt: "2026-04-28T10:00:00.000Z",
          },
        },
        tasks: {
          "task-1": {
            taskId: "task-1",
            sourceHandle: "codex:backend",
            sourceKind: "coordinator",
            coordinatorSession: "codex:backend",
            workerSession: "backend:claude:codex:backend",
            workspace: "backend",
            targetAgent: "claude",
            task: "review",
            status: "running",
            summary: "",
            resultText: "",
            createdAt: "2026-04-28T10:00:00.000Z",
            updatedAt: "2026-04-28T10:10:00.000Z",
            correctionPending: {
              requestedAt: "2026-04-28T10:11:00.000Z",
              reason: "misrouted_answer",
            },
            cancelRequestedAt: "2026-04-28T10:11:00.000Z",
          },
        },
      },
    },
  });
  const service = new OrchestrationService(harness.deps);

  await service.completeTaskCancellation("task-1");

  expect(harness.getState().orchestration.tasks["task-1"]).toMatchObject({
    status: "blocked",
    openQuestion: { questionId: "replacement-question-1", status: "open" },
  });
  expect(harness.wakeCoordinatorCalls).toEqual([]);
});

test("human input request for an external coordinator fails with unsupported route", async () => {
  const harness = makeDeps({
    initialState: {
      ...createEmptyState(),
      orchestration: {
        ...createEmptyState().orchestration,
        externalCoordinators: {
          "codex:backend": {
            coordinatorSession: "codex:backend",
            workspace: "backend",
            createdAt: "2026-04-28T10:00:00.000Z",
            updatedAt: "2026-04-28T10:00:00.000Z",
          },
        },
        tasks: {
          "task-1": { ...makeBlockedTask("task-1", "question-1"), coordinatorSession: "codex:backend" },
        },
      },
    },
  });
  const service = new OrchestrationService(harness.deps);

  await expect(
    service.coordinatorRequestHumanInput({
      coordinatorSession: "codex:backend",
      taskQuestions: [{ taskId: "task-1", questionId: "question-1" }],
      promptText: "Need human input",
    }),
  ).rejects.toThrow("human input routing is not configured for external coordinator");
});

test("external coordinator registration cannot race with a worker ensure side effect for the same handle", async () => {
  const ensureStarted = createDeferred<void>();
  const releaseEnsure = createDeferred<void>();
  const harness = makeDeps({
    reusableWorkerSession: "codex:backend",
    ensureWorkerSession: async (request) => {
      harness.ensureCalls.push(request);
      ensureStarted.resolve();
      await releaseEnsure.promise;
      return request.workerSession;
    },
  });
  const service = new OrchestrationService(harness.deps);

  const delegatePromise = service.requestDelegate({
    sourceHandle: "wx:user",
    sourceKind: "human",
    coordinatorSession: "backend:main",
    workspace: "backend",
    targetAgent: "claude",
    task: "review",
  });
  await ensureStarted.promise;

  const registerPromise = service
    .registerExternalCoordinator({
      coordinatorSession: "codex:backend",
      workspace: "backend",
    })
    .then(
      () => undefined,
      (error) => error,
    );
  await Bun.sleep(10);
  releaseEnsure.resolve();

  await expect(delegatePromise).resolves.toMatchObject({
    workerSession: "codex:backend",
  });
  const registerError = await registerPromise;
  expect(registerError).toBeInstanceOf(Error);
  expect((registerError as Error).message).toBe(
    'coordinatorSession "codex:backend" conflicts with an existing worker session',
  );
  expect(harness.getState().orchestration.externalCoordinators).toEqual({});
  expect(harness.getState().orchestration.workerBindings["codex:backend"]).toMatchObject({
    coordinatorSession: "backend:main",
  });
});

test("external coordinator registration is not blocked by an unrelated proposed worker handle", async () => {
  const ensureStarted = createDeferred<void>();
  const releaseEnsure = createDeferred<void>();
  const harness = makeDeps({
    reusableWorkerSession: "codex:proposed",
    ensureWorkerSession: async (request) => {
      harness.ensureCalls.push(request);
      ensureStarted.resolve();
      await releaseEnsure.promise;
      return "codex:actual";
    },
  });
  const service = new OrchestrationService(harness.deps);

  const delegatePromise = service.requestDelegate({
    sourceHandle: "wx:user",
    sourceKind: "human",
    coordinatorSession: "backend:main",
    workspace: "backend",
    targetAgent: "claude",
    task: "review",
  }).then(
    () => undefined,
    (error) => error,
  );
  await ensureStarted.promise;

  const registerPromise = service
    .registerExternalCoordinator({
      coordinatorSession: "codex:actual",
      workspace: "backend",
    })
    .then(
      () => undefined,
      (error) => error,
    );
  await Bun.sleep(10);
  releaseEnsure.resolve();

  await expect(registerPromise).resolves.toBeUndefined();
  const delegateError = await delegatePromise;
  expect(delegateError).toBeInstanceOf(Error);
  expect((delegateError as Error).message).toBe(
    'ensureWorkerSession returned "codex:actual", expected "codex:proposed"',
  );
  expect(harness.getState().orchestration.externalCoordinators?.["codex:actual"]).toMatchObject({
    coordinatorSession: "codex:actual",
    workspace: "backend",
  });
  expect(harness.getState().orchestration.workerBindings).toEqual({});
});

test("records a completed reply and rejects source-handle mismatches", async () => {
  const times = [
    "2026-04-13T10:00:00.000Z",
    "2026-04-13T10:05:00.000Z",
  ];
  let timeIndex = 0;
  const harness = makeDeps({
    now: () => new Date(times[Math.min(timeIndex++, times.length - 1)]),
    createId: () => "task-3",
  });
  const service = new OrchestrationService(harness.deps);

  await service.requestDelegate({
    sourceHandle: "wx:user-3",
    sourceKind: "human",
    coordinatorSession: "backend:main",
    workspace: "backend",
    targetAgent: "claude",
    task: "write the summary",
  });

  await expect(
    service.recordWorkerReply({
      taskId: "task-3",
      sourceHandle: "backend:claude:wrong-worker",
      summary: "done",
      resultText: "summary text",
    }),
  ).rejects.toThrow('task "task-3" belongs to worker "backend:claude:backend:main", not "backend:claude:wrong-worker"');

  const updated = await service.recordWorkerReply({
    taskId: "task-3",
    sourceHandle: "backend:claude:backend:main",
    summary: "done",
    resultText: "summary text",
  });

  expect(updated).toMatchObject({
    taskId: "task-3",
    sourceHandle: "wx:user-3",
    workerSession: "backend:claude:backend:main",
    status: "completed",
    summary: "done",
    resultText: "summary text",
    updatedAt: "2026-04-13T10:05:00.000Z",
  });
  expect(await service.getTask("task-3")).toMatchObject({
    status: "completed",
    summary: "done",
    resultText: "summary text",
  });
});

test("records a completed reply against the assigned worker session", async () => {
  const harness = makeDeps({
    createId: () => "task-3b",
  });
  const service = new OrchestrationService(harness.deps);

  await service.requestDelegate({
    sourceHandle: "wx:user-3",
    sourceKind: "human",
    coordinatorSession: "backend:main",
    workspace: "backend",
    targetAgent: "claude",
    role: "reviewer",
    task: "write the summary",
  });

  const updated = await service.recordWorkerReply({
    taskId: "task-3b",
    sourceHandle: "backend:claude:reviewer:backend:main",
    summary: "done",
    resultText: "summary text",
  });

  expect(updated).toMatchObject({
    taskId: "task-3b",
    sourceHandle: "wx:user-3",
    workerSession: "backend:claude:reviewer:backend:main",
    status: "completed",
    summary: "done",
    resultText: "summary text",
  });
  expect(await service.getTask("task-3b")).toMatchObject({
    status: "completed",
    summary: "done",
    resultText: "summary text",
  });
});

test("rejects worker replies after the task has already reached a terminal state", async () => {
  const harness = makeDeps({
    createId: () => "task-3c",
  });
  const service = new OrchestrationService(harness.deps);

  await service.requestDelegate({
    sourceHandle: "wx:user-3",
    sourceKind: "human",
    coordinatorSession: "backend:main",
    workspace: "backend",
    targetAgent: "claude",
    task: "write the summary",
  });

  await service.cancelTask({
    taskId: "task-3c",
    sourceHandle: "wx:user-3",
  });

  await expect(
    service.recordWorkerReply({
      taskId: "task-3c",
      sourceHandle: "backend:claude:backend:main",
      summary: "too late",
      resultText: "late result",
    }),
  ).rejects.toThrow('task "task-3c" is already cancelled');

  expect(await service.getTask("task-3c")).toMatchObject({
    status: "cancelled",
    summary: "",
    resultText: "",
  });
});

test("rejects worker replies while the task is blocked or waiting_for_human", async () => {
  const harness = makeDeps({
    initialState: {
      ...createEmptyState(),
      orchestration: {
        ...createEmptyState().orchestration,
        tasks: {
          "task-blocked": makeBlockedTask("task-blocked", "question-1"),
          "task-waiting": {
            ...makeBlockedTask("task-waiting", "question-2"),
            status: "waiting_for_human",
            openQuestion: {
              ...makeBlockedTask("task-waiting", "question-2").openQuestion,
              packageId: "package-1",
            },
          },
        },
      },
    },
  });
  const service = new OrchestrationService(harness.deps);

  await expect(
    service.recordWorkerReply({
      taskId: "task-blocked",
      sourceHandle: "worker:claude:1",
      summary: "late",
      resultText: "late result",
    }),
  ).rejects.toThrow('task "task-blocked" is blocked, not running');

  await expect(
    service.recordWorkerReply({
      taskId: "task-waiting",
      sourceHandle: "worker:claude:1",
      summary: "late",
      resultText: "late result",
    }),
  ).rejects.toThrow('task "task-waiting" is waiting_for_human, not running');
});


test("records the delivery account used for completion notices", async () => {
  const harness = makeDeps({
    initialState: {
      ...createEmptyState(),
      orchestration: {
        tasks: {
          "task-1": {
            taskId: "task-1",
            sourceHandle: "backend:main",
            sourceKind: "human",
            coordinatorSession: "backend:main",
            workerSession: "backend:claude:backend:main",
            workspace: "backend",
            targetAgent: "claude",
            task: "reply ok",
            status: "completed",
            summary: "",
            resultText: "ok",
            createdAt: "2026-04-13T10:00:00.000Z",
            updatedAt: "2026-04-13T10:00:00.000Z",
            chatKey: "wx:user",
            replyContextToken: "ctx-123",
            accountId: "acc-origin",
          },
        },
        workerBindings: {},
      },
    },
  });
  const service = new OrchestrationService(harness.deps);

  const updated = await service.recordTaskNoticeDelivery({
    taskId: "task-1",
    deliveryAccountId: "acc-fallback",
  });

  expect(updated.deliveryAccountId).toBe("acc-fallback");
  expect(harness.getState().orchestration.tasks["task-1"]?.deliveryAccountId).toBe("acc-fallback");
});

test("workerRaiseQuestion blocks the task, stores an open question, and wakes the coordinator", async () => {
  const harness = makeDeps({
    createId: () => "question-1",
    initialState: {
      ...createEmptyState(),
      orchestration: {
        ...createEmptyState().orchestration,
        tasks: {
          "task-1": {
            ...makeCompletedTask("task-1"),
            status: "running",
            summary: "",
            resultText: "",
            updatedAt: "2026-04-13T10:01:00.000Z",
          },
        },
        workerBindings: {
          "worker:claude:1": {
            sourceHandle: "worker:claude:1",
            coordinatorSession: "backend:main",
            workspace: "backend",
            targetAgent: "claude",
          },
        },
      },
    },
  });
  const service = new OrchestrationService(harness.deps);

  const result = await service.workerRaiseQuestion({
    taskId: "task-1",
    sourceHandle: "worker:claude:1",
    question: "Need the production token",
    whyBlocked: "Cannot continue without credentials",
    whatIsNeeded: "A valid API token",
  });

  expect(result).toEqual({
    taskId: "task-1",
    questionId: "question-1",
    status: "blocked",
  });
  expect(harness.getState().orchestration.tasks["task-1"]).toMatchObject({
    status: "blocked",
    openQuestion: {
      questionId: "question-1",
      question: "Need the production token",
      whyBlocked: "Cannot continue without credentials",
      whatIsNeeded: "A valid API token",
      status: "open",
    },
  });
  expect(harness.wakeCoordinatorCalls).toEqual([{ coordinatorSession: "backend:main" }]);
});

test("coordinatorAnswerQuestion only resumes when the questionId matches the current open question", async () => {
  const harness = makeDeps({
    now: () => new Date("2026-04-13T11:00:00.000Z"),
    initialState: {
      ...createEmptyState(),
      orchestration: {
        ...createEmptyState().orchestration,
        tasks: {
          "task-1": makeBlockedTask("task-1", "question-1"),
        },
      },
    },
  });
  const service = new OrchestrationService(harness.deps);

  await expect(
    service.coordinatorAnswerQuestion({
      coordinatorSession: "backend:main",
      taskId: "task-1",
      questionId: "question-wrong",
      answer: "Use staging instead",
    }),
  ).rejects.toThrow('task "task-1" open question is "question-1", not "question-wrong"');
  expect(harness.resumeCalls).toEqual([]);

  await service.coordinatorAnswerQuestion({
    coordinatorSession: "backend:main",
    taskId: "task-1",
    questionId: "question-1",
    answer: "Use staging instead",
  });

  expect(harness.resumeCalls).toEqual([
    {
      taskId: "task-1",
      workerSession: "worker:claude:1",
      coordinatorSession: "backend:main",
      workspace: "backend",
      targetAgent: "claude",
      answer: "Use staging instead",
    },
  ]);
  expect(harness.getState().orchestration.tasks["task-1"]).toMatchObject({
    status: "running",
    openQuestion: {
      questionId: "question-1",
      status: "answered",
      answerSource: "coordinator",
      answerText: "Use staging instead",
      answeredAt: "2026-04-13T11:00:00.000Z",
    },
  });
});

test("coordinatorAnswerQuestion keeps queued blockers recoverable when queue handoff wake fails", async () => {
  const harness = makeDeps({
    wakeCoordinatorSession: async () => {
      throw new Error("wake failed");
    },
    now: () => new Date("2026-04-13T11:05:00.000Z"),
    initialState: {
      ...createEmptyState(),
      orchestration: {
        ...createEmptyState().orchestration,
        tasks: {
          "task-1": {
            ...makeBlockedTask("task-1", "question-1"),
            status: "waiting_for_human",
            openQuestion: {
              ...makeBlockedTask("task-1", "question-1").openQuestion,
              packageId: "package-1",
            },
          },
          "task-2": {
            ...makeBlockedTask("task-2", "question-2"),
            updatedAt: "2026-04-13T10:01:00.000Z",
          },
        },
        humanQuestionPackages: {
          "package-1": {
            packageId: "package-1",
            coordinatorSession: "backend:main",
            status: "active",
            createdAt: "2026-04-13T10:00:00.000Z",
            updatedAt: "2026-04-13T10:00:00.000Z",
            initialTaskIds: ["task-1"],
            openTaskIds: ["task-1"],
            resolvedTaskIds: [],
            awaitingReplyMessageId: "message-1",
            messages: [
              {
                messageId: "message-1",
                kind: "initial",
                promptText: "Please answer task 1.",
                createdAt: "2026-04-13T10:00:00.000Z",
                taskQuestions: [{ taskId: "task-1", questionId: "question-1" }],
                deliveredAt: "2026-04-13T10:00:10.000Z",
                deliveredChatKey: "wx:human",
              },
            ],
          },
        },
        coordinatorQuestionState: {
          "backend:main": {
            activePackageId: "package-1",
            queuedQuestions: [
              {
                taskId: "task-2",
                questionId: "question-2",
                enqueuedAt: "2026-04-13T10:01:00.000Z",
              },
            ],
          },
        },
      },
    },
  });
  const service = new OrchestrationService(harness.deps);

  await service.coordinatorAnswerQuestion({
    coordinatorSession: "backend:main",
    taskId: "task-1",
    questionId: "question-1",
    answer: "Use staging instead",
  });

  expect(harness.getState().orchestration.coordinatorQuestionState["backend:main"]).toEqual({
    queuedQuestions: [
      {
        taskId: "task-2",
        questionId: "question-2",
        enqueuedAt: "2026-04-13T10:01:00.000Z",
      },
    ],
  });
  expect(harness.getState().orchestration.tasks["task-2"]).toMatchObject({
    status: "blocked",
    openQuestion: {
      questionId: "question-2",
      lastWakeError: "wake failed",
    },
  });
});

test("coordinatorRequestHumanInput creates one active frozen package and queues later tasks", async () => {
  const ids = ["package-1", "message-1"];
  const harness = makeDeps({
    createId: () => ids.shift() ?? "unexpected-id",
    now: () => new Date("2026-04-13T12:00:00.000Z"),
    initialState: {
      ...createEmptyState(),
      orchestration: {
        ...createEmptyState().orchestration,
        tasks: {
          "task-1": makeBlockedTask("task-1", "question-1"),
          "task-2": {
            ...makeBlockedTask("task-2", "question-2"),
            sourceHandle: "wx:user-2",
            updatedAt: "2026-04-13T10:02:00.000Z",
          },
        },
      },
    },
  });
  const service = new OrchestrationService(harness.deps);

  await service.recordCoordinatorRouteContext({
    coordinatorSession: "backend:main",
    chatKey: "wx:human",
    accountId: "acc-1",
    replyContextToken: "reply-ctx-1",
  });

  const firstResult = await service.coordinatorRequestHumanInput({
    coordinatorSession: "backend:main",
    taskQuestions: [{ taskId: "task-1", questionId: "question-1" }],
    promptText: "Please ask the human about task 1.",
  });

  expect(firstResult).toEqual({
    packageId: "package-1",
    queuedTaskIds: [],
  });

  expect(harness.deliverCoordinatorCalls).toEqual([
    {
      coordinatorSession: "backend:main",
      chatKey: "wx:human",
      accountId: "acc-1",
      replyContextToken: "reply-ctx-1",
      text: "Please ask the human about task 1.",
    },
  ]);
  expect(harness.getState().orchestration.tasks["task-1"]).toMatchObject({
    status: "waiting_for_human",
    openQuestion: {
      questionId: "question-1",
      packageId: "package-1",
    },
  });
  expect(harness.getState().orchestration.humanQuestionPackages["package-1"]).toMatchObject({
    packageId: "package-1",
    coordinatorSession: "backend:main",
    status: "active",
    initialTaskIds: ["task-1"],
    openTaskIds: ["task-1"],
    resolvedTaskIds: [],
    awaitingReplyMessageId: "message-1",
    messages: [
      {
        messageId: "message-1",
        kind: "initial",
        promptText: "Please ask the human about task 1.",
        deliveredChatKey: "wx:human",
        deliveryAccountId: "acc-1",
      },
    ],
  });

  const queuedResult = await service.coordinatorRequestHumanInput({
    coordinatorSession: "backend:main",
    taskQuestions: [{ taskId: "task-2", questionId: "question-2" }],
    promptText: "Please also ask about task 2.",
    expectedActivePackageId: "package-1",
  });

  expect(queuedResult).toEqual({
    queuedTaskIds: ["task-2"],
  });

  expect(harness.getState().orchestration.tasks["task-2"]).toMatchObject({
    status: "blocked",
    openQuestion: {
      questionId: "question-2",
    },
  });
  expect(harness.getState().orchestration.tasks["task-2"]?.openQuestion?.packageId).toBeUndefined();
  expect(harness.getState().orchestration.coordinatorQuestionState["backend:main"]).toEqual({
    activePackageId: "package-1",
    queuedQuestions: [
      {
        taskId: "task-2",
        questionId: "question-2",
        enqueuedAt: "2026-04-13T12:00:00.000Z",
      },
    ],
  });
  expect(harness.getState().orchestration.humanQuestionPackages["package-1"]?.messages).toHaveLength(1);
  expect(harness.deliverCoordinatorCalls).toHaveLength(1);
});

test("recordCoordinatorRouteContext clears reply route when the chatKey changes without a fresh tuple", async () => {
  const harness = makeDeps({
    now: () => new Date("2026-04-13T12:05:00.000Z"),
    initialState: {
      ...createEmptyState(),
      orchestration: {
        ...createEmptyState().orchestration,
        coordinatorRoutes: {
          "backend:main": {
            coordinatorSession: "backend:main",
            chatKey: "wx:old",
            accountId: "acc-1",
            replyContextToken: "ctx-1",
            updatedAt: "2026-04-13T10:00:00.000Z",
          },
        },
      },
    },
  });
  const service = new OrchestrationService(harness.deps);

  const route = await service.recordCoordinatorRouteContext({
    coordinatorSession: "backend:main",
    chatKey: "wx:new",
  });

  expect(route).toEqual({
    coordinatorSession: "backend:main",
    chatKey: "wx:new",
    updatedAt: "2026-04-13T12:05:00.000Z",
  });
  expect(harness.getState().orchestration.coordinatorRoutes["backend:main"]).toEqual(route);
});

test("recordCoordinatorRouteContext preserves reply route when chatKey stays the same", async () => {
  const harness = makeDeps({
    now: () => new Date("2026-04-13T12:07:00.000Z"),
    initialState: {
      ...createEmptyState(),
      orchestration: {
        ...createEmptyState().orchestration,
        coordinatorRoutes: {
          "backend:main": {
            coordinatorSession: "backend:main",
            chatKey: "wx:old",
            accountId: "acc-1",
            replyContextToken: "ctx-1",
            updatedAt: "2026-04-13T10:00:00.000Z",
          },
        },
      },
    },
  });
  const service = new OrchestrationService(harness.deps);

  const route = await service.recordCoordinatorRouteContext({
    coordinatorSession: "backend:main",
    chatKey: "wx:old",
  });

  expect(route).toEqual({
    coordinatorSession: "backend:main",
    chatKey: "wx:old",
    accountId: "acc-1",
    replyContextToken: "ctx-1",
    updatedAt: "2026-04-13T12:07:00.000Z",
  });
});

test("recordCoordinatorRouteContext stores chat metadata used by internal session tools", async () => {
  const harness = makeDeps({
    now: () => new Date("2026-04-13T12:08:00.000Z"),
  });
  const service = new OrchestrationService(harness.deps);

  const route = await service.recordCoordinatorRouteContext({
    coordinatorSession: "backend:main",
    chatKey: "wx:group",
    channel: "weixin",
    chatType: "group",
    groupId: "group-1",
    senderId: "user-1",
    senderName: "Alice",
    isOwner: false,
  });

  expect(route).toEqual({
    coordinatorSession: "backend:main",
    chatKey: "wx:group",
    channel: "weixin",
    chatType: "group",
    groupId: "group-1",
    senderId: "user-1",
    senderName: "Alice",
    isOwner: false,
    updatedAt: "2026-04-13T12:08:00.000Z",
  });
  expect(harness.getState().orchestration.coordinatorRoutes["backend:main"]).toEqual(route);
});

test("recordCoordinatorRouteContext treats accountId and replyContextToken as an atomic reply route", async () => {
  const harness = makeDeps({
    now: () => new Date("2026-04-13T12:06:00.000Z"),
    initialState: {
      ...createEmptyState(),
      orchestration: {
        ...createEmptyState().orchestration,
        coordinatorRoutes: {
          "backend:main": {
            coordinatorSession: "backend:main",
            chatKey: "wx:old",
            accountId: "acc-1",
            replyContextToken: "ctx-1",
            updatedAt: "2026-04-13T10:00:00.000Z",
          },
        },
      },
    },
  });
  const service = new OrchestrationService(harness.deps);

  const route = await service.recordCoordinatorRouteContext({
    coordinatorSession: "backend:main",
    chatKey: "wx:new",
    accountId: "acc-2",
  });

  expect(route).toEqual({
    coordinatorSession: "backend:main",
    chatKey: "wx:new",
    updatedAt: "2026-04-13T12:06:00.000Z",
  });
  expect(harness.getState().orchestration.coordinatorRoutes["backend:main"]).toEqual(route);
});

test("listPendingCoordinatorBlockers hides queued blockers while an active human package is open", async () => {
  const harness = makeDeps({
    initialState: {
      ...createEmptyState(),
      orchestration: {
        ...createEmptyState().orchestration,
        tasks: {
          "task-1": {
            ...makeBlockedTask("task-1", "question-1"),
            status: "waiting_for_human",
            openQuestion: {
              ...makeBlockedTask("task-1", "question-1").openQuestion,
              packageId: "package-1",
            },
          },
          "task-2": {
            ...makeBlockedTask("task-2", "question-2"),
            updatedAt: "2026-04-13T10:01:00.000Z",
          },
          "task-3": {
            ...makeBlockedTask("task-3", "question-3"),
            updatedAt: "2026-04-13T10:02:00.000Z",
          },
        },
        humanQuestionPackages: {
          "package-1": {
            packageId: "package-1",
            coordinatorSession: "backend:main",
            status: "active",
            createdAt: "2026-04-13T10:00:00.000Z",
            updatedAt: "2026-04-13T10:00:00.000Z",
            initialTaskIds: ["task-1"],
            openTaskIds: ["task-1"],
            resolvedTaskIds: [],
            awaitingReplyMessageId: "message-1",
            messages: [
              {
                messageId: "message-1",
                kind: "initial",
                promptText: "Please answer task 1.",
                createdAt: "2026-04-13T10:00:00.000Z",
                deliveredAt: "2026-04-13T10:00:10.000Z",
                deliveredChatKey: "wx:human",
              },
            ],
          },
        },
        coordinatorQuestionState: {
          "backend:main": {
            activePackageId: "package-1",
            queuedQuestions: [
              {
                taskId: "task-2",
                questionId: "question-2",
                enqueuedAt: "2026-04-13T10:01:00.000Z",
              },
            ],
          },
        },
      },
    },
  });
  const service = new OrchestrationService(harness.deps);

  const blockers = await service.listPendingCoordinatorBlockers("backend:main");

  expect(blockers.map((task) => task.taskId)).toEqual(["task-3"]);
});

test("coordinatorRequestHumanInput throws and records delivery error when the coordinator route is missing", async () => {
  const harness = makeDeps({
    createId: (() => {
      const ids = ["package-1", "message-1"];
      return () => ids.shift() ?? "unexpected-id";
    })(),
    initialState: {
      ...createEmptyState(),
      orchestration: {
        ...createEmptyState().orchestration,
        tasks: {
          "task-1": makeBlockedTask("task-1", "question-1"),
        },
      },
    },
  });
  const service = new OrchestrationService(harness.deps);

  await expect(
    service.coordinatorRequestHumanInput({
      coordinatorSession: "backend:main",
      taskQuestions: [{ taskId: "task-1", questionId: "question-1" }],
      promptText: "Please ask the human about task 1.",
    }),
  ).rejects.toThrow('coordinator "backend:main" does not have a delivery route for human question packages');

  expect(harness.getState().orchestration.humanQuestionPackages["package-1"]).toMatchObject({
    messages: [
      {
        messageId: "message-1",
        lastDeliveryError: 'coordinator "backend:main" does not have a delivery route for human question packages',
      },
    ],
  });
  expect(harness.getState().orchestration.humanQuestionPackages["package-1"]?.awaitingReplyMessageId).toBeUndefined();
});

test("initial human package delivery failure keeps the package active and tasks waiting_for_human", async () => {
  const harness = makeDeps({
    createId: (() => {
      const ids = ["package-1", "message-1"];
      return () => ids.shift() ?? "unexpected-id";
    })(),
    deliverCoordinatorMessage: async (request) => {
      harness.deliverCoordinatorCalls.push(request);
      throw new Error("wechat send failed");
    },
    initialState: {
      ...createEmptyState(),
      orchestration: {
        ...createEmptyState().orchestration,
        tasks: {
          "task-1": makeBlockedTask("task-1", "question-1"),
        },
        coordinatorRoutes: {
          "backend:main": {
            coordinatorSession: "backend:main",
            chatKey: "wx:human",
            accountId: "acc-1",
            replyContextToken: "ctx-1",
            updatedAt: "2026-04-13T10:00:00.000Z",
          },
        },
      },
    },
  });
  const service = new OrchestrationService(harness.deps);

  await expect(
    service.coordinatorRequestHumanInput({
      coordinatorSession: "backend:main",
      taskQuestions: [{ taskId: "task-1", questionId: "question-1" }],
      promptText: "Please ask the human about task 1.",
    }),
  ).rejects.toThrow("wechat send failed");

  expect(harness.getState().orchestration.tasks["task-1"]).toMatchObject({
    status: "waiting_for_human",
    openQuestion: {
      questionId: "question-1",
      packageId: "package-1",
    },
  });
  expect(harness.getState().orchestration.humanQuestionPackages["package-1"]).toMatchObject({
    status: "active",
    openTaskIds: ["task-1"],
    resolvedTaskIds: [],
    messages: [
      {
        messageId: "message-1",
        promptText: "Please ask the human about task 1.",
        lastDeliveryError: "wechat send failed",
      },
    ],
  });
  expect(harness.getState().orchestration.humanQuestionPackages["package-1"]?.awaitingReplyMessageId).toBeUndefined();
});

test("retryHumanQuestionPackageDelivery resends the same undelivered initial message and sets awaitingReplyMessageId", async () => {
  const harness = makeDeps({
    initialState: {
      ...createEmptyState(),
      orchestration: {
        ...createEmptyState().orchestration,
        tasks: {
          "task-1": {
            ...makeBlockedTask("task-1", "question-1"),
            status: "waiting_for_human",
            openQuestion: {
              ...makeBlockedTask("task-1", "question-1").openQuestion,
              packageId: "package-1",
            },
          },
        },
        humanQuestionPackages: {
          "package-1": {
            packageId: "package-1",
            coordinatorSession: "backend:main",
            status: "active",
            createdAt: "2026-04-13T10:00:00.000Z",
            updatedAt: "2026-04-13T10:00:00.000Z",
            initialTaskIds: ["task-1"],
            openTaskIds: ["task-1"],
            resolvedTaskIds: [],
            messages: [
              {
                messageId: "message-1",
                kind: "initial",
                promptText: "Please ask the human about task 1.",
                createdAt: "2026-04-13T10:00:00.000Z",
                routeChatKey: "wx:human",
                routeAccountId: "acc-1",
                routeReplyContextToken: "ctx-1",
                lastDeliveryError: "wechat send failed",
              },
            ],
          },
        },
        coordinatorQuestionState: {
          "backend:main": {
            activePackageId: "package-1",
            queuedQuestions: [],
          },
        },
        coordinatorRoutes: {
          "backend:main": {
            coordinatorSession: "backend:main",
            chatKey: "wx:human",
            accountId: "acc-1",
            replyContextToken: "ctx-1",
            updatedAt: "2026-04-13T10:00:00.000Z",
          },
        },
      },
    },
  });
  const service = new OrchestrationService(harness.deps);

  const result = await service.retryHumanQuestionPackageDelivery({
    coordinatorSession: "backend:main",
    packageId: "package-1",
    messageId: "message-1",
  });

  expect(result).toEqual({
    packageId: "package-1",
    messageId: "message-1",
  });
  expect(harness.deliverCoordinatorCalls).toEqual([
    {
      coordinatorSession: "backend:main",
      chatKey: "wx:human",
      accountId: "acc-1",
      replyContextToken: "ctx-1",
      text: "Please ask the human about task 1.",
    },
  ]);
  expect(harness.getState().orchestration.humanQuestionPackages["package-1"]).toMatchObject({
    awaitingReplyMessageId: "message-1",
    messages: [
      {
        messageId: "message-1",
        promptText: "Please ask the human about task 1.",
        deliveredChatKey: "wx:human",
        deliveryAccountId: "acc-1",
      },
    ],
  });
});

test("retryHumanQuestionPackageDelivery reuses the frozen message route after coordinator route changes", async () => {
  let deliveryAttempts = 0;
  const harness = makeDeps({
    createId: (() => {
      const ids = ["package-1", "message-1"];
      return () => ids.shift() ?? "unexpected-id";
    })(),
    deliverCoordinatorMessage: async (request) => {
      harness.deliverCoordinatorCalls.push(request);
      deliveryAttempts += 1;
      if (deliveryAttempts === 1) {
        throw new Error("wechat send failed");
      }
    },
    initialState: {
      ...createEmptyState(),
      orchestration: {
        ...createEmptyState().orchestration,
        tasks: {
          "task-1": makeBlockedTask("task-1", "question-1"),
        },
      },
    },
  });
  const service = new OrchestrationService(harness.deps);

  await service.recordCoordinatorRouteContext({
    coordinatorSession: "backend:main",
    chatKey: "wx:human-a",
    accountId: "acc-a",
    replyContextToken: "ctx-a",
  });

  await expect(
    service.coordinatorRequestHumanInput({
      coordinatorSession: "backend:main",
      taskQuestions: [{ taskId: "task-1", questionId: "question-1" }],
      promptText: "Please answer task 1.",
    }),
  ).rejects.toThrow("wechat send failed");

  await service.recordCoordinatorRouteContext({
    coordinatorSession: "backend:main",
    chatKey: "wx:human-b",
    accountId: "acc-b",
    replyContextToken: "ctx-b",
  });

  await service.retryHumanQuestionPackageDelivery({
    coordinatorSession: "backend:main",
    packageId: "package-1",
    messageId: "message-1",
  });

  expect(harness.deliverCoordinatorCalls).toEqual([
    {
      coordinatorSession: "backend:main",
      chatKey: "wx:human-a",
      accountId: "acc-a",
      replyContextToken: "ctx-a",
      text: "Please answer task 1.",
    },
    {
      coordinatorSession: "backend:main",
      chatKey: "wx:human-a",
      accountId: "acc-a",
      replyContextToken: "ctx-a",
      text: "Please answer task 1.",
    },
  ]);
});

test("retryHumanQuestionPackageDelivery backfills the current coordinator route when an undelivered message has no frozen route yet", async () => {
  const harness = makeDeps({
    initialState: {
      ...createEmptyState(),
      orchestration: {
        ...createEmptyState().orchestration,
        tasks: {
          "task-1": {
            ...makeBlockedTask("task-1", "question-1"),
            status: "waiting_for_human",
            openQuestion: {
              ...makeBlockedTask("task-1", "question-1").openQuestion,
              packageId: "package-1",
            },
          },
        },
        humanQuestionPackages: {
          "package-1": {
            packageId: "package-1",
            coordinatorSession: "backend:main",
            status: "active",
            createdAt: "2026-04-13T10:00:00.000Z",
            updatedAt: "2026-04-13T10:00:00.000Z",
            initialTaskIds: ["task-1"],
            openTaskIds: ["task-1"],
            resolvedTaskIds: [],
            messages: [
              {
                messageId: "message-1",
                kind: "initial",
                promptText: "Please ask the human about task 1.",
                createdAt: "2026-04-13T10:00:00.000Z",
                lastDeliveryError: "missing route on first attempt",
              },
            ],
          },
        },
        coordinatorQuestionState: {
          "backend:main": {
            activePackageId: "package-1",
            queuedQuestions: [],
          },
        },
        coordinatorRoutes: {
          "backend:main": {
            coordinatorSession: "backend:main",
            chatKey: "wx:human",
            accountId: "acc-1",
            replyContextToken: "ctx-1",
            updatedAt: "2026-04-13T10:00:00.000Z",
          },
        },
      },
    },
  });
  const service = new OrchestrationService(harness.deps);

  await service.retryHumanQuestionPackageDelivery({
    coordinatorSession: "backend:main",
    packageId: "package-1",
    messageId: "message-1",
  });

  expect(harness.deliverCoordinatorCalls).toEqual([
    {
      coordinatorSession: "backend:main",
      chatKey: "wx:human",
      accountId: "acc-1",
      replyContextToken: "ctx-1",
      text: "Please ask the human about task 1.",
    },
  ]);
  expect(harness.getState().orchestration.humanQuestionPackages["package-1"]).toMatchObject({
    messages: [
      {
        messageId: "message-1",
        routeChatKey: "wx:human",
        routeAccountId: "acc-1",
        routeReplyContextToken: "ctx-1",
      },
    ],
  });
});

test("retryHumanQuestionPackageDelivery rejects delivered messages and non-active package state", async () => {
  const harness = makeDeps({
    initialState: {
      ...createEmptyState(),
      orchestration: {
        ...createEmptyState().orchestration,
        humanQuestionPackages: {
          "package-1": {
            packageId: "package-1",
            coordinatorSession: "backend:main",
            status: "active",
            createdAt: "2026-04-13T10:00:00.000Z",
            updatedAt: "2026-04-13T10:00:00.000Z",
            initialTaskIds: ["task-1"],
            openTaskIds: ["task-1"],
            resolvedTaskIds: [],
            messages: [
              {
                messageId: "message-1",
                kind: "initial",
                promptText: "Delivered already",
                createdAt: "2026-04-13T10:00:00.000Z",
                deliveredAt: "2026-04-13T10:00:10.000Z",
                deliveredChatKey: "wx:human",
              },
            ],
          },
          "package-2": {
            packageId: "package-2",
            coordinatorSession: "backend:main",
            status: "closed",
            createdAt: "2026-04-13T10:00:00.000Z",
            updatedAt: "2026-04-13T10:00:00.000Z",
            closedAt: "2026-04-13T10:05:00.000Z",
            initialTaskIds: ["task-2"],
            openTaskIds: [],
            resolvedTaskIds: ["task-2"],
            messages: [
              {
                messageId: "message-2",
                kind: "initial",
                promptText: "Undelivered but inactive",
                createdAt: "2026-04-13T10:00:00.000Z",
                lastDeliveryError: "wechat send failed",
              },
            ],
          },
        },
        coordinatorQuestionState: {
          "backend:main": {
            activePackageId: "package-1",
            queuedQuestions: [],
          },
        },
        coordinatorRoutes: {
          "backend:main": {
            coordinatorSession: "backend:main",
            chatKey: "wx:human",
            updatedAt: "2026-04-13T10:00:00.000Z",
          },
        },
      },
    },
  });
  const service = new OrchestrationService(harness.deps);

  await expect(
    service.retryHumanQuestionPackageDelivery({
      coordinatorSession: "backend:main",
      packageId: "package-1",
      messageId: "message-1",
    }),
  ).rejects.toThrow('message "message-1" in package "package-1" is already delivered');

  await expect(
    service.retryHumanQuestionPackageDelivery({
      coordinatorSession: "backend:main",
      packageId: "package-2",
      messageId: "message-2",
    }),
  ).rejects.toThrow('package "package-2" is not the active package for coordinator "backend:main"');
});


test("coordinatorAnswerQuestion on waiting_for_human cleans active package state", async () => {
  const harness = makeDeps({
    now: () => new Date("2026-04-13T11:30:00.000Z"),
    initialState: {
      ...createEmptyState(),
      orchestration: {
        ...createEmptyState().orchestration,
        tasks: {
          "task-1": {
            ...makeBlockedTask("task-1", "question-1"),
            status: "waiting_for_human",
            openQuestion: {
              ...makeBlockedTask("task-1", "question-1").openQuestion,
              packageId: "package-1",
            },
          },
        },
        humanQuestionPackages: {
          "package-1": {
            packageId: "package-1",
            coordinatorSession: "backend:main",
            status: "active",
            createdAt: "2026-04-13T10:00:00.000Z",
            updatedAt: "2026-04-13T10:00:00.000Z",
            initialTaskIds: ["task-1"],
            openTaskIds: ["task-1"],
            resolvedTaskIds: [],
            awaitingReplyMessageId: "message-1",
            messages: [
              {
                messageId: "message-1",
                kind: "initial",
                promptText: "Please answer task 1.",
                createdAt: "2026-04-13T10:00:00.000Z",
                taskQuestions: [{ taskId: "task-1", questionId: "question-1" }],
                deliveredAt: "2026-04-13T10:00:10.000Z",
                deliveredChatKey: "wx:human",
                deliveryAccountId: "acc-1",
              },
            ],
          },
        },
        coordinatorQuestionState: {
          "backend:main": {
            activePackageId: "package-1",
            queuedQuestions: [],
          },
        },
      },
    },
  });
  const service = new OrchestrationService(harness.deps);

  await service.coordinatorAnswerQuestion({
    coordinatorSession: "backend:main",
    taskId: "task-1",
    questionId: "question-1",
    answer: "Use staging instead",
  });

  expect(harness.getState().orchestration.humanQuestionPackages["package-1"]).toMatchObject({
    status: "closed",
    openTaskIds: [],
    resolvedTaskIds: ["task-1"],
    closedAt: "2026-04-13T11:30:00.000Z",
  });
  expect(harness.getState().orchestration.humanQuestionPackages["package-1"]?.awaitingReplyMessageId).toBeUndefined();
  expect(harness.getState().orchestration.coordinatorQuestionState["backend:main"]).toEqual({
    queuedQuestions: [],
  });
});

test("coordinatorAnswerQuestion rejects waiting_for_human tasks outside the awaited message snapshot", async () => {
  const harness = makeDeps({
    initialState: {
      ...createEmptyState(),
      orchestration: {
        ...createEmptyState().orchestration,
        tasks: {
          "task-1": {
            ...makeBlockedTask("task-1", "question-1"),
            status: "waiting_for_human",
            openQuestion: {
              ...makeBlockedTask("task-1", "question-1").openQuestion,
              packageId: "package-1",
            },
          },
          "task-2": {
            ...makeBlockedTask("task-2", "question-2"),
            status: "waiting_for_human",
            openQuestion: {
              ...makeBlockedTask("task-2", "question-2").openQuestion,
              packageId: "package-1",
            },
          },
        },
        humanQuestionPackages: {
          "package-1": {
            packageId: "package-1",
            coordinatorSession: "backend:main",
            status: "active",
            createdAt: "2026-04-13T10:00:00.000Z",
            updatedAt: "2026-04-13T10:00:00.000Z",
            initialTaskIds: ["task-1"],
            openTaskIds: ["task-1", "task-2"],
            resolvedTaskIds: [],
            awaitingReplyMessageId: "message-1",
            messages: [
              {
                messageId: "message-1",
                kind: "initial",
                promptText: "Please answer task 1 first.",
                createdAt: "2026-04-13T10:00:00.000Z",
                taskQuestions: [{ taskId: "task-1", questionId: "question-1" }],
                deliveredAt: "2026-04-13T10:00:10.000Z",
                deliveredChatKey: "wx:human",
                deliveryAccountId: "acc-1",
              },
            ],
          },
        },
        coordinatorQuestionState: {
          "backend:main": {
            activePackageId: "package-1",
            queuedQuestions: [],
          },
        },
      },
    },
  });
  const service = new OrchestrationService(harness.deps);

  await expect(
    service.coordinatorAnswerQuestion({
      coordinatorSession: "backend:main",
      taskId: "task-2",
      questionId: "question-2",
      answer: "Use the reopened answer.",
    }),
  ).rejects.toThrow(
    'task "task-2" question "question-2" is outside awaited message "message-1" for package "package-1"',
  );

  expect(harness.resumeCalls).toEqual([]);
});

test("coordinatorAnswerQuestion restores waiting_for_human package state when resume fails", async () => {
  const harness = makeDeps({
    now: () => new Date("2026-04-13T11:45:00.000Z"),
    resumeWorkerTask: async (request) => {
      harness.resumeCalls.push(request);
      throw new Error("worker resume failed");
    },
    initialState: {
      ...createEmptyState(),
      orchestration: {
        ...createEmptyState().orchestration,
        tasks: {
          "task-1": {
            ...makeBlockedTask("task-1", "question-1"),
            status: "waiting_for_human",
            openQuestion: {
              ...makeBlockedTask("task-1", "question-1").openQuestion,
              packageId: "package-1",
            },
          },
        },
        humanQuestionPackages: {
          "package-1": {
            packageId: "package-1",
            coordinatorSession: "backend:main",
            status: "active",
            createdAt: "2026-04-13T10:00:00.000Z",
            updatedAt: "2026-04-13T10:00:00.000Z",
            initialTaskIds: ["task-1"],
            openTaskIds: ["task-1"],
            resolvedTaskIds: [],
            awaitingReplyMessageId: "message-1",
            messages: [
              {
                messageId: "message-1",
                kind: "initial",
                promptText: "Please answer task 1.",
                createdAt: "2026-04-13T10:00:00.000Z",
                taskQuestions: [{ taskId: "task-1", questionId: "question-1" }],
                deliveredAt: "2026-04-13T10:00:10.000Z",
                deliveredChatKey: "wx:human",
                deliveryAccountId: "acc-1",
              },
            ],
          },
        },
        coordinatorQuestionState: {
          "backend:main": {
            activePackageId: "package-1",
            queuedQuestions: [],
          },
        },
      },
    },
  });
  const service = new OrchestrationService(harness.deps);

  await expect(
    service.coordinatorAnswerQuestion({
      coordinatorSession: "backend:main",
      taskId: "task-1",
      questionId: "question-1",
      answer: "Use staging instead",
    }),
  ).rejects.toThrow("worker resume failed");

  expect(harness.getState().orchestration.tasks["task-1"]).toMatchObject({
    status: "waiting_for_human",
    openQuestion: {
      questionId: "question-1",
      status: "open",
      packageId: "package-1",
      lastResumeError: "worker resume failed",
    },
  });
  expect(harness.getState().orchestration.humanQuestionPackages["package-1"]).toMatchObject({
    status: "active",
    openTaskIds: ["task-1"],
    resolvedTaskIds: [],
    awaitingReplyMessageId: "message-1",
  });
  expect(harness.getState().orchestration.humanQuestionPackages["package-1"]?.closedAt).toBeUndefined();
  expect(harness.getState().orchestration.coordinatorQuestionState["backend:main"]).toEqual({
    activePackageId: "package-1",
    queuedQuestions: [],
  });
});

test("coordinatorAnswerQuestion closes the active package, hands off queued blockers, and wakes the coordinator", async () => {
  const harness = makeDeps({
    now: () => new Date("2026-04-13T11:30:00.000Z"),
    initialState: {
      ...createEmptyState(),
      orchestration: {
        ...createEmptyState().orchestration,
        tasks: {
          "task-1": {
            ...makeBlockedTask("task-1", "question-1"),
            status: "waiting_for_human",
            openQuestion: {
              ...makeBlockedTask("task-1", "question-1").openQuestion,
              packageId: "package-1",
            },
          },
          "task-2": {
            ...makeBlockedTask("task-2", "question-2"),
            updatedAt: "2026-04-13T10:05:00.000Z",
          },
        },
        humanQuestionPackages: {
          "package-1": {
            packageId: "package-1",
            coordinatorSession: "backend:main",
            status: "active",
            createdAt: "2026-04-13T10:00:00.000Z",
            updatedAt: "2026-04-13T10:00:00.000Z",
            initialTaskIds: ["task-1"],
            openTaskIds: ["task-1"],
            resolvedTaskIds: [],
            awaitingReplyMessageId: "message-1",
            messages: [
              {
                messageId: "message-1",
                kind: "initial",
                promptText: "Please answer task 1.",
                createdAt: "2026-04-13T10:00:00.000Z",
                taskQuestions: [{ taskId: "task-1", questionId: "question-1" }],
                deliveredAt: "2026-04-13T10:00:10.000Z",
                deliveredChatKey: "wx:human",
                deliveryAccountId: "acc-1",
              },
            ],
          },
        },
        coordinatorQuestionState: {
          "backend:main": {
            activePackageId: "package-1",
            queuedQuestions: [
              {
                taskId: "task-2",
                questionId: "question-2",
                enqueuedAt: "2026-04-13T10:05:00.000Z",
              },
            ],
          },
        },
      },
    },
  });
  const service = new OrchestrationService(harness.deps);

  await service.coordinatorAnswerQuestion({
    coordinatorSession: "backend:main",
    taskId: "task-1",
    questionId: "question-1",
    answer: "Use staging instead",
  });

  expect(harness.getState().orchestration.humanQuestionPackages["package-1"]).toMatchObject({
    status: "closed",
    openTaskIds: [],
    resolvedTaskIds: ["task-1"],
  });
  expect(harness.getState().orchestration.coordinatorQuestionState["backend:main"]).toEqual({
    queuedQuestions: [],
  });
  expect(harness.wakeCoordinatorCalls).toEqual([
    {
      coordinatorSession: "backend:main",
    },
  ]);

  const blockers = await service.listPendingCoordinatorBlockers("backend:main");
  expect(blockers.map((task) => task.taskId)).toEqual(["task-2"]);
});

test("coordinatorRequestHumanInput records the actual delivered route returned by the sender", async () => {
  const harness = makeDeps({
    createId: (() => {
      const ids = ["package-1", "message-1"];
      return () => ids.shift() ?? "unexpected-id";
    })(),
    deliverCoordinatorMessage: (async (request) => {
      harness.deliverCoordinatorCalls.push(request);
      return {
        chatKey: request.chatKey,
        accountId: "acc-runtime",
        replyContextToken: "ctx-runtime",
      };
    }) as OrchestrationServiceDeps["deliverCoordinatorMessage"],
    initialState: {
      ...createEmptyState(),
      orchestration: {
        ...createEmptyState().orchestration,
        tasks: {
          "task-1": makeBlockedTask("task-1", "question-1"),
        },
        coordinatorRoutes: {
          "backend:main": {
            coordinatorSession: "backend:main",
            chatKey: "wx:human",
            updatedAt: "2026-04-13T10:00:00.000Z",
          },
        },
      },
    },
  });
  const service = new OrchestrationService(harness.deps);

  await service.coordinatorRequestHumanInput({
    coordinatorSession: "backend:main",
    taskQuestions: [{ taskId: "task-1", questionId: "question-1" }],
    promptText: "Please answer task 1.",
  });

  const message = harness.getState().orchestration.humanQuestionPackages["package-1"]?.messages[0];
  expect(message).toMatchObject({
    routeChatKey: "wx:human",
    routeAccountId: "acc-runtime",
    routeReplyContextToken: "ctx-runtime",
    deliveredChatKey: "wx:human",
    deliveryAccountId: "acc-runtime",
  });
});

test("claimActiveHumanReply uses packageId and messageId as an exact-match claim", async () => {
  const harness = makeDeps({
    initialState: {
      ...createEmptyState(),
      orchestration: {
        ...createEmptyState().orchestration,
        tasks: {
          "task-1": {
            ...makeBlockedTask("task-1", "question-1"),
            status: "waiting_for_human",
            openQuestion: {
              ...makeBlockedTask("task-1", "question-1").openQuestion,
              packageId: "package-1",
            },
          },
        },
        humanQuestionPackages: {
          "package-1": {
            packageId: "package-1",
            coordinatorSession: "backend:main",
            status: "active",
            createdAt: "2026-04-13T10:00:00.000Z",
            updatedAt: "2026-04-13T10:05:00.000Z",
            initialTaskIds: ["task-1"],
            openTaskIds: ["task-1"],
            resolvedTaskIds: [],
            messages: [
              {
                messageId: "message-1",
                kind: "initial",
                promptText: "Initial question.",
                createdAt: "2026-04-13T10:00:00.000Z",
                taskQuestions: [{ taskId: "task-1", questionId: "question-1" }],
                deliveredAt: "2026-04-13T10:00:10.000Z",
                deliveredChatKey: "wx:human",
              },
              {
                messageId: "message-2",
                kind: "follow_up",
                promptText: "Latest follow-up.",
                createdAt: "2026-04-13T10:01:00.000Z",
                taskQuestions: [{ taskId: "task-1", questionId: "question-1" }],
                deliveredAt: "2026-04-13T10:01:10.000Z",
                deliveredChatKey: "wx:human",
              },
            ],
            awaitingReplyMessageId: "message-2",
          },
        },
        coordinatorQuestionState: {
          "backend:main": {
            activePackageId: "package-1",
            queuedQuestions: [],
          },
        },
      },
    },
  });
  const service = new OrchestrationService(harness.deps);

  await expect(
    service.claimActiveHumanReply({
      coordinatorSession: "backend:main",
      chatKey: "wx:human",
      packageId: "package-1",
      messageId: "message-1",
    }),
  ).resolves.toBeNull();

  expect(harness.getState().orchestration.humanQuestionPackages["package-1"]?.awaitingReplyMessageId).toBe("message-2");
});

test("claimActiveHumanReply also matches the frozen delivery account and reply context", async () => {
  const harness = makeDeps({
    initialState: {
      ...createEmptyState(),
      orchestration: {
        ...createEmptyState().orchestration,
        tasks: {
          "task-1": {
            ...makeBlockedTask("task-1", "question-1"),
            status: "waiting_for_human",
            openQuestion: {
              ...makeBlockedTask("task-1", "question-1").openQuestion,
              packageId: "package-1",
            },
          },
        },
        humanQuestionPackages: {
          "package-1": {
            packageId: "package-1",
            coordinatorSession: "backend:main",
            status: "active",
            createdAt: "2026-04-13T10:00:00.000Z",
            updatedAt: "2026-04-13T10:05:00.000Z",
            initialTaskIds: ["task-1"],
            openTaskIds: ["task-1"],
            resolvedTaskIds: [],
            messages: [
              {
                messageId: "message-1",
                kind: "initial",
                promptText: "Initial question.",
                createdAt: "2026-04-13T10:00:00.000Z",
                taskQuestions: [{ taskId: "task-1", questionId: "question-1" }],
                routeChatKey: "wx:human",
                routeAccountId: "acc-1",
                routeReplyContextToken: "ctx-1",
                deliveredAt: "2026-04-13T10:00:10.000Z",
                deliveredChatKey: "wx:human",
                deliveryAccountId: "acc-1",
              },
            ],
            awaitingReplyMessageId: "message-1",
          },
        },
        coordinatorQuestionState: {
          "backend:main": {
            activePackageId: "package-1",
            queuedQuestions: [],
          },
        },
      },
    },
  });
  const service = new OrchestrationService(harness.deps);

  await expect(
    service.claimActiveHumanReply({
      coordinatorSession: "backend:main",
      chatKey: "wx:human",
      packageId: "package-1",
      messageId: "message-1",
      accountId: "acc-2",
      replyContextToken: "ctx-2",
    }),
  ).resolves.toBeNull();

  expect(harness.getState().orchestration.humanQuestionPackages["package-1"]?.awaitingReplyMessageId).toBe("message-1");
});

test("active human package snapshots only expose questions that are still open", async () => {
  const harness = makeDeps({
    initialState: {
      ...createEmptyState(),
      orchestration: {
        ...createEmptyState().orchestration,
        tasks: {
          "task-1": {
            ...makeBlockedTask("task-1", "question-1"),
            status: "running",
            openQuestion: {
              ...makeBlockedTask("task-1", "question-1").openQuestion,
              status: "answered",
              answeredAt: "2026-04-13T12:00:30.000Z",
              answerSource: "coordinator",
              answerText: "Use SQLite",
              packageId: "package-1",
            },
          },
          "task-2": {
            ...makeBlockedTask("task-2", "question-2"),
            status: "waiting_for_human",
            openQuestion: {
              ...makeBlockedTask("task-2", "question-2").openQuestion,
              packageId: "package-1",
            },
          },
        },
        humanQuestionPackages: {
          "package-1": {
            packageId: "package-1",
            coordinatorSession: "backend:main",
            status: "active",
            createdAt: "2026-04-13T12:00:00.000Z",
            updatedAt: "2026-04-13T12:01:00.000Z",
            initialTaskIds: ["task-1", "task-2"],
            openTaskIds: ["task-2"],
            resolvedTaskIds: ["task-1"],
            awaitingReplyMessageId: "message-1",
            messages: [
              {
                messageId: "message-1",
                kind: "initial",
                promptText: "Please answer task 1 and task 2.",
                createdAt: "2026-04-13T12:00:00.000Z",
                deliveredAt: "2026-04-13T12:00:10.000Z",
                deliveredChatKey: "wx:human",
                taskQuestions: [
                  { taskId: "task-1", questionId: "question-1" },
                  { taskId: "task-2", questionId: "question-2" },
                ],
              },
            ],
          },
        },
        coordinatorQuestionState: {
          "backend:main": {
            activePackageId: "package-1",
            queuedQuestions: [],
          },
        },
      },
    },
  });
  const service = new OrchestrationService(harness.deps);

  expect(await service.getActiveHumanQuestionPackage("backend:main")).toMatchObject({
    packageId: "package-1",
    messageTaskQuestions: [{ taskId: "task-2", questionId: "question-2" }],
  });

  const claimed = await service.claimActiveHumanReply({
    coordinatorSession: "backend:main",
    chatKey: "wx:human",
    packageId: "package-1",
    messageId: "message-1",
  });

  expect(claimed).toMatchObject({
    packageId: "package-1",
    messageId: "message-1",
    taskQuestions: [{ taskId: "task-2", questionId: "question-2" }],
  });
});

test("external coordinator active human packages cannot be read or claimed", async () => {
  const externalTask = {
    ...makeBlockedTask("task-1", "question-1"),
    sourceHandle: "codex:backend",
    sourceKind: "coordinator" as const,
    coordinatorSession: "codex:backend",
    workerSession: "backend:claude:codex:backend",
    status: "waiting_for_human" as const,
    openQuestion: {
      ...makeBlockedTask("task-1", "question-1").openQuestion,
      packageId: "package-1",
    },
  };
  const harness = makeDeps({
    initialState: {
      ...createEmptyState(),
      orchestration: {
        ...createEmptyState().orchestration,
        externalCoordinators: {
          "codex:backend": {
            coordinatorSession: "codex:backend",
            workspace: "backend",
            createdAt: "2026-04-28T10:00:00.000Z",
            updatedAt: "2026-04-28T10:00:00.000Z",
          },
        },
        tasks: {
          "task-1": externalTask,
        },
        humanQuestionPackages: {
          "package-1": {
            packageId: "package-1",
            coordinatorSession: "codex:backend",
            status: "active",
            createdAt: "2026-04-28T10:00:00.000Z",
            updatedAt: "2026-04-28T10:00:00.000Z",
            initialTaskIds: ["task-1"],
            openTaskIds: ["task-1"],
            resolvedTaskIds: [],
            awaitingReplyMessageId: "message-1",
            messages: [
              {
                messageId: "message-1",
                kind: "initial",
                promptText: "Please answer task 1.",
                createdAt: "2026-04-28T10:00:00.000Z",
                deliveredAt: "2026-04-28T10:00:10.000Z",
                deliveredChatKey: "wx:human",
                taskQuestions: [{ taskId: "task-1", questionId: "question-1" }],
              },
            ],
          },
        },
        coordinatorQuestionState: {
          "codex:backend": {
            activePackageId: "package-1",
            queuedQuestions: [],
          },
        },
      },
    },
  });
  const service = new OrchestrationService(harness.deps);

  await expect(service.getActiveHumanQuestionPackage("codex:backend")).resolves.toBeNull();
  await expect(
    service.claimActiveHumanReply({
      coordinatorSession: "codex:backend",
      chatKey: "wx:human",
      packageId: "package-1",
      messageId: "message-1",
    }),
  ).resolves.toBeNull();

  expect(harness.savedStates).toEqual([]);
  expect(harness.getState().orchestration.humanQuestionPackages["package-1"].awaitingReplyMessageId).toBe("message-1");
});

test("claimActiveHumanReply refuses awaited messages that are missing frozen taskQuestions", async () => {
  const harness = makeDeps({
    initialState: {
      ...createEmptyState(),
      orchestration: {
        ...createEmptyState().orchestration,
        tasks: {
          "task-1": {
            ...makeBlockedTask("task-1", "question-1"),
            status: "waiting_for_human",
            openQuestion: {
              ...makeBlockedTask("task-1", "question-1").openQuestion,
              packageId: "package-1",
            },
          },
        },
        humanQuestionPackages: {
          "package-1": {
            packageId: "package-1",
            coordinatorSession: "backend:main",
            status: "active",
            createdAt: "2026-04-13T10:00:00.000Z",
            updatedAt: "2026-04-13T10:05:00.000Z",
            initialTaskIds: ["task-1"],
            openTaskIds: ["task-1"],
            resolvedTaskIds: [],
            messages: [
              {
                messageId: "message-1",
                kind: "initial",
                promptText: "Please answer task 1.",
                createdAt: "2026-04-13T10:00:00.000Z",
                deliveredAt: "2026-04-13T10:00:10.000Z",
                deliveredChatKey: "wx:human",
              },
            ],
            awaitingReplyMessageId: "message-1",
          },
        },
        coordinatorQuestionState: {
          "backend:main": {
            activePackageId: "package-1",
            queuedQuestions: [],
          },
        },
      },
    },
  });
  const service = new OrchestrationService(harness.deps);

  await expect(
    service.claimActiveHumanReply({
      coordinatorSession: "backend:main",
      chatKey: "wx:human",
      packageId: "package-1",
      messageId: "message-1",
    }),
  ).resolves.toBeNull();

  expect(harness.getState().orchestration.humanQuestionPackages["package-1"]?.awaitingReplyMessageId).toBe("message-1");
});

test("lists pending blockers and contested coordinator results", async () => {
  const harness = makeDeps({
    initialState: {
      ...createEmptyState(),
      orchestration: {
        ...createEmptyState().orchestration,
        tasks: {
          "task-blocked": makeBlockedTask("task-blocked", "question-1"),
          "task-waiting": {
            ...makeBlockedTask("task-waiting", "question-2"),
            status: "waiting_for_human",
          },
          "task-contested": {
            ...makeCompletedTask("task-contested"),
            reviewPending: {
              reviewId: "review-1",
              reason: "misrouted_answer",
              createdAt: "2026-04-13T10:03:00.000Z",
              resultId: "result-1",
              resultText: "wrong answer",
            },
          },
        },
      },
    },
  });
  const service = new OrchestrationService(harness.deps);

  const blockers = await service.listPendingCoordinatorBlockers("backend:main");
  const contested = await service.listContestedCoordinatorResults("backend:main");

  expect(blockers.map((task) => task.taskId)).toEqual(["task-blocked"]);
  expect(contested.map((task) => task.taskId)).toEqual(["task-contested"]);
});

test("external coordinator blockers and contested results are excluded from prompt fan-in lists", async () => {
  const harness = makeDeps({
    initialState: {
      ...createEmptyState(),
      orchestration: {
        ...createEmptyState().orchestration,
        externalCoordinators: {
          "codex:backend": {
            coordinatorSession: "codex:backend",
            workspace: "backend",
            createdAt: "2026-04-28T10:00:00.000Z",
            updatedAt: "2026-04-28T10:00:00.000Z",
          },
        },
        tasks: {
          "task-blocked": {
            ...makeBlockedTask("task-blocked", "question-1"),
            sourceHandle: "codex:backend",
            sourceKind: "coordinator",
            coordinatorSession: "codex:backend",
            workerSession: "backend:claude:codex:backend",
          },
          "task-contested": {
            ...makeCompletedTask("task-contested"),
            sourceHandle: "codex:backend",
            sourceKind: "coordinator",
            coordinatorSession: "codex:backend",
            workerSession: "backend:claude:codex:backend",
            reviewPending: {
              reviewId: "review-1",
              reason: "misrouted_answer",
              createdAt: "2026-04-28T10:03:00.000Z",
              resultId: "result-1",
              resultText: "wrong answer",
            },
          },
        },
      },
    },
  });
  const service = new OrchestrationService(harness.deps);

  await expect(service.listPendingCoordinatorBlockers("codex:backend")).resolves.toEqual([]);
  await expect(service.listContestedCoordinatorResults("codex:backend")).resolves.toEqual([]);
});

test("lists pending coordinator results sorted by updatedAt and excludes injected tasks", async () => {
  const harness = makeDeps({
    initialState: {
      ...createEmptyState(),
      orchestration: {
        tasks: {
          "task-old": {
            taskId: "task-old",
            sourceHandle: "wx:user-1",
            sourceKind: "human",
            coordinatorSession: "backend:main",
            workspace: "backend",
            targetAgent: "claude",
            task: "old result",
            status: "completed",
            summary: "old",
            resultText: "old result",
            createdAt: "2026-04-13T10:00:00.000Z",
            updatedAt: "2026-04-13T10:05:00.000Z",
          },
          "task-injected": {
            taskId: "task-injected",
            sourceHandle: "wx:user-2",
            sourceKind: "human",
            coordinatorSession: "backend:main",
            workspace: "backend",
            targetAgent: "claude",
            task: "already injected",
            status: "failed",
            summary: "fail",
            resultText: "failed result",
            createdAt: "2026-04-13T10:01:00.000Z",
            updatedAt: "2026-04-13T10:06:00.000Z",
            coordinatorInjectedAt: "2026-04-13T10:07:00.000Z",
          },
          "task-running": {
            taskId: "task-running",
            sourceHandle: "wx:user-3",
            sourceKind: "human",
            coordinatorSession: "backend:main",
            workspace: "backend",
            targetAgent: "claude",
            task: "still running",
            status: "running",
            summary: "",
            resultText: "",
            createdAt: "2026-04-13T10:02:00.000Z",
            updatedAt: "2026-04-13T10:08:00.000Z",
          },
          "task-new": {
            taskId: "task-new",
            sourceHandle: "wx:user-4",
            sourceKind: "human",
            coordinatorSession: "backend:main",
            workspace: "backend",
            targetAgent: "claude",
            task: "new result",
            status: "failed",
            summary: "new",
            resultText: "new result",
            createdAt: "2026-04-13T10:03:00.000Z",
            updatedAt: "2026-04-13T10:09:00.000Z",
          },
          "task-other-coordinator": {
            taskId: "task-other-coordinator",
            sourceHandle: "wx:user-5",
            sourceKind: "human",
            coordinatorSession: "backend:other",
            workspace: "backend",
            targetAgent: "claude",
            task: "other coordinator result",
            status: "completed",
            summary: "other",
            resultText: "other result",
            createdAt: "2026-04-13T10:04:00.000Z",
            updatedAt: "2026-04-13T10:04:30.000Z",
          },
        },
        workerBindings: {},
      },
    },
  });
  const service = new OrchestrationService(harness.deps);

  const results = await service.listPendingCoordinatorResults("backend:main");

  expect(results.map((task) => task.taskId)).toEqual(["task-old", "task-new"]);
});

test("does not leak completed siblings from a contested group into standalone result fan-in", async () => {
  const harness = makeDeps({
    initialState: {
      ...createEmptyState(),
      orchestration: {
        ...createEmptyState().orchestration,
        tasks: {
          "task-group-complete": {
            ...makeCompletedTask("task-group-complete"),
            groupId: "group-1",
            updatedAt: "2026-04-13T10:04:00.000Z",
          },
          "task-group-contested": {
            ...makeCompletedTask("task-group-contested"),
            groupId: "group-1",
            updatedAt: "2026-04-13T10:03:00.000Z",
            reviewPending: {
              reviewId: "review-1",
              reason: "misrouted_answer",
              createdAt: "2026-04-13T10:03:00.000Z",
              resultId: "result-1",
              resultText: "wrong answer",
            },
          },
        },
        groups: {
          "group-1": {
            groupId: "group-1",
            coordinatorSession: "backend:main",
            title: "parallel review",
            createdAt: "2026-04-13T10:00:00.000Z",
            updatedAt: "2026-04-13T10:04:00.000Z",
          },
        },
      },
    },
  });
  const service = new OrchestrationService(harness.deps);

  expect((await service.listPendingCoordinatorGroups("backend:main")).map((group) => group.groupId)).toEqual([]);
  expect((await service.listPendingCoordinatorResults("backend:main")).map((task) => task.taskId)).toEqual([]);
});

test("excludes reviewPending tasks from pending coordinator result fan-in", async () => {
  const harness = makeDeps({
    initialState: {
      ...createEmptyState(),
      orchestration: {
        ...createEmptyState().orchestration,
        tasks: {
          "task-ready": {
            ...makeCompletedTask("task-ready"),
            updatedAt: "2026-04-13T10:04:00.000Z",
          },
          "task-contested": {
            ...makeCompletedTask("task-contested"),
            updatedAt: "2026-04-13T10:03:00.000Z",
            reviewPending: {
              reviewId: "review-1",
              reason: "misrouted_answer",
              createdAt: "2026-04-13T10:03:00.000Z",
              resultId: "result-1",
              resultText: "wrong answer",
            },
          },
        },
      },
    },
  });
  const service = new OrchestrationService(harness.deps);

  const results = await service.listPendingCoordinatorResults("backend:main");

  expect(results.map((task) => task.taskId)).toEqual(["task-ready"]);
});

test("discarding a contested result clears reviewPending and creates a replacement questionId", async () => {
  const ids = ["replacement-question-1"];
  const harness = makeDeps({
    createId: () => ids.shift() ?? "unexpected-id",
    now: () => new Date("2026-04-13T13:00:00.000Z"),
    initialState: {
      ...createEmptyState(),
      orchestration: {
        ...createEmptyState().orchestration,
        tasks: {
          "task-1": {
            ...makeCompletedTask("task-1"),
            openQuestion: {
              questionId: "question-old",
              question: "Which environment should I use?",
              whyBlocked: "Need the right target",
              whatIsNeeded: "A confirmed environment",
              askedAt: "2026-04-13T09:00:00.000Z",
              status: "answered",
              answeredAt: "2026-04-13T09:05:00.000Z",
              answerSource: "coordinator",
              answerText: "Use production",
              packageId: "package-1",
            },
            reviewPending: {
              reviewId: "review-1",
              reason: "misrouted_answer",
              createdAt: "2026-04-13T10:10:00.000Z",
              resultId: "result-1",
              resultText: "completed with the wrong environment",
            },
          },
        },
      },
    },
  });
  const service = new OrchestrationService(harness.deps);

  await service.coordinatorReviewContestedResult({
    coordinatorSession: "backend:main",
    taskId: "task-1",
    reviewId: "review-1",
    decision: "discard",
  });

  expect(harness.getState().orchestration.tasks["task-1"]).toMatchObject({
    status: "blocked",
    summary: "",
    resultText: "",
    openQuestion: {
      questionId: "replacement-question-1",
      question: "Which environment should I use?",
      whyBlocked: "Need the right target",
      whatIsNeeded: "A confirmed environment",
      askedAt: "2026-04-13T13:00:00.000Z",
      status: "open",
    },
  });
  expect(harness.getState().orchestration.tasks["task-1"]?.openQuestion?.packageId).toBeUndefined();
  expect(harness.getState().orchestration.tasks["task-1"]?.reviewPending).toBeUndefined();
  expect(harness.getState().orchestration.tasks["task-1"]?.openQuestion?.answeredAt).toBeUndefined();
  expect(harness.getState().orchestration.tasks["task-1"]?.openQuestion?.answerSource).toBeUndefined();
  expect(harness.getState().orchestration.tasks["task-1"]?.openQuestion?.answerText).toBeUndefined();
});

test("accepting a contested result restores completion notice delivery for human-originated tasks", async () => {
  const harness = makeDeps({
    now: () => new Date("2026-04-13T13:05:00.000Z"),
    initialState: {
      ...createEmptyState(),
      orchestration: {
        ...createEmptyState().orchestration,
        tasks: {
          "task-1": {
            ...makeCompletedTask("task-1"),
            chatKey: "wx:user-1",
            replyContextToken: "ctx-1",
            noticePending: false,
            noticeSentAt: undefined,
            lastNoticeError: undefined,
            reviewPending: {
              reviewId: "review-accept-1",
              reason: "misrouted_answer",
              createdAt: "2026-04-13T10:10:00.000Z",
              resultId: "result-accept-1",
              resultText: "completed with the corrected answer",
            },
          },
        },
      },
    },
  });
  const service = new OrchestrationService(harness.deps);

  await service.coordinatorReviewContestedResult({
    coordinatorSession: "backend:main",
    taskId: "task-1",
    reviewId: "review-accept-1",
    decision: "accept",
  });

  expect(harness.getState().orchestration.tasks["task-1"]?.status).toBe("completed");
  expect(harness.getState().orchestration.tasks["task-1"]?.reviewPending).toBeUndefined();
  expect(harness.getState().orchestration.tasks["task-1"]?.noticePending).toBe(true);
  expect(harness.getState().orchestration.tasks["task-1"]?.noticeSentAt).toBeUndefined();
});

test("marks coordinator results injected and persists the timestamp", async () => {
  const harness = makeDeps({
    now: () => new Date("2026-04-13T11:00:00.000Z"),
    initialState: {
      ...createEmptyState(),
      orchestration: {
        tasks: {
          "task-1": {
            taskId: "task-1",
            sourceHandle: "wx:user-1",
            sourceKind: "human",
            coordinatorSession: "backend:main",
            workspace: "backend",
            targetAgent: "claude",
            task: "first result",
            status: "completed",
            summary: "first",
            resultText: "first result",
            createdAt: "2026-04-13T10:00:00.000Z",
            updatedAt: "2026-04-13T10:05:00.000Z",
          },
          "task-2": {
            taskId: "task-2",
            sourceHandle: "wx:user-2",
            sourceKind: "human",
            coordinatorSession: "backend:main",
            workspace: "backend",
            targetAgent: "claude",
            task: "second result",
            status: "failed",
            summary: "second",
            resultText: "second result",
            createdAt: "2026-04-13T10:01:00.000Z",
            updatedAt: "2026-04-13T10:06:00.000Z",
            coordinatorInjectedAt: "2026-04-13T10:07:00.000Z",
          },
          "task-3": {
            taskId: "task-3",
            sourceHandle: "wx:user-3",
            sourceKind: "human",
            coordinatorSession: "backend:other",
            workspace: "backend",
            targetAgent: "claude",
            task: "other coordinator result",
            status: "completed",
            summary: "other",
            resultText: "other result",
            createdAt: "2026-04-13T10:02:00.000Z",
            updatedAt: "2026-04-13T10:08:00.000Z",
          },
          "task-4": {
            taskId: "task-4",
            sourceHandle: "wx:user-4",
            sourceKind: "human",
            coordinatorSession: "backend:main",
            workspace: "backend",
            targetAgent: "claude",
            task: "running task",
            status: "running",
            summary: "",
            resultText: "",
            createdAt: "2026-04-13T10:03:00.000Z",
            updatedAt: "2026-04-13T10:09:00.000Z",
          },
        },
        workerBindings: {},
      },
    },
  });
  const service = new OrchestrationService(harness.deps);

  await service.markCoordinatorResultsInjected([
    "task-2",
    "task-1",
    "task-missing",
    "task-3",
    "task-4",
  ]);

  expect(harness.savedStates).toHaveLength(1);
  expect(harness.getState().orchestration.tasks["task-1"]).toMatchObject({
    coordinatorInjectedAt: "2026-04-13T11:00:00.000Z",
    updatedAt: "2026-04-13T11:00:00.000Z",
  });
  expect(harness.getState().orchestration.tasks["task-2"]).toMatchObject({
    coordinatorInjectedAt: "2026-04-13T10:07:00.000Z",
  });
  expect(harness.getState().orchestration.tasks["task-3"]).toMatchObject({
    coordinatorInjectedAt: "2026-04-13T11:00:00.000Z",
  });
  expect(harness.getState().orchestration.tasks["task-4"]).not.toHaveProperty("coordinatorInjectedAt");
});

test("markTaskInjectionApplied skips grouped tasks that stopped being injectable", async () => {
  const harness = makeDeps({
    now: () => new Date("2026-04-13T11:10:00.000Z"),
    initialState: {
      ...createEmptyState(),
      orchestration: {
        ...createEmptyState().orchestration,
        tasks: {
          "task-group-ready": {
            ...makeCompletedTask("task-group-ready"),
            groupId: "group-1",
          },
          "task-group-contested": {
            ...makeCompletedTask("task-group-contested"),
            groupId: "group-1",
            reviewPending: {
              reviewId: "review-1",
              reason: "misrouted_answer",
              createdAt: "2026-04-13T10:03:00.000Z",
              resultId: "result-1",
              resultText: "wrong answer",
            },
          },
        },
        groups: {
          "group-1": {
            groupId: "group-1",
            coordinatorSession: "backend:main",
            title: "parallel review",
            createdAt: "2026-04-13T10:00:00.000Z",
            updatedAt: "2026-04-13T10:02:00.000Z",
            injectionPending: true,
          },
        },
      },
    },
  });
  const service = new OrchestrationService(harness.deps);

  await service.markTaskInjectionApplied(["task-group-ready"]);

  expect(harness.getState().orchestration.tasks["task-group-ready"]).not.toHaveProperty("coordinatorInjectedAt");
  expect(harness.getState().orchestration.tasks["task-group-ready"]).toMatchObject({
    injectionPending: true,
  });
});

test("lists tasks and marks running tasks as cancellation requested", async () => {
  const ids = ["task-4", "task-5"];
  let idIndex = 0;
  const cancelCalls: Array<{ taskId: string; workerSession: string; workspace: string; targetAgent: string }> = [];
  const pendingCancellation = new Promise<void>(() => {});
  const harness = makeDeps({
    createId: () => ids[idIndex++] ?? "task-extra",
    findReusableWorkerSession: async () => null,
    cancelWorkerTask: async (request) => {
      cancelCalls.push(request);
      await pendingCancellation;
    },
  });
  const service = new OrchestrationService(harness.deps);

  await service.requestDelegate({
    sourceHandle: "wx:user-4",
    sourceKind: "human",
    coordinatorSession: "backend:main",
    workspace: "backend",
    targetAgent: "claude",
    task: "first task",
  });

  await service.requestDelegate({
    sourceHandle: "wx:user-4",
    sourceKind: "human",
    coordinatorSession: "backend:main",
    workspace: "backend",
    targetAgent: "codex",
    task: "second task",
  });

  expect(await service.listTasks()).toHaveLength(2);
  expect(await service.listTasks({ targetAgent: "claude" })).toHaveLength(1);

  const cancelled = await service.requestTaskCancellation({
    taskId: "task-4",
    sourceHandle: "wx:user-4",
  });

  expect(cancelled.status).toBe("running");
  expect(cancelled.cancelRequestedAt).toBe("2026-04-13T10:00:00.000Z");
  expect(await service.getTask("task-4")).toMatchObject({
    status: "running",
    cancelRequestedAt: "2026-04-13T10:00:00.000Z",
  });
  expect(await service.listTasks({ status: "cancelled" })).toHaveLength(0);
  expect(await service.listTasks({ status: "running" })).toHaveLength(2);
  expect(cancelCalls).toEqual([
    {
      taskId: "task-4",
      workerSession: "backend:claude:backend:main",
      workspace: "backend",
      targetAgent: "claude",
    },
  ]);
});

test("rejects cancelling a task when no source or coordinator ownership is provided", async () => {
  const harness = makeDeps({
    createId: () => "task-cancel-auth-1",
  });
  const service = new OrchestrationService(harness.deps);

  await service.requestDelegate({
    sourceHandle: "wx:user-4",
    sourceKind: "human",
    coordinatorSession: "backend:main",
    workspace: "backend",
    targetAgent: "claude",
    task: "first task",
  });

  await expect(
    service.cancelTask({
      taskId: "task-cancel-auth-1",
    }),
  ).rejects.toThrow('task "task-cancel-auth-1" cancel request must include sourceHandle or coordinatorSession');
});

test("allows cancelling a task by coordinator ownership", async () => {
  const harness = makeDeps({
    createId: () => "task-cancel-auth-2",
  });
  const service = new OrchestrationService(harness.deps);

  await service.requestDelegate({
    sourceHandle: "backend:worker-1",
    sourceKind: "worker",
    coordinatorSession: "backend:main",
    workspace: "backend",
    targetAgent: "claude",
    task: "first task",
  });

  const cancelled = await service.requestTaskCancellation({
    taskId: "task-cancel-auth-2",
    coordinatorSession: "backend:main",
  });

  expect(cancelled.status).toBe("running");
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const task = await service.getTask("task-cancel-auth-2");
    if (task?.status === "cancelled") {
      break;
    }
    await Bun.sleep(0);
  }
  expect(await service.getTask("task-cancel-auth-2")).toMatchObject({
    status: "cancelled",
  });
});

test("cancelling the last waiting_for_human task closes the active package and hands off queued blockers", async () => {
  const harness = makeDeps({
    now: () => new Date("2026-04-13T10:30:00.000Z"),
    initialState: {
      ...createEmptyState(),
      orchestration: {
        ...createEmptyState().orchestration,
        tasks: {
          "task-human-1": {
            ...makeBlockedTask("task-human-1", "question-human-1"),
            status: "waiting_for_human",
            openQuestion: {
              ...makeBlockedTask("task-human-1", "question-human-1").openQuestion,
              packageId: "package-1",
            },
          },
          "task-queued-1": makeBlockedTask("task-queued-1", "question-queued-1"),
        },
        humanQuestionPackages: {
          "package-1": {
            packageId: "package-1",
            coordinatorSession: "backend:main",
            status: "active",
            createdAt: "2026-04-13T10:00:00.000Z",
            updatedAt: "2026-04-13T10:10:00.000Z",
            initialTaskIds: ["task-human-1"],
            openTaskIds: ["task-human-1"],
            resolvedTaskIds: [],
            awaitingReplyMessageId: "message-1",
            messages: [
              {
                messageId: "message-1",
                kind: "initial",
                promptText: "Please answer task-human-1.",
                createdAt: "2026-04-13T10:00:00.000Z",
                deliveredAt: "2026-04-13T10:00:10.000Z",
                deliveredChatKey: "wx:user-1",
                taskQuestions: [{ taskId: "task-human-1", questionId: "question-human-1" }],
              },
            ],
          },
        },
        coordinatorQuestionState: {
          "backend:main": {
            activePackageId: "package-1",
            queuedQuestions: [
              {
                taskId: "task-queued-1",
                questionId: "question-queued-1",
                enqueuedAt: "2026-04-13T10:15:00.000Z",
              },
            ],
          },
        },
      },
    },
  });
  const service = new OrchestrationService(harness.deps);

  const cancelled = await service.requestTaskCancellation({
    taskId: "task-human-1",
    coordinatorSession: "backend:main",
  });

  expect(cancelled).toMatchObject({
    status: "cancelled",
  });
  expect(harness.getState().orchestration.tasks["task-human-1"]?.status).toBe("cancelled");
  expect(harness.getState().orchestration.tasks["task-human-1"]?.openQuestion).toBeUndefined();
  expect(harness.getState().orchestration.humanQuestionPackages["package-1"]?.status).toBe("closed");
  expect(harness.getState().orchestration.humanQuestionPackages["package-1"]?.openTaskIds).toEqual([]);
  expect(harness.getState().orchestration.humanQuestionPackages["package-1"]?.awaitingReplyMessageId).toBeUndefined();
  expect(harness.getState().orchestration.coordinatorQuestionState["backend:main"]).toEqual({
    activePackageId: undefined,
    queuedQuestions: [],
  });
  expect(harness.wakeCoordinatorCalls).toEqual([{ coordinatorSession: "backend:main" }]);
});

test("cancelTask on a needs_confirmation task records it as rejected", async () => {
  const harness = makeDeps({
    initialState: {
      ...createEmptyState(),
      orchestration: {
        ...createEmptyState().orchestration,
        tasks: {
          "task-1": { ...makeCompletedTask("task-1"), status: "needs_confirmation", summary: "", resultText: "" },
        },
      },
    },
  });
  const service = new OrchestrationService(harness.deps);

  const task = await service.cancelTask({ coordinatorSession: "backend:main", taskId: "task-1" });

  expect(task.status).toBe("cancelled");
  expect(task.summary).toBe("rejected");
});

test("completes a running task cancellation when transport cancellation succeeds", async () => {
  const harness = makeDeps({
    initialState: {
      ...createEmptyState(),
      orchestration: {
        tasks: {
          "task-cancel-complete-1": {
            taskId: "task-cancel-complete-1",
            sourceHandle: "backend:main",
            sourceKind: "coordinator",
            coordinatorSession: "backend:main",
            workerSession: "backend:claude:backend:main",
            workspace: "backend",
            targetAgent: "claude",
            task: "review",
            status: "running",
            summary: "",
            resultText: "",
            createdAt: "2026-04-13T10:00:00.000Z",
            updatedAt: "2026-04-13T10:01:00.000Z",
            cancelRequestedAt: "2026-04-13T10:02:00.000Z",
          },
        },
        workerBindings: {},
      },
    },
  });
  const service = new OrchestrationService(harness.deps);

  const task = await service.completeTaskCancellation("task-cancel-complete-1");

  expect(task).toMatchObject({
    status: "cancelled",
    cancelRequestedAt: "2026-04-13T10:02:00.000Z",
    cancelCompletedAt: "2026-04-13T10:00:00.000Z",
  });
});

test("records cancellation failure and keeps the task running", async () => {
  const harness = makeDeps({
    initialState: {
      ...createEmptyState(),
      orchestration: {
        tasks: {
          "task-cancel-fail-1": {
            taskId: "task-cancel-fail-1",
            sourceHandle: "backend:main",
            sourceKind: "coordinator",
            coordinatorSession: "backend:main",
            workerSession: "backend:claude:backend:main",
            workspace: "backend",
            targetAgent: "claude",
            task: "review",
            status: "running",
            summary: "",
            resultText: "",
            createdAt: "2026-04-13T10:00:00.000Z",
            updatedAt: "2026-04-13T10:01:00.000Z",
            cancelRequestedAt: "2026-04-13T10:02:00.000Z",
          },
        },
        workerBindings: {},
      },
    },
  });
  const service = new OrchestrationService(harness.deps);

  const task = await service.failTaskCancellation("task-cancel-fail-1", "cancel transport failed");

  expect(task).toMatchObject({
    status: "running",
    cancelRequestedAt: "2026-04-13T10:02:00.000Z",
    lastCancelError: "cancel transport failed",
  });
});

test("coordinatorRetractAnswer interrupts an answered task, recreates a blocked question, and wakes the coordinator", async () => {
  const ids = ["replacement-question-1"];
  const harness = makeDeps({
    createId: () => ids.shift() ?? "unexpected-id",
    now: () => new Date("2026-04-13T10:20:00.000Z"),
    initialState: {
      ...createEmptyState(),
      orchestration: {
        tasks: {
          "task-correction-1": {
            taskId: "task-correction-1",
            sourceHandle: "backend:main",
            sourceKind: "coordinator",
            coordinatorSession: "backend:main",
            workerSession: "backend:claude:backend:main",
            workspace: "backend",
            targetAgent: "claude",
            task: "review",
            status: "running",
            summary: "",
            resultText: "",
            createdAt: "2026-04-13T10:00:00.000Z",
            updatedAt: "2026-04-13T10:10:00.000Z",
            openQuestion: {
              questionId: "question-answered-1",
              question: "Should I use staging?",
              whyBlocked: "Need the right environment",
              whatIsNeeded: "A confirmed environment",
              askedAt: "2026-04-13T10:05:00.000Z",
              status: "answered",
              answeredAt: "2026-04-13T10:06:00.000Z",
              answerSource: "coordinator",
              answerText: "Use production",
            },
          },
        },
        workerBindings: {},
      },
    },
  });
  const service = new OrchestrationService(harness.deps);

  await service.coordinatorRetractAnswer({
    taskId: "task-correction-1",
    coordinatorSession: "backend:main",
    questionId: "question-answered-1",
  });
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const task = await service.getTask("task-correction-1");
    if (task?.status === "blocked") {
      break;
    }
    await Bun.sleep(0);
  }

  expect(harness.interruptCalls).toEqual([
    {
      taskId: "task-correction-1",
      workerSession: "backend:claude:backend:main",
      workspace: "backend",
      targetAgent: "claude",
    },
  ]);
  expect(await service.getTask("task-correction-1")).toMatchObject({
    status: "blocked",
    openQuestion: {
      questionId: "replacement-question-1",
      question: "Should I use staging?",
      whyBlocked: "Need the right environment",
      whatIsNeeded: "A confirmed environment",
      status: "open",
    },
  });
  expect((await service.getTask("task-correction-1"))?.correctionPending).toBeUndefined();
  expect(harness.wakeCoordinatorCalls).toEqual([
    {
      coordinatorSession: "backend:main",
    },
  ]);
});

test("coordinatorRetractAnswer can contest an already completed answered task before fan-in", async () => {
  const ids = ["review-late-1", "result-late-1"];
  const harness = makeDeps({
    createId: () => ids.shift() ?? "unexpected-id",
    now: () => new Date("2026-04-13T10:25:00.000Z"),
    initialState: {
      ...createEmptyState(),
      orchestration: {
        ...createEmptyState().orchestration,
        tasks: {
          "task-completed-late-1": {
            ...makeCompletedTask("task-completed-late-1"),
            resultText: "wrong completed result",
            injectionPending: true,
            noticePending: true,
            openQuestion: {
              questionId: "question-answered-late-1",
              question: "Should I use staging?",
              whyBlocked: "Need the right environment",
              whatIsNeeded: "A confirmed environment",
              askedAt: "2026-04-13T10:05:00.000Z",
              status: "answered",
              answeredAt: "2026-04-13T10:06:00.000Z",
              answerSource: "coordinator",
              answerText: "Use production",
            },
          },
        },
      },
    },
  });
  const service = new OrchestrationService(harness.deps);

  const task = await service.coordinatorRetractAnswer({
    taskId: "task-completed-late-1",
    coordinatorSession: "backend:main",
    questionId: "question-answered-late-1",
  });

  expect(task).toMatchObject({
    status: "completed",
    noticePending: false,
    reviewPending: {
      reviewId: "review-late-1",
      reason: "misrouted_answer",
      resultId: "result-late-1",
      resultText: "wrong completed result",
    },
  });
  expect(harness.interruptCalls).toEqual([]);
});

test("recordWorkerReply on a correction-pending task creates a contested review instead of normal fan-in", async () => {
  const ids = ["review-1", "result-1"];
  const harness = makeDeps({
    createId: () => ids.shift() ?? "unexpected-id",
    now: () => new Date("2026-04-13T10:25:00.000Z"),
    initialState: {
      ...createEmptyState(),
      orchestration: {
        tasks: {
          "task-contested-runtime-1": {
            taskId: "task-contested-runtime-1",
            sourceHandle: "backend:main",
            sourceKind: "coordinator",
            coordinatorSession: "backend:main",
            workerSession: "backend:claude:backend:main",
            workspace: "backend",
            targetAgent: "claude",
            task: "review",
            status: "running",
            summary: "",
            resultText: "",
            createdAt: "2026-04-13T10:00:00.000Z",
            updatedAt: "2026-04-13T10:20:00.000Z",
            cancelRequestedAt: "2026-04-13T10:21:00.000Z",
            correctionPending: {
              requestedAt: "2026-04-13T10:21:00.000Z",
              reason: "misrouted_answer",
            },
            openQuestion: {
              questionId: "question-answered-1",
              question: "Should I use staging?",
              whyBlocked: "Need the right environment",
              whatIsNeeded: "A confirmed environment",
              askedAt: "2026-04-13T10:05:00.000Z",
              status: "answered",
              answeredAt: "2026-04-13T10:06:00.000Z",
              answerSource: "coordinator",
              answerText: "Use production",
            },
            chatKey: "wx:user",
            replyContextToken: "ctx-1",
          },
        },
        workerBindings: {},
      },
    },
  });
  const service = new OrchestrationService(harness.deps);

  const task = await service.recordWorkerReply({
    taskId: "task-contested-runtime-1",
    sourceHandle: "backend:claude:backend:main",
    status: "completed",
    resultText: "completed with the wrong environment",
  });

  expect(task).toMatchObject({
    status: "completed",
    resultText: "completed with the wrong environment",
    injectionPending: true,
    reviewPending: {
      reviewId: "review-1",
      reason: "misrouted_answer",
      resultId: "result-1",
      resultText: "completed with the wrong environment",
    },
  });
  expect(task.correctionPending).toBeUndefined();
  expect(task.noticePending).not.toBeTrue();
  expect((await service.listPendingCoordinatorResults("backend:main")).map((entry) => entry.taskId)).toEqual([]);
  expect((await service.listContestedCoordinatorResults("backend:main")).map((entry) => entry.taskId)).toEqual([
    "task-contested-runtime-1",
  ]);
});

test("discarding a contested result reopens active package membership for follow-up", async () => {
  const ids = ["replacement-question-2"];
  const harness = makeDeps({
    createId: () => ids.shift() ?? "unexpected-id",
    now: () => new Date("2026-04-13T13:10:00.000Z"),
    initialState: {
      ...createEmptyState(),
      orchestration: {
        ...createEmptyState().orchestration,
        tasks: {
          "task-1": {
            ...makeCompletedTask("task-1"),
            openQuestion: {
              questionId: "question-old",
              question: "Which environment should I use?",
              whyBlocked: "Need the right target",
              whatIsNeeded: "A confirmed environment",
              askedAt: "2026-04-13T09:00:00.000Z",
              status: "answered",
              answeredAt: "2026-04-13T09:05:00.000Z",
              answerSource: "coordinator",
              answerText: "Use production",
              packageId: "package-1",
            },
            reviewPending: {
              reviewId: "review-1",
              reason: "misrouted_answer",
              createdAt: "2026-04-13T10:10:00.000Z",
              resultId: "result-1",
              resultText: "completed with the wrong environment",
            },
          },
          "task-2": {
            ...makeBlockedTask("task-2", "question-2"),
            status: "waiting_for_human",
            openQuestion: {
              ...makeBlockedTask("task-2", "question-2").openQuestion,
              packageId: "package-1",
            },
          },
        },
        humanQuestionPackages: {
          "package-1": {
            packageId: "package-1",
            coordinatorSession: "backend:main",
            status: "active",
            createdAt: "2026-04-13T09:00:00.000Z",
            updatedAt: "2026-04-13T10:10:00.000Z",
            initialTaskIds: ["task-1", "task-2"],
            openTaskIds: ["task-2"],
            resolvedTaskIds: ["task-1"],
            messages: [],
          },
        },
        coordinatorQuestionState: {
          "backend:main": {
            activePackageId: "package-1",
            queuedQuestions: [],
          },
        },
      },
    },
  });
  const service = new OrchestrationService(harness.deps);

  await service.coordinatorReviewContestedResult({
    coordinatorSession: "backend:main",
    taskId: "task-1",
    reviewId: "review-1",
    decision: "discard",
  });

  expect(harness.getState().orchestration.tasks["task-1"]).toMatchObject({
    status: "waiting_for_human",
    openQuestion: {
      questionId: "replacement-question-2",
      packageId: "package-1",
    },
  });
  expect(harness.getState().orchestration.humanQuestionPackages["package-1"]).toMatchObject({
    openTaskIds: ["task-2", "task-1"],
    resolvedTaskIds: [],
  });
});

test("coordinatorRetractAnswer reopens the current active package as waiting_for_human follow-up", async () => {
  const ids = ["replacement-question-3"];
  const harness = makeDeps({
    createId: () => ids.shift() ?? "unexpected-id",
    now: () => new Date("2026-04-13T13:15:00.000Z"),
    initialState: {
      ...createEmptyState(),
      orchestration: {
        ...createEmptyState().orchestration,
        tasks: {
          "task-1": {
            taskId: "task-1",
            sourceHandle: "backend:main",
            sourceKind: "coordinator",
            coordinatorSession: "backend:main",
            workerSession: "backend:claude:backend:main",
            workspace: "backend",
            targetAgent: "claude",
            task: "review",
            status: "running",
            summary: "",
            resultText: "",
            createdAt: "2026-04-13T10:00:00.000Z",
            updatedAt: "2026-04-13T10:10:00.000Z",
            openQuestion: {
              questionId: "question-old",
              question: "Which environment should I use?",
              whyBlocked: "Need the right target",
              whatIsNeeded: "A confirmed environment",
              askedAt: "2026-04-13T09:00:00.000Z",
              status: "answered",
              answeredAt: "2026-04-13T09:05:00.000Z",
              answerSource: "coordinator",
              answerText: "Use production",
              packageId: "package-1",
            },
          },
          "task-2": {
            ...makeBlockedTask("task-2", "question-2"),
            status: "waiting_for_human",
            openQuestion: {
              ...makeBlockedTask("task-2", "question-2").openQuestion,
              packageId: "package-1",
            },
          },
        },
        humanQuestionPackages: {
          "package-1": {
            packageId: "package-1",
            coordinatorSession: "backend:main",
            status: "active",
            createdAt: "2026-04-13T09:00:00.000Z",
            updatedAt: "2026-04-13T10:10:00.000Z",
            initialTaskIds: ["task-1", "task-2"],
            openTaskIds: ["task-2"],
            resolvedTaskIds: ["task-1"],
            messages: [],
          },
        },
        coordinatorQuestionState: {
          "backend:main": {
            activePackageId: "package-1",
            queuedQuestions: [],
          },
        },
      },
    },
  });
  const service = new OrchestrationService(harness.deps);

  await service.coordinatorRetractAnswer({
    taskId: "task-1",
    coordinatorSession: "backend:main",
    questionId: "question-old",
  });
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const task = await service.getTask("task-1");
    if (task?.status === "waiting_for_human") {
      break;
    }
    await Bun.sleep(0);
  }

  expect(harness.getState().orchestration.tasks["task-1"]).toMatchObject({
    status: "waiting_for_human",
    openQuestion: {
      questionId: "replacement-question-3",
      packageId: "package-1",
      status: "open",
    },
  });
  expect(harness.getState().orchestration.humanQuestionPackages["package-1"]).toMatchObject({
    openTaskIds: ["task-2", "task-1"],
    resolvedTaskIds: [],
  });
});

test("recordWorkerReply marks notice and injection pending for human-originated completed tasks", async () => {
  const harness = makeDeps({
    initialState: {
      ...createEmptyState(),
      orchestration: {
        tasks: {
          "task-notice-1": {
            taskId: "task-notice-1",
            sourceHandle: "backend:main",
            sourceKind: "coordinator",
            coordinatorSession: "backend:main",
            workerSession: "backend:claude:backend:main",
            workspace: "backend",
            targetAgent: "claude",
            task: "reply ok",
            status: "running",
            summary: "",
            resultText: "",
            createdAt: "2026-04-13T10:00:00.000Z",
            updatedAt: "2026-04-13T10:00:00.000Z",
            chatKey: "wx:user",
            replyContextToken: "ctx-123",
            accountId: "acc-1",
          },
        },
        workerBindings: {},
      },
    },
  });
  const service = new OrchestrationService(harness.deps);

  const task = await service.recordWorkerReply({
    taskId: "task-notice-1",
    sourceHandle: "backend:claude:backend:main",
    status: "completed",
    resultText: "ok",
  });

  expect(task).toMatchObject({
    status: "completed",
    resultText: "ok",
    noticePending: true,
    injectionPending: true,
  });
});

test("successful notice delivery clears noticePending and records noticeSentAt", async () => {
  const harness = makeDeps({
    initialState: {
      ...createEmptyState(),
      orchestration: {
        tasks: {
          "task-notice-delivered-1": {
            taskId: "task-notice-delivered-1",
            sourceHandle: "backend:main",
            sourceKind: "coordinator",
            coordinatorSession: "backend:main",
            workerSession: "backend:claude:backend:main",
            workspace: "backend",
            targetAgent: "claude",
            task: "reply ok",
            status: "completed",
            summary: "",
            resultText: "ok",
            createdAt: "2026-04-13T10:00:00.000Z",
            updatedAt: "2026-04-13T10:05:00.000Z",
            noticePending: true,
          },
        },
        workerBindings: {},
      },
    },
  });
  const service = new OrchestrationService(harness.deps);

  const task = await service.markTaskNoticeDelivered("task-notice-delivered-1", "acc-2");

  expect(task).toMatchObject({
    noticePending: false,
    noticeSentAt: "2026-04-13T10:00:00.000Z",
    deliveryAccountId: "acc-2",
  });
});

test("failed notice delivery records lastNoticeError and leaves noticePending true", async () => {
  const harness = makeDeps({
    initialState: {
      ...createEmptyState(),
      orchestration: {
        tasks: {
          "task-notice-failed-1": {
            taskId: "task-notice-failed-1",
            sourceHandle: "backend:main",
            sourceKind: "coordinator",
            coordinatorSession: "backend:main",
            workerSession: "backend:claude:backend:main",
            workspace: "backend",
            targetAgent: "claude",
            task: "reply ok",
            status: "completed",
            summary: "",
            resultText: "ok",
            createdAt: "2026-04-13T10:00:00.000Z",
            updatedAt: "2026-04-13T10:05:00.000Z",
            noticePending: true,
          },
        },
        workerBindings: {},
      },
    },
  });
  const service = new OrchestrationService(harness.deps);

  const task = await service.markTaskNoticeFailed({
    taskId: "task-notice-failed-1",
    errorMessage: "send failed",
  });

  expect(task).toMatchObject({
    noticePending: true,
    lastNoticeError: "send failed",
  });
});

test("lists pending task notices", async () => {
  const harness = makeDeps({
    initialState: {
      ...createEmptyState(),
      orchestration: {
        tasks: {
          a: {
            taskId: "a",
            sourceHandle: "backend:main",
            sourceKind: "coordinator",
            coordinatorSession: "backend:main",
            workspace: "backend",
            targetAgent: "claude",
            task: "a",
            status: "completed",
            summary: "",
            resultText: "ok",
            createdAt: "2026-04-13T10:00:00.000Z",
            updatedAt: "2026-04-13T10:02:00.000Z",
            noticePending: true,
          },
          b: {
            taskId: "b",
            sourceHandle: "backend:main",
            sourceKind: "coordinator",
            coordinatorSession: "backend:main",
            workspace: "backend",
            targetAgent: "claude",
            task: "b",
            status: "completed",
            summary: "",
            resultText: "ok",
            createdAt: "2026-04-13T10:00:00.000Z",
            updatedAt: "2026-04-13T10:01:00.000Z",
          },
        },
        workerBindings: {},
      },
    },
  });
  const service = new OrchestrationService(harness.deps);

  expect(await service.listPendingTaskNotices()).toEqual([
    expect.objectContaining({ taskId: "a", noticePending: true }),
  ]);
});

test("successful coordinator prompt clears injectionPending and records injectionAppliedAt", async () => {
  const harness = makeDeps({
    initialState: {
      ...createEmptyState(),
      orchestration: {
        tasks: {
          "task-injection-applied-1": {
            taskId: "task-injection-applied-1",
            sourceHandle: "backend:main",
            sourceKind: "coordinator",
            coordinatorSession: "backend:main",
            workerSession: "backend:claude:backend:main",
            workspace: "backend",
            targetAgent: "claude",
            task: "reply ok",
            status: "completed",
            summary: "",
            resultText: "ok",
            createdAt: "2026-04-13T10:00:00.000Z",
            updatedAt: "2026-04-13T10:05:00.000Z",
            injectionPending: true,
          },
        },
        workerBindings: {},
      },
    },
  });
  const service = new OrchestrationService(harness.deps);

  await service.markTaskInjectionApplied(["task-injection-applied-1"]);

  expect(await service.getTask("task-injection-applied-1")).toMatchObject({
    injectionPending: false,
    injectionAppliedAt: "2026-04-13T10:00:00.000Z",
    coordinatorInjectedAt: "2026-04-13T10:00:00.000Z",
  });
});

test("failed coordinator prompt records lastInjectionError and keeps injectionPending true", async () => {
  const harness = makeDeps({
    initialState: {
      ...createEmptyState(),
      orchestration: {
        tasks: {
          "task-injection-failed-1": {
            taskId: "task-injection-failed-1",
            sourceHandle: "backend:main",
            sourceKind: "coordinator",
            coordinatorSession: "backend:main",
            workerSession: "backend:claude:backend:main",
            workspace: "backend",
            targetAgent: "claude",
            task: "reply ok",
            status: "completed",
            summary: "",
            resultText: "ok",
            createdAt: "2026-04-13T10:00:00.000Z",
            updatedAt: "2026-04-13T10:05:00.000Z",
          },
        },
        workerBindings: {},
      },
    },
  });
  const service = new OrchestrationService(harness.deps);

  await service.markTaskInjectionFailed(["task-injection-failed-1"], "prompt failed");

  expect(await service.getTask("task-injection-failed-1")).toMatchObject({
    injectionPending: true,
    lastInjectionError: "prompt failed",
  });
});


test("approves a worker-chained needs_confirmation task by assigning a worker session", async () => {
  const times = [
    "2026-04-13T10:00:00.000Z",
    "2026-04-13T10:05:00.000Z",
  ];
  let timeIndex = 0;
  const harness = makeDeps({
    now: () => new Date(times[Math.min(timeIndex++, times.length - 1)]),
    createId: () => "task-approve-1",
    reusableWorkerSession: "backend:codex:reviewer:backend:main",
    initialState: {
      ...createEmptyState(),
      orchestration: {
        tasks: {},
        workerBindings: {
          "backend:claude:backend:main": {
            sourceHandle: "backend:claude:backend:main",
            coordinatorSession: "backend:main",
            workspace: "backend",
            targetAgent: "claude",
          },
        },
      },
    },
    config: {
      ...createConfig(),
      orchestration: {
        maxPendingAgentRequestsPerCoordinator: 3,
        allowWorkerChainedRequests: true,
        allowedAgentRequestTargets: [],
        allowedAgentRequestRoles: [],
      },
    },
  });
  const service = new OrchestrationService(harness.deps);

  await service.requestDelegateFromRpc({
    sourceHandle: "backend:claude:backend:main",
    targetAgent: "codex",
    role: "reviewer",
    task: "review the design",
  });

  const approved = await service.approveTask({
    taskId: "task-approve-1",
    coordinatorSession: "backend:main",
  });

  expect(harness.lookupCalls.at(-1)).toEqual({
    sourceHandle: "backend:claude:backend:main",
    sourceKind: "worker",
    coordinatorSession: "backend:main",
    workspace: "backend",
    targetAgent: "codex",
    role: "reviewer",
  });
  expect(harness.ensureCalls.at(-1)).toEqual({
    workerSession: "backend:codex:reviewer:backend:main",
    sourceHandle: "backend:claude:backend:main",
    sourceKind: "worker",
    coordinatorSession: "backend:main",
    workspace: "backend",
    targetAgent: "codex",
    role: "reviewer",
  });
  expect(harness.dispatchCalls.at(-1)).toEqual({
    taskId: "task-approve-1",
    workerSession: "backend:codex:reviewer:backend:main",
    coordinatorSession: "backend:main",
    workspace: "backend",
    targetAgent: "codex",
    role: "reviewer",
    task: "review the design",
  });
  expect(approved).toMatchObject({
    taskId: "task-approve-1",
    status: "running",
    workerSession: "backend:codex:reviewer:backend:main",
    updatedAt: "2026-04-13T10:05:00.000Z",
  });
  expect(harness.getState().orchestration.workerBindings["backend:codex:reviewer:backend:main"]).toEqual({
    sourceHandle: "backend:codex:reviewer:backend:main",
    coordinatorSession: "backend:main",
    workspace: "backend",
    targetAgent: "codex",
    role: "reviewer",
    guardAcpOutput: true,
    logicalSessionId: "task-approve-1",
    transportEngine: "cli",
  });
});
test("rejects a worker-chained needs_confirmation task without assigning a worker session", async () => {
  const times = [
    "2026-04-13T10:00:00.000Z",
    "2026-04-13T10:05:00.000Z",
  ];
  let timeIndex = 0;
  const harness = makeDeps({
    now: () => new Date(times[Math.min(timeIndex++, times.length - 1)]),
    createId: () => "task-reject-1",
    initialState: {
      ...createEmptyState(),
      orchestration: {
        tasks: {},
        workerBindings: {
          "backend:claude:backend:main": {
            sourceHandle: "backend:claude:backend:main",
            coordinatorSession: "backend:main",
            workspace: "backend",
            targetAgent: "claude",
          },
        },
      },
    },
    config: {
      ...createConfig(),
      orchestration: {
        maxPendingAgentRequestsPerCoordinator: 3,
        allowWorkerChainedRequests: true,
        allowedAgentRequestTargets: [],
        allowedAgentRequestRoles: [],
      },
    },
  });
  const service = new OrchestrationService(harness.deps);

  await service.requestDelegateFromRpc({
    sourceHandle: "backend:claude:backend:main",
    targetAgent: "codex",
    task: "review the design",
  });

  const rejected = await service.cancelTask({
    taskId: "task-reject-1",
    coordinatorSession: "backend:main",
  });

  expect(harness.ensureCalls).toEqual([]);
  expect(harness.dispatchCalls).toEqual([]);
  expect(rejected).toMatchObject({
    taskId: "task-reject-1",
    status: "cancelled",
    summary: "rejected",
  });
  expect(rejected.workerSession).toBe("backend:codex:backend:main");
});

test("rejects approval and rejection when the coordinator session does not own the task", async () => {
  const harness = makeDeps({
    createId: () => "task-owned",
    initialState: {
      ...createEmptyState(),
      sessions: {
        main: {
          alias: "main",
          agent: "codex",
          workspace: "backend",
          transport_session: "backend:main",
          created_at: "2026-04-13T10:00:00.000Z",
          last_used_at: "2026-04-13T10:00:00.000Z",
        },
      },
    },
  });
  const service = new OrchestrationService(harness.deps);

  await service.requestDelegateFromRpc({
    sourceHandle: "backend:main",
    targetAgent: "claude",
    task: "review the design",
  });

  await expect(
    service.approveTask({
      taskId: "task-owned",
      coordinatorSession: "backend:other",
    }),
  ).rejects.toThrow('task "task-owned" belongs to coordinator "backend:main", not "backend:other"');

});

test("does not persist a human delegate task when worker dispatch fails", async () => {
  const harness = makeDeps({
    createId: () => "task-dispatch-fail",
    dispatchWorkerTask: async () => {
      throw new Error("prompt failed");
    },
  });
  const service = new OrchestrationService(harness.deps);

  await expect(
    service.requestDelegate({
      sourceHandle: "wx:user-9",
      sourceKind: "human",
      coordinatorSession: "backend:main",
      workspace: "backend",
      targetAgent: "claude",
      task: "review the design",
    }),
  ).rejects.toThrow("prompt failed");

  expect(harness.getState().orchestration.tasks).toEqual({});
  expect(harness.getState().orchestration.workerBindings).toEqual({});
});

test("human delegate dispatch failure restores group injection metadata", async () => {
  const initialGroup = {
    groupId: "group-a",
    coordinatorSession: "backend:main",
    title: "review group",
    createdAt: "2026-04-13T09:00:00.000Z",
    updatedAt: "2026-04-13T09:30:00.000Z",
    coordinatorInjectedAt: "2026-04-13T09:31:00.000Z",
    injectionPending: true,
    injectionAppliedAt: "2026-04-13T09:32:00.000Z",
    lastInjectionError: "previous error",
  };
  const harness = makeDeps({
    createId: () => "task-group-dispatch-fail",
    initialState: {
      ...createEmptyState(),
      orchestration: {
        tasks: {},
        workerBindings: {},
        groups: {
          "group-a": initialGroup,
        },
      },
    },
    dispatchWorkerTask: async () => {
      throw new Error("prompt failed");
    },
  });
  const service = new OrchestrationService(harness.deps);

  await expect(
    service.requestDelegate({
      sourceHandle: "wx:user-9",
      sourceKind: "human",
      coordinatorSession: "backend:main",
      workspace: "backend",
      targetAgent: "claude",
      groupId: "group-a",
      task: "review the design",
    }),
  ).rejects.toThrow("prompt failed");

  expect(harness.getState().orchestration.tasks).toEqual({});
  expect(harness.getState().orchestration.groups?.["group-a"]).toEqual(initialGroup);
});

test("persists a human delegate task and binding before worker dispatch starts", async () => {
  const harness = makeDeps({
    createId: () => "task-visible-1",
  });
  const service = new OrchestrationService({
    ...harness.deps,
    dispatchWorkerTask: async (request) => {
      harness.dispatchCalls.push(request);
      expect(harness.getState().orchestration.tasks["task-visible-1"]).toMatchObject({
        taskId: "task-visible-1",
        status: "running",
        workerSession: "backend:claude:backend:main",
      });
      expect(harness.getState().orchestration.workerBindings["backend:claude:backend:main"]).toMatchObject({
        coordinatorSession: "backend:main",
        targetAgent: "claude",
      });
    },
  });

  await service.requestDelegate({
    sourceHandle: "wx:user-10",
    sourceKind: "human",
    coordinatorSession: "backend:main",
    workspace: "backend",
    targetAgent: "claude",
    task: "review while visible",
  });
});

test("keeps a worker-chained needs_confirmation task unchanged when approval dispatch fails", async () => {
  let dispatchCount = 0;
  const harness = makeDeps({
    createId: () => "task-approve-fail",
    initialState: {
      ...createEmptyState(),
      orchestration: {
        tasks: {},
        workerBindings: {
          "backend:claude:backend:main": {
            sourceHandle: "backend:claude:backend:main",
            coordinatorSession: "backend:main",
            workspace: "backend",
            targetAgent: "claude",
          },
        },
      },
    },
    config: {
      ...createConfig(),
      orchestration: {
        maxPendingAgentRequestsPerCoordinator: 3,
        allowWorkerChainedRequests: true,
        allowedAgentRequestTargets: [],
        allowedAgentRequestRoles: [],
      },
    },
    dispatchWorkerTask: async () => {
      dispatchCount += 1;
      // Worker-chained delegation persists as needs_confirmation, so the
      // initial create does not dispatch. Only fail when approveTask invokes
      // dispatch.
      throw new Error("prompt failed");
    },
  });
  const service = new OrchestrationService(harness.deps);

  await service.requestDelegateFromRpc({
    sourceHandle: "backend:claude:backend:main",
    targetAgent: "codex",
    task: "review the design",
  });
  expect(dispatchCount).toBe(0);

  await expect(
    service.approveTask({
      taskId: "task-approve-fail",
      coordinatorSession: "backend:main",
    }),
  ).rejects.toThrow("prompt failed");

  const task = await service.getTask("task-approve-fail");
  expect(task).toMatchObject({
    taskId: "task-approve-fail",
    status: "needs_confirmation",
    summary: "",
    resultText: "",
  });
  expect(task?.workerSession).toBe("backend:codex:backend:main");
});

test("approval dispatch failure restores missing legacy worker session", async () => {
  const harness = makeDeps({
    initialState: {
      ...createEmptyState(),
      orchestration: {
        tasks: {
          "task-legacy": {
            taskId: "task-legacy",
            sourceHandle: "backend:claude:backend:main",
            sourceKind: "worker",
            coordinatorSession: "backend:main",
            workspace: "backend",
            targetAgent: "codex",
            task: "legacy pending request",
            status: "needs_confirmation",
            summary: "",
            resultText: "",
            createdAt: "2026-04-13T10:00:00.000Z",
            updatedAt: "2026-04-13T10:00:00.000Z",
          },
        },
        workerBindings: {
          "backend:claude:backend:main": {
            sourceHandle: "backend:claude:backend:main",
            coordinatorSession: "backend:main",
            workspace: "backend",
            targetAgent: "claude",
          },
        },
      },
    },
    dispatchWorkerTask: async () => {
      throw new Error("prompt failed");
    },
  });
  const service = new OrchestrationService(harness.deps);

  await expect(
    service.approveTask({
      taskId: "task-legacy",
      coordinatorSession: "backend:main",
    }),
  ).rejects.toThrow("prompt failed");

  const task = await service.getTask("task-legacy");
  expect(task).toMatchObject({
    taskId: "task-legacy",
    status: "needs_confirmation",
    updatedAt: "2026-04-13T10:00:00.000Z",
  });
  expect(task?.workerSession).toBeUndefined();
  expect(harness.getState().orchestration.workerBindings["backend:codex:backend:main"]).toBeUndefined();
});

test("persists approved worker-chained task state and binding before worker dispatch resumes work", async () => {
  const harness = makeDeps({
    createId: () => "task-approve-visible",
    initialState: {
      ...createEmptyState(),
      orchestration: {
        tasks: {},
        workerBindings: {
          "backend:claude:backend:main": {
            sourceHandle: "backend:claude:backend:main",
            coordinatorSession: "backend:main",
            workspace: "backend",
            targetAgent: "claude",
          },
        },
      },
    },
    config: {
      ...createConfig(),
      orchestration: {
        maxPendingAgentRequestsPerCoordinator: 3,
        allowWorkerChainedRequests: true,
        allowedAgentRequestTargets: [],
        allowedAgentRequestRoles: [],
      },
    },
  });
  const service = new OrchestrationService({
    ...harness.deps,
    dispatchWorkerTask: async (request) => {
      harness.dispatchCalls.push(request);
      expect(harness.getState().orchestration.tasks["task-approve-visible"]).toMatchObject({
        taskId: "task-approve-visible",
        status: "running",
        workerSession: "backend:codex:backend:main",
      });
      expect(harness.getState().orchestration.workerBindings["backend:codex:backend:main"]).toMatchObject({
        coordinatorSession: "backend:main",
        targetAgent: "codex",
      });
    },
  });

  await service.requestDelegateFromRpc({
    sourceHandle: "backend:claude:backend:main",
    targetAgent: "codex",
    task: "resume work",
  });

  await service.approveTask({
    taskId: "task-approve-visible",
    coordinatorSession: "backend:main",
  });
});

test("removes terminal tasks for a coordinator session and prunes orphaned bindings", async () => {
  const harness = makeDeps({
    initialState: {
      ...createEmptyState(),
      orchestration: {
        tasks: {
          "task-done-1": {
            taskId: "task-done-1",
            sourceHandle: "backend:main",
            sourceKind: "coordinator",
            coordinatorSession: "backend:main",
            workerSession: "backend:claude:backend:main",
            workspace: "backend",
            targetAgent: "claude",
            task: "review",
            status: "completed",
            summary: "done",
            resultText: "ok",
            createdAt: "2026-04-13T10:00:00.000Z",
            updatedAt: "2026-04-13T10:05:00.000Z",
          },
          "task-fail-1": {
            taskId: "task-fail-1",
            sourceHandle: "backend:main",
            sourceKind: "coordinator",
            coordinatorSession: "backend:main",
            workerSession: "backend:claude:backend:main",
            workspace: "backend",
            targetAgent: "claude",
            task: "build",
            status: "failed",
            summary: "error",
            resultText: "",
            createdAt: "2026-04-13T10:00:00.000Z",
            updatedAt: "2026-04-13T10:06:00.000Z",
          },
          "task-active-1": {
            taskId: "task-active-1",
            sourceHandle: "backend:main",
            sourceKind: "coordinator",
            coordinatorSession: "backend:main",
            workerSession: "backend:claude:backend:main",
            workspace: "backend",
            targetAgent: "claude",
            task: "deploy",
            status: "running",
            summary: "",
            resultText: "",
            createdAt: "2026-04-13T10:00:00.000Z",
            updatedAt: "2026-04-13T10:07:00.000Z",
          },
          "task-other-1": {
            taskId: "task-other-1",
            sourceHandle: "backend:other",
            sourceKind: "coordinator",
            coordinatorSession: "backend:other",
            workerSession: "backend:claude:backend:other",
            workspace: "backend",
            targetAgent: "claude",
            task: "test",
            status: "completed",
            summary: "done",
            resultText: "ok",
            createdAt: "2026-04-13T10:00:00.000Z",
            updatedAt: "2026-04-13T10:08:00.000Z",
          },
        },
        workerBindings: {
          "backend:claude:backend:main": {
            sourceHandle: "backend:claude:backend:main",
            coordinatorSession: "backend:main",
            workspace: "backend",
            targetAgent: "claude",
          },
          "backend:claude:backend:other": {
            sourceHandle: "backend:claude:backend:other",
            coordinatorSession: "backend:other",
            workspace: "backend",
            targetAgent: "claude",
          },
        },
      },
    },
  });
  const service = new OrchestrationService(harness.deps);

  const result = await service.cleanTasks("backend:main");

  expect(result.removedTasks).toBe(2);
  expect(result.removedBindings).toBe(0);
  expect(await service.getTask("task-active-1")).not.toBeNull();
  expect(await service.getTask("task-done-1")).toBeNull();
  expect(await service.getTask("task-fail-1")).toBeNull();
  expect(await service.getTask("task-other-1")).not.toBeNull();
});

test("cleanTasks keeps terminal reviewPending tasks for contested review", async () => {
  const harness = makeDeps({
    initialState: {
      ...createEmptyState(),
      orchestration: {
        ...createEmptyState().orchestration,
        tasks: {
          "task-contested-1": {
            ...makeCompletedTask("task-contested-1"),
            reviewPending: {
              reviewId: "review-1",
              reason: "misrouted_answer",
              createdAt: "2026-04-13T10:03:00.000Z",
              resultId: "result-1",
              resultText: "wrong answer",
            },
          },
        },
      },
    },
  });
  const service = new OrchestrationService(harness.deps);

  const result = await service.cleanTasks("backend:main");

  expect(result).toEqual({
    removedTasks: 0,
    removedBindings: 0,
  });
  expect(await service.getTask("task-contested-1")).not.toBeNull();
});

test("cleanTasks removes groups that become empty after terminal tasks are cleaned", async () => {
  const harness = makeDeps({
    initialState: {
      ...createEmptyState(),
      orchestration: {
        ...createEmptyState().orchestration,
        groups: {
          "group-1": {
            groupId: "group-1",
            coordinatorSession: "backend:main",
            title: "cleanup-me",
            createdAt: "2026-04-13T10:00:00.000Z",
            updatedAt: "2026-04-13T10:00:00.000Z",
          },
        },
        tasks: {
          "task-done-1": {
            ...makeCompletedTask("task-done-1"),
            groupId: "group-1",
          },
        },
      },
    },
  });
  const service = new OrchestrationService(harness.deps);

  const result = await service.cleanTasks("backend:main");

  expect(result).toEqual({
    removedTasks: 1,
    removedBindings: 0,
  });
  expect(harness.getState().orchestration.groups["group-1"]).toBeUndefined();
});

test("prunes orphaned worker bindings after cleaning terminal tasks", async () => {
  const harness = makeDeps({
    initialState: {
      ...createEmptyState(),
      orchestration: {
        tasks: {
          "task-done-1": {
            taskId: "task-done-1",
            sourceHandle: "backend:main",
            sourceKind: "coordinator",
            coordinatorSession: "backend:main",
            workerSession: "backend:claude:backend:main",
            workspace: "backend",
            targetAgent: "claude",
            task: "review",
            status: "completed",
            summary: "done",
            resultText: "ok",
            createdAt: "2026-04-13T10:00:00.000Z",
            updatedAt: "2026-04-13T10:05:00.000Z",
          },
        },
        workerBindings: {
          "backend:claude:backend:main": {
            sourceHandle: "backend:claude:backend:main",
            coordinatorSession: "backend:main",
            workspace: "backend",
            targetAgent: "claude",
          },
        },
      },
    },
  });
  const service = new OrchestrationService(harness.deps);

  const result = await service.cleanTasks("backend:main");

  expect(result.removedTasks).toBe(1);
  expect(result.removedBindings).toBe(1);
});

test("cleanTasks leaves bindings owned by other coordinators alone even when unreferenced", async () => {
  const harness = makeDeps({
    initialState: {
      ...createEmptyState(),
      orchestration: {
        tasks: {
          "task-done-1": {
            taskId: "task-done-1",
            sourceHandle: "backend:main",
            sourceKind: "coordinator",
            coordinatorSession: "backend:main",
            workerSession: "backend:claude:backend:main",
            workspace: "backend",
            targetAgent: "claude",
            task: "review",
            status: "completed",
            summary: "done",
            resultText: "ok",
            createdAt: "2026-04-13T10:00:00.000Z",
            updatedAt: "2026-04-13T10:05:00.000Z",
          },
        },
        workerBindings: {
          "backend:claude:backend:main": {
            sourceHandle: "backend:claude:backend:main",
            coordinatorSession: "backend:main",
            workspace: "backend",
            targetAgent: "claude",
          },
          "backend:claude:backend:other": {
            sourceHandle: "backend:claude:backend:other",
            coordinatorSession: "backend:other",
            workspace: "backend",
            targetAgent: "claude",
          },
        },
      },
    },
  });
  const service = new OrchestrationService(harness.deps);

  const result = await service.cleanTasks("backend:main");

  expect(result.removedTasks).toBe(1);
  expect(result.removedBindings).toBe(1);
  const state = await harness.deps.loadState();
  expect(state.orchestration.workerBindings["backend:claude:backend:main"]).toBeUndefined();
  expect(state.orchestration.workerBindings["backend:claude:backend:other"]).toBeDefined();
});

test("listSessionBlockingTasks returns non-terminal tasks touching the transport session as coord or worker", async () => {
  const harness = makeDeps({
    initialState: {
      ...createEmptyState(),
      orchestration: {
        tasks: {
          "task-coord-running": {
            taskId: "task-coord-running",
            sourceHandle: "wx:user-1",
            sourceKind: "human",
            coordinatorSession: "backend:main",
            workerSession: "backend:claude:backend:main",
            workspace: "backend",
            targetAgent: "claude",
            task: "review",
            status: "running",
            summary: "",
            resultText: "",
            createdAt: "2026-04-13T10:00:00.000Z",
            updatedAt: "2026-04-13T10:00:00.000Z",
          },
          "task-worker-running": {
            taskId: "task-worker-running",
            sourceHandle: "wx:user-1",
            sourceKind: "human",
            coordinatorSession: "backend:other",
            workerSession: "backend:main",
            workspace: "backend",
            targetAgent: "claude",
            task: "work",
            status: "running",
            summary: "",
            resultText: "",
            createdAt: "2026-04-13T10:00:00.000Z",
            updatedAt: "2026-04-13T10:00:00.000Z",
          },
          "task-coord-done": {
            taskId: "task-coord-done",
            sourceHandle: "wx:user-1",
            sourceKind: "human",
            coordinatorSession: "backend:main",
            workerSession: "backend:claude:backend:main",
            workspace: "backend",
            targetAgent: "claude",
            task: "review",
            status: "completed",
            summary: "done",
            resultText: "ok",
            createdAt: "2026-04-13T09:00:00.000Z",
            updatedAt: "2026-04-13T09:05:00.000Z",
          },
          "task-unrelated-running": {
            taskId: "task-unrelated-running",
            sourceHandle: "wx:user-1",
            sourceKind: "human",
            coordinatorSession: "backend:elsewhere",
            workerSession: "backend:claude:backend:elsewhere",
            workspace: "backend",
            targetAgent: "claude",
            task: "x",
            status: "running",
            summary: "",
            resultText: "",
            createdAt: "2026-04-13T10:00:00.000Z",
            updatedAt: "2026-04-13T10:00:00.000Z",
          },
        },
        workerBindings: {},
      },
    },
  });
  const service = new OrchestrationService(harness.deps);

  const blocking = await service.listSessionBlockingTasks("backend:main");
  const ids = blocking.map((task) => task.taskId).sort();
  expect(ids).toEqual(["task-coord-running", "task-worker-running"]);
});

test("listSessionBlockingTasks includes reviewPending tasks as teardown blockers", async () => {
  const harness = makeDeps({
    initialState: {
      ...createEmptyState(),
      orchestration: {
        ...createEmptyState().orchestration,
        tasks: {
          "task-contested-1": {
            ...makeCompletedTask("task-contested-1"),
            coordinatorSession: "backend:main",
            workerSession: "backend:claude:backend:main",
            reviewPending: {
              reviewId: "review-1",
              reason: "misrouted_answer",
              createdAt: "2026-04-13T10:03:00.000Z",
              resultId: "result-1",
              resultText: "wrong answer",
            },
          },
        },
      },
    },
  });
  const service = new OrchestrationService(harness.deps);

  expect((await service.listSessionBlockingTasks("backend:main")).map((task) => task.taskId)).toEqual([
    "task-contested-1",
  ]);
});

test("purgeSessionReferences removes terminal tasks and bindings that reference the transport session", async () => {
  const harness = makeDeps({
    initialState: {
      ...createEmptyState(),
      orchestration: {
        tasks: {
          "task-coord-done": {
            taskId: "task-coord-done",
            sourceHandle: "wx:user-1",
            sourceKind: "human",
            coordinatorSession: "backend:main",
            workerSession: "backend:claude:backend:main",
            workspace: "backend",
            targetAgent: "claude",
            task: "review",
            status: "completed",
            summary: "done",
            resultText: "ok",
            createdAt: "2026-04-13T09:00:00.000Z",
            updatedAt: "2026-04-13T09:05:00.000Z",
          },
          "task-worker-done": {
            taskId: "task-worker-done",
            sourceHandle: "wx:user-2",
            sourceKind: "human",
            coordinatorSession: "backend:other",
            workerSession: "backend:main",
            workspace: "backend",
            targetAgent: "claude",
            task: "x",
            status: "completed",
            summary: "done",
            resultText: "ok",
            createdAt: "2026-04-13T09:00:00.000Z",
            updatedAt: "2026-04-13T09:05:00.000Z",
          },
          "task-unrelated": {
            taskId: "task-unrelated",
            sourceHandle: "wx:user-1",
            sourceKind: "human",
            coordinatorSession: "backend:elsewhere",
            workerSession: "backend:claude:backend:elsewhere",
            workspace: "backend",
            targetAgent: "claude",
            task: "x",
            status: "completed",
            summary: "done",
            resultText: "ok",
            createdAt: "2026-04-13T09:00:00.000Z",
            updatedAt: "2026-04-13T09:05:00.000Z",
          },
        },
        workerBindings: {
          "backend:main": {
            sourceHandle: "backend:main",
            coordinatorSession: "backend:other",
            workspace: "backend",
            targetAgent: "claude",
          },
          "backend:claude:backend:main": {
            sourceHandle: "backend:claude:backend:main",
            coordinatorSession: "backend:main",
            workspace: "backend",
            targetAgent: "claude",
          },
          "backend:claude:backend:elsewhere": {
            sourceHandle: "backend:claude:backend:elsewhere",
            coordinatorSession: "backend:elsewhere",
            workspace: "backend",
            targetAgent: "claude",
          },
        },
      },
    },
  });
  const service = new OrchestrationService(harness.deps);

  const result = await service.purgeSessionReferences("backend:main");

  expect(result.removedTasks).toBe(2);
  expect(result.removedBindings).toBe(2);
  expect(await service.getTask("task-coord-done")).toBeNull();
  expect(await service.getTask("task-worker-done")).toBeNull();
  expect(await service.getTask("task-unrelated")).not.toBeNull();
  const bindings = harness.getState().orchestration.workerBindings;
  expect(bindings["backend:main"]).toBeUndefined();
  expect(bindings["backend:claude:backend:main"]).toBeUndefined();
  expect(bindings["backend:claude:backend:elsewhere"]).toBeDefined();
});

test("purgeSessionReferences removes final coordinator metadata and empty groups for the removed transport session", async () => {
  const harness = makeDeps({
    initialState: {
      ...createEmptyState(),
      orchestration: {
        ...createEmptyState().orchestration,
        groups: {
          "group-1": {
            groupId: "group-1",
            coordinatorSession: "backend:main",
            title: "final-group",
            createdAt: "2026-04-13T08:00:00.000Z",
            updatedAt: "2026-04-13T09:05:00.000Z",
          },
        },
        tasks: {
          "task-coord-done": {
            taskId: "task-coord-done",
            sourceHandle: "wx:user-1",
            sourceKind: "human",
            coordinatorSession: "backend:main",
            workerSession: "backend:claude:backend:main",
            workspace: "backend",
            targetAgent: "claude",
            task: "review",
            status: "completed",
            summary: "done",
            resultText: "ok",
            createdAt: "2026-04-13T09:00:00.000Z",
            updatedAt: "2026-04-13T09:05:00.000Z",
            groupId: "group-1",
          },
        },
        workerBindings: {
          "backend:claude:backend:main": {
            sourceHandle: "backend:claude:backend:main",
            coordinatorSession: "backend:main",
            workspace: "backend",
            targetAgent: "claude",
          },
        },
        humanQuestionPackages: {
          "package-1": {
            packageId: "package-1",
            coordinatorSession: "backend:main",
            status: "closed",
            createdAt: "2026-04-13T08:30:00.000Z",
            updatedAt: "2026-04-13T09:05:00.000Z",
            closedAt: "2026-04-13T09:05:00.000Z",
            initialTaskIds: ["task-coord-done"],
            openTaskIds: [],
            resolvedTaskIds: ["task-coord-done"],
            messages: [],
          },
        },
        coordinatorQuestionState: {
          "backend:main": {
            activePackageId: undefined,
            queuedQuestions: [],
          },
        },
        coordinatorRoutes: {
          "backend:main": {
            coordinatorSession: "backend:main",
            chatKey: "wx:human",
            accountId: "acc-1",
            replyContextToken: "ctx-1",
            updatedAt: "2026-04-13T09:05:00.000Z",
          },
        },
      },
    },
  });
  const service = new OrchestrationService(harness.deps);

  const result = await service.purgeSessionReferences("backend:main");

  expect(result).toEqual({
    removedTasks: 1,
    removedBindings: 1,
  });
  const orchestration = harness.getState().orchestration;
  expect(orchestration.groups["group-1"]).toBeUndefined();
  expect(orchestration.humanQuestionPackages["package-1"]).toBeUndefined();
  expect(orchestration.coordinatorQuestionState["backend:main"]).toBeUndefined();
  expect(orchestration.coordinatorRoutes["backend:main"]).toBeUndefined();
});

test("purgeSessionReferences keeps reviewPending tasks even when their sessions match", async () => {
  const harness = makeDeps({
    initialState: {
      ...createEmptyState(),
      orchestration: {
        ...createEmptyState().orchestration,
        tasks: {
          "task-contested-1": {
            ...makeCompletedTask("task-contested-1"),
            coordinatorSession: "backend:main",
            workerSession: "backend:claude:backend:main",
            reviewPending: {
              reviewId: "review-1",
              reason: "misrouted_answer",
              createdAt: "2026-04-13T10:03:00.000Z",
              resultId: "result-1",
              resultText: "wrong answer",
            },
          },
        },
        workerBindings: {
          "backend:claude:backend:main": {
            sourceHandle: "backend:claude:backend:main",
            coordinatorSession: "backend:main",
            workspace: "backend",
            targetAgent: "claude",
          },
        },
      },
    },
  });
  const service = new OrchestrationService(harness.deps);

  const result = await service.purgeSessionReferences("backend:main");

  expect(result).toEqual({
    removedTasks: 0,
    removedBindings: 0,
  });
  expect(await service.getTask("task-contested-1")).not.toBeNull();
  expect(harness.getState().orchestration.workerBindings["backend:claude:backend:main"]).toBeDefined();
});

test("purgeSessionReferences leaves non-terminal tasks untouched", async () => {
  const harness = makeDeps({
    initialState: {
      ...createEmptyState(),
      orchestration: {
        tasks: {
          "task-coord-running": {
            taskId: "task-coord-running",
            sourceHandle: "wx:user-1",
            sourceKind: "human",
            coordinatorSession: "backend:main",
            workerSession: "backend:claude:backend:main",
            workspace: "backend",
            targetAgent: "claude",
            task: "review",
            status: "running",
            summary: "",
            resultText: "",
            createdAt: "2026-04-13T10:00:00.000Z",
            updatedAt: "2026-04-13T10:00:00.000Z",
          },
        },
        workerBindings: {},
      },
    },
  });
  const service = new OrchestrationService(harness.deps);

  const result = await service.purgeSessionReferences("backend:main");

  expect(result.removedTasks).toBe(0);
  expect(result.removedBindings).toBe(0);
  expect(await service.getTask("task-coord-running")).not.toBeNull();
});

test("listSessionBlockingTasks with post-/clear reset transport session finds tasks stored under stable coordinator id", async () => {
  // Tasks are stored with coordinatorSession="ws:alias" (stable id).
  // After /clear, transport session becomes "ws:alias:reset-1700000000000".
  // The blocking guard must detect the active task so session remove is blocked.
  const harness = makeDeps({
    initialState: {
      ...createEmptyState(),
      orchestration: {
        tasks: {
          "task-stable-running": {
            taskId: "task-stable-running",
            sourceHandle: "wx:user-1",
            sourceKind: "human" as const,
            coordinatorSession: "backend:main",
            workerSession: "backend:claude:backend:main",
            workspace: "backend",
            targetAgent: "claude",
            task: "some work",
            status: "running",
            summary: "",
            resultText: "",
            createdAt: "2026-04-13T10:00:00.000Z",
            updatedAt: "2026-04-13T10:00:00.000Z",
          },
        },
        workerBindings: {},
      },
    },
  });
  const service = new OrchestrationService(harness.deps);

  // Calling with post-/clear raw transport name — should still find the task
  const blocking = await service.listSessionBlockingTasks("backend:main:reset-1700000000000");
  expect(blocking.map((t) => t.taskId)).toEqual(["task-stable-running"]);
});

test("purgeSessionReferences with post-/clear reset transport session removes terminal task stored under stable coordinator id", async () => {
  // Tasks are stored with coordinatorSession="ws:alias" (stable id).
  // After /clear, transport session becomes "ws:alias:reset-1700000000000".
  // purgeSessionReferences must clean up those records so no orphans are left.
  const harness = makeDeps({
    initialState: {
      ...createEmptyState(),
      orchestration: {
        tasks: {
          "task-stable-done": {
            taskId: "task-stable-done",
            sourceHandle: "wx:user-1",
            sourceKind: "human" as const,
            coordinatorSession: "backend:main",
            workerSession: "backend:claude:backend:main",
            workspace: "backend",
            targetAgent: "claude",
            task: "finished work",
            status: "completed",
            summary: "done",
            resultText: "ok",
            createdAt: "2026-04-13T09:00:00.000Z",
            updatedAt: "2026-04-13T09:05:00.000Z",
          },
        },
        workerBindings: {
          "backend:claude:backend:main": {
            sourceHandle: "backend:claude:backend:main",
            coordinatorSession: "backend:main",
            workspace: "backend",
            targetAgent: "claude",
          },
        },
      },
    },
  });
  const service = new OrchestrationService(harness.deps);

  // Calling with post-/clear raw transport name — should remove the stable-id records
  const result = await service.purgeSessionReferences("backend:main:reset-1700000000000");
  expect(result.removedTasks).toBeGreaterThanOrEqual(1);
  expect(await service.getTask("task-stable-done")).toBeNull();
});

test("purgeSessionReferences still removes a task whose workerSession matches the passed identifier (worker removal not regressed)", async () => {
  // Worker session names never carry :reset- suffix; pass a plain name and
  // confirm the worker-matching branch still works after the identity normalization.
  const harness = makeDeps({
    initialState: {
      ...createEmptyState(),
      orchestration: {
        tasks: {
          "task-worker-done": {
            taskId: "task-worker-done",
            sourceHandle: "wx:user-2",
            sourceKind: "human" as const,
            coordinatorSession: "backend:other",
            workerSession: "backend:main",
            workspace: "backend",
            targetAgent: "claude",
            task: "worker task",
            status: "completed",
            summary: "done",
            resultText: "ok",
            createdAt: "2026-04-13T09:00:00.000Z",
            updatedAt: "2026-04-13T09:05:00.000Z",
          },
        },
        workerBindings: {
          "backend:main": {
            sourceHandle: "backend:main",
            coordinatorSession: "backend:other",
            workspace: "backend",
            targetAgent: "claude",
          },
        },
      },
    },
  });
  const service = new OrchestrationService(harness.deps);

  const result = await service.purgeSessionReferences("backend:main");
  expect(result.removedTasks).toBe(1);
  expect(result.removedBindings).toBe(1);
  expect(await service.getTask("task-worker-done")).toBeNull();
});

test("records task progress by updating lastProgressAt", async () => {
  const harness = makeDeps({
    initialState: {
      ...createEmptyState(),
      orchestration: {
        tasks: {
          "task-progress-1": {
            taskId: "task-progress-1",
            sourceHandle: "backend:main",
            sourceKind: "coordinator",
            coordinatorSession: "backend:main",
            workerSession: "backend:claude:backend:main",
            workspace: "backend",
            targetAgent: "claude",
            task: "review",
            status: "running",
            summary: "",
            resultText: "",
            createdAt: "2026-04-13T10:00:00.000Z",
            updatedAt: "2026-04-13T10:00:00.000Z",
          },
        },
        workerBindings: {},
      },
    },
  });
  const service = new OrchestrationService(harness.deps);

  const task = await service.recordTaskProgress("task-progress-1", "analyzing code");

  expect(task.lastProgressAt).toBe("2026-04-13T10:00:00.000Z");
  expect(task.lastProgressSummary).toBe("analyzing code");
  const reloaded = await service.getTask("task-progress-1");
  expect(reloaded?.lastProgressAt).toBe("2026-04-13T10:00:00.000Z");
  expect(reloaded?.lastProgressSummary).toBe("analyzing code");
});

test("lists running tasks overdue for heartbeat", async () => {
  const harness = makeDeps({
    now: () => new Date("2026-04-18T10:10:00.000Z"),
    initialState: {
      ...createEmptyState(),
      orchestration: {
        tasks: {
          "task-overdue-1": {
            taskId: "task-overdue-1",
            sourceHandle: "backend:main",
            sourceKind: "coordinator",
            coordinatorSession: "backend:main",
            workerSession: "backend:claude:backend:main",
            workspace: "backend",
            targetAgent: "claude",
            task: "review",
            status: "running",
            summary: "",
            resultText: "",
            createdAt: "2026-04-18T10:00:00.000Z",
            updatedAt: "2026-04-18T10:00:00.000Z",
          },
          "task-recent-1": {
            taskId: "task-recent-1",
            sourceHandle: "backend:main",
            sourceKind: "coordinator",
            coordinatorSession: "backend:main",
            workerSession: "backend:claude:backend:main",
            workspace: "backend",
            targetAgent: "claude",
            task: "build",
            status: "running",
            summary: "",
            resultText: "",
            createdAt: "2026-04-18T10:00:00.000Z",
            updatedAt: "2026-04-18T10:09:00.000Z",
            lastProgressAt: "2026-04-18T10:08:00.000Z",
          },
          "task-completed-1": {
            taskId: "task-completed-1",
            sourceHandle: "backend:main",
            sourceKind: "coordinator",
            coordinatorSession: "backend:main",
            workspace: "backend",
            targetAgent: "claude",
            task: "test",
            status: "completed",
            summary: "done",
            resultText: "ok",
            createdAt: "2026-04-18T10:00:00.000Z",
            updatedAt: "2026-04-18T10:05:00.000Z",
          },
        },
        workerBindings: {},
      },
    },
  });
  const service = new OrchestrationService(harness.deps);

  const overdue = await service.listHeartbeatTasks(300);

  expect(overdue).toHaveLength(1);
  expect(overdue[0].taskId).toBe("task-overdue-1");
});

test("strips [PROGRESS] lines from resultText in recordWorkerReply", async () => {
  const harness = makeDeps({
    initialState: {
      ...createEmptyState(),
      orchestration: {
        tasks: {
          "task-strip-1": {
            taskId: "task-strip-1",
            sourceHandle: "backend:main",
            sourceKind: "coordinator",
            coordinatorSession: "backend:main",
            workerSession: "backend:claude:backend:main",
            workspace: "backend",
            targetAgent: "claude",
            task: "review",
            status: "running",
            summary: "",
            resultText: "",
            createdAt: "2026-04-13T10:00:00.000Z",
            updatedAt: "2026-04-13T10:00:00.000Z",
            chatKey: "wx:user",
            replyContextToken: "ctx-1",
          },
        },
        workerBindings: {},
      },
    },
  });
  const service = new OrchestrationService(harness.deps);

  const task = await service.recordWorkerReply({
    taskId: "task-strip-1",
    sourceHandle: "backend:claude:backend:main",
    status: "completed",
    resultText: "[PROGRESS] analyzing types\n[PROGRESS] found 2 issues\nHere is my review:\nAll looks good.",
  });

  expect(task.resultText).toBe("Here is my review:\nAll looks good.");
});

test("getGroupSummary returns null for wrong coordinator", async () => {
  const harness = makeDeps({
    initialState: {
      ...createEmptyState(),
      orchestration: {
        tasks: {},
        workerBindings: {},
        groups: {
          "group-review": {
            groupId: "group-review",
            coordinatorSession: "backend:main",
            title: "review",
            createdAt: "2026-04-13T10:00:00.000Z",
            updatedAt: "2026-04-13T10:00:00.000Z",
          },
        },
      },
    },
  });
  const service = new OrchestrationService(harness.deps);

  const summary = await service.getGroupSummary({
    groupId: "group-review",
    coordinatorSession: "backend:other",
  });

  expect(summary).toBeNull();
});

test("getGroupSummary returns null for nonexistent group", async () => {
  const harness = makeDeps({ initialState: createEmptyState() });
  const service = new OrchestrationService(harness.deps);

  const summary = await service.getGroupSummary({
    groupId: "no-such-group",
    coordinatorSession: "backend:main",
  });

  expect(summary).toBeNull();
});

test("cancelGroup rejects wrong coordinator", async () => {
  const harness = makeDeps({
    initialState: {
      ...createEmptyState(),
      orchestration: {
        tasks: {},
        workerBindings: {},
        groups: {
          "group-review": {
            groupId: "group-review",
            coordinatorSession: "backend:main",
            title: "review",
            createdAt: "2026-04-13T10:00:00.000Z",
            updatedAt: "2026-04-13T10:00:00.000Z",
          },
        },
      },
    },
  });
  const service = new OrchestrationService(harness.deps);

  await expect(
    service.cancelGroup({
      groupId: "group-review",
      coordinatorSession: "backend:other",
    }),
  ).rejects.toThrow('group "group-review" does not exist');
});

test("listTasks filters by status and defaults to updatedAt desc", async () => {
  const harness = makeDeps({
    initialState: {
      ...createEmptyState(),
      orchestration: {
        tasks: {
          "t-done": {
            taskId: "t-done",
            sourceHandle: "backend:main",
            sourceKind: "coordinator",
            coordinatorSession: "backend:main",
            workspace: "backend",
            targetAgent: "claude",
            task: "done",
            status: "completed",
            summary: "",
            resultText: "",
            createdAt: "2026-04-18T10:00:00.000Z",
            updatedAt: "2026-04-18T10:01:00.000Z",
          },
          "t-run": {
            taskId: "t-run",
            sourceHandle: "backend:main",
            sourceKind: "coordinator",
            coordinatorSession: "backend:main",
            workspace: "backend",
            targetAgent: "claude",
            task: "run",
            status: "running",
            summary: "",
            resultText: "",
            createdAt: "2026-04-18T10:00:00.000Z",
            updatedAt: "2026-04-18T10:05:00.000Z",
          },
        },
        workerBindings: {},
      },
    },
  });
  const service = new OrchestrationService(harness.deps);

  const running = await service.listTasks({ status: "running" });
  expect(running.map((t) => t.taskId)).toEqual(["t-run"]);

  const all = await service.listTasks({});
  expect(all.map((t) => t.taskId)).toEqual(["t-run", "t-done"]);
});

test("listTasks with stuck=true filters running tasks past the heartbeat threshold", async () => {
  const harness = makeDeps({
    now: () => new Date("2026-04-18T10:10:00.000Z"),
    config: {
      ...createConfig(),
      orchestration: {
        maxPendingAgentRequestsPerCoordinator: 3,
        allowWorkerChainedRequests: true,
        allowedAgentRequestTargets: [],
        allowedAgentRequestRoles: [],
        progressHeartbeatSeconds: 300,
      },
    },
    initialState: {
      ...createEmptyState(),
      orchestration: {
        tasks: {
          "t-stuck": {
            taskId: "t-stuck",
            sourceHandle: "backend:main",
            sourceKind: "coordinator",
            coordinatorSession: "backend:main",
            workspace: "backend",
            targetAgent: "claude",
            task: "stuck",
            status: "running",
            summary: "",
            resultText: "",
            createdAt: "2026-04-18T10:00:00.000Z",
            updatedAt: "2026-04-18T10:00:00.000Z",
          },
          "t-fresh": {
            taskId: "t-fresh",
            sourceHandle: "backend:main",
            sourceKind: "coordinator",
            coordinatorSession: "backend:main",
            workspace: "backend",
            targetAgent: "claude",
            task: "fresh",
            status: "running",
            summary: "",
            resultText: "",
            createdAt: "2026-04-18T10:09:00.000Z",
            updatedAt: "2026-04-18T10:09:00.000Z",
            lastProgressAt: "2026-04-18T10:09:30.000Z",
          },
        },
        workerBindings: {},
      },
    },
  });
  const service = new OrchestrationService(harness.deps);

  const stuck = await service.listTasks({ stuck: true });
  expect(stuck.map((t) => t.taskId)).toEqual(["t-stuck"]);
});

test("listGroupSummaries only returns groups owned by the requesting coordinator", async () => {
  const harness = makeDeps({
    initialState: {
      ...createEmptyState(),
      orchestration: {
        tasks: {},
        workerBindings: {},
        groups: {
          "group-a": {
            groupId: "group-a",
            coordinatorSession: "backend:main",
            title: "mine",
            createdAt: "2026-04-13T10:00:00.000Z",
            updatedAt: "2026-04-13T10:00:00.000Z",
          },
          "group-b": {
            groupId: "group-b",
            coordinatorSession: "backend:other",
            title: "theirs",
            createdAt: "2026-04-13T10:00:00.000Z",
            updatedAt: "2026-04-13T10:00:00.000Z",
          },
        },
      },
    },
  });
  const service = new OrchestrationService(harness.deps);

  const summaries = await service.listGroupSummaries({ coordinatorSession: "backend:main" });

  expect(summaries.length).toBe(1);
  expect(summaries[0]?.group.groupId).toBe("group-a");
});

test("emits structured logs for task lifecycle transitions", async () => {
  const logs: Array<{ level: string; event: string; context?: Record<string, unknown> }> = [];
  const logger = {
    debug: async (event: string, _msg: string, ctx?: Record<string, unknown>) =>
      void logs.push({ level: "debug", event, context: ctx }),
    info: async (event: string, _msg: string, ctx?: Record<string, unknown>) =>
      void logs.push({ level: "info", event, context: ctx }),
    error: async (event: string, _msg: string, ctx?: Record<string, unknown>) =>
      void logs.push({ level: "error", event, context: ctx }),
    cleanup: async () => {},
    flush: async () => {},
  };
  const harness = makeDeps({
    createId: () => "task-log-1",
    reusableWorkerSession: "backend:claude:worker-a",
  });
  const service = new OrchestrationService({ ...harness.deps, logger });

  await service.requestDelegate({
    sourceHandle: "wx:user",
    sourceKind: "human",
    coordinatorSession: "backend:main",
    workspace: "backend",
    targetAgent: "claude",
    task: "review",
  });

  const created = logs.find((entry) => entry.event === "orchestration.task.created");
  expect(created).toBeDefined();
  expect(created?.context).toMatchObject({
    task_id: "task-log-1",
    coordinator_session: "backend:main",
    worker_session: "backend:claude:worker-a",
  });
});

test("serializes concurrent approvals so only one transition wins", async () => {
  const initialState = createEmptyState();
  initialState.orchestration.tasks["task-concurrent-approve"] = {
    taskId: "task-concurrent-approve",
    sourceHandle: "backend:main",
    sourceKind: "coordinator",
    coordinatorSession: "backend:main",
    workerSession: "backend:claude:backend:main",
    workspace: "backend",
    targetAgent: "claude",
    task: "review the design",
    status: "needs_confirmation",
    summary: "",
    resultText: "",
    createdAt: "2026-04-13T10:00:00.000Z",
    updatedAt: "2026-04-13T10:00:00.000Z",
  };

  let state = cloneState(initialState);
  const dispatchCalls: Array<{ taskId: string; workerSession: string }> = [];
  let saveCount = 0;
  let releaseFirstSave!: () => void;
  let firstSaveStarted!: () => void;
  const firstSaveStartedPromise = new Promise<void>((resolve) => {
    firstSaveStarted = resolve;
  });
  const firstSaveReleasePromise = new Promise<void>((resolve) => {
    releaseFirstSave = resolve;
  });

  const service = new OrchestrationService({
    now: () => new Date("2026-04-13T10:00:00.000Z"),
    createId: () => "unused",
    loadState: async () => cloneState(state),
    saveState: async (nextState) => {
      saveCount += 1;
      if (saveCount === 1) {
        firstSaveStarted();
        await firstSaveReleasePromise;
      }
      state = cloneState(nextState);
    },
    config: createConfig(),
    resolveWorkerBindingEngine: () => "cli",
    ensureWorkerSession: async (request) => request.workerSession,
    dispatchWorkerTask: async (request) => {
      dispatchCalls.push({ taskId: request.taskId, workerSession: request.workerSession });
    },
    findReusableWorkerSession: async () => null,
  });

  const firstApproval = service.approveTask({
    taskId: "task-concurrent-approve",
    coordinatorSession: "backend:main",
  });
  await firstSaveStartedPromise;

  const secondApproval = service
    .approveTask({
      taskId: "task-concurrent-approve",
      coordinatorSession: "backend:main",
    })
    .then(
      (value) => ({ status: "resolved" as const, value }),
      (error) => ({ status: "rejected" as const, error }),
    );

  releaseFirstSave();

  await expect(firstApproval).resolves.toMatchObject({
    taskId: "task-concurrent-approve",
    status: "running",
  });
  const secondResult = await secondApproval;
  expect(secondResult.status).toBe("rejected");
  if (secondResult.status === "rejected") {
    expect(secondResult.error).toBeInstanceOf(Error);
    expect(secondResult.error.message).toBe('worker session "backend:claude:backend:main" is already in use');
  }
  expect(dispatchCalls).toEqual([
    {
      taskId: "task-concurrent-approve",
      workerSession: "backend:claude:backend:main",
    },
  ]);
  expect(state.orchestration.tasks["task-concurrent-approve"]?.status).toBe("running");
});

test("startWorkerCancellation reads fresh workerSession from state, not stale snapshot", async () => {
  const cancelCalls: Array<{ workerSession: string }> = [];

  // Blocker for loadState — the closure will pause here while we change the state
  let loadStateBlockerResolve!: () => void;
  const loadStateBlocker = new Promise<void>((resolve) => {
    loadStateBlockerResolve = resolve;
  });

  // Track loadState calls inside the service (not manual calls via originalLoadState)
  let serviceLoadStateCount = 0;
  const harness = makeDeps({
    cancelWorkerTask: async (request) => {
      cancelCalls.push({ workerSession: request.workerSession });
    },
  });

  // Save original loadState for manual use
  const originalLoadState = harness.deps.loadState;

  // Intercept loadState: calls through the service path get counted and potentially blocked.
  // requestDelegateForHuman -> reserve precheck + shell stage + task persist -> loadState
  // (counts 1-3, pass through)
  // requestTaskCancellation -> mutate -> loadState (count 4, pass through)
  // startWorkerCancellation -> loadState (count 5, block here)
  harness.deps.loadState = async () => {
    serviceLoadStateCount++;
    if (serviceLoadStateCount >= 5) {
      await loadStateBlocker;
    }
    return originalLoadState();
  };

  const service = new OrchestrationService(harness.deps);

  // requestDelegateForHuman creates the task directly in "running" state
  await service.requestDelegate({
    sourceHandle: "wx:user",
    sourceKind: "human",
    coordinatorSession: "backend:main",
    workspace: "backend",
    targetAgent: "claude",
    task: "do something",
  });

  // Request cancellation — this calls startWorkerCancellation which starts the async closure.
  // The closure's loadState call will block on our blocker (count 3).
  await service.requestTaskCancellation({
    taskId: "task-1",
    sourceHandle: "wx:user",
  });

  // Give the async closure time to start and hit the blocked loadState
  await Bun.sleep(10);

  // Now reassign the workerSession on the task in state (using original loadState, not intercepted)
  const state = await originalLoadState();
  state.orchestration.tasks["task-1"].workerSession = "backend:new-worker";
  await harness.deps.saveState(state);

  // Release the blocked loadState — the closure will now read the fresh state
  loadStateBlockerResolve();
  await new Promise((r) => setTimeout(r, 50));

  expect(cancelCalls).toHaveLength(1);
  // After fix: should read fresh workerSession from state
  expect(cancelCalls[0].workerSession).toBe("backend:new-worker");
});

test("startWorkerCancellation handles completeTaskCancellation failure gracefully when no workerSession", async () => {
  const harness = makeDeps({});
  const service = new OrchestrationService(harness.deps);

  // requestDelegateForHuman creates the task directly in "running" state
  // (this is save call #1)
  await service.requestDelegate({
    sourceHandle: "wx:user",
    sourceKind: "human",
    coordinatorSession: "backend:main",
    workspace: "backend",
    targetAgent: "claude",
    task: "do something",
  });

  // Remove workerSession to trigger the no-worker path (save call #2)
  const state = await harness.deps.loadState();
  state.orchestration.tasks["task-1"].workerSession = undefined;
  await harness.deps.saveState(state);

  // Now intercept saveState: the next save is from requestTaskCancellation (#3),
  // and the one after that is from completeTaskCancellation (#4) — make #4 fail.
  let saveCallIndex = 0;
  const originalSaveState = harness.deps.saveState;
  harness.deps.saveState = async (state) => {
    saveCallIndex++;
    if (saveCallIndex >= 2) {
      throw new Error("save failed");
    }
    return originalSaveState(state);
  };

  // Track unhandled rejections
  const unhandledRejections: unknown[] = [];
  const originalUnhandledRejection = process.listeners("unhandledRejection");
  process.on("unhandledRejection", (reason) => {
    unhandledRejections.push(reason);
  });

  // Request cancellation — should not cause unhandled rejection
  await service.requestTaskCancellation({
    taskId: "task-1",
    sourceHandle: "wx:user",
  });

  await new Promise((r) => setTimeout(r, 100));

  // Restore unhandled rejection handler
  process.removeAllListeners("unhandledRejection");
  for (const handler of originalUnhandledRejection) {
    process.on("unhandledRejection", handler as (...args: unknown[]) => void);
  }

  // The fix should catch the error — no unhandled rejections
  expect(unhandledRejections).toHaveLength(0);
});

test("coordinatorRequestHumanInput propagates QuotaDeferredError without recording delivery error", async () => {
  // P0-B regression guard: quota deferral is not a delivery failure. The
  // package's lastDeliveryError must remain undefined so the next wake (after
  // the user's next inbound resets the quota window) can retry cleanly.
  const deferred = new QuotaDeferredError({
    chatKey: "wx:human",
    reason: "outbound budget exhausted",
  });
  const harness = makeDeps({
    createId: (() => {
      const ids = ["package-1", "message-1"];
      return () => ids.shift() ?? "unexpected-id";
    })(),
    deliverCoordinatorMessage: async (request) => {
      harness.deliverCoordinatorCalls.push(request);
      throw deferred;
    },
    initialState: {
      ...createEmptyState(),
      orchestration: {
        ...createEmptyState().orchestration,
        tasks: {
          "task-1": makeBlockedTask("task-1", "question-1"),
        },
        coordinatorRoutes: {
          "backend:main": {
            coordinatorSession: "backend:main",
            chatKey: "wx:human",
            accountId: "acc-1",
            replyContextToken: "ctx-1",
            updatedAt: "2026-04-13T10:00:00.000Z",
          },
        },
      },
    },
  });
  const service = new OrchestrationService(harness.deps);

  await expect(
    service.coordinatorRequestHumanInput({
      coordinatorSession: "backend:main",
      taskQuestions: [{ taskId: "task-1", questionId: "question-1" }],
      promptText: "Please ask the human about task 1.",
    }),
  ).rejects.toBe(deferred);

  // Critical invariant: lastDeliveryError MUST NOT be set for a deferred
  // delivery; the package stays cleanly retryable.
  const pkg = harness.getState().orchestration.humanQuestionPackages["package-1"];
  expect(pkg).toBeDefined();
  expect(pkg!.messages[0]!.lastDeliveryError).toBeUndefined();
  expect(pkg!.status).toBe("active");
});

test("parallel delegation mints a unique worker session and skips reuse", async () => {
  let idCounter = 0;
  const deps = makeDeps({
    createId: () => `id-${++idCounter}`,
    reusableWorkerSession: "ws:codex:reused",
  });
  const service = new OrchestrationService(deps.deps);
  const a = await service.requestDelegate({
    sourceHandle: "wx:user-1",
    sourceKind: "human",
    coordinatorSession: "backend:main",
    workspace: "backend",
    targetAgent: "codex",
    task: "task A",
    parallel: true,
  });
  const b = await service.requestDelegate({
    sourceHandle: "wx:user-1",
    sourceKind: "human",
    coordinatorSession: "backend:main",
    workspace: "backend",
    targetAgent: "codex",
    task: "task B",
    parallel: true,
  });
  expect(a.workerSession).toContain(":p-");
  expect(b.workerSession).toContain(":p-");
  expect(a.workerSession).not.toBe(b.workerSession);
  expect(a.workerSession).not.toBe("ws:codex:reused");
});

test("non-parallel delegation still reuses the worker session", async () => {
  const deps = makeDeps({ reusableWorkerSession: "backend:codex:reused" });
  const service = new OrchestrationService(deps.deps);
  const r = await service.requestDelegate({
    sourceHandle: "wx:user-1",
    sourceKind: "human",
    coordinatorSession: "backend:main",
    workspace: "backend",
    targetAgent: "codex",
    task: "task",
  });
  expect(r.workerSession).toBe("backend:codex:reused");
});

test("parallel delegations beyond the cap are queued", async () => {
  let idCounter = 0;
  const config = createConfig();
  config.orchestration.maxParallelTasksPerAgent = 2;
  const deps = makeDeps({ config, createId: () => `id-${++idCounter}` });
  const service = new OrchestrationService(deps.deps);
  const mk = (task: string) =>
    service.requestDelegate({
      sourceHandle: "wx:user-1",
      sourceKind: "human",
      coordinatorSession: "backend:main",
      workspace: "backend",
      targetAgent: "codex",
      task,
      parallel: true,
    });
  const r1 = await mk("A");
  const r2 = await mk("B");
  const r3 = await mk("C");
  expect(r1.status).toBe("running");
  expect(r2.status).toBe("running");
  expect(r3.status).toBe("queued");
});

test("a queued parallel task neither ensures a session nor dispatches", async () => {
  let idCounter = 0;
  const config = createConfig();
  config.orchestration.maxParallelTasksPerAgent = 1;
  const deps = makeDeps({ config, createId: () => `id-${++idCounter}` });
  const service = new OrchestrationService(deps.deps);
  await service.requestDelegate({
    sourceHandle: "wx:user-1",
    sourceKind: "human",
    coordinatorSession: "backend:main",
    workspace: "backend",
    targetAgent: "codex",
    task: "A",
    parallel: true,
  });
  deps.ensureCalls.length = 0;
  deps.dispatchCalls.length = 0;
  const r2 = await service.requestDelegate({
    sourceHandle: "wx:user-1",
    sourceKind: "human",
    coordinatorSession: "backend:main",
    workspace: "backend",
    targetAgent: "codex",
    task: "B",
    parallel: true,
  });
  expect(r2.status).toBe("queued");
  expect(deps.ensureCalls.length).toBe(0);
  expect(deps.dispatchCalls.length).toBe(0);
});

test("a queued parallel task is persisted and retrievable with status queued", async () => {
  let idCounter = 0;
  const config = createConfig();
  config.orchestration.maxParallelTasksPerAgent = 1;
  const deps = makeDeps({ config, createId: () => `id-${++idCounter}` });
  const service = new OrchestrationService(deps.deps);
  await service.requestDelegate({
    sourceHandle: "wx:user-1",
    sourceKind: "human",
    coordinatorSession: "backend:main",
    workspace: "backend",
    targetAgent: "codex",
    task: "A",
    parallel: true,
  });
  const r2 = await service.requestDelegate({
    sourceHandle: "wx:user-1",
    sourceKind: "human",
    coordinatorSession: "backend:main",
    workspace: "backend",
    targetAgent: "codex",
    task: "B",
    parallel: true,
  });
  expect(r2.status).toBe("queued");
  const task = await service.getTask(r2.taskId);
  expect(task).not.toBeNull();
  expect(task!.status).toBe("queued");
  expect(task!.targetAgent).toBe("codex");
  expect(task!.task).toBe("B");
  expect(task!.ephemeralWorkerSession).toBe(true);
});

// ---------------------------------------------------------------------------
// Task 7: parallel gate for requestDelegateFromRpc and approveTask
// ---------------------------------------------------------------------------

test("rpc coordinator parallel delegations beyond the cap are queued", async () => {
  let idCounter = 0;
  const config = createConfig();
  config.orchestration.maxParallelTasksPerAgent = 2;
  const harness = makeDeps({
    config,
    createId: () => `id-${++idCounter}`,
    initialState: {
      ...createEmptyState(),
      sessions: {
        main: {
          alias: "main",
          agent: "codex",
          workspace: "backend",
          transport_session: "backend:main",
          created_at: "2026-04-13T10:00:00.000Z",
          last_used_at: "2026-04-13T10:00:00.000Z",
        },
      },
    },
  });
  const service = new OrchestrationService(harness.deps);

  const mk = (task: string) =>
    service.requestDelegateFromRpc({
      sourceHandle: "backend:main",
      targetAgent: "claude",
      task,
      parallel: true,
    });

  const r1 = await mk("A");
  const r2 = await mk("B");
  // Wait for async ensure/dispatch to settle before r3 so slots are registered
  for (let attempt = 0; attempt < 20 && harness.dispatchCalls.length < 2; attempt += 1) {
    await Bun.sleep(0);
  }
  const r3 = await mk("C");

  expect(r1.status).toBe("running");
  expect(r2.status).toBe("running");
  expect(r3.status).toBe("queued");
});

test("rpc coordinator queued parallel task triggers no ensure or dispatch", async () => {
  let idCounter = 0;
  const config = createConfig();
  config.orchestration.maxParallelTasksPerAgent = 1;
  const harness = makeDeps({
    config,
    createId: () => `id-${++idCounter}`,
    initialState: {
      ...createEmptyState(),
      sessions: {
        main: {
          alias: "main",
          agent: "codex",
          workspace: "backend",
          transport_session: "backend:main",
          created_at: "2026-04-13T10:00:00.000Z",
          last_used_at: "2026-04-13T10:00:00.000Z",
        },
      },
    },
  });
  const service = new OrchestrationService(harness.deps);

  // Fill the single slot
  await service.requestDelegateFromRpc({
    sourceHandle: "backend:main",
    targetAgent: "claude",
    task: "A",
    parallel: true,
  });
  for (let attempt = 0; attempt < 20 && harness.dispatchCalls.length < 1; attempt += 1) {
    await Bun.sleep(0);
  }

  harness.ensureCalls.length = 0;
  harness.dispatchCalls.length = 0;

  const r2 = await service.requestDelegateFromRpc({
    sourceHandle: "backend:main",
    targetAgent: "claude",
    task: "B",
    parallel: true,
  });

  expect(r2.status).toBe("queued");
  expect(harness.ensureCalls.length).toBe(0);
  expect(harness.dispatchCalls.length).toBe(0);
});

test("approveTask on parallel needs_confirmation task queues it when agent is at capacity", async () => {
  let idCounter = 0;
  const config = createConfig();
  config.orchestration.maxParallelTasksPerAgent = 1;
  config.orchestration.allowWorkerChainedRequests = true;
  const harness = makeDeps({
    config,
    createId: () => `id-${++idCounter}`,
    initialState: {
      ...createEmptyState(),
      orchestration: {
        tasks: {
          // Pre-seed a running parallel task that occupies the single slot
          "slot-filler": {
            taskId: "slot-filler",
            sourceHandle: "wx:user-1",
            sourceKind: "human" as const,
            coordinatorSession: "backend:main",
            workerSession: "backend:codex:p-slot",
            workspace: "backend",
            targetAgent: "codex",
            task: "filling the slot",
            status: "running" as const,
            ephemeralWorkerSession: true,
            summary: "",
            resultText: "",
            createdAt: "2026-04-13T10:00:00.000Z",
            updatedAt: "2026-04-13T10:00:00.000Z",
            eventSeq: 1,
            events: [],
          },
        },
        workerBindings: {
          // binding for the slot-filler session
          "backend:codex:p-slot": {
            sourceHandle: "backend:codex:p-slot",
            coordinatorSession: "backend:main",
            workspace: "backend",
            targetAgent: "codex",
            ephemeral: true,
          },
          // binding so worker-sourced delegation from claude is allowed
          "backend:claude:backend:main": {
            sourceHandle: "backend:claude:backend:main",
            coordinatorSession: "backend:main",
            workspace: "backend",
            targetAgent: "claude",
          },
        },
      },
    },
  });
  const service = new OrchestrationService(harness.deps);

  // Worker-sourced parallel delegation → needs_confirmation (not gated here)
  const delegated = await service.requestDelegateFromRpc({
    sourceHandle: "backend:claude:backend:main",
    targetAgent: "codex",
    task: "parallel worker task",
    parallel: true,
  });
  expect(delegated.status).toBe("needs_confirmation");

  harness.ensureCalls.length = 0;
  harness.dispatchCalls.length = 0;

  // Now approve the needs_confirmation task — cap is full (slot-filler running), should become queued
  const approved = await service.approveTask({
    taskId: delegated.taskId,
    coordinatorSession: "backend:main",
  });

  expect(approved.status).toBe("queued");
  expect(harness.ensureCalls.length).toBe(0);
  expect(harness.dispatchCalls.length).toBe(0);
});

test("approveTask on parallel needs_confirmation task starts it when agent has free capacity", async () => {
  let idCounter = 0;
  const config = createConfig();
  // Default cap (3) with no running parallel tasks → capacity is free
  config.orchestration.allowWorkerChainedRequests = true;
  const harness = makeDeps({
    config,
    createId: () => `id-${++idCounter}`,
    initialState: {
      ...createEmptyState(),
      orchestration: {
        tasks: {},
        workerBindings: {
          "backend:claude:backend:main": {
            sourceHandle: "backend:claude:backend:main",
            coordinatorSession: "backend:main",
            workspace: "backend",
            targetAgent: "claude",
          },
        },
      },
    },
  });
  const service = new OrchestrationService(harness.deps);

  // Worker-sourced parallel delegation → needs_confirmation
  const delegated = await service.requestDelegateFromRpc({
    sourceHandle: "backend:claude:backend:main",
    targetAgent: "codex",
    task: "parallel worker task",
    parallel: true,
  });
  expect(delegated.status).toBe("needs_confirmation");

  harness.ensureCalls.length = 0;
  harness.dispatchCalls.length = 0;

  // Approve — cap is 3 (default), no running parallel tasks → should run immediately
  const approved = await service.approveTask({
    taskId: delegated.taskId,
    coordinatorSession: "backend:main",
  });

  expect(approved.status).toBe("running");
  expect(harness.ensureCalls.length).toBe(1);
  expect(harness.dispatchCalls.length).toBe(1);
});

// ---------------------------------------------------------------------------
// Task 8: reconcileParallelSlots — slot teardown and queue draining
// ---------------------------------------------------------------------------

test("reconcileParallelSlots closes finished slots and drains the queue", async () => {
  let idCounter = 0;
  const config = createConfig();
  config.orchestration.maxParallelTasksPerAgent = 1;
  const harness = makeDeps({
    config,
    createId: () => `id-${++idCounter}`,
  });
  const service = new OrchestrationService(harness.deps);

  const mkDelegate = (task: string) =>
    service.requestDelegate({
      sourceHandle: "wx:user-1",
      sourceKind: "human",
      coordinatorSession: "backend:main",
      workspace: "backend",
      targetAgent: "codex",
      task,
      parallel: true,
    });

  // r1 -> running (slot occupied), r2 -> queued (cap = 1)
  const r1 = await mkDelegate("A");
  const r2 = await mkDelegate("B");
  expect(r1.status).toBe("running");
  expect(r2.status).toBe("queued");

  // Drive r1 to completed using the real mechanism: recordWorkerReply with
  // sourceHandle = the task's workerSession (which is how the service identifies the worker)
  await service.recordWorkerReply({
    taskId: r1.taskId,
    sourceHandle: r1.workerSession,
    status: "completed",
    summary: "done",
    resultText: "result",
  });

  // Verify r1 is now completed before reconcile
  const r1Task = await service.getTask(r1.taskId);
  expect(r1Task?.status).toBe("completed");

  // reconcile
  harness.dispatchCalls.length = 0;
  harness.ensureCalls.length = 0;
  await service.reconcileParallelSlots();

  // r1's ephemeral session must have been closed
  expect(harness.closeCalls.map((c) => c.workerSession)).toContain(r1.workerSession);

  // r2 must have been drained into running
  const r2Task = await service.getTask(r2.taskId);
  expect(r2Task?.status).toBe("running");

  // a status_changed event to running must have been appended for r2
  expect(
    (r2Task?.events ?? []).some((e) => e.type === "status_changed" && e.status === "running"),
  ).toBe(true);

  // ensure and dispatch must have been called for r2
  expect(harness.ensureCalls.some((c) => c.workerSession === r2.workerSession)).toBe(true);
  expect(harness.dispatchCalls.some((c) => c.taskId === r2.taskId)).toBe(true);
});

test("reconcileParallelSlots is idempotent and survives closeWorkerSession errors", async () => {
  let idCounter = 0;
  const config = createConfig();
  config.orchestration.maxParallelTasksPerAgent = 1;
  const harness = makeDeps({
    config,
    createId: () => `id-${++idCounter}`,
    closeWorkerSession: async () => {
      throw new Error("close failed");
    },
  });
  const service = new OrchestrationService(harness.deps);

  const r1 = await service.requestDelegate({
    sourceHandle: "wx:user-1",
    sourceKind: "human",
    coordinatorSession: "backend:main",
    workspace: "backend",
    targetAgent: "codex",
    task: "A",
    parallel: true,
  });
  expect(r1.status).toBe("running");

  // Drive r1 to completed
  await service.recordWorkerReply({
    taskId: r1.taskId,
    sourceHandle: r1.workerSession,
    status: "completed",
    summary: "done",
    resultText: "result",
  });

  // First reconcile: close throws, but reconcileParallelSlots must NOT rethrow
  await expect(service.reconcileParallelSlots()).resolves.toBeUndefined();
  expect(harness.closeCalls.length).toBe(1);

  // Second reconcile: ephemeralWorkerSessionClosed is already set, so must NOT close again
  await service.reconcileParallelSlots();
  expect(harness.closeCalls.length).toBe(1);
});

test("reconcileParallelSlots snapshots a legacy ephemeral binding before deleting it", async () => {
  const workerSession = "backend:codex:p-legacy";
  const harness = makeDeps({
    initialState: {
      ...createEmptyState(),
      orchestration: {
        tasks: {
          "task-legacy": {
            taskId: "task-legacy",
            sourceHandle: "wx:user-1",
            sourceKind: "human",
            coordinatorSession: "backend:main",
            workerSession,
            workspace: "backend",
            targetAgent: "codex",
            task: "legacy work",
            status: "completed",
            ephemeralWorkerSession: true,
            summary: "done",
            resultText: "done",
            createdAt: "2026-04-13T10:00:00.000Z",
            updatedAt: "2026-04-13T10:00:00.000Z",
            eventSeq: 0,
            events: [],
          },
        },
        workerBindings: {
          [workerSession]: {
            sourceHandle: workerSession,
            coordinatorSession: "backend:main",
            workspace: "backend",
            targetAgent: "codex",
            ephemeral: true,
          },
        },
      },
    },
  });
  const service = new OrchestrationService(harness.deps);

  await service.reconcileParallelSlots();

  expect(harness.closeCalls).toHaveLength(1);
  expect(harness.closeCalls[0]).toMatchObject({ workerSession });
  expect(harness.closeCalls[0]).toHaveProperty("guardAcpOutput", undefined);
});

test("reconcileParallelSlots drains multiple queued tasks for one agent in a single call", async () => {
  let idCounter = 0;
  const config = createConfig();
  config.orchestration.maxParallelTasksPerAgent = 2;
  const harness = makeDeps({
    config,
    createId: () => `id-${++idCounter}`,
  });
  const service = new OrchestrationService(harness.deps);

  const mkDelegate = (task: string) =>
    service.requestDelegate({
      sourceHandle: "wx:user-1",
      sourceKind: "human",
      coordinatorSession: "backend:main",
      workspace: "backend",
      targetAgent: "codex",
      task,
      parallel: true,
    });

  // r1, r2 -> running (cap = 2 filled); r3, r4 -> queued
  const r1 = await mkDelegate("A");
  const r2 = await mkDelegate("B");
  const r3 = await mkDelegate("C");
  const r4 = await mkDelegate("D");
  expect(r1.status).toBe("running");
  expect(r2.status).toBe("running");
  expect(r3.status).toBe("queued");
  expect(r4.status).toBe("queued");

  // Free both slots by completing r1 and r2
  for (const r of [r1, r2]) {
    await service.recordWorkerReply({
      taskId: r.taskId,
      sourceHandle: r.workerSession,
      status: "completed",
      summary: "done",
      resultText: "result",
    });
  }

  harness.dispatchCalls.length = 0;
  await service.reconcileParallelSlots();

  // Both queued tasks must have drained to running in this single call
  expect((await service.getTask(r3.taskId))?.status).toBe("running");
  expect((await service.getTask(r4.taskId))?.status).toBe("running");
  expect(harness.dispatchCalls.some((c) => c.taskId === r3.taskId)).toBe(true);
  expect(harness.dispatchCalls.some((c) => c.taskId === r4.taskId)).toBe(true);
});

test("reconcileParallelSlots drains a free agent's queue while leaving a full agent's queue alone", async () => {
  const config = createConfig();
  config.orchestration.maxParallelTasksPerAgent = 1;
  // Pre-seed: agent codex is at capacity (one running parallel task) with a
  // queued codex task waiting; agent claude has no running task and a queued
  // claude task — claude has free capacity, codex does not.
  const initialState = createEmptyState();
  initialState.orchestration.tasks = {
    "codex-running": {
      taskId: "codex-running",
      sourceHandle: "wx:user-1",
      sourceKind: "human",
      coordinatorSession: "backend:main",
      workerSession: "backend:codex:p-running",
      workspace: "backend",
      targetAgent: "codex",
      task: "codex running",
      status: "running",
      ephemeralWorkerSession: true,
      summary: "",
      resultText: "",
      createdAt: "2026-04-13T10:00:00.000Z",
      updatedAt: "2026-04-13T10:00:00.000Z",
      eventSeq: 1,
      events: [],
    },
    "codex-queued": {
      taskId: "codex-queued",
      sourceHandle: "wx:user-1",
      sourceKind: "human",
      coordinatorSession: "backend:main",
      workerSession: "backend:codex:p-queued",
      workspace: "backend",
      targetAgent: "codex",
      task: "codex queued",
      status: "queued",
      ephemeralWorkerSession: true,
      summary: "",
      resultText: "",
      createdAt: "2026-04-13T10:01:00.000Z",
      updatedAt: "2026-04-13T10:01:00.000Z",
      eventSeq: 1,
      events: [],
    },
    "claude-queued": {
      taskId: "claude-queued",
      sourceHandle: "wx:user-1",
      sourceKind: "human",
      coordinatorSession: "backend:main",
      workerSession: "backend:claude:p-queued",
      workspace: "backend",
      targetAgent: "claude",
      task: "claude queued",
      status: "queued",
      ephemeralWorkerSession: true,
      summary: "",
      resultText: "",
      createdAt: "2026-04-13T10:02:00.000Z",
      updatedAt: "2026-04-13T10:02:00.000Z",
      eventSeq: 1,
      events: [],
    },
  };
  initialState.orchestration.workerBindings = {
    "backend:codex:p-running": {
      sourceHandle: "backend:codex:p-running",
      coordinatorSession: "backend:main",
      workspace: "backend",
      targetAgent: "codex",
      ephemeral: true,
    },
  };
  const harness = makeDeps({ config, initialState });
  const service = new OrchestrationService(harness.deps);

  harness.dispatchCalls.length = 0;
  await service.reconcileParallelSlots();

  // Agent codex is still at capacity (codex-running never terminated) ->
  // codex-queued stays queued.
  expect((await service.getTask("codex-queued"))?.status).toBe("queued");
  expect(harness.dispatchCalls.some((c) => c.taskId === "codex-queued")).toBe(false);

  // Agent claude has free capacity -> claude-queued is drained to running and dispatched.
  expect((await service.getTask("claude-queued"))?.status).toBe("running");
  expect(harness.dispatchCalls.some((c) => c.taskId === "claude-queued")).toBe(true);
});

test("reconcileParallelSlots reverts the task to queued when ensureWorkerSession throws", async () => {
  const config = createConfig();
  config.orchestration.maxParallelTasksPerAgent = 1;
  // Pre-seed a single queued ephemeral parallel task and no running task — the
  // agent has free capacity, so Phase 3 will pick this task up. ensureWorkerSession
  // is wired to throw, exercising the rollback path.
  const initialState = createEmptyState();
  initialState.orchestration.tasks = {
    "codex-queued": {
      taskId: "codex-queued",
      sourceHandle: "wx:user-1",
      sourceKind: "human",
      coordinatorSession: "backend:main",
      workerSession: "backend:codex:p-queued",
      workspace: "backend",
      targetAgent: "codex",
      task: "codex queued",
      status: "queued",
      ephemeralWorkerSession: true,
      summary: "",
      resultText: "",
      createdAt: "2026-04-13T10:00:00.000Z",
      updatedAt: "2026-04-13T10:00:00.000Z",
      eventSeq: 1,
      events: [],
    },
  };
  const harness = makeDeps({
    config,
    initialState,
    ensureWorkerSession: async () => {
      throw new Error("ensure failed");
    },
  });
  const service = new OrchestrationService(harness.deps);

  // reconcile must NOT throw out — rollback runs internally.
  await expect(service.reconcileParallelSlots()).resolves.toBeUndefined();

  // (a) Task ended up back at queued.
  const task = await service.getTask("codex-queued");
  expect(task?.status).toBe("queued");

  // (b) Its workerBindings entry is gone.
  expect(harness.getState().orchestration.workerBindings["backend:codex:p-queued"]).toBeUndefined();

  // (c) dispatchWorkerTask was NOT called for this task.
  expect(harness.dispatchCalls.some((c) => c.taskId === "codex-queued")).toBe(false);

  // (d) A status_changed → queued event with the re-queued message is present.
  expect(
    (task?.events ?? []).some(
      (e) =>
        e.type === "status_changed" &&
        e.status === "queued" &&
        e.message === "Task re-queued after drain failure",
    ),
  ).toBe(true);
});

// ---------------------------------------------------------------------------
// Task 9 (review fixes): I-1 TOCTOU, I-2 cancel trigger, I-3 spurious close
// ---------------------------------------------------------------------------

// I-1: TOCTOU — pending counter prevents cap overshoot
test("I-1: TOCTOU — pending parallel start counter prevents a concurrent delegation from exceeding the cap", async () => {
  // Scenario: cap=1. Two delegations race. The first passes the gate and hangs at
  // ensureWorkerSession (deferred). The second delegation runs the gate while the
  // first is still in flight — the pending counter must make the gate see the
  // slot as taken, forcing the second delegation to queue.

  const config = createConfig();
  config.orchestration.maxParallelTasksPerAgent = 1;

  let idCounter = 0;
  const firstDeferred = createDeferred<string>();
  let ensureCallCount = 0;

  const harness = makeDeps({
    config,
    createId: () => `id-${++idCounter}`,
    ensureWorkerSession: async (request) => {
      ensureCallCount += 1;
      if (ensureCallCount === 1) {
        // First call: hang until the deferred resolves (simulates slow I/O)
        await firstDeferred.promise;
      }
      return request.workerSession;
    },
  });
  const service = new OrchestrationService(harness.deps);

  // Start first delegation (parallel). It will pass the gate and hang at
  // ensureWorkerSession. We do NOT await it yet.
  const first = service.requestDelegate({
    sourceHandle: "wx:user-1",
    sourceKind: "human",
    coordinatorSession: "backend:main",
    workspace: "backend",
    targetAgent: "codex",
    task: "A",
    parallel: true,
  });

  // Yield until the first delegation's ensureWorkerSession call is in flight.
  for (let attempt = 0; attempt < 50 && ensureCallCount < 1; attempt += 1) {
    await Bun.sleep(0);
  }
  expect(ensureCallCount).toBe(1);

  // Now start the second delegation while first is hanging at ensure.
  // The pending counter must make the gate see the slot as occupied → second must queue.
  const r2 = await service.requestDelegate({
    sourceHandle: "wx:user-2",
    sourceKind: "human",
    coordinatorSession: "backend:main",
    workspace: "backend",
    targetAgent: "codex",
    task: "B",
    parallel: true,
  });
  expect(r2.status).toBe("queued");

  // Unblock the first delegation and let it complete.
  firstDeferred.resolve("ok");
  const r1 = await first;
  expect(r1.status).toBe("running");

  // Verify state: exactly one running parallel task (r1) and one queued (r2).
  const tasks = Object.values(harness.getState().orchestration.tasks);
  const running = tasks.filter((t) => t.ephemeralWorkerSession === true && t.status === "running");
  const queued = tasks.filter((t) => t.ephemeralWorkerSession === true && t.status === "queued");
  expect(running.length).toBe(1);
  expect(queued.length).toBe(1);
});

// I-2: cancelling a blocked ephemeral parallel task triggers reconcileParallelSlots
test("I-2: cancelling a blocked parallel task triggers reconcileParallelSlots and closes the session", async () => {
  const config = createConfig();
  config.orchestration.maxParallelTasksPerAgent = 1;
  let idCounter = 0;
  const harness = makeDeps({
    config,
    createId: () => `id-${++idCounter}`,
    initialState: {
      ...createEmptyState(),
      orchestration: {
        tasks: {
          // A running parallel task that will become blocked
          "blocked-task": {
            taskId: "blocked-task",
            sourceHandle: "wx:user-1",
            sourceKind: "human" as const,
            coordinatorSession: "backend:main",
            workerSession: "backend:codex:p-slot",
            workspace: "backend",
            targetAgent: "codex",
            task: "blocked work",
            status: "blocked" as const,
            ephemeralWorkerSession: true,
            summary: "",
            resultText: "",
            createdAt: "2026-04-13T10:00:00.000Z",
            updatedAt: "2026-04-13T10:00:00.000Z",
            eventSeq: 1,
            events: [],
            openQuestion: {
              questionId: "q1",
              question: "what should I do?",
              whyBlocked: "need guidance",
              whatIsNeeded: "direction",
              askedAt: "2026-04-13T10:00:00.000Z",
              status: "open" as const,
            },
          },
          // A queued task waiting for the slot
          "queued-task": {
            taskId: "queued-task",
            sourceHandle: "wx:user-2",
            sourceKind: "human" as const,
            coordinatorSession: "backend:main",
            workerSession: "backend:codex:p-queued",
            workspace: "backend",
            targetAgent: "codex",
            task: "queued work",
            status: "queued" as const,
            ephemeralWorkerSession: true,
            summary: "",
            resultText: "",
            createdAt: "2026-04-13T10:01:00.000Z",
            updatedAt: "2026-04-13T10:01:00.000Z",
            eventSeq: 1,
            events: [],
          },
        },
        workerBindings: {
          "backend:codex:p-slot": {
            sourceHandle: "backend:codex:p-slot",
            coordinatorSession: "backend:main",
            workspace: "backend",
            targetAgent: "codex",
            ephemeral: true,
          },
        },
      },
    },
  });
  const service = new OrchestrationService(harness.deps);

  // Cancel the blocked task (non-running cancel path — should trigger reconcile)
  await service.requestTaskCancellation({
    taskId: "blocked-task",
    coordinatorSession: "backend:main",
  });

  // Yield to let any async reconcile fire
  for (let attempt = 0; attempt < 20 && harness.closeCalls.length < 1; attempt += 1) {
    await Bun.sleep(0);
  }

  // The blocked task's ephemeral session must have been closed (I-2 trigger)
  expect(harness.closeCalls.map((c) => c.workerSession)).toContain("backend:codex:p-slot");
});

// I-3: cancelling a queued parallel task must NOT call closeWorkerSession
test("I-3: cancelling a queued parallel task does NOT invoke closeWorkerSession for the never-started session", async () => {
  const config = createConfig();
  config.orchestration.maxParallelTasksPerAgent = 1;
  let idCounter = 0;
  const harness = makeDeps({
    config,
    createId: () => `id-${++idCounter}`,
    initialState: {
      ...createEmptyState(),
      orchestration: {
        tasks: {
          // The slot-filler occupies the only slot
          "running-task": {
            taskId: "running-task",
            sourceHandle: "wx:user-1",
            sourceKind: "human" as const,
            coordinatorSession: "backend:main",
            workerSession: "backend:codex:p-running",
            workspace: "backend",
            targetAgent: "codex",
            task: "running work",
            status: "running" as const,
            ephemeralWorkerSession: true,
            summary: "",
            resultText: "",
            createdAt: "2026-04-13T10:00:00.000Z",
            updatedAt: "2026-04-13T10:00:00.000Z",
            eventSeq: 1,
            events: [],
          },
          // Queued task — no acpx session was ever started for it
          "queued-task": {
            taskId: "queued-task",
            sourceHandle: "wx:user-2",
            sourceKind: "human" as const,
            coordinatorSession: "backend:main",
            workerSession: "backend:codex:p-queued",
            workspace: "backend",
            targetAgent: "codex",
            task: "queued work",
            status: "queued" as const,
            ephemeralWorkerSession: true,
            summary: "",
            resultText: "",
            createdAt: "2026-04-13T10:01:00.000Z",
            updatedAt: "2026-04-13T10:01:00.000Z",
            eventSeq: 1,
            events: [],
          },
        },
        workerBindings: {
          // Only the running task has a binding; queued task has none
          "backend:codex:p-running": {
            sourceHandle: "backend:codex:p-running",
            coordinatorSession: "backend:main",
            workspace: "backend",
            targetAgent: "codex",
            ephemeral: true,
          },
        },
      },
    },
  });
  const service = new OrchestrationService(harness.deps);

  // Cancel the queued task
  await service.requestTaskCancellation({
    taskId: "queued-task",
    coordinatorSession: "backend:main",
  });

  // Yield to allow any async reconcile to fire
  for (let attempt = 0; attempt < 20; attempt += 1) {
    await Bun.sleep(0);
  }

  // closeWorkerSession must NOT have been called for the queued task's session
  expect(harness.closeCalls.map((c) => c.workerSession)).not.toContain("backend:codex:p-queued");

  // The queued task must be cancelled
  const task = await service.getTask("queued-task");
  expect(task?.status).toBe("cancelled");
});

test("requestTaskCancellation succeeds when task has legacy reset-suffixed coordinatorSession and caller uses stable id", async () => {
  // A task stored with a `:reset-<digits>` suffix on its coordinatorSession (legacy state.json record)
  // must be manageable by a coordinator presenting the stable (stripped) identity.
  const harness = makeDeps({
    initialState: {
      ...createEmptyState(),
      orchestration: {
        tasks: {
          "task-reset-owner": {
            taskId: "task-reset-owner",
            sourceHandle: "wx:user-1",
            sourceKind: "human" as const,
            coordinatorSession: "ws:alias:reset-1700000000000",
            workerSession: "backend:claude:worker-1",
            workspace: "backend",
            targetAgent: "claude",
            task: "some delegated work",
            status: "running" as const,
            summary: "",
            resultText: "",
            createdAt: "2026-04-13T10:00:00.000Z",
            updatedAt: "2026-04-13T10:00:00.000Z",
            eventSeq: 1,
            events: [],
          },
        },
        workerBindings: {},
      },
    },
  });
  const service = new OrchestrationService(harness.deps);

  // Stable coordinator id (no :reset- suffix) must be accepted for a task
  // whose stored coordinatorSession carries the legacy reset suffix.
  const result = await service.requestTaskCancellation({
    taskId: "task-reset-owner",
    coordinatorSession: "ws:alias",
  });

  expect(result.status).toBe("running");
  expect(result.cancelRequestedAt).toBeDefined();
});

test("requestDelegateFromRpc succeeds when session has reset-suffixed transport_session and sourceHandle is stable id", async () => {
  // Regression test for Fix 1: after /clear, the session record carries
  // `transport_session: "ws:alias:reset-<ts>"` but the MCP queue-owner
  // (sourceHandle) is the stable id "ws:alias". resolveRpcSourceContext must
  // normalize both sides of the find so the delegation does NOT throw
  // "is not a registered coordinator or worker session".
  const harness = makeDeps({
    createId: () => "task-rpc-reset-fix",
    reusableWorkerSession: "ws:claude:ws:alias",
    initialState: {
      ...createEmptyState(),
      sessions: {
        main: {
          alias: "main",
          agent: "claude",
          workspace: "ws",
          transport_session: "ws:alias:reset-1700000000000",
          created_at: "2026-04-13T10:00:00.000Z",
          last_used_at: "2026-04-13T10:00:00.000Z",
        },
      },
    },
  });
  const service = new OrchestrationService(harness.deps);

  // sourceHandle is the stable id (no :reset- suffix) — as baked by the MCP
  // queue-owner registration in command-router.ts
  const result = await service.requestDelegateFromRpc({
    sourceHandle: "ws:alias",
    targetAgent: "claude",
    task: "implement the feature",
  });

  expect(result.taskId).toBe("task-rpc-reset-fix");
  expect(result.status).toBe("running");

  // Wait for the async dispatch to fire
  for (let attempt = 0; attempt < 20 && harness.dispatchCalls.length === 0; attempt += 1) {
    await Bun.sleep(0);
  }

  const task = harness.getState().orchestration.tasks["task-rpc-reset-fix"];
  // The task must record the stable coordinator session (not the reset-suffixed one)
  expect(task).toMatchObject({
    sourceHandle: "ws:alias",
    sourceKind: "coordinator",
    coordinatorSession: "ws:alias",
    workspace: "ws",
    targetAgent: "claude",
    status: "running",
  });
});

// Boundary-normalization regressions: every coordinator-ownership read must
// recognize a task/group whose stored coordinatorSession carries a legacy
// `:reset-<digits>` suffix when queried with the stable id, exactly like the
// blocking/cancellation paths already do. Before centralizing comparisons on
// sameCoordinatorSession these readers used a raw `===` and silently dropped
// such records, producing "blocked but unlistable / uncancellable" deadlocks.
function makeResetOwnedTaskState() {
  return {
    ...createEmptyState(),
    orchestration: {
      tasks: {
        "legacy-running": {
          taskId: "legacy-running",
          sourceHandle: "wx:user-1",
          sourceKind: "human" as const,
          coordinatorSession: "ws:alias:reset-1700000000000",
          workerSession: "backend:claude:worker-1",
          workspace: "backend",
          targetAgent: "claude",
          task: "in flight",
          status: "running" as const,
          summary: "",
          resultText: "",
          createdAt: "2026-04-13T10:00:00.000Z",
          updatedAt: "2026-04-13T10:00:00.000Z",
          eventSeq: 1,
          events: [],
        },
        "legacy-terminal": {
          taskId: "legacy-terminal",
          sourceHandle: "wx:user-1",
          sourceKind: "human" as const,
          coordinatorSession: "ws:alias:reset-1700000000000",
          workerSession: "backend:claude:worker-2",
          workspace: "backend",
          targetAgent: "claude",
          task: "done work",
          status: "completed" as const,
          summary: "done",
          resultText: "result",
          createdAt: "2026-04-13T10:00:00.000Z",
          updatedAt: "2026-04-13T10:05:00.000Z",
          injectionPending: true,
        },
      },
      workerBindings: {},
      groups: {
        "legacy-group": {
          groupId: "legacy-group",
          coordinatorSession: "ws:alias:reset-1700000000000",
          title: "legacy",
          createdAt: "2026-04-13T10:00:00.000Z",
          updatedAt: "2026-04-13T10:00:00.000Z",
        },
      },
    },
  } as AppState;
}

test("listTasks with stable id returns a task stored under a legacy reset-suffixed coordinatorSession", async () => {
  const harness = makeDeps({ initialState: makeResetOwnedTaskState() });
  const service = new OrchestrationService(harness.deps);

  const tasks = await service.listTasks({ coordinatorSession: "ws:alias" });

  expect(tasks.map((task) => task.taskId).sort()).toEqual(["legacy-running", "legacy-terminal"]);
});

test("cleanTasks with stable id removes a terminal task stored under a legacy reset-suffixed coordinatorSession", async () => {
  const harness = makeDeps({ initialState: makeResetOwnedTaskState() });
  const service = new OrchestrationService(harness.deps);

  const result = await service.cleanTasks("ws:alias");

  expect(result.removedTasks).toBe(1);
  expect(harness.getState().orchestration.tasks["legacy-terminal"]).toBeUndefined();
  expect(harness.getState().orchestration.tasks["legacy-running"]).toBeDefined();
});

test("listPendingCoordinatorResults with stable id returns a result stored under a legacy reset-suffixed coordinatorSession", async () => {
  const harness = makeDeps({ initialState: makeResetOwnedTaskState() });
  const service = new OrchestrationService(harness.deps);

  const pending = await service.listPendingCoordinatorResults("ws:alias");

  expect(pending.map((task) => task.taskId)).toEqual(["legacy-terminal"]);
});

test("getGroupSummary/listGroupSummaries with stable id find a group stored under a legacy reset-suffixed coordinatorSession", async () => {
  const harness = makeDeps({ initialState: makeResetOwnedTaskState() });
  const service = new OrchestrationService(harness.deps);

  const summary = await service.getGroupSummary({
    groupId: "legacy-group",
    coordinatorSession: "ws:alias",
  });
  expect(summary).not.toBeNull();

  const summaries = await service.listGroupSummaries({ coordinatorSession: "ws:alias" });
  expect(summaries.map((summary) => summary.group.groupId)).toEqual(["legacy-group"]);
});
