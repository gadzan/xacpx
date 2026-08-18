import { expect, test } from "bun:test";

import {
  createMemoryTransport,
  createOrchestrationTransport,
  type XacpxMcpTaskIdArgs,
} from "../../../src/mcp/xacpx-mcp-transport";

test("createMemoryTransport delegates and exposes override hooks", async () => {
  const calls: unknown[] = [];
  const transport = createMemoryTransport(
    async (input) => {
      calls.push(input);
      return { taskId: "task-1", status: "needs_confirmation" };
    },
    {
      getTask: async (input) => {
        calls.push(input);
        return null;
      },
      watchTask: async (input) => {
        calls.push(input);
        return { status: "timeout", task: null, events: [], nextAfterSeq: input.afterSeq ?? 0 };
      },
      workerRaiseQuestion: async (input) => {
        calls.push(input);
        return { taskId: "task-1", questionId: "question-1", status: "blocked" };
      },
    },
  );

  await expect(
    transport.delegateRequest({
      coordinatorSession: "backend:main",
      targetAgent: "claude",
      task: "review",
      groupId: "group-1",
    }),
  ).resolves.toEqual({ taskId: "task-1", status: "needs_confirmation" });
  await expect(
    transport.getTask({ coordinatorSession: "backend:main", taskId: "task-1" }),
  ).resolves.toBeNull();
  await expect(
    transport.watchTask({ coordinatorSession: "backend:main", taskId: "task-1", afterSeq: 1, mode: "next_event" }),
  ).resolves.toEqual({ status: "timeout", task: null, events: [], nextAfterSeq: 1 });
  await expect(
    transport.workerRaiseQuestion({
      sourceHandle: "backend:worker",
      taskId: "task-1",
      question: "Need environment details",
      whyBlocked: "Requirement is ambiguous",
      whatIsNeeded: "Clarify the target environment",
    }),
  ).resolves.toEqual({
    taskId: "task-1",
    questionId: "question-1",
    status: "blocked",
  });

  expect(calls).toEqual([
    {
      coordinatorSession: "backend:main",
      targetAgent: "claude",
      task: "review",
      groupId: "group-1",
    },
    { coordinatorSession: "backend:main", taskId: "task-1" },
    { coordinatorSession: "backend:main", taskId: "task-1", afterSeq: 1, mode: "next_event" },
    {
      sourceHandle: "backend:worker",
      taskId: "task-1",
      question: "Need environment details",
      whyBlocked: "Requirement is ambiguous",
      whatIsNeeded: "Clarify the target environment",
    },
  ]);
});

test("createOrchestrationTransport maps coordinator-scoped MCP calls onto the RPC client", async () => {
  const calls: Array<{ method: string; input: unknown }> = [];
  const taskRecord = {
    taskId: "task-1",
    sourceHandle: "backend:main",
    sourceKind: "coordinator" as const,
    coordinatorSession: "backend:main",
    workspace: "backend",
    targetAgent: "claude",
    task: "review",
    status: "running" as const,
    summary: "",
    resultText: "",
    createdAt: "a",
    updatedAt: "a",
  };
  const fakeClient = {
    delegateRequest: async (input: unknown) => {
      calls.push({ method: "delegateRequest", input });
      return { taskId: "task-1", status: "needs_confirmation" as const };
    },
    createGroup: async (input: unknown) => {
      calls.push({ method: "createGroup", input });
      return {
        groupId: "g-1",
        coordinatorSession: "backend:main",
        title: "parallel review",
        createdAt: "a",
        updatedAt: "a",
      };
    },
    getTaskForCoordinator: async (input: unknown) => {
      calls.push({ method: "getTaskForCoordinator", input });
      return taskRecord;
    },
    listTasks: async (input: unknown) => {
      calls.push({ method: "listTasks", input });
      return [taskRecord];
    },
    approveTask: async (input: unknown) => {
      calls.push({ method: "approveTask", input });
      return taskRecord;
    },
    cancelTaskForCoordinator: async (input: unknown) => {
      calls.push({ method: "cancelTaskForCoordinator", input });
      return { ...taskRecord, status: "cancelled" as const };
    },
    watchTask: async (input: unknown) => {
      calls.push({ method: "watchTask", input });
      return { status: "event" as const, task: taskRecord, events: [], nextAfterSeq: 1 };
    },
    workerRaiseQuestion: async (input: unknown) => {
      calls.push({ method: "workerRaiseQuestion", input });
      return { taskId: "task-1", questionId: "question-1", status: "blocked" as const };
    },
    coordinatorAnswerQuestion: async (input: unknown) => {
      calls.push({ method: "coordinatorAnswerQuestion", input });
      return { ...taskRecord, status: "running" as const };
    },
    coordinatorRequestHumanInput: async (input: unknown) => {
      calls.push({ method: "coordinatorRequestHumanInput", input });
      return { packageId: "package-1", queuedTaskIds: ["task-2"] };
    },
    coordinatorReviewContestedResult: async (input: unknown) => {
      calls.push({ method: "coordinatorReviewContestedResult", input });
      return { ...taskRecord, status: "blocked" as const };
    },
    agentList: async (input: unknown) => {
      calls.push({ method: "agentList", input });
      return [];
    },
    agentSend: async (input: unknown) => {
      calls.push({ method: "agentSend", input });
      return {
        messageId: "msg-1",
        status: "queued" as const,
        modeUsed: "queue" as const,
        route: "local" as const,
      };
    },
  };

  const transport = createOrchestrationTransport(
    { kind: "unix", path: "/tmp/test.sock" },
    { client: fakeClient },
  );
  const taskArgs: XacpxMcpTaskIdArgs = { coordinatorSession: "backend:main", taskId: "task-1" };

  await transport.delegateRequest({
    coordinatorSession: "backend:main",
    sourceHandle: "backend:main:worker",
    targetAgent: "claude",
    task: "review",
    workingDirectory: "/repo/weacpx",
    role: "reviewer",
  });
  await transport.getTask(taskArgs);
  await transport.listTasks({
    coordinatorSession: "backend:main",
    status: "running",
    stuck: true,
    sort: "createdAt",
    order: "asc",
  });
  await transport.approveTask(taskArgs);
  await transport.cancelTask(taskArgs);
  await transport.watchTask({
    coordinatorSession: "backend:main",
    taskId: "task-1",
    afterSeq: 1,
    mode: "next_event",
  });
  await transport.workerRaiseQuestion({
    sourceHandle: "backend:worker",
    taskId: "task-1",
    question: "Need environment details",
    whyBlocked: "Requirement is ambiguous",
    whatIsNeeded: "Clarify the target environment",
  });
  await transport.coordinatorAnswerQuestion({
    coordinatorSession: "backend:main",
    taskId: "task-1",
    questionId: "question-1",
    answer: "Use the staging environment.",
  });
  await transport.coordinatorRequestHumanInput({
    coordinatorSession: "backend:main",
    taskQuestions: [{ taskId: "task-1", questionId: "question-1" }],
    promptText: "Please confirm the target environment.",
    expectedActivePackageId: "package-0",
  });
  await transport.coordinatorReviewContestedResult({
    coordinatorSession: "backend:main",
    taskId: "task-1",
    reviewId: "review-1",
    decision: "discard",
  });
  await transport.listAgentEndpoints({
    coordinatorSession: "backend:main",
    sourceHandle: "backend:worker",
  });
  await transport.sendAgentMessage({
    coordinatorSession: "backend:main",
    sourceHandle: "backend:worker",
    to: "agent:node-local:endpoint-peer",
    message: "schema changed",
    mode: "queue",
    replyTo: "msg-prior",
  });

  expect(calls).toEqual([
    {
      method: "delegateRequest",
      input: {
        sourceHandle: "backend:main:worker",
        targetAgent: "claude",
        task: "review",
        cwd: "/repo/weacpx",
        role: "reviewer",
      },
    },
    { method: "getTaskForCoordinator", input: taskArgs },
    {
      method: "listTasks",
      input: {
        coordinatorSession: "backend:main",
        status: "running",
        stuck: true,
        sort: "createdAt",
        order: "asc",
      },
    },
    { method: "approveTask", input: taskArgs },
    { method: "cancelTaskForCoordinator", input: taskArgs },
    {
      method: "watchTask",
      input: {
        coordinatorSession: "backend:main",
        taskId: "task-1",
        afterSeq: 1,
        mode: "next_event",
      },
    },
    {
      method: "workerRaiseQuestion",
      input: {
        taskId: "task-1",
        sourceHandle: "backend:worker",
        question: "Need environment details",
        whyBlocked: "Requirement is ambiguous",
        whatIsNeeded: "Clarify the target environment",
      },
    },
    {
      method: "coordinatorAnswerQuestion",
      input: {
        coordinatorSession: "backend:main",
        taskId: "task-1",
        questionId: "question-1",
        answer: "Use the staging environment.",
      },
    },
    {
      method: "coordinatorRequestHumanInput",
      input: {
        coordinatorSession: "backend:main",
        taskQuestions: [{ taskId: "task-1", questionId: "question-1" }],
        promptText: "Please confirm the target environment.",
        expectedActivePackageId: "package-0",
      },
    },
    {
      method: "coordinatorReviewContestedResult",
      input: {
        coordinatorSession: "backend:main",
        taskId: "task-1",
        reviewId: "review-1",
        decision: "discard",
      },
    },
    {
      method: "agentList",
      input: {
        coordinatorSession: "backend:main",
        sourceHandle: "backend:worker",
      },
    },
    {
      method: "agentSend",
      input: {
        coordinatorSession: "backend:main",
        sourceHandle: "backend:worker",
        to: "agent:node-local:endpoint-peer",
        message: "schema changed",
        mode: "queue",
        replyTo: "msg-prior",
      },
    },
  ]);
});

test("createOrchestrationTransport maps scheduledList/scheduledCancel onto the RPC client", async () => {
  const calls: Array<{ method: string; input: unknown }> = [];
  const fakeClient = {
    delegateRequest: async () => ({ taskId: "task-1", status: "needs_confirmation" as const }),
    createGroup: async () => ({ groupId: "g-1", coordinatorSession: "backend:main", title: "t", createdAt: "a", updatedAt: "a" }),
    getTaskForCoordinator: async () => null,
    listTasks: async () => [],
    approveTask: async () => {
      throw new Error("unused");
    },
    cancelTaskForCoordinator: async () => {
      throw new Error("unused");
    },
    workerRaiseQuestion: async () => {
      throw new Error("unused");
    },
    coordinatorAnswerQuestion: async () => {
      throw new Error("unused");
    },
    coordinatorRequestHumanInput: async () => {
      throw new Error("unused");
    },
    coordinatorReviewContestedResult: async () => {
      throw new Error("unused");
    },
    scheduledList: async (input: unknown) => {
      calls.push({ method: "scheduledList", input });
      return [
        {
          id: "k8f2",
          chat_key: "wx:user",
          session_alias: "main",
          session_mode: "temp" as const,
          execute_at: "2026-05-25T02:00:00.000Z",
          message: "检查 CI",
          status: "pending" as const,
          created_at: "2026-05-25T00:00:00.000Z",
        },
      ];
    },
    scheduledCancel: async (input: unknown) => {
      calls.push({ method: "scheduledCancel", input });
      return { id: "k8f2", cancelled: true };
    },
  };

  const transport = createOrchestrationTransport({ kind: "unix", path: "/tmp/test.sock" }, { client: fakeClient });

  await expect(transport.scheduledList({ coordinatorSession: "backend:main" })).resolves.toHaveLength(1);
  await expect(
    transport.scheduledCancel({ coordinatorSession: "backend:main", id: "k8f2" }),
  ).resolves.toEqual({ id: "k8f2", cancelled: true });

  expect(calls).toEqual([
    { method: "scheduledList", input: { coordinatorSession: "backend:main" } },
    { method: "scheduledCancel", input: { coordinatorSession: "backend:main", id: "k8f2" } },
  ]);
});

test("createOrchestrationTransport scheduledList/scheduledCancel fail clearly when the client lacks them", async () => {
  const fakeClient = {
    delegateRequest: async () => ({ taskId: "task-1", status: "needs_confirmation" as const }),
    createGroup: async () => ({ groupId: "g-1", coordinatorSession: "backend:main", title: "t", createdAt: "a", updatedAt: "a" }),
    getTaskForCoordinator: async () => null,
    listTasks: async () => [],
    approveTask: async () => {
      throw new Error("unused");
    },
    cancelTaskForCoordinator: async () => {
      throw new Error("unused");
    },
    workerRaiseQuestion: async () => {
      throw new Error("unused");
    },
    coordinatorAnswerQuestion: async () => {
      throw new Error("unused");
    },
    coordinatorRequestHumanInput: async () => {
      throw new Error("unused");
    },
    coordinatorReviewContestedResult: async () => {
      throw new Error("unused");
    },
  };

  const transport = createOrchestrationTransport({ kind: "unix", path: "/tmp/test.sock" }, { client: fakeClient });

  await expect(transport.scheduledList({ coordinatorSession: "backend:main" })).rejects.toThrow(/scheduledList is not configured/);
  await expect(
    transport.scheduledCancel({ coordinatorSession: "backend:main", id: "k8f2" }),
  ).rejects.toThrow(/scheduledCancel is not configured/);
});

test("createOrchestrationTransport workerRaiseQuestion fails clearly when no injected sourceHandle is provided", async () => {
  const calls: unknown[] = [];
  const fakeClient = {
    delegateRequest: async () => ({ taskId: "task-1", status: "needs_confirmation" as const }),
    createGroup: async () => ({
      groupId: "g-1",
      coordinatorSession: "backend:main",
      title: "parallel review",
      createdAt: "a",
      updatedAt: "a",
    }),
    getTaskForCoordinator: async () => null,
    listTasks: async () => [],
    approveTask: async () => {
      throw new Error("unused");
    },
    cancelTaskForCoordinator: async () => {
      throw new Error("unused");
    },
    workerRaiseQuestion: async (input: unknown) => {
      calls.push(input);
      return { taskId: "task-1", questionId: "question-1", status: "blocked" as const };
    },
    coordinatorAnswerQuestion: async () => {
      throw new Error("unused");
    },
    coordinatorRequestHumanInput: async () => {
      throw new Error("unused");
    },
    coordinatorReviewContestedResult: async () => {
      throw new Error("unused");
    },
  };

  const transport = createOrchestrationTransport(
    { kind: "unix", path: "/tmp/test.sock" },
    { client: fakeClient },
  );

  await expect(
    transport.workerRaiseQuestion({
      taskId: "task-1",
      question: "Need environment details",
      whyBlocked: "Requirement is ambiguous",
      whatIsNeeded: "Clarify the target environment",
    }),
  ).rejects.toThrow(/sourceHandle/i);
  expect(calls).toEqual([]);
});

test("createMemoryTransport exposes agent messaging override hooks", async () => {
  const calls: unknown[] = [];
  const transport = createMemoryTransport(
    async () => ({ taskId: "task-1", status: "running" }),
    {
      listAgentEndpoints: async (input) => {
        calls.push(input);
        return [
          {
            address: { nodeId: "node-local", endpointId: "endpoint-peer" },
            handle: "agent:node-local:endpoint-peer",
            node: "node-local",
            agent: "codex",
            state: "idle",
            capabilities: { receive: true, steer: false, queue: true, interrupt: false },
          },
        ];
      },
      sendAgentMessage: async (input) => {
        calls.push(input);
        return {
          messageId: "msg-1",
          status: "queued",
          modeUsed: "queue",
          route: "local",
        };
      },
    },
  );

  await expect(
    transport.listAgentEndpoints({ coordinatorSession: "backend:main", sourceHandle: "worker-a" }),
  ).resolves.toHaveLength(1);
  await expect(
    transport.sendAgentMessage({
      coordinatorSession: "backend:main",
      sourceHandle: "worker-a",
      to: "agent:node-local:endpoint-peer",
      message: "schema changed",
      mode: "auto",
      replyTo: "msg-prior",
    }),
  ).resolves.toEqual({
    messageId: "msg-1",
    status: "queued",
    modeUsed: "queue",
    route: "local",
  });

  expect(calls).toEqual([
    { coordinatorSession: "backend:main", sourceHandle: "worker-a" },
    {
      coordinatorSession: "backend:main",
      sourceHandle: "worker-a",
      to: "agent:node-local:endpoint-peer",
      message: "schema changed",
      mode: "auto",
      replyTo: "msg-prior",
    },
  ]);
});
