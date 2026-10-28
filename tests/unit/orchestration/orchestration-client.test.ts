import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  getWatchRequestTimeoutMs,
  OrchestrationClient,
  OrchestrationClientError,
} from "../../../src/orchestration/orchestration-client";
import { AgentMessagingError } from "../../../src/orchestration/agent-messaging-error";
import { resolveOrchestrationEndpoint } from "../../../src/orchestration/orchestration-ipc";
import { OrchestrationServer } from "../../../src/orchestration/orchestration-server";
import { skipIfLocalIpcUnavailable } from "../../helpers/ipc-capability";
import { createOrchestrationTransport } from "../../../src/mcp/xacpx-mcp-transport";
import { PeerService } from "../../../src/peer/peer-service";
import { PeerStore } from "../../../src/peer/peer-store";
import type { ResolvedSession } from "../../../src/transport/types";

test("task watch RPC timeout follows one minute default and twenty minute cap", () => {
  expect(getWatchRequestTimeoutMs(undefined, 30_000)).toBe(65_000);
  expect(getWatchRequestTimeoutMs(1_200_000, 30_000)).toBe(1_205_000);
  expect(getWatchRequestTimeoutMs(9_999_999, 30_000)).toBe(1_205_000);
});

test("agent client methods forward trusted binding and message fields", async () => {
  if (await skipIfLocalIpcUnavailable("orchestration-client socket integration tests")) return;

  const dir = await mkdtemp(join(tmpdir(), "weacpx-orch-agent-client-"));
  const endpoint = resolveOrchestrationEndpoint(dir);
  const listInputs: unknown[] = [];
  const sendInputs: unknown[] = [];
  const resultInputs: unknown[] = [];
  const server = new OrchestrationServer(
    endpoint,
    {
      requestDelegate: async () => ({ taskId: "task-1", status: "needs_confirmation" }),
      getTask: async () => null,
      listTasks: async () => [],
      approveTask: async (input) => ({ taskId: input.taskId }) as never,
      cancelTask: async (input) => ({ taskId: input.taskId }) as never,
      recordWorkerReply: async () => ({ taskId: "task-1" }) as never,
    },
    {
      groupReadResult: async (input) => { resultInputs.push(input); return { kind: "catalog", assignments: [], nextOffset: null }; },
      agentMessaging: {
        listReachable: async (binding) => {
          listInputs.push(binding);
          return [
            {
              address: { nodeId: "node-local", endpointId: "endpoint-worker" },
              handle: "agent:node-local:endpoint-worker",
              node: "node-local",
              agent: "codex",
              state: "idle",
              capabilities: { receive: true, steer: false, queue: true, interrupt: false },
            },
          ];
        },
        send: async (binding, input) => {
          sendInputs.push({ binding, input });
          return {
            messageId: "msg-1",
            status: "queued",
            modeUsed: "queue",
            route: "local",
          };
        },
      },
    },
  );
  const client = new OrchestrationClient(endpoint, { createId: () => "req-agent" });

  try {
    await server.start();
    const resultInput = { executionToken: "group-execution:bound", args: { offset: 0 } };
    expect(await createOrchestrationTransport(endpoint, { client }).groupReadResult!(resultInput))
      .toEqual({ kind: "catalog", assignments: [], nextOffset: null });
    expect(resultInputs).toEqual([resultInput]);

    await expect(
      client.agentList({ coordinatorSession: "backend:main", sourceHandle: "worker:review" }),
    ).resolves.toEqual([
      {
        address: { nodeId: "node-local", endpointId: "endpoint-worker" },
        handle: "agent:node-local:endpoint-worker",
        node: "node-local",
        agent: "codex",
        state: "idle",
        capabilities: { receive: true, steer: false, queue: true, interrupt: false },
      },
    ]);
    await expect(
      client.agentSend({
        coordinatorSession: "backend:main",
        sourceHandle: "worker:review",
        to: "agent:node-local:endpoint-worker",
        message: "schema updated",
        mode: "queue",
        replyTo: "msg-parent",
      }),
    ).resolves.toEqual({
      messageId: "msg-1",
      status: "queued",
      modeUsed: "queue",
      route: "local",
    });

    expect(listInputs).toEqual([{ coordinatorSession: "backend:main", sourceHandle: "worker:review" }]);
    expect(sendInputs).toEqual([
      {
        binding: { coordinatorSession: "backend:main", sourceHandle: "worker:review" },
        input: {
          to: "agent:node-local:endpoint-worker",
          content: "schema updated",
          mode: "queue",
          replyTo: "msg-parent",
        },
      },
    ]);
  } finally {
    await server.stop();
    await rm(dir, { recursive: true, force: true });
  }
});

test("client preserves Agent Messaging error codes", async () => {
  if (await skipIfLocalIpcUnavailable("orchestration-client socket integration tests")) return;

  const dir = await mkdtemp(join(tmpdir(), "weacpx-orch-agent-error-"));
  const endpoint = resolveOrchestrationEndpoint(dir);
  const server = new OrchestrationServer(
    endpoint,
    {
      requestDelegate: async () => ({ taskId: "task-1", status: "needs_confirmation" }),
      getTask: async () => null,
      listTasks: async () => [],
      approveTask: async (input) => ({ taskId: input.taskId }) as never,
      cancelTask: async (input) => ({ taskId: input.taskId }) as never,
      recordWorkerReply: async () => ({ taskId: "task-1" }) as never,
    },
    {
      agentMessaging: {
        listReachable: async () => [],
        send: async () => {
          throw new AgentMessagingError("TARGET_NOT_REACHABLE", "Target is not reachable.");
        },
      },
    },
  );
  const client = new OrchestrationClient(endpoint, { createId: () => "req-agent-error" });

  try {
    await server.start();
    let received: unknown;
    try {
      await client.agentSend({
        coordinatorSession: "backend:main",
        to: "agent:node-other:endpoint-worker",
        message: "schema updated",
      });
    } catch (error) {
      received = error;
    }

    expect(received).toBeInstanceOf(OrchestrationClientError);
    expect(received).toMatchObject({
      code: "TARGET_NOT_REACHABLE",
      message: "Target is not reachable.",
    });
  } finally {
    await server.stop();
    await rm(dir, { recursive: true, force: true });
  }
});

test("sends orchestration RPC requests through the client", async () => {
  // Requires node:net listen; sandboxed runners may deny local IPC with EPERM.
  if (await skipIfLocalIpcUnavailable("orchestration-client socket integration tests")) return;

  const dir = await mkdtemp(join(tmpdir(), "weacpx-orch-client-"));
  const endpoint = resolveOrchestrationEndpoint(dir);
  const server = new OrchestrationServer(endpoint, {
    registerExternalCoordinator: async (input) => ({
      coordinatorSession: input.coordinatorSession,
      workspace: input.workspace,
      createdAt: "2026-04-28T00:00:00.000Z",
      updatedAt: "2026-04-28T00:00:00.000Z",
    }),
    requestDelegate: async (input) => ({
      taskId: "task-1",
      status: "needs_confirmation",
    }),
    getTask: async (taskId) => ({
      taskId,
      sourceHandle: "wx:user",
      sourceKind: "human",
      coordinatorSession: "backend:main",
      workerSession: "backend:claude:worker",
      workspace: "backend",
      targetAgent: "claude",
      task: "review",
      status: "running",
      summary: "",
      resultText: "",
      createdAt: "2026-04-13T00:00:00.000Z",
      updatedAt: "2026-04-13T00:00:00.000Z",
    }),
    listTasks: async (filter) => [
      {
        taskId: "task-1",
        sourceHandle: filter?.coordinatorSession ?? "wx:user",
        sourceKind: "human",
        coordinatorSession: filter?.coordinatorSession ?? "backend:main",
        workerSession: "backend:claude:worker",
        workspace: "backend",
        targetAgent: "claude",
        task: "review",
        status: "running",
        summary: "",
        resultText: "",
        createdAt: "2026-04-13T00:00:00.000Z",
        updatedAt: "2026-04-13T00:00:00.000Z",
      },
    ],
    watchTask: async (input) => ({ status: "timeout" as const, task: null, events: [], nextAfterSeq: input.afterSeq ?? 0 }),
    cancelTask: async (input) => ({
      taskId: input.taskId,
      sourceHandle: input.sourceHandle ?? "wx:user",
      sourceKind: "human",
      coordinatorSession: "backend:main",
      workerSession: "backend:claude:worker",
      workspace: "backend",
      targetAgent: "claude",
      task: "review",
      status: "cancelled",
      summary: "",
      resultText: "",
      createdAt: "2026-04-13T00:00:00.000Z",
      updatedAt: "2026-04-13T00:00:00.000Z",
    }),
    recordWorkerReply: async () => ({
      taskId: "task-1",
      sourceHandle: "backend:claude:worker",
      sourceKind: "worker",
      coordinatorSession: "backend:main",
      workerSession: "backend:claude:worker",
      workspace: "backend",
      targetAgent: "claude",
      task: "review",
      status: "completed",
      summary: "done",
      resultText: "done",
      createdAt: "2026-04-13T00:00:00.000Z",
      updatedAt: "2026-04-13T00:00:00.000Z",
    }),
    approveTask: async (input) => ({
      taskId: input.taskId,
      sourceHandle: "backend:main",
      sourceKind: "coordinator",
      coordinatorSession: input.coordinatorSession,
      workerSession: "backend:claude:worker",
      workspace: "backend",
      targetAgent: "claude",
      task: "review",
      status: "running",
      summary: "",
      resultText: "",
      createdAt: "2026-04-13T00:00:00.000Z",
      updatedAt: "2026-04-13T00:00:00.000Z",
    }),
  });
  const client = new OrchestrationClient(endpoint, { createId: () => "req-1" });

  try {
    await server.start();

    await expect(
      client.registerExternalCoordinator({ coordinatorSession: "codex:backend", workspace: "backend" }),
    ).resolves.toEqual({
      coordinatorSession: "codex:backend",
      workspace: "backend",
      createdAt: "2026-04-28T00:00:00.000Z",
      updatedAt: "2026-04-28T00:00:00.000Z",
    });

    await expect(
      client.delegateRequest({
        sourceHandle: "backend:main",
        targetAgent: "claude",
        task: "review",
      }),
    ).resolves.toEqual({
      taskId: "task-1",
      status: "needs_confirmation",
    });

    await expect(
      client.getTaskForCoordinator({ coordinatorSession: "backend:main", taskId: "task-1" }),
    ).resolves.toMatchObject({ taskId: "task-1", status: "running" });
    await expect(client.listTasks({ coordinatorSession: "backend:main" })).resolves.toHaveLength(1);
    await expect(
      client.watchTask({ coordinatorSession: "backend:main", taskId: "task-1", afterSeq: 1, mode: "next_event" }),
    ).resolves.toEqual({ status: "timeout", task: null, events: [], nextAfterSeq: 1 });
    await expect(client.cancelTask({ taskId: "task-1", sourceHandle: "wx:user" })).resolves.toMatchObject({
      taskId: "task-1",
      status: "cancelled",
    });
    await expect(
      client.cancelTaskForCoordinator({ coordinatorSession: "backend:main", taskId: "task-1" }),
    ).resolves.toMatchObject({
      taskId: "task-1",
      status: "cancelled",
    });
    await expect(
      client.approveTask({ coordinatorSession: "backend:main", taskId: "task-1" }),
    ).resolves.toMatchObject({ taskId: "task-1", status: "running" });
    await expect(
      client.workerReply({ taskId: "task-1", sourceHandle: "backend:claude:worker", resultText: "done" }),
    ).resolves.toEqual({ accepted: true });
  } finally {
    await server.stop();
    await rm(dir, { recursive: true, force: true });
  }
});

test("sends group.new RPC request through the client", async () => {
  // Requires node:net listen; sandboxed runners may deny local IPC with EPERM.
  if (await skipIfLocalIpcUnavailable("orchestration-client socket integration tests")) return;

  const dir = await mkdtemp(join(tmpdir(), "weacpx-orch-client-"));
  const endpoint = resolveOrchestrationEndpoint(dir);
  const groupRecord = {
    groupId: "g-1",
    coordinatorSession: "backend:main",
    title: "parallel review",
    createdAt: "2026-04-18T00:00:00.000Z",
    updatedAt: "2026-04-18T00:00:00.000Z",
  };
  let lastCreateGroup: unknown;
  const server = new OrchestrationServer(endpoint, {
    requestDelegate: async () => ({ taskId: "task-1", status: "needs_confirmation" }),
    getTask: async () => null,
    listTasks: async () => [],
    cancelTask: async (input) => ({
      taskId: input.taskId,
      sourceHandle: "wx:user",
      sourceKind: "human",
      coordinatorSession: "backend:main",
      workspace: "backend",
      targetAgent: "claude",
      task: "t",
      status: "cancelled",
      summary: "",
      resultText: "",
      createdAt: "a",
      updatedAt: "a",
    }),
    recordWorkerReply: async () => ({
      taskId: "task-1",
      sourceHandle: "w",
      sourceKind: "worker",
      coordinatorSession: "backend:main",
      workspace: "backend",
      targetAgent: "claude",
      task: "t",
      status: "completed",
      summary: "",
      resultText: "",
      createdAt: "a",
      updatedAt: "a",
    }),
    approveTask: async () => ({
      taskId: "task-1",
      sourceHandle: "backend:main",
      sourceKind: "coordinator",
      coordinatorSession: "backend:main",
      workspace: "backend",
      targetAgent: "claude",
      task: "t",
      status: "running",
      summary: "",
      resultText: "",
      createdAt: "a",
      updatedAt: "a",
    }),
    createGroup: async (input) => {
      lastCreateGroup = input;
      return groupRecord;
    },
  });
  const client = new OrchestrationClient(endpoint, { createId: () => "req-1" });

  try {
    await server.start();

    await expect(
      client.createGroup({ coordinatorSession: "backend:main", title: "parallel review" }),
    ).resolves.toEqual(groupRecord);
    expect(lastCreateGroup).toEqual({ coordinatorSession: "backend:main", title: "parallel review" });
  } finally {
    await server.stop();
    await rm(dir, { recursive: true, force: true });
  }
});

test("sends blocker-loop RPC requests through the client", async () => {
  // Requires node:net listen; sandboxed runners may deny local IPC with EPERM.
  if (await skipIfLocalIpcUnavailable("orchestration-client socket integration tests")) return;

  const dir = await mkdtemp(join(tmpdir(), "weacpx-orch-client-"));
  const endpoint = resolveOrchestrationEndpoint(dir);
  const blockerTask = {
    taskId: "task-1",
    sourceHandle: "backend:main",
    sourceKind: "coordinator" as const,
    coordinatorSession: "backend:main",
    workerSession: "backend:claude:worker",
    workspace: "backend",
    targetAgent: "claude",
    task: "review",
    status: "blocked" as const,
    summary: "",
    resultText: "",
    createdAt: "2026-04-22T00:00:00.000Z",
    updatedAt: "2026-04-22T00:00:00.000Z",
    openQuestion: {
      questionId: "question-1",
      question: "Need environment details",
      whyBlocked: "The requirement is ambiguous.",
      whatIsNeeded: "Clarify the target environment.",
      askedAt: "2026-04-22T00:00:00.000Z",
      status: "open" as const,
    },
  };
  const reviewedTask = {
    ...blockerTask,
    status: "running" as const,
    updatedAt: "2026-04-22T00:05:00.000Z",
  };
  let lastWorkerRaiseQuestion: unknown;
  let lastCoordinatorAnswerQuestion: unknown;
  let lastCoordinatorRetractAnswer: unknown;
  let lastCoordinatorRequestHumanInput: unknown;
  let lastCoordinatorReviewContestedResult: unknown;
  const server = new OrchestrationServer(endpoint, {
    requestDelegate: async () => ({ taskId: "task-1", status: "needs_confirmation" }),
    getTask: async () => null,
    listTasks: async () => [],
    cancelTask: async (input) => ({
      taskId: input.taskId,
      sourceHandle: "wx:user",
      sourceKind: "human",
      coordinatorSession: "backend:main",
      workspace: "backend",
      targetAgent: "claude",
      task: "review",
      status: "cancelled",
      summary: "",
      resultText: "",
      createdAt: "2026-04-22T00:00:00.000Z",
      updatedAt: "2026-04-22T00:00:00.000Z",
    }),
    recordWorkerReply: async () => blockerTask,
    approveTask: async () => reviewedTask,
    workerRaiseQuestion: async (input) => {
      lastWorkerRaiseQuestion = input;
      return { taskId: input.taskId, questionId: "question-1", status: "blocked" as const };
    },
    coordinatorAnswerQuestion: async (input) => {
      lastCoordinatorAnswerQuestion = input;
      return reviewedTask;
    },
    coordinatorRetractAnswer: async (input) => {
      lastCoordinatorRetractAnswer = input;
      return { ...blockerTask, status: "waiting_for_human" as const };
    },
    coordinatorRequestHumanInput: async (input) => {
      lastCoordinatorRequestHumanInput = input;
      return { packageId: "package-1", queuedTaskIds: ["task-2"] };
    },
    coordinatorReviewContestedResult: async (input) => {
      lastCoordinatorReviewContestedResult = input;
      return {
        ...blockerTask,
        reviewPending: undefined,
      };
    },
  });
  const client = new OrchestrationClient(endpoint, { createId: () => "req-1" });

  try {
    await server.start();

    await expect(
      client.workerRaiseQuestion({
        taskId: "task-1",
        sourceHandle: "backend:claude:worker",
        question: "Need environment details",
        whyBlocked: "The requirement is ambiguous.",
        whatIsNeeded: "Clarify the target environment.",
      }),
    ).resolves.toEqual({
      taskId: "task-1",
      questionId: "question-1",
      status: "blocked",
    });
    expect(lastWorkerRaiseQuestion).toEqual({
      taskId: "task-1",
      sourceHandle: "backend:claude:worker",
      question: "Need environment details",
      whyBlocked: "The requirement is ambiguous.",
      whatIsNeeded: "Clarify the target environment.",
    });

    await expect(
      client.coordinatorAnswerQuestion({
        coordinatorSession: "backend:main",
        taskId: "task-1",
        questionId: "question-1",
        answer: "Use the staging environment.",
      }),
    ).resolves.toEqual(reviewedTask);
    expect(lastCoordinatorAnswerQuestion).toEqual({
      coordinatorSession: "backend:main",
      taskId: "task-1",
      questionId: "question-1",
      answer: "Use the staging environment.",
    });

    await expect(
      client.coordinatorRetractAnswer({
        coordinatorSession: "backend:main",
        taskId: "task-1",
        questionId: "question-1",
      }),
    ).resolves.toMatchObject({
      taskId: "task-1",
      status: "waiting_for_human",
    });
    expect(lastCoordinatorRetractAnswer).toEqual({
      coordinatorSession: "backend:main",
      taskId: "task-1",
      questionId: "question-1",
    });

    await expect(
      client.coordinatorRequestHumanInput({
        coordinatorSession: "backend:main",
        taskQuestions: [{ taskId: "task-1", questionId: "question-1" }],
        promptText: "Please confirm the target environment.",
        expectedActivePackageId: "package-0",
      }),
    ).resolves.toEqual({
      packageId: "package-1",
      queuedTaskIds: ["task-2"],
    });
    expect(lastCoordinatorRequestHumanInput).toEqual({
      coordinatorSession: "backend:main",
      taskQuestions: [{ taskId: "task-1", questionId: "question-1" }],
      promptText: "Please confirm the target environment.",
      expectedActivePackageId: "package-0",
    });

    await expect(
      client.coordinatorReviewContestedResult({
        coordinatorSession: "backend:main",
        taskId: "task-1",
        reviewId: "review-1",
        decision: "discard",
      }),
    ).resolves.toEqual({
      ...blockerTask,
      reviewPending: undefined,
    });
    expect(lastCoordinatorReviewContestedResult).toEqual({
      coordinatorSession: "backend:main",
      taskId: "task-1",
      reviewId: "review-1",
      decision: "discard",
    });
  } finally {
    await server.stop();
    await rm(dir, { recursive: true, force: true });
  }
});

test("client methods pass all input fields through to the server", async () => {
  // Requires node:net listen; sandboxed runners may deny local IPC with EPERM.
  if (await skipIfLocalIpcUnavailable("orchestration-client socket integration tests")) return;

  const dir = await mkdtemp(join(tmpdir(), "weacpx-orch-client-type-"));
  const endpoint = resolveOrchestrationEndpoint(dir);
  let receivedParams: Record<string, unknown> | undefined;
  const server = new OrchestrationServer(endpoint, {
    requestDelegate: async (input) => {
      receivedParams = input as unknown as Record<string, unknown>;
      return { taskId: "task-1", status: "needs_confirmation" };
    },
    getTask: async () => null,
    listTasks: async () => [],
    approveTask: async (input) => ({ taskId: input.taskId }) as any,
    cancelTask: async (input) => ({ taskId: input.taskId }) as any,
    recordWorkerReply: async () => ({ taskId: "task-1" }) as any,
    workerRaiseQuestion: async () => ({ taskId: "task-1", questionId: "q-1", status: "blocked" }),
    coordinatorAnswerQuestion: async (input) => ({ taskId: input.taskId }) as any,
    coordinatorRetractAnswer: async (input) => ({ taskId: input.taskId }) as any,
    coordinatorRequestHumanInput: async () => ({ packageId: "pkg-1", queuedTaskIds: [] }),
    coordinatorReviewContestedResult: async (input) => ({ taskId: input.taskId }) as any,
    createGroup: async () => ({ groupId: "g-1" }) as any,
    getGroupSummary: async () => null,
    listGroupSummaries: async () => [],
    cancelGroup: async () => ({ cancelledTaskIds: [] }),
  });
  await server.start();
  const client = new OrchestrationClient(endpoint);

  await client.delegateRequest({
    sourceHandle: "wx:user",
    targetAgent: "claude",
    task: "review code",
  });

  expect(receivedParams).toBeDefined();
  expect(receivedParams!.sourceHandle).toBe("wx:user");
  expect(receivedParams!.task).toBe("review code");

  await server.stop();
  await rm(dir, { recursive: true });
});

test("surfaces server-side RPC errors from the client", async () => {
  // Requires node:net listen; sandboxed runners may deny local IPC with EPERM.
  if (await skipIfLocalIpcUnavailable("orchestration-client socket integration tests")) return;

  const dir = await mkdtemp(join(tmpdir(), "weacpx-orch-client-"));
  const endpoint = resolveOrchestrationEndpoint(dir);
  const server = new OrchestrationServer(endpoint, {
    requestDelegate: async () => {
      throw new Error("delegate failed");
    },
    getTask: async () => null,
    listTasks: async () => [],
    cancelTask: async () => {
      throw new Error("cancel failed");
    },
    recordWorkerReply: async () => {
      throw new Error("reply failed");
    },
    approveTask: async () => {
      throw new Error("approve failed");
    },
  });
  const client = new OrchestrationClient(endpoint, { createId: () => "req-1" });

  try {
    await server.start();

    await expect(
      client.delegateRequest({
        sourceHandle: "backend:main",
        targetAgent: "claude",
        task: "review",
      }),
    ).rejects.toThrow("delegate failed");
  } finally {
    await server.stop();
    await rm(dir, { recursive: true, force: true });
  }
});

test("client request times out when server does not respond", async () => {
  // Requires node:net listen; sandboxed runners may deny local IPC with EPERM.
  if (await skipIfLocalIpcUnavailable("orchestration-client socket integration tests")) return;

  const dir = await mkdtemp(join(tmpdir(), "weacpx-orch-timeout-"));
  const endpoint = resolveOrchestrationEndpoint(dir);

  // Start a server that accepts connections but never responds
  const { createServer } = await import("node:net");
  const netServer = createServer(() => {
    // Accept connection but send nothing back
  });
  await new Promise<void>((resolve) => netServer.listen(endpoint.path, resolve));

  const client = new OrchestrationClient(endpoint, { timeoutMs: 200 });

  const start = Date.now();
  await expect(
    client.getTaskForCoordinator({ coordinatorSession: "backend:main", taskId: "task-1" }),
  ).rejects.toThrow();
  const elapsed = Date.now() - start;

  // Should fail within ~200ms, not hang
  expect(elapsed).toBeLessThan(1000);

  await new Promise<void>((resolve) => netServer.close(() => resolve()));
  await rm(dir, { recursive: true });
});

test("client does not expose an unscoped task getter", () => {
  const endpoint = resolveOrchestrationEndpoint("/tmp/weacpx-orch-client-test");
  const client = new OrchestrationClient(endpoint);

  expect((client as unknown as { getTask?: unknown }).getTask).toBeUndefined();
});

test("peer methods round-trip through a real IPC endpoint to a bound PeerService", async () => {
  if (await skipIfLocalIpcUnavailable("orchestration-client socket integration tests")) return;

  const dir = await mkdtemp(join(tmpdir(), "weacpx-orch-peer-client-"));
  const endpoint = resolveOrchestrationEndpoint(dir);
  const sessions = new Map<string, ResolvedSession>([
    ["peer-a", { alias: "peer-a", agent: "mock", workspace: "ws-a", transportSession: "ws-a:peer-a" } as ResolvedSession],
    ["peer-b", { alias: "peer-b", agent: "mock", workspace: "ws-b", transportSession: "ws-b:peer-b" } as ResolvedSession],
  ]);
  const prompts: string[] = [];
  const peer = new PeerService({
    resolveSession: async (key) => sessions.get(key) ?? null,
    promptSession: async (session, text) => {
      prompts.push(`${session.alias}:${text}`);
      return { text: `echo:${text}` };
    },
    store: new PeerStore(join(dir, "peer-requests.json")),
  });
  const server = new OrchestrationServer(
    endpoint,
    {
      requestDelegate: async () => ({ taskId: "task-1", status: "needs_confirmation" }),
      getTask: async () => null,
      listTasks: async () => [],
      approveTask: async (input) => ({ taskId: input.taskId }) as never,
      cancelTask: async (input) => ({ taskId: input.taskId }) as never,
      recordWorkerReply: async () => ({ taskId: "task-1" }) as never,
    },
    {
      peer: {
        delegate: peer.delegate.bind(peer),
        approve: peer.approve.bind(peer),
        watch: peer.watch.bind(peer),
        confirm: peer.confirm.bind(peer),
        cancel: peer.cancel.bind(peer),
        list: peer.list.bind(peer),
        get: peer.get.bind(peer),
      },
    },
  );
  const client = new OrchestrationClient(endpoint, { createId: () => "req-peer" });

  try {
    await server.start();
    const transport = createOrchestrationTransport(endpoint, { client });

    // Full daemon-bound path: MCP transport -> RPC client -> socket ->
    // server dispatch -> PeerService -> store, with no direct service call.
    const created = await transport.peerDelegate!({
      originatorAlias: "peer-a",
      targetAlias: "peer-b",
      task: "round-trip task",
      requestId: "req-round-trip",
      coordinatorSession: "ws-a:peer-a",
    });
    expect(created.status).toBe("needs_confirmation");
    expect(created.coordinator).toBe("ws-a:peer-a");
    expect(prompts).toHaveLength(0);

    const approved = await transport.peerApprove!({
      requestId: "req-round-trip",
      approverAlias: "ws-a:peer-a",
      coordinatorSession: "ws-a:peer-a",
    });
    expect(approved.status).toBe("running");

    const watched = await transport.peerWatch!({
      requestId: "req-round-trip",
      timeoutMs: 5000,
      pollIntervalMs: 20,
    });
    expect(watched.status).toBe("terminal");
    expect(watched.request.status).toBe("completed");
    expect(watched.request.result).toContain("round-trip task");
    expect(prompts).toHaveLength(1);

    const got = await transport.peerGet!({ requestId: "req-round-trip" });
    expect(got?.status).toBe("completed");

    // Coordinator view over the socket: the coordinator sees its record;
    // a worker under it sees only the related view (here: nothing, since
    // the worker is neither originator nor target).
    const coordList = await transport.peerList!({
      callerAlias: "ws-a:peer-a",
      coordinatorSession: "ws-a:peer-a",
    });
    expect(coordList.map((r) => r.requestId)).toEqual(["req-round-trip"]);
    const workerList = await transport.peerList!({
      callerAlias: "worker:review",
      coordinatorSession: "ws-a:peer-a",
    });
    expect(workerList).toHaveLength(0);

    const confirmed = await transport.peerConfirm!({
      requestId: "req-round-trip",
      originatorAlias: "peer-a",
    });
    expect(confirmed.status).toBe("delivered");

    // A worker approve over the same socket is rejected by the service,
    // surfacing as an RPC error to the client.
    const workerReq = await transport.peerDelegate!({
      originatorAlias: "worker:review",
      targetAlias: "peer-b",
      task: "worker task",
      requestId: "req-round-trip-worker",
      coordinatorSession: "ws-a:peer-a",
    });
    expect(workerReq.status).toBe("needs_confirmation");
    await expect(
      transport.peerApprove!({
        requestId: "req-round-trip-worker",
        approverAlias: "worker:review",
        coordinatorSession: "ws-a:peer-a",
      }),
    ).rejects.toThrow("only the record's coordinator");
  } finally {
    await server.stop();
    await rm(dir, { recursive: true, force: true });
  }
});
