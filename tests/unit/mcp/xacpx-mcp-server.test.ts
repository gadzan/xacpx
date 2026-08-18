import { EventEmitter } from "node:events";

import { expect, test } from "bun:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { CallToolResultSchema, ListRootsRequestSchema, RELATED_TASK_META_KEY } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

import {
  createXacpxMcpServer,
  installMcpStdioShutdownHooks,
  WATCH_TASKS_CACHE_LIMIT,
  XACPX_MCP_SERVER_INSTRUCTIONS,
} from "../../../src/mcp/xacpx-mcp-server";
import { createMemoryTransport } from "../../../src/mcp/xacpx-mcp-transport";
import type { OrchestrationTaskRecord } from "../../../src/orchestration/orchestration-types";
import { AgentMessagingError } from "../../../src/orchestration/agent-messaging-error";

test("lists 13 MCP tools and hides coordinator/source identity from input schemas", async () => {
  const transport = createMemoryTransport(
    async () => ({ taskId: "task-1", status: "needs_confirmation" }),
    {
      getTask: async () => null,
      listTasks: async () => [],
      approveTask: async () => {
        throw new Error("approve not implemented");
      },
      cancelTask: async () => {
        throw new Error("cancel not implemented");
      },
      workerRaiseQuestion: async () => ({ taskId: "task-1", questionId: "question-1", status: "blocked" }),
      coordinatorAnswerQuestion: async () => {
        throw new Error("unused");
      },
      coordinatorRequestHumanInput: async () => {
        throw new Error("unused");
      },
      coordinatorReviewContestedResult: async () => {
        throw new Error("unused");
      },
    },
  );
  const server = createXacpxMcpServer({
    transport,
    coordinatorSession: "backend:main",
    sourceHandle: "backend:main:worker",
  });
  const client = new Client({ name: "weacpx-test-client", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);

    const list = await client.listTools();
    expect(list.tools).toHaveLength(13);
    const delegate = list.tools.find((tool) => tool.name === "delegate_request");
    const workerRaiseQuestion = list.tools.find((tool) => tool.name === "worker_raise_question");
    const coordinatorAnswerQuestion = list.tools.find((tool) => tool.name === "coordinator_answer_question");
    const taskList = list.tools.find((tool) => tool.name === "task_list");
    const taskWatch = list.tools.find((tool) => tool.name === "task_watch");
    const agentList = list.tools.find((tool) => tool.name === "agent_list");
    const agentSend = list.tools.find((tool) => tool.name === "agent_send");
    expect(delegate?.inputSchema.properties).not.toHaveProperty("sourceHandle");
    expect(delegate?.inputSchema.properties).not.toHaveProperty("coordinatorSession");
    expect(delegate?.execution?.taskSupport).toBe("optional");
    expect(workerRaiseQuestion?.inputSchema.properties).not.toHaveProperty("sourceHandle");
    expect(workerRaiseQuestion?.inputSchema.properties).not.toHaveProperty("coordinatorSession");
    expect(coordinatorAnswerQuestion?.inputSchema.properties).not.toHaveProperty("coordinatorSession");
    expect(taskList?.inputSchema.properties?.status?.enum).toContain("blocked");
    expect(taskList?.inputSchema.properties?.status?.enum).toContain("waiting_for_human");
    expect(taskWatch?.inputSchema.properties).not.toHaveProperty("coordinatorSession");
    expect(agentList?.inputSchema.properties).toEqual({});
    expect(agentSend?.inputSchema.properties).not.toHaveProperty("from");
    expect(agentSend?.inputSchema.properties).not.toHaveProperty("coordinatorSession");
    expect(agentSend?.inputSchema.properties).not.toHaveProperty("sourceHandle");
  } finally {
    await client.close();
    await server.close();
  }
});

test("lists scheduled_create only when internal session tools are enabled", async () => {
  const transport = createMemoryTransport(
    async () => ({ taskId: "task-1", status: "needs_confirmation" }),
    {
      scheduledCreate: async () => ({
        id: "k8f2",
        chat_key: "wx:user",
        session_alias: "main",
        session_mode: "temp",
        execute_at: "2026-05-25T02:00:00.000Z",
        message: "检查 CI",
        status: "pending",
        created_at: "2026-05-25T00:00:00.000Z",
      }),
    },
  );
  const server = createXacpxMcpServer({
    transport,
    coordinatorSession: "backend:main",
    internalSessionTools: true,
  });
  const client = new Client({ name: "weacpx-test-client", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);

    const list = await client.listTools();
    expect(list.tools).toHaveLength(16);
    expect(list.tools.map((tool) => tool.name)).toContain("scheduled_list");
    expect(list.tools.map((tool) => tool.name)).toContain("scheduled_cancel");
    const scheduledCreate = list.tools.find((tool) => tool.name === "scheduled_create");
    expect(scheduledCreate?.inputSchema.properties).toHaveProperty("timeText");
    expect(scheduledCreate?.inputSchema.properties).toHaveProperty("message");
    expect(scheduledCreate?.inputSchema.properties).not.toHaveProperty("chatKey");
    expect(scheduledCreate?.inputSchema.properties).not.toHaveProperty("sessionAlias");
    expect(scheduledCreate?.inputSchema.properties).not.toHaveProperty("accountId");
    expect(scheduledCreate?.inputSchema.properties).not.toHaveProperty("replyContextToken");
  } finally {
    await client.close();
    await server.close();
  }
});

test("delegate_request supports native MCP task execution", async () => {
  const task: OrchestrationTaskRecord = {
    taskId: "task-9",
    sourceHandle: "backend:main",
    sourceKind: "coordinator",
    coordinatorSession: "backend:main",
    workerSession: "backend:worker",
    workspace: "backend",
    targetAgent: "claude",
    task: "review",
    status: "completed",
    summary: "review complete",
    resultText: "No blocking issues.",
    createdAt: "2026-05-16T00:00:00.000Z",
    updatedAt: "2026-05-16T00:00:01.000Z",
  };
  const calls: unknown[] = [];
  const server = createXacpxMcpServer({
    transport: createMemoryTransport(
      async (input) => {
        calls.push(input);
        return { taskId: "task-9", status: "running" };
      },
      {
        getTask: async ({ taskId }) => taskId === "task-9" ? task : null,
        listTasks: async () => [task],
        cancelTask: async () => {
          throw new Error("unused");
        },
      },
    ),
    coordinatorSession: "backend:main",
  });
  const client = new Client({ name: "weacpx-test-client", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);

    const messages: Array<{ type: string; task?: { taskId: string; status: string }; result?: unknown }> = [];
    const stream = client.experimental.tasks.callToolStream(
      {
        name: "delegate_request",
        arguments: {
          targetAgent: "claude",
          task: "review",
          workingDirectory: "/repo/backend",
        },
      },
      CallToolResultSchema,
      { task: { ttl: 60_000, pollInterval: 1 } },
    );

    for await (const message of stream) {
      messages.push(message);
    }

    expect(calls).toEqual([
      {
        coordinatorSession: "backend:main",
        targetAgent: "claude",
        task: "review",
        workingDirectory: "/repo/backend",
      },
    ]);
    expect(messages[0]).toMatchObject({
      type: "taskCreated",
      task: { taskId: "task-9", status: "completed" },
    });
    expect(messages.at(-1)).toMatchObject({
      type: "result",
      result: {
        content: [{ type: "text", text: "Task \"task-9\" finished with status completed.\nNo blocking issues." }],
        _meta: {
          [RELATED_TASK_META_KEY]: { taskId: "task-9" },
        },
      },
    });

    const listed = await client.experimental.tasks.listTasks();
    expect(listed.tasks).toEqual([
      {
        taskId: "task-9",
        status: "completed",
        ttl: 60_000,
        createdAt: "2026-05-16T00:00:00.000Z",
        lastUpdatedAt: "2026-05-16T00:00:01.000Z",
        statusMessage: "review complete",
      },
    ]);
  } finally {
    await client.close();
    await server.close();
  }
});

test("native MCP tasks map input-required states and cancellation", async () => {
  const task: OrchestrationTaskRecord = {
    taskId: "task-blocked",
    sourceHandle: "backend:main",
    sourceKind: "coordinator",
    coordinatorSession: "backend:main",
    workerSession: "backend:worker",
    workspace: "backend",
    targetAgent: "claude",
    task: "review",
    status: "blocked",
    summary: "Need clarification",
    resultText: "",
    createdAt: "2026-05-16T00:00:00.000Z",
    updatedAt: "2026-05-16T00:00:02.000Z",
    lastProgressAt: "2026-05-16T00:00:01.500Z",
    lastProgressSummary: "reading files",
    openQuestion: {
      questionId: "q1",
      question: "Which branch?",
      whatIsNeeded: "Branch name",
      whyBlocked: "Cannot review without it",
      askedAt: "2026-05-16T00:00:01.000Z",
      status: "open",
    },
  };
  let cancelTaskId: string | undefined;
  const server = createXacpxMcpServer({
    transport: createMemoryTransport(
      async () => ({ taskId: "task-blocked", status: "running" }),
      {
        getTask: async ({ taskId }) => taskId === "task-blocked" ? task : null,
        listTasks: async () => [task],
        cancelTask: async ({ taskId }) => {
          cancelTaskId = taskId;
          task.status = "cancelled";
          task.updatedAt = "2026-05-16T00:00:03.000Z";
        },
      },
    ),
    coordinatorSession: "backend:main",
  });
  const client = new Client({ name: "weacpx-test-client", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);

    const messages: Array<{ type: string; task?: { taskId: string; status: string }; result?: { content?: Array<{ type: string; text?: string }>; structuredContent?: unknown } }> = [];
    const stream = client.experimental.tasks.callToolStream(
      {
        name: "delegate_request",
        arguments: {
          targetAgent: "claude",
          task: "review",
          workingDirectory: "/repo/backend",
        },
      },
      CallToolResultSchema,
      { task: { pollInterval: 10 } },
    );
    for await (const message of stream) {
      messages.push(message);
    }

    expect(messages[0]).toMatchObject({
      type: "taskCreated",
      task: { taskId: "task-blocked", status: "input_required" },
    });
    expect(messages[1]).toMatchObject({
      type: "taskStatus",
      task: { taskId: "task-blocked", status: "input_required" },
    });
    expect(messages[2]).toMatchObject({
      type: "result",
      result: {
        content: [
          {
            type: "text",
            text: expect.stringContaining("coordinator_answer_question"),
          },
        ],
      },
    });
    expect(messages[2]?.result?.structuredContent).toMatchObject({
      nextAction: {
        kind: "input_required",
        taskId: "task-blocked",
        recommendedTools: ["coordinator_answer_question"],
      },
    });
    expect(messages[2]?.result?._meta).toEqual({
      [RELATED_TASK_META_KEY]: { taskId: "task-blocked" },
    });

    const status = await client.experimental.tasks.getTask("task-blocked");
    expect(status).toMatchObject({
      taskId: "task-blocked",
      status: "input_required",
      statusMessage: "Need clarification\nLatest progress: reading files\nLast progress at: 2026-05-16T00:00:01.500Z",
    });

    const cancelled = await client.experimental.tasks.cancelTask("task-blocked");
    expect(cancelTaskId).toBe("task-blocked");
    expect(cancelled).toMatchObject({
      taskId: "task-blocked",
      status: "cancelled",
    });
  } finally {
    await client.close();
    await server.close();
  }
});

test("native MCP tasks expose pending approval as input_required", async () => {
  const task: OrchestrationTaskRecord = {
    taskId: "task-approval",
    sourceHandle: "backend:main",
    sourceKind: "worker",
    coordinatorSession: "backend:main",
    workerSession: "backend:worker",
    workspace: "backend",
    targetAgent: "claude",
    task: "delegate onward",
    status: "needs_confirmation",
    summary: "Worker requested delegation",
    resultText: "",
    createdAt: "2026-05-16T00:00:00.000Z",
    updatedAt: "2026-05-16T00:00:01.000Z",
  };
  const server = createXacpxMcpServer({
    transport: createMemoryTransport(
      async () => ({ taskId: "task-approval", status: "needs_confirmation" }),
      {
        getTask: async ({ taskId }) => taskId === "task-approval" ? task : null,
        listTasks: async () => [task],
      },
    ),
    coordinatorSession: "backend:main",
  });
  const client = new Client({ name: "weacpx-test-client", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);

    const messages: Array<{ type: string; result?: { structuredContent?: unknown } }> = [];
    const stream = client.experimental.tasks.callToolStream(
      {
        name: "delegate_request",
        arguments: {
          targetAgent: "claude",
          task: "review",
          workingDirectory: "/repo/backend",
        },
      },
      CallToolResultSchema,
      { task: { pollInterval: 10 } },
    );
    for await (const message of stream) {
      messages.push(message);
    }

    expect(await client.experimental.tasks.getTask("task-approval")).toMatchObject({
      taskId: "task-approval",
      status: "input_required",
    });
    expect(messages.at(-1)?.result?.structuredContent).toMatchObject({
      nextAction: {
        kind: "input_required",
        taskId: "task-approval",
        recommendedTools: ["task_approve", "task_cancel"],
      },
    });
  } finally {
    await client.close();
    await server.close();
  }
});

test("native MCP tasks keep contested terminal results input_required", async () => {
  const task: OrchestrationTaskRecord = {
    taskId: "task-contested",
    sourceHandle: "backend:main",
    sourceKind: "coordinator",
    coordinatorSession: "backend:main",
    workerSession: "backend:worker",
    workspace: "backend",
    targetAgent: "claude",
    task: "review",
    status: "completed",
    summary: "Review result is contested",
    resultText: "Looks good.",
    createdAt: "2026-05-16T00:00:00.000Z",
    updatedAt: "2026-05-16T00:00:01.000Z",
    reviewPending: {
      reviewId: "review-1",
      reason: "misrouted_answer",
      createdAt: "2026-05-16T00:00:01.000Z",
      resultId: "result-1",
      resultText: "Looks good.",
    },
  };
  const server = createXacpxMcpServer({
    transport: createMemoryTransport(
      async () => ({ taskId: "task-contested", status: "running" }),
      {
        getTask: async ({ taskId }) => taskId === "task-contested" ? task : null,
        listTasks: async () => [task],
      },
    ),
    coordinatorSession: "backend:main",
  });
  const client = new Client({ name: "weacpx-test-client", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);

    const messages: Array<{ type: string; task?: { taskId: string; status: string }; result?: { structuredContent?: unknown } }> = [];
    const stream = client.experimental.tasks.callToolStream(
      {
        name: "delegate_request",
        arguments: {
          targetAgent: "claude",
          task: "review",
          workingDirectory: "/repo/backend",
        },
      },
      CallToolResultSchema,
      { task: { pollInterval: 10 } },
    );
    for await (const message of stream) {
      messages.push(message);
    }

    expect(messages[0]).toMatchObject({
      type: "taskCreated",
      task: { taskId: "task-contested", status: "input_required" },
    });
    expect(await client.experimental.tasks.getTask("task-contested")).toMatchObject({
      taskId: "task-contested",
      status: "input_required",
    });
    expect(messages.at(-1)?.result?.structuredContent).toMatchObject({
      nextAction: {
        kind: "input_required",
        taskId: "task-contested",
        recommendedTools: ["coordinator_review_contested_result"],
      },
    });
  } finally {
    await client.close();
    await server.close();
  }
});

test("native MCP tasks list uses cursor pagination", async () => {
  const tasks: OrchestrationTaskRecord[] = Array.from({ length: 101 }, (_, index) => ({
    taskId: `task-${index}`,
    sourceHandle: "backend:main",
    sourceKind: "coordinator",
    coordinatorSession: "backend:main",
    workerSession: `backend:worker-${index}`,
    workspace: "backend",
    targetAgent: "claude",
    task: "review",
    status: "running",
    summary: "",
    resultText: "",
    createdAt: "2026-05-16T00:00:00.000Z",
    updatedAt: `2026-05-16T00:00:${String(index).padStart(2, "0")}.000Z`,
  }));
  const server = createXacpxMcpServer({
    transport: createMemoryTransport(
      async () => ({ taskId: "task-0", status: "running" }),
      {
        getTask: async ({ taskId }) => tasks.find((task) => task.taskId === taskId) ?? null,
        listTasks: async () => tasks,
      },
    ),
    coordinatorSession: "backend:main",
  });
  const client = new Client({ name: "weacpx-test-client", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);

    const first = await client.experimental.tasks.listTasks();
    const second = await client.experimental.tasks.listTasks(first.nextCursor);

    expect(first.tasks).toHaveLength(100);
    expect(first.nextCursor).toBe("100");
    expect(second.tasks).toHaveLength(1);
    expect(second.nextCursor).toBeUndefined();
  } finally {
    await client.close();
    await server.close();
  }
});

test("hides coordinator human-input package tools when resolveIdentity reports an external coordinator", async () => {
  const server = createXacpxMcpServer({
    transport: createMemoryTransport(async () => ({ taskId: "task-1", status: "running" })),
    resolveIdentity: async () => ({
      coordinatorSession: "external_claude-code:backend",
      isExternalCoordinator: true,
    }),
  });
  const client = new Client({ name: "Claude Code", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);

    const list = await client.listTools();
    const names = list.tools.map((tool) => tool.name);
    expect(list.tools).toHaveLength(12);
    expect(names).not.toContain("coordinator_request_human_input");
    expect(names).toContain("coordinator_answer_question");
    expect(names).toContain("coordinator_review_contested_result");
  } finally {
    await client.close();
    await server.close();
  }
});

test("infers MCP identity from client roots before listing tools", async () => {
  const resolved: unknown[] = [];
  const server = createXacpxMcpServer({
    transport: createMemoryTransport(async () => ({ taskId: "task-1", status: "needs_confirmation" })),
    resolveIdentity: async (context) => {
      const roots = await context.listRoots();
      resolved.push({ clientName: context.clientName, roots });
      return {
        coordinatorSession: "external_claude-code:backend",
      };
    },
  });
  const client = new Client(
    { name: "Claude Code", version: "1.0.0" },
    { capabilities: { roots: {} } },
  );
  client.setRequestHandler(ListRootsRequestSchema, async () => ({
    roots: [{ uri: "file:///repo/backend", name: "backend" }],
  }));
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);

    const list = await client.listTools();
    expect(list.tools).toHaveLength(13);
    expect(resolved).toEqual([
      {
        clientName: "Claude Code",
        roots: [{ uri: "file:///repo/backend", name: "backend" }],
      },
    ]);
  } finally {
    await client.close();
    await server.close();
  }
});


test("uses resolveIdentity when both static and lazy MCP identities are configured", async () => {
  const resolved: unknown[] = [];
  const server = createXacpxMcpServer({
    transport: createMemoryTransport(async () => ({ taskId: "task-1", status: "needs_confirmation" })),
    coordinatorSession: "static:session",
    resolveIdentity: async (context) => {
      resolved.push({ clientName: context.clientName });
      return { coordinatorSession: "resolved:session" };
    },
  });
  const client = new Client({ name: "Claude Code", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);

    const list = await client.listTools();
    expect(list.tools).toHaveLength(13);
    expect(resolved).toEqual([{ clientName: "Claude Code" }]);
  } finally {
    await client.close();
    await server.close();
  }
});

test("exposes the orchestration lifecycle as server instructions to the client", async () => {
  const server = createXacpxMcpServer({
    transport: createMemoryTransport(async () => ({ taskId: "task-1", status: "running" })),
    coordinatorSession: "backend:main",
  });
  const client = new Client({ name: "weacpx-test-client", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);

    const instructions = client.getInstructions();
    expect(instructions).toBe(XACPX_MCP_SERVER_INSTRUCTIONS);
    expect(instructions ?? "").toContain("delegate_request");
    expect(instructions ?? "").toContain("delegate_batch");
    // task_watch must be mentioned as the long-poll mechanism.
    expect(instructions ?? "").toContain("task_watch");
    // Each attention-required sub-case must be wired to a different tool so the LLM
    // does not blindly call coordinator_answer_question on a needs_confirmation task.
    expect(instructions ?? "").toContain("needs_confirmation needs task_approve or task_cancel");
    expect(instructions ?? "").toContain("coordinator_answer_question");
    expect(instructions ?? "").toContain("coordinator_review_contested_result");
    // Every tool result carries a Next: hint — the instructions reference that contract.
    expect(instructions ?? "").toContain("Never report a result you did not read from task_get");
    // worker_raise_question is worker-side only — this must be explicit.
    expect(instructions ?? "").toContain("worker_raise_question is worker-side only");
    expect(instructions ?? "").toContain("<xacpx-message>");
    expect(instructions ?? "").toContain("provided from handle");
    expect(instructions ?? "").toContain("replyTo");
    expect(instructions ?? "").toContain("A reply is optional");
    expect(instructions ?? "").toContain("Do not echo pure acknowledgements");
  } finally {
    await client.close();
    await server.close();
  }
});

test("memoizes in-flight lazy MCP identity resolution across concurrent first requests", async () => {
  let resolveCalls = 0;
  let releaseResolve!: () => void;
  const resolveStarted = new Promise<void>((resolve) => {
    releaseResolve = resolve;
  });
  const server = createXacpxMcpServer({
    transport: createMemoryTransport(async () => ({ taskId: "task-1", status: "needs_confirmation" })),
    resolveIdentity: async () => {
      resolveCalls += 1;
      await resolveStarted;
      return { coordinatorSession: "external_claude-code:backend" };
    },
  });
  const client = new Client({ name: "Claude Code", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);

    const firstList = client.listTools();
    const secondList = client.listTools();
    await Promise.resolve();
    releaseResolve();

    const [first, second] = await Promise.all([firstList, secondList]);
    expect(first.tools).toHaveLength(13);
    expect(second.tools).toHaveLength(13);
    expect(resolveCalls).toBe(1);
  } finally {
    await client.close();
    await server.close();
  }
});

test("worker_raise_question uses host-bound sourceHandle and still rejects spoofed public identity fields", async () => {
  const calls: unknown[] = [];
  const server = createXacpxMcpServer({
    transport: createMemoryTransport(
      async () => ({ taskId: "task-9", status: "needs_confirmation" }),
      {
        getTask: async () => null,
        listTasks: async () => [],
        approveTask: async () => {
          throw new Error("unused");
        },
        cancelTask: async () => {
          throw new Error("unused");
        },
        workerRaiseQuestion: async (input) => {
          calls.push(input);
          return { taskId: "task-1", questionId: "question-1", status: "blocked" };
        },
      },
    ),
    coordinatorSession: "backend:main",
    sourceHandle: "backend:worker",
  });
  const client = new Client({ name: "weacpx-test-client", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);

    const result = await client.callTool({
      name: "worker_raise_question",
      arguments: {
        taskId: "task-1",
        question: "Need environment details",
        whyBlocked: "Requirement is ambiguous",
        whatIsNeeded: "Clarify the target environment",
      },
    });

    expect(calls).toEqual([
      {
        sourceHandle: "backend:worker",
        taskId: "task-1",
        question: "Need environment details",
        whyBlocked: "Requirement is ambiguous",
        whatIsNeeded: "Clarify the target environment",
      },
    ]);
    expect(result).toMatchObject({
      content: [{ type: "text", text: "Blocker question submitted for task \"task-1\".\n- questionId: question-1" }],
      structuredContent: { taskId: "task-1", questionId: "question-1", status: "blocked" },
    });

    await expect(
      client.callTool({
        name: "worker_raise_question",
        arguments: {
          sourceHandle: "spoofed",
          coordinatorSession: "spoofed",
          taskId: "task-1",
          question: "Need environment details",
          whyBlocked: "Requirement is ambiguous",
          whatIsNeeded: "Clarify the target environment",
        },
      }),
    ).rejects.toThrow(/sourceHandle|coordinatorSession|unrecognized/i);
  } finally {
    await client.close();
    await server.close();
  }
});

test("worker_raise_question fails clearly when the MCP host did not bind a sourceHandle", async () => {
  const calls: unknown[] = [];
  const server = createXacpxMcpServer({
    transport: createMemoryTransport(
      async () => ({ taskId: "task-9", status: "needs_confirmation" }),
      {
        getTask: async () => null,
        listTasks: async () => [],
        approveTask: async () => {
          throw new Error("unused");
        },
        cancelTask: async () => {
          throw new Error("unused");
        },
        workerRaiseQuestion: async (input) => {
          calls.push(input);
          return { taskId: "task-1", questionId: "question-1", status: "blocked" };
        },
      },
    ),
    coordinatorSession: "backend:main",
  });
  const client = new Client({ name: "weacpx-test-client", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);

    const result = await client.callTool({
      name: "worker_raise_question",
      arguments: {
        taskId: "task-1",
        question: "Need environment details",
        whyBlocked: "Requirement is ambiguous",
        whatIsNeeded: "Clarify the target environment",
      },
    });

    expect(calls).toEqual([]);
    expect(result).toEqual({
      isError: true,
      content: [
        {
          type: "text",
          text: "worker_raise_question requires a bound sourceHandle; start mcp-stdio with --source-handle or XACPX_SOURCE_HANDLE",
        },
      ],
    });
  } finally {
    await client.close();
    await server.close();
  }
});

test("delegates through the MCP server and rejects spoofed sourceHandle params", async () => {
  const calls: unknown[] = [];
  const server = createXacpxMcpServer({
    transport: createMemoryTransport(
      async (input) => {
        calls.push(input);
        return { taskId: "task-9", status: "needs_confirmation" };
      },
      {
        getTask: async () => null,
        listTasks: async () => [],
        approveTask: async () => {
          throw new Error("unused");
        },
        cancelTask: async () => {
          throw new Error("unused");
        },
      },
    ),
    coordinatorSession: "backend:main",
    sourceHandle: "backend:main:worker",
  });
  const client = new Client({ name: "weacpx-test-client", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);

    const result = await client.callTool({
      name: "delegate_request",
      arguments: {
        targetAgent: "claude",
        task: "review",
      },
    });

    expect(calls).toEqual([
      {
        coordinatorSession: "backend:main",
        sourceHandle: "backend:main:worker",
        targetAgent: "claude",
        task: "review",
      },
    ]);
    expect(result).toMatchObject({
      content: [
        {
          type: "text",
          text:
            "Delegation task \"task-9\" created.\n- Status: needs_confirmation\n"
            + "Next: this delegation requires user approval. "
            + "Tell the user, then call task_approve or task_cancel based on their response.",
        },
      ],
      structuredContent: { taskId: "task-9", status: "needs_confirmation" },
    });

    await expect(
      client.callTool({
        name: "delegate_request",
        arguments: {
          sourceHandle: "spoofed",
          targetAgent: "claude",
          task: "review",
        },
      }),
    ).rejects.toThrow(/sourceHandle|unrecognized/i);
  } finally {
    await client.close();
    await server.close();
  }
});

test("agent messaging calls return delivery ACKs and use the server-bound sender", async () => {
  const calls: unknown[] = [];
  let targetModelSettled = false;
  const targetModel = new Promise<void>(() => undefined).finally(() => {
    targetModelSettled = true;
  });
  const agents = [
    {
      address: { nodeId: "node-local", endpointId: "endpoint-peer" },
      handle: "agent:node-local:endpoint-peer",
      node: "node-local",
      agent: "codex",
      state: "running" as const,
      capabilities: { receive: true, steer: false, queue: true, interrupt: false },
    },
  ];
  const receipt = {
    messageId: "msg-1",
    status: "queued" as const,
    modeUsed: "queue" as const,
    route: "local" as const,
  };
  const server = createXacpxMcpServer({
    transport: createMemoryTransport(
      async () => ({ taskId: "task-1", status: "running" }),
      {
        listAgentEndpoints: async (input) => {
          calls.push(input);
          return agents;
        },
        sendAgentMessage: async (input) => {
          calls.push(input);
          void targetModel;
          return receipt;
        },
      },
    ),
    coordinatorSession: "backend:main",
    sourceHandle: "backend:worker-a",
  });
  const client = new Client({ name: "weacpx-test-client", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);

    const listResult = await client.callTool({ name: "agent_list", arguments: {} });
    const sendResult = await client.callTool({
      name: "agent_send",
      arguments: {
        to: "agent:node-local:endpoint-peer",
        message: "schema changed",
        mode: "auto",
        replyTo: "msg-prior",
      },
    });

    expect(listResult.structuredContent).toEqual({ agents });
    expect(sendResult.structuredContent).toEqual(receipt);
    expect(targetModelSettled).toBe(false);
    expect(calls).toEqual([
      { coordinatorSession: "backend:main", sourceHandle: "backend:worker-a" },
      {
        coordinatorSession: "backend:main",
        sourceHandle: "backend:worker-a",
        to: "agent:node-local:endpoint-peer",
        message: "schema changed",
        mode: "auto",
        replyTo: "msg-prior",
      },
    ]);

    await expect(
      client.callTool({
        name: "agent_send",
        arguments: {
          to: "agent:node-local:endpoint-peer",
          message: "schema changed",
          from: "spoofed",
          coordinatorSession: "spoofed",
          sourceHandle: "spoofed",
        },
      }),
    ).rejects.toThrow(/from|coordinatorSession|sourceHandle|unrecognized/i);
  } finally {
    await client.close();
    await server.close();
  }
});

test("agent_send exposes typed messaging failures through MCP structured content", async () => {
  const server = createXacpxMcpServer({
    transport: createMemoryTransport(
      async () => ({ taskId: "task-1", status: "running" }),
      {
        sendAgentMessage: async () => {
          throw new AgentMessagingError("TARGET_NOT_REACHABLE", "Target is not reachable.");
        },
      },
    ),
    coordinatorSession: "backend:main",
  });
  const client = new Client({ name: "weacpx-test-client", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);

    const result = await client.callTool({
      name: "agent_send",
      arguments: {
        to: "agent:node-local:endpoint-peer",
        message: "schema changed",
      },
    });

    expect(result).toMatchObject({
      content: [{ type: "text", text: "Target is not reachable." }],
      structuredContent: {
        error: {
          code: "TARGET_NOT_REACHABLE",
          message: "Target is not reachable.",
        },
      },
      isError: true,
    });
  } finally {
    await client.close();
    await server.close();
  }
});

test("returns tool-level business errors as isError text results", async () => {
  const server = createXacpxMcpServer({
    transport: createMemoryTransport(
      async () => {
        throw new Error("worker-originated delegation is disabled by orchestration policy");
      },
      {
        getTask: async () => null,
        listTasks: async () => [],
        approveTask: async () => {
          throw new Error("unused");
        },
        cancelTask: async () => {
          throw new Error("unused");
        },
      },
    ),
    coordinatorSession: "backend:main",
  });
  const client = new Client({ name: "weacpx-test-client", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);

    const result = await client.callTool({
      name: "delegate_request",
      arguments: {
        targetAgent: "claude",
        task: "review",
      },
    });

    expect(result).toMatchObject({
      isError: true,
      content: [
        {
          type: "text",
          text: "worker-originated delegation is disabled by orchestration policy",
        },
      ],
    });
  } finally {
    await client.close();
    await server.close();
  }
});

test("MCP stdio shutdown hooks react to the first stream/signal event and ignore later events", () => {
  const stdin = new EventEmitter();
  const stdout = new EventEmitter();
  const signals = new EventEmitter();
  let calls = 0;
  const diagnostics: unknown[] = [];
  const cleanup = installMcpStdioShutdownHooks({
    stdin,
    stdout,
    platform: "win32",
    parentPid: 0,
    signalSource: signals as never,
    onDiagnostic: (event, context) => diagnostics.push({ event, context }),
    shutdown: () => { calls += 1; },
  });

  stdin.emit("close");
  // The handler is single-fire: follow-on events on stdout/signals after the
  // first trigger must not produce additional diagnostics or shutdown calls.
  stdout.emit("error", new Error("EPIPE"));
  signals.emit("SIGBREAK");

  expect(calls).toBe(1);
  expect(diagnostics).toEqual([
    { event: "mcp.stdio.shutdown", context: { reason: "stdin.close" } },
  ]);
  cleanup();
  stdin.emit("end");
  signals.emit("SIGINT");
  expect(calls).toBe(1);
});

test("MCP stdio shutdown hooks fire once per install regardless of which event arrives first", () => {
  const cases: Array<{ event: string; reason: string; context?: Record<string, unknown>; emit: (stdin: EventEmitter, stdout: EventEmitter, signals: EventEmitter) => void }> = [
    {
      event: "stdout.error first",
      reason: "stdout.error",
      context: { message: "EPIPE" },
      emit: (_, stdout) => stdout.emit("error", new Error("EPIPE")),
    },
    {
      event: "signal first",
      reason: "signal",
      context: { signal: "SIGBREAK" },
      emit: (_, __, signals) => signals.emit("SIGBREAK"),
    },
  ];
  for (const testCase of cases) {
    const stdin = new EventEmitter();
    const stdout = new EventEmitter();
    const signals = new EventEmitter();
    let calls = 0;
    const diagnostics: unknown[] = [];
    const cleanup = installMcpStdioShutdownHooks({
      stdin,
      stdout,
      platform: "win32",
      parentPid: 0,
      signalSource: signals as never,
      onDiagnostic: (event, context) => diagnostics.push({ event, context }),
      shutdown: () => { calls += 1; },
    });
    testCase.emit(stdin, stdout, signals);
    expect(calls).toBe(1);
    expect(diagnostics).toEqual([
      { event: "mcp.stdio.shutdown", context: { reason: testCase.reason, ...(testCase.context ?? {}) } },
    ]);
    cleanup();
  }
});

test("MCP stdio shutdown hooks poll parent process liveness", () => {
  const stdin = new EventEmitter();
  const stdout = new EventEmitter();
  const signals = new EventEmitter();
  let intervalCallback: (() => void) | undefined;
  let cleared = false;
  const intervalHandle = { unref() {} } as ReturnType<typeof setInterval>;
  let calls = 0;
  const diagnostics: unknown[] = [];

  const cleanup = installMcpStdioShutdownHooks({
    stdin,
    stdout,
    platform: "win32",
    parentPid: 1234,
    parentCheckIntervalMs: 10,
    signalSource: signals as never,
    isProcessRunning: () => false,
    setIntervalFn: (callback) => {
      intervalCallback = callback;
      return intervalHandle;
    },
    clearIntervalFn: (handle) => {
      expect(handle).toBe(intervalHandle);
      cleared = true;
    },
    onDiagnostic: (event, context) => diagnostics.push({ event, context }),
    shutdown: () => { calls += 1; },
  });

  expect(intervalCallback).toBeDefined();
  intervalCallback!();
  expect(calls).toBe(1);
  expect(diagnostics).toEqual([{ event: "mcp.stdio.shutdown", context: { reason: "parent_dead", parentPid: 1234 } }]);
  cleanup();
  expect(cleared).toBe(true);
});

test("MCP stdio endpoint watchdog shuts down after consecutive no-listener probes", async () => {
  const stdin = new EventEmitter();
  const stdout = new EventEmitter();
  const signals = new EventEmitter();
  let intervalCallback: (() => void | Promise<void>) | undefined;
  let cleared = false;
  const intervalHandle = { unref() {} } as ReturnType<typeof setInterval>;
  let calls = 0;
  const diagnostics: unknown[] = [];

  const cleanup = installMcpStdioShutdownHooks({
    stdin,
    stdout,
    platform: "win32",
    parentPid: 0,
    signalSource: signals as never,
    probeEndpoint: async () => false,
    endpointCheckIntervalMs: 10,
    endpointFailureThreshold: 3,
    setIntervalFn: (callback) => {
      intervalCallback = callback;
      return intervalHandle;
    },
    clearIntervalFn: (handle) => {
      expect(handle).toBe(intervalHandle);
      cleared = true;
    },
    onDiagnostic: (event, context) => diagnostics.push({ event, context }),
    shutdown: () => { calls += 1; },
  });

  expect(intervalCallback).toBeDefined();
  await intervalCallback!();
  expect(calls).toBe(0);
  await intervalCallback!();
  expect(calls).toBe(0);
  await intervalCallback!();
  expect(calls).toBe(1);
  expect(diagnostics).toEqual([
    { event: "mcp.stdio.shutdown", context: { reason: "daemon_endpoint_dead", consecutiveFailures: 3 } },
  ]);
  cleanup();
  expect(cleared).toBe(true);
});

test("MCP stdio endpoint watchdog resets its counter when a probe reaches the daemon", async () => {
  const stdin = new EventEmitter();
  const stdout = new EventEmitter();
  const signals = new EventEmitter();
  let intervalCallback: (() => void | Promise<void>) | undefined;
  let calls = 0;

  // dead, dead, ALIVE, dead, dead — never 3 consecutive failures, so no shutdown.
  const results = [false, false, true, false, false];
  let index = 0;

  installMcpStdioShutdownHooks({
    stdin,
    stdout,
    platform: "win32",
    parentPid: 0,
    signalSource: signals as never,
    probeEndpoint: async () => results[index++]!,
    endpointCheckIntervalMs: 10,
    endpointFailureThreshold: 3,
    setIntervalFn: (callback) => {
      intervalCallback = callback;
      return { unref() {} } as ReturnType<typeof setInterval>;
    },
    shutdown: () => { calls += 1; },
  });

  for (let i = 0; i < results.length; i += 1) {
    await intervalCallback!();
  }
  expect(calls).toBe(0);
});

test("task_watch native MCP task surfaces the watch result and is purged once consumed", async () => {
  const baseTask: OrchestrationTaskRecord = {
    taskId: "task-1",
    sourceHandle: "backend:main",
    sourceKind: "coordinator",
    coordinatorSession: "backend:main",
    workerSession: "backend:worker",
    workspace: "backend",
    targetAgent: "claude",
    task: "review",
    status: "completed",
    summary: "review complete",
    resultText: "All good.",
    createdAt: "2026-05-16T00:00:00.000Z",
    updatedAt: "2026-05-16T00:00:05.000Z",
  };
  const watchCalls: unknown[] = [];
  const server = createXacpxMcpServer({
    transport: createMemoryTransport(
      async () => ({ taskId: "task-1", status: "running" }),
      {
        getTask: async ({ taskId }) => (taskId === "task-1" ? baseTask : null),
        listTasks: async () => [baseTask],
        watchTask: async (input) => {
          watchCalls.push(input);
          return {
            status: "terminal" as const,
            task: baseTask,
            events: [
              { seq: 1, at: "2026-05-16T00:00:00.000Z", type: "created", status: "running", message: "Task created" },
              { seq: 2, at: "2026-05-16T00:00:05.000Z", type: "status_changed", status: "completed", message: "Task completed" },
            ],
            nextAfterSeq: 2,
          };
        },
      },
    ),
    coordinatorSession: "backend:main",
  });
  const client = new Client({ name: "weacpx-test-client", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);

    const messages: Array<{ type: string; task?: { taskId: string; status: string }; result?: { content?: Array<{ type: string; text?: string }>; _meta?: unknown } }> = [];
    const stream = client.experimental.tasks.callToolStream(
      { name: "task_watch", arguments: { taskId: "task-1", mode: "until_attention_or_terminal" } },
      CallToolResultSchema,
      { task: { ttl: 60_000, pollInterval: 1 } },
    );
    for await (const message of stream) {
      messages.push(message);
    }

    // The native watcher delegates to the orchestration watchTask transport.
    expect(watchCalls).toEqual([
      { coordinatorSession: "backend:main", taskId: "task-1", mode: "until_attention_or_terminal" },
    ]);

    expect(messages[0]).toMatchObject({ type: "taskCreated" });
    expect(messages[0]?.task?.taskId).toMatch(/^watch:task-1:/);
    expect(messages[0]?.task?.status).toBe("working");

    const final = messages.at(-1);
    expect(final?.type).toBe("result");
    const text = final?.result?.content?.[0]?.text ?? "";
    expect(text).toContain("finished with terminal");
    expect(text).toContain("Watched task task-1 is completed");
    expect(text).toContain("nextAfterSeq: 2");
    expect(text).toContain("#2 status_changed");
    // The terminal watch carries the result inline so the coordinator skips a follow-up task_get.
    expect(text).toContain("Result: All good.");
    expect(text).toContain("Next: summarize this result for the user.");
    expect(text).not.toContain("call task_get");
    expect(final?.result?._meta).toEqual({ [RELATED_TASK_META_KEY]: { taskId: "task-1" } });

    // Leak guard: a one-shot watcher must not linger in the registry once its
    // result has been delivered.
    const listed = await client.experimental.tasks.listTasks();
    expect(listed.tasks.map((task) => task.taskId)).toEqual(["task-1"]);
  } finally {
    await client.close();
    await server.close();
  }
});

test("task_watch native MCP task maps attention_required to input_required", async () => {
  const baseTask: OrchestrationTaskRecord = {
    taskId: "task-blocked",
    sourceHandle: "backend:main",
    sourceKind: "coordinator",
    coordinatorSession: "backend:main",
    workerSession: "backend:worker",
    workspace: "backend",
    targetAgent: "claude",
    task: "review",
    status: "blocked",
    summary: "Need clarification",
    resultText: "",
    createdAt: "2026-05-16T00:00:00.000Z",
    updatedAt: "2026-05-16T00:00:02.000Z",
    openQuestion: {
      questionId: "q-1",
      question: "Which branch?",
      whyBlocked: "ambiguous target",
      whatIsNeeded: "branch name",
      askedAt: "2026-05-16T00:00:02.000Z",
      status: "open",
    },
  };
  const server = createXacpxMcpServer({
    transport: createMemoryTransport(
      async () => ({ taskId: "task-blocked", status: "running" }),
      {
        getTask: async ({ taskId }) => (taskId === "task-blocked" ? baseTask : null),
        listTasks: async () => [baseTask],
        watchTask: async () => ({
          status: "attention_required" as const,
          task: baseTask,
          events: [
            { seq: 3, at: "2026-05-16T00:00:02.000Z", type: "attention_required", status: "blocked", message: "Which branch?" },
          ],
          nextAfterSeq: 3,
        }),
      },
    ),
    coordinatorSession: "backend:main",
  });
  const client = new Client({ name: "weacpx-test-client", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);

    const messages: Array<{ type: string; task?: { taskId: string; status: string }; result?: { content?: Array<{ type: string; text?: string }> } }> = [];
    const stream = client.experimental.tasks.callToolStream(
      { name: "task_watch", arguments: { taskId: "task-blocked" } },
      CallToolResultSchema,
      { task: { pollInterval: 1 } },
    );
    for await (const message of stream) {
      messages.push(message);
    }

    expect(messages.some((message) => message.task?.status === "input_required")).toBe(true);
    const final = messages.at(-1);
    expect(final?.type).toBe("result");
    const text = final?.result?.content?.[0]?.text ?? "";
    expect(text).toContain("finished with attention required");
    expect(text).toContain("Open question: Which branch?");
    expect(text).toContain("coordinator_answer_question");
    expect(text).not.toContain("call task_get");
  } finally {
    await client.close();
    await server.close();
  }
});

test("task_watch native MCP task registry stays bounded for clients that never consume results", async () => {
  const baseTask: OrchestrationTaskRecord = {
    taskId: "task-1",
    sourceHandle: "backend:main",
    sourceKind: "coordinator",
    coordinatorSession: "backend:main",
    workerSession: "backend:worker",
    workspace: "backend",
    targetAgent: "claude",
    task: "review",
    status: "running",
    summary: "",
    resultText: "",
    createdAt: "2026-05-16T00:00:00.000Z",
    updatedAt: "2026-05-16T00:00:00.000Z",
  };
  const server = createXacpxMcpServer({
    transport: createMemoryTransport(
      async () => ({ taskId: "task-1", status: "running" }),
      {
        getTask: async () => baseTask,
        listTasks: async () => [],
        cancelTask: async () => baseTask,
        watchTask: async () => ({ status: "timeout" as const, task: baseTask, events: [], nextAfterSeq: 0 }),
      },
    ),
    coordinatorSession: "backend:main",
  });
  const client = new Client({ name: "weacpx-test-client", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const createTaskResultSchema = z
    .object({ task: z.object({ taskId: z.string() }).passthrough() })
    .passthrough();

  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);

    // Create more native watchers than the cache limit without ever fetching
    // their results, simulating a client that abandons watchers.
    const total = WATCH_TASKS_CACHE_LIMIT + 24;
    for (let index = 0; index < total; index += 1) {
      await client.request(
        {
          method: "tools/call",
          params: {
            name: "task_watch",
            arguments: { taskId: "task-1" },
            task: { ttl: 60_000, pollInterval: 1 },
          },
        },
        createTaskResultSchema,
      );
    }
    // Let every background watcher settle.
    await new Promise((resolve) => setTimeout(resolve, 50));

    const watchIds = new Set<string>();
    let cursor: string | undefined;
    do {
      const page = await client.experimental.tasks.listTasks(cursor);
      for (const task of page.tasks) {
        if (task.taskId.startsWith("watch:")) watchIds.add(task.taskId);
      }
      cursor = page.nextCursor;
    } while (cursor);

    expect(watchIds.size).toBeGreaterThan(0);
    expect(watchIds.size).toBeLessThanOrEqual(WATCH_TASKS_CACHE_LIMIT);
  } finally {
    await client.close();
    await server.close();
  }
});

test("task_watch native MCP task evicted mid-flight is not resurrected past the cap", async () => {
  const baseTask: OrchestrationTaskRecord = {
    taskId: "task-1",
    sourceHandle: "backend:main",
    sourceKind: "coordinator",
    coordinatorSession: "backend:main",
    workerSession: "backend:worker",
    workspace: "backend",
    targetAgent: "claude",
    task: "review",
    status: "running",
    summary: "",
    resultText: "",
    createdAt: "2026-05-16T00:00:00.000Z",
    updatedAt: "2026-05-16T00:00:00.000Z",
  };
  let watchCallCount = 0;
  let releaseFirstWatch!: () => void;
  const firstWatchGate = new Promise<void>((resolve) => {
    releaseFirstWatch = resolve;
  });
  const server = createXacpxMcpServer({
    transport: createMemoryTransport(
      async () => ({ taskId: "task-1", status: "running" }),
      {
        getTask: async () => baseTask,
        listTasks: async () => [],
        cancelTask: async () => baseTask,
        watchTask: async () => {
          watchCallCount += 1;
          // The first watcher's background watch hangs, so the cap evicts it
          // while it is still in flight.
          if (watchCallCount === 1) {
            await firstWatchGate;
          }
          return { status: "timeout" as const, task: baseTask, events: [], nextAfterSeq: 0 };
        },
      },
    ),
    coordinatorSession: "backend:main",
  });
  const client = new Client({ name: "weacpx-test-client", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const createTaskResultSchema = z
    .object({ task: z.object({ taskId: z.string() }).passthrough() })
    .passthrough();

  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);

    const createWatcher = async (): Promise<string> => {
      const created = await client.request(
        {
          method: "tools/call",
          params: {
            name: "task_watch",
            arguments: { taskId: "task-1" },
            task: { ttl: 60_000, pollInterval: 1 },
          },
        },
        createTaskResultSchema,
      );
      return (created.task as { taskId: string }).taskId;
    };

    const firstWatchTaskId = await createWatcher();
    // Fill the cache; the last insertion evicts the still-in-flight first watcher.
    for (let index = 0; index < WATCH_TASKS_CACHE_LIMIT; index += 1) {
      await createWatcher();
    }

    // Let the evicted watcher's background watch resolve. It must not
    // re-insert itself past the cap.
    releaseFirstWatch();
    await new Promise((resolve) => setTimeout(resolve, 50));

    const watchIds = new Set<string>();
    let cursor: string | undefined;
    do {
      const page = await client.experimental.tasks.listTasks(cursor);
      for (const task of page.tasks) {
        if (task.taskId.startsWith("watch:")) watchIds.add(task.taskId);
      }
      cursor = page.nextCursor;
    } while (cursor);

    expect(watchIds.size).toBeLessThanOrEqual(WATCH_TASKS_CACHE_LIMIT);
    expect(watchIds.has(firstWatchTaskId)).toBe(false);
  } finally {
    releaseFirstWatch();
    await client.close();
    await server.close();
  }
});
