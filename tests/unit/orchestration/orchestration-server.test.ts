import { expect, mock, test } from "bun:test";
import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventEmitter } from "node:events";
import { createConnection, type createServer } from "node:net";

import { resolveOrchestrationEndpoint } from "../../../src/orchestration/orchestration-ipc";
import { AgentMessagingError } from "../../../src/orchestration/agent-messaging-error";
import { OrchestrationServer } from "../../../src/orchestration/orchestration-server";
import { skipIfLocalIpcUnavailable } from "../../helpers/ipc-capability";

test("agent.list forwards only the trusted sender binding to Agent Messaging", async () => {
  const endpoint = resolveOrchestrationEndpoint("/tmp/weacpx-orch-server-test");
  const listReachable = mock(async () => [
    {
      address: { nodeId: "node-local", endpointId: "endpoint-worker" },
      handle: "agent:node-local:endpoint-worker",
      node: "node-local",
      agent: "codex",
      workspace: "backend",
      state: "idle" as const,
      capabilities: { receive: true, steer: false, queue: true, interrupt: false },
    },
  ]);
  const server = new OrchestrationServer(endpoint, makeServerHandlers(), {
    agentMessaging: {
      listReachable,
      send: async () => {
        throw new Error("not used");
      },
    },
  });

  const response = JSON.parse(
    await server.handleLine(
      JSON.stringify({
        id: "req-agent-list",
        method: "agent.list",
        params: {
          coordinatorSession: "backend:main",
          sourceHandle: "worker:review",
        },
      }),
    ),
  );

  expect(response).toMatchObject({
    id: "req-agent-list",
    ok: true,
    result: [{ handle: "agent:node-local:endpoint-worker" }],
  });
  expect(listReachable).toHaveBeenCalledWith({
    coordinatorSession: "backend:main",
    sourceHandle: "worker:review",
  });
});

test("agent.send forwards sender binding separately from message intent", async () => {
  const endpoint = resolveOrchestrationEndpoint("/tmp/weacpx-orch-server-test");
  const send = mock(async () => ({
    messageId: "msg-1",
    status: "queued" as const,
    modeUsed: "queue" as const,
    route: "local" as const,
  }));
  const server = new OrchestrationServer(endpoint, makeServerHandlers(), {
    agentMessaging: {
      listReachable: async () => [],
      send,
    },
  });

  const response = JSON.parse(
    await server.handleLine(
      JSON.stringify({
        id: "req-agent-send",
        method: "agent.send",
        params: {
          coordinatorSession: "backend:main",
          sourceHandle: "worker:review",
          to: "agent:node-local:endpoint-worker",
          message: "schema updated",
          mode: "queue",
          replyTo: "msg-parent",
        },
      }),
    ),
  );

  expect(response).toEqual({
    id: "req-agent-send",
    ok: true,
    result: {
      messageId: "msg-1",
      status: "queued",
      modeUsed: "queue",
      route: "local",
    },
  });
  expect(send).toHaveBeenCalledWith(
    { coordinatorSession: "backend:main", sourceHandle: "worker:review" },
    {
      to: "agent:node-local:endpoint-worker",
      content: "schema updated",
      mode: "queue",
      replyTo: "msg-parent",
    },
  );
});

test("agent messaging business errors retain their typed RPC code", async () => {
  const endpoint = resolveOrchestrationEndpoint("/tmp/weacpx-orch-server-test");
  const server = new OrchestrationServer(endpoint, makeServerHandlers(), {
    agentMessaging: {
      listReachable: async () => [],
      send: async () => {
        throw new AgentMessagingError("TARGET_NOT_REACHABLE", "Target is not reachable.");
      },
    },
  });

  const response = JSON.parse(
    await server.handleLine(
      JSON.stringify({
        id: "req-agent-send-denied",
        method: "agent.send",
        params: {
          coordinatorSession: "backend:main",
          to: "agent:node-other:endpoint-worker",
          message: "schema updated",
        },
      }),
    ),
  );

  expect(response).toEqual({
    id: "req-agent-send-denied",
    ok: false,
    error: {
      code: "TARGET_NOT_REACHABLE",
      message: "Target is not reachable.",
    },
  });
});

test("Task RPC keeps mapping unexpected Agent Messaging errors to the existing internal code", async () => {
  const endpoint = resolveOrchestrationEndpoint("/tmp/weacpx-orch-server-test");
  const server = new OrchestrationServer(
    endpoint,
    makeServerHandlers({
      requestDelegate: async () => {
        throw new AgentMessagingError("TARGET_NOT_REACHABLE", "unexpected domain error");
      },
    }),
  );

  const response = JSON.parse(
    await server.handleLine(
      JSON.stringify({
        id: "req-task-domain-error",
        method: "delegate.request",
        params: {
          sourceHandle: "backend:main",
          targetAgent: "codex",
          task: "review",
        },
      }),
    ),
  );

  expect(response).toEqual({
    id: "req-task-domain-error",
    ok: false,
    error: {
      code: "ORCHESTRATION_INTERNAL_ERROR",
      message: "unexpected domain error",
    },
  });
});

test("agent RPC rejects forged identity, scope, and malformed message fields before dispatch", async () => {
  const endpoint = resolveOrchestrationEndpoint("/tmp/weacpx-orch-server-test");
  const listReachable = mock(async () => []);
  const send = mock(async () => ({ messageId: "msg-1", status: "queued", route: "local" }));
  const server = new OrchestrationServer(endpoint, makeServerHandlers(), {
    agentMessaging: { listReachable, send },
  });

  const requests: Array<{ method: "agent.list" | "agent.send"; params: Record<string, unknown> }> = [
    { method: "agent.list", params: { coordinatorSession: "backend:main", scope: "all" } },
    { method: "agent.list", params: { coordinatorSession: "backend:main", from: "agent:forged" } },
    { method: "agent.list", params: { coordinatorSession: "backend:main", nodeId: "node-forged" } },
    { method: "agent.list", params: { coordinatorSession: "backend:main", accountId: "account-forged" } },
    {
      method: "agent.send",
      params: {
        coordinatorSession: "backend:main",
        to: "agent:node-local:endpoint-worker",
        message: "schema updated",
        endpointId: "endpoint-forged",
      },
    },
    {
      method: "agent.send",
      params: {
        coordinatorSession: "backend:main",
        to: "agent:node-local:endpoint-worker",
        message: "schema updated",
        busId: "bus-forged",
      },
    },
    {
      method: "agent.send",
      params: {
        coordinatorSession: "backend:main",
        to: "agent:node-local:endpoint-worker",
        message: "schema updated",
        mode: "realtime",
      },
    },
    {
      method: "agent.send",
      params: { coordinatorSession: "backend:main", message: "schema updated" },
    },
    {
      method: "agent.send",
      params: { coordinatorSession: "backend:main", to: "agent:node-local:endpoint-worker" },
    },
  ];

  for (const [index, request] of requests.entries()) {
    const response = JSON.parse(
      await server.handleLine(JSON.stringify({ id: `req-agent-invalid-${index}`, ...request })),
    );
    expect(response).toMatchObject({
      id: `req-agent-invalid-${index}`,
      ok: false,
      error: { code: "ORCHESTRATION_INVALID_REQUEST" },
    });
  }

  expect(listReachable).not.toHaveBeenCalled();
  expect(send).not.toHaveBeenCalled();
});

test("agent RPC reports internal error when Agent Messaging is not configured", async () => {
  const endpoint = resolveOrchestrationEndpoint("/tmp/weacpx-orch-server-test");
  const server = new OrchestrationServer(endpoint, makeServerHandlers());

  for (const request of [
    {
      id: "req-agent-list-unconfigured",
      method: "agent.list",
      params: { coordinatorSession: "backend:main" },
    },
    {
      id: "req-agent-send-unconfigured",
      method: "agent.send",
      params: {
        coordinatorSession: "backend:main",
        to: "agent:node-local:endpoint-worker",
        message: "schema updated",
      },
    },
  ]) {
    const response = JSON.parse(await server.handleLine(JSON.stringify(request)));
    expect(response).toMatchObject({
      id: request.id,
      ok: false,
      error: {
        code: "ORCHESTRATION_INTERNAL_ERROR",
        message: "agent messaging is not configured",
      },
    });
  }
});

test("agent RPC validates required fields before checking whether Agent Messaging is configured", async () => {
  const endpoint = resolveOrchestrationEndpoint("/tmp/weacpx-orch-server-test");
  const server = new OrchestrationServer(endpoint, makeServerHandlers());

  for (const request of [
    { id: "req-agent-list-invalid-unconfigured", method: "agent.list", params: {} },
    {
      id: "req-agent-send-invalid-unconfigured",
      method: "agent.send",
      params: {
        coordinatorSession: "backend:main",
        to: "agent:node-local:endpoint-worker",
      },
    },
  ]) {
    const response = JSON.parse(await server.handleLine(JSON.stringify(request)));
    expect(response).toMatchObject({
      id: request.id,
      ok: false,
      error: { code: "ORCHESTRATION_INVALID_REQUEST" },
    });
  }
});

async function sendRequest(endpointPath: string, request: Record<string, unknown>) {
  return await new Promise<Record<string, unknown>>((resolve, reject) => {
    const socket = createConnection(endpointPath);
    let buffer = "";

    socket.setEncoding("utf8");
    socket.once("error", reject);
    socket.once("connect", () => {
      socket.write(`${JSON.stringify(request)}\n`);
    });
    socket.on("data", (chunk) => {
      buffer += chunk;
      const newlineIndex = buffer.indexOf("\n");
      if (newlineIndex < 0) {
        return;
      }

      const line = buffer.slice(0, newlineIndex);
      socket.end();
      resolve(JSON.parse(line) as Record<string, unknown>);
    });
  });
}

function makeServerHandlers(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    registerExternalCoordinator: async (input: Record<string, unknown>) => ({
      coordinatorSession: input.coordinatorSession,
      workspace: input.workspace,
      createdAt: "2026-04-28T00:00:00.000Z",
      updatedAt: "2026-04-28T00:00:00.000Z",
    }),
    requestDelegate: async () => ({ taskId: "task-1", status: "needs_confirmation" }),
    getTask: async () => null,
    listTasks: async () => [],
    watchTask: async (input: Record<string, unknown>) => ({ status: "timeout", task: { taskId: input.taskId, status: "running" }, events: [], nextAfterSeq: input.afterSeq ?? 0 }),
    approveTask: async (input: Record<string, unknown>) => ({
      taskId: input.taskId,
      coordinatorSession: input.coordinatorSession,
      status: "running",
    }),
    cancelTask: async (input: Record<string, unknown>) => ({ taskId: input.taskId, status: "cancelled" }),
    recordWorkerReply: async (input: Record<string, unknown>) => ({ taskId: input.taskId, status: "completed" }),
    workerRaiseQuestion: async () => ({ taskId: "task-1", questionId: "question-1", status: "blocked" }),
    coordinatorAnswerQuestion: async (input: Record<string, unknown>) => ({ taskId: input.taskId, status: "running" }),
    coordinatorRetractAnswer: async (input: Record<string, unknown>) => ({ taskId: input.taskId, status: "waiting_for_human" }),
    coordinatorRequestHumanInput: async () => ({ packageId: "pkg-1", queuedTaskIds: [] }),
    coordinatorReviewContestedResult: async (input: Record<string, unknown>) => ({ taskId: input.taskId, status: "completed" }),
    createGroup: async () => ({
      groupId: "g-1",
      coordinatorSession: "backend:main",
      title: "review batch",
      createdAt: "2026-04-18T00:00:00.000Z",
      updatedAt: "2026-04-18T00:00:00.000Z",
    }),
    ...overrides,
  } as unknown as ConstructorParameters<typeof OrchestrationServer>[1];
}



test("delegate.request accepts parallel:true and passes it to the handler", async () => {
  const endpoint = resolveOrchestrationEndpoint("/tmp/weacpx-orch-server-test");
  const requestDelegate = mock(async (input: Record<string, unknown>) => ({
    taskId: "task-1",
    status: "needs_confirmation",
    input,
  }));
  const server = new OrchestrationServer(endpoint, makeServerHandlers({ requestDelegate }));

  const response = JSON.parse(
    await server.handleLine(JSON.stringify({
      id: "req-parallel-true",
      method: "delegate.request",
      params: {
        sourceHandle: "backend:main",
        targetAgent: "claude",
        task: "review",
        parallel: true,
      },
    })),
  );

  expect(response).toMatchObject({ id: "req-parallel-true", ok: true });
  expect(requestDelegate).toHaveBeenCalledWith({
    sourceHandle: "backend:main",
    targetAgent: "claude",
    task: "review",
    parallel: true,
  });
});

test("delegate.request accepts parallel:false and passes it to the handler", async () => {
  const endpoint = resolveOrchestrationEndpoint("/tmp/weacpx-orch-server-test");
  const requestDelegate = mock(async (input: Record<string, unknown>) => ({
    taskId: "task-2",
    status: "needs_confirmation",
    input,
  }));
  const server = new OrchestrationServer(endpoint, makeServerHandlers({ requestDelegate }));

  const response = JSON.parse(
    await server.handleLine(JSON.stringify({
      id: "req-parallel-false",
      method: "delegate.request",
      params: {
        sourceHandle: "backend:main",
        targetAgent: "claude",
        task: "review",
        parallel: false,
      },
    })),
  );

  expect(response).toMatchObject({ id: "req-parallel-false", ok: true });
  expect(requestDelegate).toHaveBeenCalledWith({
    sourceHandle: "backend:main",
    targetAgent: "claude",
    task: "review",
    parallel: false,
  });
});

test("delegate.request without parallel omits the field from handler input", async () => {
  const endpoint = resolveOrchestrationEndpoint("/tmp/weacpx-orch-server-test");
  const requestDelegate = mock(async (input: Record<string, unknown>) => ({
    taskId: "task-3",
    status: "needs_confirmation",
    input,
  }));
  const server = new OrchestrationServer(endpoint, makeServerHandlers({ requestDelegate }));

  const response = JSON.parse(
    await server.handleLine(JSON.stringify({
      id: "req-no-parallel",
      method: "delegate.request",
      params: {
        sourceHandle: "backend:main",
        targetAgent: "claude",
        task: "review",
      },
    })),
  );

  expect(response).toMatchObject({ id: "req-no-parallel", ok: true });
  const calledWith = (requestDelegate.mock.calls[0] as unknown[])[0] as Record<string, unknown>;
  expect(calledWith).not.toHaveProperty("parallel");
});

test("delegate.request rejects non-boolean parallel value", async () => {
  const endpoint = resolveOrchestrationEndpoint("/tmp/weacpx-orch-server-test");
  const requestDelegate = mock(async () => ({ taskId: "task-1", status: "needs_confirmation" }));
  const server = new OrchestrationServer(endpoint, makeServerHandlers({ requestDelegate }));

  for (const parallel of ["yes", 1, "true", null, []]) {
    const response = JSON.parse(
      await server.handleLine(JSON.stringify({
        id: "req-bad-parallel",
        method: "delegate.request",
        params: {
          sourceHandle: "backend:main",
          targetAgent: "claude",
          task: "review",
          parallel,
        },
      })),
    );

    expect(response).toMatchObject({
      id: "req-bad-parallel",
      ok: false,
      error: { code: "ORCHESTRATION_INVALID_REQUEST" },
    });
  }

  expect(requestDelegate).not.toHaveBeenCalled();
});

test("forwards task watch RPC to handlers", async () => {
  const endpoint = resolveOrchestrationEndpoint("/tmp/weacpx-orch-server-test");
  const watchTask = mock(async (input: Record<string, unknown>) => ({
    status: "event",
    task: { taskId: input.taskId, status: "running" },
    events: [{ seq: 2, at: "2026-05-16T00:00:00.000Z", type: "progress", summary: "halfway" }],
    nextAfterSeq: 2,
  }));
  const server = new OrchestrationServer(endpoint, makeServerHandlers({ watchTask }));

  await expect(
    server.handleLine(JSON.stringify({
      id: "req-task-watch",
      method: "task.watch",
      params: {
        coordinatorSession: "backend:main",
        taskId: "task-1",
        afterSeq: 1,
        mode: "next_event",
        includeProgress: true,
        timeoutMs: 60_000,
        pollIntervalMs: 50,
      },
    })),
  ).resolves.toBe(`${JSON.stringify({
    id: "req-task-watch",
    ok: true,
    result: {
      status: "event",
      task: { taskId: "task-1", status: "running" },
      events: [{ seq: 2, at: "2026-05-16T00:00:00.000Z", type: "progress", summary: "halfway" }],
      nextAfterSeq: 2,
    },
  })}\n`);

  expect(watchTask).toHaveBeenCalledWith({
    coordinatorSession: "backend:main",
    taskId: "task-1",
    afterSeq: 1,
    mode: "next_event",
    includeProgress: true,
    timeoutMs: 60_000,
    pollIntervalMs: 50,
  });
});

test("forwards scheduled.create RPC to the configured route-scoped handler", async () => {
  const endpoint = resolveOrchestrationEndpoint("/tmp/weacpx-orch-server-test");
  const createScheduledTaskFromRoute = mock(async (input: Record<string, unknown>) => ({
    id: "k8f2",
    chat_key: "wx:user",
    session_alias: "main",
    execute_at: "2026-05-25T02:00:00.000Z",
    message: input.message,
    status: "pending",
    created_at: "2026-05-25T00:00:00.000Z",
  }));
  const server = new OrchestrationServer(endpoint, makeServerHandlers(), {
    createScheduledTaskFromRoute,
  });

  await expect(
    server.handleLine(JSON.stringify({
      id: "req-scheduled-create",
      method: "scheduled.create",
      params: {
        coordinatorSession: "backend:main",
        timeText: "in 2h",
        message: "检查 CI",
        mode: "bound",
      },
    })),
  ).resolves.toBe(`${JSON.stringify({
    id: "req-scheduled-create",
    ok: true,
    result: {
      id: "k8f2",
      chat_key: "wx:user",
      session_alias: "main",
      execute_at: "2026-05-25T02:00:00.000Z",
      message: "检查 CI",
      status: "pending",
      created_at: "2026-05-25T00:00:00.000Z",
    },
  })}\n`);

  expect(createScheduledTaskFromRoute).toHaveBeenCalledWith({
    coordinatorSession: "backend:main",
    timeText: "in 2h",
    message: "检查 CI",
    mode: "bound",
  });
});

test("forwards scheduled.list RPC to the configured route-scoped handler", async () => {
  const endpoint = resolveOrchestrationEndpoint("/tmp/weacpx-orch-server-test");
  const listScheduledTasksFromRoute = mock(async (_input: Record<string, unknown>) => [
    {
      id: "k8f2",
      chat_key: "wx:user",
      session_alias: "main",
      execute_at: "2026-05-25T02:00:00.000Z",
      message: "检查 CI",
      status: "pending",
      created_at: "2026-05-25T00:00:00.000Z",
    },
  ]);
  const server = new OrchestrationServer(endpoint, makeServerHandlers(), { listScheduledTasksFromRoute });

  const response = JSON.parse(
    await server.handleLine(
      JSON.stringify({ id: "req-scheduled-list", method: "scheduled.list", params: { coordinatorSession: "backend:main" } }),
    ),
  );

  expect(response).toMatchObject({ id: "req-scheduled-list", ok: true });
  expect(response.result).toHaveLength(1);
  expect(listScheduledTasksFromRoute).toHaveBeenCalledWith({ coordinatorSession: "backend:main" });
});

test("forwards scheduled.cancel RPC to the configured route-scoped handler", async () => {
  const endpoint = resolveOrchestrationEndpoint("/tmp/weacpx-orch-server-test");
  const cancelScheduledTaskFromRoute = mock(async (_input: Record<string, unknown>) => ({ id: "k8f2", cancelled: true }));
  const server = new OrchestrationServer(endpoint, makeServerHandlers(), { cancelScheduledTaskFromRoute });

  const response = JSON.parse(
    await server.handleLine(
      JSON.stringify({
        id: "req-scheduled-cancel",
        method: "scheduled.cancel",
        params: { coordinatorSession: "backend:main", id: "k8f2" },
      }),
    ),
  );

  expect(response).toMatchObject({ id: "req-scheduled-cancel", ok: true, result: { id: "k8f2", cancelled: true } });
  expect(cancelScheduledTaskFromRoute).toHaveBeenCalledWith({ coordinatorSession: "backend:main", id: "k8f2" });
});

test("rejects malformed scheduled.list / scheduled.cancel params before dispatch", async () => {
  const endpoint = resolveOrchestrationEndpoint("/tmp/weacpx-orch-server-test");
  const listScheduledTasksFromRoute = mock(async () => []);
  const cancelScheduledTaskFromRoute = mock(async () => ({ id: "k8f2", cancelled: true }));
  const server = new OrchestrationServer(endpoint, makeServerHandlers(), {
    listScheduledTasksFromRoute,
    cancelScheduledTaskFromRoute,
  });

  const bad: Array<{ method: "scheduled.list" | "scheduled.cancel"; params: Record<string, unknown> }> = [
    { method: "scheduled.list", params: { coordinatorSession: "backend:main", extra: 1 } },
    { method: "scheduled.cancel", params: { coordinatorSession: "backend:main" } },
    { method: "scheduled.cancel", params: { coordinatorSession: "backend:main", id: "k8f2", extra: 1 } },
  ];
  for (const { method, params } of bad) {
    const response = JSON.parse(await server.handleLine(JSON.stringify({ id: "req-bad", method, params })));
    expect(response).toMatchObject({ id: "req-bad", ok: false, error: { code: "ORCHESTRATION_INVALID_REQUEST" } });
  }

  expect(listScheduledTasksFromRoute).not.toHaveBeenCalled();
  expect(cancelScheduledTaskFromRoute).not.toHaveBeenCalled();
});

test("rejects malformed scheduled.create params before dispatch", async () => {
  const endpoint = resolveOrchestrationEndpoint("/tmp/weacpx-orch-server-test");
  const createScheduledTaskFromRoute = mock(async () => ({
    id: "k8f2",
    chat_key: "wx:user",
    session_alias: "main",
    execute_at: "2026-05-25T02:00:00.000Z",
    message: "检查 CI",
    status: "pending",
    created_at: "2026-05-25T00:00:00.000Z",
  }));
  const server = new OrchestrationServer(endpoint, makeServerHandlers(), {
    createScheduledTaskFromRoute,
  });

  for (const params of [
    { coordinatorSession: "backend:main", timeText: "in 2h", mode: "temp" },
    { coordinatorSession: "backend:main", timeText: "in 2h", message: "检查 CI", mode: "bind" },
    { coordinatorSession: "backend:main", timeText: "in 2h", message: "检查 CI", chatKey: "wx:user" },
  ]) {
    const response = JSON.parse(await server.handleLine(JSON.stringify({
      id: "req-bad-scheduled-create",
      method: "scheduled.create",
      params,
    })));

    expect(response).toMatchObject({
      id: "req-bad-scheduled-create",
      ok: false,
      error: { code: "ORCHESTRATION_INVALID_REQUEST" },
    });
  }

  expect(createScheduledTaskFromRoute).not.toHaveBeenCalled();
});

test("returns ORCHESTRATION_INTERNAL_ERROR when scheduled.list/scheduled.cancel handlers are not configured", async () => {
  const endpoint = resolveOrchestrationEndpoint("/tmp/weacpx-orch-server-test");
  const server = new OrchestrationServer(endpoint, makeServerHandlers(), {});

  for (const [method, params] of [
    ["scheduled.list", { coordinatorSession: "backend:main" }],
    ["scheduled.cancel", { coordinatorSession: "backend:main", id: "k8f2" }],
  ] as const) {
    const response = JSON.parse(
      await server.handleLine(JSON.stringify({ id: "req-unconfigured", method, params })),
    );
    expect(response).toMatchObject({ ok: false, error: { code: "ORCHESTRATION_INTERNAL_ERROR" } });
  }
});

test("rejects malformed task watch option ranges before dispatch", async () => {
  const endpoint = resolveOrchestrationEndpoint("/tmp/weacpx-orch-server-test");
  const watchTask = mock(async () => ({ status: "timeout", task: null, events: [], nextAfterSeq: 0 }));
  const server = new OrchestrationServer(endpoint, makeServerHandlers({ watchTask }));

  for (const params of [
    { afterSeq: -1 },
    { afterSeq: 1.5 },
    { mode: "bad" },
    { includeProgress: "yes" },
    { timeoutMs: -1 },
    { timeoutMs: 1_200_001 },
    { timeoutMs: 1.5 },
    { pollIntervalMs: 0 },
    { pollIntervalMs: 10_001 },
    { pollIntervalMs: 1.5 },
  ]) {
    const response = JSON.parse(await server.handleLine(JSON.stringify({
      id: "req-bad-watch",
      method: "task.watch",
      params: {
        coordinatorSession: "backend:main",
        taskId: "task-1",
        ...params,
      },
    })));

    expect(response).toMatchObject({
      id: "req-bad-watch",
      ok: false,
      error: { code: "ORCHESTRATION_INVALID_REQUEST" },
    });
  }

  expect(watchTask).not.toHaveBeenCalled();
});

test("forwards coordinator answer retraction RPC to handlers", async () => {
  const endpoint = resolveOrchestrationEndpoint("/tmp/weacpx-orch-server-test");
  const coordinatorRetractAnswer = mock(async (input: Record<string, unknown>) => ({
    taskId: input.taskId,
    questionId: input.questionId,
    status: "waiting_for_human",
  }));
  const server = new OrchestrationServer(endpoint, makeServerHandlers({ coordinatorRetractAnswer }));

  await expect(
    server.handleLine(JSON.stringify({
      id: "req-retract",
      method: "coordinator.retract_answer",
      params: {
        coordinatorSession: "backend:main",
        taskId: "task-1",
        questionId: "question-1",
      },
    })),
  ).resolves.toBe(`${JSON.stringify({
    id: "req-retract",
    ok: true,
    result: { taskId: "task-1", questionId: "question-1", status: "waiting_for_human" },
  })}\n`);

  expect(coordinatorRetractAnswer).toHaveBeenCalledWith({
    coordinatorSession: "backend:main",
    taskId: "task-1",
    questionId: "question-1",
  });
});

test("forwards external coordinator registration RPC to handlers", async () => {
  const endpoint = resolveOrchestrationEndpoint("/tmp/weacpx-orch-server-test");
  const registerExternalCoordinator = mock(async (input: Record<string, unknown>) => ({
    coordinatorSession: input.coordinatorSession,
    workspace: input.workspace,
    createdAt: "2026-04-28T00:00:00.000Z",
    updatedAt: "2026-04-28T00:00:00.000Z",
  }));
  const server = new OrchestrationServer(endpoint, makeServerHandlers({ registerExternalCoordinator }));

  await expect(
    server.handleLine(JSON.stringify({
      id: "req-register-external",
      method: "coordinator.register_external",
      params: {
        coordinatorSession: "codex:backend",
        workspace: "backend",
      },
    })),
  ).resolves.toBe(`${JSON.stringify({
    id: "req-register-external",
    ok: true,
    result: {
      coordinatorSession: "codex:backend",
      workspace: "backend",
      createdAt: "2026-04-28T00:00:00.000Z",
      updatedAt: "2026-04-28T00:00:00.000Z",
    },
  })}\n`);

  expect(registerExternalCoordinator).toHaveBeenCalledWith({
    coordinatorSession: "codex:backend",
    workspace: "backend",
  });
});

test("task get and list require coordinator-scoped filters", async () => {
  const endpoint = resolveOrchestrationEndpoint("/tmp/weacpx-orch-server-test");
  const server = new OrchestrationServer(endpoint, makeServerHandlers());

  for (const request of [
    { id: "req-get", method: "task.get", params: { taskId: "task-1" } },
    { id: "req-list", method: "task.list", params: {} },
    { id: "req-list-filter", method: "task.list", params: { filter: { status: "running" } } },
  ]) {
    const response = JSON.parse(await server.handleLine(JSON.stringify(request)));
    expect(response).toMatchObject({
      id: request.id,
      ok: false,
      error: { code: "ORCHESTRATION_INVALID_REQUEST" },
    });
  }
});

test("rejects malformed task list filters before dispatch", async () => {
  const endpoint = resolveOrchestrationEndpoint("/tmp/weacpx-orch-server-test");
  const listTasks = mock(async () => []);
  const server = new OrchestrationServer(endpoint, makeServerHandlers({ listTasks }));

  for (const filter of [
    { coordinatorSession: "backend:main", status: "bogus" },
    { coordinatorSession: "backend:main", stuck: "false" },
    { coordinatorSession: "backend:main", sort: "bogus" },
    { coordinatorSession: "backend:main", order: "bogus" },
    { coordinatorSession: "backend:main", targetAgent: "claude" },
  ]) {
    const response = JSON.parse(await server.handleLine(JSON.stringify({
      id: "req-bad-list",
      method: "task.list",
      params: { filter },
    })));
    expect(response).toMatchObject({
      id: "req-bad-list",
      ok: false,
      error: { code: "ORCHESTRATION_INVALID_REQUEST" },
    });
  }

  const response = JSON.parse(await server.handleLine(JSON.stringify({
    id: "req-bad-list-top",
    method: "task.list",
    params: { filter: { coordinatorSession: "backend:main" }, targetAgent: "claude" },
  })));
  expect(response).toMatchObject({
    id: "req-bad-list-top",
    ok: false,
    error: { code: "ORCHESTRATION_INVALID_REQUEST" },
  });

  expect(listTasks).not.toHaveBeenCalled();
});

test("rejects malformed raw params for delegate cancel and worker reply before dispatch", async () => {
  const endpoint = resolveOrchestrationEndpoint("/tmp/weacpx-orch-server-test");
  const requestDelegate = mock(async () => ({ taskId: "task-1", status: "needs_confirmation" }));
  const cancelTask = mock(async () => ({ taskId: "task-1", status: "cancelled" }));
  const recordWorkerReply = mock(async () => ({ taskId: "task-1", status: "completed" }));
  const server = new OrchestrationServer(endpoint, makeServerHandlers({
    requestDelegate,
    cancelTask,
    recordWorkerReply,
  }));

  for (const request of [
    { id: "req-delegate", method: "delegate.request", params: { sourceHandle: "backend:main", task: "review" } },
    {
      id: "req-delegate-extra",
      method: "delegate.request",
      params: { sourceHandle: "backend:main", targetAgent: "claude", task: "review", coordinatorSession: "spoof" },
    },
    { id: "req-cancel", method: "task.cancel", params: { taskId: "task-1" } },
    {
      id: "req-cancel-extra",
      method: "task.cancel",
      params: { taskId: "task-1", coordinatorSession: "backend:main", workspace: "backend" },
    },
    { id: "req-reply", method: "worker.reply", params: { taskId: "task-1", sourceHandle: "worker-1", status: "running" } },
    {
      id: "req-reply-extra",
      method: "worker.reply",
      params: { taskId: "task-1", sourceHandle: "worker-1", resultText: "done", coordinatorSession: "spoof" },
    },
  ]) {
    const response = JSON.parse(await server.handleLine(JSON.stringify(request)));
    expect(response).toMatchObject({
      id: request.id,
      ok: false,
      error: { code: "ORCHESTRATION_INVALID_REQUEST" },
    });
  }

  expect(requestDelegate).not.toHaveBeenCalled();
  expect(cancelTask).not.toHaveBeenCalled();
  expect(recordWorkerReply).not.toHaveBeenCalled();
});

test("forwards supported orchestration RPC methods to handlers", async () => {
  // Requires node:net listen; sandboxed runners may deny local IPC with EPERM.
  if (await skipIfLocalIpcUnavailable("orchestration-server socket integration tests")) return;

  const dir = await mkdtemp(join(tmpdir(), "weacpx-orch-server-"));
  const endpoint = resolveOrchestrationEndpoint(dir);
  const requestDelegate = mock(async (input: Record<string, unknown>) => ({
    taskId: "task-1",
    status: "needs_confirmation",
    input,
  }));
  const getTask = mock(async (taskId: string) => ({ taskId, status: "running", coordinatorSession: "backend:main" }));
  const listTasks = mock(async (filter?: Record<string, unknown>) => [{ taskId: "task-1", filter }]);
  const approveTask = mock(async (input: Record<string, unknown>) => ({
    taskId: input.taskId,
    coordinatorSession: input.coordinatorSession,
    status: "running",
  }));
  const cancelTask = mock(async (input: Record<string, unknown>) => ({ taskId: input.taskId, status: "cancelled" }));
  const recordWorkerReply = mock(async (input: Record<string, unknown>) => ({ taskId: input.taskId, status: "completed" }));
  const server = new OrchestrationServer(
    endpoint,
    makeServerHandlers({
      requestDelegate,
      getTask,
      listTasks,
      approveTask,
      cancelTask,
      recordWorkerReply,
    }),
  );

  try {
    await server.start();

    await expect(
      sendRequest(endpoint.path, {
        id: "req-1",
        method: "delegate.request",
        params: {
          sourceHandle: "backend:main",
          targetAgent: "claude",
          task: "review",
        },
      }),
    ).resolves.toEqual({
      id: "req-1",
      ok: true,
      result: {
        taskId: "task-1",
        status: "needs_confirmation",
        input: {
          sourceHandle: "backend:main",
          targetAgent: "claude",
          task: "review",
        },
      },
    });

    await expect(
      sendRequest(endpoint.path, {
        id: "req-2",
        method: "task.get",
        params: { taskId: "task-1", coordinatorSession: "backend:main" },
      }),
    ).resolves.toEqual({
      id: "req-2",
      ok: true,
      result: { taskId: "task-1", status: "running", coordinatorSession: "backend:main" },
    });

    await expect(
      sendRequest(endpoint.path, {
        id: "req-3",
        method: "task.list",
        params: { filter: { coordinatorSession: "backend:main" } },
      }),
    ).resolves.toEqual({
      id: "req-3",
      ok: true,
      result: [{ taskId: "task-1", filter: { coordinatorSession: "backend:main" } }],
    });

    await expect(
      sendRequest(endpoint.path, {
        id: "req-4",
        method: "task.cancel",
        params: { taskId: "task-1", sourceHandle: "wx:user" },
      }),
    ).resolves.toEqual({
      id: "req-4",
      ok: true,
      result: { taskId: "task-1", status: "cancelled" },
    });

    await expect(
      sendRequest(endpoint.path, {
        id: "req-4b",
        method: "task.approve",
        params: { taskId: "task-1", coordinatorSession: "backend:main" },
      }),
    ).resolves.toEqual({
      id: "req-4b",
      ok: true,
      result: { taskId: "task-1", coordinatorSession: "backend:main", status: "running" },
    });

    await expect(
      sendRequest(endpoint.path, {
        id: "req-5",
        method: "worker.reply",
        params: { taskId: "task-1", sourceHandle: "worker-1", resultText: "done" },
      }),
    ).resolves.toEqual({
      id: "req-5",
      ok: true,
      result: { accepted: true },
    });

    expect(requestDelegate).toHaveBeenCalledWith({
      sourceHandle: "backend:main",
      targetAgent: "claude",
      task: "review",
    });
    expect(getTask).toHaveBeenCalledWith("task-1");
    expect(listTasks).toHaveBeenCalledWith({ coordinatorSession: "backend:main" });
    expect(approveTask).toHaveBeenCalledWith({ taskId: "task-1", coordinatorSession: "backend:main" });
    expect(cancelTask).toHaveBeenCalledWith({ taskId: "task-1", sourceHandle: "wx:user" });
    expect(recordWorkerReply).toHaveBeenCalledWith({
      taskId: "task-1",
      sourceHandle: "worker-1",
      resultText: "done",
    });
  } finally {
    await server.stop();
    await rm(dir, { recursive: true, force: true });
  }
});

test("task.cancel forwards coordinator ownership when provided", async () => {
  // Requires node:net listen; sandboxed runners may deny local IPC with EPERM.
  if (await skipIfLocalIpcUnavailable("orchestration-server socket integration tests")) return;

  const dir = await mkdtemp(join(tmpdir(), "weacpx-orch-server-"));
  const endpoint = resolveOrchestrationEndpoint(dir);
  const cancelTask = mock(async (input: Record<string, unknown>) => ({ taskId: input.taskId, status: "cancelled" }));
  const server = new OrchestrationServer(endpoint, makeServerHandlers({ cancelTask }));

  try {
    await server.start();

    await expect(
      sendRequest(endpoint.path, {
        id: "req-cancel-coordinator",
        method: "task.cancel",
        params: { taskId: "task-1", coordinatorSession: "backend:main" },
      }),
    ).resolves.toEqual({
      id: "req-cancel-coordinator",
      ok: true,
      result: { taskId: "task-1", status: "cancelled" },
    });

    expect(cancelTask).toHaveBeenCalledWith({
      taskId: "task-1",
      coordinatorSession: "backend:main",
    });
  } finally {
    await server.stop();
    await rm(dir, { recursive: true, force: true });
  }
});

test("task.get returns null when coordinator ownership does not match", async () => {
  // Requires node:net listen; sandboxed runners may deny local IPC with EPERM.
  if (await skipIfLocalIpcUnavailable("orchestration-server socket integration tests")) return;

  const dir = await mkdtemp(join(tmpdir(), "weacpx-orch-server-"));
  const endpoint = resolveOrchestrationEndpoint(dir);
  const getTask = mock(async (taskId: string) => ({
    taskId,
    coordinatorSession: "backend:other",
    status: "running",
  }));
  const server = new OrchestrationServer(endpoint, makeServerHandlers({ getTask }));

  try {
    await server.start();

    await expect(
      sendRequest(endpoint.path, {
        id: "req-get-mismatch",
        method: "task.get",
        params: { taskId: "task-1", coordinatorSession: "backend:main" },
      }),
    ).resolves.toEqual({
      id: "req-get-mismatch",
      ok: true,
      result: null,
    });

    expect(getTask).toHaveBeenCalledWith("task-1");
  } finally {
    await server.stop();
    await rm(dir, { recursive: true, force: true });
  }
});

test("rejects malformed task.list filters instead of widening the request", async () => {
  // Requires node:net listen; sandboxed runners may deny local IPC with EPERM.
  if (await skipIfLocalIpcUnavailable("orchestration-server socket integration tests")) return;

  const dir = await mkdtemp(join(tmpdir(), "weacpx-orch-server-"));
  const endpoint = resolveOrchestrationEndpoint(dir);
  const server = new OrchestrationServer(endpoint, makeServerHandlers({ listTasks: mock(async () => []) }));

  try {
    await server.start();

    await expect(
      sendRequest(endpoint.path, {
        id: "req-bad-filter",
        method: "task.list",
        params: { filter: "bad-filter" },
      }),
    ).resolves.toEqual({
      id: "req-bad-filter",
      ok: false,
      error: {
        code: "ORCHESTRATION_INVALID_REQUEST",
        message: "filter must be an object when provided",
      },
    });
  } finally {
    await server.stop();
    await rm(dir, { recursive: true, force: true });
  }
});

class FakeNetServer extends EventEmitter {
  listen(_path: string): this {
    queueMicrotask(() => this.emit("listening"));
    return this;
  }

  close(callback?: (error?: Error) => void): void {
    callback?.();
  }
}

test("hardens the unix socket to owner-only (0600) after listen", async () => {
  // Requires node:net listen; sandboxed runners may deny local IPC with EPERM.
  if (await skipIfLocalIpcUnavailable("orchestration-server socket integration tests")) return;

  if (process.platform === "win32") {
    return;
  }

  const dir = await mkdtemp(join(tmpdir(), "weacpx-orch-server-"));
  const endpoint = resolveOrchestrationEndpoint(dir);
  const server = new OrchestrationServer(endpoint, makeServerHandlers());

  try {
    await server.start();
    expect(((await stat(endpoint.path)).mode & 0o777)).toBe(0o600);
  } finally {
    await server.stop();
    await rm(dir, { recursive: true, force: true });
  }
});

test("skips socket chmod for windows named-pipe endpoints", async () => {
  const chmodCalls: Array<{ path: string; mode: number }> = [];
  const endpoint = { kind: "named-pipe" as const, path: "\\\\.\\pipe\\xacpx-orchestration-test" };
  const server = new OrchestrationServer(endpoint, makeServerHandlers(), {
    createServer: (() => new FakeNetServer()) as unknown as typeof createServer,
    chmodFile: async (path, mode) => {
      chmodCalls.push({ path, mode });
    },
  });

  await server.start();
  await server.stop();

  expect(chmodCalls).toEqual([]);
});

test("socket chmod failure is non-fatal and reported", async () => {
  const dir = await mkdtemp(join(tmpdir(), "weacpx-orch-server-"));
  const endpoint = resolveOrchestrationEndpoint(dir);
  const hardenErrors: unknown[] = [];
  const server = new OrchestrationServer(endpoint, makeServerHandlers(), {
    createServer: (() => new FakeNetServer()) as unknown as typeof createServer,
    chmodFile: async () => {
      throw new Error("chmod denied");
    },
    onSocketHardenError: (error) => {
      hardenErrors.push(error);
    },
  });

  try {
    await expect(server.start()).resolves.toBeUndefined();
    expect(hardenErrors).toHaveLength(1);
    expect((hardenErrors[0] as Error).message).toBe("chmod denied");
  } finally {
    await server.stop();
    await rm(dir, { recursive: true, force: true });
  }
});

test("cleans up stale unix sockets on start and stop", async () => {
  // Requires node:net listen; sandboxed runners may deny local IPC with EPERM.
  if (await skipIfLocalIpcUnavailable("orchestration-server socket integration tests")) return;

  if (process.platform === "win32") {
    return;
  }

  const dir = await mkdtemp(join(tmpdir(), "weacpx-orch-server-"));
  const endpoint = resolveOrchestrationEndpoint(dir);
  const server = new OrchestrationServer(endpoint, makeServerHandlers());

  try {
    await writeFile(endpoint.path, "stale");
    await server.start();
    await expect(
      sendRequest(endpoint.path, {
        id: "req-stale",
        method: "task.list",
        params: { filter: { coordinatorSession: "backend:main" } },
      }),
    ).resolves.toEqual({
      id: "req-stale",
      ok: true,
      result: [],
    });

    await server.stop();
    await expect(writeFile(endpoint.path, "fresh")).resolves.toBeUndefined();
  } finally {
    await server.stop();
    await rm(dir, { recursive: true, force: true });
  }
});

test("refuses to start when a live unix socket listener already owns the path", async () => {
  // Requires node:net listen; sandboxed runners may deny local IPC with EPERM.
  if (await skipIfLocalIpcUnavailable("orchestration-server socket integration tests")) return;

  if (process.platform === "win32") {
    return;
  }

  const dir = await mkdtemp(join(tmpdir(), "weacpx-orch-server-"));
  const endpoint = resolveOrchestrationEndpoint(dir);
  const first = new OrchestrationServer(endpoint, makeServerHandlers());
  const second = new OrchestrationServer(endpoint, makeServerHandlers());

  try {
    await first.start();
    await expect(second.start()).rejects.toThrow(`orchestration endpoint is already in use: ${endpoint.path}`);
  } finally {
    await second.stop();
    await first.stop();
    await rm(dir, { recursive: true, force: true });
  }
});

test("forwards group.new RPC to handler", async () => {
  // Requires node:net listen; sandboxed runners may deny local IPC with EPERM.
  if (await skipIfLocalIpcUnavailable("orchestration-server socket integration tests")) return;

  const dir = await mkdtemp(join(tmpdir(), "weacpx-orch-server-"));
  const endpoint = resolveOrchestrationEndpoint(dir);
  const groupRecord = {
    groupId: "g-1",
    coordinatorSession: "backend:main",
    title: "parallel review",
    createdAt: "2026-04-18T00:00:00.000Z",
    updatedAt: "2026-04-18T00:00:00.000Z",
  };
  const createGroup = mock(async () => groupRecord);
  const server = new OrchestrationServer(
    endpoint,
    makeServerHandlers({ createGroup }),
  );

  try {
    await server.start();

    await expect(
      sendRequest(endpoint.path, {
        id: "req-group-new",
        method: "group.new",
        params: { coordinatorSession: "backend:main", title: "parallel review" },
      }),
    ).resolves.toEqual({ id: "req-group-new", ok: true, result: groupRecord });

    expect(createGroup).toHaveBeenCalledWith({ coordinatorSession: "backend:main", title: "parallel review" });
  } finally {
    await server.stop();
    await rm(dir, { recursive: true, force: true });
  }
});

test("group RPC methods reject missing required params", async () => {
  // Requires node:net listen; sandboxed runners may deny local IPC with EPERM.
  if (await skipIfLocalIpcUnavailable("orchestration-server socket integration tests")) return;

  const dir = await mkdtemp(join(tmpdir(), "weacpx-orch-server-"));
  const endpoint = resolveOrchestrationEndpoint(dir);
  const server = new OrchestrationServer(endpoint, makeServerHandlers());

  try {
    await server.start();

    await expect(
      sendRequest(endpoint.path, {
        id: "req-group-new-bad",
        method: "group.new",
        params: { coordinatorSession: "backend:main" },
      }),
    ).resolves.toEqual({
      id: "req-group-new-bad",
      ok: false,
      error: { code: "ORCHESTRATION_INVALID_REQUEST", message: "title must be a non-empty string" },
    });

    await expect(
      sendRequest(endpoint.path, {
        id: "req-task-approve-bad",
        method: "task.approve",
        params: { taskId: "task-1" },
      }),
    ).resolves.toEqual({
      id: "req-task-approve-bad",
      ok: false,
      error: {
        code: "ORCHESTRATION_INVALID_REQUEST",
        message: "coordinatorSession must be a non-empty string",
      },
    });
  } finally {
    await server.stop();
    await rm(dir, { recursive: true, force: true });
  }
});
